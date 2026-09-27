// @vitest-environment happy-dom
//
// Pen stage 5 (final review): PenToolbar's Clean up row — the note when a
// run stopped early, and the Clean up button giving up focus when the
// preview closes, so the next Enter / Escape belong to the pen and the host.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addPath } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'

// the hover cards are look-only: pass their slot through
vi.mock('~/components/pen/PenTipCard.vue', async () => {
  const { defineComponent: dc } = await import('vue')
  return { default: dc({ setup: (_, { slots }) => () => slots.default?.() }) }
})
vi.mock('~/components/ui/tooltip', async () => {
  const { defineComponent: dc } = await import('vue')
  const pass = dc({ setup: (_, { slots }) => () => slots.default?.() })
  return { TooltipProvider: pass, Tooltip: pass, TooltipTrigger: pass }
})
const { default: PenToolbar } = await import('~/components/pen/PenToolbar.vue')

const view = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function flower(d: SketchDoc): void {
  const C: [number, number][] = [[6, 2], [12, 2], [12, 8], [6, 8]]
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const ex = x1 + 0.08, ey = y1 + 0.05
    const s = addPoint(d, x0, y0), e = addPoint(d, ex, ey), c = addPoint(d, (x0 + ex) / 2, (y0 + ey) / 2)
    addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
  }
}
function mountBar() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  flower(doc.value)
  const pen = usePen({ doc: doc as any, view: ref(view) })
  const wrapper = mount(PenToolbar, { props: { pen }, attachTo: document.body })
  return { wrapper, pen }
}
let mounted: ReturnType<typeof mountBar>['wrapper'] | null = null
afterEach(() => { mounted?.unmount(); mounted = null; document.body.innerHTML = '' })

describe('PenToolbar — Clean up', () => {
  it.each(['applyCleanup', 'cancelCleanup'] as const)('the Clean up button gives up focus when %s closes the preview', async (close) => {
    const { wrapper, pen } = mountBar(); mounted = wrapper
    const btn = wrapper.find('[data-act="cleanup"]').element as HTMLButtonElement
    btn.focus()
    await wrapper.find('[data-act="cleanup"]').trigger('click')
    expect(pen.cleanup.value).not.toBeNull()
    expect(document.activeElement).toBe(btn)
    pen[close](); await nextTick()
    expect(pen.cleanup.value).toBeNull()
    expect(document.activeElement).not.toBe(btn)
  })
  it('a focus elsewhere is left alone when the preview closes', async () => {
    const { wrapper, pen } = mountBar(); mounted = wrapper
    const other = document.createElement('input')
    document.body.appendChild(other)
    pen.startCleanup(); await nextTick()
    other.focus()
    pen.cancelCleanup(); await nextTick()
    expect(document.activeElement).toBe(other)
  })
  it('a run that stopped early says so in the note', async () => {
    const { wrapper, pen } = mountBar(); mounted = wrapper
    pen.startCleanup(); await nextTick()
    expect(wrapper.find('[data-cleanup-note]').exists()).toBe(false)
    const s = pen.cleanup.value!
    pen.cleanup.value = { ...s, result: { ...s.result, stopped: true } }
    await nextTick()
    expect(wrapper.find('[data-cleanup-note]').text()).toBe('Stopped early — select a part to clean up the rest')
  })
})
