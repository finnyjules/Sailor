/**
 * Path morphing — the steps between two outlines (the Illustrator Blend tool).
 *
 * Pure: no paper.js, no DOM, no three, no studio imports. Two consumers: Shape
 * Studio's Blend layout (phase one) and the Frame's Blend layer (phase two), so
 * this lives beside `svg.ts` rather than under `geoshape/`.
 *
 * Pipeline: `parsePathD` → `Subpath[]` (lines + cubics; quadratics and arcs are
 * converted) → `flattenSubpath` → closed polyline → `resample` to K evenly spaced
 * points → `alignCorrespondence` (winding + best start + twist) → lerp. When both
 * inputs share the same command skeleton AND no twist is asked for, `prepareBlend`
 * skips all of that and interpolates control points directly, so curves stay curves.
 *
 * `prepareBlend(dA, dB, opts)` does that whole set-up ONCE and returns a closure
 * that only lerps + serialises per `t` — a 200-step blend parses, flattens,
 * resamples and aligns one time instead of two hundred. `blendPath` is the
 * one-shot wrapper around it.
 */
import { formatNumber } from './svg'

export type Pt = [number, number]
export type ArcCubic = [number, number, number, number, number, number]
export type Seg = { kind: 'line'; to: Pt } | { kind: 'cubic'; c1: Pt; c2: Pt; to: Pt }
export interface Subpath { start: Pt; segs: Seg[]; closed: boolean }

/** Line segments per cubic when flattening. Fixed (not tolerance-based) so the
 *  same input always gives the same point count — the alignment search below
 *  depends on that determinism. */
export const CURVE_STEPS = 12

const COMMAND_CHARS = new Set(['M', 'm', 'L', 'l', 'H', 'h', 'V', 'v', 'C', 'c', 'S', 's', 'Q', 'q', 'T', 't', 'A', 'a', 'Z', 'z'])
// Sticky (not global) so `lastIndex` can be pinned to an exact scan position before each match.
const NUMBER_RE = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/y

