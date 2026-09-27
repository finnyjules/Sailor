// app/lib/sketch/corners.ts
// Pen stage 8, Round corner and Chamfer (spec "Stage 8"). A corner is a point
// where exactly two drawn pieces end (Ruling 3). Rounding makes a tangent arc
// between two touch points on its sides, chamfering a straight cut at equal
// setbacks; the corner point stays as a guide — the "virtual sharp" — tied to
// both sides, so every rule that named it still holds (Ruling 4). Everything
// is made of ordinary points, pieces and rules. Pure.
import type { SketchDoc, EntityId, PathEntity, SegmentSpec } from './model'
import { getEntity, getPoint } from './model'
import type { Vec2 } from './geom'
import { addPoint, addConstraint, addPath } from './edit'
import { splitSeeds, cornerSeeds } from './fills'
import { entityPath } from './sketchPath'
import { cloneDoc } from './clone'

const TAU = Math.PI * 2
const EPS = 1e-9
/** two leaving directions this close to opposite: the corner is already smooth (Ruling 3) */
const SMOOTH_COS = Math.cos((0.5 * Math.PI) / 180)

export type CornerKind = 'round' | 'chamfer'
/** One side of a corner: the piece ending at the corner point, as stored. */
export interface CornerSide {
  host: 'seg' | 'line'
  id: EntityId            // the path's id (host 'seg') or the line's
  segIndex: number        // host 'seg'; −1 for a line
  far: EntityId           // the piece's other end
  xIsStart: boolean       // stored running from the corner (x → far)
  kind: 'line' | 'arc'
  center?: EntityId       // arc
  sweep?: 0 | 1           // arc, as stored (1 = counter-clockwise)
}
/** `a` runs into the corner, `b` out of it (for a spliced corner, in path order). */
export interface Corner { x: EntityId; a: CornerSide; b: CornerSide; spliced: boolean }
export type CornerCheck = { ok: true; corner: Corner } | { ok: false; why: 'notCorner' | 'curve' | 'smooth' }
export interface CornerGeom { t1: Vec2; t2: Vec2; c?: Vec2; r?: number; sweep?: 0 | 1; fa: number; fb: number; fits: boolean }
export interface CornerBuild { ok: boolean; bad: EntityId[]; rules: EntityId[]; created: EntityId[] }
export interface CornerPreview { d: string; fits: boolean; bad: { at: Vec2; d: string }[] }

const NOT: CornerCheck = { ok: false, why: 'notCorner' }

// ── which points are corners ────────────────────────────────────────────────

interface Uses { sides: CornerSide[]; cubic: number; blocked: boolean }

// every point's pieces, in one pass (guides left out)
function usesOf(doc: SketchDoc, only?: EntityId): Map<EntityId, Uses> {
  const out = new Map<EntityId, Uses>()
  const at = (id: EntityId): Uses | null => {
    if (only && id !== only) return null
    let u = out.get(id)
    if (!u) out.set(id, (u = { sides: [], cubic: 0, blocked: false }))
    return u
  }
  for (const e of doc.entities) {
    if (e.kind === 'point' || e.construction) continue
    if (e.kind === 'circle') { const u = at(e.center); if (u) u.blocked = true; continue }
    if (e.kind === 'line') {
      if (e.p1 === e.p2) continue
      at(e.p1)?.sides.push({ host: 'line', id: e.id, segIndex: -1, far: e.p2, xIsStart: true, kind: 'line' })
      at(e.p2)?.sides.push({ host: 'line', id: e.id, segIndex: -1, far: e.p1, xIsStart: false, kind: 'line' })
      continue
    }
    const n = e.anchors.length, count = e.closed ? n : n - 1
    for (let i = 0; i < count; i++) {
      const s = e.segments[i]!, a = e.anchors[i]!, b = e.anchors[(i + 1) % n]!
      if (s.kind === 'arc') { const u = at(s.center); if (u) u.blocked = true }
      if (s.kind === 'cubic') {
        for (const h of [s.h1, s.h2]) if (h) { const u = at(h); if (u) u.blocked = true }
        if (a !== b) { const ua = at(a); if (ua) ua.cubic++; const ub = at(b); if (ub) ub.cubic++ }
        continue
      }
      if (a === b) continue
      const base = { host: 'seg' as const, id: e.id, segIndex: i, kind: s.kind, ...(s.kind === 'arc' ? { center: s.center, sweep: s.sweep } : {}) }
      at(a)?.sides.push({ ...base, far: b, xIsStart: true })
      at(b)?.sides.push({ ...base, far: a, xIsStart: false })
    }
  }
  return out
}

