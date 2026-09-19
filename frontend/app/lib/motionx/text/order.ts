import { hash01 } from './rng'
export type Order = 'ltr' | 'rtl' | 'center' | 'edges' | 'random'
const MIN_PIECE = 0.05

/** Start RANK per piece (0 = first). Equal ranks start together (mirrored pairs). */
export function pieceRanks(count: number, order: Order, seed: number): number[] {
  const idx = Array.from({ length: count }, (_, i) => i)
  if (order === 'rtl') return idx.map((i) => count - 1 - i)
  if (order === 'center' || order === 'edges') {
    const mid = (count - 1) / 2
    const dist = idx.map((i) => Math.floor(Math.abs(i - mid)))
    const max = Math.max(0, ...dist)
    return order === 'center' ? dist : dist.map((d) => max - d)
  }
  if (order === 'random') {
    const sorted = [...idx].sort((a, b) => hash01(seed, a) - hash01(seed, b) || a - b)
    const rank = new Array<number>(count); sorted.forEach((i, r) => { rank[i] = r }); return rank
  }
  return idx
}

/** The bar is the WHOLE move: the last piece ends when the bar ends. */
export function pieceTiming(ranks: number[], stagger: number, duration: number): { delays: number[]; pieceDur: number; staggerUsed: number } {
  // Params arrive from number fields: an emptied field is NaN, and NaN poisons every delay
  // (even rank 0 — 0 × NaN is NaN) and defeats the minimum piece length.
  stagger = Number.isFinite(stagger) ? stagger : 0
  duration = Number.isFinite(duration) ? duration : MIN_PIECE
  const maxRank = Math.max(0, ...ranks)
  const room = Math.max(0, duration - MIN_PIECE)
  const staggerUsed = maxRank > 0 ? Math.min(Math.max(0, stagger), room / maxRank) : Math.max(0, stagger)
  return { delays: ranks.map((r) => r * staggerUsed), pieceDur: Math.max(MIN_PIECE, duration - maxRank * staggerUsed), staggerUsed }
}
