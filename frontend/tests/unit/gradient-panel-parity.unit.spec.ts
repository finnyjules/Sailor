import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  GRADIENT_CONTROLS,
  GRADIENT_DESIGN_ORDER,
  gradientPanelOverride,
  gradientPanelVisible,
  type GradientControl,
} from '~/lib/gradientfx/controls'
import { groupIntoSections } from '~/lib/studio/sections'
import {
  GRADIENT_PANEL_ORDER,
  PANEL_ANCHORS,
  PANEL_ANCHOR_KEYS,
  gradientPanelControls,
  panelSectionTitle,
} from '~/lib/gradientfx/panelPresentation'
import { ASPECTS, BLEND_MODES, LAYOUTS, ensureConfigDefaults, type GradientConfig } from '~/lib/gradientfx/types'
import { defaultConfig, stripeConfig } from '~/lib/gradientfx/randomize'

/**
 * CHARACTERIZATION ("parity") SPEC — captured 2026-08-24 from the hand-written
 * inspector in `GradientStudioSurface.vue` lines 986-1613, BEFORE Task 3 deletes
 * it and swaps in a schema-driven StudioControlPanel.
 *
 * THE TABLE BELOW IS THE CONTRACT. It was transcribed from the TEMPLATE, not from
 * the schema — that is the entire point: where the two disagreed, the schema was
 * wrong and was corrected. Do NOT edit the table to make a test pass; edit
 * `~/lib/gradientfx/controls.ts`.
 *
 * ── What is pinned ─────────────────────────────────────────────────────────────
 * For every state (layout / shape kind / focus mode / active layer) the panel could
 * be in: which rows were visible, in which section, with which label, bounds, step,
 * options, and whether the row offered a Collection binding (`:bindable="false"`).
 *
 * ── What is deliberately NOT pinned ────────────────────────────────────────────
 * Bespoke blocks the schema never described and Task 3 must render through
 * `#section-*` / `#control-*` slots:
 *   - the colour-stop repeater + "Add stop" + PalettePicker  (template ~1088-1113)
 *   - the mesh-point repeater + Add point / Scatter          (template ~1390-1404)
 *   - the Layout / Shape kind / Ring shape / Gradient direction / Mapping /
 *     Direction / Mirror button grids, and the aspect row's lock button
 *   - the Design|Motion tab strip, the Motion track editor, the Export block
 * `canvas.layout` and `canvas.aspect` DO stay in the table (they are real schema
 * rows) but their shipped widget is bespoke — see BESPOKE_WIDGETS below.
 *
 * ── Scope of the config model used here ────────────────────────────────────────
 * The scenarios in the FIRST block use a SINGLE-layer config with `activeLayer = 0`
 * (plus one explicit two-layer scenario for the Layer section). On a single-layer
 * config the template's `is*` (active layer), `any*` (any layer) and `base*` (layer 0)
 * predicate families all collapse onto `canvas.layout`, so they are indistinguishable
 * there. Telling them apart needs a stacked gradient with a `layer.layout` override —
 * see MULTI_LAYER_SCENARIOS near the end of this file, and MULTI_LAYER_FAMILIES for
 * which family each row belongs to.
 */

// ── the transcribed panel ────────────────────────────────────────────────────

interface Row {
  /** Schema `group` — today this is also the card title `groupIntoSections` emits. */
  group: string
  /** Title the SHIPPED panel printed above this row. Task 3 builds its section
   *  chrome map from this column; where it differs from `group`, see
   *  SECTION_TITLE_MAP below. */
  onScreen: string
  key: string
  label: string
  min?: number
  max?: number
  step?: number
  options?: readonly (string | number)[]
  /** Positionally paired with `options` — index i's display text for index i's stored
   *  value. Task 3 (option display labels): presentation only, never asserted unless
   *  the row actually carries one. */
  optionLabels?: readonly string[]
  /** `false` = the shipped row carried `:bindable="false"` (or was not wrapped in a
   *  BindableRow at all), so it offered no Collection binding. */
  bindable?: false
}

const sl = (group: string, onScreen: string, key: string, label: string,
            min: number, max: number, step: number, bindable?: false): Row =>
  ({ group, onScreen, key, label, min, max, step, ...(bindable === false ? { bindable } : {}) })

const sel = (group: string, onScreen: string, key: string, label: string,
             options: readonly (string | number)[], bindable?: false): Row =>
  ({ group, onScreen, key, label, options, ...(bindable === false ? { bindable } : {}) })

const row = (group: string, onScreen: string, key: string, label: string, bindable?: false): Row =>
  ({ group, onScreen, key, label, ...(bindable === false ? { bindable } : {}) })

/** Canvas — template 986-1037. Order is the TEMPLATE's:
 *  aspect, layout, margin, inner radius, center X/Y, background. */
const CANVAS = (o: { margin?: boolean; innerRadius?: boolean; center?: boolean } = {}): Row[] => [
  sel('Canvas', 'Canvas', 'canvas.aspect', 'Aspect ratio', ASPECTS),
  // Shipped as a button grid (LAYOUT_LABELS), never a BindableRow.
  sel('Canvas', 'Canvas', 'canvas.layout', 'Layout', LAYOUTS, false),
  ...(o.margin ? [sl('Canvas', 'Canvas', 'canvas.margin', 'Margin', 0, 0.45, 0.01)] : []),
  ...(o.innerRadius ? [sl('Canvas', 'Canvas', 'canvas.innerRadius', 'Inner radius', 0, 0.9, 0.01)] : []),
  ...(o.center
    ? [sl('Canvas', 'Canvas', 'canvas.center.x', 'Center X', -0.5, 0.5, 0.01),
       sl('Canvas', 'Canvas', 'canvas.center.y', 'Center Y', -0.5, 0.5, 0.01)]
    : []),
  row('Canvas', 'Canvas', 'canvas.background', 'Background'),
]

