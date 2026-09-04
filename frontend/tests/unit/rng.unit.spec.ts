import { describe, it, expect } from 'vitest'
import { makeRng } from '~/lib/rng'

describe('makeRng', () => {
  it('is deterministic for a given seed', () => {
    const a = makeRng('seed-x'); const b = makeRng('seed-x')
    const seqA = [a.next(), a.next(), a.next()]
    const seqB = [b.next(), b.next(), b.next()]
    expect(seqA).toEqual(seqB)
  })
  it('differs across seeds', () => {
    expect(makeRng('a').next()).not.toEqual(makeRng('b').next())
  })
  it('range and int stay in bounds', () => {
    const r = makeRng('k')
    for (let i = 0; i < 100; i++) {
      const f = r.range(2, 5); expect(f).toBeGreaterThanOrEqual(2); expect(f).toBeLessThan(5)
      const n = r.int(1, 3); expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(3)
    }
  })
})