function checkUses(doc: SketchDoc, x: EntityId, u: Uses | undefined): CornerCheck {
  const X = getPoint(doc, x)
  if (!X || !u || u.blocked || u.sides.length + u.cubic !== 2) return NOT
  if (u.cubic) return { ok: false, why: 'curve' }
  let [a, b] = u.sides as [CornerSide, CornerSide]
  let spliced = false
  if (a.host === 'seg' && b.host === 'seg' && a.id === b.id) {
    const p = getEntity(doc, a.id) as PathEntity
    const count = p.closed ? p.anchors.length : p.anchors.length - 1
    const follows = (s: CornerSide, t: CornerSide) => !s.xIsStart && t.xIsStart && (s.segIndex + 1) % count === t.segIndex
    if (follows(b, a)) [a, b] = [b, a]
    spliced = follows(a, b)
  }
  const ga = sideGeom(doc, a, X), gb = sideGeom(doc, b, X)
  if (!ga || !gb) return NOT
  const cos = ga.u.x * gb.u.x + ga.u.y * gb.u.y
  if (cos < -SMOOTH_COS) return { ok: false, why: 'smooth' }
  if (cos > SMOOTH_COS) return NOT   // folded back on itself
  return { ok: true, corner: { x, a, b, spliced } }
}

export function cornerCheck(doc: SketchDoc, x: EntityId): CornerCheck {
  return checkUses(doc, x, usesOf(doc, x).get(x))
}

/** Every corner of the drawing, by its point (one pass; cache it per revision). */
export function cornersOf(doc: SketchDoc): Map<EntityId, Corner> {
  const out = new Map<EntityId, Corner>()
  for (const [id, u] of usesOf(doc)) {
    if (u.sides.length + u.cubic !== 2) continue
    const c = checkUses(doc, id, u)
    if (c.ok) out.set(id, c.corner)
  }
  return out
}

/** The corner nearest `p` within `tol` (drawing units), or null. */
export function cornerAt(doc: SketchDoc, p: Vec2, tol: number, corners: Map<EntityId, Corner> = cornersOf(doc)): EntityId | null {
  let best: EntityId | null = null, bd = tol
  for (const id of corners.keys()) {
    const q = getPoint(doc, id)
    if (!q) continue
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d <= bd) { bd = d; best = id }
  }
  return best
}

// ── a side's geometry, seen from the corner ────────────────────────────────

type SideGeom =
  | { kind: 'line'; X: Vec2; u: Vec2; len: number }
  | { kind: 'arc'; X: Vec2; u: Vec2; c: Vec2; r: number; dir: 1 | -1; span: number }

const norm = (a: number) => ((a % TAU) + TAU) % TAU

function sideGeom(doc: SketchDoc, s: CornerSide, X: Vec2): SideGeom | null {
  const F = getPoint(doc, s.far)
  if (!F) return null
  if (s.kind === 'line') {
    const len = Math.hypot(F.x - X.x, F.y - X.y)
    if (len < EPS) return null
    return { kind: 'line', X, u: { x: (F.x - X.x) / len, y: (F.y - X.y) / len }, len }
  }
  const C = getPoint(doc, s.center!)
  if (!C) return null
  const r = Math.hypot(X.x - C.x, X.y - C.y)
  if (r < EPS) return null
  // stored s → e with sweep 1 = counter-clockwise; travelled from the corner
  const stored: 1 | -1 = s.sweep === 1 ? 1 : -1
  const dir: 1 | -1 = s.xIsStart ? stored : (-stored as 1 | -1)
  const angX = Math.atan2(X.y - C.y, X.x - C.x), angF = Math.atan2(F.y - C.y, F.x - C.x)
  const span = norm(dir * (angF - angX)) || TAU
  const u = { x: (-dir * (X.y - C.y)) / r, y: (dir * (X.x - C.x)) / r }
  return { kind: 'arc', X, u, c: { x: C.x, y: C.y }, r, dir, span }
}

