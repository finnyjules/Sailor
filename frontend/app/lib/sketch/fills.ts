// app/lib/sketch/fills.ts
// Pen stage 7, filled areas. A fill is stored by a seed on one of its
// area's edges — the piece (named by its points), how far along it, and on
// which side — never by an area id, so it follows every drag. Faces come from
// faces.ts. reconcileFills carries fills across an edit (split → both halves,
// merge → one, opened → asleep with a gap marker); the structural edits that
// rename pieces (Cut, Dissolve, merging points, copies) move seeds themselves
// through splitSeeds / joinSeeds / renameSeedPoints / mapSeed. Pure.
import type { SketchDoc, SketchFill, FillSeed, EntityId } from './model'
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
