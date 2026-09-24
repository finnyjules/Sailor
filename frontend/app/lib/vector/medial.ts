/**
 * Vector — MEDIAL PINNING (centreline morph engine). PURE.
 *
 * The 2026-09-03 stroke-vector spike (`skeleton.ts`) rebuilt a letter FROM its
 * centreline — union of disks over a 96–192 grid — and the round trip was
 * lumpy by construction. This spike never rebuilds. It keeps the real outline
 * and PINS every outline sample to the centreline:
 *
 *   p = m + r·u
 *
 * where m is the sample's inner pole (the centre of the largest empty disk
 * touching p from the ink side — a point on the medial axis), r that disk's
 * radius (half the stroke thickness there) and u the unit direction m → p.
 * Because p lies ON the disk, the identity holds exactly: at rest there is no
 * reconstruction error to measure, and corners and flat cuts stay as drawn.
 *
 * Poles come from a Delaunay triangulation of dense boundary samples: the
 * circumcentres of triangles lying inside the ink are Voronoi vertices of the
 * samples, which converge on the medial axis as sampling densifies (Amenta's
 * poles). No grid anywhere.
 *
 * What the pinning is FOR: correspondence and measurement. Two fonts' samples
 * pair by where they sit on the letter (`pairGlyphs`), and interpolating
 * (m, r, u) keeps a stroke's thickness while it turns (`evalPair`). Each
 * sample's stroke half-width `w` is what a weight change reads.
 *
 * What it is NOT for: reshaping. Moving points toward the centreline to thin a
 * letter made edges inherit the centreline's bends (Julien, 2026-09-23: "doesn't
 * respect the straight lines, the curves or the geometry"). Weight is a
 * parallel offset of the real outline — see `weightGlyph`.
 *
 * Coordinates: whatever space the caller hands in (the lab uses canvas px).
 *
 * Consumers: /dev/morph-lab and the Frame Morph transition (lib/vector/morphPieces.ts).
 */
import type { PathCommand } from '~/lib/vectortype/outline'

export type P = [number, number]

export interface PinnedContour {
  /** Closed ring of samples (first point not repeated at the end). */
  pts: P[]
  hole: boolean
  /** Signed area (shoelace). */
  area: number
  centroid: P
  /** Inner pole per sample — the ink-side medial point. */
  m: P[]
  /** Pole radius per sample (half the stroke thickness there). */
  r: number[]
  /** Unit m → p per sample; the ink's outward normal. */
  u: P[]
  /** Pole on the side this contour BOUNDS (its own region): for an outer
   *  contour that is the ink (= m/r); for a hole, the counter. Collapsing a
   *  contour onto these is how an unmatched contour deflates to nothing. */
  cm: P[]
  cr: number[]
  /** Stroke half-width at each sample: the trimmed-centreline disk it is
   *  pinned to (so a corner reports its stem's width, not ~0). A MEASURE —
   *  weight changes read it to keep hairlines alive; they never move along it. */
  w: number[]
  /** Radius of the largest empty disk touching each sample from the INK side
   *  (its inner pole) and from the OUTSIDE (exterior or counter; Infinity on
   *  the convex hull). An offset of up to that distance cannot fold over. */
  pr: number[]
  or: number[]
}

export interface MedialEdge { a: P; b: P; ra: number; rb: number }

export interface PinnedGlyph {
  contours: PinnedContour[]
  /** The trimmed medial-axis edges, for drawing the centreline. */
  axis: MedialEdge[]
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
  /** Largest |m + r·u − p| over all samples; ~1e-12 unless something is wrong. */
  restError: number
  /** Samples that found no inner pole (fell back to r = 0). */
  orphans: number
}

// ── Geometry helpers ────────────────────────────────────────────────────────

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]]
const len = (a: P) => Math.hypot(a[0], a[1])
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerpP = (a: P, b: P, t: number): P => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]

function signedArea(poly: P[]): number {
  let s = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!
    s += a[0] * b[1] - b[0] * a[1]
  }
  return s / 2
}

function centroidOf(poly: P[]): P {
  let x = 0, y = 0
  for (const p of poly) { x += p[0]; y += p[1] }
  return [x / poly.length, y / poly.length]
}

function insidePoly(pt: P, poly: P[]): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c
  }
  return c
}

/** Even-odd over every contour — ink iff inside an odd number of rings. */
function insideInk(pt: P, rings: P[][]): boolean {
  let c = false
  for (const r of rings) if (insidePoly(pt, r)) c = !c
  return c
}