/** Flow — template 1254-1298. Unconditional on every layout. */
const FLOW: Row[] = [
  sl('Flow', 'Flow', 'flow.angle', 'Flow angle', 0, 360, 1),
  sl('Flow', 'Flow', 'flow.noiseScale', 'Noise scale', 0.5, 8, 0.1),
  sl('Flow', 'Flow', 'flow.intensity', 'Noise intensity', 0, 100, 1),
  sl('Flow', 'Flow', 'flow.distortion', 'Curve distortion', 0, 100, 1),
  sl('Flow', 'Flow', 'flow.detail', 'Detail', 1, 6, 1),
  sl('Flow', 'Flow', 'flow.swirl', 'Swirl', 0, 100, 1),
  sl('Flow', 'Flow', 'flow.speed', 'Flow speed', 0, 100, 1),
]

/** Relief — template 1432-1450. Shown when layer 0 is banded. NOTE the template
 *  order is Relief, Light angle, Light height; the schema emits azimuth, elevation,
 *  relief. See KNOWN_ORDER_DIVERGENCES. */
const RELIEF: Row[] = [
  sl('Relief', 'Relief', 'relief.relief', 'Relief', 0, 1, 0.01),
  sl('Relief', 'Relief', 'relief.light.azimuth', 'Light angle', 0, 360, 1),
  sl('Relief', 'Relief', 'relief.light.elevation', 'Light height', 0, 90, 1),
]

/** Focus — template 1453-1500. blur + region always; the rest only off "off". */
const FOCUS = (shape: 'off' | 'radial' | 'linear' = 'off'): Row[] => [
  sl('Focus', 'Focus', 'focus.blur', 'Blur', 0, 100, 1),
  // optionLabels: template truth (9c20f8b72, GradientStudioSurface.vue ~1465-1467) —
  // the old native <select>'s three <option> texts.
  { ...sel('Focus', 'Focus', 'focus.shape', 'Focus region', ['off', 'radial', 'linear']),
    optionLabels: ['Off — blur everything', 'Radial — sharp spot', 'Linear — tilt-shift band'] },
  ...(shape === 'off' ? [] : [
    sl('Focus', 'Focus', 'focus.radius', 'Focus size', 0, 1, 0.01),
    sl('Focus', 'Focus', 'focus.softness', 'Focus falloff', 0, 100, 1),
    sl('Focus', 'Focus', 'focus.x', 'Focus X', -0.5, 0.5, 0.01),
    sl('Focus', 'Focus', 'focus.y', 'Focus Y', -0.5, 0.5, 0.01),
  ]),
  ...(shape === 'linear' ? [sl('Focus', 'Focus', 'focus.angle', 'Band angle', 0, 360, 1)] : []),
]

/** The colour-parameter tail of the on-screen "Color" card (template 1114-1176).
 *  These live in schema group 'Layer', NOT 'Colours' — see SECTION_TITLE_MAP. */
const COLOR_PARAMS = (o: { steps?: boolean; hueDrift?: boolean; repeat?: boolean; tile?: boolean; falloff?: boolean }): Row[] => [
  ...(o.steps ? [sl('Layer', 'Color', 'layer.color.steps', 'Posterize steps', 0, 24, 1)] : []),
  ...(o.hueDrift ? [sl('Layer', 'Color', 'layer.color.hueDrift', 'Hue drift', -180, 180, 1)] : []),
  sl('Layer', 'Color', 'layer.color.hueRotate', 'Hue rotate', 0, 360, 1),
  ...(o.repeat ? [sel('Layer', 'Color', 'layer.color.repeat', 'Repeat', ['once', 'mirror', 'tile'])] : []),
  ...(o.tile ? [sl('Layer', 'Color', 'layer.color.repeatCount', 'Repeat count', 2, 16, 1)] : []),
  ...(o.falloff ? [sel('Layer', 'Color', 'layer.color.falloff', 'Falloff', ['linear', 'ease', 'smooth'])] : []),
]

/** Shape — template 1524-1613. EVERY row carried `:bindable="false"`. */
const SHAPE_COMMON: Row[] = [
  sl('Shape', 'Shape', 'layer.shape.minDepth', 'Min depth', 0, 1, 0.01, false),
  sl('Shape', 'Shape', 'layer.shape.curveExp', 'Curve exponent', 0.2, 3, 0.05, false),
]
const SHAPE_TAIL: Row[] = [
  sl('Shape', 'Shape', 'layer.shape.gap', 'Gap', 0, 0.8, 0.01, false),
  sl('Shape', 'Shape', 'layer.shape.rounding', 'Rounding', 0, 1, 0.01, false),
]
const count = (stack = false): Row =>
  stack ? sl('Shape', 'Shape', 'layer.shape.count', 'Ring count', 2, 40, 1, false)
        : sl('Shape', 'Shape', 'layer.shape.count', 'Count', 2, 64, 1, false)
const jitter = (type: string): Row =>
  sl('Shape', 'Shape', 'layer.shape.jitter', type === 'bands' ? 'Randomness' : 'Jitter', 0, 1, 0.01, false)

const SHAPE_STACK: Row[] = [
  count(true),
  sl('Shape', 'Shape', 'layer.shape.rotStep', 'Rotation / ring', 0, 45, 1, false),
  sl('Shape', 'Shape', 'layer.shape.pivot', 'Pivot', 0, 0.6, 0.01, false),
  sl('Shape', 'Shape', 'layer.shape.ringScale', 'Disc size', 1, 2.2, 0.02, false),
]

