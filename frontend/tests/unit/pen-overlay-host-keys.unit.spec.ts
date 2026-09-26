// @vitest-environment happy-dom
//
// Task 4 (shared pen — Plan B): PenOverlay's `keyboard="host"` mode. With it,
// the overlay registers NO window key listeners of its own; a host feeds keys
// in via the exposed onHostKeydown/onHostKeyup. onHostKeydown must run the
// same typing guard and focused-control rule as the window-mode listener
// BEFORE touching the pen, since a host calls it from its OWN capture-phase
// window listener — which runs before a field's own handlers, so a field's
// stopPropagation cannot protect it.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen } from '~/composables/pen/usePen'
import PenOverlay from '~/components/pen/PenOverlay.vue'
import { addPoint, addLine } from '~/lib/sketch/edit'
import { FRAME_PEN_TOOLS } from '~/composables/frame/useFramePenSession'

const view: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }

function mountOverlay(keyboard?: 'window' | 'host') {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const pen = usePen({ doc: doc as any, view: ref(view) })
  const props: Record<string, unknown> = { pen, view, width: 80, height: 80 }
  if (keyboard) props.keyboard = keyboard
  const wrapper = mount(PenOverlay, { props })
  return { wrapper, doc, pen }
}

let mounted: ReturnType<typeof mountOverlay>['wrapper'] | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
})

