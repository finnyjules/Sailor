// Hold to snap: fit a held stroke (client px) to a line, arc, ellipse/circle or a shape with
// corners; adjust it while held; draw it as dense points. Ported from the prototype
// (docs/superpowers/specs/assets/2026-09-26-brush-steady-prototype.html: fitShape, shapePts, editSnap).
import type { Pt, TPt } from './steady'

export type Shape =
  | { kind: 'line'; A: Pt; B: Pt }
  | { kind: 'arc'; A: Pt; M: Pt; B: Pt }
  | { kind: 'ellipse' | 'circle'; cx: number; cy: number; a: number; b: number; th: number; phase: number; dir: 1 | -1 }
  | { kind: 'shape'; V: Pt[]; closed: boolean; cx: number; cy: number }

export function evenPts(P: Pt[], step: number): Pt[] {
  const out: Pt[] = [{ x: P[0]!.x, y: P[0]!.y }]; let carry = 0
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1]!, b = P[i]!, L = Math.hypot(b.x - a.x, b.y - a.y); let d = step - carry
    while (d <= L) { const t = d / L; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); d += step }
    carry = L - (d - step)
  }
  const last = P[P.length - 1]!, o = out[out.length - 1]!
  if (Math.hypot(last.x - o.x, last.y - o.y) > 0.5) out.push({ x: last.x, y: last.y })
  return out
}
const plen = (P: Pt[]) => { let L = 0; for (let i = 1; i < P.length; i++) L += Math.hypot(P[i]!.x - P[i - 1]!.x, P[i]!.y - P[i - 1]!.y); return L }
function circ(a: Pt, b: Pt, c: Pt): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-6) return null
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
  return { x, y, r: Math.hypot(a.x - x, a.y - y) }
}
function rdp(P: Pt[], eps: number): Pt[] {
  if (P.length < 3) return P.slice()
  const a = P[0]!, b = P[P.length - 1]!, L = Math.hypot(b.x - a.x, b.y - a.y) || 1
  let mi = 0, md = 0
  for (let i = 1; i < P.length - 1; i++) { const d = Math.abs((b.x - a.x) * (a.y - P[i]!.y) - (a.x - P[i]!.x) * (b.y - a.y)) / L; if (d > md) { md = d; mi = i } }
  if (md <= eps) return [a, b]
  return rdp(P.slice(0, mi + 1), eps).slice(0, -1).concat(rdp(P.slice(mi), eps))
}
/** A simplified polyline counts as a shape only when it has real corners: at every interior
 *  vertex (closed: the wrap-around vertex V[0] == V[last] too) the drawn path turns by more than
 *  CORNER rad. The turn is measured on the drawn path Q a short way either side of the vertex, not
 *  along the simplified edges, so a smooth curve (whose coarse simplification always looks bent)
 *  has no corners. Without real corners the stroke stays as drawn. */
const CORNER = 0.6, CORNER_REACH = 5 // samples of Q (3 px apart) either side of a vertex
function dirAng(a: Pt, b: Pt) { return Math.atan2(b.y - a.y, b.x - a.x) }
function angDiff(a: number, b: number) { const t = b - a; return Math.abs(Math.atan2(Math.sin(t), Math.cos(t))) }
function hasRealCorners(Q: Pt[], V: Pt[], closed: boolean): boolean {
  const n = Q.length, idx = V.map(v => Q.indexOf(v)) // rdp keeps Q's point objects; a closed V's copied last point is -1
  for (let i = 1; i < V.length - 1; i++) {
    const j = idx[i]!, prev = idx[i - 1]!, next = idx[i + 1]! >= 0 ? idx[i + 1]! : n - 1
    if (j < 0 || prev < 0) return false
    const k = Math.max(1, Math.min(CORNER_REACH, Math.floor((j - prev) / 2), Math.floor((next - j) / 2)))
    if (angDiff(dirAng(Q[j - k]!, Q[j]!), dirAng(Q[j]!, Q[j + k]!)) <= CORNER) return false
  }
  if (closed) { // wrap-around: the way the pen arrived at the end against the way it set off
    const k = Math.max(1, Math.min(CORNER_REACH, Math.floor(n / 4)))
    if (angDiff(dirAng(Q[n - 1 - k]!, Q[n - 1]!), dirAng(Q[0]!, Q[k]!)) <= CORNER) return false
  }
  return true
}

