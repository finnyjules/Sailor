// @vitest-environment happy-dom
// The layout grid's editor UI: the overlay (quiet columns, modules only while moving, the
// covered cells in the accent) and the panel section (one patch per committed edit).
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LayoutGridOverlay from '~/components/vue-canvas/LayoutGridOverlay.vue'
import LayoutGridSection from '~/components/vue-canvas/LayoutGridSection.vue'
import { suggestedLayoutGrid, resolveLayoutGrid, patchLayoutGrid, type LayoutGrid } from '~/lib/frame/layoutGrid'

const grid = suggestedLayoutGrid(1080, 1350, null)
const resolved = resolveLayoutGrid(grid, 1080, 1350)

function overlay(p: Partial<{ show: boolean; moving: boolean; covered: any; textMarks: any }> = {}) {
  return mount(LayoutGridOverlay, { props: { grid: resolved, show: true, moving: false, covered: null, w: 540, h: 675, ...p } })
}

describe('LayoutGridOverlay', () => {
  it('draws nothing when the grid is hidden', () => {
    expect(overlay({ show: false }).find('[data-testid="compositor-grid-overlay"]').exists()).toBe(false)
  })
  it('shows faint column edges; modules stay mounted but faded until a layer moves', () => {
    const w = overlay()
    expect(w.findAll('svg').at(0)!.findAll('line').length).toBe(grid.cols.count * 2)
    const mods = w.get('[data-testid="compositor-grid-modules"]')
    expect(mods.classes()).not.toContain('on')
    expect(mods.findAll('rect').length).toBe(resolved.cols.length * resolved.rows.length)
    expect(overlay({ moving: true }).get('[data-testid="compositor-grid-modules"]').classes()).toContain('on')
  })
  it('fills the cells the moving layer covers, only while it moves', () => {
    const c0 = resolved.cols[0]!, c1 = resolved.cols[1]!, r0 = resolved.rows[0]!
    const covered = { x: c0.a, y: r0.a, w: c1.a + c1.w - c0.a, h: r0.w }
    const marks = (w: ReturnType<typeof overlay>) => w.findAll('svg').at(2)!.findAll('rect').length
    expect(marks(overlay({ moving: true, covered }))).toBe(2)
    expect(marks(overlay({ moving: false, covered }))).toBe(0)
  })
  it('keeps hairlines one CSS px at any display size and zoom (non-scaling strokes)', () => {
    // The modal zooms with a CSS transform, so a stroke width computed from the display size is
    // only 1 px at zoom 1 — every stroked line/rect must be a non-scaling 1 px stroke instead.
    const stroked = overlay({ moving: true }).findAll('line, rect').filter(el => el.attributes('stroke'))
    expect(stroked.length).toBeGreaterThan(0)
    for (const el of stroked) {
      expect(el.attributes('stroke-width')).toBe('1')
      expect(el.attributes('vector-effect')).toBe('non-scaling-stroke')
    }
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
    expect(w.findAll('svg').at(2)!.findAll('rect').length).toBe(2)
  })
  it('a one-line text inside a row still covers that row (spans, not half-cell overlap)', () => {
    const c0 = resolved.cols[0]!, r1 = resolved.rows[1]!
    const capsToBaseline = { x: c0.a, y: r1.a, w: c0.w, h: 10 }       // far less than half the row
    const w = overlay({ moving: true, covered: capsToBaseline })
    expect(w.findAll('svg').at(2)!.findAll('rect').length).toBe(1)
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
