// frontend/tests/unit/frame-layout-grid-fit.unit.spec.ts
// Stage 3: the checker's grid rules (11, 12) and the planner's settle, on a synthetic grid.
import { describe, it, expect } from 'vitest'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { checkPlan, textBlocks, textMarks } from '~/lib/frame/patterns/kit/check'
import { settleOnGrid } from '~/lib/frame/patterns/kit/gridFit'
import { resolveLayoutGrid, type LayoutGrid } from '~/lib/frame/layoutGrid'
import type { El, TextEl } from '~/lib/frame/patterns/kit/types'

const measure = makeStubMeasure()
// 1000 × 1000, unit 2 kit units; rows' tops 6, 14, 22 … and bottoms 12, 20, 28 … (kit units).
const g = (rows: LayoutGrid['rows']['mode'] = 'square'): LayoutGrid => ({
  v: 2, auto: false, show: true, line: 40,
  cols: { count: 12, fit: 'stretch', margin: 60, gutter: 20, width: 0 }, rows: { mode: rows, count: 8 },
})
const sheet = (rows: LayoutGrid['rows']['mode'] = 'square') =>
  makeSheet({ frameW: 1000, frameH: 1000, measure, layout: resolveLayoutGrid(g(rows), 1000, 1000), whole: true })
const S = sheet()
// Body text: capitals one unit (2), so its baseline is 2 below its top.
const info = (top: number, x = 6, s = 'Kunstraum Lenz'): TextEl => S.info(s, { x, w: 30, top, role: 'caption' })
const grid = (issues: string[]) => issues.filter(i => /baseline grid|not on a row/.test(i))

describe('rule 11 — text on the baseline grid', () => {
  it('a line whose baseline is on the unit passes; half a unit off fails', () => {
    expect(grid(checkPlan([info(14)], S))).toEqual([])
    expect(grid(checkPlan([info(15)], S))).toContain('caption: off the baseline grid')
  })
  it('turned text and text inside a shape are exempt', () => {
    const turned = S.disp('Echoes', { size: 10, x: 6, top: 17.3, rot: -90, role: 'title' })
    const label = S.text('Shop now', { size: 3, lh: 1, x: 6, top: 17.3, inside: 'btn', role: 'action' })
    expect(grid(checkPlan([turned, label], S))).toEqual([])
  })
  it('the kit\'s own sheet has no grid rules', () => {
    const K = makeSheet({ frameW: 1000, frameH: 1000, measure })
    expect(grid(checkPlan([K.info('x', { x: 6, w: 30, top: 17.3 })], K))).toEqual([])
  })
})

describe('rule 12 — with rows, each block on a row', () => {
  it('capitals on a row top pass; the last baseline on a row bottom passes; mid-row fails', () => {
    expect(grid(checkPlan([info(14)], S))).toEqual([])
    expect(grid(checkPlan([info(18)], S))).toEqual([])            // baseline 20: a row bottom
    expect(grid(checkPlan([info(16)], S))).toContain('caption: not on a row')
  })
  it('a stack is one block: only its first capitals (or last baseline) must be on a row', () => {
    const a = info(14), b = info(18, 6, 'Lenzgasse 14')         // 2 below a's baseline: stacked
    expect(textBlocks([a, b], S)).toHaveLength(1)
    expect(grid(checkPlan([a, b], S))).toEqual([])
  })
  it('rows off: rule 12 does not apply', () => {
    const O = sheet('off')
    expect(grid(checkPlan([O.info('x', { x: 6, w: 30, top: 16 })], O))).toEqual([])
  })
  it('text free to lie anywhere (ok) or bleeding is exempt from rule 12', () => {
    const t = { ...info(16), ok: true }
    expect(grid(checkPlan([t], S))).toEqual([])
  })
})

describe('settleOnGrid', () => {
  it('a block within a unit of a row top moves onto it', () => {
    const t = info(14.6)
    settleOnGrid([t], S)
    expect(t.top).toBeCloseTo(14, 9)
  })
  it('a block within a unit of a row bottom stands on it', () => {
    const t = info(17.3)                                          // baseline 19.3; row bottom 20
    settleOnGrid([t], S)
    expect(textMarks(t, S).baselines[0]).toBeCloseTo(20, 9)
  })
  it('a stack moves together; rows off, each line only rounds its baseline', () => {
    const a = info(14.6), b = info(18.6, 6, 'Lenzgasse 14')
    settleOnGrid([a, b], S)
    expect(a.top).toBeCloseTo(14, 9)
    expect(b.top).toBeCloseTo(18, 9)
    const O = sheet('off')
    const c = O.info('x', { x: 6, w: 30, top: 16.7 })             // baseline 18.7 → 18 (nearest unit)
    settleOnGrid([c], O)
    expect(textMarks(c, O).baselines[0]).toBeCloseTo(18, 9)
  })
  it('after settling, rules 11 and 12 hold', () => {
    const els: El[] = [info(14.6), info(18.6, 6, 'Lenzgasse 14'), info(40.9, 40, '19.09.–15.11.2026')]
    settleOnGrid(els, S)
    expect(grid(checkPlan(els, S))).toEqual([])
  })
  it('does nothing on the kit\'s own sheet', () => {
    const K = makeSheet({ frameW: 1000, frameH: 1000, measure })
    const t = K.info('x', { x: 6, w: 30, top: 17.3 })
    settleOnGrid([t], K)
    expect(t.top).toBe(17.3)
  })
})
