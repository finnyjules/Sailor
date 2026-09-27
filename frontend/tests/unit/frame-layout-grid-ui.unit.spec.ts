// @vitest-environment happy-dom
// The layout grid's editor UI: the overlay (quiet columns, modules only while moving, the
// covered cells in the accent) and the panel section (one patch per committed edit).
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LayoutGridOverlay from '~/components/vue-canvas/LayoutGridOverlay.vue'
import LayoutGridSection from '~/components/vue-canvas/LayoutGridSection.vue'
import LayerGridFields from '~/components/vue-canvas/LayerGridFields.vue'
import { suggestedLayoutGrid, resolveLayoutGrid, patchLayoutGrid, type LayoutGrid } from '~/lib/frame/layoutGrid'

const grid = suggestedLayoutGrid(1080, 1350, null)
const resolved = resolveLayoutGrid(grid, 1080, 1350)

function overlay(p: Partial<{ show: boolean; moving: boolean; covered: any; textMarks: any; w: number; h: number }> = {}) {
  return mount(LayoutGridOverlay, { props: { grid: resolved, show: true, moving: false, covered: null, w: 540, h: 675, ...p } })
}
/** How many closed rectangles (Z) or move-tos (M) a path draws. */
const count = (d: string | undefined, ch: 'M' | 'Z') => (d ?? '').split(ch).length - 1
const dOf = (w: ReturnType<typeof overlay>, id: string) => w.find(`[data-testid="${id}"]`).attributes('d')

