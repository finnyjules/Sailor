// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Panel from '~/components/vue-canvas/compositor/CompositorClonerPanel.vue'
import { DEFAULT_CLONER, expandClones, type Cloner } from '~/composables/useCloner'

// `v-scrubnum` (drag-to-scrub on a number field) is registered by a Nuxt CLIENT
// plugin — app/plugins/scrub-input.client.ts — which never runs under vitest, so
// the directive is unresolved here. Stub it in the mount rather than dropping it
// from the component: dragging is how these fields are actually used.
const global = { directives: { scrubnum: {} } }

const mountWith = (over: Partial<Cloner> = {}) =>
  mount(Panel, { props: { cloner: { ...DEFAULT_CLONER, enabled: true, ...over } }, global })

/** Just the Vary block's visible text, so assertions can't catch the panel's
 *  pre-existing copy (the mode buttons render the raw words linear/radial). */
const varyText = (w: ReturnType<typeof mountWith>) => w.find('[data-test="vary-block"]').text()

const lastEmit = (w: ReturnType<typeof mountWith>): Cloner => {
  const ev = w.emitted('update')
  if (!ev?.length) throw new Error('nothing emitted')
  return ev[ev.length - 1]![0] as Cloner
}

describe('Vary block', () => {
  it('is absent while the cloner is disabled', () => {
    const w = mount(Panel, { props: { cloner: { ...DEFAULT_CLONER, enabled: false } }, global })
    expect(w.find('[data-test="vary-block"]').exists()).toBe(false)
    expect(w.find('[data-test="vary-mode"]').exists()).toBe(false)
    // ZERO-CHANGE: a disabled cloner's panel says nothing about Vary at all.
    expect(w.text()).not.toContain('Vary')
  })

  it('offers all three drivers', () => {
    const w = mountWith()
    const labels = w.findAll('[data-test="vary-mode"] button').map((b) => b.text())
    expect(labels).toEqual(['Sequence', 'Random', 'Falloff'])
  })

  it('shows the seed only in random mode', () => {
    expect(mountWith().find('[data-test="vary-seed"]').exists()).toBe(false)
    expect(mountWith({ varyMode: 'random' }).find('[data-test="vary-seed"]').exists()).toBe(true)
  })

  it('shows centre and reach only in falloff mode', () => {
    const w = mountWith({ varyMode: 'falloff' })
    expect(w.find('[data-test="vary-center"]').exists()).toBe(true)
    expect(w.find('[data-test="vary-reach"]').exists()).toBe(true)
    expect(mountWith({ varyMode: 'random' }).find('[data-test="vary-center"]').exists()).toBe(false)
  })

  it('reveals the palette only when colour is switched on', () => {
    expect(mountWith().find('[data-test="vary-palette-add"]').exists()).toBe(false)
    expect(mountWith({ varyColor: true }).find('[data-test="vary-palette-add"]').exists()).toBe(true)
  })

  it('mounts the SHARED palette editor, remove control and all', () => {
    const w = mountWith({ varyColor: true, varyPalette: ['#ff0000', '#00ff00'] })
    expect(w.findAll('[data-test="vary-palette-remove"]').length).toBe(2)
  })

  it('emits the whole cloner when the driver changes', async () => {
    const w = mountWith()
    await w.findAll('[data-test="vary-mode"] button')[1]!.trigger('click')
    const next = lastEmit(w)
    expect(next.varyMode).toBe('random')
    expect(next.enabled).toBe(true)
  })

  it('emits the palette the shared editor hands back', async () => {
    const w = mountWith({ varyColor: true, varyPalette: ['#ff0000', '#00ff00'] })
    await w.find('[data-test="vary-palette-add"]').trigger('click')
    expect(lastEmit(w).varyPalette).toEqual(['#ff0000', '#00ff00', '#00ff00'])
  })

  it('offers both colour spreads', () => {
    const w = mountWith({ varyColor: true })
    const labels = w.findAll('[data-test="vary-spread"] button').map((b) => b.text())
    expect(labels).toEqual(['Cycle', 'Blend'])
  })
})

describe('Vary copy', () => {
  // The vocabulary the 3D Studio inspector already ships, kept identical here.
  it('captions the block Vary and the driver picker Pattern', () => {
    const t = varyText(mountWith())
    expect(t).toContain('Vary')
    expect(t).toContain('Pattern')
    expect(t).toContain('Colour')
  })

  it('labels the seed, centre, reach, palette, spread and strength', () => {
    expect(varyText(mountWith({ varyMode: 'random' }))).toContain('Seed')
    const f = varyText(mountWith({ varyMode: 'falloff' }))
    expect(f).toContain('Centre')
    expect(f).toContain('Reach')
    const c = varyText(mountWith({ varyColor: true }))
    expect(c).toContain('Palette')
    expect(c).toContain('Spread')
    expect(c).toContain('Colour strength')
  })

  it('never surfaces a stored internal value as copy', () => {
    for (const over of [{}, { varyMode: 'random' as const }, { varyMode: 'falloff' as const },
      { varyColor: true }, { varyColor: true, varyColorSpread: 'blend' as const }]) {
      const t = varyText(mountWith(over))
      expect(t, JSON.stringify(over)).not.toMatch(/\b(sequence|random|falloff|cycle|blend)\b/)
    }
  })

  it('starts every label with a capital — sentence case, no lowercase identifiers', () => {
    const w = mountWith({ varyMode: 'falloff', varyColor: true })
    for (const el of w.findAll('[data-test="vary-block"] span, [data-test="vary-block"] div')) {
      const t = el.text().trim()
      if (t) expect(t[0], t).toBe(t[0]!.toUpperCase())
    }
  })
})

describe('a cleared number field cannot blank the layer', () => {
  // The panel binds four number inputs. Clearing one gives Number('') === NaN,
  // and NaN survives `??`; in falloff mode it reaches Math.pow(stepScale, NaN),
  // making BOTH dscale and dopacity NaN — the layer vanishes from the composite.
  const finite = (c: Cloner) => expandClones(c, 1)
    .every((t) => [t.dx, t.dy, t.drot, t.dscale, t.dopacity, t.weight, t.tintStrength]
      .every((n) => Number.isFinite(n)))

  it('survives NaN in each of the four numeric vary fields', () => {
    for (const field of ['varySeed', 'varyFalloffCenter', 'varyFalloffRadius', 'varyColorStrength'] as const) {
      for (const varyMode of ['sequence', 'random', 'falloff'] as const) {
        const c: Cloner = { ...DEFAULT_CLONER, enabled: true, countX: 4, varyMode, varyColor: true, [field]: NaN }
        expect(finite(c), `${field} / ${varyMode}`).toBe(true)
      }
    }
  })

  it('survives NaN in all four at once', () => {
    const c: Cloner = {
      ...DEFAULT_CLONER, enabled: true, countX: 4, varyMode: 'falloff', varyColor: true,
      varySeed: NaN, varyFalloffCenter: NaN, varyFalloffRadius: NaN, varyColorStrength: NaN,
    }
    expect(finite(c)).toBe(true)
  })

  it('is proved end to end: clearing the reach field still composites', async () => {
    const w = mountWith({ varyMode: 'falloff', countX: 4, stepScale: 0.9 })
    const input = w.find('[data-test="vary-reach"] input')
    ;(input.element as HTMLInputElement).value = ''
    await input.trigger('input')
    expect(finite(lastEmit(w))).toBe(true)
  })
})
