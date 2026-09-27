// app/lib/sketch/cleanup/context.ts
// What every Clean up detector reads: the drawing's pieces (lines, arcs and
// circles — never guides, never Bézier segments), which points may move (the
// selection's scope), which are Repeat/Mirror copies, point roles, and the
// tolerance in drawing units.
import type { SketchDoc, EntityId, PointEntity } from '../model'
import { getEntity } from '../model'
import { allCurves, curveGeom, type CurveRef, type CurveGeom } from '../crossings'
import { curveKey, type RuleSpec } from '../tangency'
import { pointRolesForDoc, type PointRole } from '../pointRoles'
import { GUARD, type CleanupScope } from './types'

export interface Piece {
  key: string                  // curveKey: a line / circle id, or "pathId:segIndex"
  ref: CurveRef
  kind: 'line' | 'arc' | 'circle'
  a: EntityId | null           // line / arc: start (a path segment's own order)
  b: EntityId | null           // line / arc: end
  c: EntityId | null           // arc / circle: centre
  circle: EntityId | null      // circle entity id
  lineId: EntityId | null      // line entity id
  points: EntityId[]           // a, b, c where present
  inScope: boolean             // something about it may move
  copy: boolean                // every point is a Repeat / Mirror copy
  len: number                  // line length, arc length, circle circumference
  size: number                 // for the movement cap: length (line, arc), radius (circle)
  geom: CurveGeom
}

export interface CleanupContext {
  doc: SketchDoc
  s: number                    // strength factor
  unitsPerPx: number
  openOnly: boolean
  pieces: Piece[]
  held: ReadonlySet<EntityId>  // points (and circle ids) that must not move
  copies: ReadonlySet<EntityId>
  roles: Map<EntityId, PointRole>
  pts: Map<EntityId, PointEntity>
  /** screen px × strength → drawing units */
  tol: (px: number) => number
}

export interface ContextEnv {
  held: ReadonlySet<EntityId>
  copies: ReadonlySet<EntityId>
  s: number
  unitsPerPx: number
  openOnly?: boolean
}

export const pairKey = (a: EntityId, b: EntityId): string => (a < b ? `${a}~${b}` : `${b}~${a}`)

/** A key for a piece built from its points, so it survives a path being joined or renumbered. */
export function stableKey(p: Piece): string {
  if (p.kind === 'circle') return p.circle!
  return p.kind === 'arc' ? `${p.c}@${pairKey(p.a!, p.b!)}` : pairKey(p.a!, p.b!)
}

/** The points a piece is built on: its ends and (arc, circle) its centre. */
export function curvePoints(doc: SketchDoc, ref: CurveRef): EntityId[] {
  if (ref.kind === 'line') { const e = getEntity(doc, ref.id); return e?.kind === 'line' ? [e.p1, e.p2] : [] }
  if (ref.kind === 'circle') { const e = getEntity(doc, ref.id); return e?.kind === 'circle' ? [e.center] : [] }
  const p = getEntity(doc, ref.pathId)
  if (!p || p.kind !== 'path') return []
  const seg = p.segments[ref.segIndex]
  const a = p.anchors[ref.segIndex], b = p.anchors[(ref.segIndex + 1) % p.anchors.length]
  if (!seg || !a || !b) return []
  return seg.kind === 'arc' ? [a, b, seg.center] : [a, b]
}

function isGuide(doc: SketchDoc, ref: CurveRef): boolean {
  const e = getEntity(doc, ref.kind === 'seg' ? ref.pathId : ref.id)
  return !!e && e.kind !== 'point' && !!e.construction
}

/** Points that are Repeat / Mirror copies (the copy of a rotatedFrom / mirroredFrom rule). */
export function copyPoints(doc: SketchDoc): Set<EntityId> {
  const out = new Set<EntityId>()
  for (const c of doc.constraints) if (c.kind === 'rotatedFrom' || c.kind === 'mirroredFrom') out.add(c.refs[0]!)
  return out
}

/** What must not move for a scope: with a selection of pieces, every point of
 *  an unselected piece (shared ones included), every point no selected piece
 *  uses, and every unselected circle's radius. No usable selection: nothing. */
export function heldForScope(doc: SketchDoc, scope: CleanupScope | null | undefined): Set<EntityId> {
  const held = new Set<EntityId>()
  if (!scope) return held
  const keys = new Set<string>()
  for (const id of scope.entities) {
    const e = getEntity(doc, id)
    if (!e) continue
    if (e.kind === 'line' || e.kind === 'circle') keys.add(e.id)
    else if (e.kind === 'path') {
      const n = e.closed ? e.anchors.length : e.anchors.length - 1
      for (let i = 0; i < n; i++) keys.add(`${e.id}:${i}`)
    }
  }
  for (const s of scope.segments) keys.add(`${s.pathId}:${s.segIndex}`)
  const curves = allCurves(doc).filter(r => !isGuide(doc, r))
  if (!curves.some(r => keys.has(curveKey(r)))) return held
  const free = new Set<EntityId>(), pinned = new Set<EntityId>()
  for (const r of curves) {
    const mine = keys.has(curveKey(r))
    for (const id of curvePoints(doc, r)) (mine ? free : pinned).add(id)
    if (r.kind === 'circle' && !mine) held.add(r.id)
  }
  for (const e of doc.entities) if (e.kind === 'point' && (!free.has(e.id) || pinned.has(e.id))) held.add(e.id)
  return held
}