// ── Flatten + resample ──────────────────────────────────────────────────────

/** fontkit commands → closed polylines, after mapping each point through `tf`. */
export function flattenCommands(cmds: readonly PathCommand[], tf: (x: number, y: number) => P, steps = 16): P[][] {
  const out: P[][] = []
  let cur: P[] | null = null
  let x = 0, y = 0, sx = 0, sy = 0
  const push = (px: number, py: number) => {
    if (!cur) { cur = [tf(sx, sy)] }
    cur.push(tf(px, py))
  }
  const end = () => {
    if (cur && cur.length > 2) out.push(cur)
    cur = null
  }
  for (const c of cmds) {
    const a = c.args
    switch (c.command) {
      case 'moveTo':
        end(); x = sx = a[0]!; y = sy = a[1]!; cur = [tf(x, y)]; break
      case 'lineTo':
        push(a[0]!, a[1]!); x = a[0]!; y = a[1]!; break
      case 'quadraticCurveTo':
        for (let i = 1; i <= steps; i++) {
          const t = i / steps, mt = 1 - t
          push(mt * mt * x + 2 * mt * t * a[0]! + t * t * a[2]!, mt * mt * y + 2 * mt * t * a[1]! + t * t * a[3]!)
        }
        x = a[2]!; y = a[3]!; break
      case 'bezierCurveTo':
        for (let i = 1; i <= steps; i++) {
          const t = i / steps, mt = 1 - t
          const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t
          push(b0 * x + b1 * a[0]! + b2 * a[2]! + b3 * a[4]!, b0 * y + b1 * a[1]! + b2 * a[3]! + b3 * a[5]!)
        }
        x = a[4]!; y = a[5]!; break
      case 'closePath':
        end(); x = sx; y = sy; break
    }
  }
  end()
  // Drop a repeated closing point and zero-length steps.
  return out.map((poly) => {
    const q: P[] = []
    for (const p of poly) {
      const last = q[q.length - 1]
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) q.push(p)
    }
    if (q.length > 1 && Math.hypot(q[0]![0] - q[q.length - 1]![0], q[0]![1] - q[q.length - 1]![1]) < 1e-9) q.pop()
    return q
  }).filter(q => q.length > 2)
}

/**
 * Resample a closed ring at spacing ≈ `h`, KEEPING corners (turns sharper than
 * `cornerDeg`) as exact samples — uniform resampling would shave every corner
 * by up to h, which is exactly the softening this spike exists to avoid.
 */
export function resampleRing(poly: P[], h: number, cornerDeg = 30): P[] {
  const n = poly.length
  const cosLimit = Math.cos((cornerDeg * Math.PI) / 180)
  const corners: number[] = []
  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n]!, b = poly[i]!, c = poly[(i + 1) % n]!
    const d1 = sub(b, a), d2 = sub(c, b)
    const l1 = len(d1), l2 = len(d2)
    if (l1 < 1e-9 || l2 < 1e-9) continue
    if ((d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2) < cosLimit) corners.push(i)
  }
  if (!corners.length) corners.push(0)
  const out: P[] = []
  for (let ci = 0; ci < corners.length; ci++) {
    const from = corners[ci]!, to = corners[(ci + 1) % corners.length]!
    // The piece from corner `from` round to corner `to` (the whole ring if one corner).
    const piece: P[] = [poly[from]!]
    let k = from
    do { k = (k + 1) % n; piece.push(poly[k]!) } while (k !== to)
    const cum = [0]
    for (let i = 1; i < piece.length; i++) cum.push(cum[i - 1]! + len(sub(piece[i]!, piece[i - 1]!)))
    const L = cum[cum.length - 1]!
    const segs = Math.max(1, Math.round(L / h))
    let j = 0
    for (let s = 0; s < segs; s++) {
      const target = (s / segs) * L
      while (j < piece.length - 2 && cum[j + 1]! < target) j++
      const span = cum[j + 1]! - cum[j]!
      const t = span > 0 ? (target - cum[j]!) / span : 0
      out.push(lerpP(piece[j]!, piece[j + 1]!, t))
    }
  }
  return out
}

// ── Delaunay (Bowyer–Watson, naive — a few hundred points per glyph) ────────

interface Tri { a: number; b: number; c: number; cx: number; cy: number; r2: number }

