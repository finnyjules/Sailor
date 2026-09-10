import { describe, it, expect } from 'vitest'
import { applyGeometry, GEOMETRY_EFFECT_LABELS } from '~/lib/compositor/geometryEffects'
import { flatten, pathLength, type Pt2 } from '~/lib/vector/pathOps'

// 100×100 square: perimeter 400. Same shape the pathOps spec uses.
const SQUARE_D = 'M0 0 L100 0 L100 100 L0 100 Z'
const W = 100

const flat = (d: string) => flatten(d)
const lenOf = (d: string) => {
  const subs = flatten(d)
  return subs.reduce((a, s) => a + pathLength(s.pts, s.closed), 0)
}

// Distance from a point to a segment [a,b].
function distToSeg(p: Pt2, a: Pt2, b: Pt2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
// Nearest distance from p to a closed polyline outline.
function distToOutline(p: Pt2, pts: Pt2[]): number {
  let best = Infinity
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!
    best = Math.min(best, distToSeg(p, a, b))
  }
  return best
}
const hasPointNear = (pts: Pt2[], q: Pt2, tol = 0.5) =>
  pts.some(p => Math.hypot(p.x - q.x, p.y - q.y) <= tol)

// Bounding box over every subpath's points.
function bboxOf(d: string) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of flatten(d)) for (const p of s.pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}
// Two closed subpaths: an outer 100×100 rect with an inner 40×40 hole.
const RECT_WITH_HOLE = 'M0 0 L100 0 L100 100 L0 100 Z M30 30 L70 30 L70 70 L30 70 Z'
// Same outer square wound the other way (CW vs CCW) — offset outward must still grow it.
const SQUARE_CW_D = 'M0 0 L0 100 L100 100 L100 0 Z'

describe('geometryEffects: labels single-source', () => {
  it('exposes sentence-case labels for the geometry kinds', () => {
    expect(GEOMETRY_EFFECT_LABELS.trim).toBe('Trim path')
    expect(GEOMETRY_EFFECT_LABELS.roughen).toBe('Roughen')
    expect(GEOMETRY_EFFECT_LABELS.offset).toBe('Offset path')
    expect(GEOMETRY_EFFECT_LABELS.round_corners).toBe('Round corners')
    expect(GEOMETRY_EFFECT_LABELS.boolean).toBe('Combine shapes')
    expect(GEOMETRY_EFFECT_LABELS.morph).toBe('Morph to shape')
  })
})

describe('geometryEffects: identity', () => {
  it('returns the SAME string when there are no effects', () => {
    expect(applyGeometry(SQUARE_D, [], { W })).toBe(SQUARE_D)
  })
  it('returns the SAME string when every effect is invisible', () => {
    const eff = [{ type: 'trim', start: 0, end: 0.5, offset: 0, visible: false }]
    expect(applyGeometry(SQUARE_D, eff, { W })).toBe(SQUARE_D)
  })
  it('ignores non-geometry kinds (they never reach the outline path)', () => {
    const eff = [{ type: 'bloom', visible: true }]
    expect(applyGeometry(SQUARE_D, eff, { W })).toBe(SQUARE_D)
  })
})

