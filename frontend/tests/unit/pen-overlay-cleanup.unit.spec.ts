// @vitest-environment happy-dom
//
// Pen stage 5: PenOverlay while a Clean up preview is open — the cleaned
// drawing over a faint ghost, one badge per fix that switches it, the
// drawing's own points and input set aside, ⌥⇧C and Enter from the window.
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { addPoint, addPath, addLine } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'
import PenOverlay from '~/components/pen/PenOverlay.vue'

const view: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function flower(d: SketchDoc): void {
  const C: [number, number][] = [[6, 2], [12, 2], [12, 8], [6, 8]]
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const ex = x1 + 0.08, ey = y1 + 0.05
    const s = addPoint(d, x0, y0), e = addPoint(d, ex, ey), c = addPoint(d, (x0 + ex) / 2, (y0 + ey) / 2)
    addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
  }
}
function mountFlower(keyboard?: 'window' | 'host', cursor?: string) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  flower(doc.value)
  const pen = usePen({ doc: doc as any, view: ref(view) })
  const props: Record<string, unknown> = { pen, view, width: 680, height: 460 }
  if (keyboard) props.keyboard = keyboard
  if (cursor) props.cursor = cursor
  const wrapper = mount(PenOverlay, { props, attachTo: document.body })
  return { wrapper, doc, pen }
}
const altShiftC = () => new KeyboardEvent('keydown', { key: 'Ç', code: 'KeyC', altKey: true, shiftKey: true, bubbles: true, cancelable: true })
const pointsOf = (d: SketchDoc) => d.entities.filter(e => e.kind === 'point').map(p => [p.id, (p as any).x, (p as any).y])

let mounted: ReturnType<typeof mountFlower>['wrapper'] | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
})