function circum(pts: P[], a: number, b: number, c: number): Tri {
  const [ax, ay] = pts[a]!, [bx, by] = pts[b]!, [cx, cy] = pts[c]!
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-12) return { a, b, c, cx: 0, cy: 0, r2: Infinity }
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  return { a, b, c, cx: ux, cy: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 }
}

/** Triangles over `pts` (indices), super-triangle removed. */
export function delaunay(input: P[]): [number, number, number][] {
  const n = input.length
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of input) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  const span = Math.max(maxX - minX, maxY - minY) || 1
  // A tiny deterministic jitter breaks the co-circular ties that uniform
  // sampling of straight edges and arcs produces by the hundred.
  const pts: P[] = input.map(([x, y], i) => {
    const h1 = Math.sin(i * 12.9898 + 78.233) * 43758.5453
    const h2 = Math.sin(i * 39.3468 + 11.135) * 23421.6313
    return [x + (h1 - Math.floor(h1) - 0.5) * span * 1e-7, y + (h2 - Math.floor(h2) - 0.5) * span * 1e-7]
  })
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2
  pts.push([mx - 20 * span, my - span], [mx, my + 20 * span], [mx + 20 * span, my - span])
  let tris: Tri[] = [circum(pts, n, n + 1, n + 2)]
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i]!
    const bad: Tri[] = [], keep: Tri[] = []
    for (const t of tris) ((px - t.cx) ** 2 + (py - t.cy) ** 2 < t.r2 ? bad : keep).push(t)
    const edges = new Map<number, [number, number, number]>()
    const K = n + 3
    for (const t of bad) {
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
        const key = Math.min(u, v) * K + Math.max(u, v)
        const e = edges.get(key)
        if (e) e[2]++
        else edges.set(key, [u, v, 1])
      }
    }
    for (const [u, v, count] of edges.values()) if (count === 1) keep.push(circum(pts, u, v, i))
    tris = keep
  }
  return tris.filter(t => t.a < n && t.b < n && t.c < n).map(t => [t.a, t.b, t.c])
}

// ── Pinning ─────────────────────────────────────────────────────────────────

export interface PinOptions {
  /** Sample spacing, in the caller's units. */
  h: number
  /** A leaf branch whose disks all stay within `spur ×` the disk where it
   *  joins is a corner spur, not a stroke, and is trimmed. 0 keeps all. */
  spur?: number
  /** 'axis': pin each sample to the nearest disk on the TRIMMED centreline
   *  (corners ride their stroke). 'pole': its own inner pole (corners pin to
   *  their spur, so they never move when strokes thin). */
  pin?: 'axis' | 'pole'
}

/**
 * Trim the corner and serif spurs every sharp outline turn grows. A leaf chain
 * is a spur when every disk along it stays inside the junction's disk scaled by
 * `spur` — max(|c − c_junction| + r) < spur·R_junction. A corner tapers into
 * its point (a square corner reaches √2·R), while a real leg or stem keeps its
 * thickness and runs well past. A bare length test cannot tell the two apart
 * in a heavy face, where legs are short next to the junction radius.
 * Repeated passes: trimming exposes the next generation of spurs.
 */
function pruneAxis(nodes: Map<number, { c: P; r: number; nb: Set<number> }>, spur: number): void {
  if (spur <= 0) return
  for (let pass = 0; pass < 4; pass++) {
    // Find every short leaf chain on the graph AS IT IS, then remove them all
    // together — removing one fork first would demote its junction to a chain
    // node and let the sibling fork pass as part of the stem.
    const doomed: number[][] = []
    for (const [id, node] of nodes) {
      if (node.nb.size !== 1) continue
      const chain = [id]
      let prev = -1, cur = id
      for (;;) {
        const n = nodes.get(cur)!
        const next = [...n.nb].find(x => x !== prev)
        if (next === undefined) break
        const nn = nodes.get(next)!
        if (nn.nb.size !== 2) { cur = next; break }
        chain.push(next); prev = cur; cur = next
      }
      const end = nodes.get(cur)!
      if (end.nb.size < 3) continue // a lone stroke, not a spur
      let reach = 0
      for (const k of chain) { const n = nodes.get(k)!; reach = Math.max(reach, len(sub(n.c, end.c)) + n.r) }
      if (reach < spur * end.r) doomed.push(chain)
    }
    if (!doomed.length) break
    for (const chain of doomed) for (const k of chain) {
      const n = nodes.get(k)
      if (!n) continue
      for (const nb of n.nb) nodes.get(nb)?.nb.delete(k)
      nodes.delete(k)
    }
  }
}

