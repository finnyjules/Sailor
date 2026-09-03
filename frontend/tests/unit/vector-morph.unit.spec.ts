import { describe, it, expect } from 'vitest'
import { parsePathD, flattenSubpath, subpathsToD } from '~/lib/vector/morph'

const SQUARE = 'M -50 -50 L 50 -50 L 50 50 L -50 50 Z'

describe('morph: parsePathD', () => {
  it('parses absolute M L Z into one closed subpath of lines', () => {
    const subs = parsePathD(SQUARE)
    expect(subs).toHaveLength(1)
    expect(subs[0]!.start).toEqual([-50, -50])
    expect(subs[0]!.closed).toBe(true)
    expect(subs[0]!.segs.map(s => s.kind)).toEqual(['line', 'line', 'line'])
  })

  it('parses relative commands and H/V into the same geometry', () => {
    const rel = parsePathD('m -50 -50 h 100 v 100 h -100 z')
    const abs = parsePathD(SQUARE)
    expect(flattenSubpath(rel[0]!)).toEqual(flattenSubpath(abs[0]!))
  })

  it('turns a quadratic into a cubic with the standard 2/3 control points', () => {
    const subs = parsePathD('M 0 0 Q 30 60 60 0')
    const seg = subs[0]!.segs[0]!
    expect(seg.kind).toBe('cubic')
    if (seg.kind === 'cubic') {
      expect(seg.c1[0]).toBeCloseTo(20, 6); expect(seg.c1[1]).toBeCloseTo(40, 6)
      expect(seg.c2[0]).toBeCloseTo(40, 6); expect(seg.c2[1]).toBeCloseTo(40, 6)
      expect(seg.to).toEqual([60, 0])
    }
  })

  it('turns an arc into cubics that pass near the arc midpoint', () => {
    // half circle of radius 50 from (-50,0) to (50,0), sweeping through (0,-50)
    const subs = parsePathD('M -50 0 A 50 50 0 0 1 50 0')
    const pts = flattenSubpath({ ...subs[0]!, closed: false })
    const nearTop = pts.some(([x, y]) => Math.abs(x) < 8 && Math.abs(y + 50) < 1.5)
    expect(nearTop).toBe(true)
    for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeCloseTo(50, 0)
  })

  it('splits multiple subpaths', () => {
    const subs = parsePathD('M 0 0 L 10 0 L 10 10 Z M 20 20 L 30 20 L 30 30 Z')
    expect(subs).toHaveLength(2)
    expect(subs[1]!.start).toEqual([20, 20])
  })

  it('does not reflect a Q control point across an S (S after Q starts from the current point)', () => {
    const subs = parsePathD('M 0 0 Q 30 60 60 0 S 90 -60 120 0')
    const seg = subs[0]!.segs[1]!
    expect(seg.kind).toBe('cubic')
    if (seg.kind === 'cubic') {
      expect(seg.c1).toEqual([60, 0])
      expect(seg.c2).toEqual([90, -60])
      expect(seg.to).toEqual([120, 0])
    }
  })

  it('tokenises packed arc flags without separators (e.g. "0140" = large 0, sweep 1, x 40, y 30)', () => {
    const subs = parsePathD('M 0 0 A 50 50 0 0140 30')
    expect(subs).toHaveLength(1)
    const pts = flattenSubpath({ ...subs[0]!, closed: false })
    const last = pts[pts.length - 1]!
    expect(last[0]).toBeCloseTo(40, 6)
    expect(last[1]).toBeCloseTo(30, 6)
  })

  it('produces identical geometry for packed and spaced arc flags', () => {
    const packed = flattenSubpath(parsePathD('M 0 0 A 50 50 0 1140 30')[0]!)
    const spaced = flattenSubpath(parsePathD('M 0 0 A 50 50 0 1 1 40 30')[0]!)
    expect(packed).toEqual(spaced)
  })
})

describe('morph: flattenSubpath / subpathsToD', () => {
  it('flattens a square to exactly its 4 corners', () => {
    const pts = flattenSubpath(parsePathD(SQUARE)[0]!)
    expect(pts).toEqual([[-50, -50], [50, -50], [50, 50], [-50, 50]])
  })

  it('flattens a cubic into CURVE_STEPS segments', () => {
    const pts = flattenSubpath({ start: [0, 0], segs: [{ kind: 'cubic', c1: [0, 50], c2: [50, 50], to: [50, 0] }], closed: false })
    expect(pts).toHaveLength(13) // start + 12 steps
  })

  it('round-trips through subpathsToD', () => {
    const d = subpathsToD(parsePathD(SQUARE))
    expect(d).toBe('M -50 -50 L 50 -50 L 50 50 L -50 50 Z')
  })
})
