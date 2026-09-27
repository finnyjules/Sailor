// app/lib/sketch/offset.ts
// Pen stage 8, Offset (spec "Stage 8 — Offset"): a parallel copy of a path at
// a signed distance — lines to parallel lines, arcs to arcs on the same centre
// point, a circle to a circle on its centre — meeting sharp (Ruling 10), kept
// live by offsetLine / offsetRadius (and, at an open chain's ends,
// perpendicular / collinear). The copy takes no fill (Ruling 19). Pure: only
// `applyOffset` changes the drawing, and only when the whole offset can be made.
import type { SketchDoc, EntityId, SegmentSpec, PathEntity, PointEntity } from './model'
import { getEntity } from './model'
import type { Vec2 } from './geom'
import { addPoint, addPath, addCircle, addConstraint } from './edit'
import { segCount, type SegPick } from './pieces'
import { intersectCarriers, pointIndex } from './corners'

const TAU = Math.PI * 2
const EPS = 1e-9
/** two neighbouring offset pieces whose naive offsets of the shared point are
 *  this close (relative to the distance) meet smoothly: the naive point is
 *  their sharp corner (a tangent or collinear join — no crossing to look for) */
const SMOOTH_REL = 1e-6

export type ChainPiece =
  | { kind: 'line'; a: EntityId; b: EntityId }
  | { kind: 'arc'; a: EntityId; b: EntityId; c: EntityId; sweep: 0 | 1 }
export type OffsetChain =
  | { kind: 'chain'; pieces: ChainPiece[]; closed: boolean }
  | { kind: 'circle'; id: EntityId; c: EntityId }
export type OffsetSource = { ok: true; chains: OffsetChain[] } | { ok: false; why: 'nothing' | 'curve' }
export interface OffsetChainGeom { pts: Vec2[]; radii: (number | null)[]; centres: (Vec2 | null)[]; sweeps: (0 | 1 | null)[]; closed: boolean; circle?: { c: Vec2; r: number } }
export interface OffsetGeom { chains: OffsetChainGeom[]; ok: boolean }
export interface OffsetBuild { ok: boolean; created: EntityId[]; rules: EntityId[] }

// ── the source (Ruling 9) ───────────────────────────────────────────────────

function piecesOf(p: PathEntity, idx: number[]): ChainPiece[] | null {
  const n = p.anchors.length
  const out: ChainPiece[] = []
  for (const i of idx) {
    const s = p.segments[i]!, a = p.anchors[i]!, b = p.anchors[(i + 1) % n]!
    if (s.kind === 'cubic') return null
    out.push(s.kind === 'arc' ? { kind: 'arc', a, b, c: s.center, sweep: s.sweep } : { kind: 'line', a, b })
  }
  return out
}

/** What an offset would copy: every selected whole path, line and circle, and
 *  the picked pieces of a path in runs that follow on from each other (each
 *  run its own chain). Guides are left out; any Bézier piece in the source
 *  refuses the whole offset ('curve'). */
export function offsetSource(doc: SketchDoc, sel: readonly EntityId[], segs: readonly SegPick[]): OffsetSource {
  const chains: OffsetChain[] = []
  let curve = false
  const whole = new Set(sel)
  for (const id of whole) {
    const e = getEntity(doc, id)
    if (!e || e.kind === 'point' || e.construction) continue
    if (e.kind === 'line') chains.push({ kind: 'chain', pieces: [{ kind: 'line', a: e.p1, b: e.p2 }], closed: false })
    else if (e.kind === 'circle') chains.push({ kind: 'circle', id: e.id, c: e.center })
    else {
      const ps = piecesOf(e, [...Array(segCount(e)).keys()])
      if (!ps) curve = true
      else chains.push({ kind: 'chain', pieces: ps, closed: e.closed })
    }
  }
  const byPath = new Map<EntityId, Set<number>>()
  for (const s of segs) {
    if (whole.has(s.pathId)) continue
    const set = byPath.get(s.pathId) ?? new Set<number>()
    set.add(s.segIndex); byPath.set(s.pathId, set)
  }
  for (const [pid, set] of byPath) {
    const p = getEntity(doc, pid)
    if (!p || p.kind !== 'path' || p.construction) continue
    const n = segCount(p)
    const ok = [...set].filter(i => i >= 0 && i < n).sort((x, y) => x - y)
    if (!ok.length) continue
    if (p.closed && ok.length === n) {
      const ps = piecesOf(p, ok)
      if (!ps) curve = true; else chains.push({ kind: 'chain', pieces: ps, closed: true })
      continue
    }
    const has = new Set(ok)
    const prevOf = (i: number) => (p.closed ? (i - 1 + n) % n : i - 1)
    for (const i of ok) {
      if (has.has(prevOf(i))) continue           // not the start of a run
      const run: number[] = []
      for (let k = i; has.has(k) && run.length < n; k = p.closed ? (k + 1) % n : k + 1) run.push(k)
      const ps = piecesOf(p, run)
      if (!ps) curve = true; else chains.push({ kind: 'chain', pieces: ps, closed: false })
    }
  }
  if (curve) return { ok: false, why: 'curve' }
  return chains.length ? { ok: true, chains } : { ok: false, why: 'nothing' }
}