export function buildContext(doc: SketchDoc, env: ContextEnv): CleanupContext {
  const pts = new Map<EntityId, PointEntity>()
  for (const e of doc.entities) if (e.kind === 'point') pts.set(e.id, e)
  const pieces: Piece[] = []
  for (const ref of allCurves(doc)) {
    if (isGuide(doc, ref)) continue
    const geom = curveGeom(doc, ref)
    if (!geom) continue
    let a: EntityId | null = null, b: EntityId | null = null, c: EntityId | null = null
    let circle: EntityId | null = null, lineId: EntityId | null = null
    if (ref.kind === 'line') {
      const e = getEntity(doc, ref.id)
      if (e?.kind !== 'line') continue
      a = e.p1; b = e.p2; lineId = e.id
    } else if (ref.kind === 'circle') {
      const e = getEntity(doc, ref.id)
      if (e?.kind !== 'circle') continue
      c = e.center; circle = e.id
    } else {
      const [p, q, cc] = curvePoints(doc, ref)
      a = p ?? null; b = q ?? null; c = cc ?? null
    }
    const points = [a, b, c].filter((x): x is EntityId => !!x)
    const len = geom.kind === 'line' ? Math.hypot(geom.b!.x - geom.a!.x, geom.b!.y - geom.a!.y)
      : geom.kind === 'arc' ? geom.r! * Math.abs(geom.sweepAngle!) : 2 * Math.PI * geom.r!
    const inScope = ref.kind === 'circle' ? !env.held.has(circle!) || !env.held.has(c!) : points.some(id => !env.held.has(id))
    pieces.push({
      key: curveKey(ref), ref, kind: geom.kind, a, b, c, circle, lineId, points, inScope,
      copy: points.length > 0 && points.every(id => env.copies.has(id)),
      len, size: geom.kind === 'circle' ? geom.r! : len, geom,
    })
  }
  const u = env.unitsPerPx, s = env.s
  return {
    doc, s, unitsPerPx: u, openOnly: !!env.openOnly, pieces, held: env.held, copies: env.copies,
    roles: pointRolesForDoc(doc), pts, tol: px => px * s * u,
  }
}

/** The rule that keeps point `p` on piece `q` — the pen's own on-curve forms. */
export function onCurveRule(q: Piece, p: EntityId): RuleSpec | null {
  if (q.kind === 'circle') return q.circle ? { kind: 'pointOnCircle', refs: [p, q.circle] } : null
  if (q.kind === 'line') return q.lineId ? { kind: 'pointOnLine', refs: [p, q.lineId] } : { kind: 'collinear', refs: [q.a!, q.b!, p] }
  return { kind: 'equalDist', refs: [q.c!, p, q.c!, q.a!] }
}

/** A typed length (a distance rule — the value chip) between a and b, if any. */
export function typedLength(doc: SketchDoc, a: EntityId, b: EntityId): number | null {
  const c = doc.constraints.find(k => k.kind === 'distance' && k.value != null &&
    ((k.refs[0] === a && k.refs[1] === b) || (k.refs[0] === b && k.refs[1] === a)))
  return c?.value ?? null
}

/** A piece's typed size: a line's length, an arc's radius pin, a circle's radius rule. */
export function typedSize(doc: SketchDoc, p: Piece): number | null {
  if (p.kind === 'line') return typedLength(doc, p.a!, p.b!)
  if (p.kind === 'arc') return typedLength(doc, p.c!, p.a!) ?? typedLength(doc, p.c!, p.b!)
  const c = doc.constraints.find(k => k.kind === 'radius' && k.refs[0] === p.circle && k.value != null)
  return c?.value ?? null
}

export const radiusOf = (p: Piece): number => p.geom.r ?? 0

/** A line's direction in degrees, folded into [0, 180). */
export function lineAngleDeg(p: Piece): number {
  const g = p.geom
  const a = Math.atan2(g.b!.y - g.a!.y, g.b!.x - g.a!.x) * 180 / Math.PI
  return ((a % 180) + 180) % 180
}

/** Line pieces long enough to have a direction worth reading (≥ 2 px). */
export function linePieces(ctx: CleanupContext): Piece[] {
  const min = ctx.unitsPerPx * GUARD.ARC_MIN_PX
  return ctx.pieces.filter(p => p.kind === 'line' && p.len >= min)
}
