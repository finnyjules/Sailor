// app/lib/sketch/fills.ts
// Pen stage 7, filled areas. A fill is stored by a seed on one of its
// area's edges — the piece (named by its points), how far along it, and on
// which side — never by an area id, so it follows every drag. Faces come from
// faces.ts. reconcileFills carries fills across an edit (split → both halves,
// merge → one, opened → asleep with a gap marker); the structural edits that
// rename pieces (Cut, Dissolve, merging points, copies) move seeds themselves
// through splitSeeds / joinSeeds / renameSeedPoints / mapSeed. Pure.
import type { SketchDoc, SketchFill, FillSeed, EntityId } from './model'
import { getPoint } from './model'
import type { Vec2 } from './geom'
import { facesFor, faceAt, facesD, faceOfHalfEdge, facePieceKey, type FaceSet, type FacePiece, type HalfEdge } from './faces'

/** How far (screen px, at the zoom of the first fill) a nearly-closed area's
 *  gap may be and still fill — Clean up's join distance. */
export const FILL_GAP_PX = 6

/** The gap a drawing's faces use: its stored gap; none when it has fills
 *  but no stored gap (its first fill was made without one — a gap must never
 *  appear later, at another zoom); `gapIfNone` only before its first fill. */
function gapOf(doc: SketchDoc, gapIfNone: number): number {
  return doc.fillGap ?? (doc.fills?.length ? 0 : gapIfNone)
}

/** The faces this drawing's fills live on (its stored gap). */
export function fillFaces(doc: SketchDoc, gapIfNone = 0): FaceSet {
  return facesFor(doc, gapOf(doc, gapIfNone))
}

// ── seeds ↔ half-edges ─────────────────────────────────────────────────────

function pieceOfSeed(s: FillSeed): FacePiece {
  if (s.kind === 'circle') return { kind: 'circle', id: s.a, c: s.c ?? s.a }
  if (s.kind === 'arc') return { kind: 'arc', a: s.a, b: s.b, c: s.c ?? '', ccw: !!s.ccw }
  return { kind: 'line', a: s.a, b: s.b }
}

// the seed on its piece as faces.ts has it: the piece's index, the half-edge
// holding the seed's spot running the piece's own way, and the piece's own
// parameter there (a circle's may pass 1 on the wrap). A piece named the
// other way round reads 1 − t and the other side.
function locateSeed(fs: FaceSet, s: FillSeed): { h: number; u: number } | null {
  const pi = fs.byKey.get(facePieceKey(pieceOfSeed(s)))
  if (pi == null) return null
  const piece = fs.pieces[pi]!
  let t = s.t, side = s.side
  if ((piece.kind === 'line' || piece.kind === 'arc') && piece.a !== s.a) { t = 1 - t; side = side === 1 ? -1 : 1 }
  for (const h of fs.pieceEdges[pi]!) {
    const e = fs.halfEdges[h]!
    let u = t
    if (piece.kind === 'circle' && u < e.t0 - 1e-12) u += 1
    if (u >= e.t0 - 1e-12 && u <= e.t1 + 1e-12) return { h: side === 1 ? h : h ^ 1, u }
  }
  return null
}

/** The half-edge whose left side the seed's area is on, or null when its piece is gone. */
export function halfEdgeOfSeed(fs: FaceSet, s: FillSeed): number | null {
  return locateSeed(fs, s)?.h ?? null
}

/** The face a fill sits on now, or null (asleep). A seed counts only on a
 *  face's OUTER cycle: one on a hole's outline (an area inside that opened)
 *  sleeps rather than hand its fill to the area around it. seedForFace only
 *  ever seeds an outer cycle. */
export function resolveFill(fs: FaceSet, f: SketchFill): number | null {
  const h = halfEdgeOfSeed(fs, f.seed)
  if (h == null) return null
  const face = faceOfHalfEdge(fs, h)
  return face != null && fs.faces[face]!.outer === fs.cycleOf[h] ? face : null
}

