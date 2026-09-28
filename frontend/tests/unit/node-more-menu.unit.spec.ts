// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import NodeMoreMenu from '~/components/vue-canvas/surfaces/NodeMoreMenu.vue'

enableAutoUnmount(afterEach)

describe('NodeMoreMenu', () => {
  it('opens a menu of its items and runs the picked one', async () => {
    const a = vi.fn(); const b = vi.fn()
    const w = mount(NodeMoreMenu, { props: { items: [{ label: 'Replace', onSelect: a }, { label: 'Lock', onSelect: b, disabled: true }] } })
    expect(w.find('[role="menu"]').exists()).toBe(false)
    await w.find('button[aria-label="More"]').trigger('click')
    const items = w.findAll('[role="menuitem"]')
    expect(items.map(i => i.text())).toEqual(['Replace', 'Lock'])
    await items[1]!.trigger('click')
    expect(b).not.toHaveBeenCalled()
    await items[0]!.trigger('click')
    expect(a).toHaveBeenCalledOnce()
    expect(w.find('[role="menu"]').exists()).toBe(false)
  })
  it('closes on a pointerdown outside', async () => {
    const w = mount(NodeMoreMenu, { props: { items: [{ label: 'Replace', onSelect: () => {} }] }, attachTo: document.body })
    await w.find('button[aria-label="More"]').trigger('click')
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(w.find('[role="menu"]').exists()).toBe(false)
  })
})