export function fitShape(raw: Pt[]): Shape | null {
  if (raw.length < 2) return null
  const Q = evenPts(raw, 3), n = Q.length
  if (n < 4) return null
  const Lp = plen(Q), A = Q[0]!, B = Q[n - 1]!, chord = Math.hypot(B.x - A.x, B.y - A.y)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const q of Q) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y) }
  const diag = Math.hypot(x1 - x0, y1 - y0)
  if (Lp > 80 && chord < Math.max(24, 0.2 * Lp)) {
    let cx = 0, cy = 0; for (const q of Q) { cx += q.x; cy += q.y } cx /= n; cy /= n
    let sxx = 0, syy = 0, sxy = 0; for (const q of Q) { const dx = q.x - cx, dy = q.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy }
    const th = 0.5 * Math.atan2(2 * sxy / n, (sxx - syy) / n), c = Math.cos(th), s = Math.sin(th)
    let va = 0, vb = 0; for (const q of Q) { const dx = q.x - cx, dy = q.y - cy, u = dx * c + dy * s, v = -dx * s + dy * c; va += u * u; vb += v * v }
    const a = Math.sqrt(2 * va / n), b = Math.sqrt(2 * vb / n)
    let res = 0, area = 0
    for (let i = 0; i < n; i++) {
      const q = Q[i]!, dx = q.x - cx, dy = q.y - cy, u = dx * c + dy * s, v = -dx * s + dy * c
      res += Math.abs(1 - Math.hypot(u / a, v / b)); const q2 = Q[(i + 1) % n]!; area += q.x * q2.y - q2.x * q.y
    }
    res /= n
    if (res < 0.11) {
      const du = (A.x - cx) * c + (A.y - cy) * s, dv = -(A.x - cx) * s + (A.y - cy) * c
      return { kind: a / b < 1.12 ? 'circle' : 'ellipse', cx, cy, a, b, th, phase: Math.atan2(dv / b, du / a), dir: area >= 0 ? 1 : -1 }
    }
    const V = rdp(Q, Math.max(6, 0.06 * diag)); V[V.length - 1] = { ...V[0]! }
    return V.length >= 4 && hasRealCorners(Q, V, true) ? { kind: 'shape', V, closed: true, cx, cy } : null
  }
  if (chord < 20) return null
  let md = 0; for (const q of Q) md = Math.max(md, Math.abs((B.x - A.x) * (A.y - q.y) - (A.x - q.x) * (B.y - A.y)) / chord)
  if (md / chord < 0.06) return { kind: 'line', A: { ...A }, B: { ...B } }
  let acc = 0, M = Q[Math.floor(n / 2)]!
  for (let i = 1; i < n; i++) { acc += Math.hypot(Q[i]!.x - Q[i - 1]!.x, Q[i]!.y - Q[i - 1]!.y); if (acc >= Lp / 2) { M = Q[i]!; break } }
  const C = circ(A, M, B)
  if (C && C.r < 8 * chord) {
    let res = 0; for (const q of Q) res += Math.abs(Math.hypot(q.x - C.x, q.y - C.y) - C.r); res /= n * C.r
    if (res < 0.07) return { kind: 'arc', A: { ...A }, M: { ...M }, B: { ...B } }
  }
  const V = rdp(Q, Math.max(6, 0.06 * diag))
  if (V.length <= 2) return { kind: 'line', A: { ...A }, B: { ...B } }
  return hasRealCorners(Q, V, false) ? { kind: 'shape', V, closed: false, cx: 0, cy: 0 } : null
}

