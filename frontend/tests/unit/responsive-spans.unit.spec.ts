// @vitest-environment happy-dom
// frontend/tests/unit/responsive-spans.unit.spec.ts — a responsive Frame's layers hold to the
// columns (and rows) they cover on the Frame's layout grid (spec "Responsive Frames").
import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer, textVAlignCenterOffset, type LocalLayer } from '~/composables/useCompositorLayers'
import { resolveLayoutGrid, type LayoutGrid } from '~/lib/frame/layoutGrid'
import { textMetrics } from '~/lib/frame/textMetrics'
import { gridsAt, holdRows, holdOf, textRowBox } from '~/lib/frame/responsive/spans'
import { buildUnits } from '~/lib/frame/responsive/units'

/** An own grid: 2 columns of 500 on a 1000-wide design (margin 0, gutter 0), rows off, unit 20. */
const own = (over: Partial<LayoutGrid> = {}): LayoutGrid => ({
  v: 2, auto: false, show: true, line: 40,
  cols: { count: 2, fit: 'stretch', margin: 0, gutter: 0, width: 0 },
  rows: { mode: 'off', count: 4 }, ...over,
})
const W0 = 1000, H0 = 1000
const unitOf = (l: LocalLayer) => buildUnits([l], [], null, W0, H0)[0]!

describe('gridsAt', () => {
  const g = own({ cols: { count: 12, fit: 'stretch', margin: 40, gutter: 20, width: 0 }, rows: { mode: 'square', count: 8 } })
  it('resolves the grid at the design size, and at the view with its px scaled by the fit scale', () => {
    const p = gridsAt(g, null, 1000, 500, 3000, 500)!
    expect(p.s).toBe(1)
    expect(p.design).toEqual(resolveLayoutGrid(g, 1000, 500, null))
    expect(p.view).toEqual(resolveLayoutGrid(g, 3000, 500, null, 1))
  })
  it('at the same shape the view grid is the design grid scaled (the resolver\'s identity fast path relies on it)', () => {
    const p = gridsAt(g, null, 1080, 1350, 540, 675)!
    expect(p.s).toBe(0.5)
    expect(p.view.cols.length).toBe(p.design.cols.length)
    expect(p.view.rows.length).toBe(p.design.rows.length)
    p.view.cols.forEach((c, i) => { expect(c.a).toBeCloseTo(p.design.cols[i]!.a / 2, 9); expect(c.w).toBeCloseTo(p.design.cols[i]!.w / 2, 9) })
    p.view.rows.forEach((r, i) => { expect(r.a).toBeCloseTo(p.design.rows[i]!.a / 2, 9); expect(r.w).toBeCloseTo(p.design.rows[i]!.w / 2, 9) })
  })
  it('null without a grid or with an empty size', () => {
    expect(gridsAt(null, null, 10, 10, 10, 10)).toBeNull()
    expect(gridsAt(own(), null, 0, 10, 10, 10)).toBeNull()
    expect(gridsAt(own(), null, 10, 10, 10, 0)).toBeNull()
  })
})

describe('holdRows', () => {
  it('the same rows when the count is the same', () => expect(holdRows(2, 3, 8, 8)).toEqual([2, 3]))
  it('first rows stay first; last rows stay last', () => {
    expect(holdRows(0, 1, 8, 12)).toEqual([0, 1])
    expect(holdRows(6, 7, 8, 12)).toEqual([10, 11])
    expect(holdRows(6, 7, 8, 5)).toEqual([3, 4])
    expect(holdRows(0, 1, 8, 5)).toEqual([0, 1])
  })
  it('nearer the top counts from the top; nearer the bottom, from the bottom', () => {
    expect(holdRows(1, 2, 8, 12)).toEqual([1, 2])     // 1 above, 5 below
    expect(holdRows(5, 6, 8, 12)).toEqual([9, 10])    // 5 above, 1 below
  })
  it('in the middle it keeps its place from the middle', () => {
    expect(holdRows(3, 4, 8, 12)).toEqual([5, 6])     // 3 above, 3 below → +2
    expect(holdRows(2, 4, 8, 12)).toEqual([4, 6])     // 2 above, 3 below → +2
    expect(holdRows(1, 1, 3, 7)).toEqual([3, 3])
  })
  it('every row stays every row', () => expect(holdRows(0, 7, 8, 12)).toEqual([0, 11]))
  it('never more rows than the view has, never past either end', () => {
    expect(holdRows(1, 6, 8, 3)).toEqual([0, 2])
    expect(holdRows(0, 2, 8, 2)).toEqual([0, 1])
  })
  it('no rows at the view: null (the axis holds to the frame)', () => {
    expect(holdRows(0, 0, 4, 0)).toBeNull()
  })
})

