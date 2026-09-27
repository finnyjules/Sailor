// app/lib/sketch/tangency.ts
// Tangency, pen stage 4. Shared by the solver (the two new rule kinds read
// their circle operands here), the badges (the touch point), the rules row
// (which rule makes two pieces tangent) and the Pen's bow snap.
//
// A "circle operand" is how a tangency rule names a round thing: either a
// point pair [C, S] (centre, and any point on it — a path arc's centre and its
// start anchor) or a circle entity's id (its centre point and its r).
import type { SketchDoc, SketchEntity, SketchConstraint, PointEntity, CircleEntity, EntityId, ConstraintKind } from './model'
import { getEntity, getPoint } from './model'
import { dist, type Vec2 } from './geom'
import { curveGeom, allCurves, paramOf, pointAt, type CurveRef } from './crossings'

export type CircleOperand =
  | { kind: 'pair'; c: PointEntity; s: PointEntity }
  | { kind: 'circle'; c: PointEntity; circle: CircleEntity }

/** Reads refs[start..] as circle operands: a circle id takes one ref, a point
 *  takes itself and the next ref (which must be a point). Null when anything
 *  is missing or of the wrong kind; the caller checks how many it needs. */
export function readCircleOperands(map: ReadonlyMap<EntityId, SketchEntity>, refs: EntityId[], start: number): CircleOperand[] | null {
  const out: CircleOperand[] = []
  let i = start
  while (i < refs.length) {
    const e = map.get(refs[i]!)
    if (!e) return null
    if (e.kind === 'circle') {
      const c = map.get(e.center)
      if (!c || c.kind !== 'point') return null
      out.push({ kind: 'circle', c, circle: e })
      i += 1
    } else if (e.kind === 'point') {
      const s = map.get(refs[i + 1] ?? '')
      if (!s || s.kind !== 'point') return null
      out.push({ kind: 'pair', c: e, s })
      i += 2
    } else {
      return null
    }
  }
  return out
}

export function operandRadius(o: CircleOperand): number {
  return o.kind === 'circle' ? o.circle.r : Math.hypot(o.s.x - o.c.x, o.s.y - o.c.y)
}

function entityMap(doc: SketchDoc): Map<EntityId, SketchEntity> {
  const m = new Map<EntityId, SketchEntity>()
  for (const e of doc.entities) m.set(e.id, e)
  return m
}

/** Where a tangentLineArc / tangentArcs rule touches (its badge sits here):
 *  the foot of the centre on the line, or the point on the line of centres at
 *  the first radius. Null for any other kind or unreadable refs. */
export function tangentTouchPoint(doc: SketchDoc, c: SketchConstraint): Vec2 | null {
  const map = entityMap(doc)
  if (c.kind === 'tangentLineArc') {
    const a = map.get(c.refs[0]!), b = map.get(c.refs[1]!)
    const ops = readCircleOperands(map, c.refs, 2)
    if (!a || a.kind !== 'point' || !b || b.kind !== 'point' || !ops || ops.length !== 1) return null
    const o = ops[0]!
    const dx = b.x - a.x, dy = b.y - a.y
    const L2 = dx * dx + dy * dy
    if (L2 < 1e-18) return null
    const t = ((o.c.x - a.x) * dx + (o.c.y - a.y) * dy) / L2
    return { x: a.x + t * dx, y: a.y + t * dy }
  }
  if (c.kind === 'tangentArcs') {
    const ops = readCircleOperands(map, c.refs, 0)
    if (!ops || ops.length !== 2) return null
    const [o1, o2] = ops as [CircleOperand, CircleOperand]
    const r1 = operandRadius(o1), r2 = operandRadius(o2)
    const dx = o2.c.x - o1.c.x, dy = o2.c.y - o1.c.y
    const d = Math.hypot(dx, dy)
    if (d < 1e-9) return { x: o1.c.x + r1, y: o1.c.y }
    // inside, first one smaller: it touches on its far side from the other centre
    const k = c.value === -1 && r1 < r2 ? -1 : 1
    return { x: o1.c.x + (k * r1 * dx) / d, y: o1.c.y + (k * r1 * dy) / d }
  }
  return null
}

// ── pieces and the rule that makes two of them tangent ─────────────────────

export type TangentPiece =
  | { kind: 'line'; a: EntityId; b: EntityId; lineId?: EntityId }
  | { kind: 'arc'; c: EntityId; s: EntityId; e: EntityId }
  | { kind: 'circle'; id: EntityId; c: EntityId }

export interface RuleSpec { kind: ConstraintKind; refs: EntityId[]; value?: number }

export function curveKey(ref: CurveRef): string {
  return ref.kind === 'seg' ? `${ref.pathId}:${ref.segIndex}` : ref.id
}

