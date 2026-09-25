import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addPath } from '~/lib/sketch/edit'
import { applyView } from '~/lib/sketch/view'
import { solve } from '~/lib/sketch/solve'
import { longestSubpath } from '~/lib/compositor/pathFlatten'
import { SKETCH_UNITS, sketchToLocalD, localOutlineBounds, recentreSketch, layerView, placementAfterRecentre, guideView } from '~/lib/compositor/penFrame'
import { customGuideMapping, guideFromPathD, guideFromPolyline } from '~/lib/compositor/textPath'

const square = (x0: number, y0: number, s: number): SketchDoc => {
  const d: SketchDoc = { entities: [], constraints: [] }
  const a = addPoint(d, x0, y0), b = addPoint(d, x0 + s, y0), c = addPoint(d, x0 + s, y0 + s), e = addPoint(d, x0, y0 + s)
  addPath(d, [a, b, c, e], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
  return d
}
const W = 680, H = 400

describe('penFrame', () => {
  it('drawing units are 1/100 of a local unit', () => {
    const b = localOutlineBounds(sketchToLocalD(square(10, 20, 30)))!
    expect(b.minX).toBeCloseTo(0.1, 9); expect(b.maxX).toBeCloseTo(0.4, 9)
    expect(b.minY).toBeCloseTo(0.2, 9); expect(b.maxY).toBeCloseTo(0.5, 9)
    expect(SKETCH_UNITS).toBe(100)
  })
  it('recentre moves the outline to the origin and reports the local shift and bbox', () => {
    const r = recentreSketch(square(10, 20, 30))!
    const b = localOutlineBounds(sketchToLocalD(r.sketch))!
    expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 9); expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 9)
    expect(r.shiftLocal.x).toBeCloseTo(0.25, 9); expect(r.shiftLocal.y).toBeCloseTo(0.35, 9)
    expect(r.bbox.w).toBeCloseTo(0.3, 9); expect(r.bbox.h).toBeCloseTo(0.3, 9)
  })
  it('layerView matches the painter transform (translate · rotate · shear · scale·W)', () => {
    const p = { x: 0.3, y: 0.6, rotation: 30, skewX: 10, skewY: 0, scale: 1.5 }
    const v = layerView(p, W, H)
    const local = { x: 0.1, y: -0.05 }                       // local units
    const got = applyView(v, { x: local.x * 100, y: local.y * 100 })
    // expected, computed the painter's way
    const s = 1.5 * W
    let x = local.x * s, y = local.y * s
    const tx = Math.tan(10 * Math.PI / 180), ty = 0
    ;[x, y] = [x + tx * y, ty * x + y]                       // shear matrix(1, tanY, tanX, 1)
    const r = 30 * Math.PI / 180
    ;[x, y] = [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]
    expect(got.x).toBeCloseTo(0.3 * W + x, 6); expect(got.y).toBeCloseTo(0.6 * H + y, 6)
  })
  it('layerView applies skewX and skewY together', () => {
    const p = { x: 0.2, y: 0.7, rotation: -15, skewX: 8, skewY: -12, scale: 0.8 }
    const v = layerView(p, W, H)
    const local = { x: -0.06, y: 0.09 }                      // local units
    const got = applyView(v, { x: local.x * 100, y: local.y * 100 })
    const s = 0.8 * W
    let x = local.x * s, y = local.y * s
    const tx = Math.tan(8 * Math.PI / 180), ty = Math.tan(-12 * Math.PI / 180)
    ;[x, y] = [x + tx * y, ty * x + y]                       // shear matrix(1, tanY, tanX, 1)
    const r = -15 * Math.PI / 180
    ;[x, y] = [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]
    expect(got.x).toBeCloseTo(0.2 * W + x, 6); expect(got.y).toBeCloseTo(0.7 * H + y, 6)
  })
  it('placementAfterRecentre keeps the outline where it was on screen', () => {
    const p = { x: 0.5, y: 0.5, rotation: 45, scale: 2 }
    const sk = square(10, 20, 30)
    const before = applyView(layerView(p, W, H), { x: 10, y: 20 })
    const r = recentreSketch(sk)!
    const q = { ...p, ...placementAfterRecentre(p, r.shiftLocal, W, H) }
    const movedCorner = { x: 10 - r.shiftLocal.x * 100, y: 20 - r.shiftLocal.y * 100 }
    const after = applyView(layerView(q, W, H), movedCorner)
    expect(after.x).toBeCloseTo(before.x, 6); expect(after.y).toBeCloseTo(before.y, 6)
  })
  it('customGuideMapping is exactly what guideFromPathD does', () => {
    const d = 'M -0.15 0 C -0.15 -0.18, 0.15 0.18, 0.15 0'
    const m = customGuideMapping(d, W, 0.3 * W)!
    const g = guideFromPathD(d, W, 0.3 * W)!
    const start = g.at(0)
    expect(start.x).toBeCloseTo(W * m.k * (-0.15 - m.mid.x), 3)
    expect(start.y).toBeCloseTo(W * m.k * (0 - m.mid.y), 3)
  })
  it('guideView maps a drawing point to where the text layer draws the guide', () => {
    const sk = square(0, 0, 20)
    const d = sketchToLocalD(sk)
    const text = { x: 0.4, y: 0.5, rotation: 0 }
    const v = guideView(text, { d, size: 0.2 }, W, H)!
    const m = customGuideMapping(d, W, 0.2 * W)!
    const p = applyView(v, { x: 0, y: 0 })
    expect(p.x).toBeCloseTo(0.4 * W + W * m.k * (0 - m.mid.x), 6)
    expect(p.y).toBeCloseTo(0.5 * H + W * m.k * (0 - m.mid.y), 6)
  })
  it('guideView applies rotation and skew on top of the guide mapping', () => {
    const sk = square(0, 0, 20)
    const d = sketchToLocalD(sk)
    const text = { x: 0.35, y: 0.6, rotation: 25, skewX: 6, skewY: -4 }
    const v = guideView(text, { d, size: 0.2 }, W, H)!
    const m = customGuideMapping(d, W, 0.2 * W)!
    const drawingPt = { x: 5, y: 12 }                        // arbitrary drawing-unit point
    const got = applyView(v, drawingPt)
    const localPt = { x: drawingPt.x / SKETCH_UNITS - m.mid.x, y: drawingPt.y / SKETCH_UNITS - m.mid.y }
    let x = W * m.k * localPt.x, y = W * m.k * localPt.y
    const tx = Math.tan(6 * Math.PI / 180), ty = Math.tan(-4 * Math.PI / 180)
    ;[x, y] = [x + tx * y, ty * x + y]
    const r = 25 * Math.PI / 180
    ;[x, y] = [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]
    expect(got.x).toBeCloseTo(text.x * W + x, 6)
    expect(got.y).toBeCloseTo(text.y * H + y, 6)
  })
  it('a Frame-sized drawing solves at these units', () => {
    const sk = square(10, 10, 40)
    const pt = sk.entities.find(e => e.kind === 'point')!
    const res = solve(sk, { drag: { point: pt.id, x: 12, y: 9 } })
    expect(res.converged).toBe(true)
  })
})

