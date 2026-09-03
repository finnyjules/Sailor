// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ShapePicker from '../../app/components/vue-canvas/studio/ShapePicker.vue'
import RowShape from '../../app/components/vue-canvas/studio/rows/RowShape.vue'

const mountPicker = (props: Partial<{ modelValue: string; allowNone: boolean }> = {}) =>
  mount(ShapePicker, {
    props: { modelValue: 'none', anchor: { x: 10, y: 10 }, ...props },
    attachTo: document.body,
    global: { stubs: { Teleport: true } },
  })

describe('ShapePicker', () => {
  it('shows a None tile, all 100 shapes, and marks the current one', () => {
    const w = mountPicker({ modelValue: 'sparkle' })
    expect(w.find('[data-shape="none"]').exists()).toBe(true)
    expect(w.findAll('[data-shape]').length).toBe(101)
    expect(w.find('[data-shape="sparkle"]').attributes('aria-selected')).toBe('true')
    w.unmount()
  })
  it('hides None when allowNone is false', () => {
    const w = mountPicker({ allowNone: false })
    expect(w.find('[data-shape="none"]').exists()).toBe(false)
    expect(w.findAll('[data-shape]').length).toBe(100)
    w.unmount()
  })
  it('filters by search and by family', async () => {
    const w = mountPicker()
    await w.find('input[type="search"]').setValue('sun')
    const ids = w.findAll('[data-shape]').map(b => b.attributes('data-shape'))
    expect(ids).toContain('sun-rays')
    expect(ids).not.toContain('circle')
    await w.find('input[type="search"]').setValue('')
    await w.find('[data-family="diagram"]').trigger('click')
    expect(w.findAll('[data-shape]').map(b => b.attributes('data-shape'))).toEqual(['none', 'circle-network', 'diagram-venn', 'pie-chart', 'stairs'])
    w.unmount()
  })
  it('emits the picked id and closes', async () => {
    const w = mountPicker()
    await w.find('[data-shape="sparkle"]').trigger('click')
    expect(w.emitted('update:modelValue')).toEqual([['sparkle']])
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })
  // The spec's keyboard contract: arrows move, Enter picks, Escape closes.
  // The grid is 5 columns, so ArrowDown is +5 tiles, not +1.
  it('moves focus with the arrow keys and picks with Enter', async () => {
    const w = mountPicker()
    const tiles = w.findAll('[data-shape]').map(t => t.element as HTMLElement)
    tiles[0]!.focus()

    tiles[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(tiles[1])

    tiles[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(tiles[6])

    const focused = document.activeElement as HTMLElement
    focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(w.emitted('update:modelValue')).toEqual([[focused.dataset.shape]])
    w.unmount()
  })
  it('clamps arrow movement at both ends and jumps with Home/End', async () => {
    const w = mountPicker()
    const tiles = w.findAll('[data-shape]').map(t => t.element as HTMLElement)
    tiles[0]!.focus()
    tiles[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(document.activeElement).toBe(tiles[0])
    tiles[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(document.activeElement).toBe(tiles[tiles.length - 1])
    w.unmount()
  })
  it('ArrowDown from the search box moves focus onto the current shape', async () => {
    const w = mountPicker({ modelValue: 'sparkle' })
    const input = w.find('input[type="search"]').element as HTMLInputElement
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect((document.activeElement as HTMLElement).dataset.shape).toBe('sparkle')
    w.unmount()
  })
  it('mirrors the pressed state as aria-selected for the listbox role', () => {
    const w = mountPicker({ modelValue: 'sparkle' })
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    const tile = w.find('[data-shape="sparkle"]')
    expect(tile.attributes('role')).toBe('option')
    expect(tile.attributes('aria-selected')).toBe('true')
    expect(w.find('[data-shape="none"]').attributes('aria-selected')).toBe('false')
    w.unmount()
  })
  it('closes on Escape', async () => {
    const w = mountPicker()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })
})

describe('RowShape', () => {
  it('mounts as a single root, so StudioRow-provided commit/cancel listeners inherit cleanly (no extraneous-listener warning), and opens the picker on click', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = mount(RowShape, {
      props: {
        value: 'sparkle',
        spec: { key: 'separator', label: 'Separator', kind: 'shape', default: 'none', group: 'Type' },
        step: 1,
        editing: false,
      },
      attrs: { onCommit: () => {}, onCancel: () => {} },
      attachTo: document.body,
    })

    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('Extraneous'))).toEqual([])

    expect(w.find('button').text()).toContain('Sparkle')

    // `trigger('click')` alone dispatches no `mousedown`, so it can't tell
    // apart the real toggle from a version that lacks the picker's `ignore`
    // wiring (the outside-click handler listens on `mousedown`, capture
    // phase). Dispatch both events, like a real press does, so this test
    // actually discriminates the two.
    const btn = w.find('button').element
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    // The button is the picker's `ignore` element, so it never doubles as an
    // outside click — a second press is a plain toggle back to closed.
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    w.unmount()
    warnSpy.mockRestore()
  })
})
