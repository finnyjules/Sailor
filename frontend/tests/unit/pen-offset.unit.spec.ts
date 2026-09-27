// @vitest-environment happy-dom
//
// Pen stage 8, the Offset tool in the shared pen: E (never in an open-only
// pen), the selection starts as the source, press-drag-release applies one
// step, click + digits + Enter, − flips the side, too far refused, Esc leaves
// the drawing exactly as it was (never reaching onLiveChange), Option-click
// takes one piece, the overlay draws it, and a drag frame stays cheap.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { addPoint, addPath, addLine } from '~/lib/sketch/edit'
import { usePen, type PenTool } from '~/composables/pen/usePen'
import { OFFSET_TOO_FAR, OFFSET_MISS, OFFSET_CURVE } from '~/composables/pen/penOffset'
import { gear, squarePath } from './__fixtures__/penStage8'

vi.mock('~/components/pen/PenTipCard.vue', async () => {
  const { defineComponent: dc } = await import('vue')
  return { default: dc({ setup: (_, { slots }) => () => slots.default?.() }) }
})
vi.mock('~/components/ui/tooltip', async () => {
  const { defineComponent: dc } = await import('vue')
  const pass = dc({ setup: (_, { slots }) => () => slots.default?.() })
  return { TooltipProvider: pass, Tooltip: pass, TooltipTrigger: pass }
})
const { default: PenOverlay } = await import('~/components/pen/PenOverlay.vue')

const DEV: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
  preventDefault() {}, stopPropagation() {}, ...mods,
}) as unknown as KeyboardEvent
function setup(options?: { tools?: PenTool[]; openOnly?: boolean }) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const sq = squarePath(doc.value, 1, 1, 4)
  let live = 0
  const pen = usePen({ doc, view: ref(DEV), options, onLiveChange: () => { live++ } })
  return { doc, pen, ...sq, live: () => live }
}
const json = (d: SketchDoc) => JSON.stringify(d)

describe('Offset — keys and start', () => {
  it('E picks Offset; an open-only pen never offers it', () => {
    const { pen } = setup()
    expect(pen.onKeydown(key('e'))).toBe(true); expect(pen.tool.value).toBe('offset')
    const { pen: guide } = setup({ openOnly: true, tools: ['select', 'path', 'offset', 'round'] })
    expect(guide.options.tools).not.toContain('offset')
    expect(guide.options.tools).toContain('round')
    expect(guide.onKeydown(key('e'))).toBe(false)
  })
  it('a selected path starts as the source, previewed 12 px to its left', () => {
    const { pen, path, doc } = setup()
    pen.pick(path)
    const before = json(doc.value)
    pen.selectTool('offset')
    const v = pen.offsetView.value!
    expect(v.d).toBeCloseTo(12 / 34, 9)
    expect(v.ok).toBe(true)
    expect(v.preview).toMatch(/Z$/)
    expect(json(doc.value)).toBe(before)
  })
  it('an Option-picked piece starts as the source too', () => {
    const { pen, path } = setup()
    pen.pickSegment(path, 0)
    pen.selectTool('offset')
    const ch = pen.offsetView.value!.chains
    expect(ch).toHaveLength(1)
    expect((ch[0] as any).pieces).toHaveLength(1)
  })
})

