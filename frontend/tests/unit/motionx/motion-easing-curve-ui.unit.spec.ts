// @vitest-environment happy-dom
/**
 * MOTION EASING CURVE — THE STEPS TYPE.
 *
 * `MotionEasingCurve.vue` is not shared with another in-flight task, so it can be exercised
 * directly with `@vue/test-utils` rather than the source-string extraction `letters-ui.unit.spec`
 * needs for an ~11k-line shared file — but the assertions below are the same ones that spec's
 * neighbourhood cares about:
 *
 *   1. Three Type options, in order: Easing, Spring, Steps.
 *   2. The Steps `StudioSlider` (`data-testid="ease-steps"`) renders ONLY in Steps mode,
 *      2..24, step 1.
 *   3. The bézier "Ease" field and the Preset `StudioSelect` are hidden in Steps mode (and in
 *      Spring mode) — they describe a curve Steps does not have.
 *   4. A whole drag of the Steps slider is ONE undo step: `start` once, `change` per pixel,
 *      `end` once — mirroring the Bounce slider's existing gesture coalescing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import MotionEasingCurve from '~/components/vue-canvas/compositor/MotionEasingCurve.vue'

const FILE = resolve(process.cwd(), 'app/components/vue-canvas/compositor/MotionEasingCurve.vue')
const raw = readFileSync(FILE, 'utf8')

describe('source: MODE_OPTIONS / MODE_LABELS', () => {
  it('are Easing, Spring, Steps — in that order', () => {
    expect(raw).toMatch(/const MODE_OPTIONS = \['easing', 'spring', 'steps'\]/)
    expect(raw).toMatch(/const MODE_LABELS = \['Easing', 'Spring', 'Steps'\]/)
  })
})

describe('mounted: three-way Type switch', () => {
  it('the segmented row offers exactly three options, in order', () => {
    const w = mount(MotionEasingCurve, { props: { ease: 'linear' } })
    const row = w.findComponent('[data-testid="ease-mode"]')
    expect(row.props('options')).toEqual(['easing', 'spring', 'steps'])
    expect(row.props('optionLabels')).toEqual(['Easing', 'Spring', 'Steps'])
  })
  it('a steps ease prop selects Steps mode and shows its own graph, not the bézier or spring one', () => {
    const w = mount(MotionEasingCurve, { props: { ease: { type: 'steps', count: 8 } } })
    expect(w.get('[data-testid="easing-curve"]').attributes('data-mode')).toBe('steps')
    expect(w.find('[data-testid="steps-viz"]').exists()).toBe(true)
    expect(w.find('[data-testid="spring-viz"]').exists()).toBe(false)
    expect(w.find('[data-testid="easing-path"]').exists()).toBe(false)
  })
})

describe('mounted: Steps slider (data-testid="ease-steps")', () => {
  it('renders only in Steps mode, with min 2 / max 24 / step 1 and the current count', () => {
    const easing = mount(MotionEasingCurve, { props: { ease: 'linear' } })
    expect(easing.find('[data-testid="ease-steps"]').exists()).toBe(false)
    const spring = mount(MotionEasingCurve, { props: { ease: { type: 'spring', bounce: 0.2 } } })
    expect(spring.find('[data-testid="ease-steps"]').exists()).toBe(false)
    const w = mount(MotionEasingCurve, { props: { ease: { type: 'steps', count: 8 } } })
    const slider = w.findComponent('[data-testid="ease-steps"]')
    expect(slider.exists()).toBe(true)
    expect(slider.props('min')).toBe(2)
    expect(slider.props('max')).toBe(24)
    expect(slider.props('step')).toBe(1)
    expect(slider.props('modelValue')).toBe(8)
  })
  it('the Ease text field and Preset select are hidden in Steps mode (present in Easing mode)', () => {
    const steps = mount(MotionEasingCurve, { props: { ease: { type: 'steps', count: 6 } } })
    expect(steps.find('[data-testid="easing-text"]').exists()).toBe(false)
    expect(steps.find('[data-testid="easing-preset"]').exists()).toBe(false)
    const easing = mount(MotionEasingCurve, { props: { ease: 'linear' } })
    expect(easing.find('[data-testid="easing-text"]').exists()).toBe(true)
    expect(easing.find('[data-testid="easing-preset"]').exists()).toBe(true)
  })
  it('switching Type to Steps restores the cached last steps value', async () => {
    // Start on Steps (caches count 12), flip the incoming prop to a plain named ease (as the
    // parent would after committing), then switch Type back to Steps from the row.
    const w = mount(MotionEasingCurve, { props: { ease: { type: 'steps', count: 12 } } })
    await w.setProps({ ease: 'easeInOut' })
    const row = w.findComponent('[data-testid="ease-mode"]')
    await row.vm.$emit('update:modelValue', 'steps')
    const changed = w.emitted('change') as unknown[][]
    expect(changed?.[0]?.[0]).toEqual({ type: 'steps', count: 12 })
  })
  it('one drag = one undo step: start once, change per pixel, end once', async () => {
    const w = mount(MotionEasingCurve, { props: { ease: { type: 'steps', count: 6 } } })
    const slider = w.findComponent('[data-testid="ease-steps"]')
    await slider.trigger('pointerdown')
    await slider.vm.$emit('update:modelValue', 10)
    await slider.vm.$emit('update:modelValue', 11)
    await slider.vm.$emit('update:modelValue', 12)
    await slider.trigger('pointerup')
    expect(w.emitted('start')?.length).toBe(1)
    expect(w.emitted('change')?.length).toBe(3)
    expect(w.emitted('end')?.length).toBe(1)
    expect((w.emitted('change') as unknown[][])[2]?.[0]).toEqual({ type: 'steps', count: 12 })
  })
  it('a press that changes nothing leaves no undo step (lazy open, like Bounce)', async () => {
    const w = mount(MotionEasingCurve, { props: { ease: { type: 'steps', count: 6 } } })
    const slider = w.findComponent('[data-testid="ease-steps"]')
    await slider.trigger('pointerdown')
    await slider.trigger('pointerup')
    expect(w.emitted('start')).toBeUndefined()
    expect(w.emitted('end')).toBeUndefined()
  })
})
