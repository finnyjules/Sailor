// @vitest-environment happy-dom
// frontend/tests/unit/compositor-stroke-follow-row.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StrokeFollowRow from '~/components/vue-canvas/compositor/StrokeFollowRow.vue'

const base = { follow: false, fade: 'across' as const, fadeRepeats: 4, showFollow: true, showFade: false, showFadeRepeats: false }

describe('StrokeFollowRow', () => {
  it('shows the Fill select with plain words', () => {
    const w = mount(StrokeFollowRow, { props: base })
    const opts = w.findAll('[data-stroke-follow] option').map(o => o.text())
    expect(opts).toEqual(['Stays put', 'Follows the line'])
    expect(w.find('[data-stroke-fade]').exists()).toBe(false)
  })
  it('emits a boolean for Fill', async () => {
    const w = mount(StrokeFollowRow, { props: base })
    await w.find('[data-stroke-follow]').setValue('follow')
    expect(w.emitted('update:follow')![0]).toEqual([true])
    await w.find('[data-stroke-follow]').setValue('still')
    expect(w.emitted('update:follow')![1]).toEqual([false])
  })
  it('Ombre fades and Repeats appear only when asked, and emit their values', async () => {
    const w = mount(StrokeFollowRow, { props: { ...base, follow: true, showFade: true, showFadeRepeats: true, fade: 'along' } })
    expect(w.findAll('[data-stroke-fade] option').map(o => o.text())).toEqual(['Inner to outer edge', 'Along the line'])
    await w.find('[data-stroke-fade]').setValue('across')
    expect(w.emitted('update:fade')![0]).toEqual(['across'])
    await w.find('[data-stroke-fade-repeats]').setValue('7')
    expect(w.emitted('update:fadeRepeats')![0]).toEqual([7])
  })
  it('renders nothing when no row applies', () => {
    const w = mount(StrokeFollowRow, { props: { ...base, showFollow: false } })
    expect(w.find('select').exists()).toBe(false)
  })
})
