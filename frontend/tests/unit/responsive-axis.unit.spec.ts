import { describe, it, expect } from 'vitest'
import { fitScale, spareRoom, axisMap, applyMap, invertMap, guardedRoom } from '~/lib/frame/responsive/axis'

describe('fitScale', () => {
  it('is the tighter of the two ratios', () => {
    expect(fitScale(1920, 1080, 960, 1080)).toBe(0.5)      // width binds
    expect(fitScale(1920, 1080, 3840, 1080)).toBe(1)       // height binds
    expect(fitScale(1920, 1080, 1920, 1080)).toBe(1)
  })
})

describe('spareRoom', () => {
  it('is zero on the binding axis and the leftover on the other', () => {
    expect(spareRoom(1920, 1080, 3840, 1080)).toEqual({ x: 1920, y: 0 })
    expect(spareRoom(1920, 1080, 1920, 2160)).toEqual({ x: 0, y: 1080 })
    expect(spareRoom(1920, 1080, 960, 540)).toEqual({ x: 0, y: 0 })
  })
})

describe('guardedRoom', () => {
  it('uses spare room only up to the fitted design extent, the rest becomes an outer offset', () => {
    // fitted design width 1920, spare 1920 → all usable, no offset
    expect(guardedRoom(1920, 1920)).toEqual({ u: 1920, o: 0 })
    // spare 5000 → usable 1920, the remaining 3080 split evenly
    expect(guardedRoom(5000, 1920)).toEqual({ u: 1920, o: 1540 })
    expect(guardedRoom(0, 1920)).toEqual({ u: 0, o: 0 })
  })
})

describe('axisMap (design px → box px)', () => {
  // design width 1000, fit scale 2, usable spare 400, outer offset 50
  const s = 2, u = 400, o = 50, ref = 1000
  it('left keeps its distance from the near edge', () => {
    const m = axisMap('left', ref, s, u, o)
    expect(applyMap(m, 100)).toBe(o + s * 100)
  })
  it('right keeps its distance from the far edge', () => {
    const m = axisMap('right', ref, s, u, o)
    expect(applyMap(m, 900)).toBe(o + s * 900 + u)
  })
  it('center stays centred', () => {
    const m = axisMap('center', ref, s, u, o)
    expect(applyMap(m, 500)).toBe(o + s * 500 + u / 2)
  })
  it('relative slides proportionally', () => {
    const m = axisMap('relative', ref, s, u, o)
    expect(applyMap(m, 250)).toBe(o + s * 250 + u * 0.25)
    expect(applyMap(m, 0)).toBe(o)
    expect(applyMap(m, ref)).toBe(o + s * ref + u)
  })
  it('both maps the near edge as left and the far edge as right (a stretch)', () => {
    const m = axisMap('both', ref, s, u, o)
    expect(m.kind).toBe('both')
    expect(applyMap(m, 100, 'near')).toBe(o + s * 100)
    expect(applyMap(m, 900, 'far')).toBe(o + s * 900 + u)
  })
  it('every map is a straight line: mapping a midpoint equals the midpoint of the mapped ends', () => {
    for (const pin of ['left', 'right', 'center', 'relative'] as const) {
      const m = axisMap(pin, ref, s, u, o)
      const a = applyMap(m, 100), b = applyMap(m, 700)
      expect(applyMap(m, 400)).toBeCloseTo((a + b) / 2, 9)
    }
  })
  it('invertMap round-trips', () => {
    for (const pin of ['left', 'right', 'center', 'relative'] as const) {
      const m = axisMap(pin, ref, s, u, o)
      expect(invertMap(m, applyMap(m, 333))).toBeCloseTo(333, 9)
    }
  })
  it('with no spare room every pin is the plain fit scale', () => {
    for (const pin of ['left', 'right', 'center', 'relative'] as const) {
      const m = axisMap(pin, ref, 2, 0, 0)
      expect(applyMap(m, 123)).toBe(246)
    }
  })
})
