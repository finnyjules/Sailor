// @vitest-environment happy-dom
// A pick made while the tile stills are still painting must still free the
// SpaceType engines: the engine is only held once its dynamic imports resolve,
// so the dispose that runs at pick time finds nothing — the late paint must
// trigger a second dispose when it settles.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const { disposeSpaceTypeStill, paintStill, gate } = vi.hoisted(() => {
  const gate: { release: () => void } = { release: () => {} }
  const wait = new Promise<void>(r => { gate.release = r })
  return {
    disposeSpaceTypeStill: vi.fn(),
    paintStill: vi.fn(async () => { await wait; return true }),
    gate,
  }
})
vi.mock('~/lib/startModal/stills', () => ({
  paintStill,
  stillRendererFor: (id: string) => (['gen', 'style', 'edit', 'upscale', 'video'].includes(id) ? null : () => {}),
  ANIMATED_STILLS: new Set(['expressive']),
}))
vi.mock('~/lib/startModal/spaceTypeStill', () => ({ disposeSpaceTypeStill }))

import StartProjectModal from '~/components/StartProjectModal.vue'
import { useStartTileHover } from '~/composables/useStartTileHover'

const realRect = HTMLCanvasElement.prototype.getBoundingClientRect
afterEach(() => { HTMLCanvasElement.prototype.getBoundingClientRect = realRect })

describe('start modal quick pick', () => {
  it('disposes the SpaceType engines once paints that were in flight at the pick settle', async () => {
    // happy-dom lays nothing out; give the tile canvases a size so the stills paint.
    HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 60, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 60, toJSON() {} }) as DOMRect
    const w = mount(StartProjectModal, { attachTo: document.body })
    await flushPromises()
    expect(paintStill).toHaveBeenCalled()          // paints are in flight, not settled

    await w.get('[data-testid="start-tile-gradient"]').trigger('click')
    expect(w.emitted('start')![0]).toEqual(['gradient'])
    disposeSpaceTypeStill.mockClear()              // the pick-time dispose found nothing yet

    gate.release()                                 // the paints finish after the pick
    await flushPromises()
    expect(disposeSpaceTypeStill).toHaveBeenCalled()
    w.unmount()
  })

  it('the hover loop does not restart after stopAll, and a late hover paint calls afterStop', async () => {
    const afterStop = vi.fn()
    let rafCb: FrameRequestCallback | null = null
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { rafCb = cb; return 1 })
    const Host = { setup() { return { hover: useStartTileHover({ afterStop }) } }, render: () => h('i') }
    const w = mount(Host)
    const hover = (w.vm as any).hover
    const canvas = document.createElement('canvas')
    paintStill.mockClear()
    hover.enter('expressive', canvas)
    rafCb!(performance.now() + 16)                 // one tick starts a paint (async, still in flight)
    expect(paintStill).toHaveBeenCalledTimes(1)
    hover.stopAll()
    hover.enter('expressive', canvas)               // no restart once stopped
    expect(raf).toHaveBeenCalledTimes(2)           // the first enter + the tick's re-arm only
    await flushPromises()                          // gate already released above → paint settles
    expect(afterStop).toHaveBeenCalledTimes(1)
    raf.mockRestore()
    w.unmount()
  })
})
