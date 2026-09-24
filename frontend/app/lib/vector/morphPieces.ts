/**
 * Morph pieces — the Frame Morph transition's layer over the centreline engine (`medial.ts`).
 * PURE. An outline `d` becomes PIECES (an outer ring plus the holes inside it: one per letter,
 * two for an `i`), two piece lists pair in reading order, and `prepareMorph` returns the
 * cheap per-frame evaluator. Analysing a word costs ~100–300 ms, so it runs once per pair of
 * outlines and style (small LRU), never per frame.
 * Spec: docs/superpowers/specs/2026-09-23-frame-morph-transition-design.md
 */
import { evalGlyph, pairGlyphs, pinGlyph, type P } from './medial'
import { flattenSubpath, parsePathD } from './morph'

export type MorphStyle = 'letters' | 'shape'
export interface Piece { rings: P[][]; cx: number; cy: number; h: number }
export interface PieceLink { a: number | null; b: number | null; partner?: number }

const area = (r: P[]) => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i]!, b = r[(i + 1) % r.length]!; s += a[0] * b[1] - b[0] * a[1] } return s / 2 }
const inside = (pt: P, poly: P[]) => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c
  }
  return c
}
const oriented = (r: P[], positive: boolean) => ((area(r) > 0) === positive ? r : r.slice().reverse())

export function ringsFromD(d: string): P[][] {
  if (!d || !d.trim()) return []
  let subs
  try { subs = parsePathD(d) } catch { return [] }
  return subs.map(s => flattenSubpath(s)).filter(r => r.length >= 3 && Math.abs(area(r)) > 1e-9)
}

/** Outer rings (inside an even number of others) each take the holes directly inside them.
 *  Rings are ORIENTED (outer positive, hole negative) so a nonzero fill of the morph is right
 *  whatever winding the source used. Reading order: pieces are clustered into LINES by vertical
 *  overlap (not a fixed band from a line's first centre) — a dot, an accent or a descender can
 *  sit well outside half the median piece height of its own line's other pieces, so overlap of
 *  each piece's own [y0, y1] span is what actually tells lines apart — then sorted left to
 *  right, breaking centre-x ties by centre-y DESCENDING (a stem before its dot). */
export function splitPieces(rings: P[][]): Piece[] {
  const depth = rings.map((r, i) => rings.reduce((n, o, j) => (j !== i && inside(r[0]!, o) ? n + 1 : n), 0))
  const pieces: Piece[] = []
  rings.forEach((r, i) => {
    if (depth[i]! % 2 !== 0) return
    const holes = rings.filter((h, j) => depth[j] === depth[i]! + 1 && inside(h[0]!, r)).map(h => oriented(h, false))
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const p of r) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
    pieces.push({ rings: [oriented(r, true), ...holes], cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, h: y1 - y0 })
  })
  // Vertical-overlap clustering: sort by top edge (y0 = cy − h/2), walk them, and
  // start a new line only when a piece's top sits below every line-so-far's
  // bottom edge. This keeps an `i`'s dot and stem (and any accent/descender)
  // on the SAME line as their neighbours, unlike a fixed band measured from
  // the line's first centre, which can split them onto separate lines.
  const withSpan = pieces.map(p => ({ p, y0: p.cy - p.h / 2, y1: p.cy + p.h / 2 }))
  withSpan.sort((a, b) => a.y0 - b.y0)
  const line = new Map<Piece, number>()
  let li = -1, bottom = -Infinity
  for (const s of withSpan) {
    if (li < 0 || s.y0 > bottom) { li++; bottom = s.y1 }
    else bottom = Math.max(bottom, s.y1)
    line.set(s.p, li)
  }
  return pieces.sort((a, b) => (line.get(a)! - line.get(b)!) || (a.cx - b.cx) || (b.cy - a.cy))
}

/** Order-keeping pairing of nA pieces with nB pieces by reading RANK (0..1). Where one side has
 *  more, the extras become links with a null side and a `partner`: the matched link they ride on
 *  (they shrink into / grow out of it). */
