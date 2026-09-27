// app/lib/sketch/faces.ts
// Pen stage 7, the areas a drawing encloses. The drawing's lines, arcs and
// circles (not guides, not Bézier pieces) are split at every crossing and
// wherever an end touches another piece, and the resulting planar graph is
// walked face by face with exact arc geometry: every bounded face is one
// counter-clockwise outer cycle plus the clockwise outer cycles of whatever
// drawings sit inside it (holes). `gap` (drawing units) bridges an end that
// stops short of another piece by at most that much with a straight edge, so
// a nearly-closed area still counts. Faces are cached by a fingerprint of the
// geometry (facesFor), so hover and the overlay never recompute on a frame
// where nothing moved. Pure — no Vue, no DOM.
import type { SketchDoc, EntityId } from './model'
import type { Vec2 } from './geom'
import { curveGeom, intersectCurves, paramOf, pointAt, type CurveGeom, type CurveRef } from './crossings'

const TAU = Math.PI * 2

/** One piece of the drawing that can bound an area, in its own direction of
 *  travel: a line entity p1→p2 or a straight path piece anchor i→i+1; an arc
 *  path piece anchor i→i+1 about c (ccw = sweep 1, angle increasing); a whole
 *  circle counter-clockwise from +x; or a straight bridge across a gap. */
export type FacePiece =
  | { kind: 'line'; a: EntityId; b: EntityId }
  | { kind: 'arc'; a: EntityId; b: EntityId; c: EntityId; ccw: boolean }
  | { kind: 'circle'; id: EntityId; c: EntityId }
  | { kind: 'bridge' }

/** A key naming a piece by its points, the same whichever way round it was
 *  drawn (a line by its two ends; an arc by its ends, centre and turning;
 *  a circle by its own id). */
export function facePieceKey(p: FacePiece): string {
  if (p.kind === 'line') return p.a < p.b ? `L|${p.a}|${p.b}` : `L|${p.b}|${p.a}`
  if (p.kind === 'arc') {
    const lo = p.a < p.b
    return `A|${lo ? p.a : p.b}|${lo ? p.b : p.a}|${p.c}|${(lo ? p.ccw : !p.ccw) ? 1 : 0}`
  }
  if (p.kind === 'circle') return `C|${p.id}`
  return 'B'
}

export interface HalfEdge {
  piece: number
  /** the piece's own parameter where this half-edge starts / ends (line, arc:
   *  0..1 from its start; circle: angle / 2π, may pass 1 on the wrap) */
  t0: number
  t1: number
  /** runs the piece's own way */
  forward: boolean
  from: number
  to: number
  kind: 'line' | 'arc'
  p0: Vec2
  p1: Vec2
  c?: Vec2
  r?: number
  /** arcs: start angle and signed sweep (+ = counter-clockwise, angle increasing) */
  a0?: number
  sweep?: number
  /** leaving direction and signed curvature at the start (for the turn order) */
  ang: number
  k: number
  len: number
}

export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface FaceCycle { edges: number[]; area: number; poly: Vec2[]; box: Box; comp: number }
export interface Face { outer: number; holes: number[]; area: number; box: Box }

export interface FaceSet {
  tol: number
  pieces: FacePiece[]
  /** facePieceKey → piece index (the first piece with that key) */
  byKey: Map<string, number>
  /** each piece's half-edge pairs in parameter order: forward half-edge ids */
  pieceEdges: number[][]
  vertices: Vec2[]
  halfEdges: HalfEdge[]
  cycles: FaceCycle[]
  cycleOf: number[]
  /** the face a cycle bounds (its outer cycle, or one of its holes); null = the open plane */
  faceOfCycle: (number | null)[]
  faces: Face[]
  /** ends that stay open (no bridge reached them), and the component each vertex / piece is in */
  dangling: number[]
  vertexComp: number[]
  pieceComp: number[]
  bridges: { from: Vec2; to: Vec2 }[]
}

// ── geometry helpers ────────────────────────────────────────────────────────

const norm = (a: number) => ((a % TAU) + TAU) % TAU