/** shape.type-dependent middle block (template 1547-1566) + the radial-only tail. */
const SHAPE_BANDED = (type: 'bands' | 'wave' | 'noise' | 'pyramid', radial: boolean): Row[] => [
  count(),
  ...(type === 'wave' || type === 'bands'
    ? [sl('Shape', 'Shape', 'layer.shape.peaks', 'Peaks', 1, 12, 1, false),
       sl('Shape', 'Shape', 'layer.shape.phase', 'Wave phase', 0, 1, 0.01, false)]
    : []),
  ...(type === 'noise'
    ? [sl('Shape', 'Shape', 'layer.shape.detail', 'Detail', 1, 8, 1, false),
       // The template's noise-branch label. When the layout is ALSO radial the
       // template rendered a SECOND slider on this same key labelled
       // "Scrub / rotate" — see DEDUPLICATED_ROWS.
       sl('Shape', 'Shape', 'layer.shape.scrub', 'Scrub', 0, 1, 0.01, false)]
    : []),
  ...(type === 'pyramid' ? [sl('Shape', 'Shape', 'layer.shape.valley', 'Valley position', 0, 1, 0.01, false)] : []),
  ...SHAPE_COMMON,
  jitter(type),
  ...SHAPE_TAIL,
  ...(radial
    ? [sl('Shape', 'Shape', 'layer.shape.sweep', 'Sweep', 20, 360, 1, false),
       ...(type === 'noise' ? [] : [sl('Shape', 'Shape', 'layer.shape.scrub', 'Scrub / rotate', 0, 1, 0.01, false)])]
    : []),
]

const CURVE_HEAD: Row[] = [
  sel('Curve', 'Curve', 'layer.curve.mode', 'Mode', ['along', 'outward']),
  sel('Curve', 'Curve', 'layer.curve.shape', 'Shape', ['line', 'arc', 's-curve', 'wave', 'loop']),
  sl('Curve', 'Curve', 'layer.curve.start.x', 'Start X', 0, 1, 0.01),
  sl('Curve', 'Curve', 'layer.curve.start.y', 'Start Y', 0, 1, 0.01),
  sl('Curve', 'Curve', 'layer.curve.end.x', 'End X', 0, 1, 0.01),
  sl('Curve', 'Curve', 'layer.curve.end.y', 'End Y', 0, 1, 0.01),
  sl('Curve', 'Curve', 'layer.curve.curvature', 'Curvature', 0, 1, 0.01),
  sl('Curve', 'Curve', 'layer.curve.bend', 'Bend', -1, 1, 0.01),
]

const LIQUID: Row[] = [
  // on-screen "Depth & light"
  sl('Liquid', 'Depth & light', 'flow.depth', 'Depth', 0, 100, 1),
  sl('Liquid', 'Depth & light', 'flow.highlights', 'Highlights', 0, 100, 1),
  sl('Liquid', 'Depth & light', 'flow.shadows', 'Shadows', 0, 100, 1),
  sl('Liquid', 'Depth & light', 'flow.foldScale', 'Fold scale', 0, 100, 1),
  sl('Liquid', 'Depth & light', 'flow.gloss', 'Gloss', 0, 100, 1),
  // on-screen "Liquid surface"
  sl('Liquid', 'Liquid surface', 'flow.veins', 'Veins', 0, 100, 1),
  sl('Liquid', 'Liquid surface', 'flow.veinScale', 'Vein scale', 0, 100, 1),
  sl('Liquid', 'Liquid surface', 'flow.ripple', 'Ripple', 0, 100, 1),
  sl('Liquid', 'Liquid surface', 'flow.refract', 'Refraction', 0, 100, 1),
  sl('Liquid', 'Liquid surface', 'flow.viscosity', 'Viscosity', 0, 100, 1),
]

const MESH: Row[] = [
  sl('Mesh', 'Mesh', 'layer.mesh.softness', 'Softness', 10, 100, 1),
  sl('Mesh', 'Mesh', 'layer.mesh.contrast', 'Contrast', 0, 100, 1),
  sl('Mesh', 'Mesh', 'layer.mesh.blur', 'Blur', 0, 100, 1),
  sl('Mesh', 'Mesh', 'layer.mesh.drift', 'Drift', 0, 100, 1),
]

const LAYER_SECTION: Row[] = [
  sel('Layer', 'Layer', 'layer.blend', 'Blend', BLEND_MODES),
  sl('Layer', 'Layer', 'layer.opacity', 'Opacity', 0, 1, 0.01),
]

// ── config builders ──────────────────────────────────────────────────────────

const norm = (c: any): GradientConfig => ensureConfigDefaults(c)
/** stripeConfig() is the historical banded default: layout 'linear', shape.type 'bands'. */
const stripe = (layout: string, mutate: (c: any) => void = () => {}): GradientConfig => {
  const c: any = stripeConfig('#parity')
  c.canvas.layout = layout
  mutate(c)
  return norm(c)
}

// ── scenarios ────────────────────────────────────────────────────────────────

interface Scenario { state: string; cfg: () => GradientConfig; activeLayer?: number; rows: Row[] }