/** A seed in the middle of half-edge h, on its left (its face's side). */
export function seedOnHalfEdge(fs: FaceSet, h: number): FillSeed | null {
  const e = fs.halfEdges[h]!
  const p = fs.pieces[e.piece]!
  if (p.kind === 'bridge') return null
  const mid = (e.t0 + e.t1) / 2
  const t = p.kind === 'circle' ? ((mid % 1) + 1) % 1 : mid
  const side: 1 | -1 = e.forward ? 1 : -1
  if (p.kind === 'circle') return { kind: 'circle', a: p.id, b: p.id, c: p.c, t, side }
  if (p.kind === 'arc') return { kind: 'arc', a: p.a, b: p.b, c: p.c, ccw: p.ccw, t, side }
  return { kind: 'line', a: p.a, b: p.b, t, side }
}

/** A seed for face f: the middle of its longest outer edge (never a bridge). */
export function seedForFace(fs: FaceSet, f: number): FillSeed | null {
  const face = fs.faces[f]
  if (!face) return null
  let best: number | null = null
  for (const h of fs.cycles[face.outer]!.edges) {
    if (fs.pieces[fs.halfEdges[h]!.piece]!.kind === 'bridge') continue
    if (best == null || fs.halfEdges[h]!.len > fs.halfEdges[best]!.len) best = h
  }
  return best == null ? null : seedOnHalfEdge(fs, best)
}

export function freshFillId(doc: SketchDoc): EntityId {
  const have = new Set((doc.fills ?? []).map(f => f.id))
  let n = have.size + 1
  while (have.has(`F${n}`)) n++
  return `F${n}`
}

/** The drawing without its fills (a pen that can't fill: a text guide). */
export function withoutFills(doc: SketchDoc): SketchDoc {
  if (!doc.fills && doc.fillGap == null) return doc
  const { fills: _f, fillGap: _g, ...rest } = doc
  return rest
}

// ── what shows ──────────────────────────────────────────────────────────────

export interface FillState { fs: FaceSet; filled: number[]; asleep: SketchFill[] }

/** Which faces are filled, and which fills sleep (their area is open). */
export function fillState(doc: SketchDoc): FillState {
  const fs = fillFaces(doc)
  const filled: number[] = []
  const asleep: SketchFill[] = []
  for (const f of doc.fills ?? []) {
    const face = resolveFill(fs, f)
    if (face == null) asleep.push(f)
    else if (!filled.includes(face)) filled.push(face)
  }
  return { fs, filled, asleep }
}

/** The filled areas as one closed outline (true arcs), coordinates × scale;
 *  '' when nothing is filled (no fills, or every fill asleep). */
export function fillPathData(doc: SketchDoc, scale = 1): string {
  if (!doc.fills?.length) return ''
  const st = fillState(doc)
  return st.filled.length ? facesD(st.fs, st.filled, scale) : ''
}

function pointOnHalfEdge(e: HalfEdge, u: number): Vec2 {
  const k = e.t1 === e.t0 ? 0.5 : (u - e.t0) / (e.t1 - e.t0)
  if (e.kind === 'line') return { x: e.p0.x + (e.p1.x - e.p0.x) * k, y: e.p0.y + (e.p1.y - e.p0.y) * k }
  const a = e.a0! + e.sweep! * k
  return { x: e.c!.x + e.r! * Math.cos(a), y: e.c!.y + e.r! * Math.sin(a) }
}

/** Where to show that a fill sleeps: the open ends of the drawing its edge
 *  belongs to, nearest its seed first (at most two per fill). */
export function gapMarkers(doc: SketchDoc): Vec2[] {
  const st = fillState(doc)
  const out: Vec2[] = []
  for (const f of st.asleep) {
    const loc = locateSeed(st.fs, f.seed)
    if (!loc) continue
    const e = st.fs.halfEdges[loc.h]!
    const at = pointOnHalfEdge(e, loc.u)
    const comp = st.fs.pieceComp[e.piece]!
    const ends = st.fs.dangling.filter(v => st.fs.vertexComp[v] === comp).map(v => st.fs.vertices[v]!)
    ends.sort((p, q) => Math.hypot(p.x - at.x, p.y - at.y) - Math.hypot(q.x - at.x, q.y - at.y))
    for (const p of ends.slice(0, 2)) if (!out.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9)) out.push(p)
  }
  return out
}

// ── the Fill tool ───────────────────────────────────────────────────────────

/** The face under p as the Fill tool sees it (the drawing's own gap, or
 *  `gapIfNone` before its first fill), and whether it is filled. */
