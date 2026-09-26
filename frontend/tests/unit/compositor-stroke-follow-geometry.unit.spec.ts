import { describe, it, expect } from 'vitest'
import {
  followFrame, triangleAffine, bandTriangles, followStripPlan, fadeStops, roundOffsetPolyline, ringIsHole,
} from '~/lib/compositor/strokeFollow'
import { ombreHash, ombrePicker } from '~/lib/spacetype/fillTile'
import { resamplePolyline } from '~/lib/compositor/strokeShapes'

type P = { x: number; y: number }
const circle = (r: number, n: number, cw = true): P[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2 * (cw ? 1 : -1)
    return { x: r * Math.cos(t), y: r * Math.sin(t) }
  })
// A RECT is the fixture that matters: its edges flatten to two points each, which is the trap
// the wobble build fell into (see memory "frame-multi-stroke-landed"). Resample first, as the
// painter does.
const rect = (w: number, h: number, cw = true): P[] => {
  const c = [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]
  return resamplePolyline(cw ? c : c.slice().reverse(), true, 1)
}
// A 5-point star: sharp convex points AND sharp concave notches between them.
const star5 = (rOuter: number, rInner: number): P[] =>
  Array.from({ length: 10 }, (_, i) => {
    const t = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? rInner : rOuter
    return { x: r * Math.cos(t), y: r * Math.sin(t) }
  })
// An L-shape: one genuinely concave corner (at 40, 40), the rest convex right angles.
const lShape: P[] = [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 }]

const pointToSegment = (p: P, a: P, b: P): number => {
  const abx = b.x - a.x, aby = b.y - a.y
  const den = abx * abx + aby * aby || 1
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / den))
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby))
}
const polylineDistance = (p: P, pts: readonly P[], closed: boolean): number => {
  const n = pts.length, segs = closed ? n : n - 1
  let best = Infinity
  for (let i = 0; i < segs; i++) best = Math.min(best, pointToSegment(p, pts[i]!, pts[(i + 1) % n]!))
  return best
}
const triOrient = (a: P, b: P, c: P) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
const pointInTriangle = (p: P, a: P, b: P, c: P): boolean => {
  const d1 = triOrient(p, a, b), d2 = triOrient(p, b, c), d3 = triOrient(p, c, a)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0, hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}
const distToTriangle = (p: P, tri: readonly [P, P, P]): number => {
  if (pointInTriangle(p, tri[0], tri[1], tri[2])) return 0
  return Math.min(pointToSegment(p, tri[0], tri[1]), pointToSegment(p, tri[1], tri[2]), pointToSegment(p, tri[2], tri[0]))
}
/** Every point closer than 0.97·halfWidth to the outline must land inside (or within 0.3 units
 *  of the edge of) at least one kept triangle's dst — the coverage the crescent-gap bug broke. */
function assertBandCoverage(outline: readonly P[], halfWidth: number, gridStep = 2, tolerance = 0.3): void {
  const f = followFrame(outline, true, halfWidth)!
  const tris = bandTriangles(f, halfWidth)
  const xs = outline.map(p => p.x), ys = outline.map(p => p.y)
  const x0 = Math.min(...xs) - halfWidth - 2, x1 = Math.max(...xs) + halfWidth + 2
  const y0 = Math.min(...ys) - halfWidth - 2, y1 = Math.max(...ys) + halfWidth + 2
  const misses: P[] = []
  for (let x = x0; x <= x1; x += gridStep) {
    for (let y = y0; y <= y1; y += gridStep) {
      const p = { x, y }
      if (polylineDistance(p, outline, true) >= 0.97 * halfWidth) continue
      if (!tris.some(t => distToTriangle(p, t.dst) <= tolerance)) misses.push(p)
    }
  }
  expect(misses.length, `${misses.length} uncovered points; examples: ${JSON.stringify(misses.slice(0, 5))}`).toBe(0)
}

/** Signed distance to a closed polygon: negative inside. The band a round-join dilation /
 *  erosion paints at centre offset `c` is exactly { p : c − h ≤ sd(p) ≤ c + h }. */
