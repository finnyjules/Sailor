/**
 * Vector Type — the declarative control schema.
 *
 * The schema is the factory: one `ControlSpec[]` list feeds the agent, motion,
 * Collection sweeps and the inspector. These tests pin the two ways that goes
 * silently wrong — a key that does not resolve against the config (a control
 * that does nothing), and guidance prose naming a key that does not exist (a
 * patch `validatePatch` drops without a word) — plus the strictness of
 * `mergeConfig`, which is all that stands between a saved blob and the renderer.
 *
 * NO NETWORK. Where a real font is needed, it is the same local Inter subset the
 * outline spec uses.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, it, expect, vi } from 'vitest'

/**
 * The shader-fx catalog is a NETWORK resource (`$fetch('/sailor/shader_effects')`),
 * and `getEffectSync` reads whatever a page has already fetched. That module-level
 * cache is the seam: mocking it hands `vtAgentControls` a real-shaped `EffectDef`
 * without a request, and lets a test also exercise the "catalog has not resolved
 * this id" branch, which is otherwise unreachable offline.
 *
 * The mocked effect deliberately declares BOTH param types — a float and an enum —
 * because `derivedShaderFillControls` addresses them through two different code
 * paths and only the float one would be covered by a single-param fixture.
 */
const { CATALOG_EFFECT } = vi.hoisted(() => ({
  CATALOG_EFFECT: {
    id: 'kaleidoscope',
    name: 'Kaleidoscope',
    params: [
      { uniform: 'u_segments', label: 'Segments', type: 'float', min: 2, max: 24, default: 6 },
      { uniform: 'u_zoom', label: 'Zoom', type: 'float', min: 0.1, max: 4, default: 1 },
      { uniform: 'u_mode', label: 'Mode', type: 'enum', default: 0, options: [{ label: 'Wedge', value: 0 }, { label: 'Nested', value: 1 }] },
    ],
  } as any,
}))
vi.mock('~/lib/shaderfx/catalog', () => ({
  getEffectSync: (id: string) => (id === CATALOG_EFFECT.id ? CATALOG_EFFECT : null),
}))

import { makeConfigParams } from '~/lib/agent/configParams'
import { DEFAULT_FILL, paintPrimaryColor } from '~/lib/spacetype/fillTile'
import { isValidAxisTag, normaliseAxes, type VtAxis } from '~/lib/vectortype/font'
import { VT_STACK_PREFIX, animatableTargets, applyMotion } from '~/lib/vectortype/motion'
import {
  DEFAULT_CONFIG,
  VT_ALIGNS,
  VT_BASE_FILL_ID,
  VT_BASE_STROKE_ID,
  VT_DEFAULT_STROKE_WIDTH,
  VT_FILL_ANCHORS,
  VT_FONT_IDS,
  VT_LAYER_MAX,
  cloneConfig,
  isAxisTag,
  mergeConfig,
  migrateLegacyAppearance,
  vtBaseAppearance,
  vtLayer,
  vtLayerId,
  type VectorTypeConfig,
  type VtMotionTrack,
  type VtMove,
} from '~/lib/vectortype/config'
import {
  VT_AXES_GROUP,
  VT_CONTROLS,
  VT_LAYER_PREFIX,
  VT_SECTIONS,
  derivedAxisControls,
  derivedScatterControls,
  visibleVtControls,
} from '~/lib/vectortype/controls'
import { VT_GUIDANCE, VT_LAYER_SHADER_PREFIX, vtAgentControls } from '~/lib/vectortype/agentControls'
import { derivedShaderFillControls, shaderFillControls } from '~/lib/shaderfill/controls'

const cfg = (over: Partial<VectorTypeConfig> = {}): VectorTypeConfig =>
  mergeConfig({ ...cloneConfig(DEFAULT_CONFIG), ...over })

/** A LEGACY (pre-stack) blob: the shape every saved node holds. `cfg` cannot
 *  build one, because it spreads `DEFAULT_CONFIG` and that now carries an
 *  `appearance` array — whose presence is exactly what tells `mergeConfig` the
 *  config has already been migrated. */
const legacyCfg = (over: Record<string, unknown> = {}): VectorTypeConfig =>
  mergeConfig({ text: 'Saved', fontId: 'inter', size: 120, ...over })

/** Every track any `'tracks'`-kind move in `cfg.motion.moves` owns, flattened
 *  — the direct replacement for reading the old flat `motion.tracks` array
 *  (GONE: a track's home is a move's own `tracks` array now, see
 *  `VtMotionConfig.moves`'s doc in `~/lib/vectortype/config`). */
const allTracks = (c: VectorTypeConfig): VtMotionTrack[] =>
  c.motion.moves.filter(m => m.kind === 'tracks').flatMap(m => (m.tracks ?? []) as VtMotionTrack[])

/** A config whose ACTIVE layer (index 0) is a STROKE layer — what `layer.width`
 *  is gated on now that the stroke is a layer rather than a width on the config. */
const strokeCfg = (width = 3) =>
  cfg({ appearance: [vtLayer({ id: VT_BASE_STROKE_ID, kind: 'stroke', width })] })

/** The layer vocabulary resolves against `appearance[active]`, not `layers[…]`. */
const paramsFor = (c: VectorTypeConfig, active = 0) =>
  makeConfigParams(() => c, () => active, 'appearance')

/** The three frozen shader keys AT VECTOR TYPE'S PREFIX. The shared constant
 *  `VT_SHADER_CONTROLS` is still at `layer.paint.shader` for its three other hosts. */
const VT_SHADER_CONTROLS = shaderFillControls(VT_LAYER_SHADER_PREFIX)

/** A config whose single (active) layer carries `paint`. `cfg({ fill })` cannot
 *  do this any more: `cfg` spreads `DEFAULT_CONFIG`, so the stack is already
 *  present and a stray `fill` key is correctly ignored by the merge. */
const paintCfg = (paint: unknown) =>
  cfg({ appearance: [vtLayer({ id: VT_BASE_FILL_ID, paint: paint as any })] })

/** A Roboto-Flex-shaped axis set: two familiar axes and two exotic ones, so the
 *  derived vocabulary is exercised on the tags the design doc calls the point. */
const RICH_AXES: VtAxis[] = [
  { tag: 'wght', name: 'Weight', min: 100, max: 1000, default: 400 },
  { tag: 'wdth', name: 'Width', min: 25, max: 151, default: 100 },
  { tag: 'GRAD', name: 'Grade', min: -200, max: 150, default: 0 },
  { tag: 'XOPQ', name: 'Thick stroke', min: 27, max: 175, default: 96 },
]

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
function fixtureAxes(): VtAxis[] {
  const raw: any = (fontkit as any).create(new Uint8Array(readFileSync(FIXTURE)))
  return normaliseAxes(raw?.variationAxes)
}

