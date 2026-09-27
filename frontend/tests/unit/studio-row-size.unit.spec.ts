// @vitest-environment happy-dom
// frontend/tests/unit/studio-row-size.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StudioRow from '~/components/vue-canvas/studio/StudioRow.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'

const spec = { key: 'strength', label: 'Reference strength', kind: 'slider', min: 0, max: 100, step: 1, default: 70 } as any
const row = (w: ReturnType<typeof mount>) => w.find('[data-studio-row]')

describe('StudioRow size', () => {
  it('is 28px by default (studio inspectors)', () => {
    const w = mount(StudioRow, { props: { spec, modelValue: 70 } })
    expect(row(w).classes()).toContain('h-7')
    expect(row(w).classes()).toContain('px-2.5')
  })
  it('is 32px with 11px padding on nodes', () => {
    const w = mount(StudioRow, { props: { spec, modelValue: 70, size: 'comfortable' } })
    expect(row(w).classes()).toContain('h-8')
    expect(row(w).classes()).toContain('px-[11px]')
  })
})

describe('StudioRow quieter fills', () => {
  it('rests at 3% and answers hover at 6.5%', () => {
    const w = mount(StudioRow, { props: { spec, modelValue: 70 } })
    expect(row(w).classes()).toContain('bg-white/[0.03]')
    expect(row(w).classes()).toContain('hover:bg-white/[0.065]')
  })
  it('paints the value band at 10%', () => {
    const w = mount(StudioRow, { props: { spec, modelValue: 70 } })
    expect(w.find('[data-row-band]').attributes('style')).toMatch(/rgba\(255,\s*255,\s*255,\s*0\.1\)/)
  })
})

describe('size reaches StudioRow through the row family', () => {
  it('StudioSlider', () => {
    const w = mount(StudioSlider, { props: { label: 'Strength', min: 0, max: 100, modelValue: 50, size: 'comfortable' } })
    expect(w.find('[data-studio-row]').classes()).toContain('h-8')
  })
  it('StudioSelect (labelled)', () => {
    const w = mount(StudioSelect, { props: { label: 'Model', options: ['a', 'b'], modelValue: 'a', size: 'comfortable' } })
    expect(w.find('[data-studio-row]').classes()).toContain('h-8')
  })
  it('StudioSwitch (labelled)', () => {
    const w = mount(StudioSwitch, { props: { label: 'Upscale', modelValue: true, size: 'comfortable' } })
    expect(w.find('[data-studio-row]').classes()).toContain('h-8')
  })
  it('defaults stay compact', () => {
    const w = mount(StudioSlider, { props: { label: 'Strength', min: 0, max: 100, modelValue: 50 } })
    expect(w.find('[data-studio-row]').classes()).toContain('h-7')
  })
})