export function pinGlyph(rings: P[][], opts: PinOptions): PinnedGlyph {
  const h = opts.h
  const rs = rings.map(r => resampleRing(r, h)).filter(r => r.length >= 3)
  const all: P[] = []
  const owner: number[] = []
  const offs: number[] = []
  rs.forEach((r, ri) => { offs.push(all.length); for (const p of r) { all.push(p); owner.push(ri) } })

  // Hole = inside an odd number of OTHER rings (winding conventions differ
  // between TrueType and CFF, so nesting is the only reliable test).
  const holes = rs.map((r, ri) => {
    let c = false
    for (let k = 0; k < rs.length; k++) if (k !== ri && insidePoly(r[0]!, rs[k]!)) c = !c
    return c
  })

  const tris = delaunay(all)
  const centres: { c: P; r: number; ink: boolean; region: number }[] = tris.map(([a, b, c]) => {
    const t = circum(all, a, b, c)
    const cc: P = [t.cx, t.cy]
    const ink = Number.isFinite(t.r2) && insideInk(cc, rs)
    // Which hole's counter this centre sits in, if any (for collapsing holes).
    let region = -1
    if (!ink && Number.isFinite(t.r2)) {
      for (let k = 0; k < rs.length; k++) if (holes[k] && insidePoly(cc, rs[k]!)) { region = k; break }
    }
    return { c: cc, r: Math.sqrt(t.r2), ink, region }
  })

  // Medial graph: the dual of the triangulation restricted to ink — every
  // pair of ink triangles sharing an edge. That graph is connected (a tree per
  // simply-connected part, one loop per counter); the near-boundary Voronoi
  // "hair" appears as very short leaf branches, which the spur trim removes
  // along with the corner forks.
  const byEdge = new Map<number, number>()
  const nodes = new Map<number, { c: P; r: number; nb: Set<number> }>()
  const node = (ti: number) => {
    let n = nodes.get(ti)
    if (!n) { n = { c: centres[ti]!.c, r: centres[ti]!.r, nb: new Set() }; nodes.set(ti, n) }
    return n
  }
  const N = all.length
  tris.forEach(([a, b, c], ti) => {
    if (!centres[ti]!.ink) return
    node(ti)
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const key = Math.min(p, q) * N + Math.max(p, q)
      const other = byEdge.get(key)
      if (other === undefined) { byEdge.set(key, ti); continue }
      if (!centres[other]!.ink) continue
      node(ti).nb.add(other); node(other).nb.add(ti)
    }
  })
  pruneAxis(nodes, opts.spur ?? 1.5)
  const axis: MedialEdge[] = []
  for (const [id, n] of nodes) for (const nb of n.nb) if (nb > id) { const o = nodes.get(nb)!; axis.push({ a: n.c, b: o.c, ra: n.r, rb: o.r }) }

  /** The trimmed-axis point whose disk comes nearest to touching p:
   *  minimise |p − c(s)| − r(s) along every edge. */
  const nearestOnAxis = (p: P): { c: P; r: number } | null => {
    let best: { c: P; r: number } | null = null, bestD = Infinity
    for (const e of axis) {
      const ab = sub(e.b, e.a), ap = sub(p, e.a)
      const L2 = ab[0] * ab[0] + ab[1] * ab[1]
      const s = L2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1]) / L2)) : 0
      const c = lerpP(e.a, e.b, s), r = lerp(e.ra, e.rb, s)
      const d = len(sub(p, c)) - r
      if (d < bestD) { bestD = d; best = { c, r } }
    }
    return best
  }

  // Per sample: its incident triangles.
  const incident: number[][] = all.map(() => [])
  tris.forEach(([a, b, c], ti) => { incident[a]!.push(ti); incident[b]!.push(ti); incident[c]!.push(ti) })
  const pinMode = opts.pin ?? 'axis'

  let restError = 0, orphans = 0
  const contours: PinnedContour[] = rs.map((ring, ri) => {
    const m: P[] = [], r: number[] = [], u: P[] = [], cm: P[] = [], cr: number[] = [], w: number[] = [], pr: number[] = [], or: number[] = []
    const area = signedArea(ring)
    ring.forEach((p, k) => {
      const gi = offs[ri]! + k
      let best = -1, bestR = -1, bestOwn = -1, bestOwnR = -1, outR = -1
      for (const ti of incident[gi]!) {
        const ce = centres[ti]!
        if (ce.ink && ce.r > bestR) { best = ti; bestR = ce.r }
        if (!ce.ink && Number.isFinite(ce.r) && ce.r > outR) outR = ce.r
        if (holes[ri] && ce.region === ri && ce.r > bestOwnR) { bestOwn = ti; bestOwnR = ce.r }
      }
      pr.push(Math.max(0, bestR)); or.push(outR < 0 ? Infinity : outR)
      const onAxis = pinMode === 'axis' ? nearestOnAxis(p) : null
      const anchor: P | null = onAxis ? onAxis.c : best >= 0 ? centres[best]!.c : null
      if (!anchor) {
        orphans++
        // No ink-side pole (a stroke thinner than the sampling). Pin to itself,
        // facing along the ring's outward normal; r = 0 keeps p exact.
        const a = ring[(k - 1 + ring.length) % ring.length]!, b = ring[(k + 1) % ring.length]!
        const tn = sub(b, a); const l = len(tn) || 1
        const sgn = (area > 0 ? 1 : -1) * (holes[ri] ? -1 : 1)
        m.push([p[0], p[1]]); r.push(0); w.push(0); u.push([(tn[1] / l) * sgn, (-tn[0] / l) * sgn])
      } else {
        // r is |p − m| whichever anchor was chosen, so p = m + r·u is exact.
        const d = sub(p, anchor); const rr = len(d)
        m.push(anchor); r.push(rr); w.push(onAxis ? onAxis.r : rr); u.push(rr > 0 ? [d[0] / rr, d[1] / rr] : [0, 0])
        restError = Math.max(restError, len(sub([anchor[0] + rr * u[u.length - 1]![0], anchor[1] + rr * u[u.length - 1]![1]], p)))
      }
      if (holes[ri]) {
        if (bestOwn >= 0) { const c = centres[bestOwn]!.c; cm.push(c); cr.push(len(sub(p, c))) }
        else { const c = centroidOf(ring); cm.push(c); cr.push(len(sub(p, c))) }
      } else {
        cm.push(m[m.length - 1]!); cr.push(r[r.length - 1]!)
      }
    })
    return { pts: ring, hole: holes[ri]!, area, centroid: centroidOf(ring), m, r, u, cm, cr, w, pr, or }
  })

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of all) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  return { contours, axis, bbox: { minX, minY, maxX, maxY }, restError, orphans }
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** The dominant stroke half-width of a set of glyphs — the median of every
 *  sample's `w`. Thickness dials are expressed against this. */
