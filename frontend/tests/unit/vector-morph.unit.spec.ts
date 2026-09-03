import { describe, it, expect } from 'vitest'
import { parsePathD, flattenSubpath, subpathsToD, resample, signedArea, alignCorrespondence, blendPath, prepareBlend, samplesForSubpaths, rotatePathD, BLEND_SAMPLES } from '~/lib/vector/morph'

const SQUARE = 'M -50 -50 L 50 -50 L 50 50 L -50 50 Z'
const HEX = (() => {
  let d = ''
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3
    d += (i === 0 ? 'M' : 'L') + ` ${(90 * Math.cos(a)).toFixed(3)} ${(90 * Math.sin(a)).toFixed(3)}`
  }
  return d + ' Z'
})()
const TRI = 'M 0 -90 L 78 45 L -78 45 Z'
const flatOf = (d: string) => flattenSubpath(parsePathD(d)[0]!)

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

describe('morph: resample', () => {
  it('returns k points spaced evenly along the closed perimeter', () => {
    const pts = resample(flatOf(SQUARE), 40)
    expect(pts).toHaveLength(40)
    const seg = (i: number) => Math.hypot(pts[(i + 1) % 40]![0] - pts[i]![0], pts[(i + 1) % 40]![1] - pts[i]![1])
    const expected = 400 / 40
    for (let i = 0; i < 40; i++) expect(seg(i)).toBeCloseTo(expected, 6)
  })
})

describe('morph: alignCorrespondence', () => {
  it('recovers a known index rotation of the same polygon', () => {
    const a = resample(flatOf(SQUARE), 32)
    const shifted = [...a.slice(9), ...a.slice(0, 9)]
    const aligned = alignCorrespondence(a, shifted, 0)
    for (let i = 0; i < 32; i++) {
      expect(aligned[i]![0]).toBeCloseTo(a[i]![0], 6)
      expect(aligned[i]![1]).toBeCloseTo(a[i]![1], 6)
    }
  })

  it('reverses a polygon whose winding is opposite', () => {
    const a = resample(flatOf(SQUARE), 32)
    const rev = [...a].reverse()
    expect(Math.sign(signedArea(rev))).toBe(-Math.sign(signedArea(a)))
    const aligned = alignCorrespondence(a, rev, 0)
    expect(Math.sign(signedArea(aligned))).toBe(Math.sign(signedArea(a)))
    for (let i = 0; i < 32; i++) expect(aligned[i]![0]).toBeCloseTo(a[i]![0], 6)
  })

  it('twist shifts the start by round(twist · k)', () => {
    const a = resample(flatOf(SQUARE), 32)
    const aligned = alignCorrespondence(a, a, 0.25) // 8 of 32
    for (let i = 0; i < 32; i++) {
      expect(aligned[i]![0]).toBeCloseTo(a[(i + 8) % 32]![0], 6)
      expect(aligned[i]![1]).toBeCloseTo(a[(i + 8) % 32]![1], 6)
    }
  })
})

describe('morph: blendPath', () => {
  it('same skeleton: t = 0.5 is the argument-wise midpoint, curves stay curves', () => {
    const a = 'M 0 0 C 10 10 20 10 30 0 Z'
    const b = 'M 0 20 C 10 30 20 30 30 20 Z'
    expect(blendPath(a, b, 0.5)).toBe('M 0 10 C 10 20 20 20 30 10 Z')
  })

  it('t = 0 reproduces A and t = 1 reproduces B (resampled path)', () => {
    const d0 = blendPath(HEX, TRI, 0)
    const d1 = blendPath(HEX, TRI, 1)
    const onOutline = (pts: ReturnType<typeof flatOf>, d: string) => {
      const target = resample(flatOf(d), 720)
      return pts.every(([x, y]) => target.some(([tx, ty]) => Math.hypot(tx - x, ty - y) < 1.2))
    }
    expect(onOutline(flatOf(d0), HEX)).toBe(true)
    expect(onOutline(flatOf(d1), TRI)).toBe(true)
    expect(flatOf(d0)).toHaveLength(BLEND_SAMPLES)
  })

  it('an unpaired subpath collapses to ITS OWN centroid, not the partner shape\u2019s', () => {
    // The inner square is deliberately OFF-CENTRE (centred at 15, -10) while the
    // outer/partner square is centred at the origin, so the two readings of
    // "collapses to a centroid" are distinguishable: its own says (15, -10), the
    // partner's would say (0, 0).
    const ring = 'M -50 -50 L 50 -50 L 50 50 L -50 50 Z M 5 -20 L 25 -20 L 25 0 L 5 0 Z'
    const solid = 'M -50 -50 L 50 -50 L 50 50 L -50 50 Z'
    const d = blendPath(ring, solid, 1)
    const subs = parsePathD(d)
    expect(subs).toHaveLength(2)
    const inner = flattenSubpath(subs[1]!)
    for (const [x, y] of inner) { expect(x).toBeCloseTo(15, 1); expect(y).toBeCloseTo(-10, 1) }
  })

  it('twist is honoured on a SAME-SKELETON pair (the exact branch cannot spiral)', () => {
    // Two squares with an identical command skeleton. Twist rotates which point
    // of A meets which point of B, so it MUST reach the resampled path — the
    // exact branch interpolates argument-for-argument and can never spiral.
    const offset = 'M -30 -30 L 70 -30 L 70 70 L -30 70 Z'
    const plain = blendPath(SQUARE, offset, 0.5)
    const twisted = blendPath(SQUARE, offset, 0.5, { twist: 0.25 })
    expect(twisted).not.toBe(plain)
    // twist 0 keeps the exact branch: still four line segments, not 128.
    expect(blendPath(SQUARE, offset, 0.5, { twist: 0 })).toBe(plain)
    expect(parsePathD(plain)[0]!.segs).toHaveLength(3)
  })

  it('prepareBlend lerps per step and matches blendPath at every t', () => {
    for (const [a, b, opts] of [
      [SQUARE, 'M -30 -30 L 70 -30 L 70 70 L -30 70 Z', {}],        // same skeleton (exact)
      [HEX, TRI, {}],                                                // mixed (resampled)
      [SQUARE, 'M -30 -30 L 70 -30 L 70 70 L -30 70 Z', { twist: 0.25 }], // same skeleton + twist
    ] as [string, string, { twist?: number }][]) {
      const step = prepareBlend(a, b, opts)
      for (const t of [0, 0.3, 1]) expect(step(t)).toBe(blendPath(a, b, t, opts))
    }
  })

  it('samplesForSubpaths bounds subpath count \u00d7 samples', () => {
    expect(samplesForSubpaths(1)).toBe(128)
    expect(samplesForSubpaths(3)).toBe(128)
    expect(samplesForSubpaths(6)).toBe(64)
    expect(samplesForSubpaths(25)).toBe(24)
    expect(samplesForSubpaths(100)).toBe(24)
  })

  it('rotatePathD rotates about the origin', () => {
    const d = rotatePathD('M 10 0 L 20 0 Z', 90)
    const subs = parsePathD(d)
    expect(subs[0]!.start[0]).toBeCloseTo(0, 6); expect(subs[0]!.start[1]).toBeCloseTo(10, 6)
  })
})