export function fillTarget(doc: SketchDoc, p: Vec2, gapIfNone: number): { face: number; filled: boolean; d: string } | null {
  const fs = fillFaces(doc, gapIfNone)
  const f = faceAt(fs, p)
  if (f == null) return null
  const filled = (doc.fills ?? []).some(x => resolveFill(fs, x) === f)
  return { face: f, filled, d: facesD(fs, [f]) }
}

/** Click: fill the face under p, or empty it if it is filled. The first
 *  fill fixes the drawing's gap; the last one clears it. True if it changed. */
export function toggleFillAt(doc: SketchDoc, p: Vec2, gapIfNone: number): boolean {
  const gap = gapOf(doc, gapIfNone)
  const fs = facesFor(doc, gap)
  const f = faceAt(fs, p)
  if (f == null) return false
  const fills = doc.fills ?? []
  const on = fills.filter(x => resolveFill(fs, x) === f)
  if (on.length) {
    doc.fills = fills.filter(x => !on.includes(x))
    if (!doc.fills.length) { delete doc.fills; delete doc.fillGap }
    return true
  }
  const seed = seedForFace(fs, f)
  if (!seed) return false
  doc.fills = [...fills, { id: freshFillId(doc), seed }]
  if (doc.fillGap == null && gap > 0) doc.fillGap = gap
  return true
}

/** Fill the face at p unless it already is (copies landing on their place). */
export function addFillAt(doc: SketchDoc, p: Vec2): boolean {
  const fs = fillFaces(doc)
  const f = faceAt(fs, p)
  if (f == null) return false
  const fills = doc.fills ?? []
  if (fills.some(x => resolveFill(fs, x) === f)) return false
  const seed = seedForFace(fs, f)
  if (!seed) return false
  doc.fills = [...fills, { id: freshFillId(doc), seed }]
  return true
}

// ── carrying fills across an edit ───────────────────────────────────────────

// a half-edge in its piece key's own orientation: the key, whether it runs
// the key's way, and its parameter interval measured the key's way
interface KeyedEdge { key: string; dir: boolean; lo: number; hi: number; circle: boolean; h: number }
function keyed(fs: FaceSet, h: number): KeyedEdge | null {
  const e = fs.halfEdges[h]!
  const p = fs.pieces[e.piece]!
  if (p.kind === 'bridge') return null
  const key = facePieceKey(p)
  // does the piece's own direction run the key's way? (facePieceKey orders a
  // line's and an arc's ends by id; a circle has one way)
  const along = p.kind === 'circle' ? true : p.a <= p.b
  const u0 = along ? e.t0 : 1 - e.t0, u1 = along ? e.t1 : 1 - e.t1
  const dir = along ? e.forward : !e.forward
  return { key, dir, lo: Math.min(u0, u1), hi: Math.max(u0, u1), circle: p.kind === 'circle', h }
}

// two stretches of one piece are the same stretch, or one holds the other:
// they overlap by more than half the shorter one (a circle's may be read a
// turn apart: one split at 0.9..1.1, the other at 0..0.1). Not merely "by a
// hair": when a piece's end is dragged, the parameter where another piece
// meets it slides, and the neighbouring areas' stretches overlap by a sliver
// that says nothing about which area is which.
function overlaps(m: KeyedEdge, k: KeyedEdge): boolean {
  const need = Math.max(1e-9, 0.5 * Math.min(m.hi - m.lo, k.hi - k.lo))
  for (const s of m.circle ? [0, 1, -1] : [0]) {
    if (Math.min(m.hi + s, k.hi) - Math.max(m.lo + s, k.lo) > need) return true
  }
  return false
}

/** A face's cycles: its outer one, then its holes. */
export function faceCycles(fs: FaceSet, f: number): number[] {
  const face = fs.faces[f]!
  return [face.outer, ...face.holes]
}

// the faces of `after` that take up part of face fb of `before`, found by
// the edges they share (same piece, same side, overlapping stretch)
function sharedEdgeFaces(FB: FaceSet, fb: number, FA: FaceSet, index: Map<string, KeyedEdge[]>): Set<number> {
  const out = new Set<number>()
  for (const ci of faceCycles(FB, fb)) {
    for (const h of FB.cycles[ci]!.edges) {
      const k = keyed(FB, h)
      if (!k) continue
      for (const m of index.get(k.key) ?? []) {
        if (m.dir !== k.dir || !overlaps(m, k)) continue
        const g = faceOfHalfEdge(FA, m.h)
        if (g != null) out.add(g)
      }
    }
  }
  return out
}