/** A line entity, circle entity or path line/arc segment as a tangent piece;
 *  null for a Bézier segment or anything that no longer resolves. */
export function pieceOf(doc: SketchDoc, ref: CurveRef): TangentPiece | null {
  if (ref.kind === 'line') {
    const e = getEntity(doc, ref.id)
    return e && e.kind === 'line' ? { kind: 'line', a: e.p1, b: e.p2, lineId: e.id } : null
  }
  if (ref.kind === 'circle') {
    const e = getEntity(doc, ref.id)
    return e && e.kind === 'circle' ? { kind: 'circle', id: e.id, c: e.center } : null
  }
  const p = getEntity(doc, ref.pathId)
  if (!p || p.kind !== 'path') return null
  const segCount = p.closed ? p.anchors.length : p.anchors.length - 1
  if (ref.segIndex < 0 || ref.segIndex >= segCount) return null
  const seg = p.segments[ref.segIndex]
  const a = p.anchors[ref.segIndex], b = p.anchors[(ref.segIndex + 1) % p.anchors.length]
  if (!seg || !a || !b) return null
  if (seg.kind === 'line') return { kind: 'line', a, b }
  if (seg.kind === 'arc') return { kind: 'arc', c: seg.center, s: a, e: b }
  return null
}

const endsOf = (p: TangentPiece): EntityId[] => (p.kind === 'line' ? [p.a, p.b] : p.kind === 'arc' ? [p.s, p.e] : [])
// how a round piece is named in a rule: an arc by [centre, start], a circle by its id
const operandRefs = (p: Exclude<TangentPiece, { kind: 'line' }>): EntityId[] => (p.kind === 'arc' ? [p.c, p.s] : [p.id])

function roundGeom(doc: SketchDoc, p: Exclude<TangentPiece, { kind: 'line' }>): { c: Vec2; r: number } | null {
  const c = getPoint(doc, p.c)
  if (!c) return null
  if (p.kind === 'circle') {
    const e = getEntity(doc, p.id)
    return e && e.kind === 'circle' ? { c: { x: c.x, y: c.y }, r: e.r } : null
  }
  const s = getPoint(doc, p.s)
  return s ? { c: { x: c.x, y: c.y }, r: dist(c, s) } : null
}

/** The rule that makes pieces p and q tangent. Joined at a shared end → the
 *  joint forms the Pen already writes; apart → tangentLineArc / tangentArcs
 *  (a line entity and a circle keep tangentLineCircle). Null for two lines,
 *  or two round pieces on one centre. */
export function tangentRuleFor(doc: SketchDoc, p: TangentPiece, q: TangentPiece): RuleSpec | null {
  if (p.kind === 'line' && q.kind === 'line') return null
  if (q.kind === 'line') [p, q] = [q, p]   // a line always comes first
  const shared = endsOf(p).find(id => endsOf(q).includes(id))
  if (shared && p.kind === 'line' && q.kind === 'arc') {
    const other = p.a === shared ? p.b : p.a
    return { kind: 'perpendicular', refs: [other, shared, shared, q.c] }
  }
  if (shared && p.kind === 'arc' && q.kind === 'arc') return { kind: 'collinear', refs: [p.c, shared, q.c] }
  if (p.kind === 'line') {
    const round = q as Exclude<TangentPiece, { kind: 'line' }>
    if (round.kind === 'circle' && p.lineId) return { kind: 'tangentLineCircle', refs: [p.lineId, round.id] }
    return { kind: 'tangentLineArc', refs: [p.a, p.b, ...operandRefs(round)] }
  }
  const g1 = roundGeom(doc, p), g2 = roundGeom(doc, q as Exclude<TangentPiece, { kind: 'line' }>)
  if (!g1 || !g2) return null
  const d = dist(g1.c, g2.c)
  if (d < 1e-9) return null
  const side = Math.abs(d - (g1.r + g2.r)) <= Math.abs(d - Math.abs(g1.r - g2.r)) ? 1 : -1
  return { kind: 'tangentArcs', refs: [...operandRefs(p), ...operandRefs(q as Exclude<TangentPiece, { kind: 'line' }>)], value: side }
}

// ── the Pen's bow snap ──────────────────────────────────────────────────────

export interface BowTangentSnap { center: Vec2; r: number; target: CurveRef; touch: Vec2; side: 1 | -1 }

function quadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b]
  const disc = b * b - 4 * a * c
  if (disc < 0) return []
  const sq = Math.sqrt(disc)
  return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]
}

function curveUsesAny(doc: SketchDoc, ref: CurveRef, pts: Set<EntityId>): boolean {
  const p = pieceOf(doc, ref)
  if (!p) return true
  if (p.kind === 'line') return pts.has(p.a) || pts.has(p.b)
  if (p.kind === 'arc') return pts.has(p.c) || pts.has(p.s) || pts.has(p.e)
  return pts.has(p.c)
}