function boxOf(pts: Vec2[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y }
  return { x0, y0, x1, y1 }
}
const boxHit = (b: Box, p: Vec2, pad = 0) => p.x >= b.x0 - pad && p.x <= b.x1 + pad && p.y >= b.y0 - pad && p.y <= b.y1 + pad
const boxesMeet = (a: Box, b: Box, pad: number) => a.x0 - pad <= b.x1 && b.x0 - pad <= a.x1 && a.y0 - pad <= b.y1 && b.y0 - pad <= a.y1

// the piece's point at its own parameter (circle: u = angle / 2π)
function at(g: CurveGeom, u: number): Vec2 { return pointAt(g, g.kind === 'circle' ? u * TAU : u) }
// the piece's own parameter nearest p (circle: angle / 2π)
function paramNear(g: CurveGeom, p: Vec2): number { const t = paramOf(g, p); return g.kind === 'circle' ? t / TAU : t }
function geomBox(g: CurveGeom): Box {
  if (g.kind === 'line') return boxOf([g.a!, g.b!])
  const c = g.c!, r = g.r!
  return { x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r }
}

/** Winding number of a closed polygon around p (non-zero = inside). */
export function winding(poly: Vec2[], p: Vec2): number {
  let w = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!
    if (a.y <= p.y) { if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++ }
    else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--
  }
  return w
}

// ── the pieces ──────────────────────────────────────────────────────────────

interface Src { piece: FacePiece; g: CurveGeom; box: Box }

function collectPieces(doc: SketchDoc): Src[] {
  const out: Src[] = []
  const push = (piece: FacePiece, ref: CurveRef) => {
    const g = curveGeom(doc, ref)
    if (g) out.push({ piece, g, box: geomBox(g) })
  }
  for (const e of doc.entities) {
    if (e.construction) continue
    if (e.kind === 'line') push({ kind: 'line', a: e.p1, b: e.p2 }, { kind: 'line', id: e.id })
    else if (e.kind === 'circle') push({ kind: 'circle', id: e.id, c: e.center }, { kind: 'circle', id: e.id })
    else if (e.kind === 'path') {
      const n = e.closed ? e.anchors.length : e.anchors.length - 1
      for (let i = 0; i < n; i++) {
        const s = e.segments[i]
        if (!s || s.kind === 'cubic') continue
        const a = e.anchors[i]!, b = e.anchors[(i + 1) % e.anchors.length]!
        push(s.kind === 'arc' ? { kind: 'arc', a, b, c: s.center, ccw: s.sweep === 1 } : { kind: 'line', a, b }, { kind: 'seg', pathId: e.id, segIndex: i })
      }
    }
  }
  return out
}

/** The weld tolerance: 1e-4 of the drawing's size — invisible at any zoom,
 *  well above what a solve leaves between a pinned end and its curve. */
function weldTol(srcs: Src[]): number {
  if (!srcs.length) return 1e-9
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of srcs) { x0 = Math.min(x0, s.box.x0); y0 = Math.min(y0, s.box.y0); x1 = Math.max(x1, s.box.x1); y1 = Math.max(y1, s.box.y1) }
  return Math.max(1e-9, 1e-4 * Math.hypot(x1 - x0, y1 - y0))
}

// ── the graph ───────────────────────────────────────────────────────────────

interface Graph {
  vertices: Vec2[]
  halfEdges: HalfEdge[]
  pieceEdges: number[][]
  out: number[][]
}

function edgeLen(h: Pick<HalfEdge, 'kind' | 'p0' | 'p1' | 'r' | 'sweep'>): number {
  return h.kind === 'line' ? Math.hypot(h.p1.x - h.p0.x, h.p1.y - h.p0.y) : Math.abs(h.sweep!) * h.r!
}

