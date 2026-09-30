// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RelightControls from '~/components/vue-canvas/compositor/RelightControls.vue'
import { sanitizeRelight } from '~/lib/relight/settings'
import { applySetup, setupOf } from '~/lib/relight/presets'

const mk = (fx = sanitizeRelight(null)) => mount(RelightControls, { props: { fx, selectedLight: fx.lights[0]!.id, depthStatus: 'ready' } })

describe('RelightControls', () => {
  it('shows the setups, the photo controls and the light controls by name', () => {
    const t = mk().text()
    for (const s of ['Window', 'Golden key', 'Rim', 'Neon', 'Under', 'Original light', 'Depth', 'Texture', 'Shine', 'Shadows', 'Brightness', 'Height', 'Reach', 'Light 1'])
      expect(t).toContain(s)
  })
  it('marks the active setup', () => {
    const w = mk()
    expect(w.get('[data-testid="relight-setup-Golden key"]').attributes('aria-pressed')).toBe('true')
    expect(w.get('[data-testid="relight-setup-Neon"]').attributes('aria-pressed')).toBe('false')
  })
  it('emits the setup as a patch', async () => {
    const w = mk()
    await w.get('[data-testid="relight-setup-Neon"]').trigger('click')
    const patch = w.emitted('update')![0]![0] as any
    expect(setupOf({ ...sanitizeRelight(null), ...patch })).toBe('Neon')
  })
  it('adds a light up to three, then disables adding', async () => {
    const three = applySetup(sanitizeRelight(null), 'Rim')
    three.lights.push({ ...three.lights[0]!, id: 'x3' })
    expect(mk(three).get('[data-testid="relight-add-light"]').attributes('disabled')).toBeDefined()
    const w = mk()
    await w.get('[data-testid="relight-add-light"]').trigger('click')
    expect((w.emitted('update')![0]![0] as any).lights).toHaveLength(2)
  })
  it('recolours the selected light from a swatch', async () => {
    const w = mk()
    await w.get('[data-testid="relight-swatch-Cyan"]').trigger('click')
    expect((w.emitted('update')![0]![0] as any).lights[0].color).toBe('#29d8ff')
  })
  it('keeps explanations in tooltips, not panel text', () => {
    expect(mk().text()).not.toMatch(/how much|how strongly|glossy|contact shadows/i)
  })
  it('emits compare on press and release', async () => {
    const w = mk()
    const b = w.get('[data-testid="relight-compare"]')
    await b.trigger('pointerdown'); await b.trigger('pointerup')
    expect(w.emitted('compare')).toEqual([[true], [false]])
  })
})
