import { describe, it, expect } from 'vitest'
import { defaultGrid, resolveGrid } from '~/lib/frame/grid'

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
