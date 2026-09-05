import type { ControlSpec } from '~/lib/spacetype/effect'
import { ASPECTS, BLEND_MODES, LAYOUTS, effectiveLayout, type GradientConfig } from './types'
import { GRADIENT_PRESET_NAMES } from './presets'
import { postControls, POST_SECTIONS } from '~/lib/studio/post/controls'

/**
 * The single declarative description of Gradient Studio's parameters.
 *
 * This list is the SOURCE. `gradientAgentControls` derives the agent vocabulary
 * from it and `motion.ts` derives animatable targets from it. The inspector UI
 * will derive from it in a follow-on change; today it is still hand-written.
 *
 * It is a SUPERSET, but each consumer is opt-OUT, not opt-in: a new slider is
 * agent-visible and motion-animatable by default. `agent: false` withholds a
 * control from the agent (used for the Shape block, which the agent has never
 * seen); `animatable: false` withholds a slider from motion. So adding a
 * control here silently grants it to BOTH capabilities unless you opt it out
 * of one. The agent side is guarded against surprise grants by frozen
 * characterization snapshots (gradientfx-controls.unit.spec.ts.snap); the
 * motion side is pinned the same way by gradientfx-motion-path.unit.spec.ts's
 * animatable-target-set snapshot.
 *
 * Keys are FROZEN: persisted Collection bindings are `params.<key>`, and
 * GRADIENT_GUIDANCE names keys in prose.
 */
export type GradientControl = ControlSpec & {
  when?: (cfg: GradientConfig) => boolean
}

/** Emission order. The legacy builder emitted strictly in this group order.
 *  POST_SECTIONS (Bloom, Color, Duotone, ...) is appended so the shared post
 *  stack's sections land after Focus — see the `post` field below. */
export const GRADIENT_SECTIONS = [
  'Preset', 'Canvas', 'Gradient', 'Curve', 'Colours', 'Flow', 'Liquid', 'Mesh', 'Shape', 'Relief', 'Layer', 'Focus',
  ...POST_SECTIONS,
] as const

const isRadial = (c: GradientConfig) => c.canvas.layout === 'radial' || c.canvas.layout === 'orbit'
const isStack = (c: GradientConfig) => c.canvas.layout === 'stack'
const isLiquid = (c: GradientConfig) => c.canvas.layout === 'liquid'
const isMesh = (c: GradientConfig) => c.canvas.layout === 'mesh'
const isSimple = (c: GradientConfig) =>
  c.canvas.layout === 'ramp' || c.canvas.layout === 'radialRamp' || c.canvas.layout === 'conic' || c.canvas.layout === 'curve'
const isCurve = (c: GradientConfig) => c.canvas.layout === 'curve'
// Banded = the stripe/ring family only. Was `!isLiquid && !isMesh` (exclusion),
// which would leak Shape/Relief/Margin onto the flat simple primitives.
const isBanded = (c: GradientConfig) =>
  c.canvas.layout === 'linear' || c.canvas.layout === 'radial' || c.canvas.layout === 'orbit' || c.canvas.layout === 'stack'
// Center offset is used by the stripe polar layouts AND the simple radial/conic.
const usesCenter = (c: GradientConfig) => isRadial(c) || c.canvas.layout === 'radialRamp' || c.canvas.layout === 'conic'
// Inner radius is NOT the same set on screen: the shipped panel gated it on
// `anyInnerRadius` (radial/orbit/radialRamp — "conic does NOT use innerRadius"),
// one layout narrower than usesCenter. That narrowing is PANEL-ONLY — see
// gradientPanelVisible — so the agent keeps the grant it has always had.
const usesInnerRadius = (c: GradientConfig) => isRadial(c) || c.canvas.layout === 'radialRamp'
const isRampLinear = (c: GradientConfig) => c.canvas.layout === 'ramp' || c.canvas.layout === 'conic'

/** Mirrors agentControls.ts's helper exactly, including the inert `default: 0`. */
function slider(
  key: string, label: string, min: number, max: number, step: number, group: string,
  hint?: string, extra: Partial<GradientControl> = {},
): GradientControl {
  return { key, label, kind: 'slider', min, max, step, default: 0, group, ...(hint ? { hint } : {}), ...extra } as GradientControl
}

