// @vitest-environment happy-dom
//
// Pen stage 8, the Repeat… panel: opens on the selection's shapes, Radial
// (centre clicked, or the selected point), Linear (live, a dashed guide),
// Along a path (placed once); the preview never touches the drawing; Apply is
// one step; Cancel / Esc leave it byte-identical; the pen owns the keys while
// it is open; the panel takes Properties' place; its buttons never take focus
// from the mouse, so Space still pans.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { addPoint, addPath, addLine } from '~/lib/sketch/edit'
import { usePen, isCleanupBarFocused } from '~/composables/pen/usePen'
import { REPEAT_NEED_SHAPE, REPEAT_HINT_CENTRE, REPEAT_HINT_PATH, REPEAT_BAD_PATH, REPEAT_CURVE_PATH } from '~/composables/pen/penRepeat'
import { squarePath } from './__fixtures__/penStage8'

vi.mock('~/components/pen/PenTipCard.vue', async () => {
  const { defineComponent: dc } = await import('vue')
  return { default: dc({ setup: (_, { slots }) => () => slots.default?.() }) }
})
vi.mock('~/components/ui/tooltip', async () => {
  const { defineComponent: dc } = await import('vue')
  const pass = dc({ setup: (_, { slots }) => () => slots.default?.() })
  return { TooltipProvider: pass, Tooltip: pass, TooltipTrigger: pass }
})
const { default: PenProperties } = await import('~/components/pen/PenProperties.vue')
const { default: PenToolbar } = await import('~/components/pen/PenToolbar.vue')
const { default: PenOverlay } = await import('~/components/pen/PenOverlay.vue')

const DEV: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: null,
  preventDefault() {}, stopPropagation() {}, ...mods,
}) as unknown as KeyboardEvent
function setup() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const sq = squarePath(doc.value, 1, 1, 1)
  const rail = addPath(doc.value, [addPoint(doc.value, 0, -3), addPoint(doc.value, 10, -3)], [{ kind: 'line' }])
  let live = 0, changes = 0
  const pen = usePen({ doc, view: ref(DEV), onLiveChange: () => { live++ }, onChange: () => { changes++ } })
  return { doc, pen, ...sq, rail, live: () => live, changes: () => changes }
}
const json = (d: SketchDoc) => JSON.stringify(d)
const paths = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path' && !e.construction).length

describe('Repeat… opens the panel', () => {
  it('needs a shape; opens Radial with no centre, nothing changed, the hint says what to click', () => {
    const { pen, doc, path } = setup()
    expect(pen.repeatPrompt()).toBe(false)
    expect(pen.status.value).toBe(REPEAT_NEED_SHAPE)
    pen.pick(path)
    const before = json(doc.value)
    expect(pen.repeatPrompt()).toBe(true)
    expect(pen.repeat.value).toMatchObject({ mode: 'radial', count: 6, sweep: 360, centre: null })
    expect(pen.repeat.value!.preview.ok).toBe(false)
    expect(pen.repeatHint.value).toBe(REPEAT_HINT_CENTRE)
    expect(json(doc.value)).toBe(before)
    expect(pen.valueRequest.value).toBeNull()        // no count prompt any more
  })
  it('the point selected with the shapes is the centre', () => {
    const { pen, doc, path } = setup()
    const c = addPoint(doc.value, 0, 0)
    pen.pick(path); pen.pick(c, true)
    pen.repeatPrompt()
    expect(pen.repeat.value!.centre).toEqual({ id: c })
    expect(pen.repeat.value!.preview.ok).toBe(true)
    expect(pen.repeatNames.value.centre).toMatch(/^Point \d+$/)
  })
})

