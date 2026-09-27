// app/lib/sketch/cleanup/guards.ts
// What keeps Clean up honest: a solve that holds what may not move (and only
// solves the part of the drawing a fix touches), and the checks every
// accepted fix must pass against the drawing as it was before Clean up — no
// point moved too far, no arc turned inside out or squeezed away.
import type { SketchDoc, SketchEntity, EntityId, SketchConstraint, ConstraintKind } from '../model'
import type { Vec2 } from '../geom'
import { dist } from '../geom'
import { cloneDoc } from '../clone'
import { solve } from '../solve'
import { curveGeom, pointAt, type CurveGeom, type CurveRef } from '../crossings'
import { buildContext } from './context'
import { GUARD } from './types'

/** Solves `doc` in place with `held` points and circle radii kept where they
 *  are (the solver's own `fixed`, and a radius rule, on a private copy). False
 *  — and `doc` untouched — when it does not converge, or when it settles with
 *  a rule still not holding (a least-squares standstill between rules that
 *  can't all be met with what is held — final review I1: accepting it left
 *  rules unmet below the 1e-3 "conflict" refusal, re-solved invisibly by the
 *  next drag). */
export function solveHeld(doc: SketchDoc, held: ReadonlySet<EntityId>): boolean {
  const plain = cloneDoc(doc)
  for (const e of plain.entities) {
    if (e.kind === 'point' && held.has(e.id)) e.fixed = true
    else if (e.kind === 'circle' && held.has(e.id)) plain.constraints.push({ id: `__held_${e.id}`, kind: 'radius', refs: [e.id], value: e.r })
  }
  const res = solve(plain, { maxIter: 120 })
  if (!res.converged || res.residualNorm > HOLDS) return false
  const solved = new Map(plain.entities.map(e => [e.id, e]))
  for (const e of doc.entities) {
    const s = solved.get(e.id)
    if (e.kind === 'point' && s?.kind === 'point') { e.x = s.x; e.y = s.y }
    else if (e.kind === 'circle' && s?.kind === 'circle') e.r = s.r
  }
  return true
}

// every rule holds: ten times the solver's own target (1e-6), which a solve
// that meets its rules reaches; its "converged" (< 1e-3) also passes a standstill
const HOLDS = 1e-5

// the points an id stands for: a point itself, a line's ends, a circle's centre
// and its radius (the circle id), every point a path is built on
function pointsOf(map: ReadonlyMap<EntityId, SketchEntity>, id: EntityId): EntityId[] {
  const e = map.get(id)
  if (!e) return []
  if (e.kind === 'point') return [e.id]
  if (e.kind === 'line') return [e.p1, e.p2]
  if (e.kind === 'circle') return [e.center, e.id]     // the radius travels with its centre
  const out = [...e.anchors]
  for (const s of e.segments) {
    if (s.kind === 'arc') out.push(s.center)
    else if (s.kind === 'cubic') { if (s.h1) out.push(s.h1); if (s.h2) out.push(s.h2) }
  }
  return out
}

/** **Ruling (final review, round 2):** which rules make two things one part —
 *  positional and structural ones only. Size-only rules (a distance, an equal
 *  radius, an equal length between separate pieces) and directions
 *  (horizontal, vertical, parallel, perpendicular — where pieces share a
 *  point they are one part already) do not: Clean up's own Same length would
 *  otherwise weld a drawing of separate shapes into one. An equalDist
 *  [C, p, C, q] holds a point on a circle round C (an arc's own ends, an On
 *  curve pin) — positional. A size rule to another part is still solved: the
 *  window solve holds whatever it reaches outside the window. */
const JOINING = new Set<ConstraintKind>([
  'coincident', 'pointOnLine', 'pointOnCircle', 'collinear', 'midpoint', 'concentric',
  'tangentLineCircle', 'tangentCircleCircle', 'tangentLineArc', 'tangentArcs',
  'rotatedFrom', 'mirroredFrom', 'offsetLine', 'offsetRadius', 'translatedFrom',
])
export function joinsParts(c: SketchConstraint): boolean {
  return JOINING.has(c.kind) || (c.kind === 'equalDist' && c.refs.length === 4 && c.refs[0] === c.refs[2])
}
/** What a solve must reach together: the joining rules and the direction
 *  rules (a Parallel between two separate lines turns both) — never a size
 *  rule, whose far end the window solve holds. Shapes (partNames, for Mirror
 *  pairs) are joined by joinsParts only. */
const DIRECTION = new Set<ConstraintKind>(['horizontal', 'vertical', 'parallel', 'perpendicular'])
export function joinsSolve(c: SketchConstraint): boolean {
  return joinsParts(c) || DIRECTION.has(c.kind)
}

