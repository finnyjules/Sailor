import { describe, it, expect } from 'vitest'
import { copyRanks, copyClock, staggerOf, COPY_ORDERS, echoOffsets, staggerOverrun, echoCut, fitFrameDuration } from '~/lib/motionx/copies'
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

describe('echoOffsets — the timeline\'s stagger echoes', () => {
  it('one offset per copy after the first, each a multiple of the stagger', () => {
    expect(echoOffsets(0.25, 4, 0, 4)).toEqual([0.25, 0.5, 0.75])
    expect(echoOffsets(0.25, 1, 0, 4)).toEqual([])   // one copy → nothing to echo
  })
  it('caps at `max` however many copies', () => {
    expect(echoOffsets(0.1, 20, 0, 4, 6)).toHaveLength(6)
  })
  it('drops echoes that would start past the frame', () => {
    // bar at 3.6s, stagger 0.25, duration 4: only +0.25 (3.85) fits; +0.5 (4.10) is past.
    expect(echoOffsets(0.25, 5, 3.6, 4)).toEqual([0.25])
  })
  it('no stagger, a bad stagger, or zero copies → no echoes', () => {
    expect(echoOffsets(0, 4, 0, 4)).toEqual([])
    expect(echoOffsets(NaN, 4, 0, 4)).toEqual([])
    expect(echoOffsets(0.25, 0, 0, 4)).toEqual([])
  })
})

describe('staggerOverrun — copies the Frame\'s end cuts off', () => {
  it('counts copies cut mid-move, copies that never start, and when the last one ends', () => {
    // 8 copies, 0.3s stagger, a 2.0–2.6s bar in a 4s Frame. Copy starts: 2.3 … 4.1.
    // Copies 5 (3.5→4.1) and 6 (3.8→4.4) are cut; copy 7 starts at 4.1 and never appears.
    const o = staggerOverrun(0.3, 8, 2, 2.6, 4, 6)
    expect(o.cut).toBe(2)
    expect(o.unstarted).toBe(1)
    expect(o.lastEnd).toBeCloseTo(4.7)
    // 6 echoes fit on screen (copies 1–6), so one copy (7) goes undrawn.
    expect(o.hidden).toBe(1)
  })
  it('everything inside the Frame: nothing cut, nothing hidden', () => {
    expect(staggerOverrun(0.25, 4, 0, 1, 4)).toEqual({ cut: 0, unstarted: 0, hidden: 0, lastEnd: 1.75 })
  })
  it('copies past the echo cap are hidden but not cut', () => {
    const o = staggerOverrun(0.1, 20, 0, 0.5, 4, 6)
    expect(o).toMatchObject({ cut: 0, unstarted: 0, hidden: 13 })
    expect(o.lastEnd).toBeCloseTo(2.4)
  })
  it('a copy ending exactly at the Frame\'s end is not cut', () => {
    expect(staggerOverrun(0.5, 3, 2, 3, 4).cut).toBe(0)   // last copy 3.0 → 4.0
  })
  it('no stagger, a bad stagger, or one copy → nothing to report; lastEnd is the bar\'s end', () => {
    for (const o of [staggerOverrun(0, 4, 1, 2, 4), staggerOverrun(NaN, 4, 1, 2, 4), staggerOverrun(0.25, 1, 1, 2, 4)])
      expect(o).toEqual({ cut: 0, unstarted: 0, hidden: 0, lastEnd: 2 })
  })
})

describe('echoCut — an echo still moving when the Frame ends', () => {
  it('true only when the echo ends after the Frame', () => {
    expect(echoCut(2.6, 1.5, 4)).toBe(true)    // ends 4.1
    expect(echoCut(2.6, 1.4, 4)).toBe(false)   // ends exactly 4.0
    expect(echoCut(1, 0.5, 4)).toBe(false)
  })
})

describe('fitFrameDuration — the "Fit copies" length', () => {
  it('rounds the last copy\'s end up to the next half second', () => {
    expect(fitFrameDuration(4.7, 4)).toBe(5)
    expect(fitFrameDuration(5.5, 4)).toBe(5.5)
    expect(fitFrameDuration(5.5 + 1e-9, 4)).toBe(5.5)   // float noise doesn't add half a second
  })
  it('caps at 60s, never shortens the Frame, and ignores a bad end', () => {
    expect(fitFrameDuration(70, 4)).toBe(60)
    expect(fitFrameDuration(3, 4)).toBe(4)
    expect(fitFrameDuration(NaN, 4)).toBe(4)
  })
})
