// @vitest-environment happy-dom
//
// Pen stage 6, PenOverlay: a right press on a piece selects it first (in
// Select) and its release opens the list menu; on empty space the selection
// clears; a right drag past 12 px opens the wheel at the press point and the
// release runs the slice; a draw tool's half-drawn path survives a right
// click; keys go to the open menu; the hover highlight is drawn; host attrs
// still land on the svg.
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
// PenOverlay reads the platform once at import: a Mac, so a ctrl-click is a right press
Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
const { default: PenOverlay } = await import('~/components/pen/PenOverlay.vue')

const view = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mountIt(keyboard?: 'host', active = true) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const l = addLine(doc.value, addPoint(doc.value, 2, 5), addPoint(doc.value, 8, 6))
  const pen = usePen({ doc, view: ref(view) })
  const wrapper = mount(PenOverlay, {
    props: { pen, view, width: 680, height: 460, active, ...(keyboard ? { keyboard } : {}) },
    attrs: { 'data-testid': 'host-overlay', class: 'host-class' },
    attachTo: document.body,
  })
  return { wrapper, doc, pen, l }
}
let wrapper: ReturnType<typeof mount> | null = null
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = '' })
const R = (x: number, y: number) => ({ button: 2, buttons: 2, clientX: x, clientY: y, pointerId: 1 })
const L = (x: number, y: number, buttons = 1) => ({ button: 0, buttons, clientX: x, clientY: y, pointerId: 3 })