export function alignPieces(nA: number, nB: number): PieceLink[] {
  if (nA === 0 || nB === 0) return []
  const s = (i: number, n: number) => (n === 1 ? 0.5 : i / (n - 1))
  const D = Array.from({ length: nA }, () => new Array<number>(nB).fill(Infinity))
  for (let i = 0; i < nA; i++) for (let j = 0; j < nB; j++) {
    const c = Math.abs(s(i, nA) - s(j, nB))
    const prev = i === 0 && j === 0 ? 0 : Math.min(i > 0 && j > 0 ? D[i - 1]![j - 1]! : Infinity, i > 0 ? D[i - 1]![j]! : Infinity, j > 0 ? D[i]![j - 1]! : Infinity)
    D[i]![j] = c + prev
  }
  const path: [number, number][] = []
  let i = nA - 1, j = nB - 1
  path.push([i, j])
  while (i > 0 || j > 0) {
    if (i === 0) j--
    else if (j === 0) i--
    else { const d = D[i - 1]![j - 1]!, l = D[i - 1]![j]!, u = D[i]![j - 1]!; if (d <= l && d <= u) { i--; j-- } else if (l <= u) i--; else j-- }
    path.push([i, j])
  }
  path.reverse()
  const links: PieceLink[] = []
  const usedA = new Map<number, number>(), usedB = new Map<number, number>()
  for (const [a, b] of path) {
    if (!usedA.has(a) && !usedB.has(b)) { usedA.set(a, links.length); usedB.set(b, links.length); links.push({ a, b }) }
  }
  for (const [a, b] of path) {
    if (!usedA.has(a)) { usedA.set(a, links.length); links.push({ a, b: null, partner: usedB.get(b)! }) }
    if (!usedB.has(b)) { usedB.set(b, links.length); links.push({ a: null, b, partner: usedA.get(a)! }) }
  }
  return links
}

const toD = (rings: P[][]) => rings.filter(r => r.length >= 3)
  .map(r => 'M' + r.map(p => `${p[0].toFixed(3)} ${p[1].toFixed(3)}`).join('L') + 'Z').join('')
const centroid = (rings: P[][]): P => {
  let x = 0, y = 0, n = 0
  for (const p of rings[0] ?? []) { x += p[0]; y += p[1]; n++ }
  return n ? [x / n, y / n] : [0, 0]
}
const smooth01 = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }

function build(dA: string, dB: string, style: MorphStyle): (t: number) => string {
  const rA = ringsFromD(dA), rB = ringsFromD(dB)
  if (!rA.length || !rB.length) return () => ''
  const pA = splitPieces(rA), pB = splitPieces(rB)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of [...rA, ...rB].flat()) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
  const h = Math.max(1e-6, Math.hypot(x1 - x0, y1 - y0) / 300)
  const pin = (rings: P[][]) => pinGlyph(rings, { h, spur: 1.5 })
  if (style === 'shape' || pA.length === 0 || pB.length === 0) {
    const pairs = pairGlyphs(pin(pA.flatMap(p => p.rings)), pin(pB.flatMap(p => p.rings)))
    return (t) => toD(evalGlyph(pairs, t, 'medial'))
  }
  const links = alignPieces(pA.length, pB.length)
  const matched = links.map(l => (l.a != null && l.b != null ? pairGlyphs(pin(pA[l.a]!.rings), pin(pB[l.b]!.rings)) : null))
  return (t) => {
    const out: P[][] = []
    const now = links.map((l, k) => (matched[k] ? evalGlyph(matched[k]!, t, 'medial') : null))
    links.forEach((l, k) => {
      if (now[k]) { out.push(...now[k]!); return }
      const C = centroid(now[l.partner!] ?? [])
      const rings = l.a != null ? pA[l.a]!.rings : pB[l.b!]!.rings
      // An extra piece shrinks into its partner in the first half (A only) or grows out of it
      // in the second (B only), riding with the partner's centre so it never flies off.
      const shut = smooth01(0, 0.5, l.a != null ? t : 1 - t)
      for (const r of rings) out.push(r.map(p => [p[0] + (C[0] - p[0]) * shut, p[1] + (C[1] - p[1]) * shut] as P))
    })
    return toD(out)
  }
}

const CACHE_MAX = 16
const cache = new Map<string, (t: number) => string>()
export function prepareMorph(dA: string, dB: string, style: MorphStyle): (t: number) => string {
  const key = `${style}\u0000${dA}\u0000${dB}`
  const hit = cache.get(key)
  if (hit) { cache.delete(key); cache.set(key, hit); return hit }
  const f = build(dA, dB, style)
  cache.set(key, f)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return f
}
export function clearMorphCache(): void { cache.clear() }
