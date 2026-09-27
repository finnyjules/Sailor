// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import BrushToolbar from '~/components/vue-canvas/compositor/BrushToolbar.vue'
import BrushTipSettings from '~/components/vue-canvas/compositor/BrushTipSettings.vue'
import { useBrushPaint } from '~/composables/useBrushPaint'
import { brushEffectLabel } from '~/lib/brushTips/effects'

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
  it('switching to Effect shows the chips, hides the colour, and shows the effect hint', async () => {
    const brush = useBrushPaint()
    const w = mount(BrushToolbar, { props: { brush }, global: { stubs } })
    await w.get('[data-testid="brush-mode-effect"]').trigger('click')
    expect(brush.mode.value).toBe('effect')
    expect(w.find('[data-testid="brush-material-colour"]').exists()).toBe(false)
    expect(w.find('[data-testid="brush-effect-water_ripple"]').exists()).toBe(true)
    expect(w.find('[data-testid="brush-effect-pixelate"]').exists()).toBe(true)
    expect(w.text()).toContain('Paint where the effect should happen. Go over it again to make it stronger.')
    // Tips row and size stay.
    expect(w.find('[data-testid="brush-tip-round"]').exists()).toBe(true)
    expect(w.find('[data-testid="brush-eraser"]').exists()).toBe(true)
  })
  it('clicking an effect chip sets brush.effect', async () => {
    const brush = useBrushPaint()
    brush.mode.value = 'effect'
    const w = mount(BrushToolbar, { props: { brush }, global: { stubs } })
    await w.get('[data-testid="brush-effect-pixelate"]').trigger('click')
    expect(brush.effect.value).toBe('pixelate')
    expect(w.get('[data-testid="brush-effect-pixelate"]').attributes('aria-pressed')).toBe('true')
  })
  it('shows the shader-paint swatch only once a library shader is chosen', async () => {
    const brush = useBrushPaint()
    const w = mount(BrushToolbar, { props: { brush }, global: { stubs } })
    expect(w.find('[data-testid="brush-shader-paint"]').exists()).toBe(false)
    brush.chooseShaderPaint('water_ripple')
    await w.vm.$nextTick()
    const swatch = w.get('[data-testid="brush-shader-paint"]')
    expect(swatch.attributes('aria-pressed')).toBe('true')
    expect(swatch.attributes('title')).toBe(brushEffectLabel('water_ripple'))
  })
  it('emits more-paint and more-effect from the More… buttons', async () => {
    const brush = useBrushPaint()
    const w = mount(BrushToolbar, { props: { brush }, global: { stubs } })
    await w.get('[data-testid="brush-paint-more"]').trigger('click')
    expect(w.emitted('more-paint')).toHaveLength(1)
    brush.mode.value = 'effect'
    await w.vm.$nextTick()
    await w.get('[data-testid="brush-effect-more"]').trigger('click')
    expect(w.emitted('more-effect')).toHaveLength(1)
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
  it('says "changes apply to your next stroke" only as the Reset tooltip, not as visible copy', () => {
    const brush = useBrushPaint()
    const w = mount(BrushTipSettings, { props: { brush }, global: { stubs } })
    expect(w.text()).not.toContain('Changes apply to your next stroke.')
    expect(w.find('.note').exists()).toBe(false)
    expect(w.get('[data-testid="brush-tip-reset"]').attributes('title')).toBe('Changes apply to your next stroke.')
  })
})