/** The arc being bowed runs through J and E; `freeCenter` is where the pointer
 *  alone puts its centre. If its circle nearly touches (within `tol`, drawing
 *  units) a line, circle or path line/arc segment — none built on
 *  `skipPoints` — returns the exact touching circle of the same family (centre
 *  on the chord's perpendicular bisector) and where it touches. */
export function bowTangentSnap(doc: SketchDoc, J: Vec2, E: Vec2, freeCenter: Vec2, tol: number, skipPoints: EntityId[]): BowTangentSnap | null {
  const L = dist(J, E)
  if (L < 1e-9) return null
  const h = L / 2
  const M = { x: (J.x + E.x) / 2, y: (J.y + E.y) / 2 }
  const n = { x: -(E.y - J.y) / L, y: (E.x - J.x) / L }
  const sFree = (freeCenter.x - M.x) * n.x + (freeCenter.y - M.y) * n.y
  const rFree = Math.hypot(h, sFree)
  const at = (s: number): Vec2 => ({ x: M.x + s * n.x, y: M.y + s * n.y })
  const skip = new Set(skipPoints)
  let best: (BowTangentSnap & { gap: number }) | null = null
  for (const ref of allCurves(doc)) {
    if (curveUsesAny(doc, ref, skip)) continue
    const g = curveGeom(doc, ref)
    if (!g) continue
    const cands: { s: number; touch: Vec2; side: 1 | -1 }[] = []
    let gap: number
    if (g.kind === 'line') {
      const a = g.a!, b = g.b!
      const ll = dist(a, b)
      if (ll < 1e-9) continue
      const u = { x: -(b.y - a.y) / ll, y: (b.x - a.x) / ll }
      const d0 = (M.x - a.x) * u.x + (M.y - a.y) * u.y
      const k = n.x * u.x + n.y * u.y
      gap = Math.abs(Math.abs(d0 + sFree * k) - rFree)
      // (d0 + s·k)² = h² + s²
      for (const s of quadraticRoots(k * k - 1, 2 * d0 * k, d0 * d0 - h * h)) {
        const C = at(s)
        const sd = (C.x - a.x) * u.x + (C.y - a.y) * u.y
        const touch = { x: C.x - sd * u.x, y: C.y - sd * u.y }
        const t = ((touch.x - a.x) * (b.x - a.x) + (touch.y - a.y) * (b.y - a.y)) / (ll * ll)
        if (t < 0 || t > 1) continue
        cands.push({ s, touch, side: 1 })
      }
    } else {
      const Q = g.c!, R = g.r!
      const w = { x: M.x - Q.x, y: M.y - Q.y }
      const ww = w.x * w.x + w.y * w.y
      const wn = w.x * n.x + w.y * n.y
      const dFree = dist(freeCenter, Q)
      // outside and inside are separate snaps: a root only counts on a side whose own gap is in reach
      const gapOut = Math.abs(dFree - (rFree + R)), gapIn = Math.abs(dFree - Math.abs(rFree - R))
      gap = Math.min(gapOut, gapIn)
      // |C−Q|² − r² − R² = ±2rR, i.e. (A0 + 2s·wn)² = 4R²(h² + s²)
      const A0 = ww - h * h - R * R
      for (const s of quadraticRoots(4 * wn * wn - 4 * R * R, 4 * A0 * wn, A0 * A0 - 4 * R * R * h * h)) {
        const C = at(s)
        const r = Math.hypot(h, s)
        const dq = dist(C, Q)
        if (dq < 1e-9) continue
        const side: 1 | -1 = A0 + 2 * s * wn >= 0 ? 1 : -1
        if ((side === 1 ? gapOut : gapIn) > tol) continue
        const ux = (C.x - Q.x) / dq, uy = (C.y - Q.y) / dq
        // outside, or this circle inside the target: on the target towards C; target inside this one: away from C
        const touch = side === 1 || R > r ? { x: Q.x + R * ux, y: Q.y + R * uy } : { x: Q.x - R * ux, y: Q.y - R * uy }
        if (g.kind === 'arc' && dist(pointAt(g, paramOf(g, touch)), touch) > 1e-6 * Math.max(1, R)) continue
        cands.push({ s, touch, side })
      }
    }
    if (gap > tol || !cands.length) continue
    const pick = cands.reduce((m, c) => (Math.abs(c.s - sFree) < Math.abs(m.s - sFree) ? c : m))
    const r = Math.hypot(h, pick.s)
    if (r > 1e4) continue
    if (!best || gap < best.gap) best = { center: at(pick.s), r, target: ref, touch: pick.touch, side: pick.side, gap }
  }
  if (!best) return null
  return { center: best.center, r: best.r, target: best.target, touch: best.touch, side: best.side }
}
