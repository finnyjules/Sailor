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

describe('the sheet on the layout grid — rows', () => {
  // own(): rows' tops 6, 14, … 86 and bottoms 12, 20, … 92 (kit units); the band is the whole Frame.
  const tops = Array.from({ length: 11 }, (_, i) => 6 + 8 * i)
  const bottoms = tops.map(t => t + 6)
  it('rows on: every L(r) is a row top (the last row\'s bottom past the end), every LB(r) a row bottom', () => {
    const S = sheetOn(own())
    expect(S.rows.map(r => r.a)).toEqual(tops.map(t => expect.closeTo(t, 9)))
    // Up to the last row top (86: proportional row 14.5) L is a row top; from the first row bottom
    // (12: proportional row 1.5) LB is a row bottom.
    for (let r = 0; r <= 14.5; r += 0.5) expect(tops.some(t => Math.abs(S.L(r) - t) < 1e-9), `L(${r}) = ${S.L(r)}`).toBe(true)
    for (let r = 1.5; r <= 16; r += 0.5) expect(bottoms.some(b => Math.abs(S.LB(r) - b) < 1e-9), `LB(${r}) = ${S.LB(r)}`).toBe(true)
    expect(S.L(15.5)).toBeCloseTo(92, 9)         // past the last row top: the last row's bottom
    expect(S.LB(1)).toBeCloseTo(6, 9)            // before the first row bottom: the first row's top
    expect(S.L(0)).toBeCloseTo(6, 9)
    expect(S.L(1)).toBeCloseTo(14, 9)            // proportional 11.5 → the next row top
    expect(S.L(16)).toBeCloseTo(92, 9)           // nothing starts at the bottom: the last row's bottom
    expect(S.LB(16)).toBeCloseTo(92, 9)
    expect(S.LB(8)).toBeCloseTo(44, 9)           // proportional 50 → the row bottom before it
  })
  it('L never goes up and LB never goes down as r grows', () => {
    const S = sheetOn(own())
    for (let r = 0; r < 16; r += 0.25) {
      expect(S.L(r + 0.25)).toBeGreaterThanOrEqual(S.L(r) - 1e-9)
      expect(S.LB(r + 0.25)).toBeGreaterThanOrEqual(S.LB(r) - 1e-9)
    }
  })
  it('rows off: L rounds up and LB down to the baseline grid', () => {
    const S = sheetOn(own({ rows: { mode: 'off', count: 8 } }))
    expect(S.rows).toEqual([])
    expect(S.L(1)).toBeCloseTo(12, 9)            // 11.5 → up to the unit (2)
    expect(S.LB(8)).toBeCloseTo(50, 9)           // on the unit already
    expect(S.LB(1)).toBeCloseTo(10, 9)           // 11.5 → down
    for (let r = 0; r <= 16; r += 0.5) {
      expect(Math.abs(S.L(r) / 2 - Math.round(S.L(r) / 2))).toBeLessThan(1e-9)
      expect(Math.abs(S.LB(r) / 2 - Math.round(S.LB(r) / 2))).toBeLessThan(1e-9)
    }
  })
  it('a grid with fewer than three rows counts as rows off (the 728×90 banner)', () => {
    const lb = FRAME_FORMATS.find(f => f.id === 'ad-728x90')!
    const r = resolveLayoutGrid(suggestedLayoutGrid(728, 90, lb), 728, 90, lb)
    expect(r.rows.length).toBeLessThan(3)
    const S = makeSheet({ frameW: 728, frameH: 90, measure, layout: r })
    expect(S.rows).toEqual([])
  })
  it('on a band (a story) the rows are in the band\'s coordinates', () => {
    const story = FRAME_FORMATS.find(f => f.id === 'meta-story')!
    const r = resolveLayoutGrid(suggestedLayoutGrid(1080, 1920, story), 1080, 1920, story)
    const S = makeSheet({ frameW: 1080, frameH: 1920, measure, layout: r })
    expect(S.rows[0]!.a + S.Y0).toBeCloseTo(r.rows[0]!.a * 100 / 1080, 9)
    expect(S.L(0) + S.Y0).toBeCloseTo(r.rows[0]!.a * 100 / 1080, 9)
    const last = r.rows[r.rows.length - 1]!
    expect(S.LB(16) + S.Y0).toBeCloseTo((last.a + last.w) * 100 / 1080, 9)
  })
  it('GAP is a whole number of units, at least one', () => {
    const S = sheetOn(own())
    expect(S.GAP / S.U).toBeCloseTo(Math.round(S.GAP / S.U), 9)
    expect(S.GAP).toBeGreaterThanOrEqual(S.U - 1e-9)
  })
  it('rowTop / rowBottom on the kit\'s own sheet are the identity', () => {
    const S = makeSheet({ frameW: 1000, frameH: 1000, measure })
    expect(S.rowTop(13.37)).toBe(13.37)
    expect(S.rowBottom(13.37)).toBe(13.37)
    expect(S.rows).toEqual([])
  })
})