export const GRADIENT_CONTROLS: GradientControl[] = [
  // --- Preset (agent-only macro; the surface has its own button row) --------
  { key: 'preset', label: 'Style preset', kind: 'select', options: [...GRADIENT_PRESET_NAMES], default: 'linear', group: 'Preset',
    hint: 'The overall look. marble/oil/ink/lava/satin = liquid surfaces; ripple/stack = concentric; mesh = soft blobs; linear = simple ramp. Set this to establish a style, then override colours/blur/grain. Leave it alone when only ADJUSTING an existing gradient.',
    summary: 1 },

  // --- Canvas --------------------------------------------------------------
  { key: 'canvas.aspect', label: 'Aspect ratio', kind: 'select', options: [...ASPECTS], default: '16:9', group: 'Canvas', hint: 'Output proportions' },
  // bindable:false — the shipped panel drew this as a LAYOUT_LABELS button grid, never
  // a BindableRow, so it never offered a Collection binding. Task 3 keeps it a row but
  // renders the grid through a `#control-canvas.layout` slot.
  { key: 'canvas.layout', label: 'Layout', kind: 'select', options: [...LAYOUTS], default: 'linear', group: 'Canvas', bindable: false, hint: 'Overall composition: linear/radial/orbit/stack/liquid/mesh' },
  slider('canvas.margin', 'Margin', 0, 0.45, 0.01, 'Canvas', undefined, { when: isBanded }),
  slider('canvas.innerRadius', 'Inner radius', 0, 0.9, 0.01, 'Canvas', undefined, { when: usesCenter }),
  slider('canvas.center.x', 'Center X', -0.5, 0.5, 0.01, 'Canvas', undefined, { when: usesCenter }),
  slider('canvas.center.y', 'Center Y', -0.5, 0.5, 0.01, 'Canvas', undefined, { when: usesCenter }),
  // Background sits BELOW the origin controls in the shipped panel (template 1032-1036).
  { key: 'canvas.background', label: 'Background', kind: 'color', default: '#000000', group: 'Canvas' },

  // --- Gradient axis (simple primitives: ramp / radialRamp / conic) ---------
  slider('layer.ramp.angle', 'Angle', 0, 360, 1, 'Gradient', 'Direction of the ramp (linear) / start rotation (conic)', { when: isRampLinear }),
  slider('layer.ramp.radius', 'Radius', 0.05, 2, 0.01, 'Gradient', 'Radial ramp size; 1 ≈ touches the frame edge', { when: (c) => c.canvas.layout === 'radialRamp' }),
  // label: template truth (9c20f8b72, GradientStudioSurface.vue:1066) — the visible
  // `<label>` read 'Shape', not 'Radial shape' (that string was only the BindableRow's
  // `label` prop, i.e. the promoted-variable display name, and got copied into the
  // row label by mistake during the retrofit).
  { key: 'layer.ramp.shape', label: 'Shape', kind: 'select', options: ['circle', 'ellipse'], default: 'circle', group: 'Gradient', when: (c) => c.canvas.layout === 'radialRamp', hint: 'Circle = aspect-corrected round; Ellipse = stretched to the frame' } as GradientControl,
  slider('layer.ramp.sweep', 'Sweep', 20, 360, 1, 'Gradient', 'Conic arc in degrees', { when: (c) => c.canvas.layout === 'conic' }),
  // bindable:false — shipped as a bare <input type="checkbox">, outside any BindableRow.
  { key: 'layer.ramp.closeLoop', label: 'Close loop', kind: 'switch', default: false, group: 'Gradient', when: (c) => c.canvas.layout === 'conic', bindable: false, hint: 'Wrap the ramp so the first and last colour meet seamlessly' } as GradientControl,

  // --- Curve (curve layout: a gradient that follows a parametric bezier) -----
  { key: 'layer.curve.mode', label: 'Mode', kind: 'select', options: ['along', 'outward'], default: 'along', group: 'Curve', when: isCurve, hint: 'Along = ramp runs down the curve; Outward = ramp fades sideways off it' } as GradientControl,
  { key: 'layer.curve.shape', label: 'Shape', kind: 'select', options: ['line', 'arc', 's-curve', 'wave', 'loop'], default: 'arc', group: 'Curve', when: isCurve } as GradientControl,
  slider('layer.curve.start.x', 'Start X', 0, 1, 0.01, 'Curve', undefined, { when: isCurve }),
  slider('layer.curve.start.y', 'Start Y', 0, 1, 0.01, 'Curve', undefined, { when: isCurve }),
  slider('layer.curve.end.x', 'End X', 0, 1, 0.01, 'Curve', undefined, { when: isCurve }),
  slider('layer.curve.end.y', 'End Y', 0, 1, 0.01, 'Curve', undefined, { when: isCurve }),
  slider('layer.curve.curvature', 'Curvature', 0, 1, 0.01, 'Curve', 'How much the curve bows', { when: (c) => isCurve(c) && c.layers?.[0]?.curve?.shape !== 'line' }),
  slider('layer.curve.bend', 'Bend', -1, 1, 0.01, 'Curve', 'Which side it bows', { when: (c) => isCurve(c) && c.layers?.[0]?.curve?.shape !== 'line' }),
  slider('layer.curve.waves', 'Waves', 1, 8, 1, 'Curve', undefined, { when: (c) => isCurve(c) && c.layers?.[0]?.curve?.shape === 'wave' }),
  slider('layer.curve.phase', 'Phase', 0, 1, 0.01, 'Curve', undefined, { when: (c) => isCurve(c) && c.layers?.[0]?.curve?.shape === 'wave' }),
  slider('layer.curve.width', 'Width', 0.02, 1, 0.01, 'Curve', 'Outward glow reach', { when: (c) => isCurve(c) && c.layers?.[0]?.curve?.mode === 'outward' }),
  { key: 'layer.curve.handles', label: 'Curve handles', kind: 'curveHandles', default: '', group: 'Curve', when: isCurve, agent: false } as GradientControl,

  // --- Repeat (simple primitives only — u_repeat is only read in the simple-primitive
  //     shader branch; it's a no-op on the 6 legacy layouts) / Falloff (every layout,
  //     baked into buildRampLut) ------------------------------------------------------
  { key: 'layer.color.repeat', label: 'Repeat', kind: 'select', options: ['once', 'mirror', 'tile'], default: 'once', group: 'Layer', when: isSimple, hint: 'Repeat the ramp: once / mirror (reflect) / tile ×N' } as GradientControl,
  slider('layer.color.repeatCount', 'Repeat count', 2, 16, 1, 'Layer', undefined, { when: (c) => isSimple(c) && (c.layers?.[0]?.color?.repeat ?? 'once') === 'tile' }),
  // The shipped panel hid this on mesh (mesh colours come from meshColorAt and never
  // sample the ramp LUT falloff shapes). PANEL-ONLY — gradientPanelVisible.
  { key: 'layer.color.falloff', label: 'Falloff', kind: 'select', options: ['linear', 'ease', 'smooth'], default: 'linear', group: 'Layer', hint: 'Ramp interpolation curve — smooth kills banding on long ramps' } as GradientControl,

  // --- Colours: runtime cardinality, synthesized in visibleGradientControls --

  // --- Flow (every layout) --------------------------------------------------
  slider('flow.angle', 'Flow angle', 0, 360, 1, 'Flow'),
  slider('flow.noiseScale', 'Noise scale', 0.5, 8, 0.1, 'Flow'),
  slider('flow.intensity', 'Noise intensity', 0, 100, 1, 'Flow', 'Strength of the liquid warp; 0 = flat gradient'),
  slider('flow.distortion', 'Curve distortion', 0, 100, 1, 'Flow'),
  slider('flow.detail', 'Detail', 1, 6, 1, 'Flow'),
  slider('flow.swirl', 'Swirl', 0, 100, 1, 'Flow'),
  slider('flow.speed', 'Flow speed', 0, 100, 1, 'Flow', 'Living drift speed (visible in video export)'),

  // --- Liquid only ----------------------------------------------------------
  slider('flow.depth', 'Depth', 0, 100, 1, 'Liquid', undefined, { when: isLiquid }),
  slider('flow.highlights', 'Highlights', 0, 100, 1, 'Liquid', undefined, { when: isLiquid }),
  slider('flow.shadows', 'Shadows', 0, 100, 1, 'Liquid', undefined, { when: isLiquid }),
  slider('flow.foldScale', 'Fold scale', 0, 100, 1, 'Liquid', undefined, { when: isLiquid }),
  slider('flow.gloss', 'Gloss', 0, 100, 1, 'Liquid', undefined, { when: isLiquid }),
  slider('flow.veins', 'Veins', 0, 100, 1, 'Liquid', undefined, { when: isLiquid }),
  slider('flow.veinScale', 'Vein scale', 0, 100, 1, 'Liquid', undefined, { when: isLiquid }),
  slider('flow.ripple', 'Ripple', 0, 100, 1, 'Liquid', undefined, { when: isLiquid }),
  slider('flow.refract', 'Refraction', 0, 100, 1, 'Liquid', undefined, { when: isLiquid }),
  slider('flow.viscosity', 'Viscosity', 0, 100, 1, 'Liquid', undefined, { when: isLiquid }),

  // --- Mesh only ------------------------------------------------------------
  slider('layer.mesh.softness', 'Softness', 10, 100, 1, 'Mesh', undefined, { when: isMesh }),
  slider('layer.mesh.contrast', 'Contrast', 0, 100, 1, 'Mesh', undefined, { when: isMesh }),
  slider('layer.mesh.blur', 'Blur', 0, 100, 1, 'Mesh', undefined, { when: isMesh }),
  slider('layer.mesh.drift', 'Drift', 0, 100, 1, 'Mesh', undefined, { when: isMesh }),

  // --- Shape: previously ORPHANED. Present in the surface, but never in the
  //     agent vocabulary. Declared here with `agent: false` so motion can
  //     derive from them without changing the agent's snapshot. Exposing them
  //     to the agent is a deliberate later step.
  //     Ranges mirror the surface's Shape sliders, except `sweep`, whose
  //     animation range intentionally exceeds the UI slider bound (see the
  //     `animatable` override below), and `count`, which the surface caps
  //     lower for the stack layout (40) than the range declared here (64) — that
  //     cap, and the two other dynamic captions, now live in gradientPanelOverride.
  //     Every row here carries `bindable: false`: the shipped Shape section wrote
  //     straight to the config and never offered a Collection binding.
  slider('layer.shape.phase', 'Wave phase', 0, 1, 0.01, 'Shape', undefined, { agent: false, bindable: false, when: isBanded }),
  slider('layer.shape.scrub', 'Scrub / rotate', 0, 1, 0.01, 'Shape', undefined, { agent: false, bindable: false, when: isBanded }),
  slider('layer.shape.peaks', 'Peaks', 1, 12, 1, 'Shape', undefined, { agent: false, bindable: false, when: isBanded }),
  slider('layer.shape.count', 'Count', 2, 64, 1, 'Shape', undefined, { agent: false, bindable: false, when: isBanded }),
  slider('layer.shape.minDepth', 'Min depth', 0, 1, 0.01, 'Shape', undefined, { agent: false, bindable: false, when: isBanded }),
  slider('layer.shape.curveExp', 'Curve exponent', 0.2, 3, 0.05, 'Shape', undefined, { agent: false, bindable: false, when: isBanded }),
  slider('layer.shape.jitter', 'Jitter', 0, 1, 0.01, 'Shape', undefined, { agent: false, bindable: false, when: isBanded }),
  // Slider bound is 20 but animation is allowed the full 0..360 — the one known
  // UI-vs-track divergence, declared once here instead of in two lists.
  slider('layer.shape.sweep', 'Sweep', 20, 360, 1, 'Shape', undefined, { agent: false, bindable: false, when: isBanded, animatable: { min: 0, max: 360 } }),
  slider('layer.shape.gap', 'Gap', 0, 0.8, 0.01, 'Shape', undefined, { agent: false, bindable: false, when: isBanded, animatable: { min: 0, max: 1 } }),
  slider('layer.shape.rounding', 'Rounding', 0, 1, 0.01, 'Shape', undefined, { agent: false, bindable: false, when: isBanded }),
  slider('layer.shape.valley', 'Valley position', 0, 1, 0.01, 'Shape', undefined, { agent: false, bindable: false, when: isBanded }),
  // Four Shape rows the shipped panel had and this schema was missing entirely.
  // Their `when` is narrow (rather than the block's blanket `isBanded`) on purpose:
  // a blanket gate would make them visible on the default stripe config and so add
  // four new paths to the FROZEN animatable-target snapshot. Narrow gates keep that
  // snapshot byte-identical while still giving the panel — and motion, on the layouts
  // that actually render them — the real rows.
  slider('layer.shape.detail', 'Detail', 1, 8, 1, 'Shape', undefined,
    { agent: false, bindable: false, when: (c) => isBanded(c) && !isStack(c) && (c.layers?.[0]?.shape?.type === 'noise') }),
  slider('layer.shape.rotStep', 'Rotation / ring', 0, 45, 1, 'Shape', undefined, { agent: false, bindable: false, when: isStack }),
  slider('layer.shape.pivot', 'Pivot', 0, 0.6, 0.01, 'Shape', undefined, { agent: false, bindable: false, when: isStack }),
  slider('layer.shape.ringScale', 'Disc size', 1, 2.2, 0.02, 'Shape', undefined, { agent: false, bindable: false, when: isStack }),

  // --- Relief ---------------------------------------------------------------
  // Grain retired (Task 8) — moved into the shared post stack's own Grain section
  // (postControls() below); relief.grain is now a deprecated, unrendered field.
  // The relief light shades the band/ring height field only: shaders.ts gates u_light
  // on `u_layout < 3.5`, and the liquid branch is explicit that it uses "its own light,
  // not u_light". The legacy agent builder had these under isLiquid — exactly inverted —
  // so the agent was offered them where they do nothing and denied them where they work.
  slider('relief.light.azimuth', 'Light angle', 0, 360, 1, 'Relief', undefined, { when: isBanded }),
  slider('relief.light.elevation', 'Light height', 0, 90, 1, 'Relief', undefined, { when: isBanded }),
  slider('relief.relief', 'Relief', 0, 1, 0.01, 'Relief', undefined, { when: isBanded }),

  // --- Layer ----------------------------------------------------------------
  // agent:false — per-layer layout is a picker operation, not agent-driven: the agent
  // writes to a single active layer and layer 0 is anchored to canvas.layout, so agent
  // control of a layer's type conflicts with that anchor. The agent controls the base
  // layout via canvas.layout; this select stays inspector-visible for the user.
  // bindable:false — same button grid as canvas.layout (setLayout writes to whichever
  // layer is selected), so it was never a bindable row either.
  { key: 'layer.layout', label: 'Layer type', kind: 'select', options: [...LAYOUTS], default: 'ramp', group: 'Layer', hint: "This layer's gradient type — stack different types across layers", agent: false, bindable: false } as GradientControl,
  { key: 'layer.blend', label: 'Blend', kind: 'select', options: [...BLEND_MODES], default: 'normal', group: 'Layer' },
  slider('layer.opacity', 'Opacity', 0, 1, 0.01, 'Layer'),
  // Both carry PANEL-ONLY layout gates (steps: non-mesh; hueDrift: non-mesh,
  // non-stack, non-liquid — the branches that never read u_hueDrift). See
  // gradientPanelVisible; the agent/motion grants are unchanged.
  slider('layer.color.steps', 'Posterize steps', 0, 24, 1, 'Layer', '0 = smooth; higher = banded'),
  slider('layer.color.hueDrift', 'Hue drift', -180, 180, 1, 'Layer'),
  slider('layer.color.hueRotate', 'Hue rotate', 0, 360, 1, 'Layer'),

  // --- Focus ----------------------------------------------------------------
  slider('focus.blur', 'Blur', 0, 100, 1, 'Focus', 'Soft-focus / defocus amount; 0 = perfectly sharp'),
  // optionLabels: template truth (9c20f8b72, GradientStudioSurface.vue ~1465-1467) —
  // the old native <select>'s three <option> texts, restored here after the retrofit
  // demoted them to one combined hint string.
  { key: 'focus.shape', label: 'Focus region', kind: 'select', options: ['off', 'radial', 'linear'],
    optionLabels: ['Off — blur everything', 'Radial — sharp spot', 'Linear — tilt-shift band'],
    default: 'off', group: 'Focus',
    hint: 'Off = blur the whole thing evenly; Radial = keep a round spot sharp; Linear = keep an angled band sharp (tilt-shift)' },
  slider('focus.radius', 'Focus size', 0, 1, 0.01, 'Focus', 'Size of the in-focus region (needs a radial/linear shape)'),
  slider('focus.softness', 'Focus falloff', 0, 100, 1, 'Focus', 'How gradually blur ramps in past the focus region'),
  slider('focus.x', 'Focus X', -0.5, 0.5, 0.01, 'Focus', 'Focus centre, left↔right'),
  slider('focus.y', 'Focus Y', -0.5, 0.5, 0.01, 'Focus', 'Focus centre, up↔down'),
  slider('focus.angle', 'Band angle', 0, 360, 1, 'Focus', undefined, { when: (c) => c.focus?.shape === 'linear' }),

  // --- Post (shared stack: bloom/color/duotone/chroma/blur/film/halftone/dotScreen/
  //     glitch/grain/vignette — ambient occlusion withheld, 2D host) ---------
  // post.grainAmount picks up summary rank 2 (the capsule readout's second field,
  // e.g. "aurora · grain 0.18") — the rank retired relief.grain's own slider used
  // to carry (Task 8). Tagged here rather than inside postControls() itself: that
  // function is shared by Texture/Shape too, and this capsule-summary behavior is
  // specific to how Gradient's collapsed node reads out, not a shared-stack default.
  ...postControls({ host: 'gl2d' }).map(c => c.key === 'post.grainAmount' ? { ...c, summary: 2 } : c),
]

