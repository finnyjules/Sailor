// frontend/tests/unit/frame-layout-kit-grid.unit.spec.ts
// Stage 3: the kit's sheet on the Frame's layout grid.
import { describe, it, expect } from 'vitest'
import { gridBand, makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { resolveLayoutGrid, suggestedLayoutGrid, type LayoutGrid } from '~/lib/frame/layoutGrid'
import { FRAME_FORMATS } from '~/lib/frame/formats'

const measure = makeStubMeasure()
// 1000 × 1000, line 40 (unit 20 px = 2 kit units), margin 60, gutter 20, 12 columns, square rows:
// columns 55 px, rows 60 px tall, 80 px pitch; tops at 60, 140, … 860 px; bottoms 120 … 920 px.
const own = (over: Partial<LayoutGrid> = {}): LayoutGrid => ({
  v: 2, auto: false, show: true, line: 40,
  cols: { count: 12, fit: 'stretch', margin: 60, gutter: 20, width: 0 },
  rows: { mode: 'square', count: 8 },
  ...over,
})
const sheetOn = (g: LayoutGrid, w = 1000, h = 1000, extra: Record<string, unknown> = {}) =>
  makeSheet({ frameW: w, frameH: h, measure, layout: resolveLayoutGrid(g, w, h), ...extra })

describe('the sheet on the layout grid — columns', () => {
  it('NC, M, G, CW and every Xr(c) are the grid\'s own edges, in kit units', () => {
    const r = resolveLayoutGrid(own(), 1000, 1000)
    const S = sheetOn(own())
    expect(S.NC).toBe(12)
    expect(S.M).toBeCloseTo(6, 9)
    expect(S.G).toBeCloseTo(2, 9)
    expect(S.CW).toBeCloseTo(5.5, 9)
    for (let c = 1; c <= 12; c++) expect(S.Xr(c)).toBeCloseTo(r.cols[c - 1]!.a * 100 / 1000, 9)
    expect(S.XR(12)).toBeCloseTo((r.cols[11]!.a + r.cols[11]!.w) / 10, 9)
  })
  it('suggested grids in every format: the sheet\'s edges equal the resolver\'s', () => {
    for (const f of FRAME_FORMATS) {
      const r = resolveLayoutGrid(suggestedLayoutGrid(f.w, f.h, f), f.w, f.h, f)
      const S = makeSheet({ frameW: f.w, frameH: f.h, measure, layout: r })
      expect(S.NC, f.id).toBe(r.cols.length)
      for (let c = 1; c <= S.NC; c++) {
        expect(S.Xr(c), `${f.id} col ${c}`).toBeCloseTo(r.cols[c - 1]!.a * 100 / f.w, 9)
        expect(S.Xr(c) + S.CW, `${f.id} col ${c} end`).toBeCloseTo((r.cols[c - 1]!.a + r.cols[c - 1]!.w) * 100 / f.w, 9)
      }
    }
  })
  it('the 12 design columns map onto the real count: on 24 columns design column 2 starts on real column 3', () => {
    const S = sheetOn(own({ cols: { count: 24, fit: 'stretch', margin: 60, gutter: 10, width: 0 } }))
    expect(S.X(2)).toBeCloseTo(S.Xr(3), 9)
    expect(S.XR(12)).toBeCloseTo(S.Xr(24) + S.CW, 9)
  })
  it('a centred grid: M is the columns\' own left edge', () => {
    const g = own({ cols: { count: 6, fit: 'center', margin: 0, gutter: 20, width: 100 } })
    const r = resolveLayoutGrid(g, 1000, 1000)
    const S = sheetOn(g)
    expect(S.M).toBeCloseTo(r.margin / 10, 9)
    expect(S.CW).toBeCloseTo(10, 9)
  })
  it('the wide-frame sub-sheet (colRange) is unchanged: design column 12 ends on the range\'s last real column', () => {
    const S = sheetOn(own(), 1000, 1000, { colRange: [1, 8] })
    expect(S.XR(12)).toBeCloseTo(S.Xr(8) + S.CW, 9)
  })
})

describe('the sheet on the layout grid — the band', () => {
  it('without a covered area the band is the whole Frame (the suggested grid)', () => {
    const r = resolveLayoutGrid(suggestedLayoutGrid(1080, 1350, null), 1080, 1350)
    const S = makeSheet({ frameW: 1080, frameH: 1350, measure, layout: r })
    expect(S.Y0).toBeCloseTo(0, 9)
    expect(S.H).toBeCloseTo(125, 9)
  })
  it('a story: the sheet\'s margins are the grid\'s top and bottom, below and above the covered areas', () => {
    const story = FRAME_FORMATS.find(f => f.id === 'meta-story')!
    const r = resolveLayoutGrid(suggestedLayoutGrid(1080, 1920, story), 1080, 1920, story)
    const S = makeSheet({ frameW: 1080, frameH: 1920, measure, layout: r, format: { view: 390, keepSide: 0.06 } })
    const b = gridBand(r, 1080)
    expect(S.Y0).toBeCloseTo(b.y0, 9)
    expect(S.L(0) + S.Y0).toBeCloseTo(r.top * 100 / 1080, 9)          // the top margin IS the grid's top
    expect(S.H - S.M + S.Y0).toBeCloseTo(r.bottom * 100 / 1080, 9)   // the bottom margin IS the grid's bottom
    expect(S.L(0) + S.Y0).toBeGreaterThanOrEqual(0.14 * 1920 * 100 / 1080 - 1e-9)
  })
  it('whole: the same grid, measured on the whole Frame (Y0 0, full height)', () => {
    const story = FRAME_FORMATS.find(f => f.id === 'meta-story')!
    const r = resolveLayoutGrid(suggestedLayoutGrid(1080, 1920, story), 1080, 1920, story)
    const band = makeSheet({ frameW: 1080, frameH: 1920, measure, layout: r })
    const whole = makeSheet({ frameW: 1080, frameH: 1920, measure, layout: r, whole: true })
    expect(whole.Y0).toBe(0)
    expect(whole.H).toBeCloseTo(100 * 1920 / 1080, 9)
    for (const row of [0, 3, 8, 16]) expect(whole.L(row)).toBeCloseTo(band.L(row) + band.Y0, 9)
  })
  it('U is the grid\'s unit in kit units; the kit\'s own sheet has none', () => {
    expect(sheetOn(own()).U).toBeCloseTo(2, 9)
    expect(makeSheet({ frameW: 1000, frameH: 1000, measure }).U).toBe(0)
    expect(makeSheet({ frameW: 1000, frameH: 1000, measure }).Y0).toBe(0)
  })
  it('B still comes from the Frame\'s full height', () => {
    const story = FRAME_FORMATS.find(f => f.id === 'meta-story')!
    const r = resolveLayoutGrid(suggestedLayoutGrid(1080, 1920, story), 1080, 1920, story)
    expect(makeSheet({ frameW: 1080, frameH: 1920, measure, layout: r }).B).toBeCloseTo(makeSheet({ frameW: 1080, frameH: 1920, measure }).B, 9)
  })
})