export function parsePathD(d: string): Subpath[] {
  // Streaming lexer over `d` (not a pre-tokenised array): real-world SVG packs
  // the two arc flags and the following coordinate with no separators, e.g.
  // "A 50 50 0 0140 30" (large=0, sweep=1, x=40, y=30) — a token array built by
  // one number regex misreads "0140" as a single number.
  const n = d.length
  let i = 0
  const isSep = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ','
  const skipSep = () => { while (i < n && isSep(d[i])) i++ }
  const isNumStart = (c: string | undefined) => c === '-' || c === '.' || (c !== undefined && c >= '0' && c <= '9')
  const nextNumber = (): number => {
    skipSep()
    NUMBER_RE.lastIndex = i
    const m = NUMBER_RE.exec(d)
    if (!m) throw new Error(`morph.parsePathD: expected a number in "${d}"`)
    i = NUMBER_RE.lastIndex
    return Number(m[0])
  }
  const nextFlag = (): boolean => {
    skipSep()
    const c = d[i]
    if (c !== '0' && c !== '1') throw new Error(`morph.parsePathD: expected an arc flag (0 or 1) in "${d}"`)
    i++
    return c === '1'
  }
  const peekCommand = (): string | null => {
    skipSep()
    const c = d[i]
    return c !== undefined && COMMAND_CHARS.has(c) ? c : null
  }
  const nextCommand = (): string => {
    const c = peekCommand()
    if (!c) throw new Error(`morph.parsePathD: expected a command in "${d}"`)
    i++
    return c
  }
  const peekNumber = (): boolean => {
    skipSep()
    return isNumStart(d[i])
  }

  const subs: Subpath[] = []
  let cur: Subpath | null = null
  let cx = 0, cy = 0          // current point
  let sx = 0, sy = 0          // subpath start
  let lastC: Pt | null = null // last cubic control point (for S)
  let lastQ: Pt | null = null // last quadratic control point (for T)
  let cmd = ''
  const begin = (x: number, y: number) => {
    cur = { start: [x, y], segs: [], closed: false }
    subs.push(cur)
    sx = x; sy = y; cx = x; cy = y
  }
  const line = (x: number, y: number) => {
    if (!cur) begin(cx, cy)
    cur!.segs.push({ kind: 'line', to: [x, y] })
    cx = x; cy = y
  }
  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    if (!cur) begin(cx, cy)
    cur!.segs.push({ kind: 'cubic', c1: [x1, y1], c2: [x2, y2], to: [x, y] })
    lastC = [x2, y2]
    cx = x; cy = y
  }
  const quad = (qx: number, qy: number, x: number, y: number) => {
    // Degree elevation: a quadratic (P0, Q, P1) is the cubic with
    // c1 = P0 + 2/3 (Q − P0), c2 = P1 + 2/3 (Q − P1).
    cubic(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y)
    lastQ = [qx, qy]
    // cubic() just set lastC for its (degree-elevated) control point, but per
    // the SVG spec S only reflects a control point after C/S — never after
    // Q/T. Clear it so a following S starts from the current point instead.
    lastC = null
  }

  while (true) {
    if (peekCommand()) { cmd = nextCommand() } else if (!(cmd && peekNumber())) {
      skipSep()
      if (i >= n) break
      if (!cmd) throw new Error(`morph.parsePathD: path data must start with a command in "${d}"`)
      throw new Error(`morph.parsePathD: expected a command or number in "${d}"`)
    }
    // else: implicit repeat — reuse `cmd`, argument parsing picks up at `i`.
    const rel = cmd === cmd.toLowerCase() && cmd !== 'z' && cmd !== 'Z'
    const rx = rel ? cx : 0, ry = rel ? cy : 0
    const resetControls = () => { lastC = null; lastQ = null }
    switch (cmd.toUpperCase()) {
      case 'M': {
        const x = nextNumber() + rx, y = nextNumber() + ry
        begin(x, y)
        // Implicit repeats after M are lineTo.
        cmd = rel ? 'l' : 'L'
        resetControls()
        break
      }
      case 'L': { line(nextNumber() + rx, nextNumber() + ry); resetControls(); break }
      case 'H': { line(nextNumber() + rx, cy); resetControls(); break }
      case 'V': { line(cx, nextNumber() + ry); resetControls(); break }
      case 'C': {
        const x1 = nextNumber() + rx, y1 = nextNumber() + ry, x2 = nextNumber() + rx, y2 = nextNumber() + ry, x = nextNumber() + rx, y = nextNumber() + ry
        cubic(x1, y1, x2, y2, x, y); lastQ = null
        break
      }
      case 'S': {
        const x2 = nextNumber() + rx, y2 = nextNumber() + ry, x = nextNumber() + rx, y = nextNumber() + ry
        const x1 = lastC ? 2 * cx - lastC[0] : cx
        const y1 = lastC ? 2 * cy - lastC[1] : cy
        cubic(x1, y1, x2, y2, x, y); lastQ = null
        break
      }
      case 'Q': { const qx = nextNumber() + rx, qy = nextNumber() + ry, x = nextNumber() + rx, y = nextNumber() + ry; quad(qx, qy, x, y); break }
      case 'T': {
        const x = nextNumber() + rx, y = nextNumber() + ry
        const qx = lastQ ? 2 * cx - lastQ[0] : cx
        const qy = lastQ ? 2 * cy - lastQ[1] : cy
        quad(qx, qy, x, y)
        break
      }
      case 'A': {
        const rxA = Math.abs(nextNumber()), ryA = Math.abs(nextNumber()), rot = nextNumber()
        const large = nextFlag(), sweep = nextFlag()
        const x = nextNumber() + rx, y = nextNumber() + ry
        for (const c of arcToCubics(cx, cy, rxA, ryA, rot, large, sweep, x, y)) cubic(c[0], c[1], c[2], c[3], c[4], c[5])
        resetControls()
        break
      }
      case 'Z': {
        const open = cur as Subpath | null
        if (open) { open.closed = true; cx = sx; cy = sy }
        resetControls()
        // A Z followed by coordinates without a command is invalid SVG; stop.
        if (peekNumber()) throw new Error(`morph.parsePathD: coordinates after Z in "${d}"`)
        break
      }
      default: throw new Error(`morph.parsePathD: unsupported command "${cmd}" in "${d}"`)
    }
  }
  return subs
}