/** Per-stop / per-mesh-point colour controls — runtime cardinality. */
function colourControls(cfg: GradientConfig): GradientControl[] {
  const colour = (key: string, i: number, hint?: string): GradientControl =>
    ({ key, label: `Colour ${i + 1}`, kind: 'color', default: '#ffffff', group: 'Colours', ...(hint ? { hint } : {}) } as GradientControl)
  const layer0 = cfg.layers[0]
  if (cfg.canvas.layout === 'mesh') {
    const pts = layer0?.mesh?.points ?? []
    return pts.map((_, i) => colour(`layer.mesh.points.${i}.color`, i,
      i === 0 ? 'The gradient colours, in order. Set these to recolour the whole gradient.' : undefined))
  }
  const stops = layer0?.color?.stops ?? []
  return stops.map((_, i) => colour(`layer.color.stops.${i}.color`, i,
    i === 0 ? 'The gradient colours, in ramp order (1 = start). Set these to recolour the whole gradient.' : undefined))
}

/**
 * Controls applicable to this config, in GRADIENT_SECTIONS order, with the
 * runtime colour block spliced into the Colours section. `preset` is omitted
 * unless explicitly requested (the in-studio copilot can't express a whole-
 * config swap; only the canvas tuner can).
 */
export function visibleGradientControls(
  cfg: GradientConfig,
  opts: { includePreset?: boolean } = {},
): GradientControl[] {
  const out: GradientControl[] = []
  for (const section of GRADIENT_SECTIONS) {
    if (section === 'Preset') {
      if (opts.includePreset) out.push(...GRADIENT_CONTROLS.filter((c) => c.group === 'Preset'))
      continue
    }
    if (section === 'Colours') { out.push(...colourControls(cfg)); continue }
    for (const c of GRADIENT_CONTROLS) {
      if (c.group !== section) continue
      if (c.when && !c.when(cfg)) continue
      out.push(c)
    }
  }
  return out
}