// how far along a side (0 at the corner, 1 at its far end) point T lies
function fraction(g: SideGeom, T: Vec2): number {
  if (g.kind === 'line') return ((T.x - g.X.x) * g.u.x + (T.y - g.X.y) * g.u.y) / g.len
  const a0 = Math.atan2(g.X.y - g.c.y, g.X.x - g.c.x), a = Math.atan2(T.y - g.c.y, T.x - g.c.x)
  let t = norm(g.dir * (a - a0))
  if (t > TAU - 1e-9) t = 0
  return t / g.span
}

// ── round: the tangent circle inside the corner ─────────────────────────────

type Carrier = { kind: 'line'; p: Vec2; u: Vec2 } | { kind: 'circle'; c: Vec2; r: number }

function offsetCarriers(g: SideGeom, r: number): Carrier[] {
  if (g.kind === 'line') {
    const n = { x: -g.u.y, y: g.u.x }
    return [
      { kind: 'line', p: { x: g.X.x + r * n.x, y: g.X.y + r * n.y }, u: g.u },
      { kind: 'line', p: { x: g.X.x - r * n.x, y: g.X.y - r * n.y }, u: g.u },
    ]
  }
  const out: Carrier[] = [{ kind: 'circle', c: g.c, r: g.r + r }]
  if (g.r - r > EPS) out.push({ kind: 'circle', c: g.c, r: g.r - r })
  if (r - g.r > EPS) out.push({ kind: 'circle', c: g.c, r: r - g.r })
  return out
}

/** Where two carriers cross (a tangent touch counts once). */
export function intersectCarriers(a: Carrier, b: Carrier): Vec2[] {
  if (a.kind === 'line' && b.kind === 'line') {
    const den = a.u.x * b.u.y - a.u.y * b.u.x
    if (Math.abs(den) < 1e-12) return []
    const t = ((b.p.x - a.p.x) * b.u.y - (b.p.y - a.p.y) * b.u.x) / den
    return [{ x: a.p.x + t * a.u.x, y: a.p.y + t * a.u.y }]
  }
  if (a.kind === 'circle' && b.kind === 'line') return intersectCarriers(b, a)
  if (a.kind === 'line' && b.kind === 'circle') {
    const fx = a.p.x - b.c.x, fy = a.p.y - b.c.y
    const B = fx * a.u.x + fy * a.u.y, C = fx * fx + fy * fy - b.r * b.r
    const disc = B * B - C
    if (disc < -1e-12) return []
    const s = Math.sqrt(Math.max(0, disc))
    const ts = s < 1e-12 ? [-B] : [-B - s, -B + s]
    return ts.map(t => ({ x: a.p.x + t * a.u.x, y: a.p.y + t * a.u.y }))
  }
  const A = a as Extract<Carrier, { kind: 'circle' }>, Bc = b as Extract<Carrier, { kind: 'circle' }>
  const dx = Bc.c.x - A.c.x, dy = Bc.c.y - A.c.y, d = Math.hypot(dx, dy)
  if (d < EPS || d > A.r + Bc.r + 1e-12 || d < Math.abs(A.r - Bc.r) - 1e-12) return []
  const l = (A.r * A.r - Bc.r * Bc.r + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, A.r * A.r - l * l))
  const mx = A.c.x + (l * dx) / d, my = A.c.y + (l * dy) / d
  if (h < 1e-12) return [{ x: mx, y: my }]
  return [{ x: mx - (h * dy) / d, y: my + (h * dx) / d }, { x: mx + (h * dy) / d, y: my - (h * dx) / d }]
}

// the point of a side's carrier that a circle of radius r round C touches
function touch(g: SideGeom, C: Vec2, r: number): Vec2 {
  if (g.kind === 'line') {
    const t = (C.x - g.X.x) * g.u.x + (C.y - g.X.y) * g.u.y
    return { x: g.X.x + t * g.u.x, y: g.X.y + t * g.u.y }
  }
  const dx = C.x - g.c.x, dy = C.y - g.c.y, d = Math.hypot(dx, dy) || 1
  const near = { x: g.c.x + (g.r * dx) / d, y: g.c.y + (g.r * dy) / d }
  const far = { x: g.c.x - (g.r * dx) / d, y: g.c.y - (g.r * dy) / d }
  const err = (q: Vec2) => Math.abs(Math.hypot(q.x - C.x, q.y - C.y) - r)
  return err(near) <= err(far) ? near : far
}

