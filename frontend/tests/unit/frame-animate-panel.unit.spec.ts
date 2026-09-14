// @vitest-environment happy-dom
// frontend/tests/unit/frame-animate-panel.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Panel from '~/components/vue-canvas/compositor/CompositorAnimatePanel.vue'
import { createImageLayer, type ImageLayer } from '~/composables/useCompositorLayers'

const still = (): ImageLayer => createImageLayer('rose.png', 1)
const living = (): ImageLayer => ({
  ...still(),
  clip: { dir: 'sailor_clips/c', frames: 24, fps: 24, speed: 1, prompt: 'petals sway', model: 'seedance-2.0' },
})
const mountP = (layer: ImageLayer, busy = false, error = '') => mount(Panel, { props: { layer, busy, error } })

describe('CompositorAnimatePanel', () => {
  it('shows prompt, model, length and a priced Generate button for a still', () => {
    const w = mountP(still())
    expect(w.find('textarea, input[type="text"]').exists()).toBe(true)
    const models = w.find('select[data-role="model"]')
    expect(models.findAll('option').map(o => o.text())).toEqual(['Seedance 2.0 (720p · 90 credits)', 'Hailuo H3 (768p · 45 credits)', 'Hailuo H3 Max (768p · 60 credits)', 'Kling 3.0 Pro (1080p · 84 credits)', 'FLUX 3 draft (720p · 45 credits)'])
    const btn = w.find('button[data-role="generate"]')
    expect(btn.text()).toMatch(/Generate/)
    expect(btn.text()).toMatch(/90 credits/)       // Seedance default, 5 s
    expect(w.find('[data-role="speed"]').exists()).toBe(false)
    expect(w.find('button[data-role="remove"]').exists()).toBe(false)
  })
  it('length options follow the chosen model', async () => {
    const w = mountP(still())
    await w.find('select[data-role="model"]').setValue('hailuo-h3')
    expect(w.find('select[data-role="length"]').findAll('option').map(o => o.text())).toEqual(['5 s', '6 s', '10 s'])
    await w.find('select[data-role="length"]').setValue('10')
    // The quote is the FLAT catalog row: the ledger holds the same amount for a 10 s
    // Hailuo clip as for a 5 s one, so the button must say 0.30, not 0.30 x 2.
    expect(w.find('button[data-role="generate"]').text()).toMatch(/45 credits/)
  })
  it('emits generate with prompt, model and seconds', async () => {
    const w = mountP(still())
    await w.find('textarea, input[type="text"]').setValue('petals open and settle')
    await w.find('select[data-role="model"]').setValue('seedance-2.0')
    await w.find('select[data-role="length"]').setValue('6')
    await w.find('button[data-role="generate"]').trigger('click')
    expect(w.emitted('generate')![0][0]).toEqual({ prompt: 'petals open and settle', model: 'seedance-2.0', seconds: 6 })
  })
  it('disables Generate while busy and shows the error text', () => {
    const w = mountP(still(), true, 'The model returned no video')
    expect((w.find('button[data-role="generate"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(w.text()).toContain('The model returned no video')
  })
  // Found in the browser: a clip whose model has left the catalog (renamed, retired)
  // matched no <option>, so the select rendered BLANK and the Generate button lost its
  // price. Prefill resolves through the catalog instead of trusting the stored string.
  it('falls back to the first catalog model when the clip names one that is gone', () => {
    const layer = { ...living(), clip: { ...living().clip!, model: 'gone' } }
    const w = mountP(layer)
    expect((w.find('select[data-role="model"]').element as HTMLSelectElement).value).toBe('seedance-2.0')
    expect(w.find('button[data-role="generate"]').text()).toMatch(/90 credits/)
  })
  it('with a clip: shows speed and remove, prefilled from the clip, and emits both', async () => {
    const w = mountP(living())
    expect(w.find('[data-role="speed"]').exists()).toBe(true)
    expect((w.find('textarea, input[type="text"]').element as HTMLInputElement).value).toBe('petals sway')
    const speed = w.findAllComponents({ name: 'StudioSlider' }).find(s => s.props('label') === 'Speed')!
    speed.vm.$emit('update:modelValue', 2)
    expect(w.emitted('speed')![0][0]).toBe(2)
    await w.find('button[data-role="remove"]').trigger('click')
    expect(w.emitted('remove')).toHaveLength(1)
  })
  // A re-roll used to overwrite the clip and orphan the old folder. Every generation is
  // now a take; the row appears once there is something to go back to.
  it('shows no takes row for a single take that is still the active clip', () => {
    const c = living().clip!
    expect(mountP({ ...living(), takes: [c] }).find('[data-role="takes"]').exists()).toBe(false)
  })
  it('lists every take, marks the active one, and emits the take you click', async () => {
    const one = living().clip!
    const two = { ...one, dir: 'sailor_clips/d', prompt: 'petals open', model: 'flux-3-draft' }
    const w = mountP({ ...living(), clip: two, takes: [one, two] })
    const takes = w.findAll('button[data-role="take"]')
    expect(takes).toHaveLength(2)
    expect(takes[0]!.attributes('aria-pressed')).toBe('false')
    expect(takes[1]!.attributes('aria-pressed')).toBe('true')
    expect(takes[0]!.find('img').attributes('src')).toContain('sailor_clips%2Fc')
    expect(takes[1]!.attributes('title')).toContain('flux-3-draft')
    await takes[0]!.trigger('click')
    expect(w.emitted('take')![0][0]).toEqual(one)
  })
  it('after Remove clip the takes stay, so one can be brought back', () => {
    const one = living().clip!
    const w = mountP({ ...still(), takes: [one] })
    expect(w.find('[data-role="takes"]').exists()).toBe(true)
    expect(w.find('button[data-role="take"]').attributes('aria-pressed')).toBe('false')
    expect(w.find('[data-role="speed"]').exists()).toBe(false)
  })
})
