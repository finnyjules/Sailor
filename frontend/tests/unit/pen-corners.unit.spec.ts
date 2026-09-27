// @vitest-environment happy-dom
//
// Pen stage 8, the Round corner and Chamfer tools in the shared pen: F / H,
// the selection's corners start picked, drag to size and release to apply
// (one undo step), click + digits + Enter, too big refused, Esc and a tool
// change leave the drawing exactly as it was (and never reach onLiveChange),
// the overlay draws the preview, and the hover stays cheap on one big drawing.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc, PathEntity } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen, type PenTool } from '~/composables/pen/usePen'
import { CORNER_TOO_BIG, CORNER_MISS } from '~/composables/pen/penCorners'
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
function setup(tools?: PenTool[]) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const sq = squarePath(doc.value, 1, 1, 4)
  let live = 0, changes = 0
  const pen = usePen({ doc, view: ref(DEV), options: tools ? { tools } : undefined, onLiveChange: () => { live++ }, onChange: () => { changes++ } })
  return { doc, pen, ...sq, live: () => live, changes: () => changes }
}
const json = (d: SketchDoc) => JSON.stringify(d)

describe('Round corner and Chamfer — keys and start', () => {
  it('F picks Round corner and H Chamfer; ⇧H is still Flip; a host without them ignores the keys', () => {
    const { pen } = setup()
    expect(pen.onKeydown(key('f'))).toBe(true); expect(pen.tool.value).toBe('round')
    expect(pen.onKeydown(key('h'))).toBe(true); expect(pen.tool.value).toBe('chamfer')
    expect(pen.onKeydown(key('H', { shiftKey: true }))).toBe(false)   // Flip needs a selection; never the tool
    expect(pen.tool.value).toBe('chamfer')
    const { pen: bare } = setup(['select', 'path'])
    expect(bare.onKeydown(key('f'))).toBe(false)
    expect(bare.onKeydown(key('h'))).toBe(false)
    expect(bare.tool.value).toBe('select')
  })
  it('the selection’s corners start picked, previewed at 12 px (0.35 units here)', () => {
    const { pen, pts, doc } = setup()
    pen.pick(pts[0]!); pen.pick(pts[2]!, true)
    const before = json(doc.value)
    pen.selectTool('round')
    const v = pen.cornerView.value!
    expect(v.corners).toEqual([pts[0], pts[2]])
    expect(v.size).toBeCloseTo(12 / 34, 9)
    expect(v.fits).toBe(true)
    expect(v.d).toMatch(/ A /)
    expect(json(doc.value)).toBe(before)
  })
})