describe('PenOverlay right press', () => {
  it('host attrs land on the svg', () => {
    const m = mountIt(); wrapper = m.wrapper
    const svg = m.wrapper.find('svg[data-pen-overlay]')
    expect(svg.attributes('data-testid')).toBe('host-overlay')
    expect(svg.classes()).toContain('host-class')
  })
  it('selects the piece under it, and the release opens the list menu', async () => {
    const m = mountIt(); wrapper = m.wrapper
    await m.wrapper.find(`[data-ent="${m.l}"]`).trigger('pointerdown', R(200, 210))
    expect(m.pen.selection.value).toEqual([m.l])
    await m.wrapper.find('svg').trigger('pointerup', R(200, 210))
    expect(m.pen.menu.value!.header).toBe('1 line')
    expect(m.pen.menu.value!.at).toEqual({ x: 200, y: 210 })
    await nextTick()
    expect(document.body.querySelector('[data-pen-menu]')).not.toBeNull()
  })
  it('a Mac ctrl-click is a right press too', async () => {
    const m = mountIt(); wrapper = m.wrapper
    const C = { button: 0, buttons: 1, ctrlKey: true, clientX: 200, clientY: 210, pointerId: 4 }
    await m.wrapper.find(`[data-ent="${m.l}"]`).trigger('pointerdown', C)
    await m.wrapper.find('svg').trigger('pointerup', C)
    expect(m.pen.selection.value).toEqual([m.l])
    expect(m.pen.menu.value!.header).toBe('1 line')
  })
  it('on empty space it clears the selection and offers Paste and Select all', async () => {
    const m = mountIt(); wrapper = m.wrapper
    m.pen.pick(m.l)
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointerdown', R(600, 40))
    await svg.trigger('pointerup', R(600, 40))
    expect(m.pen.selection.value).toEqual([])
    expect(m.pen.menu.value!.groups.flat().map(i => i.id)).toEqual(['paste', 'select-all'])
  })
  it('a right drag opens the wheel at the press point; the release runs the slice', async () => {
    const m = mountIt(); wrapper = m.wrapper
    await m.wrapper.find(`[data-ent="${m.l}"]`).trigger('pointerdown', R(200, 210))
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointermove', R(195, 205))
    expect(m.pen.wheel.value).toBeNull()                      // under 12 px
    await svg.trigger('pointermove', R(150, 160))
    expect(m.pen.wheel.value!.at).toEqual({ x: 200, y: 210 })
    expect(m.pen.wheel.value!.hover).toBe('nw')
    await nextTick()
    expect(document.body.querySelector('[data-pen-wheel]')).not.toBeNull()
    await svg.trigger('pointerleave', R(150, 160))             // the svg holds the pointer: a leave is ignored
    expect(m.pen.wheel.value).not.toBeNull()
    await svg.trigger('pointerup', R(150, 160))
    expect(m.pen.wheel.value).toBeNull()
    expect(m.pen.menu.value).toBeNull()
    expect(m.doc.value.constraints.at(-1)!.kind).toBe('horizontal')
  })
  it('a wheel release back in the dead centre does nothing', async () => {
    const m = mountIt(); wrapper = m.wrapper
    await m.wrapper.find(`[data-ent="${m.l}"]`).trigger('pointerdown', R(200, 210))
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointermove', R(150, 160))
    await svg.trigger('pointermove', R(210, 215))
    await svg.trigger('pointerup', R(210, 215))
    expect(m.pen.wheel.value).toBeNull()
    expect(m.pen.menu.value).toBeNull()
    expect(m.doc.value.constraints).toHaveLength(0)
  })
  it('a right drag with nothing selected opens nothing, and its release does nothing', async () => {
    const m = mountIt(); wrapper = m.wrapper
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointerdown', R(600, 40))
    await svg.trigger('pointermove', R(540, 40))
    expect(m.pen.wheel.value).toBeNull()
    await svg.trigger('pointerup', R(540, 40))
    expect(m.pen.wheel.value).toBeNull()
    expect(m.pen.menu.value).toBeNull()
  })
  it('pointercancel drops the press and closes the wheel', async () => {
    const m = mountIt(); wrapper = m.wrapper
    await m.wrapper.find(`[data-ent="${m.l}"]`).trigger('pointerdown', R(200, 210))
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointermove', R(150, 160))
    await svg.trigger('pointercancel', R(150, 160))
    expect(m.pen.wheel.value).toBeNull()
    expect(m.doc.value.constraints).toHaveLength(0)
    await svg.trigger('pointerup', R(150, 160))
    expect(m.pen.menu.value).toBeNull()
  })
  it('a right click in the Pen tool keeps the half-drawn path', async () => {
    const m = mountIt(); wrapper = m.wrapper
    m.pen.selectTool('path')
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 2 })
    await svg.trigger('pointerup', { button: 0, clientX: 100, clientY: 100, pointerId: 2 })
    const n = m.doc.value.entities.length
    await svg.trigger('pointerdown', R(300, 300))
    await svg.trigger('pointerup', R(300, 300))
    expect(m.doc.value.entities.length).toBe(n)
    expect(m.pen.pendingPath.value).not.toBeNull()
    expect(m.pen.menu.value).not.toBeNull()
  })
  it('a right press settles a live marquee first', async () => {
    const m = mountIt(); wrapper = m.wrapper
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointerdown', L(600, 40))
    await svg.trigger('pointermove', L(500, 100))
    expect(m.wrapper.find('[data-marquee]').exists()).toBe(true)
    await svg.trigger('pointerdown', R(300, 300))
    expect(m.wrapper.find('[data-marquee]').exists()).toBe(false)
  })
  it('an inactive overlay ignores a right press', async () => {
    const m = mountIt(undefined, false); wrapper = m.wrapper
    await m.wrapper.find(`[data-ent="${m.l}"]`).trigger('pointerdown', R(200, 210))
    await m.wrapper.find('svg').trigger('pointerup', R(200, 210))
    expect(m.pen.selection.value).toEqual([])
    expect(m.pen.menu.value).toBeNull()
  })
  it('the browser menu never opens over the pen', () => {
    const m = mountIt(); wrapper = m.wrapper
    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    m.wrapper.find(`[data-ent="${m.l}"]`).element.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
  })
})

