// Seeded randomness for brush replay. Replay must never touch Math.random: a saved
// stroke has to produce the same specks on every machine and in every export.
import { mulberry32 } from '~/lib/rng'

export interface Rng2 { next(): number; gauss(): [number, number] }

export function makeRng(seed: number): Rng2 {
  const r = mulberry32(seed >>> 0)
  return {
    next: r,
    gauss() {
      let u = r(); while (u <= 1e-12) u = r()
      const m = Math.sqrt(-2 * Math.log(u)), a = 2 * Math.PI * r()
      return [m * Math.cos(a), m * Math.sin(a)]
    },
  }
}
