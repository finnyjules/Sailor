import { describe, it, expect } from 'vitest'
import { gradientAgentControls } from '../../app/lib/gradientfx/agentControls'
import { defaultConfig, stripeConfig } from '../../app/lib/gradientfx/randomize'
import { makeConfigParams } from '../../app/lib/agent/configParams'
import { ensureConfigDefaults } from '~/lib/gradientfx/types'
import { GRADIENT_CONTROLS, GRADIENT_SECTIONS, visibleGradientControls } from '../../app/lib/gradientfx/controls'

/**
 * Characterization tests. These pin the CURRENT output of gradientAgentControls
 * so converting it into a derivation over GRADIENT_CONTROLS is provably
 * behaviour-preserving. A change here means the agent's vocabulary moved, which
 * silently breaks saved Collection bindings (`params.<key>`) and the key strings
 * baked into GRADIENT_GUIDANCE.
 *
 * Note: the brief that spawned this file assumed a zero-arg default-config
 * factory lives in `app/lib/gradientfx/types.ts`. The real factory is
 * `defaultConfig` from `app/lib/gradientfx/randomize.ts` (types.ts only has
 * `ensureConfigDefaults`, which needs an existing GradientConfig-shaped input).
 * `defaultConfig(seed = randomSeed())` is effectively zero-arg for our purposes;
 * the random seed has no effect on gradientAgentControls's output (it never
 * reads cfg.seed, and every slider's `default` field is hardcoded to 0), so the
 * snapshots below are deterministic despite the random seed.
 *
 * `defaultConfig` now opens a brand-new document on the simple Linear ramp
 * (`layout:'ramp'`), not the stripe archetype — see Task 7. The per-layout
 * characterizations below (`linear`/`radial`/`orbit`/`liquid`/`mesh`) build off
 * `stripeConfig` instead, the historical stripe-shaped default that's still
 * byte-identical to what `defaultConfig` used to return, so those snapshots stay
 * pinned. `defaultConfig` itself is characterized separately, under its own
 * `layout:'ramp'`, in the `ramp default` block below.
 */

function cfgWithLayout(layout: string) {
  const c: any = stripeConfig()
  c.canvas.layout = layout
  // Match how the app actually loads a config: loadConfig() always normalizes
  // through ensureConfigDefaults, which backfills focus/center/light/flow and
  // (for mesh layouts) layer 0's mesh points. Characterizing an un-normalized
  // config would pin behavior that never occurs at runtime.
  return ensureConfigDefaults(c)
}

const LAYOUTS_UNDER_TEST = ['linear', 'radial', 'orbit', 'liquid', 'mesh'] as const

describe('gradientAgentControls characterization', () => {
  for (const layout of LAYOUTS_UNDER_TEST) {
    it(`emits stable full specs for layout=${layout}`, () => {
      expect(gradientAgentControls(cfgWithLayout(layout))).toMatchSnapshot()
    })
  }

  it('emits stable specs with includePreset', () => {
    expect(gradientAgentControls(cfgWithLayout('linear'), { includePreset: true })).toMatchSnapshot()
  })

  it('includePreset adds exactly one control, at the front', () => {
    const withPreset = gradientAgentControls(cfgWithLayout('linear'), { includePreset: true })
    const without = gradientAgentControls(cfgWithLayout('linear'))
    expect(withPreset).toHaveLength(without.length + 1)
    expect(withPreset[0]!.key).toBe('preset')
  })

  it('emits focus.angle only when focus.shape is linear', () => {
    const off: any = cfgWithLayout('linear')
    expect(gradientAgentControls(off).some((c) => c.key === 'focus.angle')).toBe(false)
    const lin: any = cfgWithLayout('linear')
    lin.focus = { ...(lin.focus ?? {}), shape: 'linear' }
    expect(gradientAgentControls(lin).some((c) => c.key === 'focus.angle')).toBe(true)
  })

  it('emits one colour control per stop, in ramp order', () => {
    const cfg: any = cfgWithLayout('linear')
    const stops = cfg.layers[0].color.stops.length
    const colours = gradientAgentControls(cfg).filter((c) => c.key.startsWith('layer.color.stops.'))
    expect(colours).toHaveLength(stops)
    expect(colours[0]!.key).toBe('layer.color.stops.0.color')
    expect(colours[0]!.label).toBe('Colour 1')
  })
})

