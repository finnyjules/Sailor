import { describe, it, expect } from 'vitest'
import { defaultGrid, resolveGrid } from '~/lib/frame/grid'
import { sectionOf, sectionsAt } from '~/lib/frame/responsive/sections'

describe('resolveGrid unitW', () => {
  it('omitted unitW is byte-identical to today', () => {
    const g = { ...defaultGrid(), mode: 'explicit' as const, columns: 3, rows: 2, margin: 0.1, gutter: 0.02 }
    expect(resolveGrid(g, 1200, 800, 1200)).toEqual(resolveGrid(g, 1200, 800))
  })
  it('margins and gutters scale with unitW, not with the box width', () => {
    const g = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0.1, gutter: 0 }
    // design 1000 wide, fitted (s = 1) into a 3000-wide box: margin stays 100px, not 300px
    const { xs } = resolveGrid(g, 3000, 1000, 1000)
    expect(xs[0]).toBe(100)
    expect(xs[xs.length - 1]).toBe(2900)
  })
  it('the gutter is a fraction of unitW, not of the box width', () => {
    const g = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0, gutter: 0.02 }
    // design 1000 wide in a 3000-wide box: gutter is 0.02 * 1000 = 20px, inset 10px a side
    // (were it read off the box it would be 0.02 * 3000 = 60px, inset 30).
    const { regions } = resolveGrid(g, 3000, 1000, 1000)
    expect(regions[0]!.x).toBe(10)
    expect(regions[0]!.w).toBe(1500 - 20)
  })
  it('the base module is a fraction of unitW, not of the box width', () => {
    // regularity 0 = free widths, so the module snap in makeAxisEdges actually bites.
    // Same box (2400) both times; only the module unit differs (1/12 of 1200 vs of 2400),
    // so the snapped column widths — and therefore the edges — must come out different.
    const g = {
      ...defaultGrid(), mode: 'generated' as const, margin: 0, gutter: 0, baseModule: 1 / 12,
      gen: { ...defaultGrid().gen, regularity: 0 },
    }
    const atDesignModule = resolveGrid(g, 2400, 800, 1200)
    const atBoxModule = resolveGrid(g, 2400, 800)
    expect(atDesignModule.xs).not.toEqual(atBoxModule.xs)
    // Both still span the whole box: only the interior edges moved.
    expect(atDesignModule.xs[0]).toBe(0)
    expect(atBoxModule.xs[0]).toBe(0)
    expect(atDesignModule.xs[atDesignModule.xs.length - 1]).toBe(2400)
    expect(atBoxModule.xs[atBoxModule.xs.length - 1]).toBe(2400)
  })
  it('a generated grid keeps its region ORDER across sizes', () => {
    const g = { ...defaultGrid(), mode: 'generated' as const }
    const a = resolveGrid(g, 1200, 800)
    const b = resolveGrid(g, 2400, 800, 1200)
    expect(b.regions.length).toBe(a.regions.length)
    expect(b.xs.length).toBe(a.xs.length)
    expect(b.ys.length).toBe(a.ys.length)
  })
})

describe('sectionOf', () => {
  const regions = [
    { x: 0, y: 0, w: 500, h: 500 }, { x: 500, y: 0, w: 500, h: 500 },
  ]
  it('finds the single section a box lies inside (within tol)', () => {
    expect(sectionOf({ x: 40, y: 40, w: 300, h: 200 }, regions, 10)).toBe(0)
    expect(sectionOf({ x: 540, y: 40, w: 300, h: 200 }, regions, 10)).toBe(1)
    expect(sectionOf({ x: 495, y: 40, w: 300, h: 200 }, regions, 10)).toBe(1)  // 5px over, inside tol
  })
  it('returns -1 when it straddles or falls outside', () => {
    expect(sectionOf({ x: 300, y: 40, w: 400, h: 200 }, regions, 10)).toBe(-1)
    expect(sectionOf({ x: 40, y: 600, w: 100, h: 100 }, regions, 10)).toBe(-1)
  })
})

describe('sectionsAt', () => {
  it('returns the design regions and the box regions in the same order, or null when off', () => {
    expect(sectionsAt(null, 1000, 1000, 1, 1000, 1000)).toBeNull()
    const g = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 2, margin: 0, gutter: 0 }
    const r = sectionsAt(g, 1000, 1000, 1, 2000, 1000)!
    expect(r.design.regions).toHaveLength(4)
    expect(r.box.regions).toHaveLength(4)
    expect(r.box.regions[1]).toEqual({ x: 1000, y: 0, w: 1000, h: 500 })
  })
})