describe('guideFromPathD stays bit-identical to the pre-refactor arithmetic', () => {
  // The old body of `guideFromPathD`, verbatim, before `customGuideMapping` was
  // factored out — ×W then conditionally ×refit-factor, handed straight to
  // `guideFromPolyline` with no re-centring of its own. `customGuideMapping` now
  // supplies `k` (and the parsed `sub`), but the arithmetic building the
  // polyline must stay exactly this, or the guide drifts by float-epsilon
  // amounts between renders of the same drawing (a reviewer measured up to
  // 8.5e-13 px from reordering `×W×k(p−mid)` vs `×W` then `×k`).
  function oldGuideFromPathD(d: string, W: number, targetWidthPx = 0) {
    const sub = longestSubpath(d)
    if (!sub || sub.pts.length < 2) return null
    const k = Number.isFinite(W) && W > 0 ? W : 1
    let pts = sub.pts.map(p => ({ x: p.x * k, y: p.y * k }))
    if (targetWidthPx > 0) {
      let lo = Infinity, hi = -Infinity
      for (const p of pts) { if (p.x < lo) lo = p.x; if (p.x > hi) hi = p.x }
      const w = hi - lo
      if (w > 0) {
        const f = targetWidthPx / w
        pts = pts.map(p => ({ x: p.x * f, y: p.y * f }))
      }
    }
    return guideFromPolyline(pts, sub.closed)
  }

  const cases: Array<{ name: string; d: string; targetWidthPx: number }> = [
    { name: 'open cubic, no refit', d: 'M -0.15 0 C -0.15 -0.18, 0.15 0.18, 0.15 0', targetWidthPx: 0 },
    { name: 'open cubic, refit', d: 'M -0.15 0 C -0.15 -0.18, 0.15 0.18, 0.15 0', targetWidthPx: 0.3 * W },
    { name: 'closed square, no refit', d: 'M 0 0 L 1 0 L 1 1 L 0 1 Z', targetWidthPx: 0 },
    { name: 'closed square, refit', d: 'M 0 0 L 1 0 L 1 1 L 0 1 Z', targetWidthPx: 250 },
    { name: 'vertical line, no refit', d: 'M 0 0 L 0 1', targetWidthPx: 0 },
    { name: 'vertical line, zero-width refit request (k stays 1)', d: 'M 0 0 L 0 1', targetWidthPx: 100 },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const want = oldGuideFromPathD(c.d, W, c.targetWidthPx)
      const got = guideFromPathD(c.d, W, c.targetWidthPx)
      expect(want).not.toBeNull()
      expect(got).not.toBeNull()
      expect(got!.closed).toBe(want!.closed)
      expect(got!.length).toBe(want!.length)
      const L = want!.length
      for (const s of [-5, 0, L * 0.25, L * 0.5, L * 0.75, L, L + 5]) {
        const a = want!.at(s)
        const b = got!.at(s)
        expect(b.x).toBe(a.x)
        expect(b.y).toBe(a.y)
        expect(b.angle).toBe(a.angle)
      }
    })
  }
})