function buildGraph(srcs: Src[], params: number[][], bridges: { from: Vec2; to: Vec2 }[], tol: number): Graph {
  const vertices: Vec2[] = []
  const grid = new Map<string, number[]>()
  const cell = (x: number) => Math.floor(x / tol)
  function vid(p: Vec2): number {
    const cx = cell(p.x), cy = cell(p.y)
    let best = -1, bd = Infinity
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        const d = Math.hypot(vertices[i]!.x - p.x, vertices[i]!.y - p.y)
        if (d <= tol && d < bd) { bd = d; best = i }
      }
    }
    if (best >= 0) return best
    vertices.push({ x: p.x, y: p.y })
    const k = `${cx},${cy}`
    const list = grid.get(k)
    if (list) list.push(vertices.length - 1); else grid.set(k, [vertices.length - 1])
    return vertices.length - 1
  }
  const halfEdges: HalfEdge[] = []
  const pieceEdges: number[][] = []
  function addPair(piece: number, g: CurveGeom | null, u0: number, u1: number, p0: Vec2, p1: Vec2): number | null {
    const from = vid(p0), to = vid(p1)
    let fwd: Omit<HalfEdge, 'from' | 'to' | 'len' | 'ang' | 'k'>
    let back: Omit<HalfEdge, 'from' | 'to' | 'len' | 'ang' | 'k'>
    if (!g || g.kind === 'line') {
      if (from === to) return null
      fwd = { piece, t0: u0, t1: u1, forward: true, kind: 'line', p0, p1 }
      back = { piece, t0: u1, t1: u0, forward: false, kind: 'line', p0: p1, p1: p0 }
    } else {
      const c = g.c!, r = g.r!
      const sweepAll = g.kind === 'circle' ? TAU : g.sweepAngle!
      const a0 = g.kind === 'circle' ? u0 * TAU : g.a0! + sweepAll * u0
      const sweep = g.kind === 'circle' ? (u1 - u0) * TAU : sweepAll * (u1 - u0)
      if (Math.abs(sweep) * r <= tol && from === to) return null
      fwd = { piece, t0: u0, t1: u1, forward: true, kind: 'arc', p0, p1, c, r, a0, sweep }
      back = { piece, t0: u1, t1: u0, forward: false, kind: 'arc', p0: p1, p1: p0, c, r, a0: a0 + sweep, sweep: -sweep }
    }
    const h = halfEdges.length
    for (const [e, f, t] of [[fwd, from, to], [back, to, from]] as const) {
      const ang = e.kind === 'line' ? norm(Math.atan2(e.p1.y - e.p0.y, e.p1.x - e.p0.x)) : norm(e.a0! + (e.sweep! > 0 ? Math.PI / 2 : -Math.PI / 2))
      const k = e.kind === 'line' ? 0 : Math.sign(e.sweep!) / e.r!
      halfEdges.push({ ...e, from: f, to: t, ang, k, len: 0 })
    }
    halfEdges[h]!.len = halfEdges[h + 1]!.len = edgeLen(halfEdges[h]!)
    return h
  }
  srcs.forEach((s, i) => {
    const g = s.g
    const list: number[] = []
    // parameters sorted, points closer than tol collapsed into one
    const ps = [...params[i]!].sort((x, y) => x - y)
    const uniq: number[] = []
    for (const u of ps) {
      const prev = uniq[uniq.length - 1]
      if (prev == null) { uniq.push(u); continue }
      const d = Math.hypot(at(g, u).x - at(g, prev).x, at(g, u).y - at(g, prev).y)
      if (d > tol) uniq.push(u)
      else if (u === 1 && g.kind !== 'circle') uniq[uniq.length - 1] = 1   // a piece's own end wins
    }
    if (g.kind === 'circle') {
      if (uniq.length > 1) {
        const first = uniq[0]!, last = uniq[uniq.length - 1]!
        if (Math.hypot(at(g, first).x - at(g, last).x, at(g, first).y - at(g, last).y) <= tol) uniq.pop()
      }
      const cuts = uniq.length ? uniq : [0]
      for (let j = 0; j < cuts.length; j++) {
        const u0 = cuts[j]!, u1 = j + 1 < cuts.length ? cuts[j + 1]! : cuts[0]! + 1
        const h = addPair(i, g, u0, u1, at(g, u0), at(g, u1))
        if (h != null) list.push(h)
      }
    } else {
      for (let j = 0; j + 1 < uniq.length; j++) {
        const u0 = uniq[j]!, u1 = uniq[j + 1]!
        const h = addPair(i, g, u0, u1, at(g, u0), at(g, u1))
        if (h != null) list.push(h)
      }
    }
    pieceEdges.push(list)
  })
  for (const b of bridges) {
    const pi = pieceEdges.length
    pieceEdges.push([])
    const h = addPair(pi, null, 0, 1, b.from, b.to)
    if (h != null) pieceEdges[pi]!.push(h)
  }
  // outgoing half-edges round each vertex, counter-clockwise; at an equal
  // leaving direction the one turning right comes first
  const out: number[][] = vertices.map(() => [])
  halfEdges.forEach((h, i) => out[h.from]!.push(i))
  for (const list of out) {
    list.sort((i, j) => {
      const a = halfEdges[i]!, b = halfEdges[j]!
      let d = a.ang - b.ang
      if (Math.abs(d) < 1e-9 || Math.abs(Math.abs(d) - TAU) < 1e-9) d = 0
      return d !== 0 ? d : a.k - b.k || i - j
    })
  }
  return { vertices, halfEdges, pieceEdges, out }
}

