// @vitest-environment happy-dom
//
// Pen stage 6: the list menu and the wheel as components — the menu draws
// the pen's items (heading, groups, keys, greyed items still hoverable), runs
// an enabled item, ignores a greyed one, follows the pen's highlight, closes
// on a click away; the wheel draws eight slices and says what is under the
// pointer, or why it is greyed.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'

vi.mock('~/components/pen/PenTipCard.vue', async () => {
  const { defineComponent: dc } = await import('vue')
  return { default: dc({ setup: (_, { slots }) => () => slots.default?.() }) }
})
vi.mock('~/components/ui/tooltip', async () => {
  const { defineComponent: dc } = await import('vue')
  const pass = dc({ setup: (_, { slots }) => () => slots.default?.() })
  return { TooltipProvider: pass, Tooltip: pass, TooltipTrigger: pass }
})
const { default: PenContextMenu } = await import('~/components/pen/PenContextMenu.vue')
const { default: PenActionWheel } = await import('~/components/pen/PenActionWheel.vue')

const view = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const l = addLine(doc.value, addPoint(doc.value, 2, 5), addPoint(doc.value, 8, 6))
  return { doc, l, pen: usePen({ doc, view: ref(view) }) }
}
let wrapper: ReturnType<typeof mount> | null = null
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = '' })
const q = (s: string) => document.body.querySelector(s) as HTMLElement | null

describe('PenContextMenu', () => {
  it('labels itself by its heading (presentation), and names the pen’s highlight as its active descendant', async () => {
    const { l, pen } = mk()
    pen.pick(l)
    pen.openMenu({ x: 0, y: 0 }, null)
    wrapper = mount(PenContextMenu, { props: { pen } })
    await nextTick()
    const menu = q('[data-pen-menu]')!, head = q('[data-pen-menu-header]')!
    expect(head.getAttribute('role')).toBe('presentation')
    expect(menu.getAttribute('aria-labelledby')).toBe(head.id)
    expect(menu.hasAttribute('aria-activedescendant')).toBe(false)
    pen.setMenuActive('rule:horizontal')
    await nextTick()
    const id = menu.getAttribute('aria-activedescendant')!
    expect(document.getElementById(id)!.getAttribute('data-menu-item')).toBe('rule:horizontal')
  })
  it('draws the heading, the items with keys, greyed ones hoverable; runs an enabled one', async () => {
    const { doc, l, pen } = mk()
    pen.pick(l)
    pen.openMenu({ x: 40, y: 50 }, null)
    wrapper = mount(PenContextMenu, { props: { pen } })
    await nextTick()
    expect(q('[data-pen-menu-header]')!.textContent).toBe('1 line')
    const mirror = q('[data-menu-item="mirror"]')!
    expect(mirror.getAttribute('aria-disabled')).toBe('true')
    expect(mirror.hasAttribute('disabled')).toBe(false)
    expect(q('[data-menu-item="construction"]')!.textContent).toContain('X')
    mirror.click()
    expect(pen.menu.value).not.toBeNull()
    q('[data-menu-item="rule:horizontal"]')!.click()
    expect(pen.menu.value).toBeNull()
    expect(doc.value.constraints.at(-1)!.kind).toBe('horizontal')
  })
  it('follows the pen’s highlight and mouse-enter', async () => {
    const { l, pen } = mk()
    pen.pick(l)
    pen.openMenu({ x: 0, y: 0 }, null)
    wrapper = mount(PenContextMenu, { props: { pen } })
    await nextTick()
    q('[data-menu-item="copy"]')!.dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    expect(pen.menu.value!.active).toBe('copy')
    expect(q('[data-menu-item="copy"]')!.hasAttribute('data-active')).toBe(true)
  })
  it('stays inside the window and closes on a press elsewhere', async () => {
    const { l, pen } = mk()
    pen.pick(l)
    pen.openMenu({ x: window.innerWidth - 2, y: window.innerHeight - 2 }, null)
    wrapper = mount(PenContextMenu, { props: { pen } })
    await nextTick(); await nextTick()
    const el = q('[data-pen-menu]')!
    expect(parseFloat(el.style.left)).toBeLessThanOrEqual(window.innerWidth - 8)
    expect(parseFloat(el.style.top)).toBeLessThanOrEqual(window.innerHeight - 8)
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    expect(pen.menu.value).toBeNull()
  })
})

describe('PenActionWheel', () => {
  it('draws eight slices and names the one under the pointer, or why it is greyed', async () => {
    const { l, pen } = mk()
    pen.pick(l)
    pen.openWheel({ x: 200, y: 200 })
    wrapper = mount(PenActionWheel, { props: { pen } })
    await nextTick()
    expect(document.body.querySelectorAll('[data-wheel-slice]')).toHaveLength(8)
    expect(q('[data-pen-wheel]')!.getAttribute('data-layout')).toBe('segment')
    pen.wheelPointer({ x: 140, y: 140 })
    await nextTick()
    expect(q('[data-wheel-slice="nw"]')!.hasAttribute('data-hover')).toBe(true)
    expect(q('[data-pen-wheel-note]')!.textContent).toBe('Horizontal')
    pen.wheelPointer({ x: 200, y: 130 })
    await nextTick()
    expect(q('[data-wheel-slice="n"]')!.hasAttribute('data-greyed')).toBe(true)
    expect(q('[data-pen-wheel-note]')!.textContent).toBe('Doesn’t apply to this selection')
  })
})
