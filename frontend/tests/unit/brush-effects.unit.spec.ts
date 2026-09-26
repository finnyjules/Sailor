import { describe, it, expect, vi } from 'vitest'

vi.mock('~/lib/shaderfx/catalogStore.ts', () => ({
  effectReadsInput: (id: string) => id === 'pixelate',
  getEffectSync: (id: string) => (id === 'unknown_effect' ? { name: 'Swirl' } : null),
  resolveEffectId: (id: string) => (id === 'filament' ? 'thread_contours' : id),
}))

import {
  BRUSH_EFFECTS,
  DEFAULT_BRUSH_EFFECT,
  paintGalleryInclude,
  effectGalleryInclude,
  brushEffectLabel,
  EFFECT_LAYER_FILL,
  withPaintedEffect,
  brushIdIsStale,
} from '~/lib/brushTips/effects'
import { addEffect } from '~/lib/compositor/effectStack'

describe('curated brush effects', () => {
  it('has the 7 curated effects in order with exact ids and labels', () => {
    expect(BRUSH_EFFECTS.map(e => e.id)).toEqual([
      'water_ripple',
      'blinds',
      'bloom',
      'bayer_dither',
      'chromatic_aberration',
      'pixelate',
      'gaussian_blur',
    ])
    expect(BRUSH_EFFECTS.map(e => e.label)).toEqual([
      'Ripple',
      'Reeded glass',
      'Glow',
      'Dither',
      'Colour split',
      'Pixels',
      'Frost',
    ])
    for (const e of BRUSH_EFFECTS) expect(typeof e.swatch).toBe('string')
  })

  it('defaults to water_ripple', () => {
    expect(DEFAULT_BRUSH_EFFECT).toBe('water_ripple')
  })

  it('paintGalleryInclude includes generative defs and material-category defs, excludes others', () => {
    expect(paintGalleryInclude({ id: 'a', generative: true })).toBe(true)
    expect(paintGalleryInclude({ id: 'b', category: 'material' })).toBe(true)
    expect(paintGalleryInclude({ id: 'c', category: 'blur' })).toBe(false)
  })

  it('effectGalleryInclude defers to effectReadsInput', () => {
    expect(effectGalleryInclude({ id: 'pixelate' })).toBe(true)
    expect(effectGalleryInclude({ id: 'aurora' })).toBe(false)
  })

  it('brushEffectLabel prefers the curated label, falls back to the catalogue name, else Effect', () => {
    expect(brushEffectLabel('blinds')).toBe('Reeded glass')
    expect(brushEffectLabel('unknown_effect')).toBe('Swirl')
    expect(brushEffectLabel('totally_unknown')).toBe('Effect')
  })
})

describe('painted-effect layer helpers', () => {
  it('an effect layer fill is opaque white, so it never weakens the effect', () => {
    expect(EFFECT_LAYER_FILL).toBe('#ffffff')
  })

  it('adds one backdrop_shader at speed 0 to a stack without one', () => {
    const out = withPaintedEffect([], 'bloom')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'backdrop_shader', effectId: 'bloom', speed: 0, visible: true, params: {} })
  })

  it('switches an existing backdrop_shader, resets its params and shows it again', () => {
    const base = addEffect([], 'backdrop_shader').map(e => ({ ...e, effectId: 'bloom', params: { amount: 2 }, visible: false, speed: 0.5 }))
    const out = withPaintedEffect(base as any, 'pixelate')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: base[0]!.id, effectId: 'pixelate', params: {}, visible: true, speed: 0.5 })
  })

  it('keeps other effects in the stack when adding the backdrop_shader', () => {
    const base = addEffect([], 'drop_shadow')
    const out = withPaintedEffect(base, 'bloom')
    expect(out.map(e => e.type).sort()).toEqual(['backdrop_shader', 'drop_shadow'])
    expect(out.find(e => e.id === base[0]!.id)).toEqual(base[0])
  })
})

describe('brushIdIsStale', () => {
  const effects = [{ id: 'bloom' }, { id: 'thread_contours' }, { id: 'mine_abcdefghijkl~v2' }]
  it('a catalogue id or a legacy alias is not stale', () => {
    expect(brushIdIsStale('bloom', effects, true)).toBe(false)
    expect(brushIdIsStale('filament', effects, true)).toBe(false)
  })
  it('a pinned My effect version in the catalogue is not stale', () => {
    expect(brushIdIsStale('mine_abcdefghijkl~v2', effects, true)).toBe(false)
  })
  it('an unknown built-in id is stale', () => {
    expect(brushIdIsStale('gone_effect', effects, false)).toBe(true)
  })
  it('a missing My effect is stale only once the library has loaded', () => {
    expect(brushIdIsStale('mine_zzzzzzzzzzzz~v1', effects, false)).toBe(false)
    expect(brushIdIsStale('mine_zzzzzzzzzzzz~v1', effects, true)).toBe(true)
  })
})