describe('Radial, Linear, Along a path', () => {
  it('Radial: an empty-space click picks the centre; Apply makes the ring as one step', () => {
    const { pen, doc, path, live, changes } = setup()
    pen.pick(path); pen.repeatPrompt()
    const before = json(doc.value), c0 = changes()
    pen.repeatPick({ kind: 'empty', at: { x: 0, y: 0 } })
    expect(pen.repeat.value!.preview.d).toMatch(/Z/)
    expect(pen.repeatNames.value.centre).toBe('New point')
    expect(json(doc.value)).toBe(before)
    expect(live()).toBe(0)
    expect(pen.applyRepeatPanel()).toBe(true)
    expect(pen.repeat.value).toBeNull()
    expect(paths(doc.value)).toBe(2 + 5)
    expect(doc.value.entities.some(e => e.kind === 'point' && e.fixed && e.x === 0 && e.y === 0)).toBe(true)
    expect(pen.status.value).toBe('Repeated ×6')
    expect(changes()).toBe(c0 + 1)
    pen.undo()
    expect(json(doc.value)).toBe(before)
  })
  it('Radial: a sweep under 360 spreads the copies over it', () => {
    const { pen, doc, path } = setup()
    pen.pick(path); pen.repeatPrompt()
    pen.repeatPick({ kind: 'empty', at: { x: 0, y: 0 } })
    pen.setRepeat({ count: 3, sweep: 90 })
    pen.applyRepeatPanel()
    expect([...new Set(doc.value.constraints.filter(c => c.kind === 'rotatedFrom').map(c => c.value))]).toEqual([45, 90])
  })
  it('Linear: copies to the right on screen, tied to a dashed guide', () => {
    const { pen, doc, path } = setup()
    pen.pick(path); pen.repeatPrompt()
    pen.setRepeat({ mode: 'linear', count: 3, angle: 0, spacing: 'step', distance: 2 })
    expect(pen.repeat.value!.preview.ok).toBe(true)
    pen.applyRepeatPanel()
    const tf = doc.value.constraints.filter(c => c.kind === 'translatedFrom')
    expect(tf).toHaveLength(8)
    const guide = doc.value.entities.find(e => e.kind === 'line' && e.construction) as any
    const from = doc.value.entities.find(e => e.id === guide.p1) as any, to = doc.value.entities.find(e => e.id === guide.p2) as any
    expect(to.x - from.x).toBeCloseTo(2, 9); expect(to.y - from.y).toBeCloseTo(0, 9)
  })
  it('Along a path: the path clicked; one of the repeated pieces is refused', () => {
    const { pen, doc, path, rail } = setup()
    pen.pick(path); pen.repeatPrompt()
    pen.setRepeat({ mode: 'along', count: 3 })
    pen.repeatPick({ kind: 'piece', ref: { kind: 'seg', pathId: path, segIndex: 0 } })
    expect(pen.status.value).toBe(REPEAT_BAD_PATH)
    pen.repeatPick({ kind: 'piece', ref: { kind: 'seg', pathId: rail, segIndex: 0 } })
    expect(pen.repeatNames.value.path).toMatch(/^Line \d+$/)
    pen.applyRepeatPanel()
    expect(paths(doc.value)).toBe(2 + 2)
    expect(doc.value.constraints.some(c => c.kind === 'translatedFrom' || c.kind === 'rotatedFrom')).toBe(false)
  })
})

describe('while it is open', () => {
  it('Esc cancels leaving the drawing byte-identical; ⌘Z closes it; Enter applies', () => {
    const { pen, doc, path, changes } = setup()
    pen.pick(path); pen.repeatPrompt()
    pen.repeatPick({ kind: 'empty', at: { x: 0, y: 0 } })
    const before = json(doc.value), c0 = changes()
    expect(pen.onKeydown(key('Escape'))).toBe(true)
    expect(pen.repeat.value).toBeNull()
    expect(json(doc.value)).toBe(before)
    expect(changes()).toBe(c0)
    pen.pick(path); pen.repeatPrompt()
    expect(pen.onKeydown(key('z', { metaKey: true }))).toBe(true)
    expect(pen.repeat.value).toBeNull()
    pen.pick(path); pen.repeatPrompt(); pen.repeatPick({ kind: 'empty', at: { x: 0, y: 0 } })
    expect(pen.onKeydown(key('Enter'))).toBe(true)
    expect(paths(doc.value)).toBe(7)
  })
  it('tool letters are swallowed, Tab is left to the browser, menus and the wheel stay shut', () => {
    const { pen, path } = setup()
    pen.pick(path); pen.repeatPrompt()
    expect(pen.onKeydown(key('l'))).toBe(true)
    expect(pen.tool.value).toBe('select')
    expect(pen.onKeydown(key('Tab'))).toBe(false)
    pen.openMenu({ x: 10, y: 10 }, null)
    expect(pen.menu.value).toBeNull()
    expect(pen.openWheel({ x: 10, y: 10 })).toBe(false)
  })
})