const crossZ = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x

function roundGeom(ga: SideGeom, gb: SideGeom, X: Vec2, r: number): CornerGeom | null {
  if (!(r > EPS)) return null
  const sg = Math.sign(crossZ(ga.u, gb.u))
  let best: CornerGeom | null = null, bestD = Infinity
  for (const ca of offsetCarriers(ga, r)) {
    for (const cb of offsetCarriers(gb, r)) {
      for (const C of intersectCarriers(ca, cb)) {
        const w = { x: C.x - X.x, y: C.y - X.y }
        // inside the wedge of the two leaving directions
        if (Math.sign(crossZ(ga.u, w)) !== sg || Math.sign(crossZ(gb.u, w)) !== -sg) continue
        const t1 = touch(ga, C, r), t2 = touch(gb, C, r)
        const fa = fraction(ga, t1), fb = fraction(gb, t2)
        if (!(fa > EPS) || !(fb > EPS)) continue
        const dd = Math.hypot(t1.x - X.x, t1.y - X.y) + Math.hypot(t2.x - X.x, t2.y - X.y)
        if (dd >= bestD) continue
        bestD = dd
        const sweep: 0 | 1 = crossZ({ x: t1.x - C.x, y: t1.y - C.y }, { x: t2.x - C.x, y: t2.y - C.y }) > 0 ? 1 : 0
        best = { t1, t2, c: C, r, sweep, fa, fb, fits: fa < 1 - EPS && fb < 1 - EPS }
      }
    }
  }
  return best
}

// ── chamfer: equal straight setbacks ────────────────────────────────────────

function setbackPoint(g: SideGeom, s: number): Vec2 | null {
  if (g.kind === 'line') return { x: g.X.x + s * g.u.x, y: g.X.y + s * g.u.y }
  const pts = intersectCarriers({ kind: 'circle', c: g.X, r: s }, { kind: 'circle', c: g.c, r: g.r })
  let best: Vec2 | null = null, bt = Infinity
  for (const q of pts) {
    const t = fraction(g, q)
    if (t > EPS && t < bt) { bt = t; best = q }
  }
  return best
}

function chamferGeom(ga: SideGeom, gb: SideGeom, s: number): CornerGeom | null {
  if (!(s > EPS)) return null
  const t1 = setbackPoint(ga, s), t2 = setbackPoint(gb, s)
  if (!t1 || !t2) return null
  const fa = fraction(ga, t1), fb = fraction(gb, t2)
  return { t1, t2, fa, fb, fits: fa > EPS && fa < 1 - EPS && fb > EPS && fb < 1 - EPS }
}

export function cornerGeom(doc: SketchDoc, corner: Corner, kind: CornerKind, size: number): CornerGeom | null {
  const X = getPoint(doc, corner.x)
  if (!X) return null
  const ga = sideGeom(doc, corner.a, X), gb = sideGeom(doc, corner.b, X)
  if (!ga || !gb) return null
  return kind === 'round' ? roundGeom(ga, gb, { x: X.x, y: X.y }, size) : chamferGeom(ga, gb, size)
}

/** The size that puts the arc's (or the cut's) middle at the pointer's
 *  projection on the corner's bisector (Ruling 8); 0 behind the corner. */
export function sizeFromPointer(doc: SketchDoc, corner: Corner, kind: CornerKind, p: Vec2): number {
  const X = getPoint(doc, corner.x)
  if (!X) return 0
  const ga = sideGeom(doc, corner.a, X), gb = sideGeom(doc, corner.b, X)
  if (!ga || !gb) return 0
  const wx = ga.u.x + gb.u.x, wy = ga.u.y + gb.u.y, wl = Math.hypot(wx, wy)
  if (wl < 1e-9) return 0
  const d = ((p.x - X.x) * wx + (p.y - X.y) * wy) / wl
  if (d <= 0) return 0
  const half = Math.acos(Math.max(-1, Math.min(1, ga.u.x * gb.u.x + ga.u.y * gb.u.y))) / 2
  const sh = Math.sin(half)
  return kind === 'round' ? (d * sh) / (1 - sh) : d / Math.cos(half)
}

