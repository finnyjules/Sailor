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
 * inputs share the same command skeleton, `blendPath` skips all of that and
 * interpolates control points directly, so curves stay curves.
 */
import { formatNumber } from './svg'

export type Pt = [number, number]
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
        if (cur) { cur.closed = true; cx = sx; cy = sy }
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
function arcToCubics(x0: number, y0: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x: number, y: number): number[][] {
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
  const out: number[][] = []
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
