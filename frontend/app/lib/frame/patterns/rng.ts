import { mulberry32 } from '~/lib/rng'

export interface PatternRng {
  f(): number
  range(a: number, b: number): number
  int(a: number, b: number): number
  pick<T>(arr: readonly T[]): T
  chance(p: number): boolean
}

/** One RNG per (tile seed, pattern index), so each tile of the sheet varies
 *  independently yet reproducibly. */
export function rngFor(seed: number, patternIndex: number): PatternRng {
  const next = mulberry32((seed * 1000 + patternIndex * 17 + 1) | 0)
  return {
    f: next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)]!,
    chance: (p) => next() < p,
  }
}
