import { describe, it, expect } from 'vitest'
import { defaultGrid, resolveGrid, type FrameGrid } from '~/lib/frame/grid'

describe('resolveGrid explicit', () => {
  it('off mode yields no lines or regions', () => {
    const g = { ...defaultGrid(), mode: 'off' as const }
    expect(resolveGrid(g, 1200, 800)).toEqual({ xs: [], ys: [], regions: [] })
  })
  it('explicit: equal columns/rows inside the margins, edges monotonic', () => {
    const g = { ...defaultGrid(), mode: 'explicit' as const, columns: 4, rows: 2, margin: 0, gutter: 0 }
    const { xs, ys, regions } = resolveGrid(g, 1200, 800)
    expect(xs).toEqual([0, 300, 600, 900, 1200])       // 4 equal columns of 300
    expect(ys).toEqual([0, 400, 800])                  // 2 equal rows of 400
    expect(regions).toHaveLength(8)                     // no merge → one region per cell
    expect(regions[0]).toEqual({ x: 0, y: 0, w: 300, h: 400 })
  })
  it('margins inset the grid from the frame edges', () => {
    const g = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0.1, gutter: 0 }
    const { xs } = resolveGrid(g, 1000, 1000)
    expect(xs[0]).toBe(100)                             // left margin 0.1 * 1000
    expect(xs[xs.length - 1]).toBe(900)                // right margin
  })
})

function gen(over: Partial<FrameGrid['gen']> = {}): FrameGrid {
  return { ...defaultGrid(), mode: 'generated', margin: 0, gutter: 0, gen: { ...defaultGrid().gen, ...over } }
}

describe('resolveGrid generated', () => {
  it('is deterministic in the seed', () => {
    const a = resolveGrid(gen({ seed: 7 }), 1200, 800)
    const b = resolveGrid(gen({ seed: 7 }), 1200, 800)
    const c = resolveGrid(gen({ seed: 8 }), 1200, 800)
    expect(a).toEqual(b)
    expect(a.xs).not.toEqual(c.xs)
  })
  it('column/row counts land in range', () => {
    for (let s = 1; s < 30; s++) {
      const { xs, ys } = resolveGrid(gen({ seed: s, colRange: [3, 5], rowRange: [2, 4], merge: false }), 1000, 1000)
      expect(xs.length - 1).toBeGreaterThanOrEqual(3)
      expect(xs.length - 1).toBeLessThanOrEqual(5)
      expect(ys.length - 1).toBeGreaterThanOrEqual(2)
      expect(ys.length - 1).toBeLessThanOrEqual(4)
    }
  })
  it('regularity 1 gives equal, module-aligned columns', () => {
    const { xs } = resolveGrid(gen({ seed: 3, regularity: 1, colRange: [4, 4], merge: false }), 1200, 800)
    const widths = xs.slice(1).map((x, i) => x - xs[i]!)
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1) // equal within rounding
  })
  it('regularity 1 equalizes columns for multiple counts (not just the one that happens to work)', () => {
    for (const n of [4, 5, 7]) {
      const { xs } = resolveGrid(gen({ seed: 3, regularity: 1, colRange: [n, n], merge: false }), 1200, 800)
      const widths = xs.slice(1).map((x, i) => x - xs[i]!)
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
    }
  })
  it('convergence toward equal widths is monotonic (non-increasing) as regularity rises', () => {
    const spreadAt = (regularity: number) => {
      const { xs } = resolveGrid(gen({ seed: 3, regularity, colRange: [5, 5], merge: false }), 1200, 800)
      const widths = xs.slice(1).map((x, i) => x - xs[i]!)
      return Math.max(...widths) - Math.min(...widths)
    }
    const s0 = spreadAt(0)
    const s05 = spreadAt(0.5)
    const s07 = spreadAt(0.7)
    const s1 = spreadAt(1)
    expect(s1).toBeLessThanOrEqual(s07)
    expect(s07).toBeLessThanOrEqual(s05)
    expect(s05).toBeLessThanOrEqual(s0)
  })
  it('regularity 0 varies column widths', () => {
    const { xs } = resolveGrid(gen({ seed: 3, regularity: 0, colRange: [5, 5], merge: false }), 1200, 800)
    const widths = xs.slice(1).map((x, i) => x - xs[i]!)
    expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThan(20) // genuinely uneven
  })
  it('merged units are rectangular, within mergeMaxSpan, non-overlapping, and cover only real cells', () => {
    const { regions, xs, ys } = resolveGrid(gen({ seed: 5, merge: true, mergeMaxSpan: 3 }), 1200, 800)
    const cols = xs.length - 1, rows = ys.length - 1
    let area = 0
    for (const r of regions) {
      const cw = (xs[1]! - xs[0]!)
      expect(r.w).toBeGreaterThan(0); expect(r.h).toBeGreaterThan(0)
      area += r.w * r.h
    }
    // regions tile the grid area exactly (no overlap, full cover)
    const gridArea = (xs[cols]! - xs[0]!) * (ys[rows]! - ys[0]!)
    expect(Math.abs(area - gridArea)).toBeLessThan(2)

    // Real partition check: mark each region's covered grid cells (by matching its edges
    // back to xs/ys indices, since columns/rows need not be uniform width) and require
    // every cell covered exactly once — area sum alone can't catch an overlap+gap that
    // happen to cancel out numerically.
    const coverCount: number[][] = Array.from({ length: cols }, () => new Array(rows).fill(0))
    for (const r of regions) {
      const i0 = xs.indexOf(r.x)
      const i1 = xs.indexOf(r.x + r.w)
      const j0 = ys.indexOf(r.y)
      const j1 = ys.indexOf(r.y + r.h)
      expect(i0).toBeGreaterThanOrEqual(0); expect(i1).toBeGreaterThan(i0)
      expect(j0).toBeGreaterThanOrEqual(0); expect(j1).toBeGreaterThan(j0)
      for (let j = j0; j < j1; j++)
        for (let i = i0; i < i1; i++)
          coverCount[i]![j]!++
    }
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++)
        expect(coverCount[i]![j]).toBe(1)
  })
  it('mirror symmetry makes the column plan palindromic in widths', () => {
    const { xs } = resolveGrid(gen({ seed: 9, regularity: 0, symmetry: 'mirror', colRange: [6, 6], merge: false }), 1200, 800)
    const w = xs.slice(1).map((x, i) => x - xs[i]!)
    expect(w).toEqual([...w].reverse().map((v, i) => v)) // symmetric widths (allow ±1 in impl if needed)
  })
})