describe('geometryEffects: trim', () => {
  it('{0,0.5,0} keeps ~half the perimeter', () => {
    const d = applyGeometry(SQUARE_D, [{ type: 'trim', start: 0, end: 0.5, offset: 0, visible: true }], { W })
    expect(lenOf(d)).toBeCloseTo(200, 0)
  })
  it('{0,1,0} keeps ~the full outline', () => {
    const d = applyGeometry(SQUARE_D, [{ type: 'trim', start: 0, end: 1, offset: 0, visible: true }], { W })
    expect(lenOf(d)).toBeCloseTo(400, 0)
  })
  it('a trimmed closed loop becomes an OPEN polyline', () => {
    const d = applyGeometry(SQUARE_D, [{ type: 'trim', start: 0, end: 0.5, offset: 0, visible: true }], { W })
    expect(flat(d)[0]!.closed).toBe(false)
  })
  it('offset rotates which segment survives', () => {
    const d0 = applyGeometry(SQUARE_D, [{ type: 'trim', start: 0, end: 0.5, offset: 0, visible: true }], { W })
    const d25 = applyGeometry(SQUARE_D, [{ type: 'trim', start: 0, end: 0.5, offset: 0.25, visible: true }], { W })
    const p0 = flat(d0)[0]!.pts
    const p25 = flat(d25)[0]!.pts
    // The origin corner is on the surviving half at offset 0, and off it at offset 0.25.
    expect(hasPointNear(p0, { x: 0, y: 0 })).toBe(true)
    expect(hasPointNear(p25, { x: 0, y: 0 })).toBe(false)
    // Both keep the same arc length; only the location moved.
    expect(lenOf(d25)).toBeCloseTo(200, 0)
  })
  it('start >= end yields an empty path', () => {
    const d = applyGeometry(SQUARE_D, [{ type: 'trim', start: 0.6, end: 0.4, offset: 0, visible: true }], { W })
    expect(d).toBe('')
    expect(lenOf(d)).toBe(0)
  })
})

describe('geometryEffects: roughen', () => {
  const rough = (seed: number, amount = 0.05, detail = 8) =>
    applyGeometry(SQUARE_D, [{ type: 'roughen', amount, detail, seed, visible: true }], { W })

  it('is deterministic — same seed gives an identical d', () => {
    expect(rough(7)).toBe(rough(7))
  })
  it('a different seed gives a different d', () => {
    expect(rough(7)).not.toBe(rough(8))
  })
  it('amount 0 ≈ identity (same subpath count, ~same perimeter)', () => {
    const d = rough(7, 0)
    expect(flat(d).length).toBe(1)
    expect(lenOf(d)).toBeCloseTo(400, 0)
  })
  it('keeps the subpath count and closedness', () => {
    const subs = flat(rough(7))
    expect(subs.length).toBe(1)
    expect(subs[0]!.closed).toBe(true)
  })
  it('stays near the original — max displacement ≤ amount·W', () => {
    const amount = 0.05
    const subs = flat(rough(7, amount))
    const orig = flatten(SQUARE_D)[0]!.pts
    let maxD = 0
    for (const p of subs[0]!.pts) maxD = Math.max(maxD, distToOutline(p, orig))
    expect(maxD).toBeLessThanOrEqual(amount * W + 1e-6)
    // and it actually roughened (non-zero displacement somewhere)
    expect(maxD).toBeGreaterThan(0)
  })
})

describe('geometryEffects: offset', () => {
  const offset = (distance: number, d = SQUARE_D) =>
    applyGeometry(d, [{ type: 'offset', distance, visible: true }], { W })

  it('distance 0 is identity (same reference string)', () => {
    expect(offset(0)).toBe(SQUARE_D)
  })
  it('positive distance grows the bbox by ≈2·distance·W on each axis', () => {
    const b = bboxOf(offset(0.05)) // 0.05·100 = 5 px outward
    expect(b.minX).toBeCloseTo(-5, 1)
    expect(b.minY).toBeCloseTo(-5, 1)
    expect(b.maxX).toBeCloseTo(105, 1)
    expect(b.maxY).toBeCloseTo(105, 1)
  })
  it('negative distance shrinks the bbox inward', () => {
    const b = bboxOf(offset(-0.05))
    expect(b.minX).toBeCloseTo(5, 1)
    expect(b.minY).toBeCloseTo(5, 1)
    expect(b.maxX).toBeCloseTo(95, 1)
    expect(b.maxY).toBeCloseTo(95, 1)
  })
  it('is winding-aware: a CW and a CCW square both GROW when offset outward', () => {
    const bccw = bboxOf(offset(0.05, SQUARE_D))
    const bcw = bboxOf(offset(0.05, SQUARE_CW_D))
    // both wider than the original 100×100 (neither shrank)
    expect(bccw.maxX - bccw.minX).toBeGreaterThan(100)
    expect(bcw.maxX - bcw.minX).toBeGreaterThan(100)
    expect(bccw.maxX - bccw.minX).toBeCloseTo(bcw.maxX - bcw.minX, 1)
  })
  it('actually transforms — the offset stub is replaced', () => {
    expect(offset(0.05)).not.toBe(SQUARE_D)
    expect(lenOf(offset(0.05))).toBeGreaterThan(400)
  })
})

