// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import VaryPalette from '~/components/vue-canvas/VaryPalette.vue'
import { DEFAULT_VARY, VARY_PALETTE_MAX } from '~/lib/vary'

describe('VaryPalette', () => {
  // Asserts the actual swatches, not just a count — a fallback to any two arbitrary
  // colours passed the count-only version.
  it('falls back to the default palette when given nothing', () => {
    for (const empty of [undefined, [] as string[]]) {
      const w = mount(VaryPalette, { props: { modelValue: empty } })
      const shown = w.findAll('input[type="color"]').map((i) => (i.element as HTMLInputElement).value)
      expect(shown).toEqual(DEFAULT_VARY.palette)
    }
  })

  it('renders one swatch per colour', () => {
    const w = mount(VaryPalette, { props: { modelValue: ['#ff0000', '#00ff00', '#0000ff'] } })
    expect(w.findAll('input[type="color"]').length).toBe(3)
  })

  // Asserts the CONTENT, not the length — an add() that discarded the existing palette
  // and returned two fresh swatches passed the length-only version.
  it('keeps the existing swatches when one is added', async () => {
    const w = mount(VaryPalette, { props: { modelValue: ['#ff0000', '#00ff00'] } })
    await w.get('[data-test="vary-palette-add"]').trigger('click')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as string[]
    expect(emitted.slice(0, 2)).toEqual(['#ff0000', '#00ff00'])
    expect(emitted.length).toBe(3)
  })

  // The one place this component departs from storing what it is given: an 8-digit
  // alpha hex is shown to the native colour input as 6 digits, because the input
  // silently renders anything else as black. The STORED value must survive untouched
  // through edits to its siblings.
  it('shows an alpha swatch without alpha, and keeps it stored with alpha', async () => {
    const w = mount(VaryPalette, { props: { modelValue: ['#4c6ef5ff', '#00ff00'] } })
    const shown = w.findAll('input[type="color"]').map((i) => (i.element as HTMLInputElement).value)
    expect(shown[0]).toBe('#4c6ef5')
    await w.get('[data-test="vary-palette-add"]').trigger('click')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as string[]
    expect(emitted[0]).toBe('#4c6ef5ff')
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
