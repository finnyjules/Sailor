// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import RelightControls from '~/components/vue-canvas/compositor/RelightControls.vue'
import { sanitizeRelight } from '~/lib/relight/settings'

const LIGHTS = [
  { id: 'la', name: 'Lamp', color: '#ffcf94', visible: true },
  { id: 'lb', name: 'Key', color: '#29d8ff', visible: false },
]
const mk = (extra: Record<string, unknown> = {}) =>
  mount(RelightControls, { props: { fx: sanitizeRelight(null), depthStatus: 'ready', ...extra } })

describe('RelightControls', () => {
  it('shows the setups and the photo controls by name, and no per-light controls', () => {
    const t = mk({ lights: LIGHTS }).text()
    for (const s of ['Window', 'Golden key', 'Rim', 'Neon', 'Under', 'Original light', 'Depth', 'Texture', 'Shine', 'Shadows', 'Compare'])
      expect(t).toContain(s)
    for (const s of ['Brightness', 'Height', 'Reach']) expect(t).not.toContain(s)
    const w = mk({ lights: LIGHTS })
    for (const id of ['relight-light-panel', 'relight-add-light', 'relight-remove-light', 'relight-light-on', 'relight-brightness', 'relight-height', 'relight-reach', 'relight-swatch-Cyan'])
      expect(w.find(`[data-testid="${id}"]`).exists()).toBe(false)
  })
  it('marks the active setup the editor reports, and none when there is none', () => {
    const w = mk({ activeSetup: 'Golden key' })
    expect(w.get('[data-testid="relight-setup-Golden key"]').attributes('aria-pressed')).toBe('true')
    expect(w.get('[data-testid="relight-setup-Neon"]').attributes('aria-pressed')).toBe('false')
    expect(mk().findAll('[aria-pressed="true"]')).toHaveLength(0)
  })
  it('emits the setup by name (the editor replaces the Frame\'s lights), not an effect patch', async () => {
    const w = mk()
    await w.get('[data-testid="relight-setup-Neon"]').trigger('click')
    expect(w.emitted('setup')).toEqual([['Neon']])
    expect(w.emitted('update')).toBeUndefined()
  })
  it('lists the Frame\'s lights as chips by name and colour, and selects one on click', async () => {
    const w = mk({ lights: LIGHTS, selectedLight: 'lb' })
    const a = w.get('[data-testid="relight-light-1"]'), b = w.get('[data-testid="relight-light-2"]')
    expect(a.text()).toBe('Lamp')
    expect(b.text()).toBe('Key')
    expect(a.attributes('data-light-id')).toBe('la')
    expect(a.attributes('aria-pressed')).toBe('false')
    expect(b.attributes('aria-pressed')).toBe('true')
    expect(a.find('span').attributes('style')).toContain('opacity: 1')
    expect(b.find('span').attributes('style')).toContain('opacity: 0.35')   // a hidden light
    await a.trigger('click')
    expect(w.emitted('select-light')).toEqual([['la']])
  })
  it('shows no chips when the Frame has no light', () => {
    expect(mk().find('[data-testid="relight-light-1"]').exists()).toBe(false)
  })
  it('emits photo dial changes as an effect patch', async () => {
    const w = mk()
    w.getComponent('[data-testid="relight-keep"]').vm.$emit('update:modelValue', 0.5)
    expect(w.emitted('update')).toEqual([[{ keep: 0.5 }]])
  })
  it('keeps explanations in tooltips, not panel text', () => {
    expect(mk({ lights: LIGHTS }).text()).not.toMatch(/how much|how strongly|glossy|contact shadows|hold to/i)
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
    const w = mk({ onCompare: (on: boolean) => got.push(on) })
    await w.get('[data-testid="relight-compare"]').trigger('pointerdown')
    w.unmount()                                   // the panel goes away mid-hold
    expect(got).toEqual([true, false])
  })
  it('a pointerup anywhere in the window, or the window losing focus, lets go of Compare', async () => {
    for (const ev of [new Event('pointerup'), new Event('blur')]) {
      const w = mk()
      await w.get('[data-testid="relight-compare"]').trigger('pointerdown')
      window.dispatchEvent(ev)
      expect(w.emitted('compare')).toEqual([[true], [false]])
      window.dispatchEvent(new Event('pointerup'))              // released once: the listener is gone
      expect(w.emitted('compare')).toEqual([[true], [false]])
      w.unmount()
    }
  })

  describe('surfaces price line', () => {
    const mkSurfaces = (surfacesStatus: 'idle' | 'loading' | 'ready' | 'error' | 'off', surfacesPrice: string | null = null) =>
      mount(RelightControls, {
        props: { fx: sanitizeRelight(null), depthStatus: 'ready', surfacesStatus, surfacesPrice },
      })

    it('shows the price while loading', () => {
      expect(mkSurfaces('loading', '3 credits').text()).toContain('Reading shape · 3 credits')
    })
    it('loading with no price shows the plain copy', () => {
      const t = mkSurfaces('loading', null).get('[data-testid="relight-status-loading"]').text()
      expect(t).toBe('Reading shape · 0 s')
    })
    it('offers a Retry button on error, which emits retry-surfaces', async () => {
      const w = mkSurfaces('error')
      const btn = w.get('[data-testid="relight-surfaces-retry"]')
      await btn.trigger('click')
      expect(w.emitted('retry-surfaces')).toEqual([[]])
    })
    it('the error line shows the still-reading note in place of the plain words', () => {
      const w = mount(RelightControls, {
        props: { fx: sanitizeRelight(null), depthStatus: 'ready', surfacesStatus: 'error', surfacesNote: 'Still reading — try again in a minute' },
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

  describe('Read shape button (2026-09-30)', () => {
    const mkAbsent = (surfacesReadPrice: string | null = '~$0.01') =>
      mount(RelightControls, {
        props: {
          fx: sanitizeRelight(null), depthStatus: 'ready',
          surfacesStatus: 'absent', surfacesReadPrice,
        },
      })

    it('shows a Read shape button with the price when surfaces are absent', () => {
      const w = mkAbsent('~$0.01')
      expect(w.get('[data-testid="relight-surfaces-read"]').text()).toBe('Read shape · ~$0.01')
    })

    it('clicking Read shape emits read-surfaces', async () => {
      const w = mkAbsent()
      await w.get('[data-testid="relight-surfaces-read"]').trigger('click')
      expect(w.emitted('read-surfaces')).toEqual([[]])
    })

    it('shows no button and no status line for idle, ready or off', () => {
      for (const surfacesStatus of ['idle', 'ready', 'off'] as const) {
        const w = mount(RelightControls, {
          props: { fx: sanitizeRelight(null), depthStatus: 'ready', surfacesStatus },
        })
        expect(w.find('[data-testid="relight-surfaces-read"]').exists()).toBe(false)
        expect(w.find('[data-testid="relight-status-loading"]').exists()).toBe(false)
        expect(w.find('[data-testid="relight-status-error"]').exists()).toBe(false)
      }
    })

    it('loading still shows the status line, not the button', () => {
      const w = mount(RelightControls, {
        props: {
          fx: sanitizeRelight(null), depthStatus: 'ready',
          surfacesStatus: 'loading', surfacesPrice: '~$0.01',
        },
      })
      expect(w.find('[data-testid="relight-surfaces-read"]').exists()).toBe(false)
      const b = w.get('[data-testid="relight-status-loading"]')
      // The same full-width button, greyed out and not clickable while the read runs.
      expect(b.element.tagName).toBe('BUTTON')
      expect(b.attributes('disabled')).toBeDefined()
      expect(b.classes()).toContain('w-full')
      expect(b.text()).toBe('Reading shape · ~$0.01 · 0 s')
    })

    it('the Read shape button is full width', () => {
      expect(mkAbsent('~$0.01').get('[data-testid="relight-surfaces-read"]').classes()).toContain('w-full')
    })

    it('counts the wait from when the read started, and says "Still reading" after 30 s', async () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-10-01T12:00:00Z'))
        const startedAt = Date.now() - 12_000
        const w = mount(RelightControls, {
          props: { fx: sanitizeRelight(null), depthStatus: 'ready', surfacesStatus: 'loading', surfacesPrice: '~$0.01', surfacesStartedAt: startedAt },
        })
        expect(w.get('[data-testid="relight-status-loading"]').text()).toBe('Reading shape · ~$0.01 · 12 s')
        await vi.advanceTimersByTimeAsync(20_000)
        expect(w.get('[data-testid="relight-status-loading"]').text()).toBe('Still reading · ~$0.01 · 32 s')
        w.unmount()
      } finally {
        vi.useRealTimers()
      }
    })
  })
  describe('Finish button (stage 3)', () => {
    const mkFinish = (extra: Record<string, unknown> = {}) =>
      mount(RelightControls, {
        props: { fx: sanitizeRelight(null), depthStatus: 'ready', finishAvailable: true, finishPrice: '~$0.08', ...extra },
      })

    it('shows the price on the button, with the explanation as a tooltip', () => {
      const b = mkFinish().get('[data-testid="relight-finish"]')
      expect(b.text()).toBe('Finish · ~$0.08')
      expect(b.attributes('title')).toBe('Adds real shadows and bounce light · about 20 s')
      expect(mkFinish({ finishPrice: '20 credits' }).get('[data-testid="relight-finish"]').text()).toBe('Finish · 20 credits')
    })
    it('clicking Finish emits finish', async () => {
      const w = mkFinish()
      await w.get('[data-testid="relight-finish"]').trigger('click')
      expect(w.emitted('finish')).toEqual([[]])
    })
    it('busy disables the button and says Finishing…', async () => {
      const w = mkFinish({ finishBusy: true })
      const b = w.get('[data-testid="relight-finish"]')
      expect(b.attributes('disabled')).toBeDefined()
      expect(b.text()).toBe('Finishing…')
      await b.trigger('click')
      expect(w.emitted('finish')).toBeUndefined()
    })
    it('blocked disables the button but keeps its price text', async () => {
      const w = mkFinish({ finishBlocked: true })
      const b = w.get('[data-testid="relight-finish"]')
      expect(b.attributes('disabled')).toBeDefined()
      expect(b.text()).toBe('Finish · ~$0.08')
      await b.trigger('click')
      expect(w.emitted('finish')).toBeUndefined()
    })
    it('unavailable hides the button (also the default)', () => {
      expect(mkFinish({ finishAvailable: false }).find('[data-testid="relight-finish"]').exists()).toBe(false)
      expect(mk().find('[data-testid="relight-finish"]').exists()).toBe(false)
    })
    it('locked makes every control above the button inert, and only while locked', () => {
      const body = mkFinish({ finishBusy: true, locked: true }).get('[data-testid="relight-controls-body"]')
      expect(body.attributes('inert')).toBeDefined()
      expect(body.find('[data-testid="relight-setup-Neon"]').exists()).toBe(true)
      expect(body.find('[data-testid="relight-compare"]').exists()).toBe(true)
      expect(body.find('[data-testid="relight-finish"]').exists()).toBe(false)
      expect(mkFinish().get('[data-testid="relight-controls-body"]').attributes('inert')).toBeUndefined()
    })
  })
})