describe('LayoutGridOverlay', () => {
  it('draws nothing when the grid is hidden', () => {
    expect(overlay({ show: false }).find('[data-testid="compositor-grid-overlay"]').exists()).toBe(false)
  })
  it('shows faint column edges; modules stay mounted but faded until a layer moves', () => {
    const w = overlay()
    expect(count(dOf(w, 'compositor-grid-columns'), 'M')).toBe(grid.cols.count * 2)
    const mods = w.get('[data-testid="compositor-grid-modules"]')
    expect(mods.classes()).not.toContain('on')
    expect(count(mods.find('path').attributes('d'), 'Z')).toBe(resolved.cols.length * resolved.rows.length)
    expect(overlay({ moving: true }).get('[data-testid="compositor-grid-modules"]').classes()).toContain('on')
  })
  it('fills the cells the moving layer covers, only while it moves', () => {
    const c0 = resolved.cols[0]!, c1 = resolved.cols[1]!, r0 = resolved.rows[0]!
    const covered = { x: c0.a, y: r0.a, w: c1.a + c1.w - c0.a, h: r0.w }
    expect(count(dOf(overlay({ moving: true, covered }), 'compositor-grid-covered'), 'Z')).toBe(2)
    expect(overlay({ moving: false, covered }).find('[data-testid="compositor-grid-covered"]').exists()).toBe(false)
  })
  it('keeps hairlines one CSS px at any display size and zoom (non-scaling strokes)', () => {
    // The modal zooms with a CSS transform, so a stroke width computed from the display size is
    // only 1 px at zoom 1 — every stroked path/line must be a non-scaling 1 px stroke instead.
    const stroked = overlay({ moving: true }).findAll('path, line, rect').filter(el => el.attributes('stroke'))
    expect(stroked.length).toBeGreaterThan(0)
    for (const el of stroked) {
      expect(el.attributes('stroke-width')).toBe('1')
      expect(el.attributes('vector-effect')).toBe('non-scaling-stroke')
    }
  })
  it('draws a fixed handful of shapes, however fine the grid (not one element per line or module)', () => {
    const fine = resolveLayoutGrid(patchLayoutGrid(grid, { columns: 24, rows: 'count', rowCount: 24 }), 1080, 1350)
    const c0 = fine.cols[0]!, r0 = fine.rows[0]!
    const w = mount(LayoutGridOverlay, { props: { grid: fine, show: true, moving: true, covered: { x: c0.a, y: r0.a, w: c0.w * 6, h: r0.w * 6 }, w: 540, h: 675 } })
    expect(w.findAll('path, line, rect').length).toBeLessThanOrEqual(4)
  })
  it('leaves out baselines too dense to read on screen', () => {
    // unit ≈ 20 grid px on a 1080-wide grid: 540 CSS px wide → ~10 px apart (drawn); 100 → ~1.9 px (not).
    expect(overlay({ moving: true }).find('[data-testid="compositor-grid-baselines"]').exists()).toBe(true)
    expect(overlay({ moving: true, w: 100, h: 125 } as any).find('[data-testid="compositor-grid-baselines"]').exists()).toBe(false)
  })
  it('skips module outlines past 2000 modules; the columns still show', () => {
    const tracks = (n: number, size: number) => Array.from({ length: n }, (_, i) => ({ a: i * size, w: size - 1 }))
    const huge = { W: 1000, H: 1000, unit: 5, cols: tracks(24, 1000 / 24), rows: tracks(100, 10), margin: 0, top: 0, bottom: 1000, xs: [], ys: [] }
    const w = mount(LayoutGridOverlay, { props: { grid: huge, show: true, moving: true, covered: null, w: 540, h: 540 } })
    expect(w.get('[data-testid="compositor-grid-modules"]').find('path:not([data-testid])').exists()).toBe(false)
    expect(count(w.get('[data-testid="compositor-grid-columns"]').attributes('d'), 'M')).toBe(48)
  })
  it('a moving cover changes only the covered path; the neutral paths keep their exact strings', async () => {
    const w = overlay({ moving: true })
    const before = [dOf(w, 'compositor-grid-columns'), w.get('[data-testid="compositor-grid-modules"] path').attributes('d')]
    const c0 = resolved.cols[0]!, r0 = resolved.rows[0]!
    await w.setProps({ covered: { x: c0.a, y: r0.a, w: c0.w, h: r0.w } })
    expect([dOf(w, 'compositor-grid-columns'), w.get('[data-testid="compositor-grid-modules"] path').attributes('d')]).toEqual(before)
    expect(count(dOf(w, 'compositor-grid-covered'), 'Z')).toBe(1)
  })
  it('marks the selected text: a dashed accent line at its capitals, a solid one at each baseline', () => {
    const marks = { capTop: 300, baselines: [330, 380], x: 100, w: 400 }
    const t = overlay({ textMarks: marks }).get('[data-testid="compositor-grid-text-marks"]')
    const lines = t.findAll('line')
    expect(lines).toHaveLength(3)
    expect(lines[0]!.attributes('y1')).toBe('300')
    expect(lines[0]!.attributes('stroke-dasharray')).toBeTruthy()
    expect(lines.slice(1).map(l => l.attributes('y1'))).toEqual(['330', '380'])
    expect(lines.slice(1).every(l => !l.attributes('stroke-dasharray'))).toBe(true)
    for (const l of lines) {
      expect(l.attributes('stroke')).toBe('#5b7cff')
      expect(l.attributes('x1')).toBe('100')
      expect(l.attributes('x2')).toBe('500')
      expect(l.attributes('vector-effect')).toBe('non-scaling-stroke')
    }
    expect(overlay().find('[data-testid="compositor-grid-text-marks"]').exists()).toBe(false)
  })
  it('badges a drag with what it covers — modules with rows, columns without', () => {
    const c0 = resolved.cols[0]!, c1 = resolved.cols[1]!, r0 = resolved.rows[0]!
    const two = { x: c0.a, y: r0.a, w: c1.a + c1.w - c0.a, h: r0.w }
    expect(overlay({ moving: true, covered: two }).get('[data-testid="compositor-grid-badge"]').text()).toBe('2 × 1 modules')
    const one = { x: c0.a, y: r0.a, w: c0.w, h: r0.w }
    expect(overlay({ moving: true, covered: one }).get('[data-testid="compositor-grid-badge"]').text()).toBe('1 × 1 module')
    expect(overlay({ moving: false, covered: two }).find('[data-testid="compositor-grid-badge"]').exists()).toBe(false)
    const off = resolveLayoutGrid(patchLayoutGrid(grid, { rows: 'off' }), 1080, 1350)
    const w = mount(LayoutGridOverlay, { props: { grid: off, show: true, moving: true, covered: two, w: 540, h: 675 } })
    expect(w.get('[data-testid="compositor-grid-badge"]').text()).toBe('2 columns')
    expect(count(w.find('[data-testid="compositor-grid-covered"]').attributes('d'), 'Z')).toBe(2)
  })
  it('a one-line text inside a row still covers that row (spans, not half-cell overlap)', () => {
    const c0 = resolved.cols[0]!, r1 = resolved.rows[1]!
    const capsToBaseline = { x: c0.a, y: r1.a, w: c0.w, h: 10 }       // far less than half the row
    const w = overlay({ moving: true, covered: capsToBaseline })
    expect(count(w.find('[data-testid="compositor-grid-covered"]').attributes('d'), 'Z')).toBe(1)
    expect(w.get('[data-testid="compositor-grid-badge"]').text()).toBe('1 × 1 module')
  })
})

