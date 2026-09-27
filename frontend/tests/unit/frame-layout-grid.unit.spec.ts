import { describe, it, expect } from 'vitest'
import {
  suggestedLayoutGrid, readLayoutGrid, resolveLayoutGrid, patchLayoutGrid, layoutGridProperty, describeLayoutGrid,
  SUGGESTED_CAP,
  type LayoutGrid,
} from '~/lib/frame/layoutGrid'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import { kitBasics, formatSheetOpts } from '~/lib/frame/patterns/kit/sheet'

const own = (over: Partial<LayoutGrid> = {}): LayoutGrid => ({
  v: 2, auto: false, show: true, line: 40,
  cols: { count: 12, fit: 'stretch', margin: 60, gutter: 20, width: 0 },
  rows: { mode: 'square', count: 8 },
  ...over,
})

describe('resolveLayoutGrid — columns', () => {
  it('stretch: exact columns margin to margin, real edges (not gutter centre lines)', () => {
    const r = resolveLayoutGrid(own(), 1080, 1350)
    expect(r.cols).toHaveLength(12)
    expect(r.cols[0]).toEqual({ a: 60, w: (1080 - 120 - 11 * 20) / 12 })
    const last = r.cols[11]!
    expect(last.a + last.w).toBeCloseTo(1020, 6)
    expect(r.margin).toBe(60)
    expect(r.xs).toContain(60)
    expect(r.xs).toContain(r.cols[0]!.a + r.cols[0]!.w)
    expect(r.xs).toContain(r.cols[1]!.a)
  })
  it('center: fixed-width columns centred', () => {
    const r = resolveLayoutGrid(own({ cols: { count: 4, fit: 'center', margin: 0, gutter: 20, width: 100 } }), 1000, 1000)
    const all = 4 * 100 + 3 * 20
    expect(r.cols[0]!.a).toBe((1000 - all) / 2)
    expect(r.cols[0]!.w).toBe(100)
  })
  it('left: fixed-width columns from the offset', () => {
    const r = resolveLayoutGrid(own({ cols: { count: 3, fit: 'left', margin: 40, gutter: 10, width: 50 } }), 1000, 1000)
    expect(r.cols.map(c => c.a)).toEqual([40, 100, 160])
  })
  it('scales every px value by the scale', () => {
    const a = resolveLayoutGrid(own(), 1080, 1350)
    const b = resolveLayoutGrid(own(), 540, 675, null, 0.5)
    expect(b.cols[0]!.a).toBeCloseTo(a.cols[0]!.a / 2, 6)
    expect(b.unit).toBe(a.unit / 2)
  })
})