// ── building a corner ───────────────────────────────────────────────────────

// the seeds on a side's piece, split where the touch point lands
function splitSide(doc: SketchDoc, s: CornerSide, x: EntityId, fromCorner: number, t: EntityId): void {
  splitSeeds(doc, s.far, x, s.kind === 'arc' ? s.center! : null, 1 - fromCorner, t)
}

// a separate piece's end at the corner moves to its touch point
function moveEnd(doc: SketchDoc, s: CornerSide, x: EntityId, t: EntityId): void {
  const e = getEntity(doc, s.id)
  if (!e) return
  if (e.kind === 'line') { if (e.p1 === x) e.p1 = t; else if (e.p2 === x) e.p2 = t; return }
  if (e.kind !== 'path') return
  const last = e.anchors.length - 1
  if (e.anchors[0] === x) e.anchors[0] = t
  else if (e.anchors[last] === x) e.anchors[last] = t
}

// an arc side's own rule equalDist [C, far, C, x] now names its new end
function reaimArcRule(doc: SketchDoc, s: CornerSide, x: EntityId, t: EntityId): void {
  if (s.kind !== 'arc') return
  const C = s.center!
  const k = doc.constraints.find(c => c.kind === 'equalDist' && c.refs[0] === C && c.refs[2] === C &&
    ((c.refs[1] === s.far && c.refs[3] === x) || (c.refs[1] === x && c.refs[3] === s.far)))
  if (k) k.refs = k.refs.map(r => (r === x ? t : r))
  else addConstraint(doc, 'equalDist', [C, s.far, C, t])
}

interface Built { x: EntityId; t1: EntityId; t2: EntityId; c: EntityId | null; touched: EntityId[]; rules: EntityId[]; created: EntityId[] }

function buildCorner(doc: SketchDoc, corner: Corner, g: CornerGeom, kind: CornerKind): Built {
  const X = corner.x
  const t1 = addPoint(doc, g.t1.x, g.t1.y), t2 = addPoint(doc, g.t2.x, g.t2.y)
  const c = kind === 'round' ? addPoint(doc, g.c!.x, g.c!.y) : null
  // fill seeds first, while they still name the pieces as they were
  splitSide(doc, corner.a, X, g.fa, t1)
  splitSide(doc, corner.b, X, g.fb, t2)
  cornerSeeds(doc, X, t1, t2, c ? { c, ccw: g.sweep === 1 } : {})
  const seg: SegmentSpec = c ? { kind: 'arc', center: c, sweep: g.sweep! } : { kind: 'line' }
  const rules: EntityId[] = []
  const touched = [corner.a.id, corner.b.id]
  const created = [t1, t2, ...(c ? [c] : [])]
  reaimArcRule(doc, corner.a, X, t1)
  reaimArcRule(doc, corner.b, X, t2)
  if (corner.spliced) {
    const p = getEntity(doc, corner.a.id) as PathEntity
    const last = p.anchors.length - 1
    if (!p.closed && p.anchors[0] === X && p.anchors[last] === X) {
      // an open path whose two ends meet at the corner: the new piece closes it
      p.anchors[0] = t2
      p.anchors[last] = t1
      p.segments.push(seg)
      p.closed = true
    } else {
      const j = p.anchors.indexOf(X)
      p.anchors.splice(j, 1, t1, t2)
      p.segments.splice(j, 0, seg)
    }
    if (c) rules.push(addConstraint(doc, 'equalDist', [c, t1, c, t2]))
  } else {
    moveEnd(doc, corner.a, X, t1)
    moveEnd(doc, corner.b, X, t2)
    const before = doc.constraints.length
    const pid = addPath(doc, [t1, t2], [seg])
    touched.push(pid); created.push(pid)
    for (const k of doc.constraints.slice(before)) rules.push(k.id)
  }
  // the virtual sharp: a guide point tied back to both sides (Ruling 4)
  const xp = getPoint(doc, X)!
  xp.construction = true
  for (const [side, t] of [[corner.a, t1], [corner.b, t2]] as const) {
    if (side.kind === 'line') rules.push(addConstraint(doc, 'collinear', [side.far, t, X]))
    else rules.push(addConstraint(doc, 'equalDist', [side.center!, t, side.center!, X]))
    if (c) {
      if (side.kind === 'line') rules.push(addConstraint(doc, 'perpendicular', [side.far, t, t, c]))
      else rules.push(addConstraint(doc, 'collinear', [side.center!, t, c]))
    }
  }
  if (!c) rules.push(addConstraint(doc, 'equalDist', [X, t1, X, t2]))
  return { x: X, t1, t2, c, touched, rules, created }
}