// union-find over the drawing's points: two points are one part when a piece
// or a rule `joins` accepts ties them
function partFinder(doc: SketchDoc, joins: (c: SketchConstraint) => boolean): { find: (x: EntityId) => EntityId; pts: (id: EntityId) => EntityId[] } {
  const map = new Map(doc.entities.map(e => [e.id, e]))
  const parent = new Map<EntityId, EntityId>()
  const find = (x: EntityId): EntityId => {
    let r = x
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!
    let y = x
    while ((parent.get(y) ?? y) !== y) { const n = parent.get(y)!; parent.set(y, r); y = n }
    return r
  }
  const union = (ids: EntityId[]) => {
    const [first, ...rest] = ids
    if (!first) return
    const r = find(first)
    for (const x of rest) { const s = find(x); if (s !== r) parent.set(s, r) }
  }
  const pts = (id: EntityId) => pointsOf(map, id)
  for (const e of doc.entities) if (e.kind !== 'point') union(pts(e.id))
  for (const c of doc.constraints) if (joins(c)) union(c.refs.flatMap(pts))
  return { find, pts }
}

/** The entities of the connected parts of the drawing that `seeds` (ids of
 *  points, pieces or circles) belong to — two things are connected when a
 *  piece or a joining or direction rule (joinsSolve) ties their points — and every rule
 *  that touches them (a size rule may reach another part: solve the part with
 *  solveWindow, which holds what it reaches). The entity objects are the
 *  drawing's own (not copies). */
export function componentOf(doc: SketchDoc, seeds: readonly EntityId[]): SketchDoc {
  const { find, pts } = partFinder(doc, joinsSolve)
  const roots = new Set(seeds.flatMap(pts).map(find))
  const keep = (id: EntityId) => pts(id).some(p => roots.has(find(p)))
  return { entities: doc.entities.filter(e => keep(e.id)), constraints: doc.constraints.filter(c => c.refs.some(keep)) }
}

/** The points and circle radii of a part (from componentOf), as a window. */
export function windowOfPart(part: SketchDoc): Set<EntityId> {
  return new Set(part.entities.filter(e => e.kind === 'point' || e.kind === 'circle').map(e => e.id))
}

/** Which connected part each point of the drawing is in, named by the
 *  smallest point id of the part (so the name doesn't depend on order). */
export function partNames(doc: SketchDoc): Map<EntityId, EntityId> {
  const { find } = partFinder(doc, joinsParts)
  const least = new Map<EntityId, EntityId>()
  const ids = doc.entities.filter(e => e.kind === 'point').map(e => e.id)
  for (const id of ids) { const r = find(id), m = least.get(r); if (m == null || id < m) least.set(r, id) }
  return new Map(ids.map(id => [id, least.get(find(id))!]))
}

/** **Ruling (fix rounds 1–2):** a candidate is first solved in a window — the
 *  points it touches and every point within this many hops of them (a hop =
 *  sharing a line, a path segment, its arc centre included, a circle, or a
 *  rule), plus the radius of every circle centred in it; everything else is
 *  held. Only when the window doesn't converge, or its
 *  answer fails a guard, is the whole connected part solved. */
export const WINDOW_HOPS = 2

/** The points a candidate's solve may move first: `seeds` (ids of points,
 *  pieces or circles) and every point within `hops` hops of them. */
export function windowOf(doc: SketchDoc, seeds: readonly EntityId[], hops = WINDOW_HOPS): Set<EntityId> {
  const map = new Map(doc.entities.map(e => [e.id, e]))
  const next = new Map<EntityId, Set<EntityId>>()
  const link = (ids: EntityId[]) => {
    for (const a of ids) {
      let s = next.get(a)
      if (!s) next.set(a, (s = new Set()))
      for (const b of ids) if (b !== a) s.add(b)
    }
  }
  for (const e of doc.entities) {
    if (e.kind === 'line') link([e.p1, e.p2])
    else if (e.kind === 'circle') link([e.center, e.id])
    else if (e.kind === 'path') {
      const n = e.closed ? e.anchors.length : e.anchors.length - 1
      for (let i = 0; i < n; i++) {
        const s = e.segments[i], ids = [e.anchors[i]!, e.anchors[(i + 1) % e.anchors.length]!]
        if (s?.kind === 'arc') ids.push(s.center)
        else if (s?.kind === 'cubic') { if (s.h1) ids.push(s.h1); if (s.h2) ids.push(s.h2) }
        link(ids)
      }
    }
  }
  // a hop along a positional or direction rule (joinsSolve); never along a
  // size rule to another shape — solveWindow holds what such a rule reaches,
  // instead of the window growing over every shape one Same length group ties
  for (const c of doc.constraints) if (joinsSolve(c)) link([...new Set(c.refs.flatMap(r => pointsOf(map, r)))])
  const win = new Set<EntityId>(seeds.flatMap(id => pointsOf(map, id)))
  let front = [...win]
  for (let k = 0; k < hops; k++) {
    const grown: EntityId[] = []
    for (const a of front) for (const b of next.get(a) ?? []) if (!win.has(b)) { win.add(b); grown.push(b) }
    front = grown
  }
  // a circle whose centre may move may change its radius too
  for (const e of doc.entities) if (e.kind === 'circle' && win.has(e.center)) win.add(e.id)
  return win
}