export function stemHalfWidth(glyphs: PinnedGlyph[]): number {
  const ws: number[] = []
  for (const g of glyphs) for (const c of g.contours) for (const w of c.w) if (w > 0) ws.push(w)
  ws.sort((a, b) => a - b)
  return ws.length ? ws[Math.floor(ws.length / 2)]! : 0
}

// ── Merging a glyph's overlapping pieces ────────────────────────────────────

/**
 * Script and brush faces draw a letter as OVERLAPPING pieces (a loop laid
 * over a stem). Filled nonzero that is one shape; tested even-odd — as the
 * pole finder and hole test must — the overlaps read as holes, which is where
 * the script slivers came from. Resolve them into clean non-overlapping rings
 * with paper.js (passed in: it touches browser globals at import, so the
 * caller loads it lazily, as extrudeSolid.ts does).
 */
export function unionRings(paper: any, rings: P[][]): P[][] {
  if (!rings.length) return rings
  const scope = new paper.PaperScope()
  scope.setup(new scope.Size(1, 1))
  const compound = new scope.CompoundPath({
    children: rings.map(r => new scope.Path({ segments: r.map(p => new scope.Point(p[0], p[1])), closed: true, insert: false })),
    fillRule: 'nonzero',
    insert: false,
  })
  let out: any = compound.resolveCrossings().reorient(true, true)
  const parts: any[] = out.className === 'CompoundPath' ? out.children : [out]
  const res: P[][] = parts
    .map((pt: any) => (pt.segments as any[]).map(sg => [sg.point.x, sg.point.y] as P))
    .filter((r: P[]) => r.length > 2)
  scope.project?.remove?.()
  return res.length ? res : rings
}

// ── Pairing two glyphs (same letter, two fonts) ─────────────────────────────

export interface ContourPair {
  a: PinnedContour | null
  b: PinnedContour | null
  /** Sample-index pairs (i in a, j in b) along the correspondence path. */
  path: [number, number][]
  /** An unmatched contour rides on a matched one: `pair` is that pair's index
   *  in the glyph's list, `idx[i]` the carrier path step nearest sample i. */
  carrier?: { pair: number; idx: number[] }
}

