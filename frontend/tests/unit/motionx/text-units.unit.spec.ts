import { describe, it, expect } from 'vitest'
import { groupCells, type TextCell } from '~/lib/motionx/text/units'
import { hash01 } from '~/lib/motionx/text/rng'
import { pieceRanks, pieceTiming } from '~/lib/motionx/text/order'

const cell = (char: string, x: number, y: number, word: number, line: number, angle = 0): TextCell => ({ char, x, y, w: 10, h: 20, angle, word, line })
// "AB CD" on line 0, "EF" on line 1
const CELLS = [cell('A', 0, 0, 0, 0), cell('B', 10, 0, 0, 0), cell('C', 30, 0, 1, 0), cell('D', 40, 0, 1, 0), cell('E', 0, 30, 2, 1), cell('F', 10, 30, 2, 1)]

describe('groupCells', () => {
  it('letters: one piece per cell, centred on it', () => {
    const p = groupCells(CELLS, 'letters')
    expect(p).toHaveLength(6)
    expect(p[2]).toMatchObject({ index: 2, cells: [2], cx: 30, cy: 0, w: 10, h: 20, angle: 0 })
  })
  it('words: cells grouped by word, centre = bounding-box centre', () => {
    const p = groupCells(CELLS, 'words')
    expect(p.map((x) => x.cells)).toEqual([[0, 1], [2, 3], [4, 5]])
    expect(p[0]).toMatchObject({ cx: 5, cy: 0, w: 20, h: 20 })
  })
  it('lines: cells grouped by line', () => {
    const p = groupCells(CELLS, 'lines')
    expect(p.map((x) => x.cells)).toEqual([[0, 1, 2, 3], [4, 5]])
    expect(p[0]).toMatchObject({ cx: 20, w: 50 })
  })
  it('a piece angle is the circular mean of its cells (path text)', () => {
    const p = groupCells([cell('A', 0, 0, 0, 0, 0.2), cell('B', 10, 0, 0, 0, 0.4)], 'words')
    expect(p[0]!.angle).toBeCloseTo(0.3, 6)
    const wrap = groupCells([cell('A', 0, 0, 0, 0, Math.PI - 0.1), cell('B', 10, 0, 0, 0, -Math.PI + 0.1)], 'words')
    expect(Math.abs(wrap[0]!.angle)).toBeCloseTo(Math.PI, 6)      // not 0: angles wrap
  })
  it('empty text → no pieces', () => { expect(groupCells([], 'words')).toEqual([]) })
})

describe('hash01', () => {
  it('is deterministic, in [0,1), and sensitive to every argument', () => {
    expect(hash01(1, 2, 3)).toBe(hash01(1, 2, 3))
    for (let i = 0; i < 200; i++) { const v = hash01(7, i, 3); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1) }
    expect(hash01(1, 2, 3)).not.toBe(hash01(1, 2, 4))
    expect(hash01(1, 2, 3)).not.toBe(hash01(2, 2, 3))
  })
  it('is roughly uniform', () => {
    let sum = 0; for (let i = 0; i < 2000; i++) sum += hash01(42, i)
    expect(sum / 2000).toBeGreaterThan(0.45); expect(sum / 2000).toBeLessThan(0.55)
  })
})

describe('pieceRanks', () => {
  it('ltr / rtl follow reading order', () => {
    expect(pieceRanks(4, 'ltr', 0)).toEqual([0, 1, 2, 3])
    expect(pieceRanks(4, 'rtl', 0)).toEqual([3, 2, 1, 0])
  })
  it('center starts in the middle and mirrors outwards; edges is the reverse', () => {
    expect(pieceRanks(5, 'center', 0)).toEqual([2, 1, 0, 1, 2])
    expect(pieceRanks(4, 'center', 0)).toEqual([1, 0, 0, 1])
    expect(pieceRanks(5, 'edges', 0)).toEqual([0, 1, 2, 1, 0])
  })
  it('random is a seeded permutation: same seed same order, other seed another order', () => {
    const a = pieceRanks(8, 'random', 5)
    expect([...a].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(pieceRanks(8, 'random', 5)).toEqual(a)
    expect(pieceRanks(8, 'random', 6)).not.toEqual(a)
  })
  it('zero or one piece', () => { expect(pieceRanks(0, 'ltr', 0)).toEqual([]); expect(pieceRanks(1, 'center', 0)).toEqual([0]) })
})

describe('pieceTiming — the bar is the whole move', () => {
  it('delay = rank × stagger; every piece gets what is left of the bar', () => {
    expect(pieceTiming([0, 1, 2], 0.1, 1)).toEqual({ delays: [0, 0.1, 0.2], pieceDur: 0.8, staggerUsed: 0.1 })
  })
  it('a stagger that does not fit is scaled down so each piece still has 0.05s', () => {
    const t = pieceTiming([0, 1, 2], 1, 1)
    expect(t.pieceDur).toBeCloseTo(0.05, 9)
    expect(t.staggerUsed).toBeCloseTo(0.475, 9)
    expect(t.delays[2]).toBeCloseTo(0.95, 9)
  })
  it('single piece / zero stagger → the whole bar', () => {
    expect(pieceTiming([0], 0.3, 2)).toEqual({ delays: [0], pieceDur: 2, staggerUsed: 0.3 })
    expect(pieceTiming([0, 1], 0, 2).pieceDur).toBe(2)
  })
})