describe('PenOverlay: a right press whose release was lost', () => {
  // the wheel is open over the nw slice (Horizontal) when the release goes missing
  async function openWheelThenLose(m: ReturnType<typeof mountIt>) {
    await m.wrapper.find(`[data-ent="${m.l}"]`).trigger('pointerdown', R(200, 210))
    await m.wrapper.find('svg').trigger('pointermove', R(150, 160))
    expect(m.pen.wheel.value!.hover).toBe('nw')
  }
  async function leftClick(m: ReturnType<typeof mountIt>) {
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointermove', { ...L(150, 160, 0), pointerId: 1 })
    await svg.trigger('pointerdown', { ...L(150, 160), pointerId: 1 })
    await svg.trigger('pointerup', { ...L(150, 160, 0), pointerId: 1 })
  }
  it('a hover with no button held drops it; the next click runs nothing', async () => {
    const m = mountIt(); wrapper = m.wrapper
    await openWheelThenLose(m)
    await m.wrapper.find('svg').trigger('pointermove', { ...R(140, 150), buttons: 0 })
    expect(m.pen.wheel.value).toBeNull()
    await leftClick(m)
    expect(m.doc.value.constraints).toHaveLength(0)
    expect(m.pen.wheel.value).toBeNull()
    expect(m.pen.menu.value).toBeNull()
  })
  it('a left press drops it, so its release runs no slice', async () => {
    const m = mountIt(); wrapper = m.wrapper
    await openWheelThenLose(m)
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointerdown', { ...L(150, 160), pointerId: 1 })
    expect(m.pen.wheel.value).toBeNull()
    await svg.trigger('pointerup', { ...L(150, 160, 0), pointerId: 1 })
    expect(m.doc.value.constraints).toHaveLength(0)
    expect(m.pen.menu.value).toBeNull()
  })
  it('a lost pointer capture drops it', async () => {
    const m = mountIt(); wrapper = m.wrapper
    await openWheelThenLose(m)
    const svg = m.wrapper.find('svg')
    await svg.trigger('lostpointercapture', { pointerId: 1 })
    expect(m.pen.wheel.value).toBeNull()
    await leftClick(m)
    expect(m.doc.value.constraints).toHaveLength(0)
    expect(m.pen.menu.value).toBeNull()
  })
  it('a window blur drops it (the host feeding blur too)', async () => {
    const m = mountIt('host'); wrapper = m.wrapper
    await openWheelThenLose(m)
    ;(m.wrapper.vm as any).onHostBlur()
    expect(m.pen.wheel.value).toBeNull()
    await leftClick(m)
    expect(m.doc.value.constraints).toHaveLength(0)
    expect(m.pen.menu.value).toBeNull()
  })
  it('another pointer’s moves and release leave the press alone', async () => {
    const m = mountIt(); wrapper = m.wrapper
    await openWheelThenLose(m)
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointermove', { ...R(300, 210), pointerId: 9 })
    expect(m.pen.wheel.value!.hover).toBe('nw')
    await svg.trigger('pointerup', { ...R(300, 210), pointerId: 9 })
    expect(m.pen.wheel.value).not.toBeNull()
    await svg.trigger('pointerup', R(150, 160))
    expect(m.doc.value.constraints.at(-1)!.kind).toBe('horizontal')
  })
  it('a tool key mid press settles it: the trailing right release opens nothing', async () => {
    const m = mountIt('host'); wrapper = m.wrapper
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointerdown', R(600, 40))
    expect((m.wrapper.vm as any).onHostKeydown(new KeyboardEvent('keydown', { key: 't' }))).toBe(true)
    expect(m.pen.tool.value).toBe('trim')
    await svg.trigger('pointerup', R(600, 40))
    expect(m.pen.menu.value).toBeNull()
    expect(m.doc.value.entities.some(e => e.id === m.l)).toBe(true)
  })
  it('a Mac ctrl-click while the menu is open reopens it there, like a right press', async () => {
    const m = mountIt(); wrapper = m.wrapper
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointerdown', R(600, 40))
    await svg.trigger('pointerup', R(600, 40))
    await nextTick()
    expect(m.pen.menu.value!.at).toEqual({ x: 600, y: 40 })
    const C = { button: 0, buttons: 1, ctrlKey: true, clientX: 200, clientY: 210, pointerId: 4 }
    await m.wrapper.find(`[data-ent="${m.l}"]`).trigger('pointerdown', C)
    await svg.trigger('pointerup', C)
    expect(m.pen.menu.value!.at).toEqual({ x: 200, y: 210 })
    expect(m.pen.menu.value!.header).toBe('1 line')
  })
})