export interface PairOptions {
  /** Cost weights: outline position, pole position, normal direction. */
  wPos?: number
  wPole?: number
  wNormal?: number
  /** Extra cost for a stall step (one side advancing alone). */
  stall?: number
}

function norm(p: P, bb: PinnedGlyph['bbox']): P {
  const w = bb.maxX - bb.minX || 1, hh = bb.maxY - bb.minY || 1
  return [(p[0] - bb.minX) / w, (p[1] - bb.minY) / hh]
}

/** Contours matched outer↔outer and hole↔hole by normalised centroid,
 *  greedily nearest-first; leftovers pair with null (they will collapse). */
function matchContours(A: PinnedGlyph, B: PinnedGlyph): [PinnedContour | null, PinnedContour | null][] {
  const out: [PinnedContour | null, PinnedContour | null][] = []
  for (const hole of [false, true]) {
    const as = A.contours.filter(c => c.hole === hole)
    const bs = B.contours.filter(c => c.hole === hole)
    const cand: { i: number; j: number; d: number }[] = []
    as.forEach((a, i) => bs.forEach((b, j) => {
      const d = len(sub(norm(a.centroid, A.bbox), norm(b.centroid, B.bbox)))
      // Prefer similar size too: a dot should not pair with a bowl.
      const sa = Math.abs(a.area) / ((A.bbox.maxX - A.bbox.minX) * (A.bbox.maxY - A.bbox.minY) || 1)
      const sb = Math.abs(b.area) / ((B.bbox.maxX - B.bbox.minX) * (B.bbox.maxY - B.bbox.minY) || 1)
      cand.push({ i, j, d: d + Math.abs(Math.log((sa + 1e-4) / (sb + 1e-4))) * 0.25 })
    }))
    cand.sort((x, y) => x.d - y.d)
    const ua = new Set<number>(), ub = new Set<number>()
    for (const { i, j, d } of cand) {
      if (ua.has(i) || ub.has(j) || d > 0.6) continue
      ua.add(i); ub.add(j); out.push([as[i]!, bs[j]!])
    }
    as.forEach((a, i) => { if (!ua.has(i)) out.push([a, null]) })
    bs.forEach((b, j) => { if (!ub.has(j)) out.push([null, b]) })
  }
  return out
}

function reversed(c: PinnedContour): PinnedContour {
  const rev = <T>(xs: T[]) => xs.slice().reverse()
  return { ...c, pts: rev(c.pts), m: rev(c.m), r: rev(c.r), u: rev(c.u), cm: rev(c.cm), cr: rev(c.cr), w: rev(c.w), pr: rev(c.pr), or: rev(c.or), area: -c.area }
}

function rotated(c: PinnedContour, s: number): PinnedContour {
  const rot = <T>(xs: T[]) => xs.slice(s).concat(xs.slice(0, s))
  return { ...c, pts: rot(c.pts), m: rot(c.m), r: rot(c.r), u: rot(c.u), cm: rot(c.cm), cr: rot(c.cr), w: rot(c.w), pr: rot(c.pr), or: rot(c.or) }
}

/**
 * Structural correspondence between two contours: cyclic DTW over per-sample
 * features — where the sample is, where its POLE is (both normalised to the
 * glyph box), and which way it faces. The pole term is what "pairing by the
 * centreline" means: a sample on the left of the stem in A finds the left of
 * the stem in B even when the two outlines spend their length differently
 * (a brush terminal vs a flat cut).
 */
