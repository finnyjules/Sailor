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

// the piece's point at its own parameter (circle: u = angle / 2π); a line's
// or arc's own ends are its anchors exactly, never a trig round trip
function at(g: CurveGeom, u: number): Vec2 {
  if (g.kind !== 'circle') { if (u === 0) return g.a!; if (u === 1) return g.b! }
  return pointAt(g, g.kind === 'circle' ? u * TAU : u)
}
const dst = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y)

/** Two leaving directions closer than this (radians) count as equal, and the
 *  turn order falls back to curvature. Solver residuals at a tangent touch
 *  leave the directions ~1e-12 apart; a real corner is far wider. */
const ANG_EPS = 1e-6
// a leaving direction in [0, 2π), with a hair under 2π read as 0 so the
// comparison has no wrap-around seam
function canonAngle(a: number): number {
  const n = norm(a)
  return n >= TAU - ANG_EPS ? 0 : n
}
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

/** A tangent touch between pieces i and j at q, and each piece's parameter there. */
interface Touch { q: Vec2; i: number; j: number; ui: number; uj: number }
interface Splits { params: number[][]; touches: Touch[] }

function buildGraph(srcs: Src[], splits: Splits, bridges: { from: Vec2; to: Vec2 }[], tol: number): Graph {
  const { params, touches } = splits
  // each piece's touch parameters (they win a run over a plain crossing)
  const touchU: Set<number>[] = srcs.map(() => new Set())
  for (const t of touches) { touchU[t.i]!.add(t.ui); touchU[t.j]!.add(t.uj) }
  const vertices: Vec2[] = []
  const grid = new Map<string, number[]>()
  const cell = (x: number) => Math.floor(x / tol)
  // the vertex within rad of p (nearest), or -1; never adds one
  function nearVertex(p: Vec2, rad: number): number {
    const cx = cell(p.x), cy = cell(p.y), n = Math.ceil(rad / tol)
    let best = -1, bd = rad
    for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) {
      for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        const d = dst(vertices[i]!, p)
        if (d <= bd) { bd = d; best = i }
      }
    }
    return best
  }
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
      const ang = canonAngle(e.kind === 'line' ? Math.atan2(e.p1.y - e.p0.y, e.p1.x - e.p0.x) : e.a0! + (e.sweep! > 0 ? Math.PI / 2 : -Math.PI / 2))
      const k = e.kind === 'line' ? 0 : Math.sign(e.sweep!) / e.r!
      halfEdges.push({ ...e, from: f, to: t, ang, k, len: 0 })
    }
    halfEdges[h]!.len = halfEdges[h + 1]!.len = edgeLen(halfEdges[h]!)
    return h
  }
  // the drawing's own anchors are the vertices' positions wherever a
  // computed point (a crossing, a touch) lands within tol of one
  for (const s of srcs) if (s.g.kind !== 'circle') { vid(s.g.a!); vid(s.g.b!) }
  srcs.forEach((s, i) => {
    const g = s.g
    const list: number[] = []
    // parameters sorted; a run of points closer than tol is one point — the
    // piece's own end if the run holds it, else the run's middle (two
    // near-tangent crossings stand for the one touch between them)
    const ps = [...params[i]!].sort((x, y) => x - y)
    const uniq: number[] = []
    let run: number[] = []
    let runPt: Vec2 | null = null
    const flush = () => {
      if (!run.length) return
      // the piece's own end, else a tangent touch (so the piece leaves the
      // vertex in its true tangent direction), else the run's middle
      const own = g.kind !== 'circle' ? run.find(u => u === 0 || u === 1) : undefined
      const touch = run.find(u => touchU[i]!.has(u))
      uniq.push(own ?? touch ?? (run.length === 1 ? run[0]! : (run[0]! + run[run.length - 1]!) / 2))
      run = []
    }
    for (const u of ps) {
      const q = at(g, u)
      if (runPt && dst(q, runPt) > tol) flush()
      run.push(u)
      runPt = q
    }
    flush()
    if (g.kind === 'circle') {
      if (uniq.length > 1) {
        const first = uniq[0]!, last = uniq[uniq.length - 1]!
        if (dst(at(g, first), at(g, last)) <= tol) {
          // the run wraps past angle 0: one point — a touch if it holds one, else midway
          let mid = touchU[i]!.has(first) ? first : touchU[i]!.has(last) ? last : (last + first + 1) / 2
          if (mid >= 1) mid -= 1
          uniq.pop(); uniq[0] = mid
          uniq.sort((x, y) => x - y)
        }
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
  // every half-edge ends exactly on its vertices (the outline and the polygon
  // close on the drawing's own points, not on trig noise)
  for (const h of halfEdges) { h.p0 = vertices[h.from]!; h.p1 = vertices[h.to]! }
  // at a tangent touch the two pieces leave in the same direction, but a
  // piece that ENDS there does so a slide s along from the true touch point
  // (tangency is second order: a residual ε leaves s ≈ √(2rε)), so its own
  // direction is off by up to s / r. Pieces detected tangent at this vertex
  // take one shared direction wherever theirs agree within that bound, and
  // the turn order below falls back to curvature — the true order.
  for (const t of touches) {
    const v = nearVertex(t.q, 2 * tol)
    if (v < 0) continue
    const rMin = Math.min(srcs[t.i]!.g.r ?? Infinity, srcs[t.j]!.g.r ?? Infinity)
    const lim = Math.min(0.5, (4 * tol) / rMin + ANG_EPS)
    const at_v = halfEdges.map((_, h) => h).filter(h => halfEdges[h]!.from === v)
    const A = at_v.filter(h => halfEdges[h]!.piece === t.i), B = at_v.filter(h => halfEdges[h]!.piece === t.j)
    for (const b of B) {
      const hb = halfEdges[b]!
      let best = -1, bd = lim
      for (const a of A) {
        const dd = Math.abs(halfEdges[a]!.ang - hb.ang), w = Math.min(dd, TAU - dd)
        if (w < bd) { bd = w; best = a }
      }
      if (best < 0) continue
      const ha = halfEdges[best]!
      // keep a line's direction (exact); otherwise the first piece's
      if (hb.kind === 'line' && ha.kind !== 'line') ha.ang = hb.ang
      else hb.ang = ha.ang
    }
  }
  // outgoing half-edges round each vertex, counter-clockwise; at an equal
  // leaving direction (within ANG_EPS) the one turning right comes first
  const out: number[][] = vertices.map(() => [])
  halfEdges.forEach((h, i) => out[h.from]!.push(i))
  for (const list of out) {
    list.sort((i, j) => {
      const a = halfEdges[i]!, b = halfEdges[j]!
      const d = a.ang - b.ang
      return Math.abs(d) >= ANG_EPS ? d : a.k - b.k || i - j
    })
  }
  return { vertices, halfEdges, pieceEdges, out }
}

// ── crossings and touches ───────────────────────────────────────────────────

/** Two pieces within the weld tolerance of tangency — a line and a circle or
 *  arc (|distance from the centre to the line − r| ≤ tol), two circles or arcs
 *  touching outside (|d − (r1 + r2)| ≤ tol) or inside (|d − |r1 − r2|| ≤ tol).
 *  If they miss, or cross at two points no more than tol from their middle,
 *  that is ONE touch, placed midway across the solver's residual (`touch`).
 *  If they overlap by a hair yet cross further apart than tol (a line end slid
 *  along a circle — tangency is second order in the slide), it is two real
 *  crossings, computed here (`cross`) because crossings.ts' absolute
 *  thresholds read such a pair as one tangent point, or as a miss. Only
 *  points both pieces actually reach count. null when not near tangency. */
function nearTangent(g1: CurveGeom, g2: CurveGeom, tol: number): { touch: Vec2 } | { cross: Vec2[] } | null {
  if (g1.kind === 'line' && g2.kind === 'line') return null
  let q: Vec2, h2: number, mid: Vec2, dir: Vec2
  if (g1.kind === 'line' || g2.kind === 'line') {
    const L = g1.kind === 'line' ? g1 : g2, C = g1.kind === 'line' ? g2 : g1
    const a = L.a!, b = L.b!, c = C.c!, r = C.r!
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy
    if (L2 < 1e-24) return null
    const t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / L2
    const foot = { x: a.x + t * dx, y: a.y + t * dy }
    const dc = dst(foot, c)
    if (dc < 1e-12 || Math.abs(dc - r) > tol) return null
    const m = (r + dc) / 2 / dc
    q = { x: c.x + (foot.x - c.x) * m, y: c.y + (foot.y - c.y) * m }
    h2 = r * r - dc * dc
    mid = foot
    const len = Math.sqrt(L2)
    dir = { x: dx / len, y: dy / len }
  } else {
    const c1 = g1.c!, r1 = g1.r!, c2 = g2.c!, r2 = g2.r!
    const d = dst(c1, c2)
    if (d <= tol) return null   // concentric: no single touch
    const ux = (c2.x - c1.x) / d, uy = (c2.y - c1.y) / d
    let s: number
    if (Math.abs(d - (r1 + r2)) <= tol) s = (r1 + d - r2) / 2              // outside: between c1 + r1·u and c2 − r2·u
    else if (Math.abs(d - Math.abs(r1 - r2)) <= tol) s = r1 >= r2 ? (r1 + d + r2) / 2 : (-r1 + d - r2) / 2   // inside
    else return null
    q = { x: c1.x + ux * s, y: c1.y + uy * s }
    const a = (d * d + r1 * r1 - r2 * r2) / (2 * d)
    h2 = r1 * r1 - a * a
    mid = { x: c1.x + ux * a, y: c1.y + uy * a }
    dir = { x: -uy, y: ux }
  }
  const reaches = (p: Vec2, lim: number) => dst(at(g1, paramNear(g1, p)), p) <= lim && dst(at(g2, paramNear(g2, p)), p) <= lim
  if (h2 <= tol * tol) return reaches(q, tol) ? { touch: q } : null   // reached within the weld distance, so the touch and the piece's end weld into one vertex
  const h = Math.sqrt(h2)
  const cross = [{ x: mid.x - dir.x * h, y: mid.y - dir.y * h }, { x: mid.x + dir.x * h, y: mid.y + dir.y * h }].filter(p => reaches(p, tol))
  return { cross }
}

function splitParams(srcs: Src[], tol: number): Splits {
  const params = srcs.map(s => (s.g.kind === 'circle' ? [] : [0, 1]))
  const touches: Touch[] = []
  for (let i = 0; i < srcs.length; i++) {
    for (let j = i + 1; j < srcs.length; j++) {
      const A = srcs[i]!, B = srcs[j]!
      if (!boxesMeet(A.box, B.box, tol)) continue
      const nt = nearTangent(A.g, B.g, tol)
      if (nt && 'touch' in nt) {
        // a tangent touch is ONE split point on each piece, whatever the
        // float maths made of it (a miss, or two crossings a hair apart)
        const tp = nt.touch, ui = paramNear(A.g, tp), uj = paramNear(B.g, tp)
        params[i]!.push(ui)
        params[j]!.push(uj)
        touches.push({ q: tp, i, j, ui, uj })
        continue
      }
      if (nt) {
        for (const p of nt.cross) { params[i]!.push(paramNear(A.g, p)); params[j]!.push(paramNear(B.g, p)) }
        continue
      }
      for (const ip of intersectCurves(A.g, B.g)) {
        params[i]!.push(A.g.kind === 'circle' ? norm(ip.tSelf) / TAU : ip.tSelf)
        params[j]!.push(B.g.kind === 'circle' ? norm(ip.tOther) / TAU : ip.tOther)
      }
    }
  }
  // an end that touches another piece (a trimmed end pinned onto it, a
  // T-junction the float maths just missed) splits that piece there
  // — except an end that is only near a piece because the two converge on a
  // tangent touch elsewhere (an arc or line running on past the touch and
  // ending just off the curve): the touch is their one contact
  const ends: { p: Vec2; of: number }[] = []
  srcs.forEach((s, k) => { if (s.g.kind !== 'circle') ends.push({ p: s.g.a!, of: k }, { p: s.g.b!, of: k }) })
  const touchAt = new Map<string, Vec2[]>()
  for (const t of touches) {
    const key = t.i < t.j ? `${t.i}|${t.j}` : `${t.j}|${t.i}`
    const list = touchAt.get(key)
    if (list) list.push(t.q); else touchAt.set(key, [t.q])
  }
  for (let i = 0; i < srcs.length; i++) {
    const s = srcs[i]!
    for (const { p: e, of } of ends) {
      if (!boxHit(s.box, e, tol)) continue
      const qs = touchAt.get(i < of ? `${i}|${of}` : `${of}|${i}`)
      if (qs && qs.every(q => dst(q, e) > tol)) continue
      const u = paramNear(s.g, e)
      const q = at(s.g, u)
      if (Math.hypot(q.x - e.x, q.y - e.y) <= tol) params[i]!.push(u)
    }
  }
  return { params, touches }
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
      // the other end of a piece no longer than the gap (a bridge would only
      // double it back); a longer piece — a C nearly closed — does bridge
      if (w === own.to && deg[w] === 1 && own.len <= gap) return
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
  const crosses = (A: Vec2, B: Vec2): boolean => {
    const seg: CurveGeom = { ref: { kind: 'line', id: '' }, kind: 'line', a: A, b: B }
    const box = boxOf([A, B])
    const inside = (p: Vec2) => dst(p, A) > tol && dst(p, B) > tol
    for (const s of srcs) {
      if (!boxesMeet(box, s.box, tol)) continue
      if (intersectCurves(seg, s.g).some(ip => inside(ip.p))) return true
    }
    for (const b of bridges) {
      const other: CurveGeom = { ref: { kind: 'line', id: '' }, kind: 'line', a: b.from, b: b.to }
      if (intersectCurves(seg, other).some(ip => inside(ip.p))) return true
    }
    return false
  }
  for (const c of cands) {
    if (used.has(c.v) || (c.end != null && used.has(c.end))) continue
    // a bridge never crosses a piece or another bridge
    if (crosses(V[c.v]!, c.to)) continue
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
  for (let i = 1; i < n; i++) {
    const a = h.a0! + (h.sweep! * i) / n
    pts.push({ x: h.c!.x + h.r! * Math.cos(a), y: h.c!.y + h.r! * Math.sin(a) })
  }
  pts.push(h.p1)
}

// ½∮(x dy − y dx) along one half-edge, exact for arcs. An arc's own ends can
// sit up to the weld tolerance off its vertices (a touch parameter, a
// clustered crossing), so the stretch from each vertex to the arc is counted
// as a straight hair: the cycle's area is then that of one closed outline.
function areaPart(h: HalfEdge): number {
  const cr = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x
  if (h.kind === 'line') return 0.5 * cr(h.p0, h.p1)
  const { x: cx, y: cy } = h.c!, r = h.r!, f0 = h.a0!, f1 = h.a0! + h.sweep!
  const s0 = { x: cx + r * Math.cos(f0), y: cy + r * Math.sin(f0) }, s1 = { x: cx + r * Math.cos(f1), y: cy + r * Math.sin(f1) }
  return 0.5 * (r * r * h.sweep! + r * (cx * (Math.sin(f1) - Math.sin(f0)) - cy * (Math.cos(f1) - Math.cos(f0))) + cr(h.p0, s0) + cr(s1, h.p1))
}

/** Every area the drawing encloses. `gap`: bridge ends that stop at most this
 *  far (drawing units) short of another piece. */
export function findFaces(doc: SketchDoc, opts: { gap?: number } = {}): FaceSet {
  const srcs = collectPieces(doc)
  const tol = weldTol(srcs)
  const splits = splitParams(srcs, tol)
  const { params } = splits
  let gr = buildGraph(srcs, splits, [], tol)
  let bridges: { from: Vec2; to: Vec2 }[] = []
  const gap = opts.gap ?? 0
  if (gap > tol) {
    const found = findBridges(srcs, gr, gap, tol)
    if (found.bridges.length) {
      for (const p of found.params) params[p.piece]!.push(p.u)
      bridges = found.bridges
      gr = buildGraph(srcs, splits, bridges, tol)
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
  // a component inside another's face is a hole of the smallest such face —
  // smallest by its GROSS outer area (a face's net area shrinks as holes are
  // assigned, so comparing net areas would pick an outer ring over the face
  // directly round the drawing); holes are subtracted once all are placed
  for (const [comp, oi] of outerOfComp) {
    const oc = cycles[oi]!
    const e0 = halfEdges[oc.edges[0]!]!
    const probe = e0.kind === 'line' ? { x: (e0.p0.x + e0.p1.x) / 2, y: (e0.p0.y + e0.p1.y) / 2 } : at({ kind: 'circle', c: e0.c!, r: e0.r! } as CurveGeom, norm(e0.a0! + e0.sweep! / 2) / TAU)
    let best: number | null = null
    faces.forEach((f, fi) => {
      if (cycles[f.outer]!.comp === comp || !boxHit(f.box, probe)) return
      if (winding(cycles[f.outer]!.poly, probe) === 0) return
      if (best == null || cycles[f.outer]!.area < cycles[faces[best]!.outer]!.area) best = fi
    })
    if (best != null) {
      faces[best]!.holes.push(oi)
      faceOfCycle[oi] = best
    }
  }
  for (const f of faces) for (const h of f.holes) f.area += Math.min(0, cycles[h]!.area)
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
    // smallest by gross outer area (see the hole nesting in findFaces)
    if (best == null || fs.cycles[f.outer]!.area < fs.cycles[fs.faces[best]!.outer]!.area) best = i
  })
  return best
}

/** The face a half-edge's left side belongs to (null = the open plane). */
export function faceOfHalfEdge(fs: FaceSet, h: number): number | null {
  return fs.faceOfCycle[fs.cycleOf[h]!] ?? null
}

// ── outlines ────────────────────────────────────────────────────────────────


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
  // a coordinate within a millionth of the weld tolerance of zero is zero
  // (cos π/2 and friends); -0 prints as 0
  const zero = fs.tol * 1e-6 * Math.abs(s)
  const num = (n: number) => (Math.abs(n) <= zero ? 0 : n)
  const P = (p: Vec2) => `${num(p.x * s)} ${num(p.y * s)}`
  let d = `M ${P(fs.halfEdges[edges[0]!]!.p0)}`
  for (const e of edges) {
    const h = fs.halfEdges[e]!
    if (h.kind === 'line') { d += ` L ${P(h.p1)}`; continue }
    const r = num(h.r! * s), sw = h.sweep! > 0 ? 1 : 0
    if (Math.abs(h.sweep!) >= TAU - 1e-9) {
      // a full turn is two halves: to the far side, then back onto the vertex
      const a = h.a0! + h.sweep! / 2
      const mid = { x: h.c!.x + h.r! * Math.cos(a), y: h.c!.y + h.r! * Math.sin(a) }
      d += ` A ${r} ${r} 0 0 ${sw} ${P(mid)} A ${r} ${r} 0 0 ${sw} ${P(h.p1)}`
    }
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

// everything faces depend on (pieces, their points, radii, guide flags) —
// never the fills — written out exactly (a JS number prints back to the same
// number), so two drawings share a key only when their geometry is equal: a
// rotated or mirrored copy can never be served the original's faces. A frame
// where nothing moved is a hit.
export function geometryKey(doc: SketchDoc): string {
  const parts: string[] = []
  for (const e of doc.entities) {
    const g = e.construction ? 'g' : ''
    if (e.kind === 'point') parts.push(`p${g}|${e.id}|${e.x}|${e.y}`)
    else if (e.kind === 'line') parts.push(`l${g}|${e.id}|${e.p1}|${e.p2}`)
    else if (e.kind === 'circle') parts.push(`c${g}|${e.id}|${e.center}|${e.r}`)
    else {
      let t = `w${g}|${e.id}|${e.closed ? 1 : 0}|${e.anchors.join(',')}|`
      for (const s of e.segments) t += s.kind === 'arc' ? `a${s.center}:${s.sweep},` : s.kind === 'line' ? 'l,' : 'b,'
      parts.push(t)
    }
  }
  return parts.join(';')
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