describe('LayoutGridSection', () => {
  function section(g: LayoutGrid = grid) {
    return mount(LayoutGridSection, { props: { grid: g, resolved: resolveLayoutGrid(g, 1080, 1350), formatLabel: 'Instagram · 4:5' } })
  }
  it('a committed column count emits one patched grid', async () => {
    const w = section()
    const input = w.get('[data-testid="grid-columns"]')
    ;(input.element as HTMLInputElement).value = '6'
    await input.trigger('change')
    const ev = w.emitted('update')!
    expect(ev).toHaveLength(1)
    expect((ev[0]![0] as LayoutGrid).cols.count).toBe(6)
    expect((ev[0]![0] as LayoutGrid).auto).toBe(false)
  })
  it('a cleared field records nothing and shows the value again', async () => {
    const w = section()
    const input = w.get('[data-testid="grid-columns"]')
    ;(input.element as HTMLInputElement).value = ''
    await input.trigger('change')
    expect(w.emitted('update')).toBeUndefined()
    expect((input.element as HTMLInputElement).value).toBe(String(grid.cols.count))
  })
  it('leaving Stretch starts the fixed width from the columns\' current width', async () => {
    const w = section()
    const btn = w.get('[data-testid="grid-fit"]').findAll('button').find(b => b.text() === 'Center')!
    await btn.trigger('click')
    const g = w.emitted('update')![0]![0] as LayoutGrid
    expect(g.cols.fit).toBe('center')
    expect(g.cols.width).toBe(Math.round(resolved.cols[0]!.w))
  })
  it('the reset button only shows for the user\'s own grid, and returns to the suggested one', async () => {
    expect(section().find('[data-testid="grid-suggested"]').exists()).toBe(false)
    const own = patchLayoutGrid(grid, { columns: 6 })
    const w = section(own)
    await w.get('[data-testid="grid-suggested"]').trigger('click')
    expect((w.emitted('update')![0]![0] as LayoutGrid).auto).toBe(true)
  })
  it('the switch tooltip names the platform\'s shortcut', () => {
    expect(section().get('[data-testid="grid-show"]').attributes('title')).toBe('Show grid (⌃G)')
    const w = mount(LayoutGridSection, { props: { grid, resolved, formatLabel: 'x', showShortcut: 'Ctrl+Shift+4' } })
    expect(w.get('[data-testid="grid-show"]').attributes('title')).toBe('Show grid (Ctrl+Shift+4)')
  })
  it('the switch shows and hides the grid', async () => {
    const w = section()
    await w.get('[data-testid="grid-show"] button').trigger('click')
    expect((w.emitted('update')![0]![0] as LayoutGrid).show).toBe(false)
  })
})