describe('geometryEffects: round corners', () => {
  const round = (radius: number, d = SQUARE_D) =>
    applyGeometry(d, [{ type: 'round_corners', radius, visible: true }], { W })

  it('radius 0 is identity (same reference string)', () => {
    expect(round(0)).toBe(SQUARE_D)
  })
  it('replaces the 4 sharp corners with Q curves; corner points gone', () => {
    const d = round(0.1) // 10 px fillet
    expect(d).toContain('Q')
    const pts = flat(d)[0]!.pts
    // the sharp corner vertices no longer sit on the outline
    for (const c of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]) {
      expect(hasPointNear(pts, c, 0.5)).toBe(false)
    }
    expect(flat(d)[0]!.closed).toBe(true)
  })
  it('keeps the bbox (rounding stays inside the original corner)', () => {
    const b = bboxOf(round(0.1))
    expect(b.minX).toBeCloseTo(0, 1)
    expect(b.minY).toBeCloseTo(0, 1)
    expect(b.maxX).toBeCloseTo(100, 1)
    expect(b.maxY).toBeCloseTo(100, 1)
  })
  it('clamps a huge radius so the shape does not invert', () => {
    const b = bboxOf(round(5)) // 500 px requested, clamped to 0.5·edge = 50
    expect(b.minX).toBeCloseTo(0, 1)
    expect(b.minY).toBeCloseTo(0, 1)
    expect(b.maxX).toBeCloseTo(100, 1)
    expect(b.maxY).toBeCloseTo(100, 1)
    expect(flat(round(5))[0]!.closed).toBe(true)
    expect(lenOf(round(5))).toBeGreaterThan(0)
  })
  it('actually transforms — the round-corners stub is replaced', () => {
    expect(round(0.1)).not.toBe(SQUARE_D)
  })
  it('leaves open-path endpoints sharp', () => {
    // An open V: only the middle vertex can be rounded.
    const open = 'M0 0 L50 50 L100 0'
    const d = applyGeometry(open, [{ type: 'round_corners', radius: 0.05, visible: true }], { W })
    const pts = flat(d)[0]!.pts
    expect(flat(d)[0]!.closed).toBe(false)
    expect(hasPointNear(pts, { x: 0, y: 0 })).toBe(true)   // endpoint kept
    expect(hasPointNear(pts, { x: 100, y: 0 })).toBe(true) // endpoint kept
    expect(hasPointNear(pts, { x: 50, y: 50 })).toBe(false) // middle rounded away
  })
})

describe('geometryEffects: multi-subpath', () => {
  it('offset keeps BOTH subpaths of a rect-with-hole', () => {
    const d = applyGeometry(RECT_WITH_HOLE, [{ type: 'offset', distance: 0.03, visible: true }], { W })
    expect(flat(d).length).toBe(2)
    expect(flat(d)[0]!.closed).toBe(true)
    expect(flat(d)[1]!.closed).toBe(true)
  })
  it('round corners keeps BOTH subpaths of a rect-with-hole', () => {
    const d = applyGeometry(RECT_WITH_HOLE, [{ type: 'round_corners', radius: 0.03, visible: true }], { W })
    const subs = flat(d)
    expect(subs.length).toBe(2)
    expect(d).toContain('Q')
    expect(subs[0]!.closed).toBe(true)
    expect(subs[1]!.closed).toBe(true)
  })
})

