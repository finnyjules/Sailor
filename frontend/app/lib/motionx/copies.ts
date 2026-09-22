// Copies stagger (spec Part 2): which copy of a cloned layer goes first, and what clock copy k
// sees. Pure. `k` is expandClones' own index (0 = the original), `n` its copy count.
import type { Cloner } from '~/composables/useCloner'
import { hash01 } from '~/lib/motionx/text/rng'

export type CopyOrder = 'first' | 'last' | 'centre' | 'edges' | 'random'
export const COPY_ORDERS: readonly CopyOrder[] = ['first', 'last', 'centre', 'edges', 'random']
export const COPY_ORDER_LABELS: Record<CopyOrder, string> = {
  first: 'First to last', last: 'Last to first', centre: 'Centre out', edges: 'Edges in', random: 'Random',
}

/** rank per copy index k: rank 0 goes first. */
export function copyRanks(n: number, order: CopyOrder, seed: number): number[] {
  const count = Math.max(1, Math.floor(n) || 1)
  const ks = Array.from({ length: count }, (_, k) => k)
  if (count <= 1) return [0]

  if (order === 'last') return ks.map((k) => count - 1 - k)

  if (order === 'centre') {
    // Nearest the middle first; a tie (the two neighbours of the middle, or the two
    // middles of an even count) goes to the LOWER index — the spec's rule.
    const mid = (count - 1) / 2
    const sorted = [...ks].sort((a, b) => (Math.abs(a - mid) - Math.abs(b - mid)) || (a - b))
    const rank = new Array<number>(count)
    sorted.forEach((k, r) => { rank[k] = r })
    return rank
  }

  if (order === 'edges') {
    // The mirror of 'centre': the OUTERMOST copy goes first, the middle last. A tie (two copies
    // the same distance from the middle) goes to the LOWER index, exactly as 'centre' does.
    const mid = (count - 1) / 2
    const sorted = [...ks].sort((a, b) => (Math.abs(b - mid) - Math.abs(a - mid)) || (a - b))
    const rank = new Array<number>(count)
    sorted.forEach((k, r) => { rank[k] = r })
    return rank
  }

  if (order === 'random') {
    // Same stateless-hash shuffle as the letter behaviours' random order
    // (lib/motionx/text/order.ts): sort by a seeded hash, repeatable per seed.
    const s = Number.isFinite(seed) ? seed : 1
    const sorted = [...ks].sort((a, b) => hash01(s, a) - hash01(s, b) || a - b)
    const rank = new Array<number>(count)
    sorted.forEach((k, r) => { rank[k] = r })
    return rank
  }

  // 'first', or anything unrecognised: identity.
  return ks
}

export function staggerOf(cloner: Pick<Cloner, 'motionStagger'> | undefined | null): number {
  const s = cloner?.motionStagger
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 0
}

/** The clock copy k of n sees: the frame clock, minus its rank × stagger. */
export function copyClock(t: number, k: number, n: number, cloner: Cloner): number {
  const s = staggerOf(cloner)
  if (s === 0) return t
  const ranks = copyRanks(n, (cloner.motionOrder ?? 'first') as CopyOrder, cloner.motionSeed ?? 1)
  return t - (ranks[k] ?? 0) * s
}

/** The time offsets of a bar's stagger "echoes" — the faint copies the timeline draws behind a
 *  bar to show that a copy stagger spreads it in time. One per copy after the first
 *  (`rank × stagger`, i.e. `stagger`, `2·stagger`, …), capped at `max`, and never past
 *  `duration` (a copy that starts after the frame ends has nothing to show). Pure; the caller
 *  supplies the distinct copy count and decides whether a bar echoes at all. */
export function echoOffsets(stagger: number, copyCount: number, barStart: number, duration: number, max = 6): number[] {
  const s = typeof stagger === 'number' && Number.isFinite(stagger) && stagger > 0 ? stagger : 0
  if (s <= 0) return []
  const n = Math.min(Math.max(0, Math.floor(max)), Math.max(0, Math.floor(copyCount) - 1))
  const out: number[] = []
  for (let i = 1; i <= n; i++) { if (barStart + i * s <= duration + 1e-6) out.push(i * s) }
  return out
}
