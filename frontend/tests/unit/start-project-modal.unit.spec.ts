// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
vi.mock('~/lib/startModal/stills', () => ({
  paintStill: vi.fn(async () => true),
  stillRendererFor: (id: string) => (['gen', 'style', 'edit', 'upscale', 'video'].includes(id) ? null : () => {}),
  ANIMATED_STILLS: new Set(),
}))
const { disposeSpaceTypeStill, stopAll } = vi.hoisted(() => ({
  disposeSpaceTypeStill: vi.fn(),
  stopAll: vi.fn(),
}))
vi.mock('~/lib/startModal/spaceTypeStill', () => ({ disposeSpaceTypeStill }))
vi.mock('~/composables/useStartTileHover', () => ({
  useStartTileHover: () => ({ enter: vi.fn(), leave: vi.fn(), stopAll }),
}))
import StartProjectModal from '~/components/StartProjectModal.vue'

describe('StartProjectModal', () => {
  it('shows AI and studios as two halves', () => {
    const w = mount(StartProjectModal)
    expect(w.get('[data-testid="start-ai"]').findAll('button').length).toBe(5)
    expect(w.get('[data-testid="start-hand"]').findAll('button').length).toBeGreaterThanOrEqual(7)
    expect(w.text()).toContain('Make it with AI')
    expect(w.text()).toContain('Make it by hand')
    expect(w.text()).not.toMatch(/Shot Director|Lip-Sync|Generate music|Generate speech/)
  })

  it('a tile emits its pick', async () => {
    const w = mount(StartProjectModal)
    await w.get('[data-testid="start-tile-gradient"]').trigger('click')
    expect(w.emitted('start')![0]).toEqual(['gradient'])
  })

  it('empty Frame, close and Esc all emit null', async () => {
    const w = mount(StartProjectModal, { attachTo: document.body })
    await w.get('[data-testid="start-empty-frame"]').trigger('click')
    await w.get('[data-testid="start-close"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('start')).toEqual([[null], [null], [null]])
    w.unmount()
  })

  it('AI tiles carry the credits dot, studio tiles do not', () => {
    const w = mount(StartProjectModal)
    expect(w.get('[data-testid="start-tile-gen"]').find('[data-testid="credits-dot"]').exists()).toBe(true)
    expect(w.get('[data-testid="start-tile-gradient"]').find('[data-testid="credits-dot"]').exists()).toBe(false)
  })

  it('disposes the SpaceType still engines and stops hover loops on close/unmount', async () => {
    const w = mount(StartProjectModal, { attachTo: document.body })
    disposeSpaceTypeStill.mockClear()
    stopAll.mockClear()
    await w.get('[data-testid="start-empty-frame"]').trigger('click')
    expect(disposeSpaceTypeStill).toHaveBeenCalled()
    expect(stopAll).toHaveBeenCalled()
    disposeSpaceTypeStill.mockClear()
    stopAll.mockClear()
    w.unmount()
    expect(disposeSpaceTypeStill).toHaveBeenCalled()
    expect(stopAll).toHaveBeenCalled()
  })
})
