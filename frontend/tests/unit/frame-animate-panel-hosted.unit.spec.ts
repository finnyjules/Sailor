// @vitest-environment happy-dom
// Step 3, LC10: Animate keys its clips in Sailor's own server code, so it runs in
// hosted too: LC7's `canGenerate` gate is gone and the panel always offers Generate.
// While a clip is being made it offers Stop, which the modal wires to
// useLayerAnimate().stop (the route then leaves nothing behind).
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Panel from '~/components/vue-canvas/compositor/CompositorAnimatePanel.vue'
import { createImageLayer, type ImageLayer } from '~/composables/useCompositorLayers'

const still = (): ImageLayer => createImageLayer('rose.png', 1)
const mountP = (busy: boolean, extra: Record<string, unknown> = {}) =>
  mount(Panel, { props: { layer: still(), busy, error: '', ...extra } })

describe('CompositorAnimatePanel, hosted and local alike', () => {
  it('offers Generate, with no way to hide it', () => {
    const w = mountP(false, { canGenerate: false })
    expect(w.find('button[data-role="generate"]').exists()).toBe(true)
    expect(w.find('textarea').exists()).toBe(true)
  })

  it('offers Stop only while generating, and says so', async () => {
    expect(mountP(false).find('button[data-role="stop"]').exists()).toBe(false)
    const w = mountP(true)
    const stop = w.find('button[data-role="stop"]')
    expect(stop.text()).toBe('Stop')
    await stop.trigger('click')
    expect(w.emitted('stop')).toHaveLength(1)
  })
})
