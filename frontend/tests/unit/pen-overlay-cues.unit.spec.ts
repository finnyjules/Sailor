// @vitest-environment happy-dom
//
// PenOverlay's draw-time cues: the ghost circle while bowing, the length
// dimension line on the rubber band, the ⊥ chip for the right-angle snap, and
// the soft glow under the cursor. All overlay-only (pointer-events none).
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen } from '~/composables/pen/usePen'
import PenOverlay from '~/components/pen/PenOverlay.vue'

const view: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }

function mountOverlay() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const pen = usePen({ doc: doc as any, view: ref(view) })
  const wrapper = mount(PenOverlay, { props: { pen, view, width: 400, height: 400, active: true } })
  return { wrapper, doc, pen }
}

let mounted: ReturnType<typeof mountOverlay>['wrapper'] | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})
function setup() {
  const m = mountOverlay()
  mounted = m.wrapper
  m.pen.selectTool('path')
  return m
}

describe('PenOverlay drawing cues', () => {
  it('draws the ghost circle, centre dot and radius leader while bowing, with the R chip on the leader', async () => {
    const { wrapper, pen } = setup()
    expect(wrapper.find('[data-bow-ghost]').exists()).toBe(false)
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0); pen.pathMove(2, 1)
    await nextTick()
    const ghost = wrapper.find('[data-bow-ghost]')
    expect(ghost.exists()).toBe(true)
    expect(ghost.attributes('pointer-events')).toBe('none')
    // circle through (0,0), (4,0), (2,1): centre (2,-1.5), r 2.5
    const c = ghost.find('circle')
    expect(Number(c.attributes('cx'))).toBeCloseTo(2, 6)
    expect(Number(c.attributes('cy'))).toBeCloseTo(-1.5, 6)
    expect(Number(c.attributes('r'))).toBeCloseTo(2.5, 6)
    expect(c.attributes('stroke-dasharray')).toBe('3 4')
    expect(wrapper.find('[data-bow-leader]').exists()).toBe(true)
    const chip = wrapper.find('[data-bow-chip]')
    expect(chip.text()).toBe('R 2.5')
    // centre (2,-1.5) → screen (108, 451); bow midpoint (2,1) → (108, 366); leader midpoint y 408.5
    const rect = chip.find('rect')
    expect(Number(rect.attributes('x')) + 20).toBeCloseTo(108, 6)
    expect(Number(rect.attributes('y')) + 7).toBeCloseTo(408.5, 6)
    pen.pathUp(2, 1)
    await nextTick()
    expect(wrapper.find('[data-bow-ghost]').exists()).toBe(false)
  })

  it('shows a dimension line on the rubber band with the length, then the typed buffer', async () => {
    const { wrapper, pen } = setup()
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathMove(3, 4)
    await nextTick()
    const dim = wrapper.find('[data-line-dim]')
    expect(dim.exists()).toBe(true)
    expect(dim.attributes('pointer-events')).toBe('none')
    expect(dim.text()).toBe('5.0')
    expect(dim.findAll('line')).toHaveLength(3)   // the dimension line + two ticks
    pen.dimBuffer.value = '12'
    await nextTick()
    expect(wrapper.find('[data-line-dim]').text()).toBe('12|')
  })

  it('hides the dimension line on a short band and while bowing', async () => {
    const { wrapper, pen } = setup()
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathMove(0.3, 0)   // ~10 px
    await nextTick()
    expect(wrapper.find('[data-line-dim]').exists()).toBe(false)
    pen.pathDown(4, 0); pen.pathMove(2, 1)
    await nextTick()
    expect(wrapper.find('[data-line-dim]').exists()).toBe(false)
  })

  it('the dimension line measures the right-angle-snapped placement', async () => {
    const { wrapper, pen } = setup()
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0); pen.pathUp(4, 0)
    pen.pathMove(4.1, 3)
    await nextTick()
    expect(wrapper.find('[data-line-dim]').text()).toBe('3.0')
  })

  it('shows the ⊥ chip at the corner while the right-angle snap is active', async () => {
    const { wrapper, pen } = setup()
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0); pen.pathUp(4, 0)
    pen.pathMove(5, 3)
    await nextTick()
    expect(wrapper.find('[data-right-angle]').exists()).toBe(false)
    pen.pathMove(4.1, 3)
    await nextTick()
    const chip = wrapper.find('[data-right-angle]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('⊥')
    // corner (4,0) → screen (176, 400); chip rect sits at +6, -16 like the T chip
    expect(Number(chip.find('rect').attributes('x'))).toBeCloseTo(182, 6)
    // the rubber band preview agrees: it ends at the snapped spot
    expect(wrapper.find('[data-path-preview]').attributes('d')).toMatch(/L 4 3$/)
  })

  it('draws the cursor glow during a path drag, and at the snap target while hovering', async () => {
    const { wrapper, pen } = setup()
    pen.pathDown(0, 0); pen.pathMove(0.1, 0.1)
    await nextTick()
    const glow = wrapper.find('[data-cursor-glow]')
    expect(glow.exists()).toBe(true)
    expect(glow.attributes('pointer-events')).toBe('none')
    pen.pathUp(0.1, 0.1)
    pen.pathMove(3, 3)   // nothing in reach
    await nextTick()
    expect(wrapper.find('[data-cursor-glow]').exists()).toBe(false)
    pen.pathMove(0.2, 0.1)   // within snap reach of the first anchor
    await nextTick()
    const g = wrapper.find('[data-cursor-glow] circle')
    expect(Number(g.attributes('cx'))).toBeCloseTo(40, 6)    // anchor (0,0) → screen (40, 400)
    expect(Number(g.attributes('cy'))).toBeCloseTo(400, 6)
  })

  it('draws the cursor glow during a curve drag', async () => {
    const { wrapper, pen } = setup()
    pen.selectTool('curve')
    pen.curveDown(0, 0); pen.curveMove(1, 1)
    await nextTick()
    expect(wrapper.find('[data-cursor-glow]').exists()).toBe(true)
    pen.curveUp(1, 1)
    await nextTick()
    expect(wrapper.find('[data-cursor-glow]').exists()).toBe(false)
  })
})
