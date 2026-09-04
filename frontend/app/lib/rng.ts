// Deterministic seeded RNG (house rule): a seed string fully determines a roll.
// Studio-agnostic — the canonical home; per-studio rng modules may re-export this.

export function xmur3(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

export function mulberry32(a: number): () => number {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Rng {
  next(): number
  range(lo: number, hi: number): number
  int(lo: number, hi: number): number
  pick<T>(arr: readonly T[]): T
  chance(p: number): boolean
}

export function makeRng(seed: string, salt = ''): Rng {
  const fn = mulberry32(xmur3(seed + '|' + salt))
  return {
    next: fn,
    range: (lo, hi) => lo + (hi - lo) * fn(),
    int: (lo, hi) => lo + Math.floor((hi - lo + 1) * fn()),
    pick: arr => arr[Math.floor(fn() * arr.length) % arr.length]!,
    chance: p => fn() < p,
  }
}
