import type { SketchDoc, EntityId, ConstraintKind } from './model'
import { lineEndpoints, circleCenter } from './model'
import { dist, distPointToLine, sub, add, scale, len, type Vec2 } from './geom'
import { curveGeom, paramOf, pointAt, type CurveGeom } from './crossings'

interface SnapAt { x: number; y: number; dist: number }

/** Where a new point would land on existing geometry, and what it joins:
 *  - `coincident` — the new point IS the existing point `targetId`;
 *  - `midpoint` — the exact middle of the line (entity or path line segment)
 *    from point `a` to point `b`;
 *  - `pointOnLine` / `pointOnCircle` — on a line or circle entity `targetId`;
 *  - `onSegment` — on a path's line or arc segment (`pathId`, `segIndex`),
 *    with the point ids its rule needs (`a`→`b` for a line; `center` and the
 *    segment's start `a` for an arc).
 *  Lines and segments only snap between their ends; arcs only on the drawn arc. */
export type PointSnap =
  | (SnapAt & { kind: 'coincident'; targetId: EntityId })
  | (SnapAt & { kind: 'pointOnLine'; targetId: EntityId })
  | (SnapAt & { kind: 'pointOnCircle'; targetId: EntityId })
  | (SnapAt & { kind: 'midpoint'; a: EntityId; b: EntityId })
  | (SnapAt & { kind: 'onSegment'; pathId: EntityId; segIndex: number; seg: 'line'; a: EntityId; b: EntityId })
  | (SnapAt & { kind: 'onSegment'; pathId: EntityId; segIndex: number; seg: 'arc'; center: EntityId; a: EntityId })

/** What the overlay's snap preview chip shows. */
export type SnapPreviewKind = 'point' | 'midpoint' | 'curve'

export function snapPreviewKind(s: PointSnap): SnapPreviewKind {
  return s.kind === 'coincident' ? 'point' : s.kind === 'midpoint' ? 'midpoint' : 'curve'
}

/** The rule that pins a freshly placed point `p` where `s` put it — null for a
 *  coincident snap (the new point is the existing one, no rule). */
export function snapRule(s: PointSnap, p: EntityId): { kind: ConstraintKind; refs: EntityId[] } | null {
  switch (s.kind) {
    case 'coincident': return null
    case 'pointOnLine': return { kind: 'pointOnLine', refs: [p, s.targetId] }
    case 'pointOnCircle': return { kind: 'pointOnCircle', refs: [p, s.targetId] }
    case 'midpoint': return { kind: 'midpoint', refs: [p, s.a, s.b] }
    case 'onSegment':
      return s.seg === 'line'
        ? { kind: 'collinear', refs: [s.a, s.b, p] }
        : { kind: 'equalDist', refs: [s.center, p, s.center, s.a] }
  }
}

const RANK: Record<PointSnap['kind'], number> = { coincident: 0, midpoint: 1, pointOnLine: 2, pointOnCircle: 2, onSegment: 2 }
// a curve snap landing on (or clamped to) an end is left to that end's point
const T_EPS = 1e-9

