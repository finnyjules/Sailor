// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FinishLightControl from '~/components/vue-canvas/compositor/FinishLightControl.vue'
import StudioHint from '~/components/vue-canvas/studio/StudioHint.vue'
import { LIGHT_PRESETS, DEFAULT_FRAME_LIGHT } from '~/lib/compositor/frameLight'

describe('FinishLightControl', () => {
  it('shows the four presets by name', () => {
    const w = mount(FinishLightControl, { props: { light: DEFAULT_FRAME_LIGHT } })
    for (const label of ['Top left', 'Top right', 'Overhead', 'Raking']) expect(w.text()).toContain(label)
  })
  it('emits the preset light when one is picked', async () => {
    const w = mount(FinishLightControl, { props: { light: DEFAULT_FRAME_LIGHT } })
    const raking = w.findAll('button').find(b => b.text() === 'Raking')!
    await raking.trigger('click')
    expect(w.emitted('update')![0]).toEqual([LIGHT_PRESETS.raking])
  })
  it('explains the handle', () => {
    const w = mount(FinishLightControl, { props: { light: DEFAULT_FRAME_LIGHT } })
    expect(w.text()).toContain('Drag the light on the canvas')
  })
})

describe('FinishLightControl, lit by the Frame lights', () => {
  it('says so, hides the presets, and emits select-light', async () => {
    const w = mount(FinishLightControl, { props: { light: DEFAULT_FRAME_LIGHT, framelit: true } })
    const btn = w.find('[data-testid="finish-light-framelit"]')
    expect(btn.text()).toBe("Lit by the Frame's lights")
    expect(w.find('[data-testid="finish-light-preset"]').exists()).toBe(false)
    expect(w.text()).not.toContain('Raking')
    expect(w.findComponent(StudioHint).props('text')).toBe('Every light on this Frame lights the finish.')
    await btn.trigger('click')
    expect(w.emitted('select-light')).toHaveLength(1)
  })
})
