// app/lib/sketch/cleanup/detect-topology.ts
// Clean up's first stage: ends that nearly meet (joined into one point),
// points nearly on a curve (On curve) and joints that are nearly smooth
// (Tangent). Pure: reads a CleanupContext, returns candidates.
import type { EntityId } from '../model'
import type { Vec2 } from '../geom'
import { dist } from '../geom'
import { paramOf, pointAt } from '../crossings'
import { pieceOf, tangentRuleFor } from '../tangency'
import { clusterPairs, meanPoint } from './cluster'
import { onCurveRule, stableKey, type CleanupContext, type Piece } from './context'
import { TOL, countLabel, type Candidate } from './types'

export function detectJoins(ctx: CleanupContext): Candidate[] {
  const tol = ctx.tol(TOL.JOIN_PX)
  const endsOf = new Map<EntityId, Piece[]>()
  for (const p of ctx.pieces) {
    if (p.kind === 'circle') continue
    for (const id of [p.a!, p.b!]) endsOf.set(id, [...(endsOf.get(id) ?? []), p])
  }
  type Item = { id: EntityId; at: Vec2; pieces: Piece[]; end: boolean }
  const items: Item[] = []
  for (const [id, pieces] of endsOf) {
    const role = ctx.roles.get(id)
    const q = ctx.pts.get(id)
    if (!q || (role !== 'end' && role !== 'joint')) continue
    items.push({ id, at: { x: q.x, y: q.y }, pieces, end: role === 'end' })
  }
  const near = (u: Item, v: Item): number | null => {
    const d = dist(u.at, v.at)
    if (d > tol) return null
    if (!u.end && !v.end) return null                         // two joints: already built, leave them
    if (u.pieces.some(p => v.pieces.includes(p))) return null   // both ends of one piece
    const shortest = Math.min(...u.pieces.map(p => p.len), ...v.pieces.map(p => p.len))
    return d <= TOL.JOIN_SHORT_FRAC * shortest ? d : null
  }
  const out: Candidate[] = []
  for (const g of clusterPairs(items, near, grp => grp.filter(x => !x.end).length <= 1)) {
    if (g.length < 2) continue
    if (!g.some(x => x.pieces.some(p => p.inScope))) continue
    if (g.every(x => ctx.copies.has(x.id))) continue
    const ids = g.map(x => x.id).sort()
    let diam = 0
    for (const u of g) for (const v of g) diam = Math.max(diam, dist(u.at, v.at))
    out.push({
      id: `join:${ids.join(',')}`, kind: 'join', label: countLabel('Joined', g.length),
      score: 2 - diam / tol, anchor: ids, merges: { points: ids, at: meanPoint(g.map(x => x.at)) },
    })
  }
  return out
}

export function detectOnCurve(ctx: CleanupContext): Candidate[] {
  const tol = ctx.tol(TOL.ON_CURVE_PX), joinTol = ctx.tol(TOL.JOIN_PX)
  const out: Candidate[] = []
  for (const [id, pt] of ctx.pts) {
    const role = ctx.roles.get(id)
    if (pt.construction || (role !== 'end' && role !== 'free')) continue
    const movable = !ctx.held.has(id)
    let best: { q: Piece; d: number } | null = null
    for (const q of ctx.pieces) {
      if (q.points.includes(id)) continue
      if (!movable && !q.inScope) continue
      if (ctx.copies.has(id) && q.copy) continue
      const d = dist(pt, pointAt(q.geom, paramOf(q.geom, pt)))
      if (d > tol) continue
      // at a piece's own end it is a join, not a pin
      if (q.kind !== 'circle' && [q.a!, q.b!].some(e => { const E = ctx.pts.get(e); return !!E && dist(E, pt) <= joinTol })) continue
      if (!best || d < best.d) best = { q, d }
    }
    if (!best) continue
    const rule = onCurveRule(best.q, id)
    if (!rule) continue
    out.push({ id: `onCurve:${id}:${stableKey(best.q)}`, kind: 'onCurve', label: 'On curve', score: 1 - best.d / tol, anchor: [id], rules: [rule] })
  }
  return out
}

// the unit direction a piece leaves point `at` in
function outward(p: Piece, at: EntityId): Vec2 | null {
  const g = p.geom
  if (p.kind === 'line') {
    const from = at === p.a ? g.a! : g.b!, to = at === p.a ? g.b! : g.a!
    const L = dist(from, to)
    return L > 1e-12 ? { x: (to.x - from.x) / L, y: (to.y - from.y) / L } : null
  }
  if (p.kind !== 'arc') return null
  const sgn = Math.sign(g.sweepAngle!)
  const atEnd = at === p.b
  const ang = g.a0! + (atEnd ? g.sweepAngle! : 0)
  const travel = { x: -Math.sin(ang) * sgn, y: Math.cos(ang) * sgn }
  return atEnd ? { x: -travel.x, y: -travel.y } : travel
}

export function detectTangents(ctx: CleanupContext): Candidate[] {
  const tolDeg = TOL.KINK_DEG * ctx.s
  const at = new Map<EntityId, Piece[]>()
  for (const p of ctx.pieces) {
    if (p.kind === 'circle' || p.a === p.b) continue
    for (const id of [p.a!, p.b!]) at.set(id, [...(at.get(id) ?? []), p])
  }
  const out: Candidate[] = []
  for (const [J, ps] of at) {
    if (ps.length !== 2) continue
    const [p, q] = ps as [Piece, Piece]
    if (p.kind === 'line' && q.kind === 'line') continue
    if ((p.a === q.a || p.a === q.b) && (p.b === q.a || p.b === q.b)) continue   // two pieces on the same two points
    if (!p.inScope && !q.inScope) continue
    if (p.copy && q.copy) continue
    const u = outward(p, J), v = outward(q, J)
    if (!u || !v) continue
    const kink = Math.acos(Math.max(-1, Math.min(1, -(u.x * v.x + u.y * v.y)))) * 180 / Math.PI
    if (kink > tolDeg) continue
    const tp = pieceOf(ctx.doc, p.ref), tq = pieceOf(ctx.doc, q.ref)
    const rule = tp && tq ? tangentRuleFor(ctx.doc, tp, tq) : null
    if (!rule) continue
    out.push({ id: `tangent:${J}`, kind: 'tangent', label: 'Tangent', score: 1 - kink / tolDeg, anchor: [J], rules: [rule] })
  }
  return out
}