// ── crossings and touches ───────────────────────────────────────────────────

function splitParams(srcs: Src[], tol: number): number[][] {
  const params = srcs.map(s => (s.g.kind === 'circle' ? [] : [0, 1]))
  for (let i = 0; i < srcs.length; i++) {
    for (let j = i + 1; j < srcs.length; j++) {
      const A = srcs[i]!, B = srcs[j]!
      if (!boxesMeet(A.box, B.box, tol)) continue
      for (const ip of intersectCurves(A.g, B.g)) {
        params[i]!.push(A.g.kind === 'circle' ? norm(ip.tSelf) / TAU : ip.tSelf)
        params[j]!.push(B.g.kind === 'circle' ? norm(ip.tOther) / TAU : ip.tOther)
      }
    }
  }
  // an end that touches another piece (a trimmed end pinned onto it, a
  // T-junction the float maths just missed) splits that piece there
  const ends: Vec2[] = []
  for (const s of srcs) if (s.g.kind !== 'circle') ends.push(s.g.a!, s.g.b!)
  for (let i = 0; i < srcs.length; i++) {
    const s = srcs[i]!
    for (const e of ends) {
      if (!boxHit(s.box, e, tol)) continue
      const u = paramNear(s.g, e)
      const q = at(s.g, u)
      if (Math.hypot(q.x - e.x, q.y - e.y) <= tol) params[i]!.push(u)
    }
  }
  return params
}

// ── gap bridges ─────────────────────────────────────────────────────────────

function findBridges(srcs: Src[], gr: Graph, gap: number, tol: number): { params: { piece: number; u: number }[]; bridges: { from: Vec2; to: Vec2 }[] } {
  const V = gr.vertices
  const deg = V.map((_, v) => gr.out[v]!.length)
  const ends = V.map((_, v) => v).filter(v => deg[v] === 1)
  type Cand = { v: number; d: number; to: Vec2; end?: number; piece?: number; u?: number }
  const cands: Cand[] = []
  for (const v of ends) {
    const P = V[v]!
    const own = gr.halfEdges[gr.out[v]![0]!]!
    // another open end, or a vertex where pieces already meet
    V.forEach((Q, w) => {
      if (w === v || deg[w] === 0) return
      const d = Math.hypot(Q.x - P.x, Q.y - P.y)
      if (d > gap || d <= tol) return
      if (w === own.to && deg[w] === 1) return   // the other end of one short piece
      cands.push({ v, d, to: Q, ...(deg[w] === 1 ? { end: w } : {}) })
    })
    // or the nearest point on a piece (not the edge it ends)
    srcs.forEach((s, i) => {
      if (!boxHit(s.box, P, gap)) return
      const u = paramNear(s.g, P)
      const q = at(s.g, u)
      const d = Math.hypot(q.x - P.x, q.y - P.y)
      if (d > gap || d <= tol) return
      if (i === own.piece && u >= Math.min(own.t0, own.t1) - 1e-9 && u <= Math.max(own.t0, own.t1) + 1e-9) return
      cands.push({ v, d, to: q, piece: i, u })
    })
  }
  // points first (another open end, a corner), then points on pieces;
  // nearest first within each; each open end takes one bridge, and an end
  // reached by another end's bridge is closed by it
  cands.sort((x, y) => (x.piece != null ? 1 : 0) - (y.piece != null ? 1 : 0) || x.d - y.d)
  const used = new Set<number>()
  const params: { piece: number; u: number }[] = []
  const bridges: { from: Vec2; to: Vec2 }[] = []
  for (const c of cands) {
    if (used.has(c.v) || (c.end != null && used.has(c.end))) continue
    used.add(c.v)
    if (c.end != null) used.add(c.end)
    if (c.piece != null) params.push({ piece: c.piece, u: c.u! })
    bridges.push({ from: V[c.v]!, to: c.to })
  }
  return { params, bridges }
}