describe('gradientAgentControls characterization — ramp default (Task 7)', () => {
  // A brand-new document opens on defaultConfig(), which is now `layout:'ramp'`.
  // This pins the intended vocabulary move: the ramp is flat, so Shape/Relief
  // drop out, and the simple axis controls (angle, repeat/falloff) take over.
  it('emits stable full specs for the ramp default', () => {
    expect(gradientAgentControls(defaultConfig() as any)).toMatchSnapshot()
  })

  it('shows the ramp axis + repeat/falloff controls', () => {
    const keys = gradientAgentControls(defaultConfig() as any).map((c) => c.key)
    expect(keys).toContain('layer.ramp.angle')
    expect(keys).toContain('layer.color.repeat')
    expect(keys).toContain('layer.color.falloff')
  })

  it('withholds Shape and Relief controls — a ramp is flat', () => {
    const keys = gradientAgentControls(defaultConfig() as any).map((c) => c.key)
    for (const c of GRADIENT_CONTROLS) {
      if (c.group === 'Shape' || c.group === 'Relief') expect(keys, c.key).not.toContain(c.key)
    }
  })
})

describe('gradientAgentControls integrity', () => {
  for (const layout of LAYOUTS_UNDER_TEST) {
    it(`every emitted key resolves against a real config leaf for layout=${layout}`, () => {
      const cfg = cfgWithLayout(layout)
      const params = makeConfigParams(() => cfg, () => 0)
      const unresolved = gradientAgentControls(cfg)
        .map((c) => c.key)
        .filter((k) => params[k] === undefined)
      expect(unresolved).toEqual([])
    })

    it(`has no duplicate keys for layout=${layout}`, () => {
      const keys = gradientAgentControls(cfgWithLayout(layout)).map((c) => c.key)
      expect(new Set(keys).size).toBe(keys.length)
    })

    it(`every slider declares a finite range for layout=${layout}`, () => {
      for (const c of gradientAgentControls(cfgWithLayout(layout))) {
        if (c.kind !== 'slider') continue
        expect(Number.isFinite(c.min), `${c.key} min`).toBe(true)
        expect(Number.isFinite(c.max), `${c.key} max`).toBe(true)
        expect(c.max, `${c.key} range`).toBeGreaterThan(c.min)
      }
    })
  }
})