export function snapPoint(
  doc: SketchDoc,
  x: number,
  y: number,
  opts: { tol?: number; exclude?: EntityId[]; skipCurvesUsing?: EntityId[] } = {},
): { x: number; y: number; snap: PointSnap | null } {
  const tol = opts.tol ?? 0.6
  const exclude = new Set(opts.exclude ?? [])
  // `skipCurvesUsing`: pieces built on any of these points (a line or path
  // segment ending at one, a circle or arc centred on one) are not targets —
  // a point being dragged can't join its own line or arc
  const using = new Set(opts.skipCurvesUsing ?? [])
  const p = { x, y }
  let best: PointSnap | null = null
  // point > midpoint > curve; among equals, nearer wins
  const consider = (s: PointSnap) => {
    if (s.dist > tol) return
    if (!best || RANK[s.kind] < RANK[best.kind] || (RANK[s.kind] === RANK[best.kind] && s.dist < best.dist)) best = s
  }
  // a straight piece a→b (line entity or path line segment): its middle, and
  // the nearest spot strictly between its ends
  const straight = (ga: Vec2, gb: Vec2, onIt: (at: SnapAt) => PointSnap, ia: EntityId, ib: EntityId) => {
    const m = { x: (ga.x + gb.x) / 2, y: (ga.y + gb.y) / 2 }
    if (dist(ga, gb) > 1e-9) consider({ kind: 'midpoint', a: ia, b: ib, x: m.x, y: m.y, dist: dist(p, m) })
    const g: CurveGeom = { ref: { kind: 'line', id: '' }, kind: 'line', a: ga, b: gb }
    const t = paramOf(g, p)
    if (t <= T_EPS || t >= 1 - T_EPS) return
    const on = pointAt(g, t)
    consider(onIt({ x: on.x, y: on.y, dist: dist(p, on) }))
  }
  for (const e of doc.entities) {
    if (exclude.has(e.id)) continue
    if (e.kind === 'point') {
      // construction points are guides (Guide-mode placement, sketch-draw.vue) —
      // full snap targets like any other point. The old pen/smooth-handle use
      // of construction points is retired from the draw UI, so there's no
      // longer a reason to exclude them here.
      const d = dist(p, { x: e.x, y: e.y })
      consider({ kind: 'coincident', targetId: e.id, x: e.x, y: e.y, dist: d })
    } else if (e.kind === 'line') {
      if (using.has(e.p1) || using.has(e.p2)) continue
      const ep = lineEndpoints(doc, e); if (!ep) continue
      straight(ep.a, ep.b, at => ({ kind: 'pointOnLine', targetId: e.id, ...at }), e.p1, e.p2)
    } else if (e.kind === 'circle') {
      if (using.has(e.center)) continue
      const cen = circleCenter(doc, e); if (!cen) continue
      const toC = sub(p, cen)
      const l = len(toC)
      if (l < 1e-9) continue // center itself — no meaningful circumference direction
      const on = add(cen, scale(toC, e.r / l))
      consider({ kind: 'pointOnCircle', targetId: e.id, x: on.x, y: on.y, dist: Math.abs(l - e.r) })
    } else if (e.kind === 'path') {
      const segCount = e.closed ? e.anchors.length : e.anchors.length - 1
      for (let i = 0; i < segCount; i++) {
        const seg = e.segments[i]
        if (!seg || seg.kind === 'cubic') continue   // Bézier segments are not snap targets
        const g = curveGeom(doc, { kind: 'seg', pathId: e.id, segIndex: i })
        if (!g) continue
        const ia = e.anchors[i]!, ib = e.anchors[(i + 1) % e.anchors.length]!
        if (using.has(ia) || using.has(ib) || (seg.kind === 'arc' && using.has(seg.center))) continue
        if (seg.kind === 'line') {
          straight(g.a!, g.b!, at => ({ kind: 'onSegment', pathId: e.id, segIndex: i, seg: 'line', a: ia, b: ib, ...at }), ia, ib)
        } else {
          const t = paramOf(g, p)
          if (t <= T_EPS || t >= 1 - T_EPS) continue   // off the drawn arc
          const on = pointAt(g, t)
          consider({ kind: 'onSegment', pathId: e.id, segIndex: i, seg: 'arc', center: seg.center, a: ia, x: on.x, y: on.y, dist: dist(p, on) })
        }
      }
    }
  }
  // `best` is only assigned inside consider(), so TS narrows it to null here
  const found = best as PointSnap | null
  if (found) return { x: found.x, y: found.y, snap: found }
  return { x, y, snap: null }
}

export interface TangentInfer {
  kind: 'tangentLineCircle' | 'tangentCircleCircle'
  targetId: EntityId
}

