// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import BrushSteadySettings from '~/components/vue-canvas/compositor/BrushSteadySettings.vue'
import BrushSnapFeedback from '~/components/vue-canvas/compositor/BrushSnapFeedback.vue'
import { useBrushPaint } from '~/composables/useBrushPaint'

beforeEach(() => localStorage.clear())

describe('BrushSteadySettings', () => {
  it('shows the "Steadying" header', () => {
    const brush = useBrushPaint()
    const w = mount(BrushSteadySettings, { props: { brush } })
    expect(w.find('.header').text()).toBe('Steadying')
  })

  it('shows the exact row labels', () => {
    const brush = useBrushPaint()
    const w = mount(BrushSteadySettings, { props: { brush } })
    const labels = w.findAll('.lbl').map((l) => l.text())
    expect(labels).toEqual(['Streamline', 'Stabilisation', 'Motion filtering', 'Hold to snap', 'Hold time'])
  })

  it('sets the exact tooltip on each row', () => {
    const brush = useBrushPaint()
    const w = mount(BrushSteadySettings, { props: { brush } })
    const lbls = w.findAll('.lbl')
    expect(lbls[0]!.attributes('title')).toBe('The brush trails your finger a little and catches up, so curves come out smooth.')
    expect(lbls[1]!.attributes('title')).toBe('Averages the path, so slow careful strokes lose their wobble.')
    expect(lbls[2]!.attributes('title')).toBe('Removes small jitter without adding lag to fast strokes.')
    expect(lbls[3]!.attributes('title')).toBe('Round and bristle: stop at the end of a stroke and keep holding to snap it to a line, arc, ellipse or shape. Keep holding and move to adjust. Shift makes a circle or a 15° line.')
    expect(lbls[4]!.attributes('title')).toBe('How long to hold still before it snaps.')
  })

  it('moving the streamline slider sets brush.steady.streamline', async () => {
    const brush = useBrushPaint()
    const w = mount(BrushSteadySettings, { props: { brush } })
    const input = w.get('[data-testid="brush-steady-streamline"]')
    await input.setValue(60)
    expect(brush.steady.streamline).toBeCloseTo(0.6)
  })

  it('reads "0.63 s" for the hold time at defaults, and hides the row when snap is off', async () => {
    const brush = useBrushPaint()
    const w = mount(BrushSteadySettings, { props: { brush } })
    expect(w.get('[data-testid="brush-steady-hold"]').element.parentElement?.textContent).toContain('0.63 s')
    await w.get('[data-testid="brush-steady-snap"]').trigger('click')
    expect(brush.steady.snap).toBe(false)
    expect(w.find('[data-testid="brush-steady-hold"]').exists()).toBe(false)
  })

  it('the snap switch shows On/Off and aria-pressed', async () => {
    const brush = useBrushPaint()
    const w = mount(BrushSteadySettings, { props: { brush } })
    const btn = w.get('[data-testid="brush-steady-snap"]')
    expect(btn.text()).toBe('On')
    expect(btn.attributes('aria-pressed')).toBe('true')
    await btn.trigger('click')
    expect(btn.text()).toBe('Off')
    expect(btn.attributes('aria-pressed')).toBe('false')
  })

  it('Reset restores the defaults', async () => {
    const brush = useBrushPaint()
    const w = mount(BrushSteadySettings, { props: { brush } })
    await w.get('[data-testid="brush-steady-streamline"]').setValue(80)
    await w.get('[data-testid="brush-steady-snap"]').trigger('click')
    await w.get('[data-testid="brush-steady-reset"]').trigger('click')
    expect(brush.steady.streamline).toBeCloseTo(0.3)
    expect(brush.steady.snap).toBe(true)
  })

  it('renders no <p> element or other visible sentence', () => {
    const brush = useBrushPaint()
    const w = mount(BrushSteadySettings, { props: { brush } })
    expect(w.findAll('p')).toHaveLength(0)
  })
})

describe('BrushSnapFeedback', () => {
  it('renders the hold ring when progress is set', () => {
    const w = mount(BrushSnapFeedback, { props: { x: 10, y: 20, progress: 0.5, label: null } })
    expect(w.find('[data-testid="brush-hold-ring"]').exists()).toBe(true)
    expect(w.find('[data-testid="brush-snap-tag"]').exists()).toBe(false)
  })

  it('renders the snap tag with its label text', () => {
    const w = mount(BrushSnapFeedback, { props: { x: 10, y: 20, progress: null, label: 'Line' } })
    const tag = w.find('[data-testid="brush-snap-tag"]')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toBe('Line')
  })

  it('renders neither when both are null', () => {
    const w = mount(BrushSnapFeedback, { props: { x: 10, y: 20, progress: null, label: null } })
    expect(w.find('[data-testid="brush-hold-ring"]').exists()).toBe(false)
    expect(w.find('[data-testid="brush-snap-tag"]').exists()).toBe(false)
  })
})
