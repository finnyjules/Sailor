// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { nextTick } from 'vue'
import NodeMoreMenu from '~/components/vue-canvas/surfaces/NodeMoreMenu.vue'

enableAutoUnmount(afterEach)

// The menu is teleported to <body>, so it is looked up there, not inside the wrapper.
const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]')
const menuItems = () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
async function flush() { await nextTick(); await nextTick() }

function mountMenu(items: { label: string; onSelect: () => void; disabled?: boolean }[]) {
  return mount(NodeMoreMenu, { props: { items }, attachTo: document.body })
}

describe('NodeMoreMenu', () => {
  it('opens a menu of its items on <body> and runs the picked one', async () => {
    const a = vi.fn(); const b = vi.fn()
    const w = mountMenu([{ label: 'Replace', onSelect: a }, { label: 'Lock', onSelect: b, disabled: true }])
    expect(menu()).toBeNull()
    await w.find('button[aria-label="More"]').trigger('click')
    await flush()
    expect(menu()).not.toBeNull()
    expect(w.element.contains(menu())).toBe(false)
    expect(menu()!.parentElement).toBe(document.body)
    expect(menu()!.className).toMatch(/\bfixed\b/)
    expect(menu()!.className).toMatch(/z-\[1000\]/)
    expect(menuItems().map(i => i.textContent)).toEqual(['Replace', 'Lock'])
    expect(menuItems()[0]!.className).toMatch(/text-\[13px\]/)
    menuItems()[1]!.click()
    await flush()
    expect(b).not.toHaveBeenCalled()
    menuItems()[0]!.click()
    await flush()
    expect(a).toHaveBeenCalledOnce()
    expect(menu()).toBeNull()
  })

  it('reports its open state on the button', async () => {
    const w = mountMenu([{ label: 'Replace', onSelect: () => {} }])
    const btn = w.find('button[aria-label="More"]')
    expect(btn.attributes('aria-haspopup')).toBe('menu')
    expect(btn.attributes('aria-expanded')).toBe('false')
    await btn.trigger('click'); await flush()
    expect(btn.attributes('aria-expanded')).toBe('true')
  })

  it('closes on a pointerdown outside, not on one inside the menu', async () => {
    const w = mountMenu([{ label: 'Replace', onSelect: () => {} }])
    await w.find('button[aria-label="More"]').trigger('click'); await flush()
    menu()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flush()
    expect(menu()).not.toBeNull()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flush()
    expect(menu()).toBeNull()
  })

  it('closes on wheel and on resize', async () => {
    const w = mountMenu([{ label: 'Replace', onSelect: () => {} }])
    const btn = w.find('button[aria-label="More"]')
    await btn.trigger('click'); await flush()
    window.dispatchEvent(new WheelEvent('wheel'))
    await flush()
    expect(menu()).toBeNull()
    await btn.trigger('click'); await flush()
    window.dispatchEvent(new Event('resize'))
    await flush()
    expect(menu()).toBeNull()
  })

  it('opening focuses the first enabled item; Escape closes and returns focus to the button', async () => {
    const w = mountMenu([{ label: 'Off', onSelect: () => {}, disabled: true }, { label: 'Replace', onSelect: () => {} }])
    await w.find('button[aria-label="More"]').trigger('click'); await flush()
    expect(document.activeElement?.textContent).toBe('Replace')
    key('Escape'); await flush()
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(w.find('button[aria-label="More"]').element)
  })

  it('ArrowDown / ArrowUp move between enabled items, wrapping, skipping disabled ones', async () => {
    const w = mountMenu([
      { label: 'Replace', onSelect: () => {} },
      { label: 'Lock', onSelect: () => {}, disabled: true },
      { label: 'Re-render', onSelect: () => {} },
    ])
    await w.find('button[aria-label="More"]').trigger('click'); await flush()
    expect(document.activeElement?.textContent).toBe('Replace')
    key('ArrowDown'); expect(document.activeElement?.textContent).toBe('Re-render')
    key('ArrowDown'); expect(document.activeElement?.textContent).toBe('Replace')
    key('ArrowUp'); expect(document.activeElement?.textContent).toBe('Re-render')
    key('ArrowUp'); expect(document.activeElement?.textContent).toBe('Replace')
  })

  it('listens on window only while open, and stops on close and unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const w = mountMenu([{ label: 'Replace', onSelect: () => {} }])
    const kinds = (spy: typeof add) => spy.mock.calls.map(c => c[0]).filter(k => ['pointerdown', 'keydown', 'wheel', 'resize'].includes(k as string))
    expect(kinds(add)).toEqual([])
    await w.find('button[aria-label="More"]').trigger('click'); await flush()
    expect(kinds(add).sort()).toEqual(['keydown', 'pointerdown', 'resize', 'wheel'])
    key('Escape'); await flush()
    expect(kinds(remove).sort()).toEqual(['keydown', 'pointerdown', 'resize', 'wheel'])
    remove.mockClear()
    await w.find('button[aria-label="More"]').trigger('click'); await flush()
    w.unmount()
    expect(kinds(remove).sort()).toEqual(['keydown', 'pointerdown', 'resize', 'wheel'])
    add.mockRestore(); remove.mockRestore()
  })

  it('renders nothing, not even the button, when it has no items', () => {
    const w = mountMenu([])
    expect(w.find('button[aria-label="More"]').exists()).toBe(false)
    expect(w.html()).not.toMatch(/<button/)
  })
})