/**
 * Group order for the DESIGN half of the inspector (Preset is agent-only and the
 * post stack renders as its own panel below). This is the order the shipped
 * hand-written panel drew its cards in — NOT `GRADIENT_SECTIONS` order, which is
 * the legacy agent-emission order and puts Shape before Relief/Focus/Layer.
 *
 * Section TITLES are not 1:1 with these group names (the shipped panel folded
 * 'Gradient' + 'Colours' into one "Color" card and split 'Liquid' into two) — see
 * SECTION_TITLE_MAP in tests/unit/gradient-panel-parity.unit.spec.ts.
 */
export const GRADIENT_DESIGN_ORDER = [
  'Canvas', 'Gradient', 'Colours', 'Curve', 'Flow', 'Liquid', 'Mesh', 'Relief', 'Focus', 'Layer', 'Shape',
] as const

const SHAPE_STACK_ONLY = ['layer.shape.count', 'layer.shape.rotStep', 'layer.shape.pivot', 'layer.shape.ringScale']
const FOCUS_REGION_ROWS = ['focus.radius', 'focus.softness', 'focus.x', 'focus.y']

/**
 * PANEL-ONLY visibility: the extra gating the shipped hand-written inspector
 * applied on top of each control's own `when`.
 *
 * Why it is a separate predicate instead of more `when` clauses: `when` feeds
 * `visibleGradientControls`, which is ALSO the agent's vocabulary and motion's
 * animatable-target list. Folding these rules into `when` would silently withdraw
 * `layer.shape.sweep/valley/scrub` and `focus.radius/softness/x/y` from motion —
 * both pinned by frozen snapshots, and both genuinely animatable regardless of
 * which row the panel happens to be showing. So the panel gets the stricter view
 * and the two capability vocabularies keep theirs.
 *
 * Pass this (ANDed with `when`) as StudioControlPanel's `:visible`.
 * `activeLayer` matters: the shipped panel read the SELECTED layer's layout and
 * shape kind, and showed Blend/Opacity only for a non-base layer.
 */