describe('the panel, the toolbar and the overlay', () => {
  it('takes Properties’ place; kinds switch; a typed field commits and blurs; Apply never takes focus from the mouse', async () => {
    const { pen, path } = setup()
    const w = mount(PenProperties, { props: { pen }, attachTo: document.body })
    pen.pick(path); await nextTick()
    expect(w.find('[data-props-rules]').exists()).toBe(true)
    pen.repeatPrompt(); await nextTick()
    expect(w.find('[data-repeat-panel]').exists()).toBe(true)
    expect(w.find('[data-props-rules]').exists()).toBe(false)
    await w.find('[data-repeat-mode="linear"]').trigger('click')
    expect(pen.repeat.value!.mode).toBe('linear')
    expect(w.find('[data-repeat-field="distance"]').exists()).toBe(true)
    const input = w.find('[data-repeat-field="count"] input')
    ;(input.element as HTMLInputElement).focus()
    await input.setValue('4'); await input.trigger('keydown', { key: 'Enter' })
    expect(pen.repeat.value!.count).toBe(4)
    expect(document.activeElement).not.toBe(input.element)
    const apply = w.find('[data-act="repeat-apply"]')
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    apply.element.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    ;(apply.element as HTMLElement).focus()
    expect(isCleanupBarFocused()).toBe(true)          // a keyboard-focused panel control keeps Space
    await apply.trigger('click')
    expect(pen.repeat.value).toBeNull()
    w.unmount()
  })
  it('the toolbar: tools off and the hint row asks for the centre', async () => {
    const { pen, path } = setup()
    const w = mount(PenToolbar, { props: { pen }, attachTo: document.body })
    pen.pick(path); pen.repeatPrompt(); await nextTick()
    expect(w.find('[data-tool="path"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-act="cleanup"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-repeat-hint]').text()).toBe(REPEAT_HINT_CENTRE)
    w.unmount()
  })
  it('the overlay: a point click picks the centre; the preview and the centre are drawn', async () => {
    const { pen, path, pts } = setup()
    const w = mount(PenOverlay, { props: { pen, view: DEV, width: 680, height: 460 }, attachTo: document.body })
    pen.pick(path); pen.repeatPrompt(); await nextTick()
    await w.find(`circle[data-point="${pts[0]}"]`).trigger('pointerdown', { button: 0, pointerId: 1 })
    expect(pen.repeat.value!.centre).toEqual({ id: pts[0] })
    await nextTick()
    expect(w.find('[data-repeat-preview]').attributes('d')).toMatch(/Z/)
    expect(w.find('[data-repeat-centre]').exists()).toBe(true)
    w.unmount()
  })
})

describe('reasons, drops and typed values', () => {
  it('a Bézier path is refused with its reason; Apply with nothing picked says what to click', () => {
    const { pen, doc, path } = setup()
    const a = addPoint(doc.value, 0, 5), b = addPoint(doc.value, 4, 5)
    const curve = addPath(doc.value, [a, b], [{ kind: 'cubic', h1: null, h2: null }])
    pen.pick(path); pen.repeatPrompt()
    expect(pen.applyRepeatPanel()).toBe(false)
    expect(pen.status.value).toBe(REPEAT_HINT_CENTRE)
    pen.setRepeat({ mode: 'along' })
    pen.repeatPick({ kind: 'piece', ref: { kind: 'seg', pathId: curve, segIndex: 0 } })
    expect(pen.status.value).toBe(REPEAT_CURVE_PATH)
    expect(pen.repeat.value!.along).toBeNull()
    expect(pen.applyRepeatPanel()).toBe(false)
    expect(pen.status.value).toBe(REPEAT_HINT_PATH)
  })
  it('values that are no value keep the old one: count 0 or 1, sweep 0, distance 0', () => {
    const { pen, path } = setup()
    pen.pick(path); pen.repeatPrompt()
    pen.setRepeat({ count: 0 }); pen.setRepeat({ count: 1 }); pen.setRepeat({ sweep: 0 }); pen.setRepeat({ distance: 0 })
    expect(pen.repeat.value).toMatchObject({ count: 6, sweep: 360 })
    expect(pen.repeat.value!.distance).toBeGreaterThan(0)
    pen.setRepeat({ count: 500 })
    expect(pen.repeat.value!.count).toBe(64)
  })
  it('the default linear distance is the selection’s width × 1.25', () => {
    const { pen, path } = setup()
    pen.pick(path); pen.repeatPrompt()
    expect(pen.repeat.value!.distance).toBeCloseTo(1.25, 9)
  })
  it('undo while open only closes it; a change to the drawing by another path drops it untouched', () => {
    const { pen, doc, path, changes } = setup()
    pen.selectTool('line'); pen.place(20, 20); pen.place(21, 20); pen.selectTool('select')
    const n = doc.value.entities.length, c0 = changes()
    pen.pick(path); pen.repeatPrompt()
    pen.undo()
    expect(pen.repeat.value).toBeNull()
    expect(doc.value.entities.length).toBe(n)
    expect(changes()).toBe(c0)
    pen.pick(path); pen.repeatPrompt()
    const p1 = addPoint(doc.value, 30, 30), p2 = addPoint(doc.value, 31, 30)
    addLine(doc.value, p1, p2)
    pen.commitHistory()
    expect(pen.repeat.value).toBeNull()
  })
  it('arrows on a focused kind radio move the kind', async () => {
    const { pen, path } = setup()
    const w = mount(PenProperties, { props: { pen }, attachTo: document.body })
    pen.pick(path); pen.repeatPrompt(); await nextTick()
    const radial = w.find('[data-repeat-mode="radial"]').element as HTMLElement
    radial.focus()
    expect(pen.onKeydown(key('ArrowRight', { target: radial } as any))).toBe(true)
    expect(pen.repeat.value!.mode).toBe('linear')
    await nextTick()
    expect(document.activeElement).toBe(w.find('[data-repeat-mode="linear"]').element)
    expect(pen.onKeydown(key(' ', { target: document.activeElement } as any))).toBe(false)   // Space presses the focused control
    w.unmount()
  })
})