// ── geometry (Ruling 10) ────────────────────────────────────────────────────

type PieceGeom =
  | { kind: 'line'; A: Vec2; B: Vec2; n: Vec2; u: Vec2 }
  | { kind: 'arc'; A: Vec2; B: Vec2; C: Vec2; R: number; sgn: 1 | -1 }
type Carrier = { kind: 'line'; p: Vec2; u: Vec2 } | { kind: 'circle'; c: Vec2; r: number }
type Points = Map<EntityId, PointEntity>

const pt = (pts: Points, id: EntityId): Vec2 | null => { const p = pts.get(id); return p ? { x: p.x, y: p.y } : null }
const norm = (a: number) => ((a % TAU) + TAU) % TAU
const wrapPi = (a: number) => { const r = norm(a); return r > Math.PI ? r - TAU : r }
const ang = (C: Vec2, P: Vec2) => Math.atan2(P.y - C.y, P.x - C.x)

function pieceGeom(pts: Points, pc: ChainPiece): PieceGeom | null {
  const A = pt(pts, pc.a), B = pt(pts, pc.b)
  if (!A || !B) return null
  if (pc.kind === 'line') {
    const L = Math.hypot(B.x - A.x, B.y - A.y)
    if (L < EPS) return null
    const u = { x: (B.x - A.x) / L, y: (B.y - A.y) / L }
    return { kind: 'line', A, B, u, n: { x: -u.y, y: u.x } }
  }
  const C = pt(pts, pc.c)
  if (!C) return null
  const R = Math.hypot(A.x - C.x, A.y - C.y)
  if (R < EPS || Math.hypot(A.x - B.x, A.y - B.y) < EPS) return null
  return { kind: 'arc', A, B, C, R, sgn: pc.sweep === 1 ? 1 : -1 }
}
// the left normal of the way of travel at P
function normalAt(g: PieceGeom, P: Vec2): Vec2 {
  if (g.kind === 'line') return g.n
  const r = Math.hypot(g.C.x - P.x, g.C.y - P.y) || g.R
  return { x: (g.sgn * (g.C.x - P.x)) / r, y: (g.sgn * (g.C.y - P.y)) / r }
}
function carrier(g: PieceGeom, d: number): Carrier {
  if (g.kind === 'line') return { kind: 'line', p: { x: g.A.x + d * g.n.x, y: g.A.y + d * g.n.y }, u: g.u }
  return { kind: 'circle', c: g.C, r: g.R - g.sgn * d }
}
const shift = (P: Vec2, n: Vec2, d: number): Vec2 => ({ x: P.x + d * n.x, y: P.y + d * n.y })
const far = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y)

const EMPTY = (closed: boolean): OffsetChainGeom => ({ pts: [], radii: [], centres: [], sweeps: [], closed })

/** The offset at signed distance `d` (left of travel positive; a circle:
 *  outside positive). Not ok when `d` is 0 or the offset is too far anywhere:
 *  a radius shrunk to nothing, arc and line carriers that never cross, or a
 *  piece that would turn back on itself. Never changes `doc`. */