describe('Round corner — the gesture', () => {
  it('press on a corner, drag, release: one undo step, nothing live before it', () => {
    const { pen, doc, pts, path, live } = setup()
    const before = json(doc.value)
    pen.selectTool('round')
    pen.cornerDown(1, 1, false)
    pen.cornerMove(1.2, 1.2); pen.cornerMove(1.3, 1.3)
    expect(pen.cornerView.value!.size).toBeGreaterThan(0.3)
    expect(json(doc.value)).toBe(before)
    expect(live()).toBe(0)
    pen.cornerUp()
    expect(pen.cornerView.value).toBeNull()
    const p = doc.value.entities.find(e => e.id === path) as PathEntity
    expect(p.segments.filter(s => s.kind === 'arc')).toHaveLength(1)
    expect(pen.status.value).toBe('Rounded')
    pen.undo()
    expect(json(doc.value)).toBe(before)
    pen.redo()
    expect((doc.value.entities.find(e => e.id === path) as PathEntity).anchors).toHaveLength(5)
    void pts
  })
  it('click, digits, Enter: the typed radius', () => {
    const { pen, doc } = setup()
    pen.selectTool('round')
    pen.cornerDown(5, 1, false); pen.cornerUp()
    for (const k of ['1', '.', '5']) expect(pen.onKeydown(key(k))).toBe(true)
    expect(pen.cornerView.value!.typed).toBe('1.5')
    expect(pen.cornerView.value!.size).toBe(1.5)
    expect(pen.onKeydown(key('Enter'))).toBe(true)
    const arcs = doc.value.entities.filter(e => e.kind === 'path').flatMap(e => (e as PathEntity).segments.filter(s => s.kind === 'arc'))
    expect(arcs).toHaveLength(1)
    const c = doc.value.entities.find(e => e.id === (arcs[0] as any).center) as any
    const t = doc.value.entities.find(e => e.kind === 'point' && Math.abs(Math.hypot((e as any).x - c.x, (e as any).y - c.y) - 1.5) < 1e-9)
    expect(t).toBeTruthy()
  })
  it('too big: the preview is red and Enter refuses, saying why', () => {
    const { pen, doc } = setup()
    const before = json(doc.value)
    pen.selectTool('round')
    pen.cornerDown(1, 1, false); pen.cornerUp()
    for (const k of ['9']) pen.onKeydown(key(k))
    expect(pen.cornerView.value!.fits).toBe(false)
    pen.onKeydown(key('Enter'))
    expect(pen.status.value).toBe(CORNER_TOO_BIG)
    expect(json(doc.value)).toBe(before)
    expect(pen.cornerView.value).not.toBeNull()
  })
  it('Esc, a tool change and undo each drop the preview, leaving the drawing exactly as it was', () => {
    const { pen, doc, changes } = setup()
    const before = json(doc.value), c0 = changes()
    pen.selectTool('round')
    pen.cornerDown(1, 1, false); pen.cornerMove(1.3, 1.3)
    expect(pen.onKeydown(key('Escape'))).toBe(true)
    expect(pen.cornerView.value).toBeNull()
    pen.cornerUp()
    expect(json(doc.value)).toBe(before)
    pen.cornerDown(1, 1, false); pen.cornerUp()
    pen.selectTool('select')
    expect(pen.cornerView.value).toBeNull()
    pen.selectTool('chamfer'); pen.cornerDown(1, 1, false); pen.cornerUp()
    pen.undo()
    expect(pen.cornerView.value).toBeNull()
    expect(json(doc.value)).toBe(before)
    expect(changes()).toBe(c0)   // no step was ever written
  })
  it('a press away from any corner says what to click', () => {
    const { pen } = setup()
    pen.selectTool('round')
    pen.cornerDown(3, 3, false)
    expect(pen.status.value).toBe(CORNER_MISS)
    expect(pen.cornerView.value).toBeNull()
  })
  it('Shift-click adds a corner; one drag sizes both; they are tied Equal', () => {
    const { pen, doc } = setup()
    pen.selectTool('chamfer')
    pen.cornerDown(1, 1, false); pen.cornerUp()
    pen.cornerDown(5, 5, true)
    pen.cornerMove(4.8, 4.8); pen.cornerMove(4.6, 4.6)
    expect(pen.cornerView.value!.corners).toHaveLength(2)
    pen.cornerUp()
    expect(pen.status.value).toBe('Chamfered')
    expect(doc.value.constraints.filter(c => c.kind === 'equalDist' && c.refs[0] !== c.refs[2])).toHaveLength(1)
  })
})

describe('PenOverlay draws it', () => {
  it('hover ring, preview (indigo, then red), picked rings, the chip', async () => {
    const { pen } = setup()
    const w = mount(PenOverlay, { props: { pen, view: DEV, width: 680, height: 460 }, attachTo: document.body })
    pen.selectTool('round')
    pen.cornerMove(1.05, 1.05); await nextTick()
    expect(w.find('[data-corner-hover]').exists()).toBe(true)
    pen.cornerDown(1, 1, false); pen.cornerUp(); await nextTick()
    expect(w.find('[data-corner-preview]').attributes('data-fits')).toBe('yes')
    expect(w.findAll('[data-corner-picked]')).toHaveLength(1)
    expect(w.find('[data-corner-chip]').text()).toMatch(/^R 0\.35$/)
    pen.onKeydown(key('9')); await nextTick()
    expect(w.find('[data-corner-chip]').text()).toBe('9|')
    expect(w.find('[data-corner-preview]').exists()).toBe(false)
    expect(w.findAll('[data-corner-bad]')).toHaveLength(1)
    w.unmount()
  })
})

describe('speed', () => {
  it('a hover and a drag frame on the 150-piece gear stay inside 16 ms', () => {
    const { doc: g, anchors } = gear(150)
    const doc = ref(g)
    const pen = usePen({ doc, view: ref({ a: 20, b: 0, c: 0, d: -20, e: 300, f: 300 }) })
    pen.selectTool('round')
    const a0 = g.entities.find(e => e.id === anchors[0]) as any
    pen.cornerMove(a0.x, a0.y)   // warm the corner cache
    let t = performance.now()
    for (let i = 0; i < 20; i++) pen.cornerMove(a0.x + i * 1e-3, a0.y)
    expect((performance.now() - t) / 20).toBeLessThan(16)
    pen.cornerDown(a0.x, a0.y, false)
    t = performance.now()
    for (let i = 1; i <= 20; i++) pen.cornerMove(a0.x * (1 - 0.004 * i), a0.y * (1 - 0.004 * i))
    expect((performance.now() - t) / 20).toBeLessThan(16)
  })
})