/** A point well inside face g (a step in from the middle of one of its
 *  longest outer edges), or null when none of the tries lands in it. */
export function interiorPoint(fs: FaceSet, g: number): Vec2 | null {
  const face = fs.faces[g]!
  const size = Math.hypot(face.box.x1 - face.box.x0, face.box.y1 - face.box.y0)
  const edges = [...fs.cycles[face.outer]!.edges].sort((a, b) => fs.halfEdges[b]!.len - fs.halfEdges[a]!.len)
  for (const step of [1e-3, 1e-2, 5e-2]) {
    for (const h of edges.slice(0, 6)) {
      const e = fs.halfEdges[h]!
      const m = pointOnHalfEdge(e, (e.t0 + e.t1) / 2)
      // the direction of travel at m; the face is on its left
      let tx: number, ty: number
      if (e.kind === 'line') { tx = e.p1.x - e.p0.x; ty = e.p1.y - e.p0.y }
      else { const a = e.a0! + e.sweep! / 2; const s = e.sweep! > 0 ? 1 : -1; tx = -Math.sin(a) * s; ty = Math.cos(a) * s }
      const L = Math.hypot(tx, ty) || 1
      const p = { x: m.x - (ty / L) * step * size, y: m.y + (tx / L) * step * size }
      if (faceAt(fs, p) === g) return p
    }
  }
  return null
}

/** Every point id on face f's boundary pieces. */
export function boundaryPoints(fs: FaceSet, f: number): EntityId[] {
  const ids = new Set<EntityId>()
  for (const ci of faceCycles(fs, f)) {
    for (const h of fs.cycles[ci]!.edges) {
      const p = fs.pieces[fs.halfEdges[h]!.piece]!
      if (p.kind === 'line') { ids.add(p.a); ids.add(p.b) }
      else if (p.kind === 'arc') { ids.add(p.a); ids.add(p.b); ids.add(p.c) }
      else if (p.kind === 'circle') ids.add(p.c)
    }
  }
  return [...ids]
}

// face fb's boundary points are all still there, within 0.1 % of its size
function stayedPut(before: SketchDoc, after: SketchDoc, FB: FaceSet, fb: number): boolean {
  const b = FB.faces[fb]!.box
  const tol = 1e-3 * Math.hypot(b.x1 - b.x0, b.y1 - b.y0)
  for (const id of boundaryPoints(FB, fb)) {
    const p = getPoint(before, id), q = getPoint(after, id)
    if (!p || !q || Math.hypot(p.x - q.x, p.y - q.y) > tol) return false
  }
  return true
}

/** The fills `after` should have, given the drawing was `before` a moment
 *  ago: every fill whose seed still finds its face keeps it; every face that
 *  takes up part of a surviving fill's old face is filled too (split → both
 *  halves); faces holding two fills keep one (merge → one); a fill whose area
 *  opened sleeps on an edge it still has (or goes, if none is left); every
 *  seed ends on its own face. A fill missing from `after` was emptied on
 *  purpose and is never brought back. Never writes; an edit that changes
 *  nothing returns `after.fills`' own objects in their order. */
