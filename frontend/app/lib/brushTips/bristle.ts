// Bristle tip replay: pointer samples → smoothed points with speed → a tapered ribbon
// (TRIANGLE_STRIP). Ported from the prototype's buildRibbon; Frame units throughout.
import { REF_W } from './tips'
import { decodePts, type Sample, type TipStroke } from './record'

export const RIBBON_STRIDE = 7
interface P { x: number; y: number; w: number; sp: number }
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-9))); return t * t * (3 - 2 * t) }
const widthFor = (size: number, speed: number, thin: number) => size * (1 + (0.2 - 0.87 * smooth(0.15, 2.2, speed)) * thin)

export function bristlePoints(samples: Sample[], size: number, S: Record<string, number>): P[] {
  if (!samples.length) return []
  const first = samples[0]!
  const lazy = { x: first.x * REF_W, y: first.y * REF_W }
  let lastRaw = { x: lazy.x, y: lazy.y, t: first.t }, speed = 0
  const out: P[] = [{ x: lazy.x, y: lazy.y, w: 0, sp: 0 }]
  const R = 3 * (S.smoothing ?? 1)
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!, p = { x: s.x * REF_W, y: s.y * REF_W }
    const dt = Math.max(1, s.t - lastRaw.t)
    speed += (Math.hypot(p.x - lastRaw.x, p.y - lastRaw.y) / dt - speed) * 0.25
    lastRaw = { ...p, t: s.t }
    const dx = p.x - lazy.x, dy = p.y - lazy.y, L = Math.hypot(dx, dy)
    if (L <= R) continue
    lazy.x += dx * (L - R) / L; lazy.y += dy * (L - R) / L
    const last = out[out.length - 1]!
    if (Math.hypot(lazy.x - last.x, lazy.y - last.y) >= 1.5) out.push({ x: lazy.x, y: lazy.y, w: 0, sp: speed })
  }
  return out
}

function resample(P: P[]): P[] {
  if (P.length < 3) return P
  const out: P[] = []
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)]!, p1 = P[i]!, p2 = P[i + 1]!, p3 = P[Math.min(P.length - 1, i + 2)]!
    const n = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 4))
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t
      const cr = (a: number, b: number, c: number, d: number) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push({ x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y), w: p1.w + (p2.w - p1.w) * t, sp: p1.sp + (p2.sp - p1.sp) * t })
    }
  }
  out.push(P[P.length - 1]!)
  return out
}
function evenSpacing(P: P[], step: number): P[] {
  if (P.length < 2) return P
  const out: P[] = [P[0]!]
  let carry = 0
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1]!, b = P[i]!, L = Math.hypot(b.x - a.x, b.y - a.y)
    let d = step - carry
    while (d <= L) {
      const t = d / L
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, sp: a.sp + (b.sp - a.sp) * t })
      d += step
    }
    carry = L - (d - step)
  }
  const last = P[P.length - 1]!, tail = out[out.length - 1]!
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > 0.5) out.push(last)
  return out
}
function roundCorners(P: P[], k: number): P[] {
  const n = P.length
  if (k < 1 || n < 3) return P
  let cur = P
  for (let pass = 0; pass < 2; pass++) {
    const next: P[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const r = Math.min(k, i, n - 1 - i)
      let sx = 0, sy = 0
      for (let j = i - r; j <= i + r; j++) { sx += cur[j]!.x; sy += cur[j]!.y }
      const c = 2 * r + 1
      next[i] = { ...cur[i]!, x: sx / c, y: sy / c }
    }
    cur = next
  }
  return cur
}

export function bristleRibbon(stroke: TipStroke, done: boolean): Float32Array | null {
  const S = stroke.settings, size = stroke.size * REF_W, thin = S.thin ?? 1
  const raw = bristlePoints(decodePts(stroke.pts), size, S)
  let wv = widthFor(size, 0, thin)
  const pts = raw.map(q => { wv += (widthFor(size, q.sp, thin) - wv) * 0.14; return { ...q, w: wv } })
  const STEP = 2, sm = S.smoothing ?? 1
  const P = roundCorners(evenSpacing(resample(pts), STEP), Math.round(Math.min(25, size * 0.2 * sm) / STEP)), n = P.length
  if (n < 2) return null
  const tw = Math.max(1, Math.round(Math.max(2, size * 0.18 * sm) / STEP))
  const s = new Float32Array(n)
  for (let i = 1; i < n; i++) s[i] = s[i - 1]! + Math.hypot(P[i]!.x - P[i - 1]!.x, P[i]!.y - P[i - 1]!.y)
  const total = s[n - 1]!
  const ws = P.map(p => p.w)
  for (let pass = 0; pass < 3; pass++) for (let i = 1; i < n - 1; i++) ws[i] = (ws[i - 1]! + ws[i]! * 2 + ws[i + 1]!) / 4
  const TP = Math.max(0.001, S.taper ?? 1)
  const tIn = Math.min(size * 1.6 * TP, total * 0.35 * Math.min(1, TP))
  const tOut = (done ? Math.min(size * 3 * TP, total * 0.45 * Math.min(1, TP)) : Math.min(size * 0.5 * TP, total * 0.15)) || 0.001
  const data = new Float32Array(n * 2 * RIBBON_STRIDE)
  let o = 0
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - tw)]!, b = P[Math.min(n - 1, i + tw)]!
    let tx = b.x - a.x, ty = b.y - a.y; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l
    const ti = smooth(0, tIn, s[i]!), to = smooth(0, tOut, total - s[i]!)
    const half = ws[i]! * (0.05 + 0.95 * Math.min(ti, to)) / 2
    const loadT = s[i]! / (size * 26)
    for (const side of [-1, 1]) {
      data[o++] = P[i]!.x - ty * half * side; data[o++] = P[i]!.y + tx * half * side
      data[o++] = s[i]!; data[o++] = side; data[o++] = ws[i]!; data[o++] = loadT; data[o++] = P[i]!.sp
    }
  }
  return data
}