describe('GRADIENT_CONTROLS schema integrity', () => {
  it('has unique keys', () => {
    const keys = GRADIENT_CONTROLS.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every control belongs to a declared section', () => {
    for (const c of GRADIENT_CONTROLS) {
      expect(GRADIENT_SECTIONS, `${c.key} group "${c.group}"`).toContain(c.group)
    }
  })

  it('every select default is one of its own options', () => {
    for (const c of GRADIENT_CONTROLS) {
      if (c.kind !== 'select') continue
      expect(c.options, `${c.key} options`).toContain(c.default)
    }
  })

  it('every slider keeps the inert default of 0', () => {
    // Post-sourced sliders are the one deliberate exception: postControls() sets
    // `default` to the effect's REAL default (e.g. bloomStrength 0.6) because,
    // unlike Gradient's own hand-authored controls (whose `default` is read only
    // by gradientAgentControls/motion, never by the UI — see this file's top
    // comment), Post is rendered by StudioControlPanel/StudioSlider directly in
    // GradientStudioSurface.vue, where `default` drives the actual double-click
    // reset-to-default behaviour. A real default there is correct, not a bug.
    for (const c of GRADIENT_CONTROLS) {
      if (c.kind !== 'slider') continue
      if (c.key.startsWith('post.')) continue
      expect(c.default, `${c.key} default`).toBe(0)
    }
  })

  it('visibleGradientControls only returns members of GRADIENT_CONTROLS or synthesized colour controls', () => {
    // Colour controls have runtime cardinality (one per gradient stop / mesh point) and
    // are deliberately NOT in the static GRADIENT_CONTROLS array — see the "Colours:
    // runtime cardinality" comment in controls.ts. Allow that documented pattern through.
    const all = new Set(GRADIENT_CONTROLS.map((c) => c.key))
    const colourKey = /^layer\.(color\.stops|mesh\.points)\.\d+\.color$/
    for (const c of visibleGradientControls(defaultConfig() as any)) {
      expect(all.has(c.key) || colourKey.test(c.key), `${c.key} not in GRADIENT_CONTROLS`).toBe(true)
    }
  })

  it('withholds Shape controls from the agent, except the deliberately exposed direction', () => {
    // direction was promoted to the agent vocabulary on 2026-08-05 (taste-wall
    // spike: "horizontal banding" was unexpressible). The rest of the Shape
    // block stays agent: false pending its own deliberate step.
    const shape = GRADIENT_CONTROLS.filter((c) => c.group === 'Shape')
    expect(shape.length).toBeGreaterThan(0)
    const exposed = shape.filter((c) => (c as any).agent !== false).map((c) => c.key)
    expect(exposed).toEqual(['layer.shape.direction'])
  })
})

describe('orientation is offered where the shader actually reads it', () => {
  // Ground truth is the shader: u_dir is read only in the linear branches
  // (computeLayer + bandHeight); u_gradHoriz in the linear and radial/orbit
  // branches. Stack ignores both (rings run the ramp along their local
  // vertical) and liquid orients via flow.angle.
  it('offers band direction on linear only', () => {
    for (const layout of LAYOUTS_UNDER_TEST) {
      const keys = gradientAgentControls(cfgWithLayout(layout)).map((c) => c.key)
      expect(keys.includes('layer.shape.direction'), layout).toBe(layout === 'linear')
    }
  })

  it('offers gradient direction on linear/radial/orbit only', () => {
    for (const layout of LAYOUTS_UNDER_TEST) {
      const keys = gradientAgentControls(cfgWithLayout(layout)).map((c) => c.key)
      const expected = layout === 'linear' || layout === 'radial' || layout === 'orbit'
      expect(keys.includes('layer.color.gradientDir'), layout).toBe(expected)
    }
  })
})

describe('relief light is offered where it actually does something', () => {
  // Ground truth is the shader: shaders.ts gates the u_light branch on
  // `u_layout < 3.5` (linear/radial/orbit/stack), and the liquid branch is explicit
  // that it uses "its own light, not u_light". The legacy agent builder had these
  // under isLiquid — exactly inverted — so the agent was offered them where they do
  // nothing and denied them where they work. This pins the corrected placement.
  const lightKeys = ['relief.light.azimuth', 'relief.light.elevation']

  for (const layout of ['linear', 'radial', 'orbit'] as const) {
    it(`offers the light controls for the banded layout ${layout}`, () => {
      const keys = gradientAgentControls(cfgWithLayout(layout)).map((c) => c.key)
      for (const k of lightKeys) expect(keys, `${layout} / ${k}`).toContain(k)
    })
  }

  for (const layout of ['liquid', 'mesh'] as const) {
    it(`withholds the light controls for ${layout}, where u_light is unused`, () => {
      const keys = gradientAgentControls(cfgWithLayout(layout)).map((c) => c.key)
      for (const k of lightKeys) expect(keys, `${layout} / ${k}`).not.toContain(k)
    })
  }
})

