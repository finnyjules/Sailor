// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import VaryPalette from '~/components/vue-canvas/VaryPalette.vue'
import { VARY_PALETTE_MAX } from '~/lib/vary'

describe('VaryPalette', () => {
  it('falls back to the default palette when given nothing', () => {
    const w = mount(VaryPalette, { props: { modelValue: undefined } })
    expect(w.findAll('input[type="color"]').length).toBeGreaterThanOrEqual(2)
  })

  it('renders one swatch per colour', () => {
    const w = mount(VaryPalette, { props: { modelValue: ['#ff0000', '#00ff00', '#0000ff'] } })
    expect(w.findAll('input[type="color"]').length).toBe(3)
  })

  it('emits a longer list when a swatch is added', async () => {
    const w = mount(VaryPalette, { props: { modelValue: ['#ff0000'] } })
    await w.get('[data-test="vary-palette-add"]').trigger('click')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as string[]
    expect(emitted.length).toBe(2)
  })

  it('hides the add button at the ceiling', () => {
    const full = Array.from({ length: VARY_PALETTE_MAX }, () => '#123456')
    const w = mount(VaryPalette, { props: { modelValue: full } })
    expect(w.find('[data-test="vary-palette-add"]').exists()).toBe(false)
  })

  it('emits a shorter list when a swatch is removed', async () => {
    const w = mount(VaryPalette, { props: { modelValue: ['#ff0000', '#00ff00'] } })
    await w.findAll('[data-test="vary-palette-remove"]')[0]!.trigger('click')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as string[]
    expect(emitted).toEqual(['#00ff00'])
  })

  it('refuses to remove the last swatch', () => {
    const w = mount(VaryPalette, { props: { modelValue: ['#ff0000'] } })
    expect(w.findAll('[data-test="vary-palette-remove"]').length).toBe(0)
  })
})