// ── faces ───────────────────────────────────────────────────────────────────

function flatten(h: HalfEdge, pts: Vec2[]): void {
  if (h.kind === 'line') { pts.push(h.p1); return }
  const n = Math.max(1, Math.ceil(Math.abs(h.sweep!) / (Math.PI / 32)))
  for (let i = 1; i <= n; i++) {
    const a = h.a0! + (h.sweep! * i) / n
    pts.push({ x: h.c!.x + h.r! * Math.cos(a), y: h.c!.y + h.r! * Math.sin(a) })
  }
}

// ½∮(x dy − y dx) along one half-edge, exact for arcs
function areaPart(h: HalfEdge): number {
  if (h.kind === 'line') return 0.5 * (h.p0.x * h.p1.y - h.p0.y * h.p1.x)
  const { x: cx, y: cy } = h.c!, r = h.r!, f0 = h.a0!, f1 = h.a0! + h.sweep!
  return 0.5 * (r * r * h.sweep! + r * (cx * (Math.sin(f1) - Math.sin(f0)) - cy * (Math.cos(f1) - Math.cos(f0))))
}

/** Every area the drawing encloses. `gap`: bridge ends that stop at most this
 *  far (drawing units) short of another piece. */
export function findFaces(doc: SketchDoc, opts: { gap?: number } = {}): FaceSet {
  const srcs = collectPieces(doc)
  const tol = weldTol(srcs)
  const params = splitParams(srcs, tol)
  let gr = buildGraph(srcs, params, [], tol)
  let bridges: { from: Vec2; to: Vec2 }[] = []
  const gap = opts.gap ?? 0
  if (gap > tol) {
    const found = findBridges(srcs, gr, gap, tol)
    if (found.bridges.length) {
      for (const p of found.params) params[p.piece]!.push(p.u)
      bridges = found.bridges
      gr = buildGraph(srcs, params, bridges, tol)
    }
  }
  const { vertices, halfEdges, pieceEdges, out } = gr
  const pieces: FacePiece[] = [...srcs.map(s => s.piece), ...bridges.map(() => ({ kind: 'bridge' as const }))]
  const byKey = new Map<string, number>()
  pieces.forEach((p, i) => { if (p.kind !== 'bridge') { const k = facePieceKey(p); if (!byKey.has(k)) byKey.set(k, i) } })

  // components (union-find over vertices)
  const parent = vertices.map((_, i) => i)
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]! } return x }
  for (let h = 0; h < halfEdges.length; h += 2) { const a = find(halfEdges[h]!.from), b = find(halfEdges[h]!.to); if (a !== b) parent[a] = b }
  const vertexComp = vertices.map((_, i) => find(i))
  const pieceComp = pieceEdges.map(list => (list.length ? vertexComp[halfEdges[list[0]!]!.from]! : -1))

  // walk: next(h) = the half-edge leaving h's end just clockwise of h's twin
  const pos = new Map<number, number>()
  out.forEach(list => list.forEach((h, i) => pos.set(h, i)))
  const next = (h: number): number => {
    const t = h ^ 1
    const list = out[halfEdges[t]!.from]!
    return list[(pos.get(t)! - 1 + list.length) % list.length]!
  }
  const cycleOf = new Array<number>(halfEdges.length).fill(-1)
  const cycles: FaceCycle[] = []
  for (let s = 0; s < halfEdges.length; s++) {
    if (cycleOf[s] !== -1) continue
    const edges: number[] = []
    let h = s, guard = 0
    while (cycleOf[h] === -1 && guard++ <= halfEdges.length) { cycleOf[h] = cycles.length; edges.push(h); h = next(h) }
    let area = 0
    const poly: Vec2[] = [halfEdges[edges[0]!]!.p0]
    for (const e of edges) { area += areaPart(halfEdges[e]!); flatten(halfEdges[e]!, poly) }
    poly.pop()
    cycles.push({ edges, area, poly, box: boxOf(poly), comp: vertexComp[halfEdges[s]!.from]! })
  }

  // bounded faces: counter-clockwise cycles with area; each component's
  // lowest-area cycle is its outline on the plane
  // an area smaller than a millionth of the drawing's square (a sliver where
  // two ends cross by a hair) is not an area
  const areaEps = 100 * tol * tol
  const faceOfCycle: (number | null)[] = cycles.map(() => null)
  const faces: Face[] = []
  const outerOfComp = new Map<number, number>()
  cycles.forEach((c, i) => {
    const o = outerOfComp.get(c.comp)
    if (o == null || c.area < cycles[o]!.area) outerOfComp.set(c.comp, i)
  })
  cycles.forEach((c, i) => {
    if (outerOfComp.get(c.comp) === i || !(c.area > areaEps)) return
    faceOfCycle[i] = faces.length
    faces.push({ outer: i, holes: [], area: c.area, box: c.box })
  })
  // a component inside another's face is a hole of the smallest such face
  for (const [comp, oi] of outerOfComp) {
    const oc = cycles[oi]!
    const e0 = halfEdges[oc.edges[0]!]!
    const probe = e0.kind === 'line' ? { x: (e0.p0.x + e0.p1.x) / 2, y: (e0.p0.y + e0.p1.y) / 2 } : at({ kind: 'circle', c: e0.c!, r: e0.r! } as CurveGeom, norm(e0.a0! + e0.sweep! / 2) / TAU)
    let best: number | null = null
    faces.forEach((f, fi) => {
      if (cycles[f.outer]!.comp === comp || !boxHit(f.box, probe)) return
      if (winding(cycles[f.outer]!.poly, probe) === 0) return
      if (best == null || f.area < faces[best]!.area) best = fi
    })
    if (best != null) {
      faces[best]!.holes.push(oi)
      faces[best]!.area += Math.min(0, oc.area)
      faceOfCycle[oi] = best
    }
  }
  const dangling = vertices.map((_, v) => v).filter(v => out[v]!.length === 1)
  return { tol, pieces, byKey, pieceEdges, vertices, halfEdges, cycles, cycleOf, faceOfCycle, faces, dangling, vertexComp, pieceComp, bridges }
}