describe('LayerGridFields', () => {
  const base = { span: { col: 2, cols: 3, row: 1, rows: 2 }, colCount: 12, rowCount: 6, canSpanCols: true, canSpanRows: true }
  const fields = (p: Record<string, any> = {}) => mount(LayerGridFields, { props: { ...base, ...p } })
  const commit = async (w: ReturnType<typeof fields>, id: string, v: string) => {
    const input = w.get(`[data-testid="${id}"]`)
    ;(input.element as HTMLInputElement).value = v
    await input.trigger('change')
    return input
  }
  it('labels only: Column, Span, Row, Span', () => {
    const text = fields().get('[data-testid="layer-grid-fields"]').text()
    expect(text).toContain('Column'); expect(text).toContain('Row')
    expect(text.match(/Span/g)).toHaveLength(2)
  })
  it('a committed column emits one patch; values clamp inside the grid', async () => {
    const w = fields()
    await commit(w, 'layer-grid-col', '5')
    await commit(w, 'layer-grid-cols', '40')
    expect(w.emitted('update')).toEqual([[{ col: 5 }], [{ cols: 11 }]])   // 12 − 2 + 1
  })
  it('an unchanged, cleared or junk value records nothing and shows the value again', async () => {
    const w = fields()
    const a = await commit(w, 'layer-grid-col', '2')
    const b = await commit(w, 'layer-grid-row', '')
    expect(w.emitted('update')).toBeUndefined()
    expect((a.element as HTMLInputElement).value).toBe('2')
    expect((b.element as HTMLInputElement).value).toBe('1')
  })
  it('rows only with rows; spans only where the layer can take them; everything off when disabled', () => {
    expect(fields({ span: { col: 1, cols: 1, row: null, rows: null } }).find('[data-testid="layer-grid-row"]').exists()).toBe(false)
    const t = fields({ canSpanRows: false })
    expect(t.get('[data-testid="layer-grid-rows"]').attributes('disabled')).toBeDefined()
    expect(t.get('[data-testid="layer-grid-row"]').attributes('disabled')).toBeUndefined()
    const d = fields({ disabled: true })
    for (const id of ['layer-grid-col', 'layer-grid-cols', 'layer-grid-row', 'layer-grid-rows'])
      expect(d.get(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined()
  })
  it('the Column field stops where the span still fits; so does Row', async () => {
    const w = fields()                                                  // span 3 columns, 2 rows
    expect(w.get('[data-testid="layer-grid-col"]').attributes('max')).toBe('10')   // 12 − 3 + 1
    expect(w.get('[data-testid="layer-grid-row"]').attributes('max')).toBe('5')    // 6 − 2 + 1
    await commit(w, 'layer-grid-col', '12')
    await commit(w, 'layer-grid-row', '6')
    expect(w.emitted('update')).toEqual([[{ col: 10 }], [{ row: 5 }]])
  })
  it('a disabled field says why in its label\'s tooltip', () => {
    const label = (w: ReturnType<typeof fields>, id: string) => w.get(`[data-testid="${id}"]`).element.closest('label')!.getAttribute('title')
    const d = fields({ disabled: true, disabledReason: 'Finish the pen first' })
    for (const id of ['layer-grid-col', 'layer-grid-cols', 'layer-grid-row', 'layer-grid-rows'])
      expect(label(d, id)).toBe('Finish the pen first')
    const s = fields({ canSpanCols: false, canSpanRows: false, colsReason: 'A line can\'t follow columns', rowsReason: 'Text height follows its lines' })
    expect(label(s, 'layer-grid-cols')).toBe('A line can\'t follow columns')
    expect(label(s, 'layer-grid-rows')).toBe('Text height follows its lines')
    expect(label(s, 'layer-grid-col')).toBe('The first column the layer covers')   // enabled: its own hint
    // No reason given: a disabled span still says something.
    const n = fields({ canSpanCols: false, canSpanRows: false })
    expect(label(n, 'layer-grid-cols')).toBeTruthy()
    expect(label(n, 'layer-grid-cols')).not.toBe('How many columns the layer covers')
    expect(label(n, 'layer-grid-rows')).not.toBe('How many rows the layer covers')
  })
})
