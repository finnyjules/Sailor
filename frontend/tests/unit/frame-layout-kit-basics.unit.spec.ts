import { describe, it, expect } from 'vitest'
import { kitBasics, makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'

describe('kitBasics', () => {
  it('is 1 B, 12 columns and a 4-unit margin on the reference 895×1280 poster', () => {
    const k = kitBasics(895, 1280)
    expect(k.B).toBeCloseTo(1, 6)
    expect(k.nc).toBe(12)
    expect(k.margin).toBeCloseTo(4, 6)
    expect(k.infoSize).toBeCloseTo(1.95, 6)
    expect(k.infoLh).toBe(1.3)
  })
  it('uses 16 columns on a landscape, 20 on a banner, and the format override', () => {
    expect(kitBasics(1600, 900).nc).toBe(16)
    expect(kitBasics(1500, 500).nc).toBe(20)
    expect(kitBasics(728, 90, { nc: 24 }).nc).toBe(24)
  })
  it('widens the margin for a format that keeps the sides clear', () => {
    expect(kitBasics(1080, 1920, { keepSide: 0.06 }).margin).toBeCloseTo(6, 6)
  })
  it('matches what makeSheet uses with the grid off', () => {
    const k = kitBasics(1080, 1350)
    const S = makeSheet({ frameW: 1080, frameH: 1350, measure: makeStubMeasure() })
    expect(S.M).toBeCloseTo(k.margin, 6)
    expect(S.NC).toBe(k.nc)
    expect(S.INFO.size).toBeCloseTo(k.infoSize, 6)
  })
})
