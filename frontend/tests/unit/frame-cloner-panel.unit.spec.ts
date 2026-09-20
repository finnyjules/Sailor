// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Panel from '~/components/vue-canvas/compositor/CompositorClonerPanel.vue'
import VaryPalette from '~/components/vue-canvas/VaryPalette.vue'
import { DEFAULT_CLONER, expandClones, type Cloner } from '~/composables/useCloner'
// THE 3D SCHEMA. The Studio's Cloner inspector draws its Vary rows from `MODIFIER_SPECS`, so
// reading them here is what keeps the two surfaces speaking one language — see the
// "Vary copy is the 3D Studio schema" block.
import { MODIFIER_SPECS } from '~/lib/scene3d/primParams'

// Where the 3D Studio's Vary words come from. They used to be panel rows (`ui.cloner.*` anchors
// and `object.modifiers.vary*` controls from scenePanelControls); since the modifier stack
// (S1, 09-10) the Cloner's inspector draws them straight from MODIFIER_SPECS — `optionRowSpec`
// and `varySliderSpec` in Scene3DStudioSurface.vue both take `label` from there — so THAT is
// the one source the Frame's copy has to agree with. (The "Vary" heading and the palette
// editor are literal markup on both sides now, not schema rows, so they are not in this map.)
const SCENE3D_VARY_LABELS: Record<string, string> = Object.fromEntries(
  MODIFIER_SPECS.filter((sp) => sp.key.startsWith('vary')).map((sp) => [sp.key, sp.label]),
)

/** The 3D label for one row. Throws rather than comparing against `undefined`, so a row
 *  renamed or gated away on that side fails loudly here instead of passing vacuously. */
const label3d = (key: string): string => {
  const l = SCENE3D_VARY_LABELS[key]
  if (!l) throw new Error(`MODIFIER_SPECS has no '${key}' — the 3D Studio's Vary schema moved under this test`)
  return l
}

/** The stored option ids behind an index-valued vary modifier… */
const optionIds = (key: string): string[] => {
  const spec = MODIFIER_SPECS.find((sp) => sp.key === key)
  if (!spec?.options?.length) throw new Error(`'${key}' is not an option row in MODIFIER_SPECS`)
  return [...spec.options]
}
/** …and the words the user sees, derived exactly as `optionRowSpec` in
 *  Scene3DStudioSurface.vue derives the 3D segmented buttons from those same ids. */
const optionWords = (key: string): string[] =>
  optionIds(key).map((o) => o[0]!.toUpperCase() + o.slice(1))
const SPREAD_WORDS = optionWords('varyColorSpread')

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

/** Every CloneTransform field stays finite — used by both the varyOf NaN-guard
 *  tests and the cleared-field DOM test below. */
const finite = (c: Cloner) => expandClones(c, 1)
  .every((t) => [t.dx, t.dy, t.drot, t.dscale, t.dopacity, t.weight, t.tintStrength]
    .every((n) => Number.isFinite(n)))

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
    expect(labels).toEqual(optionWords('varyMode'))
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

  it('renders the SHARED VaryPalette component with the cloner palette, remove control and all', () => {
    // Asserts the actual import, not just a `data-test` attribute a reimplementation
    // could copy — findComponent matches by component definition.
    const w = mountWith({ varyColor: true, varyPalette: ['#ff0000', '#00ff00'] })
    const palette = w.findComponent(VaryPalette)
    expect(palette.exists()).toBe(true)
    expect(palette.props('modelValue')).toEqual(['#ff0000', '#00ff00'])
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
    expect(labels).toEqual(SPREAD_WORDS)
  })

  it('is absent at a single copy and present above it', () => {
    // The 3D Studio gates the WHOLE Vary block on more than one copy (`varyOn`,
    // lib/scene3d/controls.ts). Frame used to gate only on the cloner being enabled,
    // so a 1x1 grid with colour on repainted its lone copy the first swatch — a user
    // who learns "Vary varies across copies" in 3D met something else here.
    const one = mountWith({ countX: 1, countY: 1, varyColor: true })
    expect(one.find('[data-test="vary-block"]').exists()).toBe(false)
    expect(one.text()).not.toContain('Vary')
    expect(mountWith({ countX: 2, countY: 1 }).find('[data-test="vary-block"]').exists()).toBe(true)
    expect(mountWith({ countX: 1, countY: 2 }).find('[data-test="vary-block"]').exists()).toBe(true)
    // Radial counts the same way…
    expect(mountWith({ mode: 'radial', count: 1 }).find('[data-test="vary-block"]').exists()).toBe(false)
    expect(mountWith({ mode: 'radial', count: 3 }).find('[data-test="vary-block"]').exists()).toBe(true)
    // …and the gate is the panel's OWN copy count, not countX*countY: a mirrored
    // single column is still 2*1-1 = 1 copy, while a mirrored pair is 3.
    expect(mountWith({ countX: 1, countY: 1, mirrorX: true }).find('[data-test="vary-block"]').exists()).toBe(false)
    expect(mountWith({ countX: 2, countY: 1, mirrorX: true }).find('[data-test="vary-block"]').exists()).toBe(true)
  })
})