/** Solves only the window `win` of `doc`: its points move (and the radii of
 *  circles in it), every other point a rule of the window reaches is held
 *  where it is, as are the `held` ones. Rules that touch no window point are
 *  left out — nothing they read moves. False (and `doc` untouched) when it
 *  does not converge. */
export function solveWindow(doc: SketchDoc, win: ReadonlySet<EntityId>, held: ReadonlySet<EntityId>): boolean {
  const map = new Map(doc.entities.map(e => [e.id, e]))
  const constraints = doc.constraints.filter(c => c.refs.some(r => pointsOf(map, r).some(p => win.has(p))))
  const need = new Set<EntityId>(win)
  for (const c of constraints) for (const r of c.refs) { need.add(r); for (const p of pointsOf(map, r)) need.add(p) }
  const entities = doc.entities.filter(e => need.has(e.id) && e.kind !== 'path')
  const hold = new Set(held)
  for (const e of entities) if (!win.has(e.id)) hold.add(e.id)
  return solveHeld({ entities, constraints }, hold)
}

/** Whether the connected part `part` has a point or circle outside `win`. */
export function reachesBeyond(part: SketchDoc, win: ReadonlySet<EntityId>): boolean {
  return part.entities.some(e => (e.kind === 'point' || e.kind === 'circle') && !win.has(e.id))
}

interface ArcRecord { c: EntityId; a: EntityId; b: EntityId; side: number; span: number; len: number; r: number }
export interface Baseline {
  unitsPerPx: number
  pos: Map<EntityId, Vec2>
  cap: Map<EntityId, number>
  radius: Map<EntityId, { r: number; cap: number }>
  arcs: ArcRecord[]
  /** every line and straight path segment (guides included) with its drawn length */
  straights: { a: EntityId; b: EntityId; len: number }[]
}

// which side of its chord A→B the drawn arc's middle lies on (+1 / −1 / 0)
function arcSide(A: Vec2, B: Vec2, g: CurveGeom): number {
  const M = pointAt(g, 0.5)
  return Math.sign((B.x - A.x) * (M.y - A.y) - (B.y - A.y) * (M.x - A.x))
}

/** The original drawing, as the guards compare against it. */
export function baselineOf(doc: SketchDoc, unitsPerPx: number): Baseline {
  const ctx = buildContext(doc, { held: new Set(), copies: new Set(), s: 1, unitsPerPx })
  const floor = GUARD.MOVE_PX * unitsPerPx
  const smallest = new Map<EntityId, number>()
  for (const p of ctx.pieces) for (const id of p.points) smallest.set(id, Math.min(smallest.get(id) ?? Infinity, p.size))
  const pos = new Map<EntityId, Vec2>(), cap = new Map<EntityId, number>()
  for (const [id, Q] of ctx.pts) {
    pos.set(id, { x: Q.x, y: Q.y })
    const s = smallest.get(id)
    cap.set(id, Math.max(floor, s != null && Number.isFinite(s) ? GUARD.MOVE_FRAC * s : 0))
  }
  const radius = new Map<EntityId, { r: number; cap: number }>()
  const arcs: ArcRecord[] = []
  for (const p of ctx.pieces) {
    if (p.kind === 'circle') radius.set(p.circle!, { r: p.geom.r!, cap: Math.max(floor, GUARD.MOVE_FRAC * p.geom.r!) })
    else if (p.kind === 'arc') arcs.push({ c: p.c!, a: p.a!, b: p.b!, side: arcSide(p.geom.a!, p.geom.b!, p.geom), span: Math.abs(p.geom.sweepAngle!), len: p.len, r: p.geom.r! })
  }
  const straights: Baseline['straights'] = []
  const lenOf = (a: EntityId, b: EntityId) => { const A = ctx.pts.get(a), B = ctx.pts.get(b); return A && B ? dist(A, B) : null }
  for (const e of doc.entities) {
    if (e.kind === 'line') { const L = lenOf(e.p1, e.p2); if (L != null) straights.push({ a: e.p1, b: e.p2, len: L }) }
    else if (e.kind === 'path') {
      const n = e.closed ? e.anchors.length : e.anchors.length - 1
      for (let i = 0; i < n; i++) {
        if (e.segments[i]?.kind !== 'line') continue
        const a = e.anchors[i]!, b = e.anchors[(i + 1) % e.anchors.length]!
        const L = lenOf(a, b)
        if (L != null) straights.push({ a, b, len: L })
      }
    }
  }
  return { unitsPerPx, pos, cap, radius, arcs, straights }
}

