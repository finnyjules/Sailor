// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NodeRunRow from '~/components/vue-canvas/NodeRunRow.vue'

const idle = { tone: 'idle' as const, text: 'Not run yet' }

describe('NodeRunRow', () => {
  it('slim variant is unchanged: 28px row, icon button, no price', () => {
    const w = mount(NodeRunRow, { props: { status: idle, canRun: true, running: false, price: '$0.03' } })
    expect(w.find('.node-run-row').classes()).toContain('h-7')
    expect(w.find('.node-btn--primary').exists()).toBe(false)
    expect(w.text()).not.toContain('$0.03')
  })
  it('instrument variant: white Run button carrying the price, status without it', () => {
    const w = mount(NodeRunRow, { props: { status: idle, canRun: true, running: false, price: '$0.03', variant: 'instrument' } })
    const btn = w.find('.node-btn--primary')
    expect(btn.text()).toContain('Run')
    expect(btn.find('.node-btn__price').text()).toBe('$0.03')
    expect(w.find('[data-run-status]').text()).toBe('Not run yet')
  })
  it('instrument variant uses the given button text', () => {
    const w = mount(NodeRunRow, { props: { status: idle, canRun: true, running: false, variant: 'instrument', buttonText: 'Run again' } })
    expect(w.find('.node-btn--primary').text()).toContain('Run again')
  })
  it('instrument variant while running: spinner, no price, disabled', () => {
    const w = mount(NodeRunRow, { props: { status: { tone: 'running', text: 'Running…' }, canRun: true, running: true, price: '$0.03', variant: 'instrument' } })
    const btn = w.find('.node-btn--primary')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.find('.node-btn__price').exists()).toBe(false)
    expect(btn.find('.animate-spin').exists()).toBe(true)
  })
  it('instrument root is a positioning context, so the Run scope menu opens right above the footer', () => {
    const w = mount(NodeRunRow, { props: { status: idle, canRun: true, running: false, variant: 'instrument' } })
    expect(w.find('.node-run-row--instrument').classes()).toContain('relative')
  })
  it('emits run on click when allowed', async () => {
    const w = mount(NodeRunRow, { props: { status: idle, canRun: true, running: false, variant: 'instrument' } })
    await w.find('.node-btn--primary').trigger('click')
    expect(w.emitted('run')).toHaveLength(1)
  })
})