const SCENARIOS: Scenario[] = [
  {
    state: 'ramp — brand-new document (defaultConfig)',
    cfg: () => norm(defaultConfig('#parity')),
    rows: [
      ...CANVAS(),
      sl('Gradient', 'Color', 'layer.ramp.angle', 'Angle', 0, 360, 1),
      ...FLOW,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, repeat: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'ramp with repeat = tile (Repeat count appears)',
    cfg: () => norm((() => { const c: any = defaultConfig('#parity'); c.layers[0].color.repeat = 'tile'; return c })()),
    rows: [
      ...CANVAS(),
      sl('Gradient', 'Color', 'layer.ramp.angle', 'Angle', 0, 360, 1),
      ...FLOW,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, repeat: true, tile: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'radialRamp (simple Radial primitive)',
    cfg: () => norm((() => { const c: any = defaultConfig('#parity'); c.canvas.layout = 'radialRamp'; return c })()),
    rows: [
      ...CANVAS({ innerRadius: true, center: true }),
      sl('Gradient', 'Color', 'layer.ramp.radius', 'Radius', 0.05, 2, 0.01),
      // label: template truth (9c20f8b72, GradientStudioSurface.vue:1066) — the visible
      // `<label>` read 'Shape'; 'Radial shape' was only the BindableRow promote-name.
      sel('Gradient', 'Color', 'layer.ramp.shape', 'Shape', ['circle', 'ellipse']),
      ...FLOW,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, repeat: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'conic',
    cfg: () => norm((() => { const c: any = defaultConfig('#parity'); c.canvas.layout = 'conic'; return c })()),
    rows: [
      ...CANVAS({ center: true }),
      sl('Gradient', 'Color', 'layer.ramp.angle', 'Angle', 0, 360, 1),
      sl('Gradient', 'Color', 'layer.ramp.sweep', 'Sweep', 20, 360, 1),
      // plain checkbox in the template — no BindableRow wrapper
      row('Gradient', 'Color', 'layer.ramp.closeLoop', 'Close loop', false),
      ...FLOW,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, repeat: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'curve (default shape "arc", mode "along")',
    cfg: () => norm((() => { const c: any = defaultConfig('#parity'); c.canvas.layout = 'curve'; return c })()),
    rows: [
      ...CANVAS(),
      ...CURVE_HEAD,
      ...FLOW,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, repeat: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'curve — wave shape + outward mode (Waves/Phase/Width appear)',
    cfg: () => norm((() => {
      const c: any = defaultConfig('#parity')
      c.canvas.layout = 'curve'
      c.layers[0].curve = { mode: 'outward', shape: 'wave', start: { x: 0.2, y: 0.5 }, end: { x: 0.8, y: 0.5 }, curvature: 0.4, bend: 0, waves: 3, phase: 0, width: 0.3 }
      return c
    })()),
    rows: [
      ...CANVAS(),
      ...CURVE_HEAD,
      sl('Curve', 'Curve', 'layer.curve.waves', 'Waves', 1, 8, 1),
      sl('Curve', 'Curve', 'layer.curve.phase', 'Phase', 0, 1, 0.01),
      sl('Curve', 'Curve', 'layer.curve.width', 'Width', 0.02, 1, 0.01),
      ...FLOW,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, repeat: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'linear stripes — shape.type "bands" (jitter reads "Randomness")',
    cfg: () => stripe('linear'),
    rows: [
      ...CANVAS({ margin: true }),
      ...FLOW,
      ...SHAPE_BANDED('bands', false),
      ...RELIEF,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'linear stripes — shape.type "noise" (Detail + Scrub)',
    cfg: () => stripe('linear', (c) => { c.layers[0].shape.type = 'noise' }),
    rows: [
      ...CANVAS({ margin: true }),
      ...FLOW,
      ...SHAPE_BANDED('noise', false),
      ...RELIEF,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'linear stripes — shape.type "pyramid" (Valley position)',
    cfg: () => stripe('linear', (c) => { c.layers[0].shape.type = 'pyramid' }),
    rows: [
      ...CANVAS({ margin: true }),
      ...FLOW,
      ...SHAPE_BANDED('pyramid', false),
      ...RELIEF,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'radial stripes — Sweep + Scrub / rotate appear',
    cfg: () => stripe('radial'),
    rows: [
      ...CANVAS({ margin: true, innerRadius: true, center: true }),
      ...FLOW,
      ...SHAPE_BANDED('bands', true),
      ...RELIEF,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'orbit — same gating as radial',
    cfg: () => stripe('orbit'),
    rows: [
      ...CANVAS({ margin: true, innerRadius: true, center: true }),
      ...FLOW,
      ...SHAPE_BANDED('bands', true),
      ...RELIEF,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'stack — Ring count 2..40 + Rotation/ring, Pivot, Disc size',
    cfg: () => stripe('stack'),
    rows: [
      ...CANVAS({ margin: true }),
      ...FLOW,
      ...SHAPE_STACK,
      ...RELIEF,
      // hue drift is NOT read by the stack branch — template gate `!isStack`
      ...COLOR_PARAMS({ steps: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'liquid — Depth & light + Liquid surface',
    cfg: () => stripe('liquid'),
    rows: [
      ...CANVAS(),
      ...FLOW,
      ...LIQUID,
      // hue drift is NOT read by the liquid branch — template gate `!isLiquid`
      ...COLOR_PARAMS({ steps: true, falloff: true }),
      ...FOCUS(),
    ],
  },
  {
    state: 'mesh — only Hue rotate survives from the colour params',
    cfg: () => stripe('mesh'),
    rows: [
      ...CANVAS(),
      ...FLOW,
      ...MESH,
      ...COLOR_PARAMS({}),
      ...FOCUS(),
    ],
  },
  {
    state: 'focus.shape = radial — Focus size/falloff/X/Y appear',
    cfg: () => norm((() => { const c: any = defaultConfig('#parity'); c.focus = { ...(c.focus ?? {}), shape: 'radial' }; return c })()),
    rows: [
      ...CANVAS(),
      sl('Gradient', 'Color', 'layer.ramp.angle', 'Angle', 0, 360, 1),
      ...FLOW,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, repeat: true, falloff: true }),
      ...FOCUS('radial'),
    ],
  },
  {
    state: 'focus.shape = linear — Band angle appears too',
    cfg: () => norm((() => { const c: any = defaultConfig('#parity'); c.focus = { ...(c.focus ?? {}), shape: 'linear' }; return c })()),
    rows: [
      ...CANVAS(),
      sl('Gradient', 'Color', 'layer.ramp.angle', 'Angle', 0, 360, 1),
      ...FLOW,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, repeat: true, falloff: true }),
      ...FOCUS('linear'),
    ],
  },
  {
    state: 'second layer selected — Blend + Opacity appear',
    activeLayer: 1,
    cfg: () => norm((() => {
      const c: any = defaultConfig('#parity')
      c.layers = [c.layers[0], JSON.parse(JSON.stringify(c.layers[0]))]
      return c
    })()),
    rows: [
      ...CANVAS(),
      sl('Gradient', 'Color', 'layer.ramp.angle', 'Angle', 0, 360, 1),
      ...FLOW,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, repeat: true, falloff: true }),
      ...FOCUS(),
      ...LAYER_SECTION,
    ],
  },
]

// ── derivation under test ────────────────────────────────────────────────────

/** Exactly what Task 3's StudioControlPanel will be handed:
 *  `GRADIENT_CONTROLS` + `GRADIENT_DESIGN_ORDER` + a `:visible` predicate of
 *  `when && gradientPanelVisible`, with `gradientPanelOverride` applied per row. */
function panelRows(cfg: GradientConfig, activeLayer = 0): Array<Row & { spec: GradientControl }> {
  const tree = groupIntoSections(
    GRADIENT_CONTROLS,
    GRADIENT_DESIGN_ORDER,
    (c) => (!c.when || c.when(cfg)) && gradientPanelVisible(c, cfg, activeLayer),
  )
  const out: Array<Row & { spec: GradientControl }> = []
  const walk = (nodes: typeof tree) => nodes.forEach((n) => {
    for (const c of n.controls) {
      const spec = { ...c, ...(gradientPanelOverride(c, cfg, activeLayer) ?? {}) } as GradientControl
      out.push({
        group: n.title, onScreen: n.title, key: spec.key, label: spec.label,
        ...(spec.kind === 'slider' ? { min: spec.min, max: spec.max, step: spec.step } : {}),
        ...((spec as any).options ? { options: (spec as any).options } : {}),
        ...((spec as any).bindable === false ? { bindable: false as const } : {}),
        spec,
      })
    }
    walk(n.sections)
  })
  walk(tree)
  return out
}

/** Groups whose row ORDER the schema already reproduces. Relief / Shape / Layer are
 *  excluded — see KNOWN_ORDER_DIVERGENCES. */
const ORDERED_GROUPS = ['Canvas', 'Gradient', 'Curve', 'Flow', 'Liquid', 'Mesh', 'Focus']

describe('Gradient panel parity — the hand-written panel is the contract', () => {
  for (const s of SCENARIOS) {
    describe(s.state, () => {
      it('shows exactly the rows the old panel showed', () => {
        const got = panelRows(s.cfg(), s.activeLayer ?? 0).map((r) => r.key)
        const want = s.rows.map((r) => r.key)
        expect([...got].sort()).toEqual([...new Set(want)].sort())
      })

      it('reproduces every row label, bound, option list and bindability', () => {
        const got = panelRows(s.cfg(), s.activeLayer ?? 0)
        for (const want of s.rows) {
          const hit = got.find((g) => g.key === want.key && g.label === want.label)
            ?? got.find((g) => g.key === want.key)
          expect(hit, `${want.key} ("${want.label}") missing`).toBeTruthy()
          expect(hit!.label, `${want.key} label`).toBe(want.label)
          expect(hit!.group, `${want.key} group`).toBe(want.group)
          if (want.min !== undefined) {
            expect(hit!.min, `${want.key} min`).toBe(want.min)
            expect(hit!.max, `${want.key} max`).toBe(want.max)
            expect(hit!.step, `${want.key} step`).toBe(want.step)
          }
          if (want.options) expect(hit!.options, `${want.key} options`).toEqual([...want.options])
          if (want.optionLabels) {
            expect((hit!.spec as any).optionLabels, `${want.key} optionLabels`).toEqual([...want.optionLabels])
          }
          expect(hit!.bindable, `${want.key} bindable`).toBe(want.bindable)
        }
      })

      it('never renders the same key twice', () => {
        const keys = panelRows(s.cfg(), s.activeLayer ?? 0).map((r) => r.key)
        expect(new Set(keys).size).toBe(keys.length)
      })

      it('keeps the shipped row order inside every order-stable section', () => {
        const got = panelRows(s.cfg(), s.activeLayer ?? 0)
        for (const g of ORDERED_GROUPS) {
          const want = s.rows.filter((r) => r.group === g).map((r) => r.key)
          expect(got.filter((r) => r.group === g).map((r) => r.key), `${g} order`).toEqual(want)
        }
      })
    })
  }
})

// ── documented divergences (data, not assertions elsewhere) ──────────────────

/** Schema group -> the title the shipped panel printed. Task 3 builds its
 *  `sections` chrome map (and its `order` prop) from this.
 *  NOTE the two non-1:1 entries — the reason this is a map and not a rename. */
export const SECTION_TITLE_MAP: Record<string, string | string[]> = {
  Canvas: 'Canvas',
  Gradient: 'Color',   // the ramp axis was folded INTO the Color card
  Colours: 'Color',    // the stop repeater, ditto
  Curve: 'Curve',
  Flow: 'Flow',
  Liquid: ['Depth & light', 'Liquid surface'], // ONE schema group, TWO shipped cards
  Mesh: 'Mesh',
  Relief: 'Relief',
  Focus: 'Focus',
  Layer: ['Color', 'Layer'],                   // ONE schema group, TWO shipped cards
  Shape: 'Shape',
}

/** Section badges/open-state the shipped panel used (StudioSection props). */
export const SECTION_CHROME: Record<string, { badge?: string; open?: boolean }> = {
  Canvas: { badge: 'both layers' },
  Color: { /* badge is dynamic: 'mesh palette' | the active layer's name */ },
  Curve: { open: true },
  Flow: { badge: 'all layouts' /* open when liquid||mesh */ },
  'Depth & light': { badge: 'liquid' },
  'Liquid surface': { badge: 'liquid', open: true },
  Mesh: { badge: 'layer 1', open: true },
  Relief: { open: false },
  Focus: { badge: 'both layers', open: false },
  Layer: { open: false },
  Shape: { /* badge: the active layer's name */ },
}

/** Rows whose shipped widget is bespoke — Task 3 needs a `#control-<key>` slot,
 *  otherwise they render as a plain select/checkbox row. */
export const BESPOKE_WIDGETS = [
  'canvas.aspect',        // select + a lock toggle in the label row
  'canvas.layout',        // 3-col button grid of LAYOUT_LABELS + a lock toggle
  'layer.ramp.closeLoop', // bare checkbox, not a StudioSwitch
]

/** Sections whose row order the schema does NOT reproduce. Fixing them means
 *  reordering GRADIENT_CONTROLS, which reorders the FROZEN animatable-target
 *  snapshot in gradientfx-motion-path.unit.spec.ts (an ordered array of paths).
 *  Left as-is deliberately; revisit with a deliberate motion-snapshot update. */
export const KNOWN_ORDER_DIVERGENCES = {
  Relief: { shipped: ['relief.relief', 'relief.light.azimuth', 'relief.light.elevation'],
            schema: ['relief.light.azimuth', 'relief.light.elevation', 'relief.relief'] },
  Shape: { shipped: 'count, [peaks, phase | detail, scrub | valley], minDepth, curveExp, jitter, gap, rounding, [sweep, scrub]',
           schema: 'phase, scrub, peaks, count, minDepth, curveExp, jitter, sweep, gap, rounding, valley, detail, rotStep, pivot, ringScale' },
  Layer: { shipped: 'Color card: steps, hueDrift, hueRotate, repeat, repeatCount, falloff — Layer card: blend, opacity',
           schema: 'repeat, repeatCount, falloff, layout, blend, opacity, steps, hueDrift, hueRotate' },
}

/** The one row the shipped panel drew TWICE. On a radial/orbit layout whose
 *  shape.type is 'noise' the template rendered `layer.shape.scrub` in the noise
 *  branch ("Scrub") AND again in the isRadial tail ("Scrub / rotate"), both bound
 *  to the same field. The derived panel keeps the first. */
export const DEDUPLICATED_ROWS = ['layer.shape.scrub']

/**
 * Predicate families that differ only on MULTI-layer configs. The template read the
 * ACTIVE layer (`is*`), ANY layer (`any*`) or LAYER 0 (`base*`); a control's `when`
 * reads `cfg.canvas.layout` and always will, because `when` is ALSO the agent's
 * vocabulary and motion's animatable-target list, where the canvas layout is the
 * right question.
 *
 * All three families are now REPRODUCED — in `panelPresentation.ts` (`shadowConfig`
 * + `GLOBAL_ROW_RULES`), the layer between the schema and the panel, and pinned by
 * MULTI_LAYER_SCENARIOS below. What is recorded here is therefore no longer a set of
 * live divergences but the map of WHICH family each row belongs to: the thing a
 * future row has to pick from, and the thing the shadow config would silently get
 * wrong if a new row were added to the `any*`/`base*` set without a rule.
 */
export const MULTI_LAYER_FAMILIES = {
  'canvas.margin': 'any — anyBanded (GLOBAL_ROW_RULES)',
  'canvas.innerRadius': 'any — anyInnerRadius, one layout narrower than center (GLOBAL_ROW_RULES)',
  'canvas.center.*': 'any — anyCenter (GLOBAL_ROW_RULES)',
  'relief.*': 'base — baseBanded, layer 0 (GLOBAL_ROW_RULES)',
  'flow.highlights|shadows|gloss|ripple': 'base — isLiquid AND baseLiquid (GLOBAL_ROW_RULES)',
  'flow.depth|foldScale|veins|veinScale|refract|viscosity': 'active — isLiquid, a genuine per-layer effect inside computeLayer (shadow `when`)',
  'Gradient / Color / Curve / Mesh / Shape gating': 'active — effectiveLayout(cfg, activeLayer) (shadow `when` + gradientPanelVisible)',
  'layer.curve.*, layer.color.repeatCount, layer.shape.detail':
    "active — their `when` reads layers[0] for per-layer STATE (curve shape/mode, colour repeat, shape kind); the shadow config stands the active layer in at index 0 so they read the selected layer, as the template's `layer` did",
  'bespoke-block anchors (ui.*)': 'active — PANEL_ANCHORS.visible reads effectiveLayout(cfg, activeLayer)',
}

/**
 * The ONE thing that stays canvas-layout-blind, deliberately: the schema half of this
 * spec (`panelRows` above) evaluates `c.when(cfg)` and `gradientPanelVisible(cfg)`
 * against the raw config, which is what the AGENT and MOTION do. Its scenarios are all
 * single-layer, where the three families collapse, so it stays a faithful pin of the
 * schema. The panel's own multi-layer answer is asserted through `gradientPanelControls`
 * in MULTI_LAYER_SCENARIOS instead.
 */
export const SCHEMA_HALF_IS_CANVAS_LEVEL = true

describe('documented divergences stay documented', () => {
  it('every group in SECTION_TITLE_MAP is a real design section', () => {
    for (const g of Object.keys(SECTION_TITLE_MAP)) expect(GRADIENT_DESIGN_ORDER).toContain(g)
  })
  it('every design group has a title mapping', () => {
    for (const g of GRADIENT_DESIGN_ORDER) expect(Object.keys(SECTION_TITLE_MAP)).toContain(g)
  })
  it('the bespoke-widget keys are real controls', () => {
    const keys = new Set(GRADIENT_CONTROLS.map((c) => c.key))
    for (const k of [...BESPOKE_WIDGETS, ...DEDUPLICATED_ROWS]) expect(keys, k).toContain(k)
  })
})

// ── the SHIPPED PANEL's own shape: card titles + within-card order ────────────

/**
 * The block above pins the schema derivation, and it groups by SCHEMA group — so it
 * says nothing about what the cards are CALLED on screen or what order their rows
 * come out in. Those are exactly the two things `panelPresentation.ts` exists to fix,
 * and green there was not the same thing as visual parity.
 *
 * This block runs the remap the surface runs and asserts the shipped truth: the card
 * titles, their order, and the row order inside each — INCLUDING Relief, Shape and
 * Layer, whose schema order diverges (KNOWN_ORDER_DIVERGENCES) and which the remap is
 * what corrects.
 */
function shippedPanel(cfg: GradientConfig, activeLayer = 0): Array<{ title: string; key: string }> {
  const tree = groupIntoSections(gradientPanelControls(cfg, activeLayer), GRADIENT_PANEL_ORDER)
  const out: Array<{ title: string; key: string }> = []
  const walk = (nodes: typeof tree) => nodes.forEach((n) => {
    for (const c of n.controls) if (!PANEL_ANCHOR_KEYS.has(c.key)) out.push({ title: n.title, key: c.key })
    walk(n.sections)
  })
  walk(tree)
  return out
}

describe('the derived panel reproduces the SHIPPED cards, not the schema groups', () => {
  for (const s of SCENARIOS) {
    describe(s.state, () => {
      it('draws exactly the cards the old panel drew, in the old order', () => {
        const got = shippedPanel(s.cfg(), s.activeLayer ?? 0)
        const want = new Set(s.rows.map((r) => r.onScreen))
        const titles = [...new Set(got.map((r) => r.title))]
        expect(new Set(titles)).toEqual(want)
        expect(titles).toEqual(GRADIENT_PANEL_ORDER.filter((t) => want.has(t)))
      })

      it('keeps the shipped row order inside every card', () => {
        const got = shippedPanel(s.cfg(), s.activeLayer ?? 0)
        for (const title of new Set(s.rows.map((r) => r.onScreen))) {
          const want: string[] = []
          for (const r of s.rows) if (r.onScreen === title && !want.includes(r.key)) want.push(r.key)
          expect(got.filter((r) => r.title === title).map((r) => r.key), `${title} order`).toEqual(want)
        }
      })

      it('gives every row the shipped card title', () => {
        const byKey = new Map(shippedPanel(s.cfg(), s.activeLayer ?? 0).map((r) => [r.key, r.title]))
        for (const r of s.rows) expect(byKey.get(r.key), `${r.key} card`).toBe(r.onScreen)
      })
    })
  }

  it('routes every schema group to the title SECTION_TITLE_MAP records', () => {
    for (const c of GRADIENT_CONTROLS) {
      const declared = SECTION_TITLE_MAP[String(c.group)]
      if (declared === undefined) continue
      const got = panelSectionTitle(c)
      expect(Array.isArray(declared) ? declared : [declared], `${c.key}`).toContain(got)
    }
  })

  it('gives every card a chrome entry and every chrome entry a card', () => {
    expect([...GRADIENT_PANEL_ORDER].sort()).toEqual(Object.keys(SECTION_CHROME).sort())
  })

  it('anchors the bespoke blocks the schema never described', () => {
    for (const k of PANEL_ANCHOR_KEYS) expect(GRADIENT_PANEL_ORDER).toContain(PANEL_ANCHORS.find(a => a.key === k)!.group)
    expect([...PANEL_ANCHOR_KEYS].every((k) => k.startsWith('ui.'))).toBe(true)
  })
})

// ── MULTI-LAYER: the three predicate families the single-layer block collapses ─

/**
 * Every scenario above is single-layer, where the template's `is*` (ACTIVE layer),
 * `any*` (ANY layer) and `base*` (LAYER 0) predicate families all collapse onto
 * `canvas.layout` — so they cannot tell the three apart. A stacked gradient CAN:
 * `layer.layout` overrides one layer's type while the canvas keeps another.
 *
 * These scenarios were transcribed from the SAME deleted template (9c20f8b72,
 * `GradientStudioSurface.vue` — the computeds at lines 65-90 and the section gates
 * at 986-1613), and they run the REAL panel path (`gradientPanelControls`), not the
 * schema-derivation harness above: a control's `when` reads `cfg.canvas.layout` and
 * always will (it is also the agent's and motion's vocabulary), so reproducing the
 * per-layer reading is the PRESENTATION layer's job. See panelPresentation.ts.
 */
const twoLayer = (base: string, override: string, mutate: (c: any) => void = () => {}): GradientConfig => {
  const c: any = stripeConfig('#parity')
  c.canvas.layout = base
  c.layers = [c.layers[0], JSON.parse(JSON.stringify(c.layers[0]))]
  c.layers[1].layout = override
  mutate(c)
  return norm(c)
}

interface MultiScenario { state: string; cfg: () => GradientConfig; activeLayer: number; rows: Row[]; anchors: string[] }

const MULTI_LAYER_SCENARIOS: MultiScenario[] = [
  {
    // template: `<StudioSection v-if="isCurve">` where isCurve reads activeLayout.
    state: 'base ramp + layer 1 overridden to curve, layer 1 active — the Curve card follows the SELECTED layer',
    cfg: () => twoLayer('ramp', 'curve'),
    activeLayer: 1,
    rows: [
      // No layer is banded (ramp + curve) => no Margin; none is polar => no Center /
      // Inner radius; layer 0 is not banded => no Relief.
      ...CANVAS(),
      ...CURVE_HEAD,
      ...FLOW,
      // activeLayout 'curve' is one of `isSimpleRamp || isCurve` => Repeat shows.
      ...COLOR_PARAMS({ steps: true, hueDrift: true, repeat: true, falloff: true }),
      ...FOCUS(),
      ...LAYER_SECTION,
    ],
    anchors: ['ui.color.stops', 'ui.flow.intro'],
  },
  {
    // The inverse: the base is curve, so the SCHEMA would draw a Curve card — but the
    // selected layer is a stack, and writes from those rows land in layers[1].curve,
    // which nothing reads.
    state: 'base curve + layer 1 overridden to stack, layer 1 active — no Curve card, the Shape card is the stack one',
    cfg: () => twoLayer('curve', 'stack'),
    activeLayer: 1,
    rows: [
      // anyBanded: layer 1 is a stack => Margin shows even though the canvas is curve.
      ...CANVAS({ margin: true }),
      ...FLOW,
      ...SHAPE_STACK,
      // baseBanded is false (layer 0 is curve) => NO Relief.
      // isStack => no Hue drift; not a simple primitive => no Repeat.
      ...COLOR_PARAMS({ steps: true, falloff: true }),
      ...FOCUS(),
      ...LAYER_SECTION,
    ],
    anchors: ['ui.color.stops', 'ui.flow.intro', 'ui.shape.ringShape'],
  },
  {
    // template: `anyCenter` / `anyInnerRadius` — a GLOBAL row shows when ANY layer
    // needs it, so selecting the linear base must not hide the radial layer's origin.
    state: 'base linear + layer 1 overridden to radial, layer 0 active — Center X/Y and Inner radius show for the OTHER layer',
    cfg: () => twoLayer('linear', 'radial'),
    activeLayer: 0,
    rows: [
      ...CANVAS({ margin: true, innerRadius: true, center: true }),
      ...FLOW,
      // The active layer is linear, so Shape is the non-radial banded block.
      ...SHAPE_BANDED('bands', false),
      ...RELIEF,
      ...COLOR_PARAMS({ steps: true, hueDrift: true, falloff: true }),
      ...FOCUS(),
    ],
    anchors: ['ui.color.stops', 'ui.color.direction', 'ui.flow.intro', 'ui.shape.kind', 'ui.shape.direction', 'ui.shape.mirror'],
  },
]

/** Every row the real panel path produces, carrying its on-screen card title. */
function panelRowsOnScreen(cfg: GradientConfig, activeLayer: number) {
  const tree = groupIntoSections(gradientPanelControls(cfg, activeLayer), GRADIENT_PANEL_ORDER)
  const out: Array<{ title: string; spec: any }> = []
  const walk = (nodes: typeof tree) => nodes.forEach((n) => {
    for (const c of n.controls) out.push({ title: n.title, spec: c })
    walk(n.sections)
  })
  walk(tree)
  return out
}

describe('multi-layer gating — active layer / any layer / layer 0', () => {
  for (const s of MULTI_LAYER_SCENARIOS) {
    describe(s.state, () => {
      it('shows exactly the rows the old panel showed', () => {
        const got = panelRowsOnScreen(s.cfg(), s.activeLayer)
          .filter((r) => !PANEL_ANCHOR_KEYS.has(r.spec.key)).map((r) => r.spec.key)
        expect([...got].sort()).toEqual([...new Set(s.rows.map((r) => r.key))].sort())
      })

      it('draws the bespoke-block anchors the old panel drew', () => {
        const got = panelRowsOnScreen(s.cfg(), s.activeLayer)
          .filter((r) => PANEL_ANCHOR_KEYS.has(r.spec.key)).map((r) => r.spec.key)
        expect([...got].sort()).toEqual([...s.anchors].sort())
      })

      it('reproduces every row label, bound, option list and card title', () => {
        const got = panelRowsOnScreen(s.cfg(), s.activeLayer)
        for (const want of s.rows) {
          const hit = got.find((g) => g.spec.key === want.key)
          expect(hit, `${want.key} ("${want.label}") missing`).toBeTruthy()
          expect(hit!.spec.label, `${want.key} label`).toBe(want.label)
          expect(hit!.title, `${want.key} card`).toBe(want.onScreen)
          if (want.min !== undefined) {
            expect(hit!.spec.min, `${want.key} min`).toBe(want.min)
            expect(hit!.spec.max, `${want.key} max`).toBe(want.max)
          }
          if (want.options) expect(hit!.spec.options, `${want.key} options`).toEqual([...want.options])
        }
      })

      it('never renders the same key twice', () => {
        const keys = panelRowsOnScreen(s.cfg(), s.activeLayer).map((r) => r.spec.key)
        expect(new Set(keys).size).toBe(keys.length)
      })
    })
  }
})

// ── the bind menu reaches only bindable rows ─────────────────────────────────

/**
 * `bindable: false` is pinned per row above, but that only says what the SCHEMA
 * declares — it says nothing about whether the panel acts on it. StudioRow gates its
 * VariableGlyph on `bindable !== false` and yet emits `menu` from the row's
 * contextmenu unconditionally, so the surface has to do the gating itself or a
 * right-click offers the binding the glyph withholds.
 *
 * Asserting that needs the SURFACE, and the unit runner is `environment: 'node'` with
 * no Vue plugin, so the component's structure is asserted against its source — the
 * house pattern (`vectortype-solid-toggle`, `capsule-meta`). The data half below is a
 * real assertion: it is what makes ONE `bindable === false` test cover the anchors too.
 */
const SURFACE_SRC = readFileSync(
  fileURLToPath(new URL('../../app/components/vue-canvas/GradientStudioSurface.vue', import.meta.url)),
  'utf8',
)

describe('the bind menu is withheld wherever the bind glyph is', () => {
  it('builds every bespoke-block anchor as bindable:false', () => {
    const rows = gradientPanelControls(norm(defaultConfig('#parity')), 0)
    const anchors = rows.filter((c) => PANEL_ANCHOR_KEYS.has(c.key))
    expect(anchors.length).toBeGreaterThan(0)
    for (const a of anchors) expect(a.bindable, a.key).toBe(false)
  })

  it('leaves no non-bindable row reachable through the panel menu', () => {
    const cfg = stripe('stack')
    const suppressed = gradientPanelControls(cfg, 0).filter((c) => c.bindable === false).map((c) => c.key)
    // canvas.layout, every Shape slider, and the anchors — never a Collection binding.
    expect(suppressed).toContain('canvas.layout')
    expect(suppressed).toContain('layer.shape.count')
    for (const k of PANEL_ANCHOR_KEYS) if (gradientPanelControls(cfg, 0).some(c => c.key === k)) expect(suppressed).toContain(k)
  })

  it('gates the surface handler on bindable, not on the anchor list', () => {
    const handler = SURFACE_SRC.slice(SURFACE_SRC.indexOf('function onControlMenu'))
      .slice(0, SURFACE_SRC.slice(SURFACE_SRC.indexOf('function onControlMenu')).indexOf('\n}') + 2)
    expect(handler).toContain('bindable === false')
  })
})
