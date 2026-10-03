// @vitest-environment happy-dom
// Step 3, LC7: hosted has no Python to key an Animate clip with, so the route
// refuses there and the panel hides its Generate controls (`canGenerate` false,
// from useLayerAnimate().available). A layer that already has a clip keeps its
// takes, Speed and Remove clip.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Panel from '~/components/vue-canvas/compositor/CompositorAnimatePanel.vue'
import { createImageLayer, type ImageLayer } from '~/composables/useCompositorLayers'

const still = (): ImageLayer => createImageLayer('rose.png', 1)
const living = (): ImageLayer => ({
  ...still(),
  clip: { dir: 'sailor_clips/c', frames: 24, fps: 24, speed: 1, prompt: 'petals sway', model: 'seedance-2.0' },
})
const mountP = (layer: ImageLayer, canGenerate?: boolean) =>
  mount(Panel, { props: { layer, busy: false, error: '', ...(canGenerate === undefined ? {} : { canGenerate }) } })

describe('CompositorAnimatePanel when Animate cannot run (hosted)', () => {
  it('offers Generate by default', () => {
    expect(mountP(still()).find('button[data-role="generate"]').exists()).toBe(true)
  })

  it('shows nothing for a still', () => {
    const w = mountP(still(), false)
    expect(w.find('button[data-role="generate"]').exists()).toBe(false)
    expect(w.find('textarea').exists()).toBe(false)
    expect(w.text()).not.toContain('Animate')
  })

  it('keeps Speed and Remove clip for a layer that already moves', () => {
    const w = mountP(living(), false)
    expect(w.find('button[data-role="generate"]').exists()).toBe(false)
    expect(w.find('select[data-role="model"]').exists()).toBe(false)
    expect(w.find('[data-role="speed"]').exists()).toBe(true)
    expect(w.find('button[data-role="remove"]').exists()).toBe(true)
  })
})
