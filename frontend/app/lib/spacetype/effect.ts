import type * as THREE from 'three'
import type { ParamValue, Params } from '~~/shared/spacetype/state'

export type { ParamValue, Params } from '~~/shared/spacetype/state'

/** Optional metadata any control kind may carry. `hint` is a short semantic
 *  description used by the AI control copilot (and doubles as tooltip text).
 *  `aiEditable` overrides the kind-based default (slider/select/color/font are
 *  editable; text/textList/fillList/path are not).
 *  `showIf` hides the control unless another param matches — used for mode-specific
 *  controls (e.g. a second axis's controls that only apply in a 'crosshatch' mode). */
type ControlMeta = {
  hint?: string
  aiEditable?: boolean
  showIf?: { key: string; equals?: ParamValue; notEquals?: ParamValue; in?: ParamValue[]; notIn?: ParamValue[] }
  /**
   * Set false to declare a control in the schema while withholding it from the
   * agent's vocabulary. Used for controls the agent has never been offered, so
   * declaring them for motion/inspector purposes is not a silent expansion of
   * what the model can change. Defaults to true.
   */
  agent?: boolean
  /**
   * Motion-track eligibility for numeric controls. Sliders are animatable by
   * default; pass false to opt out, or an explicit range when animation should
   * allow more than the UI slider does (e.g. layer.shape.sweep: slider 20..360,
   * animation 0..360).
   */
  animatable?: boolean | { min: number; max: number }
  /**
   * Rank in the collapsed node capsule's read-out line. The two lowest ranks
   * render, in ascending order; absent means never shown. Opt-in like `agent`
   * and `animatable`, so declaring a control can never silently widen what a
   * capsule advertises.
   */
  summary?: number
  /**
   * Render this control in its section's HEADER rather than as a row in the body.
   * Only one per section; a `switch` is the only kind this makes sense for today.
   *
   * It exists so a section can be a thing you turn on — the post-effects panel gives
   * each effect its own section, with the effect's own enable in the header beside
   * the collapse chevron. The section then opens and closes with the switch, while
   * the chevron still lets you open a disabled one to set it up before enabling it.
   */
  sectionToggle?: boolean
  /** Opt this control out of Collection binding/promotion in the panel UI, even
   *  though its kind is bindable. Schema-level twin of the hand-written panels'
   *  `:bindable="false"` rows (Gradient's Shape section). Motion/agent are NOT
   *  affected — use `animatable`/`agent` for those. */
  bindable?: false
  /**
   * SOFT RANGE. Numeric rows only (`slider`; the other kinds have no range to
   * soften). `min`/`max` normally gate typed and keyed entry as well as drawing the
   * fill — right for almost everything, since the declared range IS the parameter's
   * domain. `entry: 'unclamped'` keeps the range for the LOOK (fill, handle
   * position, drag travel, click-to-position) and drops it from ENTRY: a typed
   * number and an arrow press may land outside it.
   *
   * For controls whose range is a general-purpose DESCRIPTION rather than a limit —
   * 3D Studio's Transform rows, where the gizmo puts an object at x = 35 while the
   * schema says ±20, and one clamped arrow press would rewrite it to 20 and fan the
   * −15 delta across the whole selection. Step snapping and NaN rejection are
   * unaffected in both modes: a soft range is not a soft parser.
   *
   * PRESENTATION only — stripped from every derived agent vocabulary the same way
   * `bindable` is, so opting a row in never changes what the model is offered.
   */
  entry?: 'unclamped'
}

