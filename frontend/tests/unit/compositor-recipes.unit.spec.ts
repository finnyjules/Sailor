import { describe, it, expect } from 'vitest'
import { expandRecipe, isRecipeKind, RECIPE_KINDS } from '~/lib/compositor/recipes'
import type { RisographEffect, PhotocopyEffect, LetterpressEffect } from '~/lib/compositor/effectStack'

const riso = (over: Partial<RisographEffect> = {}): RisographEffect => ({
  type: 'risograph', visible: true, ink: '#2b3a8c', inkTwo: '#e03a6d', levels: 4, grain: 0.16, contrast: 1.12, ...over,
})

describe('recipes: kind guard', () => {
  it('RECIPE_KINDS + isRecipeKind cover the three print looks', () => {
    expect([...RECIPE_KINDS]).toEqual(['risograph', 'photocopy', 'letterpress'])
    expect(isRecipeKind('risograph')).toBe(true)
    expect(isRecipeKind('photocopy')).toBe(true)
    expect(isRecipeKind('letterpress')).toBe(true)
    expect(isRecipeKind('grain')).toBe(false)
    expect(isRecipeKind('shader')).toBe(false)
  })
})

describe('expandRecipe: risograph', () => {
  it('expands to adjust → posterise → gradientMap → grain, in order, all visible', () => {
    const passes = expandRecipe(riso())
    expect(passes.map(p => p.type)).toEqual(['adjust', 'posterise', 'gradientMap', 'grain'])
    for (const p of passes) expect(p.visible).toBe(true)
  })

  it('maps the dials onto the primitive passes', () => {
    const passes = expandRecipe(riso({ levels: 5, contrast: 1.3, grain: 0.4 }))
    const adjust = passes.find(p => p.type === 'adjust')! as Extract<typeof passes[number], { type: 'adjust' }>
    const post = passes.find(p => p.type === 'posterise')! as Extract<typeof passes[number], { type: 'posterise' }>
    const grain = passes.find(p => p.type === 'grain')! as Extract<typeof passes[number], { type: 'grain' }>
    expect(adjust.contrast).toBe(1.3)
    expect(post.levels).toBe(5)
    expect(grain.amount).toBe(0.4)
  })

  it('the gradientMap carries the ink / inkTwo dials as ramp stops (shadows=inkTwo, mid=ink)', () => {
    const passes = expandRecipe(riso({ ink: '#123456', inkTwo: '#abcdef' }))
    const gm = passes.find(p => p.type === 'gradientMap')! as Extract<typeof passes[number], { type: 'gradientMap' }>
    expect(gm.mix).toBe(1)
    expect(gm.stops[0]).toEqual({ pos: 0, color: '#abcdef' }) // shadows take inkTwo
    expect(gm.stops[1]).toEqual({ pos: 0.5, color: '#123456' }) // mid takes ink
    expect(gm.stops[2]!.pos).toBe(1) // highlights fade into paper
  })

  it('drops the grain pass when grain is 0', () => {
    const passes = expandRecipe(riso({ grain: 0 }))
    expect(passes.map(p => p.type)).toEqual(['adjust', 'posterise', 'gradientMap'])
  })

  it('drops the adjust pass when contrast is 1 (neutral)', () => {
    const passes = expandRecipe(riso({ contrast: 1 }))
    expect(passes.map(p => p.type)).toEqual(['posterise', 'gradientMap', 'grain'])
  })

  it('each expanded pass is a full, independent object (deep-cloned defaults)', () => {
    const a = expandRecipe(riso())
    const b = expandRecipe(riso())
    const gmA = a.find(p => p.type === 'gradientMap')! as Extract<typeof a[number], { type: 'gradientMap' }>
    const gmB = b.find(p => p.type === 'gradientMap')! as Extract<typeof b[number], { type: 'gradientMap' }>
    expect(gmA.stops).not.toBe(gmB.stops)
  })
})

const photo = (over: Partial<PhotocopyEffect> = {}): PhotocopyEffect => ({
  type: 'photocopy', visible: true, threshold: 0.5, dirt: 0.2, contrast: 1.4, ...over,
})