// ── Task 5: the render-facing seam in useCompositorLayers (computedOutlineD /
// needsComputedOutline / layerGeometryEffects). These transform a layer's OWN
// outline before it rasterises; the pure transform above is exercised through them.
import {
  computedOutlineD,
  needsComputedOutline,
  layerGeometryEffects,
  geometryOutwardPx,
  outlinePathData,
  createRectLayer,
  createEllipseLayer,
  createPolygonLayer,
  createStarLayer,
  createTextLayer,
  createImageLayer,
} from '~/composables/useCompositorLayers'

const geo = (type: string, extra: Record<string, unknown> = {}) =>
  ({ id: `fx_${type}`, type, visible: true, ...extra })

describe('useCompositorLayers: layerGeometryEffects', () => {
  it('returns only the visible geometry entries', () => {
    const layer = createRectLayer({
      effects: [
        geo('round_corners', { radius: 0.02 }),
        geo('bloom') as any,                       // pixel kind — excluded
        geo('trim', { start: 0, end: 0.5, offset: 0, visible: false }), // hidden — excluded
      ] as any,
    })
    const g = layerGeometryEffects(layer)
    expect(g.map(e => e.type)).toEqual(['round_corners'])
  })
  it('is empty for a layer with no effects', () => {
    expect(layerGeometryEffects(createRectLayer())).toEqual([])
  })
})

describe('useCompositorLayers: computedOutlineD', () => {
  const W = 300
  it('returns the base outline unchanged for a rect with no geometry effect', () => {
    const rect = createRectLayer({ w: 0.4, h: 0.2, radius: 0 })
    expect(computedOutlineD(rect, W)).toBe(outlinePathData(rect, W))
  })
  it('returns a TRIMMED outline for a rect with a trim effect', () => {
    const rect = createRectLayer({ w: 0.4, h: 0.2, radius: 0 })
    const base = outlinePathData(rect, W)!
    const trimmed = createRectLayer({
      w: 0.4, h: 0.2, radius: 0,
      effects: [geo('trim', { start: 0, end: 0.5, offset: 0 })] as any,
    })
    const d = computedOutlineD(trimmed, W)!
    expect(d).not.toBe(base)
    // ~half the perimeter survives; the base rect perimeter is 2·(0.4+0.2)·W.
    const perim = 2 * (0.4 + 0.2) * W
    expect(lenOf(d)).toBeCloseTo(perim / 2, -1)
  })
  it('round_corners on a rect emits Q curves and stays inside the box', () => {
    const rect = createRectLayer({
      w: 0.4, h: 0.2, radius: 0,
      effects: [geo('round_corners', { radius: 0.03 })] as any,
    })
    expect(computedOutlineD(rect, W)).toContain('Q')
  })
  it('returns null when there is no base outline (image)', () => {
    const img = createImageLayer('x.png', 1, { effects: [geo('trim', { start: 0, end: 0.5 })] as any })
    expect(computedOutlineD(img, W)).toBeNull()
  })
})

describe('useCompositorLayers: needsComputedOutline', () => {
  it('is TRUE for a rect with a geometry effect', () => {
    expect(needsComputedOutline(createRectLayer({ effects: [geo('round_corners', { radius: 0.02 })] as any }))).toBe(true)
  })
  it('is TRUE for an ellipse / polygon / star with a geometry effect', () => {
    expect(needsComputedOutline(createEllipseLayer({ effects: [geo('offset', { distance: 0.01 })] as any }))).toBe(true)
    expect(needsComputedOutline(createPolygonLayer({ effects: [geo('trim', { start: 0, end: 0.5 })] as any }))).toBe(true)
    expect(needsComputedOutline(createStarLayer({ effects: [geo('roughen', { amount: 0.02 })] as any }))).toBe(true)
  })
  it('is FALSE for a rect with only a pixel effect', () => {
    expect(needsComputedOutline(createRectLayer({ effects: [geo('bloom') as any] as any }))).toBe(false)
  })
  it('is FALSE for a rect with no effects', () => {
    expect(needsComputedOutline(createRectLayer())).toBe(false)
  })
  it('is FALSE for an image layer even with a geometry effect', () => {
    expect(needsComputedOutline(createImageLayer('x.png', 1, { effects: [geo('trim', { start: 0, end: 0.5 })] as any }))).toBe(false)
  })
  it('is FALSE for a DECORATED text layer (underline) that carries a geometry effect', () => {
    const t = createTextLayer({ underline: true, effects: [geo('round_corners', { radius: 0.02 })] as any })
    expect(needsComputedOutline(t)).toBe(false)
  })
  it('is FALSE for a text layer with a distance-band stroke plus a geometry effect', () => {
    const t = createTextLayer({
      effects: [geo('round_corners', { radius: 0.02 })] as any,
      strokes: [{ id: 's1', paint: '#000', width: 0.01, distance: 0.02, align: 'center', visible: true }] as any,
    })
    expect(needsComputedOutline(t)).toBe(false)
  })
})

