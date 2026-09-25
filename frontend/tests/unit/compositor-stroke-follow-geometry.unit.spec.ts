import { describe, it, expect } from 'vitest'
import {
  followFrame, triangleAffine, bandTriangles, followStripPlan, fadeStops,
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
  it('two per segment round a circle, none dropped, strip spans the band', () => {
    const f = followFrame(circle(100, 200), true, 10)!
    const tris = bandTriangles(f, 10)
    expect(tris.length).toBe(400)
    const ys = tris.flatMap(t => t.src.map(p => p.y))
    expect(Math.min(...ys)).toBe(0); expect(Math.max(...ys)).toBe(20)
    // strip y = 0 is the INNER edge: its band point is closer to the centre
    const t0 = tris[0]!
    expect(Math.hypot(t0.dst[0].x, t0.dst[0].y)).toBeCloseTo(90, 0)
    expect(Math.hypot(t0.dst[2].x, t0.dst[2].y)).toBeCloseTo(110, 0)
  })
  it('drops the triangles that fold over at a tight inner corner', () => {
    // a thin star: inner corners much tighter than the band is wide
    const star: P[] = Array.from({ length: 10 }, (_, i) => {
      const t = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 20 : 100
      return { x: r * Math.cos(t), y: r * Math.sin(t) }
    })
    const f = followFrame(resamplePolyline(star, true, 1), true, 15)!
    const segs = f.pts.length
    const tris = bandTriangles(f, 15)
    expect(tris.length).toBeLessThan(segs * 2)
    expect(tris.length).toBeGreaterThan(segs)   // most of the band survives
  })
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