export function reconcileFills(before: SketchDoc, after: SketchDoc): SketchFill[] {
  const now = after.fills ?? []
  if (!now.length) return []
  // the faces each drawing's fills live on (what fillState shows)
  const FA = fillFaces(after)
  const FB = fillFaces(before)
  const was = new Map((before.fills ?? []).map(f => [f.id, f]))
  const claimed = new Map<number, SketchFill>()
  const asleep: SketchFill[] = []
  for (const f of now) {
    const g = resolveFill(FA, f)
    if (g == null) asleep.push(f)
    else if (!claimed.has(g)) claimed.set(g, f)
  }
  // the geometry did not change (the faces cache hands back the same set):
  // every fill already sits where it did, nothing split, nothing merged
  if (FA === FB && claimed.size + asleep.length === now.length && asleep.every(f => halfEdgeOfSeed(FA, f.seed) != null)) return [...now]
  // index `after`'s half-edges by piece key, once (only when some fill had a face before)
  let index: Map<string, KeyedEdge[]> | null = null
  const indexOf = () => {
    if (index) return index
    index = new Map()
    for (let h = 0; h < FA.halfEdges.length; h++) {
      const k = keyed(FA, h)
      if (!k) continue
      const list = index.get(k.key)
      if (list) list.push(k); else index.set(k.key, [k])
    }
    return index
  }
  const pts = new Map<number, Vec2 | null>()
  const inside = (g: number) => { if (!pts.has(g)) pts.set(g, interiorPoint(FA, g)); return pts.get(g)! }
  const reborn = new Set<SketchFill>()
  for (const f of now) {
    const old = was.get(f.id)
    if (!old) continue
    const fb = resolveFill(FB, old)
    if (fb == null) continue
    const grow = sharedEdgeFaces(FB, fb, FA, indexOf())
    if (stayedPut(before, after, FB, fb)) {
      const b = FB.faces[fb]!.box
      FA.faces.forEach((face, g) => {
        if (grow.has(g) || face.box.x0 > b.x1 || face.box.x1 < b.x0 || face.box.y0 > b.y1 || face.box.y1 < b.y0) return
        const p = inside(g)
        if (p && faceAt(FB, p) === fb) grow.add(g)
      })
    }
    const sleeping = asleep.includes(f)
    for (const g of [...grow].sort((x, y) => x - y)) {
      if (claimed.has(g)) continue
      const seed = seedForFace(FA, g)
      if (!seed) continue
      if (sleeping && !reborn.has(f)) { claimed.set(g, { id: f.id, seed }); reborn.add(f) }
      else claimed.set(g, { id: '', seed })
    }
    if (sleeping && !reborn.has(f) && halfEdgeOfSeed(FA, f.seed) == null) {
      // its area opened and its own edge went: sleep on an edge of the old
      // area that is left and still open. If every edge left now bounds an
      // area, those areas were filled above (or held another fill): the fill
      // merged into them and goes.
      let moved: SketchFill | null = null
      for (const ci of faceCycles(FB, fb)) {
        for (const h of FB.cycles[ci]!.edges) {
          const s = seedOnHalfEdge(FB, h)
          if (!s || halfEdgeOfSeed(FA, s) == null) continue
          const cand = { id: f.id, seed: s }
          if (resolveFill(FA, cand) == null) { moved = cand; break }
        }
        if (moved) break
      }
      if (moved) { reborn.add(f); asleep[asleep.indexOf(f)] = moved }
    }
  }
  // the drawing's own fills first, in their order (so an edit that changes
  // nothing leaves them exactly as they were), then the new halves by face
  const byFill = new Map<SketchFill, number>()
  for (const [g, c] of claimed) byFill.set(c, g)
  const rebornAt = new Map<EntityId, number>()
  for (const [g, c] of claimed) if (c.id && !now.includes(c)) rebornAt.set(c.id, g)
  const out: SketchFill[] = []
  const taken = new Set<string>()
  const placed = new Set<number>()
  const settled = (g: number, f: SketchFill): SketchFill | null => {
    const seed = resolveFill(FA, f) === g ? f.seed : seedForFace(FA, g)
    return seed ? (seed === f.seed ? f : { id: f.id, seed }) : null
  }
  for (const f of now) {
    if (taken.has(f.id)) continue
    const own = byFill.get(f)
    const g = own ?? (reborn.has(f) ? rebornAt.get(f.id) : undefined)
    if (g != null) {
      const c = own != null ? f : claimed.get(g)!
      const s2 = settled(g, c)
      if (s2) { out.push(s2); taken.add(f.id); placed.add(g) }
      continue
    }
    const sleeper = asleep.find(x => x.id === f.id)
    if (sleeper && halfEdgeOfSeed(FA, sleeper.seed) != null) { out.push(sleeper); taken.add(f.id) }
  }
  let n = 1
  for (const [g, c] of [...claimed].sort((x, y) => x[0] - y[0])) {
    if (placed.has(g) || c.id) continue
    const s2 = settled(g, c)
    if (!s2) continue
    while (taken.has(`F${n}`)) n++
    out.push({ id: `F${n}`, seed: s2.seed }); taken.add(`F${n}`)
  }
  return out
}