export function inferCircleTangents(
  doc: SketchDoc,
  centerX: number,
  centerY: number,
  r: number,
  opts: { tol?: number; exclude?: EntityId[] } = {},
): TangentInfer[] {
  const tol = opts.tol ?? 0.6
  const exclude = new Set(opts.exclude ?? [])
  const c = { x: centerX, y: centerY }
  const out: TangentInfer[] = []
  for (const e of doc.entities) {
    if (exclude.has(e.id)) continue
    if (e.kind === 'line') {
      const ep = lineEndpoints(doc, e); if (!ep) continue
      if (Math.abs(Math.abs(distPointToLine(c, ep.a, ep.b)) - r) < tol) {
        out.push({ kind: 'tangentLineCircle', targetId: e.id })
      }
    } else if (e.kind === 'circle') {
      const cen = circleCenter(doc, e); if (!cen) continue
      if (Math.abs(dist(c, cen) - (r + e.r)) < tol) {
        out.push({ kind: 'tangentCircleCircle', targetId: e.id })
      }
    }
  }
  return out
}

export function arcThroughTangent(J: Vec2, end: Vec2, tangentDir: Vec2): { center: Vec2; radius: number } | null {
  const tl = Math.hypot(tangentDir.x, tangentDir.y)
  if (tl < 1e-12) return null
  const tx = tangentDir.x / tl, ty = tangentDir.y / tl
  const nx = -ty, ny = tx                // unit normal to the tangent
  const dx = end.x - J.x, dy = end.y - J.y
  const nd = nx * dx + ny * dy           // N·d
  if (Math.abs(nd) < 1e-9) return null   // end lies along the tangent → straight
  const s = (dx * dx + dy * dy) / (2 * nd)
  const center = { x: J.x + s * nx, y: J.y + s * ny }
  return { center, radius: Math.abs(s) }
}

// circumcircle center of three points (null if collinear)
function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const dcp = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  if (Math.abs(dcp) < 1e-9) return null
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / (2 * dcp)
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / (2 * dcp)
  return { x: ux, y: uy }
}

export function sweepFor(J: Vec2, end: Vec2, pointer: Vec2, C: Vec2): 0 | 1 {
  const TAU = Math.PI * 2
  const a0 = Math.atan2(J.y - C.y, J.x - C.x)
  const a1 = Math.atan2(end.y - C.y, end.x - C.x)
  const aQ = Math.atan2(pointer.y - C.y, pointer.x - C.x)
  const ccw = ((a1 - a0) % TAU + TAU) % TAU
  const qccw = ((aQ - a0) % TAU + TAU) % TAU
  return qccw <= ccw ? 1 : 0
}

export interface JointArc { center: Vec2; radius: number; sweep: 0 | 1; snappedTangent: boolean }

export function tangentJointArc(J: Vec2, end: Vec2, pointer: Vec2, tangentDir: Vec2 | null, tolDeg = 12): JointArc | null {
  const freeC = circumcenter(J, end, pointer)
  if (!freeC) return null
  const sweep = sweepFor(J, end, pointer, freeC)
  let center = freeC
  let snappedTangent = false
  if (tangentDir) {
    // free arc's tangent at J is perpendicular to (J − freeC)
    const rx = J.x - freeC.x, ry = J.y - freeC.y            // radial dir
    const ftx = -ry, fty = rx                               // free tangent = ⊥ radial
    const fl = Math.hypot(ftx, fty), tl = Math.hypot(tangentDir.x, tangentDir.y)
    if (fl > 1e-9 && tl > 1e-9) {
      // undirected angle between free tangent and desired tangent
      const cosang = Math.abs((ftx * tangentDir.x + fty * tangentDir.y) / (fl * tl))
      const ang = Math.acos(Math.min(1, cosang)) * 180 / Math.PI
      if (ang <= tolDeg) {
        const snap = arcThroughTangent(J, end, tangentDir)
        if (snap) { center = snap.center; snappedTangent = true }
      }
    }
  }
  const radius = Math.hypot(J.x - center.x, J.y - center.y)
  // recompute sweep for the (possibly moved) center, still biased by the pointer side
  return { center, radius, sweep: sweepFor(J, end, pointer, center), snappedTangent }
}