/** The face under p (the smallest, should faces nest), or null. */
export function faceAt(fs: FaceSet, p: Vec2): number | null {
  let best: number | null = null
  fs.faces.forEach((f, i) => {
    if (!boxHit(f.box, p)) return
    if (winding(fs.cycles[f.outer]!.poly, p) === 0) return
    for (const h of f.holes) if (Math.abs(fs.cycles[h]!.area) > fs.tol * fs.tol && winding(fs.cycles[h]!.poly, p) !== 0) return
    if (best == null || f.area < fs.faces[best]!.area) best = i
  })
  return best
}

/** The face a half-edge's left side belongs to (null = the open plane). */
export function faceOfHalfEdge(fs: FaceSet, h: number): number | null {
  return fs.faceOfCycle[fs.cycleOf[h]!] ?? null
}

// ── outlines ────────────────────────────────────────────────────────────────

const num = (n: number) => (Object.is(n, -0) ? 0 : n)

// a cycle's half-edges with the out-and-back spurs (a line poking into the
// face and ending there) taken out — they bound nothing
function withoutSpurs(edges: number[]): number[] {
  const st: number[] = []
  for (const e of edges) {
    if (st.length && (st[st.length - 1]! ^ 1) === e) st.pop()
    else st.push(e)
  }
  while (st.length > 1 && (st[0]! ^ 1) === st[st.length - 1]!) { st.shift(); st.pop() }
  return st
}