function correspond(a: PinnedContour, b: PinnedContour, A: PinnedGlyph, B: PinnedGlyph, o: Required<PairOptions>): { b: PinnedContour; path: [number, number][] } {
  if (Math.sign(a.area) !== Math.sign(b.area)) b = reversed(b)
  const na = a.pts.length, nb = b.pts.length
  const fa = a.pts.map((p, i) => ({ p: norm(p, A.bbox), m: norm(a.m[i]!, A.bbox), u: a.u[i]! }))
  const fb0 = b.pts.map((p, i) => ({ p: norm(p, B.bbox), m: norm(b.m[i]!, B.bbox), u: b.u[i]! }))
  const cost = (x: typeof fa[number], y: typeof fa[number]) =>
    o.wPos * ((x.p[0] - y.p[0]) ** 2 + (x.p[1] - y.p[1]) ** 2)
    + o.wPole * ((x.m[0] - y.m[0]) ** 2 + (x.m[1] - y.m[1]) ** 2)
    + o.wNormal * (1 - (x.u[0] * y.u[0] + x.u[1] * y.u[1])) / 2

  // Best cyclic start for B under a uniform index map.
  let bestS = 0, bestC = Infinity
  for (let s = 0; s < nb; s++) {
    let c = 0
    for (let i = 0; i < na; i += 2) c += cost(fa[i]!, fb0[(Math.floor((i * nb) / na) + s) % nb]!)
    if (c < bestC) { bestC = c; bestS = s }
  }
  b = rotated(b, bestS)
  const fb = fb0.slice(bestS).concat(fb0.slice(0, bestS))

  // DTW (1,0) (0,1) (1,1); stalls carry a small penalty so the path prefers
  // advancing both sides together unless the structure says otherwise.
  const D = new Float64Array(na * nb).fill(Infinity)
  const idx = (i: number, j: number) => i * nb + j
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nb; j++) {
      const c = cost(fa[i]!, fb[j]!)
      if (i === 0 && j === 0) { D[0] = c; continue }
      let m = Infinity
      if (i > 0 && j > 0) m = D[idx(i - 1, j - 1)]!
      if (i > 0) m = Math.min(m, D[idx(i - 1, j)]! + o.stall)
      if (j > 0) m = Math.min(m, D[idx(i, j - 1)]! + o.stall)
      D[idx(i, j)] = c + m
    }
  }
  const path: [number, number][] = []
  let i = na - 1, j = nb - 1
  path.push([i, j])
  while (i > 0 || j > 0) {
    if (i === 0) j--
    else if (j === 0) i--
    else {
      const d = D[idx(i - 1, j - 1)]!, l = D[idx(i - 1, j)]! + o.stall, u = D[idx(i, j - 1)]! + o.stall
      if (d <= l && d <= u) { i--; j-- } else if (l <= u) i--
      else j--
    }
    path.push([i, j])
  }
  path.reverse()
  return { b, path }
}

export function pairGlyphs(A: PinnedGlyph, B: PinnedGlyph, opts: PairOptions = {}): ContourPair[] {
  const o: Required<PairOptions> = { wPos: 1, wPole: 1, wNormal: 0.15, stall: 0.0005, ...opts }
  const pairs: ContourPair[] = matchContours(A, B).map(([a, b]) => {
    if (a && b) { const r = correspond(a, b, A, B, o); return { a, b: r.b, path: r.path } }
    const c = (a ?? b)!
    return { a, b, path: c.pts.map((_, i) => [i, i] as [number, number]) }
  })
  // Give every unmatched contour a carrier: the matched OUTER contour from its
  // own font that encloses it (else the nearest), so it moves with the letter
  // while it shuts instead of shrinking in place as the letter slides away.
  pairs.forEach((pr) => {
    if (pr.a && pr.b) return
    const c = (pr.a ?? pr.b)!, side = pr.a ? 0 : 1
    let best = -1, bestD = Infinity
    pairs.forEach((q, qi) => {
      if (!q.a || !q.b) return
      const src = side === 0 ? q.a : q.b
      if (src.hole) return
      let d = insidePoly(c.centroid, src.pts) ? 0 : Infinity
      if (d) for (const p of src.pts) d = Math.min(d, len(sub(p, c.centroid)))
      if (d < bestD) { bestD = d; best = qi }
    })
    if (best < 0) return
    const q = pairs[best]!, src = side === 0 ? q.a! : q.b!
    pr.carrier = {
      pair: best,
      idx: c.pts.map((p) => {
        let bk = 0, bd = Infinity
        q.path.forEach((st, k) => { const d = len(sub(src.pts[st[side]]!, p)); if (d < bd) { bd = d; bk = k } })
        return bk
      }),
    }
  })
  return pairs
}

// ── Evaluating a pair at t ──────────────────────────────────────────────────

function slerpDir(u: P, v: P, t: number): P {
  const a0 = Math.atan2(u[1], u[0])
  let d = Math.atan2(v[1], v[0]) - a0
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  const a = a0 + d * t
  return [Math.cos(a), Math.sin(a)]
}

/**
 * The ring at `t` (0 = A, 1 = B).
 *  - `linear`: pair points slide in straight lines (structural pairing only).
 *  - `medial`: pole, radius and facing interpolate separately — a stroke keeps
 *    its thickness while it turns.
 * An unmatched contour (a counter only one font has) shrinks to its centre
 * point, shut in the first half of the morph or opened in the second.
 */
