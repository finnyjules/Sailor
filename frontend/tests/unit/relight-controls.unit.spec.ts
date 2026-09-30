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
  it('releases Compare however the hold ends, once', async () => {
    for (const end of ['pointercancel', 'lostpointercapture', 'pointerleave']) {
      const w = mk()
      const b = w.get('[data-testid="relight-compare"]')
      await b.trigger('pointerdown'); await b.trigger(end); await b.trigger('pointerup')
      expect(w.emitted('compare')).toEqual([[true], [false]])
    }
    const got: boolean[] = []
    const fx = sanitizeRelight(null)
    const w = mount(RelightControls, { props: { fx, selectedLight: fx.lights[0]!.id, depthStatus: 'ready', onCompare: (on: boolean) => got.push(on) } })
    await w.get('[data-testid="relight-compare"]').trigger('pointerdown')
    w.unmount()                                   // the panel goes away mid-hold
    expect(got).toEqual([true, false])
  })
  it('cannot remove the last light', async () => {
    const one = mk()
    expect(one.get('[data-testid="relight-remove-light"]').attributes('disabled')).toBeDefined()
    const fx = applySetup(sanitizeRelight(null), 'Neon')
    const two = mk(fx)
    expect(two.get('[data-testid="relight-remove-light"]').attributes('disabled')).toBeUndefined()
    await two.get('[data-testid="relight-remove-light"]').trigger('click')
    expect((two.emitted('update')![0]![0] as any).lights).toHaveLength(1)
  })

  describe('surfaces price line', () => {
    const mkSurfaces = (surfacesStatus: 'idle' | 'loading' | 'ready' | 'error' | 'off', surfacesPrice: string | null = null) =>
      mount(RelightControls, {
        props: { fx: sanitizeRelight(null), selectedLight: sanitizeRelight(null).lights[0]!.id, depthStatus: 'ready', surfacesStatus, surfacesPrice },
      })

    it('shows the price while loading', () => {
      expect(mkSurfaces('loading', '3 credits').text()).toContain('Reading shape · 3 credits')
    })
    it('loading with no price shows the plain copy', () => {
      const t = mkSurfaces('loading', null).get('[data-testid="relight-status-loading"]').text()
      expect(t).toBe('Reading shape')
    })
    it('offers a Retry button on error, which emits retry-surfaces', async () => {
      const w = mkSurfaces('error')
      const btn = w.get('[data-testid="relight-surfaces-retry"]')
      await btn.trigger('click')
      expect(w.emitted('retry-surfaces')).toEqual([[]])
    })
    it('the error line shows the still-reading note in place of the plain words', () => {
      const w = mount(RelightControls, {
        props: { fx: sanitizeRelight(null), selectedLight: sanitizeRelight(null).lights[0]!.id, depthStatus: 'ready', surfacesStatus: 'error', surfacesNote: 'Still reading — try again in a minute' },
      })
      const t = w.get('[data-testid="relight-status-error"]').text()
      expect(t).toContain('Still reading — try again in a minute')
      expect(t).not.toContain("Couldn't read")
      expect(mkSurfaces('error').get('[data-testid="relight-status-error"]').text()).toContain("Couldn't read this photo's shape")
    })
    it('shows no status line when off', () => {
      expect(mkSurfaces('off').find('[data-testid="relight-status-loading"]').exists()).toBe(false)
      expect(mkSurfaces('off').find('[data-testid="relight-status-error"]').exists()).toBe(false)
    })
    it('shows no status line when ready', () => {
      expect(mkSurfaces('ready').find('[data-testid="relight-status-loading"]').exists()).toBe(false)
      expect(mkSurfaces('ready').find('[data-testid="relight-status-error"]').exists()).toBe(false)
    })
  })
})