/** A point moved further from where it started than its cap, or a circle's
 *  radius changed by more than its cap. Points merged away, and guide points
 *  Clean up made, are not in the baseline and so are not held to it. */
export function movedTooFar(doc: SketchDoc, base: Baseline): boolean {
  for (const e of doc.entities) {
    if (e.kind === 'point') {
      const p0 = base.pos.get(e.id)
      if (p0 && dist(p0, e) > base.cap.get(e.id)! + 1e-9) return true
    } else if (e.kind === 'circle') {
      const r0 = base.radius.get(e.id)
      if (r0 && Math.abs(e.r - r0.r) > r0.cap + 1e-9) return true
    }
  }
  return false
}

function findArc(doc: SketchDoc, c: EntityId, a: EntityId, b: EntityId): CurveRef | null {
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    const n = e.closed ? e.anchors.length : e.anchors.length - 1
    for (let i = 0; i < n; i++) {
      const s = e.segments[i]
      if (s?.kind !== 'arc' || s.center !== c) continue
      const x = e.anchors[i], y = e.anchors[(i + 1) % e.anchors.length]
      if ((x === a && y === b) || (x === b && y === a)) return { kind: 'seg', pathId: e.id, segIndex: i }
    }
  }
  return null
}

/** An arc that turned inside out (its middle crossed to the other side of
 *  its ends, or it jumped between a small and a large arc) or ended shorter
 *  than 2 px (length or radius) when it wasn't. `resolve` maps an original
 *  point id to the id it became through merges. */
export function arcBroken(doc: SketchDoc, base: Baseline, resolve: (id: EntityId) => EntityId): boolean {
  const min = GUARD.ARC_MIN_PX * base.unitsPerPx
  const at = new Map<EntityId, Vec2>()
  for (const e of doc.entities) if (e.kind === 'point') at.set(e.id, e)
  for (const rec of base.arcs) {
    const c = resolve(rec.c), a = resolve(rec.a), b = resolve(rec.b)
    const ref = findArc(doc, c, a, b)
    if (!ref) continue
    const g = curveGeom(doc, ref)
    const A = at.get(a), B = at.get(b)
    if (!g || g.kind !== 'arc' || !A || !B) continue
    const side = arcSide(A, B, g)
    if (rec.side !== 0 && side !== 0 && side !== rec.side) return true
    if (Math.abs(Math.abs(g.sweepAngle!) - rec.span) > Math.PI / 2) return true
    const len = g.r! * Math.abs(g.sweepAngle!)
    if ((len < min && rec.len >= min) || (g.r! < min && rec.r >= min)) return true
  }
  return false
}

/** A straight piece squeezed under 2 px: a line or straight path segment
 *  drawn at 2 px or more (ends resolved through merges; one whose two ends
 *  became one point is a join's business, not a squeeze), or a guide line
 *  this fix made (`created`). A rule can be met by shrinking a piece to a
 *  point — Horizontal and Parallel to a held line, say — and that is never a
 *  clean-up. */
export function lineCollapsed(doc: SketchDoc, base: Baseline, resolve: (id: EntityId) => EntityId, created: ReadonlySet<EntityId> = new Set()): boolean {
  const min = GUARD.ARC_MIN_PX * base.unitsPerPx
  const at = new Map<EntityId, Vec2>()
  for (const e of doc.entities) if (e.kind === 'point') at.set(e.id, e)
  const short = (a: EntityId, b: EntityId) => { const A = at.get(a), B = at.get(b); return !!A && !!B && dist(A, B) < min }
  for (const s of base.straights) {
    if (s.len < min) continue
    const a = resolve(s.a), b = resolve(s.b)
    if (a !== b && short(a, b)) return true
  }
  for (const e of doc.entities) if (e.kind === 'line' && created.has(e.id) && short(e.p1, e.p2)) return true
  return false
}
