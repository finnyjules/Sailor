// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import BrushToolbar from '~/components/vue-canvas/compositor/BrushToolbar.vue'
import BrushTipSettings from '~/components/vue-canvas/compositor/BrushTipSettings.vue'
import { useBrushPaint } from '~/composables/useBrushPaint'

beforeEach(() => localStorage.clear())

const stubs = { StudioColor: { template: '<div />', props: ['modelValue'] } }

describe('BrushToolbar', () => {
  it('switches tips and shows the tip hint', async () => {
    const brush = useBrushPaint()
    const w = mount(BrushToolbar, { props: { brush }, global: { stubs } })
    expect(w.text()).toContain('Spray can')
    expect(w.text()).toContain('Hold still and the paint pools')
    await w.get('[data-testid="brush-tip-round"]').trigger('click')
    expect(brush.tip.value).toBe('round')
    expect(w.text()).toContain('A clean round brush')
  })
  it('shows the mask hint and hides tips in Mask mode', async () => {
    const brush = useBrushPaint()
    brush.mode.value = 'mask'
    const w = mount(BrushToolbar, { props: { brush }, global: { stubs } })
    expect(w.find('[data-testid="brush-tip-round"]').exists()).toBe(false)
    expect(w.text()).toContain('Paint to hide part of the selected layer')
  })
})

describe('BrushTipSettings', () => {
  it('lists the current tip settings as percentages and resets', async () => {
    const brush = useBrushPaint()
    brush.tip.value = 'bristle'
    const w = mount(BrushTipSettings, { props: { brush }, global: { stubs } })
    expect(w.text()).toContain('Speed thinning')
    expect(w.text()).toContain('15%')
    brush.tipSettings.bristle.thin = 1
    await w.vm.$nextTick()
    expect(w.text()).toContain('100%')
    await w.get('[data-testid="brush-tip-reset"]').trigger('click')
    expect(brush.tipSettings.bristle.thin).toBe(0.15)
  })
})
