import { describe, it, expect } from 'vitest'
import { copyRanks, copyClock, staggerOf, COPY_ORDERS } from '~/lib/motionx/copies'
import { DEFAULT_CLONER } from '~/composables/useCloner'

describe('copyRanks', () => {
  it('first to last: the original goes first', () => { expect(copyRanks(4, 'first', 1)).toEqual([0, 1, 2, 3]) })
  it('last to first', () => { expect(copyRanks(4, 'last', 1)).toEqual([3, 2, 1, 0]) })
  it('centre out, odd and even (ties: the lower index first)', () => {
    // n = 5: k=2 first, then its neighbours 1 (lower) and 3, then 0 and 4.
    expect(copyRanks(5, 'centre', 1)).toEqual([3, 1, 0, 2, 4])
    // n = 4: the two middles 1 (lower) and 2, then 0 and 3.
    expect(copyRanks(4, 'centre', 1)).toEqual([2, 0, 1, 3])
    expect(copyRanks(6, 'centre', 1)).toEqual([4, 2, 0, 1, 3, 5])
  })
  it('random is a repeatable permutation that changes with the seed', () => {
    const a = copyRanks(8, 'random', 7), b = copyRanks(8, 'random', 7), c = copyRanks(8, 'random', 8)
    expect(a).toEqual(b)
    expect([...a].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(c).not.toEqual(a)
  })
  it('n ≤ 1 is a single rank 0; a bad order reads as first to last', () => {
    expect(copyRanks(1, 'random', 1)).toEqual([0])
    expect(copyRanks(3, 'bogus' as any, 1)).toEqual([0, 1, 2])
  })
  it('edges in: the outermost copy first, the middle last (the mirror of centre out)', () => {
    expect(copyRanks(5, 'edges', 1)).toEqual([0, 2, 4, 3, 1])
    expect(copyRanks(4, 'edges', 1)).toEqual([0, 2, 3, 1])
    expect(copyRanks(6, 'edges', 1)).toEqual([0, 2, 4, 5, 3, 1])
  })
  it('lists the five orders in gallery order', () => { expect(COPY_ORDERS).toEqual(['first', 'last', 'centre', 'edges', 'random']) })
})

describe('copyClock', () => {
  const cl = { ...DEFAULT_CLONER, enabled: true, motionStagger: 0.25, motionOrder: 'last' as const }
  it('shifts copy k back by rank × stagger', () => {
    expect(copyClock(2, 0, 4, cl)).toBeCloseTo(2 - 3 * 0.25)
    expect(copyClock(2, 3, 4, cl)).toBeCloseTo(2)
  })
  it('no stagger, or a bad one, is the frame clock', () => {
    expect(copyClock(2, 1, 4, DEFAULT_CLONER)).toBe(2)
    expect(copyClock(2, 1, 4, { ...cl, motionStagger: NaN })).toBe(2)
    expect(copyClock(2, 1, 4, { ...cl, motionStagger: -1 })).toBe(2)
  })
  it('staggerOf', () => { expect(staggerOf(cl)).toBe(0.25); expect(staggerOf(DEFAULT_CLONER)).toBe(0); expect(staggerOf(undefined)).toBe(0) })
})
