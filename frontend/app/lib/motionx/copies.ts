// Copies stagger (spec Part 2): which copy of a cloned layer goes first, and what clock copy k
// sees. Pure. `k` is expandClones' own index (0 = the original), `n` its copy count.
import type { Cloner } from '~/composables/useCloner'
import { hash01 } from '~/lib/motionx/text/rng'

export type CopyOrder = 'first' | 'last' | 'centre' | 'random'
export const COPY_ORDERS: readonly CopyOrder[] = ['first', 'last', 'centre', 'random']
export const COPY_ORDER_LABELS: Record<CopyOrder, string> = {
  first: 'First to last', last: 'Last to first', centre: 'Centre out', random: 'Random',
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