// ── guidance ↔ vocabulary drift detector ────────────────────────────────────
//
// Third bite of this class, so it gets a detector rather than another fix.
// Guidance that names a key its accompanying control list does NOT offer is
// worse than silence: the model answers with that key, `validatePatch` drops it
// without a word, and the rationale then describes an intent nothing applied.
// That shipped — the in-studio path offered no `preset` while the guidance
// taught PRESET-FIRST, so "a dreamy sunset-like gradient" returned a preset swap
// that vanished and a rationale describing a sunset over an untouched rainbow.
import { gradientGuidance, GRADIENT_GUIDANCE } from '../../app/lib/gradientfx/agentControls'

/** Every dotted key a guidance string names, plus bare `"preset"` from its JSON
 *  examples. `stops.0.` style indices are normalised so a guidance line about
 *  stop 0 is checked against whichever stop keys the config actually has. */
function keysNamedIn(text: string): string[] {
  const dotted = Array.from(text.matchAll(/\b([a-z][a-zA-Z]*(?:\.[a-zA-Z0-9]+){1,4})\b/g)).map(m => m[1]!)
  const bare = /"preset"\s*:/.test(text) ? ['preset'] : []
  return [...new Set([...dotted, ...bare])]
    .filter(k => !/^(e\.g|i\.e|0\.\d|\d)/.test(k))
    .map(k => k.replace(/\.\d+\./g, '.N.'))
}

/** Every key the vocabulary can EVER offer, across layouts. The union, not one
 *  config's list, because the guidance is deliberately layout-agnostic — it
 *  teaches `flow.depth` knowing the knob appears only on liquid/mesh. What must
 *  never happen is a key NO configuration of that vocabulary can reach, which is
 *  exactly what `preset` was in the studio. Weaker than a per-config check, and
 *  it is the class that actually bit. */
/** EVERY layout, not just the snapshotted five — the ramp family is where
 *  `layer.ramp.angle` lives, and a detector that cannot see a real layout
 *  reports a real key as drift. */
const ALL_LAYOUTS = ['ramp', 'radialRamp', 'conic', 'curve', 'linear', 'radial', 'orbit', 'stack', 'liquid', 'mesh'] as const

function offeredBy(opts: { includePreset?: boolean } = {}): Set<string> {
  const out = new Set<string>()
  for (const layout of ALL_LAYOUTS) {
    for (const c of gradientAgentControls(cfgWithLayout(layout), opts)) {
      out.add(c.key.replace(/\.\d+\./g, '.N.'))
    }
  }
  return out
}

describe('guidance never names a key its own control list lacks', () => {
  it('the preset-less assembly names no key the preset-less vocabulary omits', () => {
    const offered = offeredBy()
    const unknown = keysNamedIn(gradientGuidance()).filter(k => !offered.has(k))
    expect(unknown).toEqual([])
  })

  it('…and specifically never mentions the preset macro it cannot use', () => {
    const g = gradientGuidance()
    expect(g).not.toContain('"preset"')
    expect(g.toLowerCase()).not.toContain('preset')
  })

  it('the preset assembly names no key the preset vocabulary omits', () => {
    const offered = offeredBy({ includePreset: true })
    const unknown = keysNamedIn(GRADIENT_GUIDANCE).filter(k => !offered.has(k))
    expect(unknown).toEqual([])
  })

  it('the detector bites: the preset text against the preset-less vocabulary', () => {
    // The shipped defect, reproduced — the OLD guidance paired with the studio's
    // OLD vocabulary. If this ever comes back empty the detector has gone blind.
    const unknown = keysNamedIn(GRADIENT_GUIDANCE).filter(k => !offeredBy().has(k))
    expect(unknown).toContain('preset')
  })

  it('the two assemblies really are different texts (the split is not cosmetic)', () => {
    expect(gradientGuidance()).not.toBe(GRADIENT_GUIDANCE)
    expect(GRADIENT_GUIDANCE).toContain('"preset":"marble"')
    expect(gradientGuidance()).toContain('layer.color.stops.0.color')
  })
})