describe('holdOf', () => {
  it('a box on a column holds to it across; with rows off it holds to the frame down', () => {
    const p = gridsAt(own(), null, W0, H0, 3000, 1000)!
    const l = createRectLayer({ id: 'a', x: 0.45, y: 0.5, w: 0.05, h: 0.1 })     // 425..475, in column 1
    const h = holdOf(unitOf(l), l, p, W0, H0, 3000, 1000, null)
    expect(h.onGrid).toEqual({ h: true, v: false })
    expect(h.h).toEqual({ dStart: 0, dExtent: 500, bStart: 0, bExtent: 1500 })
    expect(h.v).toEqual({ dStart: 0, dExtent: 1000, bStart: 0, bExtent: 1000 })
  })
  it('within one unit of its columns it still holds; further out it holds to the frame', () => {
    const p = gridsAt(own(), null, W0, H0, 3000, 1000)!
    const near = createRectLayer({ id: 'n', x: 0.26, y: 0.5, w: 0.51, h: 0.1 })   // 5..515: 15 px past column 1
    expect(holdOf(unitOf(near), near, p, W0, H0, 3000, 1000, null).onGrid.h).toBe(true)
    const far = createRectLayer({ id: 'f', x: 0.48, y: 0.5, w: 0.16, h: 0.1 })    // 400..560: 60 px past column 1
    const h = holdOf(unitOf(far), far, p, W0, H0, 3000, 1000, null)
    expect(h.onGrid.h).toBe(false)
    expect(h.h).toEqual({ dStart: 0, dExtent: 1000, bStart: 0, bExtent: 3000 })
  })
  it('holdTo frame holds to the frame on both axes', () => {
    const p = gridsAt(own(), null, W0, H0, 3000, 1000)!
    const l = createRectLayer({ id: 'a', x: 0.45, y: 0.5, w: 0.05, h: 0.1, pins: { holdTo: 'frame' } })
    expect(holdOf(unitOf(l), l, p, W0, H0, 3000, 1000, null).onGrid).toEqual({ h: false, v: false })
  })
  it('an unknown stored holdTo (older data) reads as automatic: it holds to the grid', () => {
    const p = gridsAt(own(), null, W0, H0, 3000, 1000)!
    const l = createRectLayer({ id: 'a', x: 0.45, y: 0.5, w: 0.05, h: 0.1, pins: { holdTo: 'section' as any } })
    expect(holdOf(unitOf(l), l, p, W0, H0, 3000, 1000, null).onGrid.h).toBe(true)
  })
  it('no grid: the frame, exactly the rectangle resolve used before', () => {
    const l = createRectLayer({ id: 'a', x: 0.45, y: 0.5, w: 0.05, h: 0.1 })
    const h = holdOf(unitOf(l), l, null, W0, H0, 3000, 1000, null)
    expect(h).toEqual({
      h: { dStart: 0, dExtent: 1000, bStart: 0, bExtent: 3000 }, v: { dStart: 0, dExtent: 1000, bStart: 0, bExtent: 1000 },
      onGrid: { h: false, v: false }, vBox: { y: 450, h: 100 }, vCanStretch: true,
    })
  })
  it('the last row stays the last row in a taller view', () => {
    const g = own({ cols: { count: 4, fit: 'stretch', margin: 0, gutter: 0, width: 0 }, rows: { mode: 'square', count: 8 } })
    const p = gridsAt(g, null, W0, H0, 1000, 2000)!
    expect(p.view.rows.length).toBeGreaterThan(p.design.rows.length)
    const last = p.design.rows[p.design.rows.length - 1]!, c = p.design.cols[1]!
    const l = createRectLayer({ id: 'r', x: (c.a + c.w / 2) / W0, y: (last.a + last.w / 2) / H0, w: c.w / W0, h: last.w / W0 })
    const h = holdOf(unitOf(l), l, p, W0, H0, 1000, 2000, null)
    const vl = p.view.rows[p.view.rows.length - 1]!
    expect(h.onGrid).toEqual({ h: true, v: true })
    expect(h.v.dStart).toBeCloseTo(last.a, 9)
    expect(h.v.bStart).toBeCloseTo(vl.a, 9)
    expect(h.v.bExtent).toBeCloseTo(vl.w, 9)
    expect(h.vCanStretch).toBe(true)                  // a box may stretch over its rows
  })
  it('a lone text reads its rows from its capitals to its last baseline, and never stretches down its rows', () => {
    const g = own({ cols: { count: 4, fit: 'stretch', margin: 0, gutter: 0, width: 0 }, rows: { mode: 'square', count: 8 } })
    const p = gridsAt(g, null, W0, H0, 1000, 2000)!
    const row = p.design.rows[1]!
    const t = createTextLayer({ id: 't', text: 'Hello', x: 0.375, y: (row.a + row.w / 2) / H0, fontSize: 0.03, boxW: 0.2 })
    const m = textMetrics(t as any, W0)!
    const top = t.y * H0 + textVAlignCenterOffset(t, m.boxH) - m.boxH / 2
    expect(textRowBox(t, W0, H0, null)).toEqual({ y: top + m.capTop, h: m.baselines[m.baselines.length - 1]! - m.capTop })
    const h = holdOf(unitOf(t), t, p, W0, H0, 1000, 2000, null)
    expect(h.onGrid.v).toBe(true)
    expect(h.vBox.y).toBeCloseTo(top + m.capTop, 9)
    expect(h.vCanStretch).toBe(false)
  })
  it('rotated text reads its rows by its box', () => {
    const t = createTextLayer({ id: 't', text: 'Hello', x: 0.5, y: 0.5, fontSize: 0.03, rotation: 30 })
    expect(textRowBox(t, W0, H0, null)).toBeNull()
    expect(textRowBox(createRectLayer({}), W0, H0, null)).toBeNull()
    expect(textRowBox(undefined, W0, H0, null)).toBeNull()
  })
})
