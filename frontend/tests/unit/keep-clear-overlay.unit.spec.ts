// @vitest-environment happy-dom
//
// The Layout tab's covered-areas overlay (Stage 2, Task 8): the areas a format's platform covers,
// hatched over the artboard. It is an editor guide only and must never catch the pointer.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import KeepClearOverlay from '~/components/vue-canvas/compositor/KeepClearOverlay.vue'
import LayoutVaryPanel from '~/components/vue-canvas/compositor/LayoutVaryPanel.vue'

const keep = { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 }

describe('KeepClearOverlay', () => {
  it('draws two labelled bars, keep.top·h and keep.bottom·h tall, and two side strips between them', () => {
    const w = 300, h = 400
    const wrap = mount(KeepClearOverlay, { props: { keep, w, h } })
    const top = wrap.get('[data-keep="top"]'), bottom = wrap.get('[data-keep="bottom"]')
    expect(Number(top.attributes('height'))).toBeCloseTo(keep.top * h)
    expect(Number(top.attributes('y'))).toBe(0)
    expect(Number(bottom.attributes('height'))).toBeCloseTo(keep.bottom * h)
    expect(Number(bottom.attributes('y'))).toBeCloseTo(h - keep.bottom * h)
    const left = wrap.get('[data-keep="left"]'), right = wrap.get('[data-keep="right"]')
    expect(Number(left.attributes('width'))).toBeCloseTo(keep.left * w)
    expect(Number(right.attributes('x'))).toBeCloseTo(w - keep.right * w)
    expect(Number(left.attributes('y'))).toBeCloseTo(keep.top * h)
    expect(Number(left.attributes('height'))).toBeCloseTo(h - keep.top * h - keep.bottom * h)
    const labels = wrap.findAll('text').map(t => t.text())
    expect(labels).toEqual(['Covered by the app', 'Covered by the app'])
  })

  it('on a format that may crop its edges, the bars say so', () => {
    const wrap = mount(KeepClearOverlay, { props: { keep: { top: 0.1, bottom: 0.1, left: 0.1, right: 0.1 }, w: 300, h: 300, kind: 'crop' as const } })
    expect(wrap.findAll('text').map(t => t.text())).toEqual(['May be cropped', 'May be cropped'])
    expect(wrap.findAll('[data-keep]').length).toBe(4)
  })

  it('never catches the pointer', () => {
    const wrap = mount(KeepClearOverlay, { props: { keep, w: 300, h: 400 } })
    const root = wrap.get('[data-testid="keep-clear-overlay"]')
    expect(root.classes()).toContain('pointer-events-none')
    expect((root.element as SVGElement).getAttribute('style') ?? '').toContain('pointer-events: none')
  })

  it('leaves out an area of zero size', () => {
    const wrap = mount(KeepClearOverlay, { props: { keep: { top: 0.1, bottom: 0, left: 0, right: 0 }, w: 300, h: 400 } })
    expect(wrap.find('[data-keep="top"]').exists()).toBe(true)
    expect(wrap.find('[data-keep="bottom"]').exists()).toBe(false)
    expect(wrap.find('[data-keep="left"]').exists()).toBe(false)
    expect(wrap.findAll('text').length).toBe(1)
  })
})

// The Layout tab's words for the same format: its name, its rules, and the lines it leaves out.
describe('LayoutVaryPanel — the format', () => {
  const base = { name: 'Statement', candidates: [], index: 0, choices: [], library: [], layoutId: 'statement', applied: true, frameW: 160, frameH: 90 }
  const stubs = { LayoutTile: true }

  it('names the format, gives its rules, and quotes the hidden lines (24 characters, then an ellipsis)', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, format: {
      label: 'Video thumbnail · 16:9',
      notes: ['Seen about 170 px wide, so no text is smaller than 9 px there.', 'Carries the two most important lines.'],
      hidden: ['19.09.–15.11.2026', 'Kunstraum Lenz, Hauptstraße 12, Basel'],
    } }, global: { stubs } })
    const block = wrap.get('[data-testid="layout-format"]')
    expect(wrap.get('[data-testid="layout-format-label"]').text()).toBe('Format: Video thumbnail · 16:9')
    expect(block.text()).toContain('Seen about 170 px wide, so no text is smaller than 9 px there.')
    expect(block.text()).toContain('Carries the two most important lines.')
    expect(wrap.get('[data-testid="layout-format-hidden"]').text())
      .toBe('Not shown in this format: “19.09.–15.11.2026”, “Kunstraum Lenz, Hauptstr…”.')
  })

  it('shows nothing about a format when the Frame has none', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, format: null }, global: { stubs } })
    expect(wrap.find('[data-testid="layout-format"]').exists()).toBe(false)
  })
})
