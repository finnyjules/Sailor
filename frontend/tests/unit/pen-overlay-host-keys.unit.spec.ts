// @vitest-environment happy-dom
//
// Task 4 (shared pen — Plan B): PenOverlay's `keyboard="host"` mode. With it,
// the overlay registers NO window key listeners of its own; a host feeds keys
// in via the exposed onHostKeydown/onHostKeyup. onHostKeydown must run the
// same typing guard and focused-control rule as the window-mode listener
// BEFORE touching the pen, since a host calls it from its OWN capture-phase
// window listener — which runs before a field's own handlers, so a field's
// stopPropagation cannot protect it.
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen } from '~/composables/pen/usePen'
import PenOverlay from '~/components/pen/PenOverlay.vue'

const view: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }

function mountOverlay(keyboard?: 'window' | 'host') {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const pen = usePen({ doc: doc as any, view: ref(view) })
  const props: Record<string, unknown> = { pen, view, width: 80, height: 80 }
  if (keyboard) props.keyboard = keyboard
  const wrapper = mount(PenOverlay, { props })
  return { wrapper, doc }
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
})