describe('the sheet on the layout grid — L(0) and LB(16) are the resolved grid\'s top and bottom', () => {
  // A Center-fit grid (its left margin x0 = 230 px, far wider than cols.margin 60) and a zero-margin
  // stretch grid (its top forced down to one unit). The band's padding differs from the vertical
  // margins in both; L / LB must still read the resolved top, rows and bottom.
  const center = (rows: LayoutGrid['rows']) => own({ cols: { count: 6, fit: 'center', margin: 60, gutter: 20, width: 60 }, rows })
  const zero = (rows: LayoutGrid['rows']) => own({ cols: { count: 12, fit: 'stretch', margin: 0, gutter: 20, width: 0 }, rows })
  const k = 100 / 1000
  for (const [name, make] of [['Center fit', center], ['zero margin', zero]] as const) {
    for (const rowsOn of [true, false]) {
      it(`${name}, rows ${rowsOn ? 'on' : 'off'}: band and whole sheets`, () => {
        const g = make(rowsOn ? { mode: 'count', count: 6 } : { mode: 'off', count: 6 })
        const r = resolveLayoutGrid(g, 1000, 1000)
        if (rowsOn) expect(r.rows.length).toBeGreaterThanOrEqual(3)
        const last = r.rows[r.rows.length - 1]
        const bottom = rowsOn ? (last!.a + last!.w) * k : r.bottom * k
        for (const whole of [false, true]) {
          const S = makeSheet({ frameW: 1000, frameH: 1000, measure, layout: r, whole })
          expect(S.L(0) + S.Y0).toBeCloseTo(r.top * k, 9)
          expect(S.LB(16) + S.Y0).toBeCloseTo(bottom, 9)
        }
      })
    }
  }
  it('the Center-fit grid really pads its band with x0 (the case this guards)', () => {
    const r = resolveLayoutGrid(center({ mode: 'count', count: 6 }), 1000, 1000)
    expect(r.margin).toBeGreaterThan(r.top + 1)
  })
})

describe('the sheet on the layout grid — type from the Line (stub capitals 0.7 em)', () => {
  const S = sheetOn(own())                       // U = 2 kit units, the Line = 4
  const onUnits = (v: number) => Math.abs(v / S.U - Math.round(v / S.U)) < 1e-9
  it('body text: line spacing = the Line, capitals exactly one unit', () => {
    expect(S.INFO.size * 0.7).toBeCloseTo(S.U, 9)
    expect(S.INFO.lh * S.INFO.size).toBeCloseTo(2 * S.U, 9)
  })
  it('the format\'s legibility floor wins: size at the floor, line spacing whole units ≥ size × 1.3', () => {
    const F = sheetOn(own(), 1000, 1000, { format: { view: 200 } })   // floor 900/200 = 4.5 > 2/0.7
    expect(F.INFO.size).toBeCloseTo(4.5, 9)
    const line = F.INFO.lh * F.INFO.size
    expect(onUnits(line)).toBe(true)
    expect(line).toBeGreaterThanOrEqual(4.5 * 1.3 - 1e-9)
  })
  it('fitSize and sizeFor: whole-unit capitals, never bigger than the fit', () => {
    const raw = 50 * 100 / (6 * 55)             // "Echoes" in 50 units at the stub's 0.55 em per letter
    const f = S.fitSize(['Echoes'], 50)
    expect(f).toBeLessThanOrEqual(raw + 1e-9)
    expect(onUnits(f * 0.7)).toBe(true)
    const s = S.sizeFor(['Weather', 'Report'], 60, 30)
    expect(onUnits(s * 0.7)).toBe(true)
    expect(S.blockH(2, s, S.DISPLAY.lh)).toBeLessThanOrEqual(30 + 1e-9)
  })
  it('qSize up for a layout that must stay at least as big; never under INFO.size when it started above', () => {
    expect(S.qSize(15.15, 'title', 'up') * 0.7 / S.U).toBeCloseTo(6, 9)
    expect(S.qSize(15.15, 'title') * 0.7 / S.U).toBeCloseTo(5, 9)
    expect(S.qSize(S.INFO.size, 'caption')).toBeCloseTo(S.INFO.size, 9)
  })
  it('disp / sec / own quantise size and line spacing; info keeps INFO.size; turned or inside text is left alone', () => {
    const d = S.disp('Echoes', { size: 15.15, x: 0, top: 6 })
    expect(onUnits(d.size * 0.7)).toBe(true)
    expect(onUnits(d.lh * d.size)).toBe(true)
    const i = S.info('Kunstraum Lenz', { x: 0, top: 6 })
    expect(i.size).toBeCloseTo(S.INFO.size, 9)
    expect(onUnits(i.lh * i.size)).toBe(true)
    const turned = S.disp('Echoes', { size: 15.15, x: 0, top: 6, rot: -90 })
    expect(turned.size).toBe(15.15)
    const inside = S.text('Shop now', { size: 3.3, lh: 1, x: 0, top: 6, inside: 'btn' })
    expect(inside.lh).toBe(1)
  })
  it('blockH, gapBelow and groupGap are whole units', () => {
    const s = S.fitSize(['Echoes'], 50)
    expect(onUnits(S.blockH(3, s, S.DISPLAY.lh) - S.CAP * s)).toBe(true)
    expect(onUnits(S.gapBelow(s))).toBe(true)
    expect(onUnits(S.groupGap())).toBe(true)
  })
  it('the kit\'s own sheet is unchanged: qSize and lhFor are the identity', () => {
    const K = makeSheet({ frameW: 1000, frameH: 1000, measure })
    expect(K.qSize(15.15, 'title')).toBe(15.15)
    expect(K.lhFor(15.15, 0.9)).toBe(0.9)
  })
})
