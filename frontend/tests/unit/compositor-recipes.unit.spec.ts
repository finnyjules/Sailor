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

describe('expandRecipe: photocopy + letterpress are safe no-ops until their tasks', () => {
  it('photocopy returns []', () => {
    const e: PhotocopyEffect = { type: 'photocopy', visible: true, threshold: 0.5, dirt: 0.2, contrast: 1.4 }
    expect(expandRecipe(e)).toEqual([])
  })
  it('letterpress returns []', () => {
    const e: LetterpressEffect = { type: 'letterpress', visible: true, depth: 0.5, angle: 135, ink: '#2a2a2a', paper: 0.3 }
    expect(expandRecipe(e)).toEqual([])
  })
})
