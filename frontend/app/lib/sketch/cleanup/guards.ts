// app/lib/sketch/cleanup/guards.ts
// What keeps Clean up honest: a solve that holds what may not move (and only
// solves the part of the drawing a fix touches), and the checks every
// accepted fix must pass against the drawing as it was before Clean up — no
// point moved too far, no arc turned inside out or squeezed away.
import type { SketchDoc, SketchEntity, EntityId } from '../model'
import type { Vec2 } from '../geom'
import { dist } from '../geom'
import { cloneDoc } from '../clone'
import { solve } from '../solve'
import { curveGeom, pointAt, type CurveGeom, type CurveRef } from '../crossings'
import { buildContext } from './context'
import { GUARD } from './types'

/** Solves `doc` in place with `held` points and circle radii kept where they
 *  are (the solver's own `fixed`, and a radius rule, on a private copy). False
 *  — and `doc` untouched — when it does not converge. */
export function solveHeld(doc: SketchDoc, held: ReadonlySet<EntityId>): boolean {
  const plain = cloneDoc(doc)
  for (const e of plain.entities) {
    if (e.kind === 'point' && held.has(e.id)) e.fixed = true
    else if (e.kind === 'circle' && held.has(e.id)) plain.constraints.push({ id: `__held_${e.id}`, kind: 'radius', refs: [e.id], value: e.r })
  }
  if (!solve(plain, { maxIter: 120 }).converged) return false
  const solved = new Map(plain.entities.map(e => [e.id, e]))
  for (const e of doc.entities) {
    const s = solved.get(e.id)
    if (e.kind === 'point' && s?.kind === 'point') { e.x = s.x; e.y = s.y }
    else if (e.kind === 'circle' && s?.kind === 'circle') e.r = s.r
  }
  return true
}

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

/** The entities and rules of the connected parts of the drawing that `seeds`
 *  (ids of points, pieces or circles) belong to — two things are connected
 *  when a piece or a rule ties their points. The entity objects are the
 *  drawing's own (not copies), so solving the part solves the drawing. */
export function componentOf(doc: SketchDoc, seeds: readonly EntityId[]): SketchDoc {
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
  for (const c of doc.constraints) union(c.refs.flatMap(pts))
  const roots = new Set(seeds.flatMap(pts).map(find))
  const keep = (id: EntityId) => pts(id).some(p => roots.has(find(p)))
  return { entities: doc.entities.filter(e => keep(e.id)), constraints: doc.constraints.filter(c => c.refs.some(keep)) }
}

/** **Ruling (fix round 1):** a candidate is first solved in a window — the
 *  points it touches and every point within this many hops of them (a hop =
 *  sharing a line, a path segment, its arc centre included, or a circle);
 *  everything else is held. Only when the window doesn't converge, or its
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
  const win = new Set<EntityId>(seeds.flatMap(id => pointsOf(map, id)))
  let front = [...win]
  for (let k = 0; k < hops; k++) {
    const grown: EntityId[] = []
    for (const a of front) for (const b of next.get(a) ?? []) if (!win.has(b)) { win.add(b); grown.push(b) }
    front = grown
  }
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
  return { unitsPerPx, pos, cap, radius, arcs }
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

/** A guide line this fix made that the solve squeezed under 2 px — its
 *  direction rule (and a mirror about it) then says nothing. `created` are the
 *  ids the fix added. */
export function guideCollapsed(doc: SketchDoc, created: ReadonlySet<EntityId>, unitsPerPx: number): boolean {
  if (!created.size) return false
  const min = GUARD.ARC_MIN_PX * unitsPerPx
  const at = new Map<EntityId, Vec2>()
  for (const e of doc.entities) if (e.kind === 'point') at.set(e.id, e)
  for (const e of doc.entities) {
    if (e.kind !== 'line' || !created.has(e.id)) continue
    const a = at.get(e.p1), b = at.get(e.p2)
    if (a && b && dist(a, b) < min) return true
  }
  return false
}
