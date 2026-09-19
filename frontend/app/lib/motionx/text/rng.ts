/** Stateless seeded hash → [0, 1). Random ACCESS (any piece, any jump, any frame) with no
 *  sequence to keep in step — the render path must never call Math.random(). */
export function hash01(...ns: number[]): number {
  let h = 0x9e3779b9
  for (const n of ns) {
    h = Math.imul(h ^ (Math.round(n) | 0), 0x85ebca6b); h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  }
  return (h >>> 0) / 4294967296
}
