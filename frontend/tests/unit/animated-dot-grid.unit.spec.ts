// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'

// The grid sits behind every glass node. A grid that repaints every frame makes the
// browser re-blur every node every frame, so at rest it must stop asking for frames.
const viewport = ref({ x: 0, y: 0, zoom: 1 })
vi.mock('@vue-flow/core', () => ({ useVueFlow: () => ({ viewport }) }))

import AnimatedDotGrid from '~/components/vue-canvas/AnimatedDotGrid.vue'

enableAutoUnmount(afterEach)

let queue: FrameRequestCallback[] = []
let fills = 0
const flush = () => { const q = queue; queue = []; q.forEach(cb => cb(performance.now())) }

beforeEach(() => {
  queue = []; fills = 0
  viewport.value = { x: 0, y: 0, zoom: 1 }
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(cb); return queue.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const noop = () => {}
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'fill' ? () => { fills++ } : noop), set: () => true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as any)
  vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('AnimatedDotGrid', () => {
  it('draws once and then stops asking for frames at rest', async () => {
    mount(AnimatedDotGrid)
    expect(queue.length).toBe(1)
    flush()
    expect(queue.length).toBe(0)
  })

  it('draws every resting dot with a single fill', async () => {
    mount(AnimatedDotGrid)
    flush()
    expect(fills).toBe(1)
  })

  it('redraws once per pan frame, however many viewport writes land in it', async () => {
    mount(AnimatedDotGrid)
    flush()
    viewport.value = { x: 10, y: 0, zoom: 1 }
    await nextTick()
    viewport.value = { x: 20, y: 0, zoom: 1 }
    await nextTick()
    expect(queue.length).toBe(1)
    flush()
    expect(queue.length).toBe(0)
  })

  it('keeps animating while a run is going, and stops after it ends', async () => {
    const w = mount(AnimatedDotGrid, { props: { running: true } })
    flush(); flush(); flush()
    expect(queue.length).toBe(1)
    await w.setProps({ running: false })
    flush()
    expect(queue.length).toBe(0)
  })
})