const signedDistance = (p: P, poly: readonly P[]): number => {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  const d = polylineDistance(p, poly, true)
  return inside ? -d : d
}
/** The painter's route for a straight band at centre offset `centre`: the round-offset
 *  centreline, resampled, framed and meshed — and every point of the TRUE band (the mask's
 *  round-join dilation) must fall under a kept triangle. */
function assertOffsetBandCoverage(shape: readonly P[], halfWidth: number, centre: number, gridStep = 2): void {
  const src = resamplePolyline(shape, true, 1)
  const line = roundOffsetPolyline(src, true, centre)
  const f = followFrame(resamplePolyline(line, true, Math.max(0.5, halfWidth / 12)), true, halfWidth)!
  const tris = bandTriangles(f, halfWidth)
  const xs = shape.map(p => p.x), ys = shape.map(p => p.y), pad = Math.abs(centre) + halfWidth + 2
  const misses: P[] = []
  for (let x = Math.min(...xs) - pad; x <= Math.max(...xs) + pad; x += gridStep) {
    for (let y = Math.min(...ys) - pad; y <= Math.max(...ys) + pad; y += gridStep) {
      const p = { x, y }, s = signedDistance(p, shape)
      if (s < centre - 0.97 * halfWidth || s > centre + 0.97 * halfWidth) continue
      if (!tris.some(t => distToTriangle(p, t.dst) <= 0.3)) misses.push(p)
    }
  }
  expect(misses.length, `${misses.length} uncovered points; examples: ${JSON.stringify(misses.slice(0, 5))}`).toBe(0)
}
const rectCorners = (w: number, h: number): P[] => [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]

describe('followFrame', () => {
  it('measures the loop, closing chord included', () => {
    const f = followFrame(rect(100, 50), true, 10)!
    expect(f.length).toBeCloseTo(300, 0)
    expect(f.arc.length).toBe(f.pts.length + 1)
    expect(f.arc[f.arc.length - 1]).toBeCloseTo(f.length, 6)
  })
  it('normals point OUT of a closed shape, whichever way it is drawn', () => {
    for (const cw of [true, false]) {
      const f = followFrame(rect(100, 50, cw), true, 10)!
      // the sample nearest the middle of the top edge (y = -25, x ≈ 0)
      const i = f.pts.reduce((best, p, k) => (Math.abs(p.x) + Math.abs(p.y + 25) < Math.abs(f.pts[best]!.x) + Math.abs(f.pts[best]!.y + 25) ? k : best), 0)
      expect(f.normals[i]!.y, `cw=${cw}`).toBeLessThan(-0.99)
    }
  })
  it('outward −1 flips the side: a hole ring\'s normals point INTO the hole', () => {
    for (const cw of [true, false]) {
      const f = followFrame(rect(100, 50, cw), true, 10, -1)!
      const i = f.pts.reduce((best, p, k) => (Math.abs(p.x) + Math.abs(p.y + 25) < Math.abs(f.pts[best]!.x) + Math.abs(f.pts[best]!.y + 25) ? k : best), 0)
      expect(f.normals[i]!.y, `cw=${cw}`).toBeGreaterThan(0.99)   // top edge, pointing DOWN
    }
    // reach is measured against the flipped raw normal too, so a straight edge still needs none
    const f = followFrame(rect(100, 50), true, 10, -1)!
    const mid = f.pts.findIndex(p => Math.abs(p.y + 25) < 1e-6 && Math.abs(p.x) < 5)
    expect(f.reach[mid]).toBeCloseTo(1, 6)
  })
  it('normals are unit length and turn smoothly round a corner', () => {
    const f = followFrame(rect(100, 50), true, 10)!
    for (const n of f.normals) expect(Math.hypot(n.x, n.y)).toBeCloseTo(1, 6)
    // the sample nearest the top-right corner leans diagonally, not straight up or right
    const i = f.pts.reduce((b, p, k) => (Math.hypot(p.x - 50, p.y + 25) < Math.hypot(f.pts[b]!.x - 50, f.pts[b]!.y + 25) ? k : b), 0)
    expect(f.normals[i]!.x).toBeGreaterThan(0.3)
    expect(f.normals[i]!.y).toBeLessThan(-0.3)
  })
  it('an open line has one fewer segment and no wrap', () => {
    const f = followFrame([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }], false, 2)!
    expect(f.arc).toEqual([0, 5, 10])
    expect(f.length).toBe(10)
  })
  it('refuses a degenerate line', () => {
    expect(followFrame([{ x: 1, y: 1 }], true, 5)).toBeNull()
    expect(followFrame([{ x: 1, y: 1 }, { x: 1, y: 1 }], false, 5)).toBeNull()
  })
})

