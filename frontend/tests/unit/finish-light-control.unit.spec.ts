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
  it('explains the handle in a tooltip on the label, not a line in the panel', () => {
    const w = mount(FinishLightControl, { props: { light: DEFAULT_FRAME_LIGHT } })
    expect(w.findComponent(StudioHint).props('text')).toContain('Drag the light on the canvas')
    expect(w.text()).not.toContain('Drag the light on the canvas')
  })
})