/** SVG endpoint arc → up to four cubic segments (each ≤ 90°), per the SVG
 *  implementation notes' centre-parameterisation (F.6.5). Returns
 *  [x1,y1,x2,y2,x,y] tuples. */
function arcToCubics(x0: number, y0: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x: number, y: number): ArcCubic[] {
  if (rx === 0 || ry === 0) return [[x0, y0, x, y, x, y]]
  if (x0 === x && y0 === y) return []
  const phi = (rotDeg * Math.PI) / 180
  const cosP = Math.cos(phi), sinP = Math.sin(phi)
  // Step 1: (x1', y1')
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2
  const x1p = cosP * dx + sinP * dy
  const y1p = -sinP * dx + cosP * dy
  // Correct out-of-range radii
  let rxs = rx * rx, rys = ry * ry
  const lambda = (x1p * x1p) / rxs + (y1p * y1p) / rys
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; rxs = rx * rx; rys = ry * ry }
  // Step 2: (cx', cy')
  const sign = large === sweep ? -1 : 1
  const numer = Math.max(0, rxs * rys - rxs * y1p * y1p - rys * x1p * x1p)
  const coef = sign * Math.sqrt(numer / (rxs * y1p * y1p + rys * x1p * x1p))
  const cxp = coef * ((rx * y1p) / ry)
  const cyp = coef * (-(ry * x1p) / rx)
  // Step 3: (cx, cy)
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2
  // Step 4: angles
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)))
    if (ux * vy - uy * vx < 0) a = -a
    return a
  }
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dtheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI
  else if (sweep && dtheta < 0) dtheta += 2 * Math.PI
  // Split into ≤ 90° pieces
  const n = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)))
  const delta = dtheta / n
  const k = (4 / 3) * Math.tan(delta / 4)
  const out: ArcCubic[] = []
  let th = theta1
  const point = (t: number): Pt => {
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t)
    return [cosP * ex - sinP * ey + cx, sinP * ex + cosP * ey + cy]
  }
  const deriv = (t: number): Pt => {
    const ex = -rx * Math.sin(t), ey = ry * Math.cos(t)
    return [cosP * ex - sinP * ey, sinP * ex + cosP * ey]
  }
  for (let s = 0; s < n; s++) {
    const t2 = th + delta
    const p1 = point(th), p2 = point(t2)
    const d1 = deriv(th), d2 = deriv(t2)
    out.push([p1[0] + k * d1[0], p1[1] + k * d1[1], p2[0] - k * d2[0], p2[1] - k * d2[1], p2[0], p2[1]])
    th = t2
  }
  return out
}

function cubicAt(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const mt = 1 - t
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, dd = t * t * t
  return [a * p0[0] + b * c1[0] + c * c2[0] + dd * p3[0], a * p0[1] + b * c1[1] + c * c2[1] + dd * p3[1]]
}

const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9

/** Closed polyline for a subpath. A final point equal to the start is dropped
 *  so the loop closes implicitly (the resampler treats the last→first edge as
 *  part of the perimeter). */
export function flattenSubpath(sub: Subpath): Pt[] {
  const pts: Pt[] = [sub.start]
  let cur: Pt = sub.start
  for (const s of sub.segs) {
    if (s.kind === 'line') pts.push(s.to)
    else for (let k = 1; k <= CURVE_STEPS; k++) pts.push(cubicAt(cur, s.c1, s.c2, s.to, k / CURVE_STEPS))
    cur = s.to
  }
  if (pts.length > 1 && same(pts[pts.length - 1]!, pts[0]!)) pts.pop()
  return pts
}