describe('Vary copy is the 3D Studio schema, not a hand-copy of it', () => {
  // A whole review round went into making these two surfaces read identically, and
  // NOTHING held them together: this file used to assert the same string literals the
  // panel hard-codes, with a comment claiming they matched the 3D Studio. Renaming
  // `varySeed` in primParams.ts to anything at all left 245 tests green while the two
  // surfaces silently diverged.
  //
  // So every expectation below is READ FROM THE SCHEMA. The panel stays hand-rolled on
  // purpose (a Frame panel should not import a 3D module at runtime) — this test is the
  // coupling, and it fails the moment either side is edited alone.

  // Every Vary label Frame shows, paired with the mount state that reveals it here and
  // the 3D row key it must agree with word for word.
  const LABELS: { row: string; over: Partial<Cloner> }[] = [
    { row: 'varyMode', over: {} },                                  // Pattern
    { row: 'varySeed', over: { varyMode: 'random' } },              // Vary seed
    { row: 'varyFalloffCenter', over: { varyMode: 'falloff' } },    // Centre
    { row: 'varyFalloffRadius', over: { varyMode: 'falloff' } },    // Reach
    { row: 'varyColor', over: {} },                                 // Vary colour
    { row: 'varyColorSpread', over: { varyColor: true } },          // Spread
    { row: 'varyColorStrength', over: { varyColor: true } },        // Colour strength
  ]

  it('shows the 3D Studio label, word for word, for every Vary row', () => {
    for (const c of LABELS) {
      const label = label3d(c.row)
      expect(varyText(mountWith(c.over)), `${c.row} -> "${label}"`).toContain(label)
    }
  })

  it('covers EVERY Vary row the 3D inspector draws — a new one there fails here', () => {
    // Without this the list above could quietly fall behind: add a vary row to the 3D
    // Studio, forget Frame, and every assertion here would still pass.
    expect(LABELS.map((c) => c.row).sort()).toEqual(Object.keys(SCENE3D_VARY_LABELS).sort())
  })

  it('spells the driver and spread options exactly as the 3D Studio segmented rows do', () => {
    // The 3D inspector builds those buttons in `optionRowSpec` (Scene3DStudioSurface.vue)
    // by capitalising the schema's stored option ids. Same derivation here, so adding or
    // renaming an option on either side breaks this.
    expect(mountWith().findAll('[data-test="vary-mode"] button').map((b) => b.text()))
      .toEqual(optionWords('varyMode'))
    expect(mountWith({ varyColor: true }).findAll('[data-test="vary-spread"] button').map((b) => b.text()))
      .toEqual(SPREAD_WORDS)
  })

  it('never surfaces a stored internal value as copy', () => {
    // The flip side of the above: the WORDS must be shown, never the ids behind them.
    const ids = [...optionIds('varyMode'), ...optionIds('varyColorSpread')]
    const idRe = new RegExp(`\\b(${ids.join('|')})\\b`)
    for (const over of [{}, { varyMode: 'random' as const }, { varyMode: 'falloff' as const },
      { varyColor: true }, { varyColor: true, varyColorSpread: 'blend' as const }]) {
      const t = varyText(mountWith(over))
      expect(t, JSON.stringify(over)).not.toMatch(idRe)
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

describe('each numeric vary field clamps to its own declared range', () => {
  // A review found the clamps were correct but had ZERO regression protection —
  // every existing test value sits comfortably in range, so widening or dropping
  // a bound passed silently. Each case here drives a value past both ends and
  // reads the bound off the input's OWN min/max attributes, so the clamp and the
  // DOM constraint cannot drift apart.
  const CASES = [
    { name: 'Seed', hook: 'vary-seed', key: 'varySeed', extra: { varyMode: 'random' as const }, whole: true },
    { name: 'Centre', hook: 'vary-center', key: 'varyFalloffCenter', extra: {}, whole: false },
    { name: 'Reach', hook: 'vary-reach', key: 'varyFalloffRadius', extra: {}, whole: false },
    { name: 'Colour strength', hook: 'vary-strength', key: 'varyColorStrength', extra: { varyColor: true }, whole: false },
  ]

  for (const c of CASES) {
    it(`${c.name} clamps to its input's own min and max`, async () => {
      const w = mountWith({ varyMode: 'falloff', ...c.extra })
      const input = w.find(`[data-test="${c.hook}"] input`)
      const el = input.element as HTMLInputElement
      const min = Number(el.min)
      const max = Number(el.max)
      expect(Number.isFinite(min) && Number.isFinite(max)).toBe(true)

      el.value = String(max + 1000)
      await input.trigger('input')
      expect((lastEmit(w) as Record<string, number>)[c.key]).toBe(max)

      el.value = String(min - 1000)
      await input.trigger('input')
      expect((lastEmit(w) as Record<string, number>)[c.key]).toBe(min)

      // A whole-number field must round; a fractional one must not.
      el.value = String(min + (max - min) / 3)
      await input.trigger('input')
      const got = (lastEmit(w) as Record<string, number>)[c.key]!
      expect(Number.isInteger(got)).toBe(c.whole)
    })
  }
})

describe('each numeric vary field writes to its own key', () => {
  // Two review rounds have already found a copy-paste swap in this block once
  // (the reviewer made the Centre input write varyFalloffRadius, and the Colour
  // strength input write varySeed) that the suite at the time did not catch. One
  // assertion per field, pinning both the field's own key AND that the other
  // three are untouched, so a swapped `@input` target fails loudly.
  const base: Cloner = {
    ...DEFAULT_CLONER, enabled: true, varyMode: 'falloff', varyColor: true,
    varySeed: 7, varyFalloffCenter: 0.2, varyFalloffRadius: 0.3, varyColorStrength: 0.4,
  }

  it('Seed writes varySeed only', async () => {
    const w = mountWith({ ...base, varyMode: 'random' })
    const input = w.find('[data-test="vary-seed"] input')
    ;(input.element as HTMLInputElement).value = '42'
    await input.trigger('input')
    const next = lastEmit(w)
    expect(next.varySeed).toBe(42)
    expect(next.varyFalloffCenter).toBe(base.varyFalloffCenter)
    expect(next.varyFalloffRadius).toBe(base.varyFalloffRadius)
    expect(next.varyColorStrength).toBe(base.varyColorStrength)
  })

  it('Centre writes varyFalloffCenter only', async () => {
    const w = mountWith(base)
    const input = w.find('[data-test="vary-center"] input')
    ;(input.element as HTMLInputElement).value = '0.77'
    await input.trigger('input')
    const next = lastEmit(w)
    expect(next.varyFalloffCenter).toBe(0.77)
    expect(next.varySeed).toBe(base.varySeed)
    expect(next.varyFalloffRadius).toBe(base.varyFalloffRadius)
    expect(next.varyColorStrength).toBe(base.varyColorStrength)
  })

  it('Reach writes varyFalloffRadius only', async () => {
    const w = mountWith(base)
    const input = w.find('[data-test="vary-reach"] input')
    ;(input.element as HTMLInputElement).value = '0.88'
    await input.trigger('input')
    const next = lastEmit(w)
    expect(next.varyFalloffRadius).toBe(0.88)
    expect(next.varySeed).toBe(base.varySeed)
    expect(next.varyFalloffCenter).toBe(base.varyFalloffCenter)
    expect(next.varyColorStrength).toBe(base.varyColorStrength)
  })

  it('Colour strength writes varyColorStrength only', async () => {
    const w = mountWith(base)
    const input = w.find('[data-test="vary-strength"] input')
    ;(input.element as HTMLInputElement).value = '0.66'
    await input.trigger('input')
    const next = lastEmit(w)
    expect(next.varyColorStrength).toBe(0.66)
    expect(next.varySeed).toBe(base.varySeed)
    expect(next.varyFalloffCenter).toBe(base.varyFalloffCenter)
    expect(next.varyFalloffRadius).toBe(base.varyFalloffRadius)
  })
})

describe('varyOf NaN guard', () => {
  // `varyOf` (frontend/app/composables/useCloner.ts) defends against a NaN
  // already present in a STORED document reaching Math.pow(stepScale, NaN) in
  // falloff mode, which makes both dscale and dopacity NaN and silently vanishes
  // the layer from the composite. That is a real, worth-keeping defence — but it
  // is NOT reachable by clearing one of the panel's four number inputs: for an
  // `<input type="number">`, an invalid or empty DOM value reads back as `''` or
  // a valid numeric string (invalid text is sanitised away by the browser), and
  // `Number('')` is `0`, not `NaN`. So no panel gesture exercises this guard —
  // the two tests below drive it synthetically instead.

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
})

describe('a cleared number field', () => {
  it('clearing the reach field still composites to finite transforms', async () => {
    // NOT a NaN-guard proof (see the describe block above — Number('') is 0, not
    // NaN, so this gesture cannot reach `varyOf`'s guard). What this DOES prove:
    // the real DOM gesture of clearing the field — value becomes '', Number('')
    // is 0, falloffRadius 0 is floored to 1e-6 by lib/vary's own `Math.max` — never
    // produces a non-finite transform, with or without the guard.
    const w = mountWith({ varyMode: 'falloff', countX: 4, stepScale: 0.9 })
    const input = w.find('[data-test="vary-reach"] input')
    ;(input.element as HTMLInputElement).value = ''
    await input.trigger('input')
    expect(finite(lastEmit(w))).toBe(true)
  })
})

describe('Phase row', () => {
  it('shows a Phase slider and writes phase back', async () => {
    const w = mount(Panel, { props: { cloner: { ...DEFAULT_CLONER, enabled: true } } })
    const row = w.findAllComponents({ name: 'StudioSlider' }).find(s => s.props('label') === 'Phase')
    expect(row).toBeTruthy()
    row!.vm.$emit('update:modelValue', 0.5)
    const last = w.emitted('update')!.at(-1)![0] as Cloner
    expect(last.phase).toBe(0.5)
  })
})