describe('triangleAffine', () => {
  it('maps each source corner onto its destination corner', () => {
    const s = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 4 }] as const
    const d = [{ x: 5, y: 5 }, { x: 5, y: 15 }, { x: 1, y: 5 }] as const
    const m = triangleAffine(s[0], s[1], s[2], d[0], d[1], d[2])!
    for (let k = 0; k < 3; k++) {
      const x = m[0] * s[k].x + m[2] * s[k].y + m[4], y = m[1] * s[k].x + m[3] * s[k].y + m[5]
      expect(x).toBeCloseTo(d[k].x, 9); expect(y).toBeCloseTo(d[k].y, 9)
    }
  })
  it('returns null for a flat source triangle', () => {
    const p = { x: 0, y: 0 }
    expect(triangleAffine(p, { x: 1, y: 0 }, { x: 2, y: 0 }, p, p, p)).toBeNull()
  })
})

describe('bandTriangles', () => {
  it('four per segment round a circle, none dropped, strip spans the band', () => {
    const f = followFrame(circle(100, 200), true, 10)!
    const tris = bandTriangles(f, 10)
    expect(tris.length).toBe(800)
    const ys = tris.flatMap(t => t.src.map(p => p.y))
    // reach ≈ 1 all round a circle (no corner to undershoot), so the strip still spans ≈[0, 20]
    expect(Math.min(...ys)).toBeCloseTo(0, 0); expect(Math.max(...ys)).toBeCloseTo(20, 0)
    // strip y = 0 is the INNER edge: its band point is closer to the centre; y = 2h is the outer
    const inner = tris[0]!.dst[0]!   // inner-half triangle 1: [inP, inQ, p]
    const outer = tris[2]!.dst[2]!   // outer-half triangle 1: [p, q, outP]
    expect(Math.hypot(inner.x, inner.y)).toBeCloseTo(90, 0)
    expect(Math.hypot(outer.x, outer.y)).toBeCloseTo(110, 0)
  })
  it('drops the triangles that fold over at a tight inner corner, without losing coverage', () => {
    // a thin star: inner corners much tighter than the band is wide
    const star: P[] = Array.from({ length: 10 }, (_, i) => {
      const t = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 20 : 100
      return { x: r * Math.cos(t), y: r * Math.sin(t) }
    })
    const outline = resamplePolyline(star, true, 1)
    const f = followFrame(outline, true, 15)!
    const segs = f.pts.length
    const tris = bandTriangles(f, 15)
    expect(tris.length).toBeLessThan(segs * 4)
    expect(tris.length).toBeGreaterThan(segs * 2)   // most of the band survives
    assertBandCoverage(outline, 15)
  })
  it('covers the band fully round a rect corner, half-width 10', () => {
    assertBandCoverage(rect(300, 200), 10, 0.5, 0)
  }, 120_000)
  it('covers the band fully round a rect corner, half-width 40', () => {
    assertBandCoverage(rect(300, 200), 40)
  })
  it('covers the band fully round a 5-point star', () => {
    assertBandCoverage(resamplePolyline(star5(150, 60), true, 1), 15)
  })
  it('covers the band fully round a concave L-shape corner', () => {
    assertBandCoverage(resamplePolyline(lShape, true, 1), 10, 0.5, 0)
  }, 120_000)
})