export function subpathsToD(subs: Subpath[], precision = 2): string {
  const f = (v: number) => formatNumber(v, precision)
  const parts: string[] = []
  for (const s of subs) {
    parts.push(`M ${f(s.start[0])} ${f(s.start[1])}`)
    for (const g of s.segs) {
      if (g.kind === 'line') parts.push(`L ${f(g.to[0])} ${f(g.to[1])}`)
      else parts.push(`C ${f(g.c1[0])} ${f(g.c1[1])} ${f(g.c2[0])} ${f(g.c2[1])} ${f(g.to[0])} ${f(g.to[1])}`)
    }
    if (s.closed) parts.push('Z')
  }
  return parts.join(' ')
}

// ── Resample / align / blend ─────────────────────────────────────────────────

/** Evenly spaced points per subpath for the resampled blend. 128 keeps a 200-step
 *  outline stack under ~350 KB of SVG while hiding the polyline at print size. */
export const BLEND_SAMPLES = 128

/** `dropCollinear` tolerance as a fraction of the blend pair's bounding diagonal. */
export const COLLINEAR_EPS_REL = 1e-6

/** Points per outline once `n` subpaths are paired, so a detailed multi-subpath
 *  library shape cannot multiply into an unbounded point count: 1–3 subpaths keep
 *  the full `BLEND_SAMPLES`, above that the budget (3 × BLEND_SAMPLES points in
 *  total) is shared out and floored at 24 so even a 25-subpath shape still reads
 *  as a shape. Exported so the cost model is testable rather than inferred. */
export function samplesForSubpaths(n: number): number {
  if (n <= 3) return BLEND_SAMPLES
  return Math.max(24, Math.min(BLEND_SAMPLES, Math.round((BLEND_SAMPLES * 3) / n)))
}

/** `k` points spaced evenly by arc length around a CLOSED polyline. */
export function resample(poly: Pt[], k: number): Pt[] {
  const n = poly.length
  if (n === 0) return []
  if (n === 1) return Array.from({ length: k }, () => [poly[0]![0], poly[0]![1]] as Pt)
  const lens: number[] = []
  let total = 0
  for (let i = 0; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!
    const l = Math.hypot(b[0] - a[0], b[1] - a[1])
    lens.push(l); total += l
  }
  if (total === 0) return Array.from({ length: k }, () => [poly[0]![0], poly[0]![1]] as Pt)
  const out: Pt[] = []
  let edge = 0, acc = 0
  for (let i = 0; i < k; i++) {
    const s = (i * total) / k
    while (edge < n - 1 && acc + lens[edge]! < s) { acc += lens[edge]!; edge++ }
    const a = poly[edge]!, b = poly[(edge + 1) % n]!
    const f = lens[edge]! > 0 ? (s - acc) / lens[edge]! : 0
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
  }
  return out
}

/** Shoelace area: positive for one winding, negative for the other. */
export function signedArea(poly: Pt[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!
    s += a[0] * b[1] - b[0] * a[1]
  }
  return s / 2
}

/**
 * Drop every point that sits on the straight line between its two neighbours
 * (perpendicular distance ≤ `eps`), treating `pts` as a closed ring.
 *
 * `resample` lays ~20 points along each hexagon edge, and lerping two
 * straight-edged outlines keeps every run straight, so a hexagon→triangle step
 * is really a ≤ 9-gon carrying 128 points. paper.js booleans (Shape Studio's
 * single fill mode) cost by point count squared per clone pair, and an
 * exclude fold keeps every ring, so those phantom points are what turned a
 * 150-step blend into a minutes-long tab freeze. Curved runs never have three
 * collinear points in a row, so they are untouched and nothing visible changes.
 * Falls back to the input when fewer than three points survive (a subpath that
 * has collapsed to a point keeps its point list).
 */