describe('expandRecipe: photocopy', () => {
  it('expands to adjust → threshold → rough_edge → grain, in order, all visible', () => {
    const passes = expandRecipe(photo())
    expect(passes.map(p => p.type)).toEqual(['adjust', 'threshold', 'rough_edge', 'grain'])
    for (const p of passes) expect(p.visible).toBe(true)
  })

  it('the threshold pass carries the threshold dial as its cutoff', () => {
    const passes = expandRecipe(photo({ threshold: 0.72 }))
    const thr = passes.find(p => p.type === 'threshold')! as Extract<typeof passes[number], { type: 'threshold' }>
    expect(thr.cutoff).toBe(0.72)
  })

  it('maps the contrast + dirt dials onto the primitive passes', () => {
    const passes = expandRecipe(photo({ contrast: 1.6, dirt: 0.5 }))
    const adjust = passes.find(p => p.type === 'adjust')! as Extract<typeof passes[number], { type: 'adjust' }>
    const rough = passes.find(p => p.type === 'rough_edge')! as Extract<typeof passes[number], { type: 'rough_edge' }>
    const grain = passes.find(p => p.type === 'grain')! as Extract<typeof passes[number], { type: 'grain' }>
    expect(adjust.contrast).toBe(1.6)
    expect(rough.amount).toBeCloseTo(0.5 * 0.03) // dirt → small torn-edge amplitude
    expect(grain.amount).toBeCloseTo(Math.min(1, 0.5 * 1.2)) // dirt → toner speckle, clamped to 1
  })

  it('clamps the grain amount at 1 for a high dirt dial', () => {
    const passes = expandRecipe(photo({ dirt: 1 }))
    const grain = passes.find(p => p.type === 'grain')! as Extract<typeof passes[number], { type: 'grain' }>
    expect(grain.amount).toBe(1)
  })

  it('drops the adjust pass when contrast is 1 (neutral) — threshold still crushes the tone', () => {
    const passes = expandRecipe(photo({ contrast: 1 }))
    expect(passes.map(p => p.type)).toEqual(['threshold', 'rough_edge', 'grain'])
  })

  it('drops both dirt passes (rough_edge + grain) when dirt is 0, leaving adjust + threshold', () => {
    const passes = expandRecipe(photo({ dirt: 0 }))
    expect(passes.map(p => p.type)).toEqual(['adjust', 'threshold'])
  })
})

const letter = (over: Partial<LetterpressEffect> = {}): LetterpressEffect => ({
  type: 'letterpress', visible: true, depth: 0.5, ink: '#2a2a2a', paper: 0.3, ...over,
})

describe('expandRecipe: letterpress', () => {
  it('expands to inner_glow → adjust → grain, in order, all visible', () => {
    const passes = expandRecipe(letter())
    expect(passes.map(p => p.type)).toEqual(['inner_glow', 'adjust', 'grain'])
    for (const p of passes) expect(p.visible).toBe(true)
  })

  it('the inner glow carries the ink dial as its colour (the debossed impression)', () => {
    const passes = expandRecipe(letter({ ink: '#123456' }))
    const glow = passes.find(p => p.type === 'inner_glow')! as Extract<typeof passes[number], { type: 'inner_glow' }>
    expect(glow.color).toBe('#123456')
  })

  it('maps the depth dial onto the inner glow radius + intensity', () => {
    const passes = expandRecipe(letter({ depth: 0.5 }))
    const glow = passes.find(p => p.type === 'inner_glow')! as Extract<typeof passes[number], { type: 'inner_glow' }>
    expect(glow.radius).toBeCloseTo(0.5 * 0.03) // depth → tight radius, normalised to canvas width
    expect(glow.intensity).toBeCloseTo(0.5 * 1.6) // depth → impression strength
  })

  it('applies a slight, fixed desaturate (pressed ink reads muted)', () => {
    const passes = expandRecipe(letter())
    const adjust = passes.find(p => p.type === 'adjust')! as Extract<typeof passes[number], { type: 'adjust' }>
    expect(adjust.saturation).toBeCloseTo(0.85)
  })

  it('maps the paper dial onto the grain amount', () => {
    const passes = expandRecipe(letter({ paper: 0.5 }))
    const grain = passes.find(p => p.type === 'grain')! as Extract<typeof passes[number], { type: 'grain' }>
    expect(grain.amount).toBeCloseTo(0.5 * 0.6) // paper → tooth
  })

  it('drops the grain pass when paper is 0, leaving inner_glow + adjust', () => {
    const passes = expandRecipe(letter({ paper: 0 }))
    expect(passes.map(p => p.type)).toEqual(['inner_glow', 'adjust'])
  })
})