describe('PenOverlay — Clean up preview', () => {
  it('draws the cleaned drawing over a faint ghost, one badge per fix, and hides the points', async () => {
    const { wrapper, pen } = mountFlower(); mounted = wrapper
    expect(wrapper.findAll('circle[data-point]').length).toBeGreaterThan(0)
    pen.startCleanup(); await nextTick()
    expect(wrapper.find('[data-cleanup-preview]').exists()).toBe(true)
    expect(wrapper.find('[data-cleanup-ghost]').exists()).toBe(true)
    expect(wrapper.findAll('[data-fix-kind="join"]')).toHaveLength(4)
    expect(wrapper.find('[data-fix-kind="join"]').text()).toBe('Joined')
    expect(wrapper.findAll('circle[data-point]')).toHaveLength(0)
    expect(wrapper.findAll('[data-seg]')).toHaveLength(0)
    pen.cancelCleanup(); await nextTick()
    expect(wrapper.find('[data-cleanup-preview]').exists()).toBe(false)
    expect(wrapper.findAll('circle[data-point]').length).toBeGreaterThan(0)
  })
  it('the canvas cursor is plain while previewing, and the host\'s own cursor again once it closes', async () => {
    const { wrapper, pen } = mountFlower('window', 'crosshair'); mounted = wrapper
    expect(wrapper.find('svg').attributes('style')).toContain('cursor: crosshair')
    pen.startCleanup(); await nextTick()
    expect(wrapper.find('svg').attributes('style')).toContain('cursor: default')
    pen.cancelCleanup(); await nextTick()
    expect(wrapper.find('svg').attributes('style')).toContain('cursor: crosshair')
  })
  it('the cleaned drawing is the preview doc, the ghost the drawing as it is', async () => {
    const { wrapper, pen } = mountFlower(); mounted = wrapper
    const before = wrapper.find('path').attributes('d')
    pen.startCleanup(); await nextTick()
    expect(wrapper.find('[data-cleanup-ghost]').attributes('d')).toBe(before)
    expect(wrapper.find('[data-cleanup-preview]').attributes('d')).not.toBe(before)
  })
  it('rule badges and radius chips are hidden while previewing, even with Labels on', async () => {
    const { wrapper, pen } = mountFlower(); mounted = wrapper
    pen.showLabels.value = true; await nextTick()
    expect(wrapper.findAll('.constraint-badge, [data-constraint]').length + wrapper.text().split('R ').length - 1).toBeGreaterThan(0)
    pen.startCleanup(); await nextTick()
    expect(wrapper.findAll('[data-constraint]')).toHaveLength(0)
    expect(wrapper.findAll('text').map(t => t.text()).filter(t => t.startsWith('R '))).toHaveLength(0)
  })
  it('a badge click switches its fix off, and on again', async () => {
    const { wrapper, pen } = mountFlower(); mounted = wrapper
    pen.startCleanup(); await nextTick()
    const id = wrapper.find('[data-fix-kind="join"]').attributes('data-cleanup-fix')!
    await wrapper.find(`[data-cleanup-fix="${id}"]`).trigger('click')
    expect(pen.cleanup.value!.off.has(id)).toBe(true)
    expect(wrapper.find(`[data-cleanup-fix="${id}"]`).attributes('data-off')).toBe('')
    await wrapper.find(`[data-cleanup-fix="${id}"]`).trigger('click')
    expect(pen.cleanup.value!.off.has(id)).toBe(false)
    expect(wrapper.find(`[data-cleanup-fix="${id}"]`).attributes('data-on')).toBe('')
  })
  it('the clicked badge stays where it was, so it is still under the pointer', async () => {
    const { wrapper, pen } = mountFlower(); mounted = wrapper
    pen.startCleanup(); await nextTick()
    const ids = wrapper.findAll('[data-fix-kind]').map(g => g.attributes('data-cleanup-fix')!)
    expect(ids.length).toBeGreaterThan(4)
    // each badge in turn, off and on again (switching one off can make others
    // come or go — the clicked one must not move either way)
    for (const id of ids) {
      const rect = () => wrapper.find(`[data-cleanup-fix="${id}"] rect`)
      const at = [rect().attributes('x'), rect().attributes('y')]
      await wrapper.find(`[data-cleanup-fix="${id}"]`).trigger('click')
      expect([rect().attributes('x'), rect().attributes('y')]).toEqual(at)
      await wrapper.find(`[data-cleanup-fix="${id}"]`).trigger('click')
      expect([rect().attributes('x'), rect().attributes('y')]).toEqual(at)
    }
  })
  it('⌥⇧C opens it from the window; Enter applies it', async () => {
    const { wrapper, pen, doc } = mountFlower(); mounted = wrapper
    window.dispatchEvent(altShiftC())
    await nextTick()
    expect(pen.cleanup.value).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await nextTick()
    expect(pen.cleanup.value).toBeNull()
    expect(doc.value.entities.filter(e => e.kind === 'path')).toHaveLength(1)
  })
  it('Enter applies even while a toolbar button still has focus', async () => {
    const { wrapper, pen, doc } = mountFlower(); mounted = wrapper
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    pen.startCleanup(); await nextTick()
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()
    expect(pen.cleanup.value).toBeNull()
    expect(doc.value.entities.filter(e => e.kind === 'path')).toHaveLength(1)
  })
  it('with no preview, Enter on a focused button still belongs to the button', async () => {
    const { wrapper, pen, doc } = mountFlower(); mounted = wrapper
    pen.selectTool('path')
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    const n = doc.value.entities.length
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await nextTick()
    expect(wrapper.emitted('commit')).toBeUndefined()
    expect(doc.value.entities.length).toBe(n)
  })
  it('keyboard="host": onHostKeydown routes the preview keys to the pen', async () => {
    const { wrapper, pen } = mountFlower('host'); mounted = wrapper
    expect((wrapper.vm as any).onHostKeydown(altShiftC())).toBe(true)
    expect(pen.cleanup.value).not.toBeNull()
    // a plain key is swallowed (nothing edits the drawing under the preview); Escape cancels
    expect((wrapper.vm as any).onHostKeydown(new KeyboardEvent('keydown', { key: 'l' }))).toBe(true)
    expect(pen.tool.value).toBe('select')
    expect((wrapper.vm as any).onHostKeydown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
    expect(pen.cleanup.value).toBeNull()
    await nextTick()
    expect(wrapper.emitted('cancel')).toBeUndefined()   // Escape closed the preview, not the host
  })
  it('pointer input on the drawing does nothing while previewing', async () => {
    const { wrapper, pen, doc } = mountFlower(); mounted = wrapper
    pen.selectTool('path')
    pen.startCleanup(); await nextTick()
    const n = doc.value.entities.length
    await wrapper.find('svg').trigger('pointerdown', { button: 0, clientX: 100, clientY: 100 })
    expect(doc.value.entities.length).toBe(n)
    expect(pen.pendingPath.value).toBeNull()
  })
  it('a select-tool press on empty canvas starts no marquee while previewing', async () => {
    const { wrapper, pen } = mountFlower(); mounted = wrapper
    pen.startCleanup(); await nextTick()
    const svg = wrapper.find('svg')
    await svg.trigger('pointerdown', { button: 0, clientX: 5, clientY: 5 })
    await svg.trigger('pointermove', { buttons: 1, clientX: 200, clientY: 200 })
    expect(wrapper.find('[data-marquee]').exists()).toBe(false)
  })
})

describe('PenOverlay — ⌥⇧C mid gesture', () => {
  it('a live marquee is dropped before the preview opens', async () => {
    const { wrapper, pen } = mountFlower(); mounted = wrapper
    const svg = wrapper.find('svg')
    await svg.trigger('pointerdown', { button: 0, clientX: 5, clientY: 5 })
    await svg.trigger('pointermove', { buttons: 1, clientX: 200, clientY: 200 })
    expect(wrapper.find('[data-marquee]').exists()).toBe(true)
    window.dispatchEvent(altShiftC()); await nextTick()
    expect(pen.cleanup.value).not.toBeNull()
    expect(wrapper.find('[data-marquee]').exists()).toBe(false)
    // the rest of that press does nothing: no selection change on release
    await svg.trigger('pointerup', { button: 0, clientX: 200, clientY: 200 })
    expect(pen.selection.value).toEqual([])
  })
  it('a point drag settles as its own step first (a plain move); the preview starts from the settled drawing and the release does nothing', async () => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const a = addPoint(doc.value, 2, 2), b = addPoint(doc.value, 8, 2)
    addLine(doc.value, a, b)
    addPoint(doc.value, 8.85, 2.97)   // a loose point right by where the drag stops: releasing there would join onto it
    const pen = usePen({ doc: doc as any, view: ref(view) })
    const wrapper = mount(PenOverlay, { props: { pen, view, width: 680, height: 460 }, attachTo: document.body })
    mounted = wrapper
    expect(pen.canUndo()).toBe(false)
    await wrapper.find(`circle[data-point="${b}"]`).trigger('pointerdown', { button: 0, clientX: 312, clientY: 332 })
    await wrapper.find('svg').trigger('pointermove', { buttons: 1, clientX: 340, clientY: 300 })
    // mid drag the point sits on the loose point's spot (the pull), not yet joined
    expect(pointsOf(doc.value).find(p => p[0] === b)!.slice(1)).toEqual([8.85, 2.97])
    window.dispatchEvent(altShiftC()); await nextTick()
    const s = pen.cleanup.value
    expect(s).not.toBeNull()
    // settled as a plain move — back under the pointer, not joined — as its
    // own undo step, and that is the drawing the preview cleans
    const settled = pointsOf(doc.value)
    expect(settled).toHaveLength(3)
    expect(settled.find(p => p[0] === b)!.slice(1)).not.toEqual([8.85, 2.97])
    expect(pointsOf(s!.original)).toEqual(settled)
    expect(pen.canUndo()).toBe(true)
    // the rest of that press — more moves, the release on the loose point —
    // neither moves, joins nor commits anything
    await wrapper.find('svg').trigger('pointermove', { buttons: 1, clientX: 400, clientY: 200 })
    await wrapper.find('svg').trigger('pointerup', { button: 0, clientX: 340, clientY: 300 })
    expect(pointsOf(doc.value)).toEqual(settled)
    expect(pen.cleanup.value).toBe(s)
  })
})