export function gradientPanelVisible(c: ControlSpec, cfg: GradientConfig, activeLayer = 0): boolean {
  // Rows the shipped panel never drew as inspector rows at all.
  // layer.layout IS the Canvas layout button grid (setLayout writes the selected
  // layer); layer.curve.handles is the CurveHandleEditor drawn over the preview.
  if (c.key === 'layer.layout' || c.key === 'layer.curve.handles') return false

  // Blend/Opacity belonged to the active NON-base layer (template 1504-1521).
  if (c.key === 'layer.blend' || c.key === 'layer.opacity') return activeLayer > 0

  // The focus region's geometry is meaningless while the region is "off".
  if (FOCUS_REGION_ROWS.includes(c.key)) return (cfg.focus?.shape ?? 'off') !== 'off'

  // Conic reads u_center but never u_innerRadius (template 1010: "conic does NOT
  // use innerRadius"), so the shipped Canvas card was one layout narrower here.
  // NOTE this reads the CANVAS layout, which is the right answer for a single-layer
  // config only: on a stack the shipped row showed for `anyInnerRadius` (ANY layer).
  // The panel path answers it there instead — GLOBAL_ROW_RULES in panelPresentation.ts
  // short-circuits this branch — so what survives here is the single-layer contract the
  // parity spec's schema half pins.
  if (c.key === 'canvas.innerRadius') return usesInnerRadius(cfg)

  // Colour params the shipped "Color" card gated on the shader branch that reads
  // them: posterize + falloff are no-ops on mesh (meshColorAt never samples the
  // ramp LUT); u_hueDrift is referenced by the simple/curve, linear and
  // radial/orbit branches only — never stack, liquid or mesh.
  if (c.key === 'layer.color.steps' || c.key === 'layer.color.falloff') return !isMesh(cfg)
  if (c.key === 'layer.color.hueDrift') return !isMesh(cfg) && !isStack(cfg) && !isLiquid(cfg)

  if (c.group === 'Shape') {
    const layout = effectiveLayout(cfg, activeLayer)
    const type = (cfg.layers?.[activeLayer] ?? cfg.layers?.[0])?.shape?.type ?? 'bands'
    if (layout === 'stack') return SHAPE_STACK_ONLY.includes(c.key)
    switch (c.key) {
      case 'layer.shape.rotStep': case 'layer.shape.pivot': case 'layer.shape.ringScale': return false
      case 'layer.shape.peaks': case 'layer.shape.phase': return type === 'wave' || type === 'bands'
      case 'layer.shape.detail': return type === 'noise'
      // Two shipped rows write this one field: "Scrub" in the noise branch and
      // "Scrub / rotate" in the radial tail. Deduplicated to one row here.
      case 'layer.shape.scrub': return type === 'noise' || layout === 'radial' || layout === 'orbit'
      case 'layer.shape.valley': return type !== 'wave' && type !== 'bands' && type !== 'noise'
      case 'layer.shape.sweep': return layout === 'radial' || layout === 'orbit'
      default: return true
    }
  }
  return true
}

/**
 * PANEL-ONLY label / bound overrides — the three shipped rows whose caption or
 * range changed with the config (`:label="isStack ? 'Ring count' : 'Count'"`).
 * Kept out of the schema for the same reason as `gradientPanelVisible`: a second
 * same-key entry would make the agent's and motion's key sets non-unique.
 */
export function gradientPanelOverride(
  c: ControlSpec, cfg: GradientConfig, activeLayer = 0,
): { label?: string; max?: number } | undefined {
  if (c.group !== 'Shape') return undefined
  const layout = effectiveLayout(cfg, activeLayer)
  const type = (cfg.layers?.[activeLayer] ?? cfg.layers?.[0])?.shape?.type ?? 'bands'
  if (c.key === 'layer.shape.count' && layout === 'stack') return { label: 'Ring count', max: 40 }
  if (c.key === 'layer.shape.jitter' && type === 'bands') return { label: 'Randomness' }
  if (c.key === 'layer.shape.scrub' && type === 'noise') return { label: 'Scrub' }
  return undefined
}
