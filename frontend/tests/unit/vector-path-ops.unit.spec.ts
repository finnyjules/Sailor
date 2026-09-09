import { describe, it, expect } from 'vitest'
import { flatten, resampleByLength, toPathD, pathLength, cumulativeLengths, type Pt2 } from '~/lib/vector/pathOps'

const SQUARE_D = 'M0 0 L100 0 L100 100 L0 100 Z'

describe('pathOps: flatten', () => {
  it('flattens a unit-square d to one closed subpath of >= 4 points', () => {
    const subs = flatten(SQUARE_D)
    expect(subs.length).toBe(1)
    expect(subs[0]!.closed).toBe(true)
    expect(subs[0]!.pts.length).toBeGreaterThanOrEqual(4)
  })

  it('is deterministic — two calls on the same d give identical points', () => {
    const a = flatten(SQUARE_D)
    const b = flatten(SQUARE_D)
    expect(a).toEqual(b)
  })

  it('flattens an open path as not closed', () => {
    const subs = flatten('M0 0 L100 0 L100 100')
    expect(subs.length).toBe(1)
    expect(subs[0]!.closed).toBe(false)
  })
})

describe('pathOps: pathLength', () => {
  it('unit square perimeter is ~400 (scaled by 100)', () => {
    const subs = flatten(SQUARE_D)
    const len = pathLength(subs[0]!.pts, subs[0]!.closed)
    expect(len).toBeCloseTo(400, 1)
  })

  it('open path length excludes the closing chord', () => {
    const subs = flatten('M0 0 L100 0 L100 100')
    const len = pathLength(subs[0]!.pts, subs[0]!.closed)
    expect(len).toBeCloseTo(200, 1)
  })
})

describe('pathOps: cumulativeLengths', () => {
  it('is monotonic and ends at (or below, for open) the perimeter', () => {
    const subs = flatten(SQUARE_D)
    const cum = cumulativeLengths(subs[0]!.pts, subs[0]!.closed)
    expect(cum[0]).toBe(0)
    for (let i = 1; i < cum.length; i++) {
      expect(cum[i]!).toBeGreaterThanOrEqual(cum[i - 1]!)
    }
    const total = pathLength(subs[0]!.pts, subs[0]!.closed)
    // closed: last point is one segment short of the full perimeter (the
    // closing chord has no point of its own); open: last point IS the end.
    expect(cum[cum.length - 1]!).toBeLessThanOrEqual(total + 1e-6)
  })

  it('open path cumulative ends exactly at pathLength', () => {
    const subs = flatten('M0 0 L100 0 L100 100')
    const cum = cumulativeLengths(subs[0]!.pts, subs[0]!.closed)
    const total = pathLength(subs[0]!.pts, subs[0]!.closed)
    expect(cum[cum.length - 1]!).toBeCloseTo(total, 6)
  })
})

describe('pathOps: resampleByLength', () => {
  it('resamples the square perimeter (400) at step 40 to ~10 evenly spaced points', () => {
    const subs = flatten(SQUARE_D)
    const out = resampleByLength(subs[0]!.pts, subs[0]!.closed, 40)
    expect(out.length).toBeGreaterThanOrEqual(8)
    expect(out.length).toBeLessThanOrEqual(12)

    // near-constant segment lengths (arc-length even spacing), including the
    // wrap-around chord since the source is closed.
    const segLens: number[] = []
    for (let i = 0; i < out.length; i++) {
      const a = out[i] as Pt2
      const b = out[(i + 1) % out.length] as Pt2
      segLens.push(Math.hypot(b.x - a.x, b.y - a.y))
    }
    const mean = segLens.reduce((s, v) => s + v, 0) / segLens.length
    for (const len of segLens) {
      expect(Math.abs(len - mean)).toBeLessThan(mean * 0.35 + 1e-6)
    }
  })

  it('is deterministic', () => {
    const subs = flatten(SQUARE_D)
    const a = resampleByLength(subs[0]!.pts, subs[0]!.closed, 40)
    const b = resampleByLength(subs[0]!.pts, subs[0]!.closed, 40)
    expect(a).toEqual(b)
  })
})

describe('pathOps: toPathD', () => {
  it('round-trips a polygon: re-flattening toPathD(flatten(d)) matches within tolerance', () => {
    const subs = flatten(SQUARE_D)
    const d2 = toPathD(subs)
    const subs2 = flatten(d2)

    expect(subs2.length).toBe(subs.length)
    expect(subs2[0]!.closed).toBe(subs[0]!.closed)
    expect(subs2[0]!.pts.length).toBe(subs[0]!.pts.length)
    for (let i = 0; i < subs[0]!.pts.length; i++) {
      const a = subs[0]!.pts[i] as Pt2
      const b = subs2[0]!.pts[i] as Pt2
      expect(b.x).toBeCloseTo(a.x, 2)
      expect(b.y).toBeCloseTo(a.y, 2)
    }
  })

  it('emits M/L/Z for a closed polyline and no trailing Z for an open one', () => {
    const closedD = toPathD([{ pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true }])
    expect(closedD.startsWith('M0 0')).toBe(true)
    expect(closedD.endsWith('Z')).toBe(true)

    const openD = toPathD([{ pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false }])
    expect(openD.endsWith('Z')).toBe(false)
  })

  it('skips a degenerate subpath with fewer than 2 points', () => {
    const d = toPathD([{ pts: [{ x: 0, y: 0 }], closed: true }, { pts: [{ x: 0, y: 0 }, { x: 5, y: 5 }], closed: false }])
    expect(d).toBe('M0 0 L5 5')
  })
})
