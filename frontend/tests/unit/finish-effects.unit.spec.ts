import { describe, it, expect } from 'vitest'
import { createEffect, EFFECT_ORDER, EFFECT_LABELS, regionOf } from '~/lib/compositor/effectStack'

describe('finish effects in the stack', () => {
  it('spot UV sits right after letterpress, in the pixel region', () => {
    const o = EFFECT_ORDER as readonly string[]
    expect(o.indexOf('spot_uv')).toBe(o.indexOf('letterpress') + 1)
    expect(regionOf('spot_uv')).toBe('pixel')
  })
  it('Gold foil is no longer an effect kind (it is a fill since 2026-09-25)', () => {
    expect(EFFECT_ORDER as readonly string[]).not.toContain('gold_foil')
    expect(Object.keys(EFFECT_LABELS)).not.toContain('gold_foil')
  })
  it('are labelled in sentence case', () => {
    expect(EFFECT_LABELS.spot_uv).toBe('Spot UV')
  })
  it('start from the prototype look', () => {
    expect(createEffect('spot_uv')).toMatchObject({ type: 'spot_uv', gloss: 0.75, raised: 0.5, varnishOnly: false, visible: true })
  })
})