export function offsetGeom(doc: SketchDoc, chains: readonly OffsetChain[], d: number): OffsetGeom {
  const out: OffsetChainGeom[] = []
  const pts = pointIndex(doc)
  let ok = Math.abs(d) > EPS
  for (const ch of chains) {
    if (ch.kind === 'circle') {
      const e = getEntity(doc, ch.id), c = pt(pts, ch.c)
      const r = e?.kind === 'circle' ? e.r + d : -1
      if (!c || !(r > EPS)) ok = false
      out.push({ ...EMPTY(true), circle: { c: c ?? { x: 0, y: 0 }, r: Math.max(r, 0) } })
      continue
    }
    const gs = ch.pieces.map(pc => pieceGeom(pts, pc))
    if (!gs.length || gs.some(g => !g)) { ok = false; out.push(EMPTY(ch.closed)); continue }
    const G = gs as PieceGeom[], m = G.length
    const cars = G.map(g => carrier(g, d))
    const radii = cars.map(c => (c.kind === 'circle' ? c.r : null))
    const centres = G.map(g => (g.kind === 'arc' ? g.C : null))
    const sweeps = ch.pieces.map(pc => (pc.kind === 'arc' ? pc.sweep : null))
    if (radii.some(r => r != null && !(r > EPS))) ok = false
    const corner = (j: number): Vec2 => {          // where piece j−1 meets piece j (at piece j's start)
      const prev = G[(j - 1 + m) % m]!, next = G[j]!
      const naive = shift(next.A, normalAt(prev, next.A), d)
      const naiveNext = shift(next.A, normalAt(next, next.A), d)
      // a smooth join (tangent, or straight on): the naive point is exact, and
      // looking for a crossing of two carriers that only touch would be noise
      if (far(naive, naiveNext) <= SMOOTH_REL * Math.abs(d)) return { x: (naive.x + naiveNext.x) / 2, y: (naive.y + naiveNext.y) / 2 }
      const cand = intersectCarriers(cars[(j - 1 + m) % m]!, cars[j]!)
      if (!cand.length) {
        // two straight carriers that never cross fold back on each other;
        // an arc's carrier missing its neighbour's: no sharp corner exists
        if (!(prev.kind === 'line' && next.kind === 'line')) ok = false
        return naive
      }
      return cand.reduce((b, q) => (far(q, naive) < far(b, naive) ? q : b))
    }
    const P: Vec2[] = []
    if (ch.closed) for (let j = 0; j < m; j++) P.push(corner(j))
    else {
      P.push(shift(G[0]!.A, normalAt(G[0]!, G[0]!.A), d))
      for (let j = 1; j < m; j++) P.push(corner(j))
      P.push(shift(G[m - 1]!.B, normalAt(G[m - 1]!, G[m - 1]!.B), d))
    }
    // a piece that would turn back on itself: too far (Ruling 10)
    for (let i = 0; i < m && ok; i++) {
      const g = G[i]!, p0 = P[i]!, p1 = P[ch.closed ? (i + 1) % m : i + 1]!
      if (g.kind === 'line') {
        if ((p1.x - p0.x) * g.u.x + (p1.y - p0.y) * g.u.y <= EPS) ok = false
      } else {
        // the offset arc's span, followed from the source's ends: each end
        // moves round the centre by less than half a turn, so the span is the
        // source's plus the two ends' moves — at or below 0 it runs backwards,
        // at a full turn or more it laps itself
        const s0 = norm(g.sgn * (ang(g.C, g.B) - ang(g.C, g.A)))
        const s1 = s0 - wrapPi(g.sgn * (ang(g.C, p0) - ang(g.C, g.A))) + wrapPi(g.sgn * (ang(g.C, p1) - ang(g.C, g.B)))
        if (!(s1 > EPS) || !(s1 < TAU - EPS)) ok = false
      }
    }
    out.push({ pts: P, radii, centres, sweeps, closed: ch.closed })
  }
  return { chains: out, ok }
}

const f = (v: number) => { const r = Number(v.toFixed(9)); return Object.is(r, -0) ? 0 : r }

/** The offset as SVG path data (drawing space) — the preview (outlines only,
 *  Ruling 17). */
export function offsetGeomD(g: OffsetGeom): string {
  const parts: string[] = []
  for (const ch of g.chains) {
    if (ch.circle) {
      const { c, r } = ch.circle
      if (r > 0) parts.push(`M ${f(c.x - r)} ${f(c.y)} A ${f(r)} ${f(r)} 0 0 1 ${f(c.x + r)} ${f(c.y)} A ${f(r)} ${f(r)} 0 0 1 ${f(c.x - r)} ${f(c.y)} Z`)
      continue
    }
    if (!ch.pts.length) continue
    const m = ch.radii.length
    let s = `M ${f(ch.pts[0]!.x)} ${f(ch.pts[0]!.y)}`
    for (let i = 0; i < m; i++) {
      const p0 = ch.pts[i]!, q = ch.pts[ch.closed ? (i + 1) % m : i + 1]!
      const r = ch.radii[i], c = ch.centres[i], sw = ch.sweeps[i]
      if (r == null || !c || sw == null) {
        if (!(ch.closed && i === m - 1)) s += ` L ${f(q.x)} ${f(q.y)}`   // Z draws the closing line
        continue
      }
      // as sketchPath.ts pathD writes an arc: the piece's own sweep, large from its span
      const span = norm((sw === 1 ? 1 : -1) * (ang(c, q) - ang(c, p0)))
      s += ` A ${f(r)} ${f(r)} 0 ${span > Math.PI ? 1 : 0} ${sw} ${f(q.x)} ${f(q.y)}`
    }
    parts.push(ch.closed ? `${s} Z` : s)
  }
  return parts.join(' ')
}