describe('followStripPlan', () => {
  const box = { w: 100, h: 80 }
  const fill = (type: string) => ({ type, a: '#fff', b: '#000', textColor: '#fff', angle: 0, density: 8 }) as any
  it('patterns repeat a whole number of the layer tile round the loop', () => {
    const p = followStripPlan(fill('grid'), box, 314, true)!
    expect(p.kind).toBe('tiles')
    if (p.kind !== 'tiles') return
    expect(p.tiles).toBe(3)
    expect(p.box.w * p.tiles).toBeCloseTo(314, 9)            // closes exactly
    expect(p.box.h / p.box.w).toBeCloseTo(box.h / box.w, 9)  // same aspect: cells stay square
  })
  it('a short line still gets one whole tile', () => {
    const p = followStripPlan(fill('checkerboard'), box, 30, true)!
    expect(p).toEqual({ kind: 'tiles', tiles: 1, box: { w: 30, h: 24 } })
  })
  it('gradients stretch, mirrored only round a closed outline', () => {
    expect(followStripPlan(fill('gradient'), box, 300, true)).toEqual({ kind: 'stretch', mirror: true })
    expect(followStripPlan(fill('gradient'), box, 300, false)).toEqual({ kind: 'stretch', mirror: false })
    const lin = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#f00' }, { offset: 1, color: '#00f' }] }
    expect(followStripPlan(lin as any, box, 300, true)).toEqual({ kind: 'stretch', mirror: true })
  })
  it('ombre fades; paints that cannot follow get no plan', () => {
    expect(followStripPlan(fill('ombre'), box, 300, true)).toEqual({ kind: 'fade' })
    expect(followStripPlan('#f00', box, 300, true)).toBeNull()
    expect(followStripPlan(fill('solid'), box, 300, true)).toBeNull()
  })
})

describe('fadeStops', () => {
  it('across: A at the inner edge, B at the outer edge', () => {
    expect(fadeStops('across', 4)).toEqual({ axis: 'across', stops: [{ offset: 0, t: 0 }, { offset: 1, t: 1 }] })
  })
  it('along: out and back `repeats` times, starting and ending on A', () => {
    const f = fadeStops('along', 2)
    expect(f.axis).toBe('along')
    expect(f.stops).toEqual([
      { offset: 0, t: 0 }, { offset: 0.25, t: 1 }, { offset: 0.5, t: 0 }, { offset: 0.75, t: 1 }, { offset: 1, t: 0 },
    ])
  })
})

describe('ombreHash', () => {
  it('is the exact hash ombrePicker already used', () => {
    const pick = ombrePicker(10, 10, 0)
    for (const [x, y] of [[0, 0], [3, 7], [9, 2]] as const) {
      const t = x / 10 // angle 0: t runs along x over the 10-px tile (pmin 0, range 10)
      expect(pick(x, y)).toBe(ombreHash(x, y) < t)
      expect(ombreHash(x, y)).toBeGreaterThanOrEqual(0); expect(ombreHash(x, y)).toBeLessThan(1)
    }
  })
})

