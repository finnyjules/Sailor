// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
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
    expect(w.find('[data-shape="sparkle"]').attributes('aria-pressed')).toBe('true')
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

    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).not.toContain('Extraneous')
    }

    expect(w.find('button').text()).toContain('Sparkle')

    await w.find('button').trigger('click')
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    w.unmount()
    warnSpy.mockRestore()
  })
})
