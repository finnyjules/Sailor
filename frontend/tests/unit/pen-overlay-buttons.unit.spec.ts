// @vitest-environment happy-dom
//
// Task 1 (shared pen — Plan C): a right-click (or any non-primary mouse
// button) must never place a point, drag a handle, or select an entity —
// only button 0 (the primary button) does. The browser's own context menu
// must also never appear over the pen.
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen } from '~/composables/pen/usePen'
import PenOverlay from '~/components/pen/PenOverlay.vue'

const view: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }

function mountOverlay() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const pen = usePen({ doc: doc as any, view: ref(view) })
  const wrapper = mount(PenOverlay, { props: { pen, view, width: 80, height: 80, active: true } })
  return { wrapper, doc, pen }
}

let mounted: ReturnType<typeof mountOverlay>['wrapper'] | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('PenOverlay ignores non-primary mouse buttons', () => {
  it('a right-click (button 2) pointerdown on the path tool places nothing', async () => {
    const { wrapper, pen } = mountOverlay()
    mounted = wrapper
    pen.selectTool('path')
    const svg = wrapper.find('svg')
    await svg.trigger('pointerdown', { button: 2, clientX: 10, clientY: 10 })
    expect(pen.doc.value.entities.length).toBe(0)
  })

  it('a primary click (button 0) pointerdown on the path tool places an anchor', async () => {
    const { wrapper, pen } = mountOverlay()
    mounted = wrapper
    pen.selectTool('path')
    const svg = wrapper.find('svg')
    await svg.trigger('pointerdown', { button: 0, clientX: 10, clientY: 10 })
    expect(pen.doc.value.entities.length).toBeGreaterThan(0)
  })

  it('a contextmenu event on the root svg is prevented', () => {
    const { wrapper } = mountOverlay()
    mounted = wrapper
    const evt = new Event('contextmenu', { bubbles: true, cancelable: true })
    wrapper.find('svg').element.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
  })
})