describe('PenOverlay keyboard="host"', () => {
  it('registers no window keydown listener: a window Escape emits nothing', async () => {
    const { wrapper } = mountOverlay('host')
    mounted = wrapper
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('cancel')).toBeUndefined()
  })

  it('onHostKeydown(Escape) returns true and emits cancel', async () => {
    const { wrapper } = mountOverlay('host')
    mounted = wrapper
    const consumed = (wrapper.vm as any).onHostKeydown(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(consumed).toBe(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('onHostKeydown(Enter) returns true and emits commit', async () => {
    const { wrapper } = mountOverlay('host')
    mounted = wrapper
    const consumed = (wrapper.vm as any).onHostKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(consumed).toBe(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('commit')).toHaveLength(1)
  })

  it('with keyboard omitted (default "window"), a window Escape still emits cancel unchanged', async () => {
    const { wrapper } = mountOverlay()
    mounted = wrapper
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('with an <input> focused, onHostKeydown(Backspace) and onHostKeydown(Enter) return false and change nothing', async () => {
    const { wrapper } = mountOverlay('host')
    mounted = wrapper
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)

    const backspaceConsumed = (wrapper.vm as any).onHostKeydown(new KeyboardEvent('keydown', { key: 'Backspace' }))
    expect(backspaceConsumed).toBe(false)
    const enterConsumed = (wrapper.vm as any).onHostKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(enterConsumed).toBe(false)

    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('commit')).toBeUndefined()
    expect(wrapper.emitted('cancel')).toBeUndefined()
    input.remove()
  })

  it('exposes onHostBlur, which calls the pen\'s own blur handler (the window-mode blur listener\'s job)', () => {
    const { wrapper, pen } = mountOverlay('host')
    mounted = wrapper
    const blurSpy = vi.spyOn(pen, 'onBlur')
    ;(wrapper.vm as any).onHostBlur()
    expect(blurSpy).toHaveBeenCalledTimes(1)
  })

  it('captures the keyboard mode once at setup: changing the prop after mount does not skip cleanup (no window-listener leak)', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    // mounts in "window" mode (listeners registered), then the prop flips to
    // "host" before unmount — a naive `if (props.keyboard === 'host') return`
    // in onUnmounted would read the NEW value and skip removeEventListener,
    // leaking the window listeners forever.
    const { wrapper } = mountOverlay('window')
    const addedKeydown = addSpy.mock.calls.filter(c => c[0] === 'keydown').length
    const addedKeyup = addSpy.mock.calls.filter(c => c[0] === 'keyup').length
    const addedBlur = addSpy.mock.calls.filter(c => c[0] === 'blur').length
    expect(addedKeydown).toBeGreaterThan(0)
    await wrapper.setProps({ keyboard: 'host' })
    wrapper.unmount()
    mounted = null
    const removedKeydown = removeSpy.mock.calls.filter(c => c[0] === 'keydown').length
    const removedKeyup = removeSpy.mock.calls.filter(c => c[0] === 'keyup').length
    const removedBlur = removeSpy.mock.calls.filter(c => c[0] === 'blur').length
    expect(removedKeydown).toBe(addedKeydown)
    expect(removedKeyup).toBe(addedKeyup)
    expect(removedBlur).toBe(addedBlur)
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })
})

// Final review: a tool key pressed in the middle of an overlay gesture (a
// Select marquee, a point drag) settles that gesture first — the way parking
// the overlay does — so nothing is left stuck or folded into a later step.
// Both keyboard paths: the host's onHostKeydown and the window listener.
describe('PenOverlay: a tool key settles live overlay gestures', () => {
  function mountWith(build: (d: SketchDoc) => void, keyboard: 'window' | 'host', tools?: any[]) {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    build(doc.value)
    const pen = usePen({ doc: doc as any, view: ref(view), options: tools ? { tools } : undefined })
    const wrapper = mount(PenOverlay, { props: { pen, view, width: 400, height: 400, keyboard, active: true }, attachTo: document.body })
    return { wrapper, doc, pen }
  }
  const press = (w: any, keyboard: 'window' | 'host', key: string) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    if (keyboard === 'host') return (w.vm as any).onHostKeydown(ev)
    window.dispatchEvent(ev)
    return ev.defaultPrevented
  }

  for (const keyboard of ['host', 'window'] as const) {
    it(`(${keyboard}) T mid marquee clears the marquee; later moves reach the new tool`, async () => {
      const { wrapper, pen } = mountWith(d => {
        addLine(d, addPoint(d, 1, 5), addPoint(d, 9, 5))   // screen y = 230, x 74..346
      }, keyboard)
      mounted = wrapper
      const svg = wrapper.find('svg')
      await svg.trigger('pointerdown', { button: 0, clientX: 20, clientY: 20 })
      await svg.trigger('pointermove', { buttons: 1, clientX: 80, clientY: 80 })
      expect((wrapper.vm as any).$.setupState.marqueeRect).not.toBeNull()
      expect(press(wrapper, keyboard, 't')).toBe(true)
      await wrapper.vm.$nextTick()
      expect(pen.tool.value).toBe('trim')
      await svg.trigger('pointerup', { button: 0, clientX: 80, clientY: 80 })
      await wrapper.vm.$nextTick()
      expect((wrapper.vm as any).$.setupState.marqueeRect).toBeNull()
      // a later move is Trim's hover, not a swallowed marquee move
      await svg.trigger('pointermove', { buttons: 0, clientX: 200, clientY: 230 })
      expect(pen.trimHover.value).not.toBeNull()
    })

    it(`(${keyboard}) P mid point drag commits the move as its own undo step, with no join`, async () => {
      let a = '', b = ''
      const { wrapper, pen, doc } = mountWith(d => {
        a = addPoint(d, 2, 2); b = addPoint(d, 6, 2)
      }, keyboard)
      mounted = wrapper
      const pt = wrapper.find(`[data-point="${a}"]`)
      // (2,2) → screen (108, 332); drag toward b = (6,2) → screen (244, 332), stopping just short
      await pt.trigger('pointerdown', { button: 0, clientX: 108, clientY: 332 })
      const svg = wrapper.find('svg')
      await svg.trigger('pointermove', { buttons: 1, clientX: 180, clientY: 332 })
      await svg.trigger('pointermove', { buttons: 1, clientX: 242, clientY: 332 })   // in reach of b
      expect(press(wrapper, keyboard, 'p')).toBe(true)
      expect(pen.tool.value).toBe('path')
      const pa = doc.value.entities.find(e => e.id === a) as any
      expect(pa).toBeTruthy()                                   // not merged into b
      expect(doc.value.entities.find(e => e.id === b)).toBeTruthy()
      expect(pa.x).toBeCloseTo((242 - 40) / 34, 6)               // back under the pointer, not on b
      expect(pen.canUndo()).toBe(true)
      // a later release changes nothing more
      await svg.trigger('pointerup', { button: 0, clientX: 242, clientY: 332 })
      pen.undo()
      const back = doc.value.entities.find(e => e.id === a) as any
      expect(back.x).toBeCloseTo(2, 9); expect(back.y).toBeCloseTo(2, 9)
      expect(pen.canUndo()).toBe(false)
    })
  }
})

// Final review: the Frame host (CompositorModal) feeds every key to the pen
// through onHostKeydown; Trim, Cut and Dissolve are among the Frame's tools,
// so T, C and D arm them there.
describe('PenOverlay keyboard="host" with the Frame\'s tools', () => {
  it('T, C and D reach the pen and arm Trim, Cut and Dissolve', () => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const pen = usePen({ doc: doc as any, view: ref(view), options: { tools: FRAME_PEN_TOOLS } })
    const wrapper = mount(PenOverlay, { props: { pen, view, width: 80, height: 80, keyboard: 'host' } })
    mounted = wrapper
    for (const [key, tool] of [['t', 'trim'], ['c', 'cut'], ['d', 'dissolve'], ['v', 'select']] as const) {
      const consumed = (wrapper.vm as any).onHostKeydown(new KeyboardEvent('keydown', { key, cancelable: true }))
      expect(consumed).toBe(true)
      expect(pen.tool.value).toBe(tool)
    }
  })
})