describe('roundOffsetPolyline', () => {
  const sq = rectCorners(100, 100)   // corners at (±50, ±50)
  const near = (pts: readonly P[], c: P) => pts.filter(p => Math.abs(p.x) > 50 && Math.abs(p.y) > 50 && Math.sign(p.x) === Math.sign(c.x) && Math.sign(p.y) === Math.sign(c.y))
  it('distance 0 returns the points unchanged', () => {
    expect(roundOffsetPolyline(sq, true, 0)).toEqual(sq)
  })
  it('+d: every square corner becomes a quarter ARC exactly d from the corner vertex', () => {
    for (const cw of [true, false]) {
      const pts = roundOffsetPolyline(cw ? sq : sq.slice().reverse(), true, 20)
      for (const c of sq) {
        const arc = near(pts, c)
        expect(arc.length, `cw=${cw} corner ${JSON.stringify(c)}`).toBeGreaterThan(4)
        for (const p of arc) expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeCloseTo(20, 9)
      }
      // the straight runs sit exactly d out: nothing is closer than d to the square, nothing further
      for (const p of pts) expect(polylineDistance(p, sq, true)).toBeCloseTo(20, 9)
    }
  })
  it('−d: a sharp (mitred) inner corner, no arc', () => {
    const pts = roundOffsetPolyline(sq, true, -20)
    expect(pts.length).toBe(4)
    for (const p of pts) { expect(Math.abs(p.x)).toBeCloseTo(30, 9); expect(Math.abs(p.y)).toBeCloseTo(30, 9) }
  })
  it('outward −1 flips the side (a hole ring)', () => {
    expect(roundOffsetPolyline(sq, true, 20, -1)).toEqual(roundOffsetPolyline(sq, true, -20))
  })
  it('open line: ends offset square to their segment, the turn arcs on its outer side only', () => {
    // an L: right along y = 0, then down. Left normal (y-down) of +x travel is −y.
    const open = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }]
    const left = roundOffsetPolyline(open, false, 10)
    expect(left[0]).toEqual({ x: 0, y: -10 })
    expect(left[left.length - 1]).toEqual({ x: 60, y: 50 })
    const arc = left.slice(1, -1)
    expect(arc.length).toBeGreaterThan(3)
    for (const p of arc) expect(Math.hypot(p.x - 50, p.y)).toBeCloseTo(10, 9)
    const right = roundOffsetPolyline(open, false, -10)
    const want = [{ x: 0, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 50 }]
    expect(right.length).toBe(3)
    right.forEach((p, i) => { expect(p.x).toBeCloseTo(want[i]!.x, 9); expect(p.y).toBeCloseTo(want[i]!.y, 9) })
  })
  it('a star: arcs at the points, mitres in the notches, when pushed out', () => {
    const star = star5(150, 60)
    const pts = roundOffsetPolyline(star, true, 30)
    for (const [k, v] of star.entries()) {
      const close = pts.filter(p => Math.abs(Math.hypot(p.x - v.x, p.y - v.y) - 30) < 1e-9)
      if (k % 2 === 0) expect(close.length, `point ${k}`).toBeGreaterThan(4)   // tip: an arc round it
    }
    // nothing lies closer than 30 to the star (mitred notch points lie further, arcs exactly 30)
    for (const p of pts) expect(polylineDistance(p, star, true)).toBeGreaterThan(30 - 1e-9)
  })
})

describe('the band mesh covers the round-join band at a distance', () => {
  // The painter's straight band: centre offset `c`, half-width h. At c = 4h the old mitred
  // centreline left 1,024 of 11,096 rect points (h 15, c 90) and 3,008 of 11,380 star points
  // uncovered — a hole through the band at every corner.
  for (const [name, shape] of [['rect', rectCorners(300, 200)], ['star', star5(150, 60)], ['L-shape', lShape]] as const) {
    for (const c of [30, 60, 90]) {
      it(`${name}, h 15, centre ${c}`, () => assertOffsetBandCoverage(shape, 15, c))
    }
  }
})

describe('ringIsHole', () => {
  const sq = (s: number, cw = true): P[] => { const c = rectCorners(s, s); return cw ? c : c.slice().reverse() }
  const ring = (pts: P[]) => ({ pts, closed: true })
  it('an inner ring wound the OTHER way is a hole under either rule', () => {
    const rings = [ring(sq(200)), ring(sq(100, false))]
    for (const rule of ['nonzero', 'evenodd'] as const) {
      expect(ringIsHole(rings, 0, rule)).toBe(false)
      expect(ringIsHole(rings, 1, rule)).toBe(true)
    }
  })
  it('an inner ring wound the SAME way is a hole only under evenodd (nonzero fills it)', () => {
    const rings = [ring(sq(200)), ring(sq(100))]
    expect(ringIsHole(rings, 1, 'nonzero')).toBe(false)
    expect(ringIsHole(rings, 1, 'evenodd')).toBe(true)
    expect(ringIsHole(rings, 0, 'nonzero')).toBe(false)
  })
  it('an island inside a hole is not a hole; open subpaths never are', () => {
    const rings = [ring(sq(300)), ring(sq(200, false)), ring(sq(100))]
    expect(ringIsHole(rings, 2, 'nonzero')).toBe(false)
    expect(ringIsHole(rings, 2, 'evenodd')).toBe(false)
    expect(ringIsHole([{ pts: sq(100), closed: false }, ring(sq(300))], 0, 'evenodd')).toBe(false)
  })
})