export function dropCollinear(pts: Pt[], eps: number): Pt[] {
  const n = pts.length
  if (n < 4) return pts
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n]!, c = pts[i]!, q = pts[(i + 1) % n]!
    const vx = q[0] - p[0], vy = q[1] - p[1], wx = c[0] - p[0], wy = c[1] - p[1]
    const len = Math.hypot(vx, vy)
    const dist = len > 0 ? Math.abs(vx * wy - vy * wx) / len : Math.hypot(wx, wy)
    if (dist > eps) out.push(c)
  }
  return out.length >= 3 ? out : pts
}

function centroid(poly: Pt[]): Pt {
  if (!poly.length) return [0, 0]
  let x = 0, y = 0
  for (const p of poly) { x += p[0]; y += p[1] }
  return [x / poly.length, y / poly.length]
}

/**
 * Re-order `b` so `b[i]` is the natural partner of `a[i]`:
 *  1. reverse `b` when its winding differs from `a`'s (so the blend never folds
 *     through itself),
 *  2. pick the start offset minimising the summed squared distance (O(k²);
 *     k = 128 → 16k steps, run once per render),
 *  3. add `round(twist · k)` to that offset — the user's spiral knob.
 */
export function alignCorrespondence(a: Pt[], b: Pt[], twist: number): Pt[] {
  const k = a.length
  if (k === 0 || b.length !== k) throw new Error('morph.alignCorrespondence: polylines must have equal length')
  let bb = b
  const areaA = signedArea(a), areaB = signedArea(b)
  if (areaA !== 0 && areaB !== 0 && Math.sign(areaA) !== Math.sign(areaB)) bb = [...b].reverse()
  let best = 0, bestCost = Infinity
  for (let s = 0; s < k; s++) {
    let cost = 0
    for (let i = 0; i < k; i++) {
      const p = a[i]!, q = bb[(i + s) % k]!
      const dx = p[0] - q[0], dy = p[1] - q[1]
      cost += dx * dx + dy * dy
      if (cost >= bestCost) break
    }
    if (cost < bestCost) { bestCost = cost; best = s }
  }
  const shift = (best + Math.round((twist || 0) * k)) % k
  const out: Pt[] = new Array(k)
  for (let i = 0; i < k; i++) out[i] = bb[(i + shift + k) % k]!
  return out
}

function skeleton(subs: Subpath[]): string {
  return subs.map(s => (s.closed ? 'z' : 'o') + s.segs.map(g => (g.kind === 'line' ? 'L' : 'C')).join('')).join('|')
}

const lerpPt = (p: Pt, q: Pt, t: number): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]

/**
 * Prepare a blend between `dA` and `dB` ONCE and get back the per-step function.
 *
 * Everything that does not depend on `t` — parsing, the skeleton check,
 * flattening, resampling, alignment — happens here; the returned closure only
 * lerps and serialises. Shape Studio's Blend layout calls this once and maps it
 * over its placements, so cost is O(setup + steps × points) rather than
 * O(steps × setup).
 *
 * Exact branch: identical command skeletons AND no twist → interpolate every
 * point, so a hexagon→hexagon or leaf→leaf blend keeps its curves and stays
 * small. A non-zero twist has no meaning there (there is no point
 * correspondence to rotate), so it falls through to the resampled branch, which
 * is the one that implements it.
 * Resampled branch: subpaths paired by index after sorting each side by |area|
 * (largest first); each pair is flattened, resampled to `samples`
 * (`samplesForSubpaths` by default), aligned, and lerped into an `M … L … Z`
 * polyline. A subpath with no partner pairs with ITS OWN centroid repeated, so
 * it shrinks in place to a point rather than sliding to the other shape.
 */