export type ControlSpec = (
  | { key: string; label: string; kind: 'slider'; min: number; max: number; step: number; default: number; group: string }
  // A boolean toggle. Added because post-effect enables are booleans and modelling
  // them as a two-option select writes the STRING 'on' into a BOOLEAN field —
  // makeConfigParams' proxy writes through with no coercion, corrupting the doc.
  // See lib/scene3d/controls.ts's "Booleans" note: this kind is what closed that gap
  // for the shared schema (Scene3D's own booleans are still hand-omitted from ITS list).
  | { key: string; label: string; kind: 'switch'; default: boolean; group: string }
  | { key: string; label: string; kind: 'text'; default: string; group: string }
  // Multiple texts that the effect ALTERNATES per word-repeat/instance. Stored as one
  // newline-separated string in params (so ParamValue stays scalar); the surface renders
  // add/remove rows and the texture pipeline splits it into an N-row atlas.
  | { key: string; label: string; kind: 'textList'; default: string; group: string }
  // A list of "fills" (per-slot colour recipes: solid / gradient / grid / noise). Stored as one
  // JSON string in params; the surface renders a type dropdown + dependent colour pickers per row.
  // `textField: false` hides the per-row "Text" (textColor) picker for effects whose fill is a
  // pure paint/background with no separate text layer (e.g. slot's slot backgrounds), where
  // textColor would render as a dead control.
  | { key: string; label: string; kind: 'fillList'; default: string; group: string; textField?: boolean }
  // An ordered list of gradient stops (`[{pos,color},…]`). Stored as JSON text for
  // the same reason `fillList` is — `ParamValue` is scalar — and normalized back to
  // an array by the single `cleanStops` in ~/lib/shaderfx/params.ts, which accepts
  // either form so the text and the array are one canonical value, not two.
  // `maxStops` mirrors the consuming shader's array size.
  | { key: string; label: string; kind: 'gradientStops'; default: string; maxStops?: number; group: string }
  | { key: string; label: string; kind: 'color'; default: string; group: string }
  // `optionLabels`, when present, is positionally paired with `options` — index i's
  // display text for index i's stored value. Omitted (or shorter than `options`) falls
  // back to the raw option string for the missing slots. PRESENTATION only: the value
  // read/written/emitted is always the `options[i]` string, never the label — same
  // contract as `label` is to `key`. Stripped from every derived agent vocabulary
  // alongside `bindable`/`entry`, so the model always sees and writes raw option values.
  | { key: string; label: string; kind: 'select'; options: string[]; optionLabels?: string[]; default: string; group: string }
  | { key: string; label: string; kind: 'font'; default: string; group: string }
  // A shape from the shape library (~/lib/shapes/catalog). Stores a shape id or
  // 'none'. `allowNone: false` for consumers that always need a shape (a base
  // shape); the default (true) offers a None tile and lists 'none' to the agent.
  | { key: string; label: string; kind: 'shape'; default: string; allowNone?: boolean; group: string }
  | { key: string; label: string; kind: 'look'; default: string; group: string }
  // An interactive bézier path drawn on the preview (String effect). Stored as one JSON
  // string in params (StringPathDoc); the surface renders the StringPathEditor overlay.
  | { key: string; label: string; kind: 'path'; default: string; group: string }
  // A draggable cubic-bézier easing graph. Stored as a JSON string "[x1,y1,x2,y2]" (the two
  // control points; P0=(0,0), P3=(1,1)); the surface renders a CurveEditor.
  | { key: string; label: string; kind: 'curve'; default: string; group: string }
  // An ordered content list (words + images) for the ring layout. Stored as one JSON
  // string (`ContentItem[]`); the surface renders the content editor; the ring effect
  // parses it with `parseContent`.
  | { key: string; label: string; kind: 'contentList'; default: string; group: string }
  // A rich list of loft "stops" (position + profile params + colour), stored as one JSON string
  // (ParamValue is scalar). The surface renders ProfileStopsEditor; loft.ts parses it with parseStops.
  | { key: string; label: string; kind: 'profileStops'; default: string; group: string }
  // A parametric-curve handle overlay (Gradient curve layout). Renders CurveEditor.vue,
  // which drags start/end/curvature handles that write back to layer.curve.* dials.
  // Carries no value of its own — the curve lives in the numeric dials.
  | { key: string; label: string; kind: 'curveHandles'; default: string; group: string }
) & ControlMeta

/** Build the param object from a control list's declared defaults. */
export function defaultsFromControls(controls: ControlSpec[]): Params {
  const out: Params = {}
  for (const c of controls) out[c.key] = c.default
  return out
}

/**
 * Effects that render the bare word, not the tiled ribbon label — no trailing
 * gap, no separator. ONE definition: state.ts's texOptsFromState and the embed's
 * buildTexOpts both read this (they used to carry private copies).
 */
export const RAW_WORD_EFFECTS: ReadonlySet<string> = new Set(['coil', 'elastic', 'echo'])

/**
 * Effects that lay out individual letters via layoutChars and never sample the
 * tile texture as a whole — a separator painted into the tile would never show,
 * so they are excluded from separator controls until the per-glyph follow-up.
 */
export const PER_GLYPH_EFFECTS: ReadonlySet<string> = new Set(['blend', 'cascade', 'cylinder', 'onionburst', 'ring', 'slot'])

/**
 * The pluggable seam of the Space Type suite. Each effect declares its own
 * controls (so the surface auto-builds its UI), builds a Three.js scene graph
 * from a text texture + params, and advances that graph by normalized loop
 * time `t01 ∈ [0,1)`. Adding cylinder/field later = a new module implementing
 * this — no engine or surface changes.
 */
/** Render-target info passed to buildScene (e.g. the String effect maps a normalized
 *  drawn path into world space and needs the frame aspect). Optional — most effects ignore it. */
export interface BuildEnv {
  width: number; height: number; axes?: Record<string, number>
  /** Preloaded image textures keyed by ContentItem.src, for tile layouts. The
   *  build path is synchronous (withShaderFillContext), so images MUST be loaded
   *  by the caller (setImageTextures) before build; the effect only reads here. */
  imageTextures?: Map<string, import('three').Texture>
}

export interface SpaceTypeEffect {
  id: string
  label: string
  /** Hidden effects stay registered (saved configs still resolve) but don't appear in the picker. */
  hidden?: boolean
  controls: ControlSpec[]
  /** Build the scene root. Called when the effect or any structural param changes. */
  buildScene(three: typeof THREE, params: Params, textTexture: THREE.Texture, env?: BuildEnv): THREE.Object3D
  /** Advance the existing scene to normalized loop time t01. Pure in t01.
   *  `root` is the engine's currently-mounted scene root (the one this effect's buildScene
   *  returned for this engine/key). Effects that keep per-scene state MUST stash it on
   *  `root.userData` in buildScene and read it back from here — module-level state is shared
   *  across concurrent engines (card preview + headless frame source) and cached roots, so it
   *  freezes whichever surface didn't build last. Optional for effects that hold no state. */
  update(t01: number, params: Params, root?: THREE.Object3D): void
  /** Keys read live in update() each frame (vertex/uniform/transform params). Changing one
   *  should NOT trigger a structural rebuild. Omit → every key is treated as structural. */
  liveKeys?: string[]
  /** The distinct per-frame motion RATES (coefficients of t01, in whole cycles) this effect
   *  advances at — the seamless-loop export renders enough loops that ALL complete whole cycles.
   *  Must include every motion that multiplies t01, including per-ring/per-instance variations.
   *  Omit → exports as a single loop. */
  loopRates?(params: Params): number[]
}
