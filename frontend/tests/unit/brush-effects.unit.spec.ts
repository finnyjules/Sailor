import { describe, it, expect, vi } from 'vitest'

vi.mock('~/lib/shaderfx/catalogStore.ts', () => ({
  effectReadsInput: (id: string) => id === 'pixelate',
  getEffectSync: (id: string) => (id === 'unknown_effect' ? { name: 'Swirl' } : null),
}))

import {
  BRUSH_EFFECTS,
  DEFAULT_BRUSH_EFFECT,
  paintGalleryInclude,
  effectGalleryInclude,
  brushEffectLabel,
} from '~/lib/brushTips/effects'

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