describe('Offset — the gesture', () => {
  it('press on a side, drag outward, release: an outer copy, one step, nothing live before it', () => {
    const { pen, doc, live } = setup()
    const before = json(doc.value)
    pen.selectTool('offset')
    pen.offsetDown(3, 1, false, false)
    pen.offsetMove(3, 0.7); pen.offsetMove(3, 0)
    expect(pen.offsetView.value!.d).toBeCloseTo(-1, 9)
    expect(json(doc.value)).toBe(before)
    expect(live()).toBe(0)
    pen.offsetUp()
    expect(pen.offsetView.value).toBeNull()
    expect(doc.value.entities.filter(e => e.kind === 'path')).toHaveLength(2)
    expect(doc.value.constraints.filter(c => c.kind === 'offsetLine')).toHaveLength(8)
    expect(pen.status.value).toBe('Offset')
    pen.undo()
    expect(json(doc.value)).toBe(before)
  })
  it('click, digits, − flips, Enter', () => {
    const { pen, doc } = setup()
    pen.selectTool('offset')
    pen.offsetDown(3, 1, false, false); pen.offsetUp()
    for (const k of ['0', '.', '5']) expect(pen.onKeydown(key(k))).toBe(true)
    expect(pen.offsetView.value!.d).toBeCloseTo(0.5, 9)
    expect(pen.onKeydown(key('-'))).toBe(true)
    expect(pen.offsetView.value!.d).toBeCloseTo(-0.5, 9)
    expect(pen.onKeydown(key('Enter'))).toBe(true)
    expect(doc.value.constraints.filter(c => c.kind === 'offsetLine').every(c => c.value === -0.5)).toBe(true)
  })
  it('too far: red, Enter refuses and says why', () => {
    const { pen, doc } = setup()
    const before = json(doc.value)
    pen.selectTool('offset')
    pen.offsetDown(3, 1, false, false); pen.offsetUp()
    pen.onKeydown(key('3'))
    expect(pen.offsetView.value!.ok).toBe(false)
    pen.onKeydown(key('Enter'))
    expect(pen.status.value).toBe(OFFSET_TOO_FAR)
    expect(json(doc.value)).toBe(before)
  })
  it('Esc mid-drag and a tool change leave the drawing exactly as it was', () => {
    const { pen, doc } = setup()
    const before = json(doc.value)
    pen.selectTool('offset')
    pen.offsetDown(3, 1, false, false); pen.offsetMove(3, 0)
    expect(pen.onKeydown(key('Escape'))).toBe(true)
    expect(pen.status.value).toBe('Cancelled')
    pen.offsetUp()
    expect(json(doc.value)).toBe(before)
    pen.offsetDown(3, 1, false, false); pen.offsetUp()
    pen.onKeydown(key('v'))
    expect(pen.offsetView.value).toBeNull()
    expect(json(doc.value)).toBe(before)
  })
  it('Option-click takes one piece; empty space with no source says what to click', () => {
    const { pen } = setup()
    pen.selectTool('offset')
    pen.offsetDown(3, 3, false, false)
    expect(pen.status.value).toBe(OFFSET_MISS)
    pen.offsetDown(3, 1, false, true); pen.offsetUp()
    const ch = pen.offsetView.value!.chains
    expect(ch).toHaveLength(1)
    expect((ch[0] as any).pieces).toHaveLength(1)
  })
  it('the default distance goes on the side of the click', () => {
    const { pen } = setup()
    pen.selectTool('offset')
    pen.offsetDown(3, 1.1, false, false); pen.offsetUp()
    expect(pen.offsetView.value!.d).toBeCloseTo(12 / 34, 9)
    pen.onKeydown(key('Escape'))
    pen.offsetDown(3, 0.9, false, false); pen.offsetUp()
    expect(pen.offsetView.value!.d).toBeCloseTo(-12 / 34, 9)
  })
  it('Shift-click adds a second path to the source', () => {
    const { pen, doc } = setup()
    squarePath(doc.value, 7, 1, 2)
    pen.selectTool('offset')
    pen.offsetDown(3, 1, false, false); pen.offsetUp()
    pen.offsetDown(8, 1, true, false); pen.offsetUp()
    expect(pen.offsetView.value!.chains).toHaveLength(2)
    pen.onKeydown(key('Enter'))
    expect(doc.value.entities.filter(e => e.kind === 'path')).toHaveLength(4)
  })
  it('a line and a circle offset too', () => {
    const { pen, doc } = setup()
    addLine(doc.value, addPoint(doc.value, 7, 1), addPoint(doc.value, 9, 1))
    pen.selectTool('offset')
    pen.offsetDown(8, 1, false, false); pen.offsetMove(8, 1.5); pen.offsetUp()
    expect(pen.status.value).toBe('Offset')
    expect(doc.value.entities.filter(e => e.kind === 'path')).toHaveLength(2)   // the line's copy is a one-piece path
  })
  it('a Bézier piece clicked says it can’t be offset, the drawing untouched', () => {
    const { pen, doc } = setup()
    const a = addPoint(doc.value, 7, 1), b = addPoint(doc.value, 11, 1)
    addPath(doc.value, [a, b], [{ kind: 'cubic', h1: null, h2: null }], false)
    const before = json(doc.value)
    pen.selectTool('offset')
    pen.offsetDown(9, 1, false, false); pen.offsetUp()
    expect(pen.status.value).toBe(OFFSET_CURVE)
    expect(pen.offsetView.value).toBeNull()
    expect(json(doc.value)).toBe(before)
  })
})

