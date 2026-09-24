import { describe, it, expect } from 'vitest'
import { createEffect, EFFECT_ORDER, EFFECT_LABELS, regionOf } from '~/lib/compositor/effectStack'

describe('finish effects in the stack', () => {
  it('sit right after letterpress, foil then spot UV, in the pixel region', () => {
    const o = EFFECT_ORDER as readonly string[]
    expect(o.indexOf('gold_foil')).toBe(o.indexOf('letterpress') + 1)
    expect(o.indexOf('spot_uv')).toBe(o.indexOf('gold_foil') + 1)
    expect(regionOf('gold_foil')).toBe('pixel')
    expect(regionOf('spot_uv')).toBe('pixel')
  })
  it('are labelled in sentence case', () => {
    expect(EFFECT_LABELS.gold_foil).toBe('Gold foil')
    expect(EFFECT_LABELS.spot_uv).toBe('Spot UV')
  })
  it('start from the prototype look', () => {
    expect(createEffect('gold_foil')).toMatchObject({ type: 'gold_foil', metal: 'gold', brushed: 0.5, pressed: 0.5, visible: true })
    expect(createEffect('spot_uv')).toMatchObject({ type: 'spot_uv', gloss: 0.75, raised: 0.5, varnishOnly: false, visible: true })
  })
})
