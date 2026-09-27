// @vitest-environment happy-dom
//
// Pen stage 7, PenOverlay: in Fill the area under the pointer is hatched
// (through a clip of its outline drawn under the view), filled areas are
// tinted, a sleeping fill rings its gap, undo brings the fill back.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addPath } from '~/lib/sketch/edit'
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
const { default: PenOverlay } = await import('~/components/pen/PenOverlay.vue')
const view = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mountSquare() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const ids = [[1, 1], [5, 1], [5, 5], [1, 5]].map(([x, y]) => addPoint(doc.value, x!, y!))
  addPath(doc.value, ids, ids.map(() => ({ kind: 'line' as const })), true)
  const pen = usePen({ doc, view: ref(view) })
  const wrapper = mount(PenOverlay, { props: { pen, view, width: 680, height: 460 }, attachTo: document.body })
  return { wrapper, doc, pen }
}
describe('PenOverlay fills', () => {
  it('hatches the area under the pointer in Fill, tints filled areas, rings a sleeping fill’s gap', async () => {
    const { wrapper, pen } = mountSquare()
    pen.selectTool('fill')
    pen.fillMove(2, 2); await nextTick()
    const hover = wrapper.find('[data-fill-hover]')
    expect(hover.exists()).toBe(true)
    expect(hover.attributes('data-filled')).toBe('no')
    expect(hover.attributes('pointer-events')).toBe('none')
    const clip = wrapper.find('clipPath path')
    expect(clip.attributes('d')).toMatch(/^M /)
    expect(clip.attributes('transform')).toMatch(/^matrix\(/)
    pen.fillClick(2, 2); await nextTick()
    const area = wrapper.find('[data-fill-area]')
    expect(area.attributes('d')).toMatch(/Z$/)
    expect(area.attributes('pointer-events')).toBe('none')
    expect(wrapper.find('[data-fill-hover]').attributes('data-filled')).toBe('yes')
    // open the square: remove one side with Trim, the fill sleeps and rings show
    pen.selectTool('trim')
    pen.trimDown(3, 5); pen.trimUp(3, 5); await nextTick()
    expect(wrapper.find('[data-fill-area]').exists()).toBe(false)
    expect(wrapper.find('[data-fill-hover]').exists()).toBe(false)
    expect(wrapper.findAll('[data-fill-gap]').length).toBe(2)
    pen.undo(); await nextTick()
    expect(wrapper.find('[data-fill-area]').exists()).toBe(true)
    expect(wrapper.findAll('[data-fill-gap]').length).toBe(0)
    wrapper.unmount()
  })
})