export function adjustShape(base: Shape, c0: Pt, cur: Pt, shift: boolean): Shape {
  const sh = structuredClone(base) as Shape, d = { x: cur.x - c0.x, y: cur.y - c0.y }
  if (sh.kind === 'line') {
    sh.B = { x: sh.B.x + d.x, y: sh.B.y + d.y }
    if (shift) {
      const L = Math.hypot(sh.B.x - sh.A.x, sh.B.y - sh.A.y), a = Math.round(Math.atan2(sh.B.y - sh.A.y, sh.B.x - sh.A.x) / (Math.PI / 12)) * Math.PI / 12
      sh.B = { x: sh.A.x + Math.cos(a) * L, y: sh.A.y + Math.sin(a) * L }
    }
  } else if (sh.kind === 'arc') {
    sh.B = { x: sh.B.x + d.x, y: sh.B.y + d.y }; sh.M = { x: sh.M.x + d.x / 2, y: sh.M.y + d.y / 2 }
  } else if (sh.kind === 'shape' && !sh.closed) {
    const L = sh.V[sh.V.length - 1]!; sh.V[sh.V.length - 1] = { x: L.x + d.x, y: L.y + d.y }
  } else {
    const v0 = { x: c0.x - sh.cx, y: c0.y - sh.cy }, v1 = { x: cur.x - sh.cx, y: cur.y - sh.cy }
    const k = Math.hypot(v1.x, v1.y) / Math.max(10, Math.hypot(v0.x, v0.y)), rot = Math.atan2(v1.y, v1.x) - Math.atan2(v0.y, v0.x)
    if (sh.kind === 'shape') {
      const c = Math.cos(rot), s = Math.sin(rot)
      sh.V = sh.V.map(p => { const x = (p.x - sh.cx) * k, y = (p.y - sh.cy) * k; return { x: sh.cx + x * c - y * s, y: sh.cy + x * s + y * c } })
    } else { sh.a *= k; sh.b *= k; sh.th += rot }
  }
  return sh
}

export function shapePoints(sh: Shape, shift: boolean): Pt[] {
  if (sh.kind === 'line') return evenPts([sh.A, sh.B], 2)
  if (sh.kind === 'arc') {
    const C = circ(sh.A, sh.M, sh.B); if (!C) return evenPts([sh.A, sh.B], 2)
    const ang = (p: Pt) => Math.atan2(p.y - C.y, p.x - C.x)
    const norm = (x: number) => { const T = 2 * Math.PI; return ((x % T) + T) % T }
    const a0 = ang(sh.A); let sweep = norm(ang(sh.B) - a0); if (norm(ang(sh.M) - a0) > sweep) sweep -= 2 * Math.PI
    const N = Math.max(8, Math.ceil(Math.abs(sweep) * C.r / 2)), out: Pt[] = []
    for (let i = 0; i <= N; i++) { const a = a0 + sweep * i / N; out.push({ x: C.x + Math.cos(a) * C.r, y: C.y + Math.sin(a) * C.r }) }
    return out
  }
  if (sh.kind === 'shape') return evenPts(sh.V, 2)
  let a = sh.a, b = sh.b; if (sh.kind === 'circle' || shift) a = b = (sh.a + sh.b) / 2
  const c = Math.cos(sh.th), s = Math.sin(sh.th), N = Math.max(24, Math.ceil(2 * Math.PI * Math.max(a, b) / 2)), out: Pt[] = []
  for (let i = 0; i <= N; i++) { const t = sh.phase + sh.dir * 2 * Math.PI * 1.03 * i / N, u = Math.cos(t) * a, v = Math.sin(t) * b; out.push({ x: sh.cx + u * c - v * s, y: sh.cy + u * s + v * c }) }
  return out
}

export function shapeLabel(sh: Shape, shift: boolean): 'Line' | 'Arc' | 'Ellipse' | 'Circle' | 'Shape' {
  if (sh.kind === 'ellipse') return shift ? 'Circle' : 'Ellipse'
  return ({ line: 'Line', arc: 'Arc', circle: 'Circle', shape: 'Shape' } as const)[sh.kind]
}

/** Median sample-to-sample speed in px/ms (0.4 when there is nothing to measure). */
export function medianSpeed(S: TPt[]): number {
  const v: number[] = []
  for (let i = 1; i < S.length; i++) { const dt = S[i]!.t - S[i - 1]!.t, d = Math.hypot(S[i]!.x - S[i - 1]!.x, S[i]!.y - S[i - 1]!.y); if (dt > 0 && d > 0) v.push(d / dt) }
  if (!v.length) return 0.4
  v.sort((a, b) => a - b); return v[Math.floor(v.length / 2)]!
}
/** The shape's points, timed as if drawn at an even `speed` (px/ms), t from 0. */
export function timedSamples(P: Pt[], speed: number): TPt[] {
  const out: TPt[] = []; let t = 0
  for (let i = 0; i < P.length; i++) { if (i) t += Math.hypot(P[i]!.x - P[i - 1]!.x, P[i]!.y - P[i - 1]!.y) / Math.max(1e-3, speed); out.push({ x: P[i]!.x, y: P[i]!.y, t }) }
  return out
}