describe('resolveLayoutGrid — rows on the baseline grid', () => {
  it('square: module height is the column width rounded to half a line; tops, heights, gaps are whole units', () => {
    const r = resolveLayoutGrid(own(), 1080, 1350)
    expect(r.unit).toBe(20)
    const cw = r.cols[0]!.w                                  // 61.67
    expect(r.rows[0]!.w).toBe(Math.round(cw / 20) * 20)      // 60
    expect(r.rows[0]!.a).toBe(60)
    for (const row of r.rows) { expect(row.a % 20).toBe(0); expect(row.w % 20).toBe(0) }
    expect(r.rows[1]!.a - (r.rows[0]!.a + r.rows[0]!.w)).toBe(20)
    const last = r.rows[r.rows.length - 1]!
    expect(last.a + last.w).toBeLessThanOrEqual(r.bottom)
  })
  it('count: the given number of rows, on the unit', () => {
    const r = resolveLayoutGrid(own({ rows: { mode: 'count', count: 5 } }), 1080, 1350)
    expect(r.rows).toHaveLength(5)
    for (const row of r.rows) expect(row.a % 20).toBe(0)
  })
  it('off: no rows, but the margins are still horizontal snap lines', () => {
    const r = resolveLayoutGrid(own({ rows: { mode: 'off', count: 8 } }), 1080, 1350)
    expect(r.rows).toEqual([])
    expect(r.ys).toContain(r.top)
    expect(r.ys).toContain(r.bottom)
  })
  it('a format that covers the top and bottom keeps the rows in the uncovered band', () => {
    const story = FRAME_FORMATS.find(f => f.id === 'meta-story')!
    const r = resolveLayoutGrid(own(), 1080, 1920, story)
    expect(r.rows[0]!.a).toBeGreaterThanOrEqual(0.14 * 1920)
    const last = r.rows[r.rows.length - 1]!
    expect(last.a + last.w).toBeLessThanOrEqual(1920 - 0.35 * 1920 + 1e-9)
  })
  it('a band too small for even one row gives no rows, never one that overshoots', () => {
    // 200×100, margin 60: top/bottom margins alone consume more than the whole height.
    const r = resolveLayoutGrid(own({ cols: { count: 3, fit: 'stretch', margin: 60, gutter: 20, width: 0 } }), 200, 100)
    expect(r.rows).toEqual([])
  })
  it('Count mode never places a row past the bottom, even when the requested count cannot fit', () => {
    // 300×300, line 16 (unit 8), margin 10: the band holds 9 rows of the minimum height, not 24.
    const r = resolveLayoutGrid(own({ line: 16, cols: { count: 12, fit: 'stretch', margin: 10, gutter: 20, width: 0 }, rows: { mode: 'count', count: 24 } }), 300, 300)
    expect(r.rows.length).toBeGreaterThan(0)
    expect(r.rows.length).toBeLessThan(24)
    for (const row of r.rows) {
      expect(row.a).toBeGreaterThanOrEqual(r.top)
      expect(row.a + row.w).toBeLessThanOrEqual(r.bottom + 1e-9)
    }
  })
  it('Count mode keeps the row-to-row gap exactly at the grid gap, never shrinking it to fit', () => {
    const r = resolveLayoutGrid(own({ cols: { count: 12, fit: 'stretch', margin: 60, gutter: 60, width: 0 }, rows: { mode: 'count', count: 24 } }), 1080, 1350)
    expect(r.rows.length).toBeGreaterThan(1)
    const gap = Math.max(r.unit, Math.round(60 / r.unit) * r.unit)
    for (let i = 1; i < r.rows.length; i++) {
      expect(r.rows[i]!.a - (r.rows[i - 1]!.a + r.rows[i - 1]!.w)).toBe(gap)
    }
  })
})

describe('suggestedLayoutGrid', () => {
  it('12 columns, gutter = half a line, line a multiple of 4, margin on the unit, square rows', () => {
    const g = suggestedLayoutGrid(1080, 1350, null)
    expect(g.auto).toBe(true)
    expect(g.cols.count).toBe(12)
    expect(g.line % 4).toBe(0)
    expect(g.line).toBeGreaterThanOrEqual(16)
    expect(g.cols.gutter).toBe(g.line / 2)
    expect(g.cols.margin % (g.line / 2)).toBe(0)
    expect(g.rows.mode).toBe('square')
  })
  it('takes the format column override', () => {
    const lb = FRAME_FORMATS.find(f => f.id === 'ad-728x90')!
    expect(suggestedLayoutGrid(728, 90, lb).cols.count).toBe(24)
  })
  it('the Line gives one-unit capitals at or above the kit\'s information size, in every format (stage 3)', () => {
    for (const f of FRAME_FORMATS) {
      const g = suggestedLayoutGrid(f.w, f.h, f)
      const infoPx = kitBasics(f.w, f.h, formatSheetOpts(f)).infoSize * f.w / 100
      expect(g.line % 4, f.id).toBe(0)
      expect(g.line, f.id).toBeGreaterThanOrEqual(16)
      // capitals SUGGESTED_CAP em tall and one unit (line / 2) tall: size = unit / SUGGESTED_CAP
      expect(g.line / 2 / SUGGESTED_CAP, f.id).toBeGreaterThanOrEqual(infoPx - 1e-9)
    }
  })
})