// ── construction (Ruling 10) ────────────────────────────────────────────────

/** Adds the offset (Ruling 10) and the rules that keep it live, returning the
 *  new pieces and points (`created`) and every rule it added (`rules`, for the
 *  pen's "solve only if one doesn't hold"). The copy takes no fill (Ruling 19).
 *  Not ok — and `doc` left exactly as it was — when the distance is 0 or too
 *  far anywhere. */
export function applyOffset(doc: SketchDoc, chains: readonly OffsetChain[], d: number): OffsetBuild {
  const g = offsetGeom(doc, chains, d)
  if (!g.ok) return { ok: false, created: [], rules: [] }
  const created: EntityId[] = [], rules: EntityId[] = []
  const rule = (...a: Parameters<typeof addConstraint>) => { const id = addConstraint(...a); rules.push(id); return id }
  chains.forEach((ch, k) => {
    const cg = g.chains[k]!
    if (ch.kind === 'circle') {
      const nc = addCircle(doc, ch.c, cg.circle!.r)
      created.push(nc)
      rule(doc, 'offsetRadius', [ch.id, nc], d)
      return
    }
    const ids = cg.pts.map(p => addPoint(doc, p.x, p.y))
    const m = ch.pieces.length
    const at = (i: number) => ids[ch.closed ? i % m : i]!
    const segs: SegmentSpec[] = ch.pieces.map(pc => (pc.kind === 'arc' ? { kind: 'arc', center: pc.c, sweep: pc.sweep } : { kind: 'line' }))
    const before = doc.constraints.length
    const pid = addPath(doc, ids, segs, ch.closed)
    for (const c of doc.constraints.slice(before)) rules.push(c.id)   // each offset arc's own rule
    created.push(pid, ...ids)
    ch.pieces.forEach((pc, i) => {
      if (pc.kind === 'line') { rule(doc, 'offsetLine', [pc.a, pc.b, at(i)], d); rule(doc, 'offsetLine', [pc.a, pc.b, at(i + 1)], d) }
      else rule(doc, 'offsetRadius', [pc.c, pc.a, pc.c, at(i)], -(pc.sweep === 1 ? 1 : -1) * d)
    })
    if (!ch.closed) {
      const first = ch.pieces[0]!, last = ch.pieces[m - 1]!
      if (first.kind === 'line') rule(doc, 'perpendicular', [first.a, first.b, first.a, at(0)])
      else rule(doc, 'collinear', [first.c, first.a, at(0)])
      if (last.kind === 'line') rule(doc, 'perpendicular', [last.a, last.b, last.b, at(m)])
      else rule(doc, 'collinear', [last.c, last.b, at(m)])
    }
  })
  return { ok: true, created, rules }
}

// ── the pointer ─────────────────────────────────────────────────────────────

/** The signed distance of `p` from the nearest source piece: left of the way
 *  of travel positive; a circle: outside positive (Ruling 11). 0 with no source. */
export function offsetDistanceAt(doc: SketchDoc, chains: readonly OffsetChain[], p: Vec2): number {
  const pts = pointIndex(doc)
  let best = Infinity, signed = 0
  for (const ch of chains) {
    if (ch.kind === 'circle') {
      const e = getEntity(doc, ch.id), c = pt(pts, ch.c)
      if (!c || e?.kind !== 'circle') continue
      const s = Math.hypot(p.x - c.x, p.y - c.y) - e.r
      if (Math.abs(s) < best) { best = Math.abs(s); signed = s }
      continue
    }
    for (const pc of ch.pieces) {
      const g = pieceGeom(pts, pc)
      if (!g) continue
      let away: number, s: number
      if (g.kind === 'line') {
        const dx = g.B.x - g.A.x, dy = g.B.y - g.A.y, L2 = dx * dx + dy * dy
        const t = Math.max(0, Math.min(1, ((p.x - g.A.x) * dx + (p.y - g.A.y) * dy) / L2))
        away = Math.hypot(p.x - g.A.x - t * dx, p.y - g.A.y - t * dy)
        s = (dx * (p.y - g.A.y) - dy * (p.x - g.A.x)) / Math.sqrt(L2)
      } else {
        const r = Math.hypot(p.x - g.C.x, p.y - g.C.y)
        s = g.sgn * (g.R - r)
        const span = norm(g.sgn * (ang(g.C, g.B) - ang(g.C, g.A)))
        const at = norm(g.sgn * (ang(g.C, p) - ang(g.C, g.A)))
        away = at <= span ? Math.abs(s) : Math.min(far(p, g.A), far(p, g.B))
      }
      if (away < best) { best = away; signed = s }
    }
  }
  return signed
}