export function evalPair(pair: ContourPair, t: number, mode: 'linear' | 'medial', smooth = 6): P[] {
  const { a, b, path } = pair
  if (a && b) {
    const lin = path.map(([i, j]) => lerpP(a.pts[i]!, b.pts[j]!, t))
    if (mode === 'linear') return lin
    // The medial answer as a CORRECTION to the straight slide. Neighbouring
    // samples can pin to different stretches of the centreline (a flat foot in
    // one font, a round one in the other), so the raw medial points jitter;
    // the correction itself is low-frequency (keep this stroke's thickness
    // while it turns) and is exactly zero at t = 0 and 1, so smoothing it
    // along the ring removes the jitter without touching either font at rest.
    const n = lin.length
    const dx = new Float64Array(n), dy = new Float64Array(n)
    path.forEach(([i, j], k) => {
      const m = lerpP(a.m[i]!, b.m[j]!, t)
      const r = lerp(a.r[i]!, b.r[j]!, t)
      const u = slerpDir(a.u[i]!, b.u[j]!, t)
      // Paired samples facing near-opposite ways (a script loop against a
      // straight stem) have no meaningful rotation between them — the slerp
      // picks a side and turns the outline inside out. Fade the correction to
      // nothing there, leaving the straight slide.
      const agree = smoothstep(-0.3, 0.3, a.u[i]![0] * b.u[j]![0] + a.u[i]![1] * b.u[j]![1])
      dx[k] = (m[0] + r * u[0] - lin[k]![0]) * agree
      dy[k] = (m[1] + r * u[1] - lin[k]![1]) * agree
    })
    for (let pass = 0; pass < 2 && smooth > 0; pass++) {
      for (const d of [dx, dy]) {
        const src = d.slice()
        for (let k = 0; k < n; k++) {
          let s = 0
          for (let o = -smooth; o <= smooth; o++) s += src[(k + o + n) % n]!
          d[k] = s / (2 * smooth + 1)
        }
      }
    }
    return lin.map((p, k) => [p[0] + dx[k]!, p[1] + dy[k]!])
  }
  // Unmatched: see `evalGlyph`, which knows the carrier's motion. Alone, it
  // shrinks in place.
  return collapse(pair, t, null)
}

function collapse(pair: ContourPair, t: number, carried: P[] | null): P[] {
  const { a, b } = pair
  const c = (a ?? b)!
  // How far toward shut. A counter only one font has (Pacifico's looped `l`
  // → a plain `l`) shuts in the FIRST half of a morph and a new one opens in
  // the SECOND: closing across the whole morph left a half-shut slit at the
  // midpoint that read as a stray tick.
  const k = smoothstep(0, 0.5, a ? t : 1 - t)
  // Each sample rides with the carrier point nearest it; the point it shrinks
  // to rides with their average, so the counter sinks INTO the letter.
  // Collapsing onto the counter's own centreline was tried: just before it
  // shuts it becomes a slit that reads as a stray line — hence a point.
  let mx = 0, my = 0
  if (carried) { for (const d of carried) { mx += d[0]; my += d[1] } mx /= carried.length; my /= carried.length }
  const centre: P = [c.centroid[0] + mx, c.centroid[1] + my]
  return c.pts.map((p, i) => {
    const d = carried ? carried[i]! : [0, 0]
    return lerpP([p[0] + d[0], p[1] + d[1]], centre, k)
  })
}

/** Every contour of a glyph at `t`: matched pairs first, then each unmatched
 *  contour carried by the motion of its carrier's nearest points. */
export function evalGlyph(pairs: ContourPair[], t: number, mode: 'linear' | 'medial', smooth = 6): P[][] {
  const done: (P[] | null)[] = pairs.map(pr => (pr.a && pr.b ? evalPair(pr, t, mode, smooth) : null))
  return pairs.map((pr, pi) => {
    if (done[pi]) return done[pi]!
    const car = pr.carrier
    if (!car || !done[car.pair]) return collapse(pr, t, null)
    const q = pairs[car.pair]!, side = pr.a ? 0 : 1, src = side === 0 ? q.a! : q.b!
    const moved = done[car.pair]!
    return collapse(pr, t, car.idx.map((k) => {
      const from = src.pts[q.path[k]![side]]!, to = moved[k]!
      return [to[0] - from[0], to[1] - from[1]] as P
    }))
  })
}
