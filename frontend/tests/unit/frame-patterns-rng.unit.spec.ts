import { describe, it, expect } from 'vitest'
import { rngFor } from '~/lib/frame/patterns/rng'

describe('rngFor', () => {
  it('is deterministic for the same (seed, index)', () => {
    const a = rngFor(7, 3), b = rngFor(7, 3)
    expect([a.f(), a.f(), a.f()]).toEqual([b.f(), b.f(), b.f()])
  })
  it('differs across index and across seed', () => {
    expect(rngFor(7, 3).f()).not.toEqual(rngFor(7, 4).f())
    expect(rngFor(7, 3).f()).not.toEqual(rngFor(8, 3).f())
  })
  it('range/int/pick/chance stay in bounds', () => {
    const r = rngFor(1, 0)
    for (let i = 0; i < 200; i++) {
      const v = r.range(2, 5); expect(v).toBeGreaterThanOrEqual(2); expect(v).toBeLessThanOrEqual(5)
      const n = r.int(1, 3); expect(Number.isInteger(n)).toBe(true); expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(3)
      expect(['a', 'b', 'c']).toContain(r.pick(['a', 'b', 'c']))
      expect(typeof r.chance(0.5)).toBe('boolean')
    }
  })
})
