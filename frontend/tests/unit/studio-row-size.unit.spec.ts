// @vitest-environment happy-dom
// frontend/tests/unit/studio-row-size.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StudioRow from '~/components/vue-canvas/studio/StudioRow.vue'

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