describe('the corner tools’ lessons', () => {
  it('a cancelled press (pointercancel) drops the preview and leaves the drawing exactly as it was', async () => {
    const { pen, doc, live } = setup()
    const before = json(doc.value)
    const w = mount(PenOverlay, { props: { pen, view: DEV, width: 680, height: 460 }, attachTo: document.body })
    pen.selectTool('offset')
    const svg = w.find('svg')
    // (3, 1) is (142, 366) on screen; (3, 0) is (142, 400)
    await svg.trigger('pointerdown', { button: 0, clientX: 142, clientY: 366, pointerId: 1 })
    await svg.trigger('pointermove', { buttons: 1, clientX: 142, clientY: 400, pointerId: 1 })
    expect(pen.offsetView.value!.d).toBeCloseTo(-1, 6)
    await svg.trigger('pointercancel', { clientX: 142, clientY: 400, pointerId: 1 })
    expect(pen.offsetView.value).toBeNull()
    expect(json(doc.value)).toBe(before)
    expect(live()).toBe(0)
    w.unmount()
  })
  it('a drawing changed under the preview another way drops it — never a misleading "too far"', () => {
    const { pen, doc, path } = setup()
    pen.selectTool('offset')
    pen.offsetDown(3, 1, false, false); pen.offsetUp()
    pen.onKeydown(key('3'))
    doc.value.entities = doc.value.entities.filter(e => e.id !== path)
    pen.commitHistory()
    expect(pen.offsetView.value).toBeNull()
    const s0 = pen.status.value
    expect(pen.onKeydown(key('Enter'))).not.toBe(true)
    expect(pen.status.value).toBe(s0)
  })
  it('typed text that is no distance (0, ".", 0.0) never applies the old one', () => {
    const { pen, doc } = setup()
    const before = json(doc.value)
    pen.selectTool('offset')
    for (const typed of [['0'], ['.'], ['0', '.', '0']]) {
      pen.offsetDown(3, 1, false, false); pen.offsetUp()
      for (const k of typed) expect(pen.onKeydown(key(k))).toBe(true)
      expect(pen.onKeydown(key('Enter'))).toBe(true)
      expect(json(doc.value)).toBe(before)
      expect(pen.offsetView.value).not.toBeNull()
      pen.offsetDown(3, 1, false, false); pen.offsetMove(3, 0); pen.offsetUp()
      expect(json(doc.value)).toBe(before)
      pen.onKeydown(key('Escape'))
    }
  })
  it('the distance used is remembered for the next default', () => {
    const { pen } = setup()
    pen.selectTool('offset')
    pen.offsetDown(3, 1, false, false); pen.offsetUp()
    pen.onKeydown(key('1')); pen.onKeydown(key('Enter'))
    expect(pen.status.value).toBe('Offset')
    pen.offsetDown(3, 1.1, false, false); pen.offsetUp()
    expect(pen.offsetView.value!.d).toBe(1)
  })
})

describe('PenOverlay draws it', () => {
  it('hover, source, preview and chip', async () => {
    const { pen } = setup()
    const w = mount(PenOverlay, { props: { pen, view: DEV, width: 680, height: 460 }, attachTo: document.body })
    pen.selectTool('offset')
    pen.offsetMove(3, 1.02); await nextTick()
    expect(w.find('[data-offset-hover]').exists()).toBe(true)
    pen.offsetDown(3, 1, false, false); pen.offsetUp(); await nextTick()
    expect(w.find('[data-offset-hover]').exists()).toBe(false)
    expect(w.find('[data-offset-source]').attributes('d')).toMatch(/Z$/)
    expect(w.find('[data-offset-preview]').attributes('data-ok')).toBe('yes')
    expect(w.find('[data-offset-chip]').text()).toBe('0.35')
    pen.onKeydown(key('-')); await nextTick()
    expect(w.find('[data-offset-chip]').text()).toBe('−0.35')
    pen.onKeydown(key('3')); await nextTick()
    expect(w.find('[data-offset-chip]').text()).toBe('−3|')
    pen.onKeydown(key('-')); await nextTick()   // 3 inside a 4 × 4 square: too far
    expect(w.find('[data-offset-chip]').text()).toBe('3|')
    expect(w.find('[data-offset-preview]').attributes('data-ok')).toBe('no')
    w.unmount()
  })
})

describe('speed', () => {
  it('a drag frame on the 150-piece gear stays inside 16 ms', () => {
    const { doc: g, path } = gear(150)
    const doc = ref(g)
    const pen = usePen({ doc, view: ref({ a: 20, b: 0, c: 0, d: -20, e: 300, f: 300 }) })
    pen.pick(path)
    pen.selectTool('offset')
    pen.offsetDown(10, 0, false, false)
    pen.offsetMove(10.2, 0)
    const t = performance.now()
    for (let i = 1; i <= 20; i++) pen.offsetMove(10 + 0.01 * i, 0)
    expect((performance.now() - t) / 20).toBeLessThan(16)
  })
})