/** Rounds (or chamfers) the corners `xs` with one size, in order, on `doc`
 *  itself — callers hand in a clone and keep it only when `ok`. Several
 *  corners are tied Equal to the first (Ruling 7). Not ok (and `bad` names
 *  them) when any corner isn't one or its size doesn't fit (Ruling 6). */
export function roundCorners(doc: SketchDoc, xs: readonly EntityId[], kind: CornerKind, size: number): CornerBuild {
  const built: Built[] = []
  const bad: EntityId[] = []
  for (const x of [...new Set(xs)]) {
    const chk = cornerCheck(doc, x)
    const g = chk.ok ? cornerGeom(doc, chk.corner, kind, size) : null
    if (!chk.ok || !g || !g.fits) { bad.push(x); continue }
    built.push(buildCorner(doc, chk.corner, g, kind))
  }
  if (bad.length || !built.length) return { ok: false, bad, rules: [], created: [] }
  const rules = built.flatMap(b => b.rules)
  const first = built[0]!
  for (const b of built.slice(1)) {
    rules.push(kind === 'round'
      ? addConstraint(doc, 'equalDist', [first.c!, first.t1, b.c!, b.t1])
      : addConstraint(doc, 'equalDist', [first.x, first.t1, b.x, b.t1]))
  }
  return { ok: true, bad, rules, created: built.flatMap(b => b.created) }
}

// ── the preview ─────────────────────────────────────────────────────────────

function rawCornerD(g: CornerGeom): string {
  const f = (v: number) => Number(v.toFixed(6))
  if (g.c) return `M ${f(g.t1.x)} ${f(g.t1.y)} A ${f(g.r!)} ${f(g.r!)} 0 0 ${g.sweep} ${f(g.t2.x)} ${f(g.t2.y)}`
  return `M ${f(g.t1.x)} ${f(g.t1.y)} L ${f(g.t2.x)} ${f(g.t2.y)}`
}

/** What the corner tools show (Ruling 17): the new and shortened pieces as
 *  they would be, and every corner that can't be made (red: its circle or
 *  cut where it would fall, or '' for a ring). Builds on a fill-less clone;
 *  `doc` is never changed. */
export function cornerPreview(doc: SketchDoc, xs: readonly EntityId[], kind: CornerKind, size: number): CornerPreview {
  const work = cloneDoc({ entities: doc.entities, constraints: doc.constraints })
  const touched = new Set<EntityId>()
  const bad: { at: Vec2; d: string }[] = []
  for (const x of [...new Set(xs)]) {
    const X = getPoint(work, x)
    const chk = cornerCheck(work, x)
    const g = chk.ok ? cornerGeom(work, chk.corner, kind, size) : null
    if (!chk.ok || !g || !g.fits) {
      if (X) bad.push({ at: { x: X.x, y: X.y }, d: g ? rawCornerD(g) : '' })
      continue
    }
    for (const id of buildCorner(work, chk.corner, g, kind).touched) touched.add(id)
  }
  const d = [...touched].map(id => entityPath(work, id)).filter(Boolean).join(' ')
  return { d, fits: bad.length === 0 && touched.size > 0, bad }
}

/** `want`, halved (up to 8 times) until every corner takes it (Ruling 8). */
export function fittingSize(doc: SketchDoc, xs: readonly EntityId[], kind: CornerKind, want: number): number {
  let s = want
  for (let i = 0; i < 8; i++) {
    const work = cloneDoc({ entities: doc.entities, constraints: doc.constraints })
    if (roundCorners(work, xs, kind, s).ok) return s
    s /= 2
  }
  return want
}
