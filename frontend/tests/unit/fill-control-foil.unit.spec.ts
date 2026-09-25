// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FillControl from '~/components/vue-canvas/compositor/FillControl.vue'
import { DEFAULT_FOIL_FILL } from '~/lib/compositor/paint'
import { DEFAULT_FRAME_LIGHT, LIGHT_PRESETS } from '~/lib/compositor/frameLight'

const optionValues = (w: ReturnType<typeof mount>) => w.findAll('option').map(o => o.attributes('value'))
async function openPanel(w: ReturnType<typeof mount>) {
  await w.findAll('button')[0]!.trigger('click')
}

describe('FillControl — Foil', () => {
  it('offers Foil only when the host passes allowFoil', async () => {
    const plain = mount(FillControl, { props: { modelValue: '#ff0000' } })
    await openPanel(plain)
    expect(optionValues(plain)).not.toContain('foil')

    const frame = mount(FillControl, { props: { modelValue: '#ff0000', allowFoil: true } })
    await openPanel(frame)
    const values = optionValues(frame)
    expect(values).toContain('foil')
    // right after Holographic
    expect(values.indexOf('foil')).toBe(values.indexOf('holographic') + 1)
    expect(frame.find('option[value="foil"]').text()).toBe('Foil')
  })

  it('is never offered on a nested (shader input) picker', async () => {
    const w = mount(FillControl, { props: { modelValue: '#ff0000', allowFoil: true, nested: true } })
    await openPanel(w)
    expect(optionValues(w)).not.toContain('foil')
  })

  it('picking Foil emits a copy of the default foil', async () => {
    const w = mount(FillControl, { props: { modelValue: '#ff0000', allowFoil: true } })
    await openPanel(w)
    await w.find('select').setValue('foil')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0]
    expect(emitted).toEqual(DEFAULT_FOIL_FILL)
    expect(emitted).not.toBe(DEFAULT_FOIL_FILL)
  })

  it('reads a foil value back as Foil and shows its dials in sentence case', async () => {
    const w = mount(FillControl, { props: { modelValue: { ...DEFAULT_FOIL_FILL, metal: 'rose' }, allowFoil: true, light: DEFAULT_FRAME_LIGHT } })
    await openPanel(w)
    expect((w.find('select').element as HTMLSelectElement).value).toBe('foil')
    const text = w.text()
    for (const label of ['Metal', 'Brushed', 'Pressed in', 'Grain', 'Gold', 'Silver', 'Rose gold', 'Copper', 'Light']) expect(text).toContain(label)
    expect(text).not.toMatch(/pressed_in|rose\b(?! gold)|gold_foil/)
  })

  it('a metal pick keeps the other dials', async () => {
    const start = { ...DEFAULT_FOIL_FILL, brushed: 0.2, pressed: 0.9, grain: 0.7 }
    const w = mount(FillControl, { props: { modelValue: start, allowFoil: true } })
    await openPanel(w)
    await w.findAll('button').find(b => b.text() === 'Silver')!.trigger('click')
    expect(w.emitted('update:modelValue')!.at(-1)![0]).toEqual({ ...start, metal: 'silver' })
  })

  it('the light control emits update:light for the host', async () => {
    const w = mount(FillControl, { props: { modelValue: { ...DEFAULT_FOIL_FILL }, allowFoil: true, light: DEFAULT_FRAME_LIGHT } })
    await openPanel(w)
    await w.findAll('button').find(b => b.text() === 'Raking')!.trigger('click')
    expect(w.emitted('update:light')![0]).toEqual([LIGHT_PRESETS.raking])
  })
})