export function prepareBlend(dA: string, dB: string, opts: { twist?: number; samples?: number } = {}): (t: number) => string {
  const A = parsePathD(dA), B = parsePathD(dB)
  const twist = opts.twist ?? 0
  const clamp01 = (t: number) => Math.max(0, Math.min(1, t))
  if (!twist && A.length && skeleton(A) === skeleton(B)) {
    return (t: number) => {
      const tt = clamp01(t)
      const out: Subpath[] = A.map((sa, si) => {
        const sb = B[si]!
        return {
          start: lerpPt(sa.start, sb.start, tt),
          closed: sa.closed,
          segs: sa.segs.map((ga, gi) => {
            const gb = sb.segs[gi]!
            if (ga.kind === 'line' && gb.kind === 'line') return { kind: 'line' as const, to: lerpPt(ga.to, gb.to, tt) }
            const ca = ga as Extract<Seg, { kind: 'cubic' }>, cb = gb as Extract<Seg, { kind: 'cubic' }>
            return { kind: 'cubic' as const, c1: lerpPt(ca.c1, cb.c1, tt), c2: lerpPt(ca.c2, cb.c2, tt), to: lerpPt(ca.to, cb.to, tt) }
          }),
        }
      })
      return subpathsToD(out)
    }
  }
  // Flatten ONCE per subpath and carry the polyline alongside its area — the
  // sort key and the geometry are the same flattening, so computing it twice
  // (as an earlier revision did) just doubled the work.
  const byArea = (subs: Subpath[]) => subs
    .map(s => { const poly = flattenSubpath(s); return { poly, area: Math.abs(signedArea(poly)) } })
    .sort((p, q) => q.area - p.area)
    .map(x => x.poly)
  const pa = byArea(A), pb = byArea(B)
  const n = Math.max(pa.length, pb.length)
  const k = opts.samples ?? samplesForSubpaths(n)
  const pairs: { a: Pt[]; b: Pt[] }[] = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const a = pa[i], b = pb[i]
    const polyA = a ? resample(a, k) : resample([centroid(b!)], k)
    const polyBraw = b ? resample(b, k) : resample([centroid(a!)], k)
    pairs.push({ a: polyA, b: alignCorrespondence(polyA, polyBraw, twist) })
    for (const [x, y] of polyA.concat(polyBraw)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
  }
  // Collinearity tolerance scaled to the pair's extent: lerped straight runs are
  // collinear to ~1e-12 relative, so a millionth of the diagonal drops exactly
  // those and nothing a curve produced.
  const eps = COLLINEAR_EPS_REL * Math.max(1e-9, Math.hypot(maxX - minX, maxY - minY))
  return (t: number) => {
    const tt = clamp01(t)
    const out: Subpath[] = pairs.map(({ a, b }) => {
      const pts = dropCollinear(a.map((p, j) => lerpPt(p, b[j]!, tt)), eps)
      return { start: pts[0]!, segs: pts.slice(1).map(p => ({ kind: 'line' as const, to: p })), closed: true }
    })
    return subpathsToD(out)
  }
}

/**
 * The outline `t` of the way from `dA` (t = 0) to `dB` (t = 1) — the one-shot
 * form of `prepareBlend` (see it for the two branches and their rules). Blending
 * a whole stack of steps should call `prepareBlend` once instead.
 */
export function blendPath(dA: string, dB: string, t: number, opts: { twist?: number; samples?: number } = {}): string {
  return prepareBlend(dA, dB, opts)(t)
}

/** Rotate every point of `d` about the origin by `degrees` (clockwise in SVG's
 *  y-down space, matching `arrange`'s `rotate`). */
export function rotatePathD(d: string, degrees: number): string {
  if (!degrees) return d
  const r = (degrees * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  const rot = (p: Pt): Pt => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
  const subs = parsePathD(d).map(sp => ({
    start: rot(sp.start),
    closed: sp.closed,
    segs: sp.segs.map(g => g.kind === 'line' ? { kind: 'line' as const, to: rot(g.to) } : { kind: 'cubic' as const, c1: rot(g.c1), c2: rot(g.c2), to: rot(g.to) }),
  }))
  return subpathsToD(subs, 3)
}