describe('PenOverlay keys while a menu or wheel is open', () => {
  it('keys go to the open menu, even with a host feeding them', async () => {
    const m = mountIt('host'); wrapper = m.wrapper
    m.pen.pick(m.l)
    m.pen.openMenu({ x: 0, y: 0 }, null)
    const onHostKeydown = (m.wrapper.vm as any).onHostKeydown
    expect(onHostKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(true)
    expect(m.pen.menu.value!.active).toBe('rule:horizontal')
    expect(onHostKeydown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
    expect(m.pen.menu.value).toBeNull()
    expect(m.wrapper.emitted('cancel')).toBeUndefined()
  })
  it('Enter runs the highlighted item even while a toolbar button has focus', async () => {
    const m = mountIt('host'); wrapper = m.wrapper
    const btn = document.createElement('button'); document.body.appendChild(btn); btn.focus()
    m.pen.pick(m.l)
    m.pen.openMenu({ x: 0, y: 0 }, null)
    const onHostKeydown = (m.wrapper.vm as any).onHostKeydown
    onHostKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    expect(onHostKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
    expect(m.pen.menu.value).toBeNull()
    expect(m.doc.value.constraints.at(-1)!.kind).toBe('horizontal')
    expect(m.wrapper.emitted('commit')).toBeUndefined()
  })
  it('keys go to the open wheel: Escape cancels it, not the session', async () => {
    const m = mountIt('host'); wrapper = m.wrapper
    await m.wrapper.find(`[data-ent="${m.l}"]`).trigger('pointerdown', R(200, 210))
    await m.wrapper.find('svg').trigger('pointermove', R(150, 160))
    const onHostKeydown = (m.wrapper.vm as any).onHostKeydown
    const btn = document.createElement('button'); document.body.appendChild(btn); btn.focus()
    expect(onHostKeydown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
    expect(m.pen.wheel.value).toBeNull()
    expect(m.wrapper.emitted('cancel')).toBeUndefined()
    await m.wrapper.find('svg').trigger('pointerup', R(150, 160))
    expect(m.doc.value.constraints).toHaveLength(0)
    expect(m.pen.menu.value).toBeNull()
  })
  it('an action key settles a live marquee first', async () => {
    const m = mountIt('host'); wrapper = m.wrapper
    m.pen.pick(m.l)
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointerdown', { ...L(600, 40), shiftKey: true })
    await svg.trigger('pointermove', { ...L(500, 100), shiftKey: true })
    expect(m.wrapper.find('[data-marquee]').exists()).toBe(true)
    const onHostKeydown = (m.wrapper.vm as any).onHostKeydown
    expect(onHostKeydown(new KeyboardEvent('keydown', { key: 'x' }))).toBe(true)
    await nextTick()
    expect(m.wrapper.find('[data-marquee]').exists()).toBe(false)
  })
  it('⌘C with nothing selected leaves a live marquee alone', async () => {
    const m = mountIt('host'); wrapper = m.wrapper
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointerdown', L(600, 40))
    await svg.trigger('pointermove', L(500, 100))
    expect((m.wrapper.vm as any).onHostKeydown(new KeyboardEvent('keydown', { key: 'c', metaKey: true }))).toBe(false)
    await nextTick()
    expect(m.wrapper.find('[data-marquee]').exists()).toBe(true)
  })
  it('⌘A settles a live marquee first', async () => {
    const m = mountIt('host'); wrapper = m.wrapper
    const svg = m.wrapper.find('svg')
    await svg.trigger('pointerdown', L(600, 40))
    await svg.trigger('pointermove', L(500, 100))
    const onHostKeydown = (m.wrapper.vm as any).onHostKeydown
    expect(onHostKeydown(new KeyboardEvent('keydown', { key: 'a', metaKey: true }))).toBe(true)
    await nextTick()
    expect(m.wrapper.find('[data-marquee]').exists()).toBe(false)
    await svg.trigger('pointerup', L(500, 100))   // the settled marquee leaves Select all's selection alone
    expect(m.pen.selection.value.length).toBeGreaterThan(0)
  })
})

describe('PenOverlay hover highlight', () => {
  it('draws the hover highlight', async () => {
    const m = mountIt(); wrapper = m.wrapper
    m.pen.setHighlight([{ kind: 'line', id: m.l }])
    await nextTick()
    const hl = m.wrapper.find(`[data-highlight="line:${m.l}"]`)
    expect(hl.exists()).toBe(true)
    expect(hl.element.tagName.toLowerCase()).toBe('path')
    expect(hl.attributes('pointer-events')).toBe('none')
    expect(hl.attributes('vector-effect')).toBe('non-scaling-stroke')
    expect(hl.element.closest('g[transform]')).not.toBeNull()   // drawn in drawing space
    const p = (m.doc.value.entities.find(e => e.kind === 'point'))!.id
    m.pen.setHighlight([{ kind: 'point', id: p }])
    await nextTick()
    const ring = m.wrapper.find(`[data-highlight="point:${p}"]`)
    expect(ring.exists()).toBe(true)
    expect(ring.attributes('pointer-events')).toBe('none')
    expect(ring.attributes('r')).toBe('8')
    expect(ring.element.closest('g[transform]')).toBeNull()      // a screen-space ring
    expect(m.wrapper.find(`[data-highlight="line:${m.l}"]`).exists()).toBe(false)
  })
})