describe('VT_CONTROLS integrity', () => {
  it('declares a non-empty schema', () => {
    // Guards every loop below from passing vacuously over an empty list.
    expect(VT_CONTROLS.length).toBeGreaterThan(0)
  })

  it('has unique keys', () => {
    const keys = VT_CONTROLS.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every control belongs to a declared section', () => {
    for (const c of VT_CONTROLS) {
      expect(VT_SECTIONS, `${c.key} group "${c.group}"`).toContain(c.group)
    }
  })

  it('reserves the derived-axis section without declaring a static member in it', () => {
    // "Declare the frame, derive the contents": the section exists in the schema,
    // its contents come from the loaded font.
    expect(VT_SECTIONS).toContain(VT_AXES_GROUP)
    expect(VT_CONTROLS.filter((c) => c.group === VT_AXES_GROUP)).toEqual([])
  })

  it('keeps the axes namespace clear of static keys', () => {
    // A static `axes.something` would collide with a derived key the moment a
    // font declared that tag, and the collision would be silent.
    for (const c of VT_CONTROLS) expect(c.key.startsWith('axes.'), c.key).toBe(false)
  })

  it('every select default is one of its own options', () => {
    for (const c of VT_CONTROLS) {
      if (c.kind !== 'select') continue
      expect(c.options, `${c.key}`).toContain(c.default)
    }
  })

  it('every slider default sits inside its own range', () => {
    for (const c of VT_CONTROLS) {
      if (c.kind !== 'slider') continue
      expect(c.default, `${c.key} default`).toBeGreaterThanOrEqual(c.min)
      expect(c.default, `${c.key} default`).toBeLessThanOrEqual(c.max)
      expect(c.max, `${c.key} range`).toBeGreaterThan(c.min)
    }
  })

  it('every colour default is the #rrggbb form validatePatch accepts', () => {
    for (const c of VT_CONTROLS) {
      if (c.kind !== 'color') continue
      expect(c.default, `${c.key}`).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('every key resolves against a real config leaf', () => {
    // The whole point of dotted keys: the agent, motion and Collection bindings
    // all write through makeConfigParams. A key that does not resolve is a
    // control that silently does nothing.
    // EVERY declared key, including the ones `when` hides on this config: the
    // kind-specific layer fields are backfilled on every layer precisely so a
    // control can never address a leaf that is not there.
    const params = paramsFor(strokeCfg(4))
    const unresolved = VT_CONTROLS.map((s) => s.key).filter((k) => params[k] === undefined)
    expect(unresolved).toEqual([])
  })

  it('the resolution probe detects a key that does NOT resolve', () => {
    // Proves the test above is not vacuous: the same probe returns undefined for
    // a key with no leaf behind it. (Confirmed by hand too — renaming a real key
    // in VT_CONTROLS turns the test above red.)
    const params = paramsFor(cfg())
    expect(params['layer.paint.a']).toBeDefined()
    expect(params['nope']).toBeUndefined()
    expect(params['layer.paint.deeper']).toBeUndefined()
    // …and the relative prefix is not magic: it only resolves because
    // `makeConfigParams` was told the list is `appearance`.
    expect(makeConfigParams(() => cfg(), () => 0)['layer.paint.a']).toBeUndefined()
    // Sparse by design: an unset axis has no leaf until it is written.
    expect(params['axes.wght']).toBeUndefined()
  })

  it('every slider default equals the value DEFAULT_CONFIG actually ships', () => {
    const params = paramsFor(cfg())
    for (const s of VT_CONTROLS) {
      if (s.kind !== 'slider') continue
      expect(params[s.key], `${s.key}`).toBe(s.default)
    }
  })

  it('fontId is a token-tolerant free-text control, opted back into the agent vocabulary', () => {
    // `mergeConfig` now accepts any of the three token shapes (`fontToken.ts`),
    // not just a catalog id, so a fixed `options` list would reject a valid
    // `google:`/`local:` token. `text` is the free-string kind — not
    // agent-editable by default, so `aiEditable: true` opts it back in — and
    // it is not animatable: a different font is a different axis set, not a
    // point on a scale.
    const spec = VT_CONTROLS.find((c) => c.key === 'fontId')!
    expect(spec.kind).toBe('text')
    expect((spec as any).options).toBeUndefined()
    expect((spec as any).aiEditable).toBe(true)
    expect((spec as any).animatable).toBe(false)
    // The default itself is still one of the ten pinned ids.
    expect(VT_FONT_IDS).toContain(DEFAULT_CONFIG.fontId)
  })
})

describe('visibleVtControls follows the surface predicates', () => {
  it('withholds the stroke width unless the ACTIVE layer is a stroke', () => {
    // The old gate was backwards: `strokeWidth` was always offered and the
    // COLOUR was withheld until the width went above zero — which is how the
    // stroke stayed invisible. Now the width belongs to a stroke layer, and a
    // stroke layer is visible because it is in the stack.
    expect(visibleVtControls(cfg()).map((c) => c.key)).not.toContain('layer.width')
    expect(visibleVtControls(strokeCfg()).map((c) => c.key)).toContain('layer.width')
  })

  it('gates the layer controls on the ACTIVE layer, not on layer 0', () => {
    const two = cfg({ appearance: [vtLayer({ id: 'La' }), vtLayer({ id: 'Lb', kind: 'stroke' })] })
    expect(visibleVtControls(two, 0).map((c) => c.key)).not.toContain('layer.width')
    expect(visibleVtControls(two, 1).map((c) => c.key)).toContain('layer.width')
  })

  it('emits in VT_SECTIONS order', () => {
    const groups = visibleVtControls(strokeCfg()).map((c) => c.group)
    const order = groups.map((g) => VT_SECTIONS.indexOf(g as any))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('returns only members of VT_CONTROLS', () => {
    const all = new Set(VT_CONTROLS.map((c) => c.key))
    for (const c of visibleVtControls(strokeCfg())) expect(all.has(c.key), c.key).toBe(true)
  })
})

describe('derivedAxisControls — declare the frame, derive the contents', () => {
  it('derives one slider per axis of a REAL parsed variable font', () => {
    const axes = fixtureAxes()
    const derived = derivedAxisControls(axes)
    expect(derived.map((c) => c.key)).toEqual(axes.map((a) => `axes.${a.tag}`))
    expect(derived.map((c) => c.key)).toContain('axes.wght')
    for (const c of derived) {
      expect(c.kind).toBe('slider')
      expect(c.group).toBe(VT_AXES_GROUP)
    }
  })

  it('takes range and default from the font, not from a hand-written list', () => {
    const [wght] = derivedAxisControls([RICH_AXES[0]!]) as any[]
    expect(wght.min).toBe(100)
    expect(wght.max).toBe(1000)
    expect(wght.default).toBe(400)
    expect(wght.label).toBe('Weight')
  })

  it('derived keys resolve against the config once the axis is set', () => {
    const c = cfg({ axes: { wght: 700, XOPQ: 120 } })
    const params = paramsFor(c)
    for (const spec of derivedAxisControls(RICH_AXES)) {
      const set = spec.key === 'axes.wght' || spec.key === 'axes.XOPQ'
      expect(params[spec.key] !== undefined, spec.key).toBe(set)
    }
    expect(params['axes.wght']).toBe(700)
  })

  it('writing a derived key lands on the real axes record', () => {
    // The failure this guards is the one shader fills paid for: a key one segment
    // off the real path writes to a phantom object and never reaches the renderer.
    const c = cfg()
    const params = paramsFor(c)
    params['axes.GRAD'] = -80
    expect(c.axes.GRAD).toBe(-80)
    expect((c as any).axes.axes).toBeUndefined()
  })

  it('gives sub-unit axes a fine step and wide axes a whole one', () => {
    const [casl] = derivedAxisControls([{ tag: 'CASL', name: 'Casual', min: 0, max: 1, default: 0 }]) as any[]
    const [wght] = derivedAxisControls([RICH_AXES[0]!]) as any[]
    expect(casl.step).toBe(0.01)
    expect(wght.step).toBe(1)
  })

  it('every derived slider is a laid-out slider: max > min, default inside', () => {
    for (const c of derivedAxisControls([...RICH_AXES, ...fixtureAxes()]) as any[]) {
      expect(c.max, c.key).toBeGreaterThan(c.min)
      expect(c.default, c.key).toBeGreaterThanOrEqual(c.min)
      expect(c.default, c.key).toBeLessThanOrEqual(c.max)
    }
  })

  it('drops a zero-width axis rather than emitting an undraggable slider', () => {
    expect(derivedAxisControls([{ tag: 'DEAD', name: 'Dead', min: 5, max: 5, default: 5 }])).toEqual([])
  })

  it('is empty for a font that has not loaded yet', () => {
    expect(derivedAxisControls([])).toEqual([])
    expect(derivedAxisControls(undefined as any)).toEqual([])
  })

  it('leaves axis sliders animatable — the headline of the studio', () => {
    for (const c of derivedAxisControls(RICH_AXES)) {
      expect((c as any).animatable, c.key).not.toBe(false)
    }
  })
})

describe('the axis-tag rule cannot drift from the font layer', () => {
  it('config.isAxisTag agrees with font.isValidAxisTag', () => {
    // config.ts keeps its own copy so it never drags fontkit into the Collection
    // resolver; this is what stops the copy from diverging.
    const samples: unknown[] = [
      'wght', 'XOPQ', 'ital', 'a b ', 'abc', 'abcde', '', '  ', 'wghté', 'wg\nt',
      null, undefined, 42, {}, ['wght'],
    ]
    for (const s of samples) expect(isAxisTag(s), String(s)).toBe(isValidAxisTag(s))
  })
})

describe('mergeConfig is a strict rebuild', () => {
  it('returns the defaults for nothing at all', () => {
    for (const junk of [null, undefined, {}, [], 'nope', 42, true, NaN]) {
      expect(mergeConfig(junk), String(junk)).toEqual(DEFAULT_CONFIG)
    }
  })

  it('round-trips its own default and is idempotent', () => {
    expect(mergeConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG)
    const once = mergeConfig({ fontId: 'roboto-flex', axes: { wght: 900 }, strokeWidth: 3, motion: { tracks: [{ path: 'axes.wght', from: 100, to: 900, easing: 'pingpong', loops: 2, hold: 0.1, cycleOffset: 0.25, delay: 0.5 }] } })
    expect(mergeConfig(once)).toEqual(once)
  })

  it('replaces a wrong-typed field with the default, field by field', () => {
    const c = mergeConfig({
      text: 12, fontId: {}, axes: 'wght', size: 'big', tracking: null,
      align: 'diagonal', fill: [], stroke: 7, strokeWidth: 'thick', motion: 'later',
    })
    expect(c).toEqual(DEFAULT_CONFIG)
  })

  it('rejects NaN and Infinity on every numeric field', () => {
    const c = mergeConfig({ size: NaN, tracking: Infinity, strokeWidth: -Infinity })
    expect(c.size).toBe(DEFAULT_CONFIG.size)
    expect(c.tracking).toBe(DEFAULT_CONFIG.tracking)
    expect(vtBaseAppearance(c).strokeWidth).toBe(0)
  })

  it('falls back to the default font for an id the catalog does not have', () => {
    expect(mergeConfig({ fontId: 'helvetica-neue' }).fontId).toBe(DEFAULT_CONFIG.fontId)
    expect(mergeConfig({ fontId: 'roboto-flex' }).fontId).toBe('roboto-flex')
  })

  it('accepts every align the schema offers', () => {
    for (const a of VT_ALIGNS) expect(mergeConfig({ align: a }).align).toBe(a)
  })

  it('keeps the text verbatim, however long', () => {
    // Truncating here would silently rewrite a saved project; bounding the INPUT
    // is the surface's job.
    const long = 'A'.repeat(500)
    expect(mergeConfig({ text: long }).text).toBe(long)
    expect(mergeConfig({ text: '' }).text).toBe('')
  })

  describe('axes', () => {
    it('keeps four-char tags with finite numeric values', () => {
      expect(mergeConfig({ axes: { wght: 650, XOPQ: 96.5, GRAD: -80 } }).axes)
        .toEqual({ wght: 650, XOPQ: 96.5, GRAD: -80 })
    })

    it('drops malformed tags and non-numeric values', () => {
      expect(mergeConfig({
        axes: { weight: 700, wg: 1, wght: '700', opsz: NaN, slnt: null, ital: {}, wdth: 100 },
      }).axes).toEqual({ wdth: 100 })
    })

    it('KEEPS a tag the current font does not declare', () => {
      // Deliberate: the config layer does not know which font is loaded, and
      // switching font away and back must not discard the values you set.
      // clampCoords drops unknown tags at render time instead.
      expect(mergeConfig({ fontId: 'inter', axes: { CASL: 1 } }).axes).toEqual({ CASL: 1 })
    })

    it('survives an axes value that is not an object', () => {
      for (const junk of [null, [1, 2], 'wght=700', 5]) {
        expect(mergeConfig({ axes: junk }).axes, String(junk)).toEqual({})
      }
    })
  })

  describe('motion', () => {
    it('drops a track that targets nothing', () => {
      const c = mergeConfig({ motion: { tracks: [{ from: 0, to: 1 }, { path: '  ' }, null, 'track', { path: 'size', from: 10, to: 200 }] } })
      expect(allTracks(c).map((t) => t.path)).toEqual(['size'])
    })

    it('rebuilds a track field by field', () => {
      // GONE from a bare track: `easing`/`loops` — the OWNING MOVE this legacy
      // single track converts into carries them now (`~/lib/studio/moves/merge`'s
      // `legacyTrackEasePlay`: an unrecognised easing string, 'wobble', and
      // loops: 0 both fall to its default, `none`/`once ×1`).
      const c = mergeConfig({ motion: { tracks: [{ path: 'axes.wght', from: '100', to: 900, easing: 'wobble', loops: 0, hold: 9, cycleOffset: -3, delay: -5 }] } })
      const moves = c.motion.moves.filter(m => m.kind === 'tracks')
      expect(moves).toHaveLength(1)
      expect(moves[0]!.ease).toEqual({ kind: 'named', name: 'none' })
      expect(moves[0]!.play).toEqual({ mode: 'once', times: 1 })
      const [t] = allTracks(c)
      expect(t).toEqual({ path: 'axes.wght', from: 0, to: 900, hold: 0.5, cycleOffset: 0, delay: 0 })
    })

    it('keeps a well-formed track exactly', () => {
      // `easing: 'pingpong'`/`loops: 3` maps onto the owning move's `ease`/
      // `play` (`none`/`backAndForth ×3`) rather than the track, which keeps
      // only its own timing fields (`from`/`to`/`hold`/`cycleOffset`/`delay`).
      const rawTrack = { path: 'axes.GRAD', from: -200, to: 150, easing: 'pingpong' as const, loops: 3, hold: 0.2, cycleOffset: 0.5, delay: 1 }
      const c = mergeConfig({ motion: { tracks: [rawTrack] } })
      const moves = c.motion.moves.filter(m => m.kind === 'tracks')
      expect(moves).toHaveLength(1)
      expect(moves[0]!.ease).toEqual({ kind: 'named', name: 'none' })
      expect(moves[0]!.play).toEqual({ mode: 'backAndForth', times: 3 })
      expect(allTracks(c)).toEqual([{ path: 'axes.GRAD', from: -200, to: 150, hold: 0.2, cycleOffset: 0.5, delay: 1 }])
    })

    it('clamps the clip settings to what the exporter can do', () => {
      const m = mergeConfig({ motion: { duration: 0, fps: 500, size: 4321 } }).motion
      expect(m.duration).toBe(0.1)
      expect(m.fps).toBe(60)
      expect(m.size).toBe(1080)
      expect(mergeConfig({ motion: { size: 2160 } }).motion.size).toBe(2160)
    })

    it('survives a tracks value that is not an array', () => {
      expect(allTracks(mergeConfig({ motion: { tracks: { 0: { path: 'size' } } } }))).toEqual([])
    })
  })

  /**
   * TRAP 5 — the one that can destroy user work.
   *
   * Every Vector Type node saved before the fill vocabulary landed holds
   * `fill: '#ffffff'`, a bare string. `Paint` still ACCEPTS a string, so nothing
   * throws and nothing looks obviously wrong — what breaks is every dotted
   * control key (`fill.type`, `fill.a`, …), which resolves against a string and
   * silently addresses nothing. The lift is what stops that, and these are the
   * tests that stop the lift from being quietly removed.
   */
  describe('a legacy string fill is LIFTED, not lost (trap 5)', () => {
    it('lifts `#rrggbb` to a solid Fill carrying that colour', () => {
      const c = mergeConfig({ fill: '#ff8800' })
      expect(vtBaseAppearance(c).fill).toEqual({ ...DEFAULT_FILL, a: '#ff8800' })
    })

    it('a legacy config still RENDERS its colour, through the one renderer', () => {
      // The failure mode is a saved node rendering black, and it does not throw.
      // So this asserts the value the canvas/SVG paint path actually reads —
      // `paintPrimaryColor`, the bridge `drawVectorType` and `vectorTypeSVG`
      // both collapse through — rather than just the stored shape.
      const legacy = { text: 'Saved', fontId: 'inter', size: 120, fill: '#22cc55' }
      expect(paintPrimaryColor(vtBaseAppearance(mergeConfig(legacy)).fill, '#000000')).toBe('#22cc55')
      // …and the deliberately-broken control: WITHOUT the lift the same blob
      // would have taken this branch, which is indistinguishable from a colour
      // that happens to be right. The colour must survive the merge, not the
      // fallback.
      expect(paintPrimaryColor(undefined, '#000000')).toBe('#000000')
    })

    it('lifts every colour form a stored config could hold', () => {
      for (const hex of ['#fff', '#ffffff', '#ffffffcc', 'red', 'rgb(1,2,3)']) {
        expect((vtBaseAppearance(mergeConfig({ fill: hex })).fill as any).a, hex).toBe(hex)
      }
    })

    it('every dotted layer control key resolves on a LIFTED legacy config', () => {
      // The concrete consequence: before the lift these all addressed nothing.
      const params = paramsFor(mergeConfig({ fill: '#123456' }))
      for (const key of ['layer.paint.type', 'layer.paint.a', 'layer.paint.b',
        'layer.paint.angle', 'layer.paint.density', 'layer.anchor', 'layer.width']) {
        expect(params[key], key).toBeDefined()
      }
      expect(params['layer.paint.a']).toBe('#123456')
    })

    it('is idempotent — a lifted config re-merges to itself', () => {
      const once = mergeConfig({ fill: '#abcdef' })
      expect(mergeConfig(once)).toEqual(once)
    })
  })

  describe('mergeFill survives hostile paint blobs', () => {
    it('falls back to the default fill for junk of every shape', () => {
      for (const junk of [null, undefined, [], 42, true, NaN, { type: 'plaid' }, { stops: [] }]) {
        expect(vtBaseAppearance(mergeConfig({ fill: junk })).fill, String(junk)).toEqual(DEFAULT_FILL)
      }
    })

    it('keeps a Gradient as a Gradient — collapsing it would be data loss', () => {
      // Multi-stop and radial are `Paint`-only; `Fill` cannot express them.
      const g = { type: 'radial', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }
      expect(vtBaseAppearance(mergeConfig({ fill: g })).fill).toEqual(g)
      const lin = vtBaseAppearance(mergeConfig({ fill: { type: 'linear', angle: 90, stops: [{ offset: 0.5, color: '#ff0000' }] } })).fill
      expect(lin).toEqual({ type: 'linear', angle: 90, stops: [{ offset: 0.5, color: '#ff0000' }] })
    })

    it('enforces the DEPTH-1 shader guard rather than re-implementing it', () => {
      // A shader inside a shader hangs the renderer. `mergeFill` reuses
      // `normalizePaint`, whose own guard collapses the inner one to a gradient
      // — no second copy of the rule to fall out of sync.
      const nested = {
        type: 'shader',
        a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 45, density: 8,
        shader: {
          effectId: 'fbm_warp', params: {}, anchor: 'object', speed: 1,
          input: { type: 'shader', a: '#ff0000', b: '#00ff00', textColor: '#ffffff', angle: 0, density: 4, shader: {} },
        },
      }
      const out = vtBaseAppearance(mergeConfig({ fill: nested })).fill as any
      expect(out.type).toBe('shader')
      expect(out.shader.input.type).toBe('gradient')
      expect(out.shader.input.shader).toBeUndefined()
    })

    it('repairs a non-finite angle / density', () => {
      // Every other numeric field in this schema rejects NaN/Infinity (`num`),
      // because a non-finite number does not fall back at the renderer — it
      // propagates through the tile maths and paints nothing.
      const f = vtBaseAppearance(mergeConfig({ fill: { ...DEFAULT_FILL, angle: NaN, density: Infinity } })).fill as any
      expect(f.angle).toBe(DEFAULT_FILL.angle)
      expect(f.density).toBe(DEFAULT_FILL.density)
      // …inside a shader's input too, which is the one place it can nest.
      const s = vtBaseAppearance(mergeConfig({
        fill: {
          ...DEFAULT_FILL, type: 'shader',
          shader: { effectId: 'fbm_warp', params: {}, anchor: 'object', speed: 1, input: { ...DEFAULT_FILL, density: NaN } },
        },
      })).fill as any
      expect(s.shader.input.density).toBe(DEFAULT_FILL.density)
    })
  })

  describe('the anchor — now PER LAYER', () => {
    it('accepts every anchor the schema offers and rejects anything else', () => {
      for (const a of VT_FILL_ANCHORS) {
        expect(vtBaseAppearance(mergeConfig({ fillAnchor: a })).fillAnchor).toBe(a)
      }
      for (const junk of ['object', '', null, 3, {}]) {
        expect(vtBaseAppearance(mergeConfig({ fillAnchor: junk })).fillAnchor, String(junk)).toBe('glyph')
      }
    })

    it('is declared at layer.anchor, and declared NOT animatable', () => {
      const spec = VT_CONTROLS.find((c) => c.key === 'layer.anchor')!
      expect(spec.kind).toBe('select')
      expect((spec as any).options).toEqual([...VT_FILL_ANCHORS])
      expect((spec as any).animatable).toBe(false)
      // And it is genuinely unreachable from the timeline, not merely labelled.
      expect(animatableTargets(cfg()).map((t) => t.path)).not.toContain('appearance.0.anchor')
    })

    it('each layer keeps its OWN anchor', () => {
      const c = cfg({ appearance: [vtLayer({ id: 'La', anchor: 'word' }), vtLayer({ id: 'Lb', anchor: 'frame' })] })
      expect(c.appearance.map((l) => l.anchor)).toEqual(['word', 'frame'])
    })
  })

  it('cloneConfig shares nothing mutable with its source', () => {
    const trackMove: VtMove = {
      id: 'move-t1', phase: 'loop', kind: 'tracks', presetId: 'custom', duration: 4,
      ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 },
      tracks: [{ path: 'size', from: 1, to: 2, hold: 0, cycleOffset: 0, delay: 0 }],
    }
    const a = cfg({ axes: { wght: 700 }, motion: { ...DEFAULT_CONFIG.motion, moves: [trackMove] } })
    const b = cloneConfig(a)
    b.axes.wght = 100
    b.motion.moves[0]!.tracks![0]!.to = 99
    b.appearance[0]!.width = 99
    ;(b.appearance[0]!.paint as any).a = '#123123'
    expect(a.axes.wght).toBe(700)
    expect(a.motion.moves[0]!.tracks![0]!.to).toBe(2)
    expect(a.appearance[0]!.width).toBe(VT_DEFAULT_STROKE_WIDTH)
    expect((a.appearance[0]!.paint as any).a).toBe(DEFAULT_FILL.a)
    // …and the module-level default is untouched, which is the bug the previous
    // task on this file shipped and then fixed (`clonePaint` existed and was
    // never called, so every config built from DEFAULT_CONFIG shared one fill).
    expect((DEFAULT_CONFIG.appearance[0]!.paint as any).a).toBe(DEFAULT_FILL.a)
    expect(DEFAULT_CONFIG.appearance[0]!.width).toBe(VT_DEFAULT_STROKE_WIDTH)
  })
})

/**
 * TRAP 4 — the migration, and the reason this is the most important block here.
 *
 * EVERY saved Vector Type node holds the flat `fill` / `fillAnchor` / `stroke` /
 * `strokeWidth`. And `mergeConfig` is NOT on the universal load path: the node
 * card, the bake and the frame source read the stored blob. A saved node that
 * renders wrong is the failure mode, and it does not throw.
 */
describe('the appearance stack — the model, and the legacy migration (trap 4)', () => {
  describe('migration from a pre-stack config', () => {
    it('turns a legacy fill + fillAnchor into ONE fill layer', () => {
      const c = legacyCfg({ fill: '#22cc55', fillAnchor: 'word' })
      expect(c.appearance).toHaveLength(1)
      const [l] = c.appearance
      expect(l!.kind).toBe('fill')
      expect(l!.anchor).toBe('word')
      expect(l!.paint).toEqual({ ...DEFAULT_FILL, a: '#22cc55' })
      // …and it still RENDERS that colour, through the bridge the canvas reads.
      expect(paintPrimaryColor(vtBaseAppearance(c).fill, '#000000')).toBe('#22cc55')
    })

    it('turns a strokeWidth > 0 stroke into a stroke layer ABOVE the fill', () => {
      const c = legacyCfg({ fill: '#ffffff', stroke: '#ff0055', strokeWidth: 6 })
      expect(c.appearance.map((l) => l.kind)).toEqual(['fill', 'stroke'])
      // ABOVE = later in the array = painted in front, reproducing the old fixed
      // order (the single stroke was unconditionally drawn after the single fill).
      const stroke = c.appearance[1]!
      expect(stroke.width).toBe(6)
      expect(stroke.paint).toEqual({ ...DEFAULT_FILL, a: '#ff0055' })
      const base = vtBaseAppearance(c)
      expect(base.strokeWidth).toBe(6)
      expect(paintPrimaryColor(base.stroke, '#000000')).toBe('#ff0055')
    })

    it('does NOT create a stroke layer for strokeWidth === 0', () => {
      // That stroke was never visible — it is the DEFAULT, and it is the whole
      // reason users concluded this studio had no stroke. Materialising it would
      // put a dead layer in every migrated node.
      for (const w of [0, undefined, -4, 'thick', null, NaN]) {
        const c = legacyCfg({ fill: '#ffffff', stroke: '#ff0055', strokeWidth: w })
        expect(c.appearance.map((l) => l.kind), String(w)).toEqual(['fill'])
        expect(vtBaseAppearance(c).strokeWidth, String(w)).toBe(0)
      }
    })

    it('keeps a zero-width stroke ONLY when a motion track animates it', () => {
      // The one exception, and it exists so the migration cannot destroy work: a
      // stroke that was invisible at rest but animated to 10px was visible.
      const animated = legacyCfg({
        stroke: '#ff0055', strokeWidth: 0,
        motion: { tracks: [{ path: 'strokeWidth', from: 0, to: 10 }] },
      })
      expect(animated.appearance.map((l) => l.kind)).toEqual(['fill', 'stroke'])
      // …and the TRACK follows it, or the animation is still lost. It is written
      // POSITIONALLY by `remapLegacyTrackPath` and then lifted onto the layer's
      // id by `migrateStackTrackPaths`/`migrateMoveTrackPaths`, in the same
      // `mergeConfig` pass — so what comes out of a load is the id form,
      // whatever vintage went in (and now lives inside the converted move's
      // own `tracks` array — see `allTracks`).
      expect(allTracks(animated).map((t) => t.path)).toEqual([`appearance.${VT_BASE_STROKE_ID}.width`])
      // A track that animates 0 → 0 is not an exception; it is still invisible.
      const flat = legacyCfg({ strokeWidth: 0, motion: { tracks: [{ path: 'strokeWidth', from: 0, to: 0 }] } })
      expect(flat.appearance.map((l) => l.kind)).toEqual(['fill'])
      expect(allTracks(flat)).toEqual([])
    })

    it('remaps legacy fill.* motion tracks onto the migrated layer', () => {
      const c = legacyCfg({
        fill: { ...DEFAULT_FILL, type: 'gradient' },
        motion: { tracks: [
          { path: 'fill.angle', from: 0, to: 360 },
          { path: 'axes.wght', from: 100, to: 900 },
          { path: 'fillAnchor', from: 0, to: 1 },
        ] },
      })
      // Id-addressed on the way out — see the note above. `axes.wght` is NOT a
      // member path and is left exactly as written.
      expect(allTracks(c).map((t) => t.path)).toEqual([`appearance.${VT_BASE_FILL_ID}.paint.angle`, 'axes.wght'])
      // The remapped track ANIMATES — a path that merely looks right proves
      // nothing, since `applyMotion` skips a path whose parent is missing.
      const at = applyMotion(c, 2)
      expect((at.appearance[0]!.paint as any).angle).toBeCloseTo(180, 6)
    })

    it('does not re-migrate a config that already has a stack', () => {
      // An EMPTY stack is the user having removed every layer, and it must not
      // be quietly refilled from stale flat fields.
      const c = mergeConfig({ appearance: [], fill: '#ff0000', strokeWidth: 9 })
      expect(c.appearance).toEqual([])
      expect(vtBaseAppearance(c).fill).toBeUndefined()
      expect(vtBaseAppearance(c).strokeWidth).toBe(0)
      // …and a config with a real stack ignores the flat fields entirely.
      const d = mergeConfig({ appearance: [vtLayer({ id: 'Lx', paint: '#00ff00' })], fill: '#ff0000' })
      expect(paintPrimaryColor(vtBaseAppearance(d).fill, '#000000')).toBe('#00ff00')
    })

    it('is idempotent — a migrated config re-merges to itself', () => {
      const once = legacyCfg({ fill: '#abcdef', stroke: '#123456', strokeWidth: 4 })
      expect(mergeConfig(once)).toEqual(once)
      expect(mergeConfig(mergeConfig(once))).toEqual(once)
    })
  })

  describe('the id scheme', () => {
    it('mints ids that can never be read as an array index', () => {
      // `lib/studio/path.ts`'s `isIndex` is /^\d+$/, so an all-digits id in
      // `appearance.<id>.width` resolves to a POSITION — a real but wrong layer.
      for (const id of [VT_BASE_FILL_ID, VT_BASE_STROKE_ID, vtLayerId(), vtLayerId(), vtLayer().id]) {
        expect(id, id).not.toMatch(/^\d+$/)
        expect(id, id).not.toContain('.')
        expect(id.length, id).toBeGreaterThan(0)
      }
      expect(vtLayerId()).not.toBe(vtLayerId())
    })

    it('gives a migrated config DETERMINISTIC ids across loads', () => {
      // A migration that minted a fresh id every load would defeat the whole
      // point: a binding written against the layer would stop resolving.
      const blob = { fill: '#22cc55', stroke: '#ff0055', strokeWidth: 2 }
      const a = mergeConfig(blob).appearance.map((l) => l.id)
      const b = mergeConfig(blob).appearance.map((l) => l.id)
      expect(a).toEqual(b)
      expect(a).toEqual([VT_BASE_FILL_ID, VT_BASE_STROKE_ID])
    })

    it('REJECTS a stored id that is all digits, or carries a dot', () => {
      const c = mergeConfig({ appearance: [
        { kind: 'fill', id: '3' },
        { kind: 'fill', id: 'a.b' },
        { kind: 'fill', id: '  ' },
      ] })
      for (const l of c.appearance) {
        expect(l.id).not.toMatch(/^\d+$/)
        expect(l.id).not.toContain('.')
      }
      expect(new Set(c.appearance.map((l) => l.id)).size).toBe(3)
    })

    it('re-mints a DUPLICATE id rather than leaving two layers addressable as one', () => {
      // `resolveIdPath` resolves a duplicate to the LOWEST index, so leaving both
      // would make one binding silently address two layers.
      const c = mergeConfig({ appearance: [
        { kind: 'fill', id: 'Lsame' }, { kind: 'stroke', id: 'Lsame' },
      ] })
      expect(c.appearance[0]!.id).toBe('Lsame')
      expect(c.appearance[1]!.id).not.toBe('Lsame')
    })

    it('never lets a minted fallback steal an id a LATER layer holds', () => {
      // Two passes, and this is why: layer 0 has no id and would naively be given
      // `L0` — which layer 1 already legibly owns. Renaming layer 1 on load would
      // break every binding against it.
      const c = mergeConfig({ appearance: [{ kind: 'fill' }, { kind: 'stroke', id: 'L0' }] })
      expect(c.appearance[1]!.id).toBe('L0')
      expect(c.appearance[0]!.id).not.toBe('L0')
      expect(new Set(c.appearance.map((l) => l.id)).size).toBe(2)
    })

    it('keeps a stored id stable across a re-merge', () => {
      const c = mergeConfig({ appearance: [{ kind: 'fill' }, { kind: 'stroke' }] })
      expect(mergeConfig(c).appearance.map((l) => l.id)).toEqual(c.appearance.map((l) => l.id))
    })
  })

  describe('mergeAppearance is a strict rebuild', () => {
    it('rebuilds a layer field by field, defaulting anything wrong-typed', () => {
      const [l] = mergeConfig({ appearance: [{
        id: 'Lx', kind: 'sparkle', enabled: 'yes', anchor: 'object', opacity: 9,
        blend: 'divide', width: -3, depth: 1e6, angle: NaN, distance: 'far',
        // `strokeColor` (the solid extrude's silhouette colour) is rebuilt like
        // every other field: a non-string falls back to the default.
        taper: 40, solid: 1, strokeColor: 0xff0000, nope: true,
        // The DRAW-ON progress, clamped like every other 0..1 leaf. Out of range
        // here, so this also pins that a broken value lands on FULLY DRAWN and
        // not on invisible.
        draw: 12,
      }] }).appearance
      expect(l).toEqual({
        id: 'Lx', kind: 'fill', enabled: true, paint: { ...DEFAULT_FILL },
        anchor: 'glyph', opacity: 1, blend: 'normal', width: 0, depth: 32,
        angle: 135, distance: 3, taper: 1, solid: false, strokeColor: '#000000',
        draw: 1,
      })
      expect((l as any).nope).toBeUndefined()
    })

    it('keeps every kind the schema declares', () => {
      const c = mergeConfig({ appearance: [{ kind: 'fill' }, { kind: 'stroke' }, { kind: 'extrude' }] })
      expect(c.appearance.map((l) => l.kind)).toEqual(['fill', 'stroke', 'extrude'])
    })

    it('lifts a layer whose paint is a bare colour string', () => {
      const [l] = mergeConfig({ appearance: [{ kind: 'stroke', paint: '#ff0055' }] }).appearance
      expect(l!.paint).toEqual({ ...DEFAULT_FILL, a: '#ff0055' })
    })

    it('drops entries that are not layers, and bounds the stack at VT_LAYER_MAX', () => {
      const c = mergeConfig({ appearance: [null, 'fill', 42, { kind: 'fill' }, []] })
      expect(c.appearance).toHaveLength(1)
      const many = mergeConfig({ appearance: Array.from({ length: 20 }, () => ({ kind: 'fill' })) })
      expect(many.appearance).toHaveLength(VT_LAYER_MAX)
    })

    it('survives an appearance value that is not an array by MIGRATING instead', () => {
      for (const junk of [null, 'stack', 42, { 0: { kind: 'fill' } }]) {
        const c = mergeConfig({ appearance: junk, fill: '#ff0000' })
        expect(c.appearance.map((l) => l.kind), String(junk)).toEqual(['fill'])
        expect(paintPrimaryColor(vtBaseAppearance(c).fill, '#000000'), String(junk)).toBe('#ff0000')
      }
    })

    it('backfills every kind-specific field on every layer', () => {
      // The whole reason they are required rather than optional: `setByPath` and
      // `makeConfigParams` guard on the PARENT, and a control must never address
      // a leaf that is not there.
      const c = mergeConfig({ appearance: [{ kind: 'fill' }] })
      for (const k of ['width', 'depth', 'angle', 'distance', 'taper', 'solid', 'opacity', 'blend', 'anchor', 'enabled']) {
        expect((c.appearance[0] as any)[k], k).toBeDefined()
      }
    })

    it('honours a stored enabled: false', () => {
      const c = mergeConfig({ appearance: [{ kind: 'fill', enabled: false }, { kind: 'fill', paint: '#00ff00' }] })
      expect(c.appearance[0]!.enabled).toBe(false)
      // …and the bridge skips it, so a hidden base layer does not paint.
      expect(paintPrimaryColor(vtBaseAppearance(c).fill, '#000000')).toBe('#00ff00')
    })
  })

  describe('vtBaseAppearance — the Task 3 bridge', () => {
    it('reads a RAW pre-stack blob that never went through mergeConfig', () => {
      // `ensureConfigDefaults` is not on the universal load path, and neither is
      // `mergeConfig`: the node card, the bake and the frame source can hand the
      // renderer a stored blob directly.
      const raw = { text: 'Saved', fill: '#22cc55', fillAnchor: 'frame', stroke: '#ff0055', strokeWidth: 4 } as any
      const base = vtBaseAppearance(raw)
      expect(base.fill).toBe('#22cc55')
      expect(base.fillAnchor).toBe('frame')
      expect(base.strokeWidth).toBe(4)
      expect(base.stroke).toBe('#ff0055')
      // A raw blob whose stroke had no width still has no stroke.
      expect(vtBaseAppearance({ stroke: '#ff0055', strokeWidth: 0 } as any).stroke).toBeUndefined()
    })

    it('returns the layer paint BY REFERENCE, so a control write lands on the layer', () => {
      const c = cfg()
      const params = paramsFor(c)
      params['layer.paint.a'] = '#010203'
      expect((vtBaseAppearance(c).fill as any).a).toBe('#010203')
      expect(vtBaseAppearance(c).fill).toBe(c.appearance[0]!.paint)
    })

    it('survives null, undefined and an empty stack', () => {
      for (const junk of [null, undefined, {} as any, { appearance: [] } as any]) {
        const base = vtBaseAppearance(junk)
        expect(base.fill, String(junk)).toBeUndefined()
        expect(base.fillAnchor, String(junk)).toBe('glyph')
        expect(base.strokeWidth, String(junk)).toBe(0)
      }
    })
  })
})

describe('vtAgentControls', () => {
  it('emits plain ControlSpecs with no schema-only fields leaking', () => {
    for (const c of vtAgentControls(strokeCfg(), RICH_AXES)) {
      expect(c, c.key).not.toHaveProperty('when')
      expect(c, c.key).not.toHaveProperty('agent')
      expect(c, c.key).not.toHaveProperty('animatable')
    }
  })

  it('tracks the visibility predicate', () => {
    expect(vtAgentControls(cfg()).map((c) => c.key)).not.toContain('layer.width')
    expect(vtAgentControls(strokeCfg()).map((c) => c.key)).toContain('layer.width')
  })

  it('grows the vocabulary with the loaded font, and shrinks back without one', () => {
    const withFont = vtAgentControls(cfg(), RICH_AXES).map((c) => c.key)
    const without = vtAgentControls(cfg()).map((c) => c.key)
    expect(withFont).toContain('axes.XOPQ')
    expect(without.some((k) => k.startsWith('axes.'))).toBe(false)
    expect(withFont.length).toBe(without.length + RICH_AXES.length)
  })

  it('every emitted key resolves once its value is set', () => {
    const c = cfg({ appearance: strokeCfg().appearance, axes: Object.fromEntries(RICH_AXES.map((a) => [a.tag, a.default])) })
    const params = paramsFor(c)
    const unresolved = vtAgentControls(c, RICH_AXES).map((s) => s.key).filter((k) => params[k] === undefined)
    expect(unresolved).toEqual([])
  })

  it('is a characterization snapshot, with and without a font loaded', () => {
    expect(vtAgentControls(cfg())).toMatchSnapshot()
    expect(vtAgentControls(strokeCfg(), RICH_AXES)).toMatchSnapshot()
  })
})

/**
 * SHADER FILLS in the agent's vocabulary.
 *
 * `VT_CONTROLS` declares no `layer.paint.shader.*` key at all — the shader vocabulary is
 * shared across four host studios and lives in `~/lib/shaderfill/controls.ts`. So
 * `visibleVtControls`, which can only return members of `VT_CONTROLS`, can never
 * produce one, and `vtAgentControls` needs an explicit branch. These tests pin
 * that the branch exists, that it fires only when it should, and — the one that
 * matters — that every key it emits addresses REAL storage.
 */
describe('shader fills enter the agent vocabulary', () => {
  /** A config whose fill is a shader over the mocked catalog effect. Every param
   *  the effect declares is SET, because `makeConfigParams` is sparse: an unwritten
   *  leaf reads `undefined`, so an unset param would make the resolution probe
   *  below pass or fail for the wrong reason. */
  const shaderCfg = (over: Record<string, unknown> = {}) => paintCfg({
    ...DEFAULT_FILL,
    type: 'shader',
    shader: {
      effectId: 'kaleidoscope',
      params: { segments: 14, zoom: 2.5, mode: 1 },
      anchor: 'frame',
      speed: 1.5,
      input: { ...DEFAULT_FILL, type: 'gradient' },
      ...over,
    },
  })

  const keysOf = (c: VectorTypeConfig) => vtAgentControls(c).map((s) => s.key)

  it('offers the four frozen shader keys only when the fill type is shader', () => {
    // Measured before the branch was written: a shader-typed config emitted
    // `text, fontId, size, tracking, align, fill.type, fill.a, fill.b, fillAnchor,
    // strokeWidth, motion.stagger.*` and not one `layer.paint.shader` key. Nothing derives
    // them; Shape Studio needed the same explicit branch.
    const frozen = VT_SHADER_CONTROLS.map((c) => c.key)
    expect(frozen).toEqual(['layer.paint.shader.effectId', 'layer.paint.shader.anchor', 'layer.paint.shader.speed', 'layer.paint.shader.seed'])
    for (const k of frozen) expect(keysOf(shaderCfg()), k).toContain(k)
    for (const k of frozen) expect(keysOf(cfg()), k).not.toContain(k)
    expect(keysOf(paintCfg({ ...DEFAULT_FILL, type: 'stripes' })).some((k) => k.startsWith('layer.paint.shader'))).toBe(false)
  })

  it('strips the schema-only fields off the shared shader controls too', () => {
    // `layer.paint.shader.anchor` carries `animatable: false`; leaking it into the agent's
    // ControlSpec[] would put a schema field in the model's prompt.
    for (const c of vtAgentControls(shaderCfg())) {
      expect(c, c.key).not.toHaveProperty('animatable')
      expect(c, c.key).not.toHaveProperty('when')
      expect(c, c.key).not.toHaveProperty('agent')
    }
  })

  it("derives the active effect's own params at the real ShaderSpec.params path", () => {
    const derived = keysOf(shaderCfg()).filter((k) => k.startsWith('layer.paint.shader.params.'))
    expect(derived).toEqual([
      'layer.paint.shader.params.segments',
      'layer.paint.shader.params.zoom',
      'layer.paint.shader.params.mode',
    ])
    // …and it is genuinely `derivedShaderFillControls`'s output, prefix and all,
    // not a second hand-built list that happens to agree today.
    expect(vtAgentControls(shaderCfg()).slice(-3))
      .toEqual(derivedShaderFillControls(CATALOG_EFFECT, VT_LAYER_SHADER_PREFIX))
  })

  it('degrades to the frozen three when the catalog has not resolved that effect', () => {
    // `getEffectSync` never fetches: before any page has loaded the catalog it
    // returns null for every id. The frozen keys must still be offered.
    const k = keysOf(shaderCfg({ effectId: 'nothing-in-the-catalog' }))
    expect(k).toContain('layer.paint.shader.effectId')
    expect(k.some((x) => x.startsWith('layer.paint.shader.params.'))).toBe(false)
  })

  /**
   * THE ONE THAT MATTERS. `makeConfigParams` does naive dotted traversal with no
   * special cases, so a derived key one segment off the real path resolves to
   * `undefined` on read and creates a phantom object on write — which is exactly
   * what an earlier `<prefix>.p.<id>` namespace did in this codebase: it wrote to
   * `layer.paint.shader.p` next to the real `layer.paint.shader.params` and silently never
   * reached the renderer, with nothing thrown anywhere.
   */
  it('every derived shader param key RESOLVES against the real config', () => {
    const c = shaderCfg()
    const params = paramsFor(c)
    const derived = vtAgentControls(c).map((s) => s.key).filter((k) => k.startsWith('layer.paint.shader.'))
    const unresolved = derived.filter((k) => params[k] === undefined)
    expect(unresolved).toEqual([])
    // Not just "defined" — the ACTUAL stored numbers, so a key landing on some
    // other real leaf would still fail.
    expect(params['layer.paint.shader.params.segments']).toBe(14)
    expect(params['layer.paint.shader.params.zoom']).toBe(2.5)
    expect(params['layer.paint.shader.params.mode']).toBe(1)
    expect(params['layer.paint.shader.effectId']).toBe('kaleidoscope')
    expect(params['layer.paint.shader.anchor']).toBe('frame')
    expect(params['layer.paint.shader.speed']).toBe(1.5)
  })

  it('the probe is not vacuous: a key one segment off the real path resolves to nothing', () => {
    // The old `.p.` address, and a plausible near-miss, against the same config
    // that resolves every real key above. If this ever passes, the test above has
    // stopped proving anything.
    const params = paramsFor(shaderCfg())
    expect(params['layer.paint.shader.p.segments']).toBeUndefined()
    expect(params['layer.paint.shader.segments']).toBeUndefined()
    expect(params['fill.params.segments']).toBeUndefined()
  })

  it('WRITING a derived key lands on the real params bag, creating no phantom object', () => {
    const c = shaderCfg()
    const params = paramsFor(c)
    params['layer.paint.shader.params.segments'] = 3
    const shader = (c.appearance[0]!.paint as any).shader
    expect(shader.params.segments).toBe(3)
    expect(shader.p).toBeUndefined()
    // And the write is visible to the OTHER naive resolver too — `setByPath` /
    // `getByPath`, which motion and Collection bindings use.
    expect(paramsFor(c)['layer.paint.shader.params.segments']).toBe(3)
  })

  /**
   * The inert-`fill.a` decision, asserted rather than described.
   *
   * `effectiveTilePaint` unwraps a shader fill to `shader.input` and paints THAT,
   * so the outer Fill's `a`/`b` are read by nothing on the screen path. Offering
   * them to the agent means "make the fill red" writes a value that is stored,
   * survives the merge, and changes not one pixel — so they are withheld, by the
   * same `when` predicates that already withhold `stroke` and `fill.angle`.
   */
  it('withholds the inert layer.paint.a / .b on a shader fill, in the panel AND the agent', () => {
    const shader = shaderCfg()
    expect(visibleVtControls(shader).map((c) => c.key)).not.toContain('layer.paint.a')
    expect(visibleVtControls(shader).map((c) => c.key)).not.toContain('layer.paint.b')
    expect(keysOf(shader)).not.toContain('layer.paint.a')
    expect(keysOf(shader)).not.toContain('layer.paint.b')
    // `fill.angle` / `fill.density` were already withheld — `shader` is in neither
    // predicate's list — so the rule now reads as one rule.
    // `layer.opacity` / `layer.blend` ARE here, and belong here: unlike the
    // paint's own colours they compose the whole layer onto the stack whatever
    // it is painted with, so a shader fill reads them exactly like a solid one.
    expect(keysOf(shader).filter((k) => k.startsWith('layer.'))).toEqual([
      'layer.paint.type', 'layer.anchor', 'layer.opacity', 'layer.blend',
      'layer.paint.shader.effectId', 'layer.paint.shader.anchor', 'layer.paint.shader.speed', 'layer.paint.shader.seed',
      'layer.paint.shader.params.segments', 'layer.paint.shader.params.zoom', 'layer.paint.shader.params.mode',
    ])
  })

  it('is a characterization snapshot of the shader vocabulary', () => {
    // The two existing snapshots (above) are both SOLID fills, so neither moved
    // when this branch landed — the shader keys are `when`-gated and those
    // configs never reach them. This is the third one, so the shader vocabulary
    // is pinned rather than merely reachable.
    expect(vtAgentControls(shaderCfg())).toMatchSnapshot()
  })

  it('still offers layer.paint.a everywhere it PAINTS something', () => {
    // The withholding must be about the shader arm, not a blanket loss: every
    // other fill type reads `fill.a`, and a `Gradient` paint reads neither.
    for (const type of ['solid', 'gradient', 'ombre', 'grid', 'noise', 'checkerboard', 'stripes', 'qr']) {
      expect(keysOf(paintCfg({ ...DEFAULT_FILL, type })), type).toContain('layer.paint.a')
    }
    expect(keysOf(paintCfg({ ...DEFAULT_FILL, type: 'shader' }))).not.toContain('layer.paint.a')
  })
})

describe('VT_GUIDANCE', () => {
  /** Every key the prose names is backticked; this is the set. */
  const quoted = [...VT_GUIDANCE.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string)
  const staticKeys = new Set([...VT_CONTROLS, ...VT_SHADER_CONTROLS].map((c) => c.key))
  const isAxisKey = (t: string) => t.startsWith('axes.') && (t === 'axes.<tag>' || isAxisTag(t.slice(5)))
  /** The shader params are DERIVED per effect, so no fixed key exists to name.
   *  The prose may name the placeholder — and only the placeholder: a concrete
   *  `layer.paint.shader.params.segments` would be teaching the model a key that exists
   *  for some effects and not others. */
  const isShaderParamKey = (t: string) => t === 'layer.paint.shader.params.<param>'
  /**
   * The scatter's AXIS picker is derived from the loaded font for the same
   * reason the axis sliders are — there is no font-independent list of tags to
   * freeze — so it has no entry in `VT_CONTROLS`. Read off the deriving function
   * rather than restated as a literal, so a rename turns this red instead of
   * quietly waving an unknown key through.
   */
  const derivedKeys = new Set(
    derivedScatterControls(
      cfg({ motion: { ...cloneConfig(DEFAULT_CONFIG).motion, scatter: { ...DEFAULT_CONFIG.motion.scatter, spread: 0.5 } } }),
      RICH_AXES,
    ).map((c) => c.key),
  )
  const isDerivedKey = (t: string) => derivedKeys.has(t)
  /** The relative prefix itself, which the prose names when it explains that the
   *  paint controls address the ACTIVE layer. Allowed as the one non-key token,
   *  and asserted against the exported constant so it cannot drift. */
  const isLayerPrefix = (t: string) => t === VT_LAYER_PREFIX
  /**
   * The id-addressed stack form. The prose may name it as a TEMPLATE only —
   * `<layerId>` is minted per layer and a concrete `appearance.Lfill.width`
   * would teach the model an id that exists in one project and not the next.
   * The leaf must still be a real `layer.*` key, so an invented one is caught.
   */
  const isStackKey = (t: string) => {
    if (!t.startsWith(`${VT_STACK_PREFIX}<layerId>.`)) return false
    const leaf = t.slice(`${VT_STACK_PREFIX}<layerId>.`.length)
    return leaf === '<key>' || staticKeys.has(`${VT_LAYER_PREFIX}${leaf}`)
  }

  it('names only keys that exist in the schema', () => {
    expect(quoted.length).toBeGreaterThan(0)
    for (const t of quoted) {
      expect(staticKeys.has(t) || isAxisKey(t) || isDerivedKey(t) || isShaderParamKey(t) || isLayerPrefix(t) || isStackKey(t),
        `guidance names unknown key \`${t}\``).toBe(true)
    }
  })

  it('teaches the id-addressed stack form, and only as a template', () => {
    // The regression this closes: `layer.width` is `when`-gated to stroke layers
    // and the headless active layer is 0 — a fill on every migrated node — so
    // "make the outline thicker" reached nothing at all. The prose has to tell
    // the model the other way in, or the keys `vtStackControls` offers go unused.
    expect(VT_GUIDANCE).toContain(`\`${VT_STACK_PREFIX}<layerId>.<key>\``)
    expect(VT_GUIDANCE).toContain(`\`${VT_STACK_PREFIX}<layerId>.width\``)
    // No concrete id anywhere — the ids are per project.
    expect(VT_GUIDANCE).not.toMatch(/`appearance\.L[0-9a-z]+\./)
  })

  it('names every control the agent can actually reach', () => {
    // A control the agent is offered but the prose never explains is a knob the
    // model will use blind. VT_SHADER_CONTROLS is in here because
    // `vtAgentControls` now offers those three on a shader fill — a shared
    // module's keys still land in THIS studio's prompt.
    for (const c of [...VT_CONTROLS, ...VT_SHADER_CONTROLS]) {
      if ((c as any).agent === false) continue
      expect(quoted, `guidance never mentions ${c.key}`).toContain(c.key)
    }
  })

  it('says out loud that layer.paint.a / .b do not apply to a shader fill', () => {
    // Both keys are named by the prose (the rule above requires it) but they are
    // WITHHELD on a shader fill. Prose that named them without saying when they
    // vanish would teach the model to reach for a control that is not there.
    expect(VT_GUIDANCE).toMatch(/SHADER FILLS\./)
    expect(VT_GUIDANCE).toMatch(/withdrawn/)
  })

  it('leaves no un-backticked dotted key hiding in the prose', () => {
    // Second net: the rule above only sees backticked tokens, so anything
    // shaped like a path outside them is caught here. `fill` joined the
    // alternation with the shader vocabulary — `layer.paint.shader.effectId` un-quoted
    // is exactly as invisible to the first net as `axes.wght` was.
    for (const m of VT_GUIDANCE.matchAll(/(?<!`)\b(?:axes|motion|fill)\.[A-Za-z<>.]+/g)) {
      const t = m[0].replace(/\.$/, '')
      expect(staticKeys.has(t) || isAxisKey(t) || isShaderParamKey(t),
        `guidance names unknown key ${t}`).toBe(true)
    }
  })
})