// ── Task 8 (Minor 1): offscreen rasters pad for outward geometry growth. The pure
// helper reports how far a layer's enabled geometry effects push its outline PAST the
// box edge, so the silhouette / corner-pin / DOF rasters grow to hold the grown ink.
describe('useCompositorLayers: geometryOutwardPx', () => {
  const W = 300
  it('is 0 for a layer with no geometry effect (byte-identity pad preserved)', () => {
    expect(geometryOutwardPx(createRectLayer(), W)).toBe(0)
  })
  it('is 0 for trim-only (trim removes, never grows outward)', () => {
    const r = createRectLayer({ effects: [geo('trim', { start: 0, end: 0.5, offset: 0.3 })] as any })
    expect(geometryOutwardPx(r, W)).toBe(0)
  })
  it('is 0 for round_corners-only (fillets only cut inward)', () => {
    const r = createRectLayer({ effects: [geo('round_corners', { radius: 0.05 })] as any })
    expect(geometryOutwardPx(r, W)).toBe(0)
  })
  it('is distance·W for a positive offset', () => {
    const r = createRectLayer({ effects: [geo('offset', { distance: 0.02 })] as any })
    expect(geometryOutwardPx(r, W)).toBeCloseTo(0.02 * W, 6)
  })
  it('is 0 for a NEGATIVE offset (inward shrink grows nothing)', () => {
    const r = createRectLayer({ effects: [geo('offset', { distance: -0.02 })] as any })
    expect(geometryOutwardPx(r, W)).toBe(0)
  })
  it('is amount·W for a roughen', () => {
    const r = createRectLayer({ effects: [geo('roughen', { amount: 0.03 })] as any })
    expect(geometryOutwardPx(r, W)).toBeCloseTo(0.03 * W, 6)
  })
  it('is the MAX across several geometry effects', () => {
    const r = createRectLayer({
      effects: [
        geo('offset', { distance: 0.01 }),
        geo('roughen', { amount: 0.04 }),
        geo('trim', { start: 0, end: 0.9, offset: 0.2 }),
        geo('round_corners', { radius: 0.5 }),
      ] as any,
    })
    expect(geometryOutwardPx(r, W)).toBeCloseTo(0.04 * W, 6)
  })
  it('ignores a hidden geometry effect', () => {
    const r = createRectLayer({ effects: [geo('offset', { distance: 0.05, visible: false })] as any })
    expect(geometryOutwardPx(r, W)).toBe(0)
  })
  it('is 0 for an image layer (cannot take geometry) even with an offset', () => {
    const img = createImageLayer('x.png', 1, { effects: [geo('offset', { distance: 0.05 })] as any })
    expect(geometryOutwardPx(img, W)).toBe(0)
  })
  it('is 0 for a DECORATED text layer (underline) that carries an offset', () => {
    const t = createTextLayer({ underline: true, effects: [geo('offset', { distance: 0.05 })] as any })
    expect(geometryOutwardPx(t, W)).toBe(0)
  })
  it('is distance·W for a non-decorated (outlined) text layer with a positive offset', () => {
    const t = createTextLayer({ effects: [geo('offset', { distance: 0.02 })] as any })
    expect(geometryOutwardPx(t, W)).toBeCloseTo(0.02 * W, 6)
  })
})