function cycleD(fs: FaceSet, ci: number, s: number): string {
  const edges = withoutSpurs(fs.cycles[ci]!.edges)
  if (!edges.length) return ''
  const P = (p: Vec2) => `${num(p.x * s)} ${num(p.y * s)}`
  let d = `M ${P(fs.halfEdges[edges[0]!]!.p0)}`
  for (const e of edges) {
    const h = fs.halfEdges[e]!
    if (h.kind === 'line') { d += ` L ${P(h.p1)}`; continue }
    const r = num(h.r! * s), sw = h.sweep! > 0 ? 1 : 0
    const arc = (a: number, sweep: number) => {
      const end = { x: h.c!.x + h.r! * Math.cos(a + sweep), y: h.c!.y + h.r! * Math.sin(a + sweep) }
      d += ` A ${r} ${r} 0 ${Math.abs(sweep) > Math.PI ? 1 : 0} ${sw} ${P(end)}`
    }
    if (Math.abs(h.sweep!) >= TAU - 1e-9) { arc(h.a0!, h.sweep! / 2); arc(h.a0! + h.sweep! / 2, h.sweep! / 2) }
    else d += ` A ${r} ${r} 0 ${Math.abs(h.sweep!) > Math.PI ? 1 : 0} ${sw} ${P(h.p1)}`
  }
  return d + ' Z'
}

/** One closed outline (true arcs) for these faces, holes included: outer
 *  cycles counter-clockwise, holes clockwise, so a non-zero fill paints
 *  exactly the faces. Coordinates × `scale`. */
export function facesD(fs: FaceSet, faceIds: number[], scale = 1): string {
  const parts: string[] = []
  for (const f of faceIds) {
    const face = fs.faces[f]
    if (!face) continue
    for (const ci of [face.outer, ...face.holes]) {
      if (ci !== face.outer && !(Math.abs(fs.cycles[ci]!.area) > fs.tol * fs.tol)) continue
      const d = cycleD(fs, ci, scale)
      if (d) parts.push(d)
    }
  }
  return parts.join(' ')
}

// ── the cache ───────────────────────────────────────────────────────────────

// a fingerprint of everything faces depend on (pieces, their points, radii,
// guide flags) — never the fills — so a frame where nothing moved is a hit
const f64 = new Float64Array(1)
const u32 = new Uint32Array(f64.buffer)
export function geometryKey(doc: SketchDoc): string {
  let h1 = 0x811c9dc5, h2 = 5381, n = 0
  const mix = (x: number) => { h1 = Math.imul(h1 ^ x, 16777619); h2 = (Math.imul(h2, 33) ^ x) | 0; n++ }
  const str = (s: string) => { for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); mix(0) }
  const numb = (v: number) => { f64[0] = v; mix(u32[0]!); mix(u32[1]!) }
  for (const e of doc.entities) {
    str(e.kind); str(e.id); mix(e.construction ? 1 : 0)
    if (e.kind === 'point') { numb(e.x); numb(e.y) }
    else if (e.kind === 'line') { str(e.p1); str(e.p2) }
    else if (e.kind === 'circle') { str(e.center); numb(e.r) }
    else {
      mix(e.closed ? 1 : 0)
      for (const a of e.anchors) str(a)
      for (const s of e.segments) { str(s.kind); if (s.kind === 'arc') { str(s.center); mix(s.sweep) } }
    }
  }
  return `${h1 >>> 0}:${h2 >>> 0}:${n}`
}

const CACHE_SIZE = 6
const cache: { key: string; fs: FaceSet }[] = []
/** findFaces, remembered for the last few geometries (a hover, the overlay and
 *  a host's preview asking about the same drawing share one answer). */
export function facesFor(doc: SketchDoc, gap = 0): FaceSet {
  const key = `${geometryKey(doc)}|${gap}`
  const i = cache.findIndex(c => c.key === key)
  if (i >= 0) { const [hit] = cache.splice(i, 1); cache.unshift(hit!); return hit!.fs }
  const fs = findFaces(doc, { gap })
  cache.unshift({ key, fs })
  if (cache.length > CACHE_SIZE) cache.pop()
  return fs
}