describe('readLayoutGrid', () => {
  it('a stored own grid reads back as stored', () => {
    const g = own()
    expect(readLayoutGrid(layoutGridProperty(g), 1080, 1350, null)).toEqual(g)
  })
  it('a stored auto grid follows the Frame (re-derived), keeping show and rows', () => {
    const stored = { ...suggestedLayoutGrid(1080, 1080, null), show: false, rows: { mode: 'off' as const, count: 3 } }
    const g = readLayoutGrid(layoutGridProperty(stored), 1920, 1080, null)
    expect(g.auto).toBe(true)
    expect(g.cols.count).toBe(12)                            // column count is fixed (12, or the format's own) — not derived from shape
    expect(g.cols.margin).not.toBe(stored.cols.margin)       // still re-derived: the margin follows the new shape
    expect(g.show).toBe(false)
    expect(g.rows).toEqual({ mode: 'off', count: 3 })
  })
  it('a stored auto grid takes the new format\'s column override on re-derivation', () => {
    const stored = suggestedLayoutGrid(1080, 1350, null)
    const lb = FRAME_FORMATS.find(f => f.id === 'ad-728x90')!
    const g = readLayoutGrid(layoutGridProperty(stored), 728, 90, lb)
    expect(g.auto).toBe(true)
    expect(g.cols.count).toBe(24)
  })
  it('no grid on a Frame with layers → auto, hidden (old Frames look the same)', () => {
    const g = readLayoutGrid({ sailor_localLayers: [{ id: 'a' }] }, 1080, 1350, null)
    expect(g.auto).toBe(true)
    expect(g.show).toBe(false)
  })
  it('no grid on an empty Frame → auto, shown', () => {
    expect(readLayoutGrid({}, 1080, 1350, null).show).toBe(true)
  })
  it('an old explicit grid becomes the user\'s own, in px', () => {
    const old = { mode: 'explicit', columns: 6, rows: 4, gutter: 0.01, margin: 0.04, overlay: true }
    const g = readLayoutGrid({ sailor_localGrid: old, sailor_localLayers: [{ id: 'a' }] }, 1000, 1250, null)
    expect(g.auto).toBe(false)
    expect(g.cols).toMatchObject({ count: 6, fit: 'stretch', margin: 40, gutter: 10 })
    expect(g.rows).toEqual({ mode: 'count', count: 4 })
    expect(g.show).toBe(true)
  })
  it('an old generated grid becomes the auto grid', () => {
    const g = readLayoutGrid({ sailor_localGrid: { mode: 'generated' } }, 1080, 1350, null)
    expect(g.auto).toBe(true)
  })
  it('an own grid with unknown fit or rows mode reads back with the defaults', () => {
    const bad = { ...own(), cols: { ...own().cols, fit: 'justify' }, rows: { mode: 'grid', count: 5 } }
    const g = readLayoutGrid({ sailor_layoutGrid: bad }, 1080, 1350, null)
    expect(g.cols.fit).toBe('stretch')
    expect(g.rows).toEqual({ mode: 'square', count: 5 })
  })
  it('a partial stored rows object is merged over the defaults (own and auto)', () => {
    const mine = readLayoutGrid({ sailor_layoutGrid: { ...own(), rows: { mode: 'count' } } }, 1080, 1350, null)
    expect(mine.rows).toEqual({ mode: 'count', count: 8 })
    const auto = readLayoutGrid({ sailor_layoutGrid: { v: 2, auto: true, show: true, rows: { mode: 'off' } } }, 1080, 1350, null)
    expect(auto.rows).toEqual({ mode: 'off', count: 8 })
  })
})

describe('patchLayoutGrid', () => {
  it('a column or line edit makes the grid the user\'s own; show and rows do not', () => {
    const g = suggestedLayoutGrid(1080, 1350, null)
    expect(patchLayoutGrid(g, { columns: 6 }).auto).toBe(false)
    expect(patchLayoutGrid(g, { show: false }).auto).toBe(true)
    expect(patchLayoutGrid(g, { rows: 'off' }).auto).toBe(true)
  })
  it('clamps counts and rounds the line to 4 px (min 16)', () => {
    const g = own()
    expect(patchLayoutGrid(g, { columns: 99 }).cols.count).toBe(24)
    expect(patchLayoutGrid(g, { rowCount: 0 }).rows.count).toBe(1)
    expect(patchLayoutGrid(g, { line: 43 }).line).toBe(44)
    expect(patchLayoutGrid(g, { line: 3 }).line).toBe(16)
  })
})

describe('describeLayoutGrid', () => {
  it('reads out in plain words', () => {
    expect(describeLayoutGrid(own())).toBe('12 columns, square rows, line 40 px')
    expect(describeLayoutGrid(own({ show: false, rows: { mode: 'count', count: 5 } }))).toBe('12 columns, 5 rows, line 40 px, hidden')
  })
})
