import type { ControlSpec } from '~/lib/spacetype/effect'
import { isFill } from '~/lib/compositor/paint'
// Both CPU-only by contract (see fillTile.ts's header) — no `three`, no DOM at
// module scope — so they are safe for the Collection control resolver and the
// node card, same as `shapefx/controls.ts` already assumes.
import { DEFAULT_FILL, FILL_TYPES, type Fill } from '~/lib/spacetype/fillTile'
// The seven blends the studios share — the SAME list `mergeLayer` whitelists
// against, so the picker cannot offer a mode the merge would throw away.
import { BLEND_MODES } from '~/lib/studio/blend'
// TYPE-ONLY, and it must stay that way: ./font.ts loads fontkit at module scope,
// while this module is pulled in by the Collection control resolver and every
// node card. A value import here would drag a font parser into both.
import type { VtAxis } from './font'
// Pure arithmetic over `./random` and `./words` — no canvas, no DOM, no font
// parser — so it clears the same CPU-only bar this module holds itself to.
import { VT_BLINK_RATE_MAX, VT_BLINK_SEED_MAX, VT_BLINK_UNITS } from './blink'
// Same bar, same reason: `./scatter.ts` is pure arithmetic over `./random` and
// the font's declared ranges, type-only against the font parser.
import {
  VT_SCATTER_DEFAULT_AXIS,
  VT_SCATTER_MODES,
  VT_SCATTER_RATE_MAX,
  VT_SCATTER_SEED_MAX,
  VT_SCATTER_SETTLE_MAX,
} from './scatter'
import {
  DEFAULT_CONFIG,
  LAYER_DEFAULTS,
  VT_ALIGNS,
  VT_ARC_MAX,
  VT_DEFAULT_STROKE_COLOR,
  VT_DEFAULT_STROKE_WIDTH,
  VT_EXTRUDE_DEPTH_MAX,
  VT_FILL_ANCHORS,
  VT_FITS,
  VT_HEIGHT_MAX,
  VT_HEIGHT_MIN,
  VT_RISE_CYCLES_MAX,
  VT_RISE_CYCLES_MIN,
  VT_RISE_MAX,
  VT_RISE_SEED_MAX,
  VT_RISE_SHAPES,
  VT_SKEW_MAX,
  VT_STAGGER_DELAY_MAX,
  VT_STAGGER_ORDERS,
  VT_STAGGER_SEED_MAX,
  VT_STRETCH_MAX,
  VT_STRETCH_MIN,
  type VectorTypeConfig,
  type VtAppearanceLayer,
} from './config'

/**
 * The single declarative description of Vector Type Studio's parameters.
 *
 * One list, four consumers: the agent's vocabulary (`agentControls.ts`), the
 * motion system's animatable targets (Task 6's `motion.ts`), Collection variable
 * bindings / sweeps (`lib/collection/studioControls.ts`), and the inspector UI
 * (`StudioControlPanel`). Declare a control once and all four pick it up; each
 * consumer opts OUT (`agent: false`, `animatable: false`) rather than in.
 *
 * Keys are dotted paths resolved by `makeConfigParams`, so each one must address
 * a real leaf on `VectorTypeConfig` — pinned by a test, because a key that does
 * not resolve is a control that silently does nothing.
 *
 * ## The axis controls are DERIVED, not declared
 *
 * Every other studio has a closed vocabulary. This one cannot: Inter declares 2
 * variation axes, Roboto Flex 13 (including `XOPQ`, `GRAD`, `YTAS`). You cannot
 * freeze what you do not know, and Collection bindings persist `params.<key>`.
 *
 * This is the same problem shader fills hit (63 catalog effects, each with its
 * own param list) and it takes the same answer — **declare the frame, derive the
 * contents** (`lib/shaderfill/controls.ts`, and the design doc
 * `docs/superpowers/specs/2026-07-26-shader-as-fill-design.md`):
 *
 *   fontId         <- DECLARED here, frozen forever, Collection-bindable
 *   axes.<tag>     <- DERIVED from the loaded font (`derivedAxisControls`)
 *
 * `fontId` never changes shape, so a binding against it is as safe as any
 * hand-authored control. The derived `axes.<tag>` keys are stable only PER FONT
 * — switching `fontId` changes which axes exist — and that instability is
 * inherent to what they represent, not a defect: there is no font-independent
 * "XOPQ" knob. A stale binding degrades to "ignored", never "wrong value
 * applied", because `clampCoords` (./font.ts) drops any tag the font does not
 * declare before the outline is ever asked for.
 *
 * The one structural difference from shader fills: they read their catalog from
 * a synchronous cache (`getEffectSync`), so `shapeAgentControls(cfg)` could keep
 * a one-argument signature. `loadVectorFont` exposes only promises, so the
 * loaded axes are passed IN — exactly as `shaderAgentControls(config, effectDef)`
 * already does for Shader Studio.
 */
export type VtControl = ControlSpec & {
  /** `layer` is the ACTIVE appearance layer, when the caller knows which one it
   *  is. Omit it and the predicate falls back to the stack's first layer — the
   *  headless "layer 0 is active" convention `studioTune` and the Collection
   *  resolver already assume for Gradient's `layer.` prefix. */
  when?: (cfg: VectorTypeConfig, layer?: VtAppearanceLayer | null) => boolean
}

/**
 * ## The `layer.` prefix — Gradient's relative-prefix pattern, adopted whole
 *
 * The appearance stack has RUNTIME cardinality: one config has one fill, the
 * next has three fills, two strokes and an extrude. Declaring N sets of controls
 * would mean the vocabulary changed shape with the data, which is exactly the
 * dynamic-vocabulary problem `derivedAxisControls` was written to dodge for the
 * axes and `lib/shaderfill/controls.ts` for the effect params.
 *
 * Gradient's answer, reused verbatim: declare the per-layer controls ONCE,
 * UNINDEXED, under a `layer.` prefix, and let each consumer expand it —
 *
 *   `makeConfigParams`  resolves `layer.x` against the ACTIVE layer, so the
 *                       inspector and the agent edit whichever layer is selected
 *                       and the key never changes shape;
 *   `animatableTargets` expands it to one absolute path PER layer, so motion
 *                       still reaches all of them.
 *
 * The inspector therefore shows the active layer's controls plus the stack — one
 * flat key list, whatever the stack looks like. Persisted Collection bindings are
 * `params.layer.paint.a`, which is stable across a reorder for the same reason.
 *
 * `makeConfigParams` takes the list name as a parameter (`'appearance'` here,
 * `'layers'` for Gradient and Shape) rather than assuming `layers`.
 */
export const VT_LAYER_PREFIX = 'layer.'

/** Emission order; a control whose group is not listed here is dropped.
 *  `Axes` is declared but carries no STATIC member — it is the slot the derived
 *  per-font sliders land in. That empty section is the "frame" being declared. */
export const VT_SECTIONS = ['Text', 'Font', 'Axes', 'Layout', 'Paint', 'Motion'] as const

/** The group every derived axis slider carries. Must be one of VT_SECTIONS. */
export const VT_AXES_GROUP = 'Axes'

/**
 * The layer a `layer.*` predicate is being asked about.
 *
 * Falls back to `appearance[0]`, matching what `makeConfigParams` resolves a
 * `layer.` key against when the host passes no active index — the headless
 * convention `studioTune`'s Gradient adapter already documents ("Layer 0 is the
 * headless active layer"). Optional-chained because a control list can be asked
 * for from a config straight out of storage, before `mergeConfig` rebuilt it.
 *
 * **Task 8 hand-off:** once `VectorTypeSurface` owns an active-layer ref it must
 * pass it to `visibleVtControls(cfg, active)` AND to `makeConfigParams`, or the
 * panel will gate its controls on layer 0 while editing layer N.
 */
const vtLayerOf = (c: VectorTypeConfig, l?: VtAppearanceLayer | null): VtAppearanceLayer | null =>
  l ?? c?.appearance?.[0] ?? null

const layerIsStroke = (c: VectorTypeConfig, l?: VtAppearanceLayer | null) => vtLayerOf(c, l)?.kind === 'stroke'
const layerIsExtrude = (c: VectorTypeConfig, l?: VtAppearanceLayer | null) => vtLayerOf(c, l)?.kind === 'extrude'

/**
 * An extrude that is asking for its copies to be FUSED — the only layer that can
 * carry a silhouette outline.
 *
 * The outline is one contour around the whole extruded body, which does not exist
 * until the copies have been united: stroking them individually would draw an
 * outline around EACH, i.e. internal seam lines through the block. So on a
 * `solid: false` extrude the width and the colour would be two knobs that
 * resolve, store, survive the merge and change not one pixel — the exact dead
 * control this schema exists to prevent. Gated on `solid`, they appear with the
 * capability.
 *
 * (`solid` itself is deliberately NOT a declared control — `ControlSpec` has no
 * boolean kind and `mergeLayer` reads a real boolean; its home is a stack row.
 * See the note at the bottom of the Paint section.)
 */
const layerIsSolidExtrude = (c: VectorTypeConfig, l?: VtAppearanceLayer | null) => {
  const L = vtLayerOf(c, l)
  return L?.kind === 'extrude' && L.solid === true
}

/** The two kinds `layer.width` is live on — a stroke layer's own outline, and a
 *  solid extrude's silhouette. One predicate so the width and its colour cannot
 *  be gated on two different readings of the same question. */
const layerHasWidth = (c: VectorTypeConfig, l?: VtAppearanceLayer | null) =>
  layerIsStroke(c, l) || layerIsSolidExtrude(c, l)

/**
 * The active layer's paint as a `Fill`, or null.
 *
 * `VtAppearanceLayer.paint` is a `Paint` — `string | Gradient | Fill`. Every
 * `layer.paint.*` control below addresses the `Fill` arm's own fields, so all of
 * them hang off this: on a `Gradient` (multi-stop / radial, which `Fill` cannot
 * express and `mergeConfig` deliberately preserves) `layer.paint.a` resolves to
 * nothing, and a control that resolves to nothing is a control that silently
 * does nothing. `mergeConfig` lifts a bare string, so the string arm is only
 * reachable from a config that has not been merged yet — which is exactly what
 * the optional chaining is for, same as `isShuffled` below.
 */
const vtFill = (c: VectorTypeConfig, l?: VtAppearanceLayer | null): Fill | null => {
  const paint = vtLayerOf(c, l)?.paint
  return isFill(paint) ? paint : null
}

/**
 * A SHADER fill's own `a` / `b` are never read.
 *
 * `effectiveTilePaint` (fillTile.ts:60) unwraps a `type: 'shader'` Fill to
 * `shader.input` and paints THAT — the outer Fill's colours are not consulted by
 * any renderer on the screen path. So `fill.a` on a shader fill is the exact
 * "control that resolves to nothing" this file withholds `stroke` and `fill.b`
 * for elsewhere: a tune like "make the fill red" writes a value that is stored,
 * survives the merge, and changes not one pixel.
 *
 * Task 8 already hid these two in the studio panel (`VectorTypeSurface.vue`'s own
 * `controlVisible`), but that predicate is the PANEL's — `vtAgentControls`,
 * `animatableTargets` and the Collection resolver all read `when` instead, so
 * the agent kept being offered both. Putting the rule here is what makes the four
 * consumers agree; the panel's copy is now redundant rather than contradicted.
 *
 * `fillHasAngle`/`fillHasDensity` below needed no change — neither list contains
 * `shader`, so those two were already withheld.
 */
const fillIsShader = (c: VectorTypeConfig, l?: VtAppearanceLayer | null) => vtFill(c, l)?.type === 'shader'
const fillIsFill = (c: VectorTypeConfig, l?: VtAppearanceLayer | null) => !!vtFill(c, l) && !fillIsShader(c, l)
// Mirrors shapefx/controls.ts:33-35 — the same three questions, asked of the
// same `Fill`. ONE deliberate difference: `gradient` is in `fillHasAngle` here.
// `fillTileBox`'s gradient arm reads `fill.angle` (fillTile.ts:306), so Shape
// Studio's list leaves a knob that DOES change the render unreachable from its
// own UI. Mirroring that would be mirroring a bug.
const fillNeedsB = (c: VectorTypeConfig, l?: VtAppearanceLayer | null) => {
  const f = vtFill(c, l)
  return !!f && f.type !== 'solid' && f.type !== 'shader'
}
const fillHasAngle = (c: VectorTypeConfig, l?: VtAppearanceLayer | null) => {
  const t = vtFill(c, l)?.type
  return t === 'gradient' || t === 'ombre' || t === 'stripes'
}
const fillHasDensity = (c: VectorTypeConfig, l?: VtAppearanceLayer | null) => {
  const t = vtFill(c, l)?.type
  return t === 'grid' || t === 'checkerboard' || t === 'stripes' || t === 'qr'
}

/** The shuffle seed only means anything for the shuffled order; shown for any
 *  other it is a knob whose effect the user can never see. Optional-chained
 *  because a control list can be asked for from a config straight out of
 *  storage, before `mergeConfig` has rebuilt the motion block. */
const isShuffled = (c: VectorTypeConfig) => c.motion?.stagger?.order === 'random'

/** Blink's own settings only mean something once something is blinking.
 *  `amount: 0` is the shipped default AND the off switch, so this is the same
 *  gate `isShuffled` applies to the shuffle seed — optional-chained for the same
 *  reason: a control list can be asked for from a raw stored blob. */
const blinksAtAll = (c: VectorTypeConfig) => (c.motion?.blink?.amount ?? 0) > 0

/** The scatter's own settings only mean something once something is scattering.
 *  Same gate, same reason, as `blinksAtAll`: `spread: 0` is both the shipped
 *  default and the off switch. */
const scattersAtAll = (c: VectorTypeConfig) => (c.motion?.scatter?.spread ?? 0) > 0
/** The two mode-specific knobs. A settle time on a wander and a drift rate on a
 *  settle are each a slider whose effect the user can never see — and unlike a
 *  gated blink knob they would sit RIGHT NEXT to the mode select that makes them
 *  dead, which reads as the mode being broken. */
const scatterSettles = (c: VectorTypeConfig) =>
  scattersAtAll(c) && (c.motion?.scatter?.mode ?? 'settle') !== 'wander'
const scatterWanders = (c: VectorTypeConfig) =>
  scattersAtAll(c) && (c.motion?.scatter?.mode ?? 'settle') === 'wander'

/** A baseline shape has been picked. `riseShape: 'off'` is the shipped default
 *  AND the off switch — the same arrangement blink's `amount: 0` and scatter's
 *  `spread: 0` have — so this is one question, not two. Optional-chained for the
 *  same reason as `blinksAtAll`: a control list can be asked for from a raw
 *  stored blob, before `mergeConfig` has filled the key in. */
const riseShapeChosen = (c: VectorTypeConfig) => (c?.riseShape ?? 'off') !== 'off'

/** A shape is picked AND it is moving something. The gate the shape-specific
 *  knobs take, never the one the Rise slider takes — see the asymmetry note at
 *  the controls below. */
const risesAtAll = (c: VectorTypeConfig) => riseShapeChosen(c) && (c?.rise ?? 0) !== 0

/** The two shape-specific knobs. Cycles and Phase describe a wave and nothing
 *  else; a seed only re-rolls a random arrangement. Shown on any other shape
 *  they would sit RIGHT NEXT to the select that makes them dead, which reads as
 *  the select being broken — the same trade `scatterSettles`/`scatterWanders`
 *  make one section down. */
const riseIsWave = (c: VectorTypeConfig) => risesAtAll(c) && c?.riseShape === 'wave'
const riseIsRandom = (c: VectorTypeConfig) => risesAtAll(c) && c?.riseShape === 'random'

const slider = (
  key: string, label: string, min: number, max: number, step: number, group: string,
  def: number, hint?: string, extra: Partial<VtControl> = {},
): VtControl =>
  ({ key, label, kind: 'slider', min, max, step, default: def, group, ...(hint ? { hint } : {}), ...extra } as VtControl)

const select = (
  key: string, label: string, options: string[], def: string, group: string,
  hint?: string, extra: Partial<VtControl> = {},
): VtControl =>
  ({ key, label, kind: 'select', options, default: def, group, ...(hint ? { hint } : {}), ...extra } as VtControl)

const color = (key: string, label: string, def: string, group: string, extra: Partial<VtControl> = {}): VtControl =>
  ({ key, label, kind: 'color', default: def, group, ...extra } as VtControl)

export const VT_CONTROLS: VtControl[] = [
  // --- Text -----------------------------------------------------------------
  // `kind: 'text'` is not AI-editable by default (controlDescriptor.ts) and that
  // default is kept: `validatePatch` has no branch for text, so an agent write
  // would be dropped silently anyway. It IS declared, because a Collection
  // binding maps `text` to a 'text' variable — sweeping a column of words
  // through the studio is the whole point of having it in the schema.
  { key: 'text', label: 'Text', kind: 'text', default: DEFAULT_CONFIG.text, group: 'Text' },

  // --- Font -----------------------------------------------------------------
  // `fontId` is a TOKEN now (`fontToken.ts`), not a closed catalog id: any of
  // the ten pinned ids, or a `google:`/`local:` cut of any other family. A
  // `select` can no longer enumerate the option set, so this is `text` kind —
  // same free-string shape as scene3d's Texture control — opted back INTO the
  // agent's vocabulary with `aiEditable: true` (off by default for `text`,
  // because most free strings are unsafe to hand the model; this one is safe
  // because `mergeConfig`'s `isVtFontToken` gate is the same one a save/reload
  // enforces, so a junk token degrades to the default rather than corrupting
  // the config).
  {
    key: 'fontId', label: 'Font', kind: 'text', default: DEFAULT_CONFIG.fontId, group: 'Font',
    aiEditable: true,
    // A different font is a different axis set, not a point on a scale: tweening
    // it would swap vocabularies mid-clip, not interpolate anything.
    animatable: false,
    hint: 'A font token: one of the ten pinned variable families by id (inter, roboto-flex, archivo, fraunces, recursive, bricolage, big-shoulders, space-grotesk, unbounded, source-serif — these have live axes), or `google:Family@Weight` for any Google family as one static cut, or `local:Family@Weight` for a licensed library face. Changing it changes WHICH AXES EXIST.',
  } as VtControl,

  // --- Layout ---------------------------------------------------------------
  slider('size', 'Size', 8, 600, 1, 'Layout', DEFAULT_CONFIG.size, 'Em size in output pixels (CSS font-size semantics).'),
  slider('tracking', 'Tracking', -200, 500, 1, 'Layout', DEFAULT_CONFIG.tracking,
    "Extra letter spacing in 1/1000 em; 0 = the font's own spacing, negative tightens."),
  select('align', 'Align', [...VT_ALIGNS], DEFAULT_CONFIG.align, 'Layout', 'Horizontal anchoring of the glyph run.'),
  // ── SKEW, and the hint is deliberately not flattering ──────────────────────
  // The `slnt` axis hint two hundred lines down says "a true oblique, not a
  // skew", and this studio means it: an oblique is drawn by the type designer,
  // with round counters and stems that keep their weight. A shear is a matrix
  // over finished geometry — circles become ellipses and horizontals thin out.
  // Saying "slants the type" here would leave the two reading as the same knob
  // and quietly recommend the worse one, so the hint names the trade and points
  // at the axis. What it is FOR is the two things `slnt` cannot do: it works on
  // every font, and it leans the whole COMPOSITION rather than each letter.
  //
  // Ungated: unlike an axis, there is no font for which this does nothing.
  // Animatable by default — `animatableTargets` admits any slider that does not
  // opt out, and a shear is a point on a scale, not a mode.
  slider('skewX', 'Skew X', -VT_SKEW_MAX, VT_SKEW_MAX, 1, 'Layout', DEFAULT_CONFIG.skewX,
    "Leans the WHOLE RUN sideways, in degrees — a shear over the finished outlines, so counters go oval and horizontal strokes thin. If the font has a Slant axis, that is the better tool: it is a true oblique the designer drew. Reach for this on a font with no such axis, or when you want the composition to lean rather than the letters."),
  slider('skewY', 'Skew Y', -VT_SKEW_MAX, VT_SKEW_MAX, 1, 'Layout', DEFAULT_CONFIG.skewY,
    'The same shear on the other axis: the run tilts vertically, rising or falling across its own width. No font axis does this one.'),
  // ── ARC — declared as SWEEP, which is the whole reason it is draggable ──────
  // `config.ts`'s own note says it: sweep and radius are the same bend said two
  // ways (`radius = runWidth / arcRadians`), and only one of them is a control.
  // A radius slider has its flat end at INFINITY — most of its travel does
  // nothing visible and "straight" is unreachable — where sweep is linear, its
  // flat end is exactly 0, and the sign flips the bow. ±360 is where the run's
  // two ends meet, so the range ends at a picture rather than at a taste call.
  //
  // The step is 1°, matching the two skew sliders: at a typical 300px run width
  // one degree of sweep moves the middle of the word by under half a pixel, so a
  // finer step would be offering precision the raster cannot show.
  //
  // Ungated, and ANIMATABLE by default — which is the point, and it is not free
  // by accident: the curve keeps its arc length as it bends (`vtRunCurve`), so
  // every glyph stays at the arc length its own advance puts it at and `arc: 0`
  // is byte-identical to the flat run. A track from 0 to 180 is therefore a
  // smooth unbending rather than a pop at the moment the curve appears.
  slider('arc', 'Arc', -VT_ARC_MAX, VT_ARC_MAX, 1, 'Layout', DEFAULT_CONFIG.arc,
    'Bends the baseline into an arc, in degrees of TOTAL SWEEP: 0 is straight, positive arches the word upward like a rainbow, negative bowls it downward, and ±360 closes it into a ring. The letters themselves are not bent — each one is moved onto the curve and turned to follow it, so the letterforms and the spacing are untouched.'),

  // ── STRETCH — typographic, not geometric ────────────────────────────────────
  // The whole point of Phase A: white space stretches, ink doesn't. The hint says
  // what the dial is NOT (a scale) because `scaleX`/`scaleY` motion exists and
  // does the cartoon thing; a user reaching for "wider letters" must land here.
  slider('stretch', 'Stretch', VT_STRETCH_MIN, VT_STRETCH_MAX, 0.01, 'Layout', DEFAULT_CONFIG.stretch,
    'Widens or condenses the LETTERS the way a type designer would draw a wider or narrower cut: counters and spacing take the change, stems keep their weight, rounds flatten their sides. Uses the font’s own Width axis first when it has one. Not a scale — for cartoon squash use the scale motion instead.'),
  slider('stretchY', 'Height', VT_HEIGHT_MIN, VT_HEIGHT_MAX, 0.01, 'Layout', DEFAULT_CONFIG.stretchY,
    'Makes the letters taller or squatter typographically: stems lengthen, arches and crossbars keep their thickness, every letter keeps the same x-height and cap height. Animate it per glyph for letters that spring up off the baseline.'),
  select('fit', 'Fit', [...VT_FITS], DEFAULT_CONFIG.fit, 'Layout',
    'Width: solves Stretch so the run fills the output width (minus a small margin) — the Stretch dial shows the solved value and follows the text. Off: Stretch is yours.',
    { animatable: false }),

  // ── BASELINE — one letter at its own height, which skew cannot do ─────────
  // Skew shears the WHOLE RUN by design (see its hint above), so between "the
  // word tilts as one piece" and "every letter sits exactly on the baseline"
  // there was nothing. This is the missing middle: a rigid per-glyph shift along
  // the glyph's own baseline normal, which is why on an arc'd run a raised
  // letter leaves ITS baseline rather than sliding down the screen.
  //
  // THE GATES ARE DELIBERATELY ASYMMETRIC, and it is worth saying why, because
  // the obvious arrangement is a trap. `risesAtAll` asks for a shape AND a
  // non-zero Rise. Hanging the Rise slider off it would hide the only control
  // that can make `rise` non-zero: from the shipped default a user picks a
  // shape, sees nothing happen, and has no dial to reach for. So Rise is gated
  // on the SHAPE ALONE (`riseShapeChosen`) — it is the shape's companion, the
  // one knob that must appear the instant a shape is picked — and only the
  // shape-SPECIFIC knobs (Cycles, Phase, Baseline seed) take the stricter
  // `risesAtAll`, since with the amount at 0 they describe a pattern that is
  // provably invisible and the fix is sitting immediately above them.
  //
  // Every control is therefore reachable from the default state by picking a
  // shape and then raising Rise; nothing is reachable only by editing the file.
  select('riseShape', 'Baseline shape', [...VT_RISE_SHAPES], DEFAULT_CONFIG.riseShape, 'Layout',
    'The pattern the letters sit in, up and down the baseline. Random gives every letter its own height; Wave rolls them smoothly up and down across the word; Ramp climbs steadily from the first letter to the last; Arch lifts the middle and drops the two ends; Zigzag puts every other letter up and the rest down. Off keeps the whole run on one baseline.',
    // A pattern, not a point on a scale — the same reason every other select
    // here opts out. Tweening 'arch' towards 'zigzag' interpolates nothing.
    {
      animatable: false,
      // Positional, paired to `VT_RISE_SHAPES` — the row reads `optionLabels[i]`
      // for `options[i]`. Sentence case, never the raw stored identifiers.
      optionLabels: ['Off', 'Random', 'Wave', 'Ramp', 'Arch', 'Zigzag'],
    }),
  slider('rise', 'Rise', -VT_RISE_MAX, VT_RISE_MAX, 0.01, 'Layout', DEFAULT_CONFIG.rise,
    'How far the letters move off the baseline, as a fraction of the type size rather than a pixel count — so the pattern keeps its proportion when Size changes, and 0.25 is a quarter of the type size at every size. Positive lifts the pattern; negative flips it, so an arch becomes a bowl and a climb becomes a fall. At 0 nothing moves, whichever shape is picked.',
    { when: riseShapeChosen }),
  slider('riseCycles', 'Cycles', VT_RISE_CYCLES_MIN, VT_RISE_CYCLES_MAX, 0.25, 'Layout', DEFAULT_CONFIG.riseCycles,
    'How many full ups-and-downs the wave makes across the word: 1 is a single rise and fall, 2 is two, and a quarter of a cycle is one plain climb. Higher values ripple the word rather than rolling it.',
    { when: riseIsWave }),
  slider('risePhase', 'Phase', 0, 360, 1, 'Layout', DEFAULT_CONFIG.risePhase,
    'Slides the wave along the word, in degrees, so different letters sit at the crests — the shape does not change, only which letter is at the top. 180 puts the dips where the peaks were; 360 is back where it started.',
    { when: riseIsWave }),
  slider('riseSeed', 'Baseline seed', 0, VT_RISE_SEED_MAX, 1, 'Layout', DEFAULT_CONFIG.riseSeed,
    'Re-rolls which letter gets which height, without changing how far apart they sit. The same seed always gives the same arrangement, which is what makes the export match the preview.',
    // Interpolating a seed is nonsense: it would sweep the word through every
    // arrangement between two pictures rather than moving between them.
    { animatable: false, when: riseIsRandom }),

  // --- Paint ----------------------------------------------------------------
  // The ACTIVE APPEARANCE LAYER's own keys, declared once under the `layer.`
  // prefix (see VT_LAYER_PREFIX above) rather than once per layer.
  //
  // Every one of them addresses a real leaf on `VtAppearanceLayer`, never inside
  // its `paint` — except the five that genuinely are `Fill` fields, which is why
  // they carry the extra `paint.` segment. `normalizePaint` rebuilds a `Paint`
  // field by declared field, so a per-layer property stored inside one survives
  // in memory and vanishes on the next load (trap 1).
  //
  // Defaults come from `DEFAULT_FILL`, not from a second hand-written copy: a
  // fresh layer's paint IS `{ ...DEFAULT_FILL }`, and reading the shared constant
  // is what keeps the picker's idea of "solid white" and the merge's from
  // drifting.
  select('layer.paint.type', 'Fill type', [...FILL_TYPES], DEFAULT_FILL.type, 'Paint',
    'How this layer is painted: a flat colour, a gradient, or one of the procedural patterns.',
    // A mode, not a point on a scale — the same reason `fontId` opts out.
    // (`animatableTargets` only ever offers sliders, so this is documentation
    // of intent rather than the mechanism; it is declared so the intent
    // survives a future consumer that reads the flag for other kinds.)
    { animatable: false }),
  color('layer.paint.a', 'Fill', DEFAULT_FILL.a, 'Paint', { when: fillIsFill }),
  // A second colour that paints nothing on a solid fill is a control whose
  // effect the user cannot see — the same trade Shape Studio's `fill.b` makes.
  color('layer.paint.b', 'Fill 2', DEFAULT_FILL.b, 'Paint', { when: fillNeedsB }),
  slider('layer.paint.angle', 'Fill angle', 0, 360, 1, 'Paint', DEFAULT_FILL.angle,
    'Direction of the gradient / ombre fade / stripes, in degrees.',
    { when: fillHasAngle }),
  slider('layer.paint.density', 'Fill density', 2, 32, 1, 'Paint', DEFAULT_FILL.density,
    'How many cells or stripes span the fill.',
    { when: fillHasDensity }),
  // NOT `layer.paint.anchor` — `normalizePaint` rebuilds every arm field by
  // declared field, so an anchor stored inside the paint is dropped on the next
  // load. It is a field on the LAYER. See `VtAppearanceLayer`'s doc.
  select('layer.anchor', 'Fill anchor', [...VT_FILL_ANCHORS], 'glyph', 'Paint',
    'Which box this layer is measured against: each glyph, the whole word, or the frame (so the type moves over a fill that stays put).',
    // A MODE. Tweening it would jump between sampling spaces rather than
    // interpolate anything — the same reason Space Type's own anchor is
    // withheld from motion.
    { animatable: false }),
  // Withheld unless the active layer can actually draw an outline: on a fill
  // layer a width paints nothing, which is the dead-control failure this schema
  // exists to prevent. The old flat `strokeWidth` was ungated and defaulted to 0,
  // so its companion colour control was withheld instead — the arrangement that
  // made the stroke invisible and prompted this whole change.
  //
  // TWO kinds now: a `stroke` layer's outline around the letterform, and a SOLID
  // `extrude`'s outline around the whole fused body — the silhouette. Same knob,
  // one level apart, so it is one control rather than two keys addressing one
  // leaf. The `default` here is the STROKE layer's (`VT_DEFAULT_STROKE_WIDTH`); a
  // fresh extrude stores `VT_DEFAULT_EXTRUDE_STROKE_WIDTH` (0) instead, because
  // an outline is what a stroke layer is FOR and one knob among five on an
  // extrude. `ControlSpec` carries one default; the per-kind pair lives in
  // `vtDefaultWidth`, which is what both build sites read.
  slider('layer.width', 'Stroke width', 0, 40, 0.5, 'Paint', VT_DEFAULT_STROKE_WIDTH,
    'Outline width in OUTPUT pixels, so it does not shrink with size. On a solid extrude it outlines the whole fused body — one silhouette, not one outline per copy.',
    { when: layerHasWidth }),
  // The silhouette's COLOUR, and only a colour — see `VtAppearanceLayer.strokeColor`
  // for why the extrude's outline is deliberately not the nine-type `Paint` a
  // stroke LAYER carries. On the layer, never inside its paint (trap 1).
  color('layer.strokeColor', 'Stroke color', VT_DEFAULT_STROKE_COLOR, 'Paint',
    { when: layerIsSolidExtrude }),
  // The EXTRUDE knobs, withheld unless the active layer IS an extrude — same
  // gate, same reason, as the stroke width above. An extrude layer draws the
  // glyph path `depth` more times behind the face (see `./extrude.ts`); the face
  // itself is whatever fill layer sits ABOVE it in the stack.
  slider('layer.depth', 'Extrude depth', 0, VT_EXTRUDE_DEPTH_MAX, 1, 'Paint', LAYER_DEFAULTS.depth,
    'How many offset copies of the letterform are drawn behind the face. 0 = none.',
    { when: layerIsExtrude }),
  // NOT the same knob as `layer.paint.angle`, and it shares its convention with
  // it on purpose: 0° steps right, 90° steps down, so two "angle" sliders in one
  // panel cannot rotate in opposite directions.
  slider('layer.angle', 'Extrude angle', 0, 360, 1, 'Paint', LAYER_DEFAULTS.angle,
    'Which way the extrude steps, in degrees. 0 is to the right, 90 is straight down.',
    { when: layerIsExtrude }),
  slider('layer.distance', 'Extrude distance', 0, 40, 0.5, 'Paint', LAYER_DEFAULTS.distance,
    'Pixels between consecutive copies, so the extrude reaches depth × distance.',
    { when: layerIsExtrude }),
  slider('layer.taper', 'Extrude taper', -1, 1, 0.01, 'Paint', LAYER_DEFAULTS.taper,
    'Shrinks the copies as they recede: 1 fades the far end to nothing, 0 keeps them all the same size, negative flares them outwards.',
    { when: layerIsExtrude }),
  // How strongly this layer's ink lands. Both were withheld until now for the
  // reason this file's header gives — a control that cannot be WRITTEN is as
  // dead as one that cannot be read, and until the stack panel existed there was
  // nowhere to write them from. Task 3 made them real on the canvas and Task 6
  // in the SVG; Task 8 is the panel, so they are declared in the same commit as
  // their UI, exactly as the header demands.
  //
  // Ungated on purpose: unlike `width` and the extrude knobs, these two mean the
  // same thing on all three kinds and paint on all three.
  slider('layer.opacity', 'Layer opacity', 0, 1, 0.01, 'Paint', LAYER_DEFAULTS.opacity,
    "How strong this layer's ink is in the stack. MULTIPLIES the glyph's own motion fade rather than replacing it, so a half-strength layer still fades out with the word."),
  select('layer.blend', 'Layer blend', [...BLEND_MODES], LAYER_DEFAULTS.blend, 'Paint',
    'How this layer composites onto the layers below it (and onto the background, which this studio draws straight onto).',
    // A MODE — tweening `multiply` towards `screen` interpolates nothing.
    { animatable: false }),
  // ── DRAW-ON ────────────────────────────────────────────────────────────────
  // The whole of the draw-on feature, declared once. Nothing else is needed: a
  // slider is animatable by default, so `animatableTargets` expands this to one
  // `appearance.<layerId>.draw` target per stroke layer and a 0 → 1 track is the
  // animation. That is the studio's own guarantee being spent rather than a
  // second motion mechanism — `f(cfg, t) → paths`, no engine to rebuild.
  //
  // GATED TO A STROKE LAYER, and it is a real gate rather than tidiness: a dash
  // acts on stroked ink and a `fill` layer has none, so on a fill this would
  // resolve, store, survive the merge and change not one pixel. A solid
  // extrude's silhouette is stroked and is still excluded — see the field's own
  // doc in `config.ts` for why a control that only appears once an async union
  // has landed is worse than no control.
  //
  // The step is 0.01, matching `layer.opacity`: the same 0..1 shape, and a
  // hundredth of a letter's outline is under a pixel at any size this studio
  // sets type at.
  slider('layer.draw', 'Draw on', 0, 1, 0.01, 'Paint', LAYER_DEFAULTS.draw,
    "How much of this outline is drawn, as a fraction of its longest contour — the letters drawing themselves. 1 is the whole stroke and is the default. It exports as a REAL `stroke-dasharray` / `stroke-dashoffset`, so a designer opening the SVG gets a dashed stroke they can restyle, not a clipped one. Animate it 0 → 1 (with a stagger, so the letters draw one after another).",
    { when: layerIsStroke }),
  // DELIBERATELY NOT DECLARED: `layer.solid`. It renders (Task 5 — the copies
  // fuse into one body on a bake or an export) but is a **boolean**, and
  // `ControlSpec` has no boolean kind. The house pattern for one is a `select`
  // over `['off','on']`, which works for Space Type because its params are
  // strings — here `mergeLayer` reads `typeof o.solid === 'boolean'` and drops
  // the string on the next load (trap 1's shape, one level out). So declaring it
  // as a select would ship a toggle that appears to work and forgets itself,
  // which is strictly worse than no control. Its home is a stack row, beside
  // `enabled` — the other boolean this schema deliberately does not declare.

  // --- Motion ---------------------------------------------------------------
  // Task 9: `VectorTypeSurface.vue`'s Motion tab is now the shared moves panel
  // (`~/components/vue-canvas/motion/moves/MovesPanel.vue`), not a
  // `StudioControlPanel` over this group — so nothing below renders through
  // `#section-Motion` any more. The stagger trio draws in the panel's Clip
  // block, through `~/lib/vectortype/movesAdapter.ts`'s `clipExtras`
  // (`VtStaggerClipExtras.vue`); Blink and Scatter draw inside their own
  // move cards, through that same adapter's `KINDS.blink/scatter.cardBody`.
  // Neither reads a control by walking this array — both are small
  // hand-written components, since a card body/clipExtras only ever receives
  // `{ move?, cfg }`, not the surface's `setControl`/`boundFor`/StudioRow
  // machinery. The declarations stay: the agent vocabulary, Collection
  // bindings and `animatableTargets` all still read this array by key, and a
  // card body's `patch-cfg` is routed back through `setControl` for the same
  // keys, so a bound column still writes through.
  //
  // Stagger is NOT a track: it shifts the clock each glyph reads the tracks at.
  // So it is `animatable: false` on purpose — a track pointing at the stagger
  // block would be asking the timeline to rewrite its own reader mid-frame.
  slider('motion.stagger.delay', 'Stagger', 0, VT_STAGGER_DELAY_MAX, 0.01, 'Motion',
    DEFAULT_CONFIG.motion.stagger.delay,
    'Seconds between glyphs. 0 = every glyph animates on one clock; raise it and a track becomes a wave travelling across the word.',
    { animatable: false }),
  select('motion.stagger.order', 'Stagger order', [...VT_STAGGER_ORDERS], DEFAULT_CONFIG.motion.stagger.order, 'Motion',
    'Which glyph goes first: forward, reverse, center (middle outwards), edges (outermost inwards), or random.'),
  slider('motion.stagger.seed', 'Shuffle seed', 0, VT_STAGGER_SEED_MAX, 1, 'Motion',
    DEFAULT_CONFIG.motion.stagger.seed,
    'Re-rolls the random order. The shuffle is seeded, so the same seed always gives the same order — that is what keeps a bake from flickering.',
    { animatable: false, when: isShuffled }),

  // ── BLINK ──────────────────────────────────────────────────────────────────
  // Five knobs, but only ONE of them is on screen until the effect is switched
  // on: `Blink` at 0 means off (and is the shipped default), so the other four
  // are gated on it the way `Shuffle seed` is gated on the shuffled order. A
  // panel of blink settings above a blink that is not running is four controls
  // whose effect the user cannot see.
  //
  // The first three ARE animatable, and that is not incidental — a track on
  // `motion.blink.amount` is how a sign fails over the length of a clip rather
  // than flickering evenly from the first frame. `./blink.ts`'s `vtResolveBlink`
  // reads them off the tracks directly, the way `vtEmSize` reads `size`.
  slider('motion.blink.amount', 'Blink', 0, 1, 0.05, 'Motion',
    DEFAULT_CONFIG.motion.blink.amount,
    'How much of the word takes part in each blink. 0 switches the whole effect off; 1 puts every letter (or word) in the rotation. What you see dark AT ANY INSTANT is this times the share of the beat that is dark — raise Stay lit and fewer are out at a time.'),
  slider('motion.blink.rate', 'Blink rate', 0, VT_BLINK_RATE_MAX, 0.5, 'Motion',
    DEFAULT_CONFIG.motion.blink.rate,
    'Blinks per second. Each beat re-picks who drops out, so this is the pulse of the effect rather than its speed. 0 stops it.',
    { when: blinksAtAll }),
  slider('motion.blink.stayLit', 'Stay lit', 0, 1, 0.05, 'Motion',
    DEFAULT_CONFIG.motion.blink.stayLit,
    'How much of each beat a letter stays lit before it drops out — the duty cycle. 1 never goes dark at all; 0.9 is a brief nervous stutter; 0 holds it dark for the whole beat.',
    { when: blinksAtAll }),
  select('motion.blink.unit', 'Blink unit', [...VT_BLINK_UNITS], DEFAULT_CONFIG.motion.blink.unit, 'Motion',
    'What drops out as one thing: a single letter, or a whole word at a time. Spaces separate words; commas and hyphens do not, so a word takes its punctuation with it.',
    { when: blinksAtAll }),
  slider('motion.blink.seed', 'Blink seed', 0, VT_BLINK_SEED_MAX, 1, 'Motion',
    DEFAULT_CONFIG.motion.blink.seed,
    'Re-rolls which letters blink and when, without changing how many or how often. Seeded, so the same seed always gives the same blink — that is what makes the export match the preview frame for frame.',
    { animatable: false, when: blinksAtAll }),

  // ── SCATTER ────────────────────────────────────────────────────────────────
  // Every letter at its OWN weight (or width, or slant). The one control that is
  // NOT here is the AXIS — it is derived from the loaded font, because Inter
  // declares 2 and Roboto Flex 13 and there is no font-independent list to
  // freeze. Same "declare the frame, derive the contents" split as the axis
  // sliders above; see `derivedScatterControls`.
  //
  // `Scatter` is the master and the switch, exactly as `Blink` is, so the panel
  // reads "Scatter 0.4" rather than "Scatter spread 0.4" and dragging it to 0 is
  // how the effect is turned off. Everything else is gated behind it.
  slider('motion.scatter.spread', 'Scatter', 0, 1, 0.05, 'Motion',
    DEFAULT_CONFIG.motion.scatter.spread,
    "How far apart the letters land on the chosen axis, as a share of THAT AXIS'S OWN range — so 0.4 means the same amount of variation on a 100–1000 weight axis as on a −200–150 grade one. 0 switches the whole effect off; 1 spreads the word across the entire axis. Near an end of the axis the swing is squeezed into the room that is left rather than piling letters up on the limit."),
  // A MODE, and the two directions are not interchangeable — see `./scatter.ts`.
  // Tweening it would interpolate nothing, so it opts out of motion like every
  // other select here.
  select('motion.scatter.mode', 'Scatter mode', [...VT_SCATTER_MODES], DEFAULT_CONFIG.motion.scatter.mode, 'Motion',
    'Settle: the letters start scattered and resolve onto the values you set — an entrance, and it ends exactly on your design. Wander: the letters start on your design and drift off to their own positions, each at its own pace, and keep going.',
    { animatable: false, when: scattersAtAll }),
  slider('motion.scatter.settle', 'Settle time', 0, VT_SCATTER_SETTLE_MAX, 0.05, 'Motion',
    DEFAULT_CONFIG.motion.scatter.settle,
    'Seconds from fully scattered to your own values, decelerating into place. With a Stagger on, this is how long EACH letter takes and they set off one after another. 0 means there is nothing to settle from.',
    { when: scatterSettles }),
  slider('motion.scatter.rate', 'Drift rate', 0, VT_SCATTER_RATE_MAX, 0.05, 'Motion',
    DEFAULT_CONFIG.motion.scatter.rate,
    'How fast the letters drift, in cycles per second. Each letter also gets its own multiplier, so they never all come back together after the first frame. 0 stops the drift, which leaves the word exactly as you set it.',
    { when: scatterWanders }),
  slider('motion.scatter.seed', 'Scatter seed', 0, VT_SCATTER_SEED_MAX, 1, 'Motion',
    DEFAULT_CONFIG.motion.scatter.seed,
    'Re-rolls where each letter lands and how fast it drifts, without changing how far apart they are. Seeded, so the same seed always gives the same scatter — that is what makes the export match the preview frame for frame.',
    { animatable: false, when: scattersAtAll }),
]

/**
 * Controls applicable to this config, in VT_SECTIONS order. Static only — the
 * per-font axis sliders come from `derivedAxisControls`, which needs a loaded
 * font this function has no access to.
 *
 * `active` is the index of the appearance layer the `layer.*` keys are being
 * asked about, and it must match whatever index the caller gave
 * `makeConfigParams` — a control gated on layer 0 while the proxy writes to
 * layer 2 is a control that appears and disappears for the wrong reasons.
 * Defaults to 0, the headless convention.
 */
export function visibleVtControls(cfg: VectorTypeConfig, active = 0): VtControl[] {
  const layer = cfg?.appearance?.[active] ?? null
  const out: VtControl[] = []
  for (const section of VT_SECTIONS) {
    for (const c of VT_CONTROLS) {
      if (c.group !== section) continue
      if (c.when && !c.when(cfg, layer)) continue
      out.push(c)
    }
  }
  return out
}

/** Short semantic notes for the axis tags a user is least likely to recognise.
 *  Anything not listed falls back to a generic hint naming the tag. */
const AXIS_HINTS: Record<string, string> = {
  wght: 'Weight — thin to black, as real outline geometry.',
  wdth: 'Width — condensed to extended.',
  opsz: 'Optical size — the cut the designer intended at this size.',
  // There is now a Skew X slider in Layout, so this line has a companion rather
  // than an absent one. It still says which is better — the axis re-draws the
  // letterforms, the slider shears them — and it stays the FIRST thing offered
  // wherever the font declares the axis.
  slnt: 'Slant — a true oblique the designer drew, not the Skew X shear in Layout. Prefer this one.',
  ital: 'Italic — the font\'s own italic forms where it has them.',
  GRAD: 'Grade — weight WITHOUT changing the width the text occupies.',
  XOPQ: 'Thick stroke — thickness of the vertical strokes.',
  YOPQ: 'Thin stroke — thickness of the horizontal strokes.',
  XTRA: 'Counter width — the space inside the letters.',
  YTAS: 'Ascender height.',
  YTDE: 'Descender depth.',
  YTUC: 'Uppercase height.',
  YTLC: 'Lowercase height (x-height).',
  YTFI: 'Figure height.',
  SOFT: 'Softness — how rounded the terminals are.',
  WONK: 'Wonk — the quirkier alternate forms.',
  CASL: 'Casual — upright to relaxed handwriting-ish.',
  CRSV: 'Cursive — connected letterforms.',
  MONO: 'Mono — proportional to monospaced.',
}

/** Sub-unit axes (CASL/WONK, 0..1) need a fine step; wght-style ranges do not. */
function axisStep(a: VtAxis): number {
  const span = a.max - a.min
  if (span <= 2) return 0.01
  if (span <= 20) return 0.1
  return 1
}

/**
 * One slider per axis the loaded font declares, addressed at `axes.<tag>` — the
 * REAL path into `VectorTypeConfig.axes`, so `makeConfigParams` and
 * `getByPath`/`setByPath` land on the stored value with no translation layer.
 * (Shader fills paid for this lesson: a reserved `.p.` segment one step off the
 * real path wrote to a phantom object and never reached the renderer.)
 *
 * Sliders are animatable by default, which is the point — every axis of every
 * font becomes a motion target without this function opting in per-tag.
 *
 * Pass `font.axes` from a loaded `VtFont`; the ranges and defaults are the
 * FILE's `fvar`, not the catalog's curated subset, so exotic axes appear too.
 */
export function derivedAxisControls(axes: VtAxis[]): ControlSpec[] {
  const out: ControlSpec[] = []
  for (const a of axes ?? []) {
    // A zero-width axis cannot be dragged and would break the "max > min"
    // invariant every slider consumer assumes. `normaliseAxes` allows it
    // (it only rejects max < min); this is where it stops.
    if (!(a.max > a.min)) continue
    out.push({
      key: `axes.${a.tag}`,
      label: a.name || a.tag,
      kind: 'slider',
      min: a.min,
      max: a.max,
      step: axisStep(a),
      default: a.default,
      group: VT_AXES_GROUP,
      hint: AXIS_HINTS[a.tag] ?? `Variable axis ${a.tag} — real outline geometry.`,
    })
  }
  return out
}

/**
 * WHICH AXIS the per-glyph scatter aims at, derived from the loaded font.
 *
 * The same split as `derivedAxisControls`, one level up: the KEY
 * `motion.scatter.axis` is declared and frozen (a Collection binding against it
 * is as safe as any hand-authored control), and the OPTION LIST is derived,
 * because there is no font-independent set of axis tags to freeze — Inter
 * declares 2, Roboto Flex 13. A hand-written list would offer `GRAD` on a font
 * that has never heard of it.
 *
 * Only axes the font can actually be dragged along are offered (`max > min`, the
 * same rule `derivedAxisControls` applies), so picking from this list can never
 * produce the unavailable case. A STORED tag the font lacks is a different
 * matter and is kept rather than rewritten — `vtScatterAvailability` says so in
 * a sentence, matching how a missing axis PRESET is greyed out with its reason.
 *
 * Empty before a font has loaded, and empty while the scatter is switched off —
 * the same two gates every other knob in this block takes, so the panel does not
 * show an axis picker for an effect that is not running.
 */
export function derivedScatterControls(cfg: VectorTypeConfig, axes: VtAxis[]): VtControl[] {
  if (!scattersAtAll(cfg)) return []
  const usable = (axes ?? []).filter(a => a && a.max > a.min)
  if (!usable.length) return []
  const tags = usable.map(a => a.tag)
  // `wght` when the font has it — the axis a scatter means by default, and the
  // one every family in the catalog declares — otherwise whatever this font
  // leads with, so the default is never a tag the font cannot run.
  const def = tags.includes(VT_SCATTER_DEFAULT_AXIS) ? VT_SCATTER_DEFAULT_AXIS : tags[0]!
  return [
    select('motion.scatter.axis', 'Scatter axis', tags, def, 'Motion',
      `Which variable axis the letters scatter along. This font offers ${tags.join(', ')}. Weight and slant read most clearly; on a font that has it, GRAD scatters the letters WITHOUT moving any of them, because grade changes weight without changing the width the text occupies.`,
      // A tag, not a point on a scale: tweening `wght` towards `opsz` would
      // interpolate between two vocabularies rather than between two values.
      { animatable: false }) as VtControl,
  ]
}

/**
 * EVERYTHING derived from the loaded font — the per-axis sliders and the
 * scatter's axis picker — as one call.
 *
 * There is one of these because there are four consumers (the inspector panel,
 * the agent vocabulary, the Collection bindable list and `animatableTargets`)
 * and a fifth will arrive. A consumer that called `derivedAxisControls` and
 * forgot the second half would offer a `Scatter` slider with no way to say which
 * axis it scatters — the shape of failure this studio has already paid for once
 * with a shared catalog and one un-updated consumer.
 */
export function derivedVtControls(cfg: VectorTypeConfig, axes: VtAxis[] = []): ControlSpec[] {
  return [...derivedAxisControls(axes), ...derivedScatterControls(cfg, axes)]
}

/**
 * Domain guidance injected into the /api/vibe prompt. Owned here, co-located
 * with the schema it describes.
 *
 * Every control key it names is backticked and pinned by a test — prose that
 * teaches the model a key which does not exist teaches it to emit patches
 * `validatePatch` will silently drop.
 */
export const VT_GUIDANCE = `This is a VECTOR TYPE studio: real glyph OUTLINES pulled from a VARIABLE font and animated as geometry. Not a raster text layer, not 3D type.

THE FONT COMES FIRST. \`fontId\` picks the typeface, and it decides WHICH AXES EXIST — change it before touching any axis, never after. It takes one of three shapes: a pinned id (inter, roboto-flex, archivo, fraunces, recursive, bricolage, big-shoulders, space-grotesk, unbounded, source-serif) for a family with live variable axes; google:Family@Weight for any other Google family as one static cut with NO axes; or local:Family@Weight for a licensed library face, also with no axes. Prefer a pinned id whenever the axes matter to the request.

AXES ARE THE POINT. Every axis the chosen font declares is a live slider at \`axes.<tag>\`: the familiar ones are \`axes.wght\` (weight), \`axes.wdth\` (width), \`axes.opsz\` (optical size) and \`axes.slnt\` (slant), and Roboto Flex adds the rare ones — \`axes.GRAD\` (grade: weight without changing the width the text occupies), \`axes.XOPQ\` (thick-stroke thickness), \`axes.XTRA\` (counter width), \`axes.YTAS\` (ascender height), \`axes.YTLC\` (x-height). These interpolate the OUTLINE itself, so reach for an axis before faking weight with an outline. Only tags the current font declares exist; anything else is ignored.

LAYOUT. \`size\` is the em size in output pixels. \`tracking\` is extra letter spacing in 1/1000 em (0 = the font's own spacing, negative tightens). \`align\` anchors the run horizontally.

SKEW LEANS THE WHOLE RUN, and it is the CRUDER way to slant type. \`skewX\` shears the run sideways in degrees and \`skewY\` tilts it vertically; both apply to the composition as one piece, so the word leans rather than each letter leaning inside an upright word. When the user asks for italic or slanted type and the font declares a slant axis, reach for \`axes.slnt\` FIRST — that is a true oblique the type designer drew, with round counters and even stems, where a shear stretches the finished outlines into ovals and thins the horizontals. Use skew when the font has no slant axis, when the user explicitly asks to skew or shear, or when the whole block of type should lean. \`skewY\` has no font-axis equivalent at all.

ARC BENDS THE BASELINE. \`arc\` is the total sweep in DEGREES, not a radius: 0 is a straight line, positive arches the word upward like a rainbow, negative bowls it downward, and ±360 closes the run into a full ring. Reach for it whenever the user asks for curved, arched, bowed, circular or badge-style type. Only the BASELINE bends — every letter is moved onto the curve and turned to follow it, so the letterforms and the letter spacing are exactly what they were on the straight run, and there is no separate radius to set: the word keeps its own length, so a longer word on the same sweep simply describes a bigger circle. A gentle headline arch is roughly 20 to 60; a half-circle is 180; a seal or a badge is at or near 360. Combine it with \`skewX\` freely — the run bends first and the whole bent composition then leans.

STRETCH IS TYPOGRAPHIC, NOT A SCALE. \`stretch\` (width) and \`stretchY\` (height) redraw the word the way a designer draws a wider, narrower, taller or squatter cut: counters and spacing take the change, stems and crossbars keep their weight, rounds flatten their sides, every letter keeps the same x-height. For "make the letters wider" reach for \`stretch\`; for cartoon squash-and-stretch use the scaleX/scaleY motion instead. Move ONE dial at a time — the engine is proven at single-axis extremes (Stretch 0.6–1.8, Height 0.6–2.0) and the studio eases the second dial when both are pushed. \`fit\` set to "width" makes the run fill the box; then \`stretch\` follows the text and is not yours to set.

BASELINE PUTS EVERY LETTER AT ITS OWN HEIGHT, and it is the answer whenever \`skewY\` looks like one. \`riseShape\` is the pattern and the switch: "off" is the default, and picking a shape gives each letter its own position up or down the baseline — reach for it whenever the user asks for letters at different heights, bouncing or jumping letters, a ransom-note or hand-lettered look, letters off the baseline, letters that do not line up, or a wavy word. \`skewY\` is the WRONG answer to every one of those: it tilts the whole run as one piece, so the composition leans while every letter stays exactly on the one baseline it shares with its neighbours. The five shapes are "random" (each letter its own height), "wave" (a smooth roll up and down across the word), "ramp" (a steady climb from the first letter to the last), "arch" (the middle lifted, both ends dropped) and "zigzag" (every other letter up, the rest down). \`rise\` is HOW FAR, as a fraction of the type size rather than a pixel count, so a design holds its proportions at any \`size\` — 0 moves nothing whatever the shape is, positive lifts the pattern and negative flips it, turning an arch into a bowl and a climb into a fall; 0.05 is a subtle unevenness and 0.3 is letters visibly bouncing. \`riseCycles\` is how many full ups-and-downs a wave makes across the word and \`risePhase\` slides that wave along in degrees; both apply to "wave" only. \`riseSeed\` re-rolls the random arrangement without changing how far the letters spread, and applies to "random" only. Only the letters move — the spacing, the letterforms and the run's measured width are untouched, so this is a baseline shift and not a layout change — and on an arc'd run a raised letter leaves ITS OWN baseline, outward from the curve, rather than sliding down the screen. Combine it with \`arc\`, \`stretch\` or a scatter freely; they each act on something different.

STAGGER MAKES IT KINETIC. \`motion.stagger.delay\` is the gap in seconds between one glyph and the next; at 0 the whole word animates as one, and raising it turns any animated axis into a wave that travels across the word. \`motion.stagger.order\` picks which glyph leads — forward, reverse, center (middle outwards), edges (outermost inwards) or random — and \`motion.stagger.seed\` re-rolls the random one. Reach for these when the user asks for letters to cascade, ripple, or come in one at a time.

BLINK DROPS LETTERS OUT. \`motion.blink.amount\` is the master and the switch: 0 is off, and raising it puts that share of the run into the rotation — reach for it whenever the user asks for a flicker, a stutter, a broken neon sign, or letters that come and go. \`motion.blink.rate\` is blinks per second (each beat re-picks who drops out), \`motion.blink.stayLit\` is how much of each beat a letter stays lit before dropping out (1 never goes dark; 0.9 is a nervous stutter), \`motion.blink.unit\` is whether a letter or a whole word drops out at a time, and \`motion.blink.seed\` re-rolls which letters without changing how many. What is dark AT ANY INSTANT is amount × (1 − stayLit), so raise \`motion.blink.amount\` for "more of the word" and lower \`motion.blink.stayLit\` for "out for longer". The blink is seeded, so the export matches the preview frame for frame.

SCATTER PUTS EVERY LETTER AT ITS OWN WEIGHT. \`motion.scatter.spread\` is the master and the switch: 0 is off, and raising it gives each glyph its own randomly-chosen position on ONE variable axis, drawn around whatever \`axes.<tag>\` says — reach for it whenever the user asks for letters at random weights, mixed weights, a ransom-note or scrambled look, or type that "settles" or "finds its weight". The spread is a share of that axis's own range, so it means the same thing on every font. \`motion.scatter.axis\` picks the axis by tag and only tags the CURRENT font declares work — weight (wght) and slant (slnt) read most clearly, and grade (GRAD) scatters the letters without moving any of them. \`motion.scatter.mode\` is the direction: "settle" starts scattered and resolves onto the user's own values (an entrance, and it ends exactly on their design), "wander" starts on their values and drifts off, each letter at its own pace, forever. \`motion.scatter.settle\` is the settle's length in seconds and \`motion.scatter.rate\` the wander's speed in cycles per second; only one of the two applies at a time. \`motion.scatter.seed\` re-rolls where the letters land without changing how far apart they are. Scatter ADDS to any axis preset, so a weight wave and a scatter are both visible at once, and it is seeded, so the export matches the preview frame for frame.

PAINT IS A STACK. The type carries an ordered list of appearance layers — fills, strokes and extrudes, painted back to front, Illustrator's Appearance panel. The paint controls address the ACTIVE layer and are prefixed \`layer.\`; they do not name an index, so the same keys work whichever layer is selected.

NAMING ONE LAYER INSTEAD. Every layer also appears in the control list under its own key, \`appearance.<layerId>.<key>\`, labelled with the layer's name — "Stroke · Stroke width", "Fill 2 · Fill". Use those when the user names a layer rather than the selection ("make the OUTLINE thicker", "the second fill should be red"): the \`layer.\` keys only ever reach whichever layer is active, which on a fill-then-stroke stack is the fill, so an outline request sent to \`layer.width\` reaches nothing. The id in the key is that layer's own; never invent one, and never write a key that is not in the control list you were given.

\`layer.paint.type\` picks how the active layer is painted: solid, gradient, ombre (a grainy A→B fade), grid, noise, checkerboard, stripes, qr, or shader. \`layer.paint.a\` is the main colour and \`layer.paint.b\` the second one, which appears for everything except solid — and neither applies to a shader fill (see below). \`layer.paint.angle\` sets the direction of a gradient, ombre or stripes; \`layer.paint.density\` sets how many cells or stripes span grid, checkerboard, stripes and qr. \`layer.anchor\` decides which box THIS LAYER is measured against — "glyph" gives every letter its own copy, "word" spans one fill across the whole run so the letters are windows onto it, and "frame" pins the fill to the canvas so moving type slides over it. Reach for "word" when the user asks for a gradient across a word.

\`layer.width\` is the outline width in output pixels, and it only exists when the active layer can draw an outline — a STROKE layer, or a solid EXTRUDE (see below) — so for a stroke that is NOT the active one, reach for that layer's own \`appearance.<layerId>.width\` key instead. A stroke is visible because it is in the stack, not because a width was raised. You cannot add, remove or reorder layers; you can adjust any layer that is already there.

DRAW-ON: THE LETTERS DRAWING THEMSELVES. \`layer.draw\` is how much of a STROKE layer's outline is drawn, 0 to 1, and 1 (the whole stroke) is the default — reach for it whenever the user asks for handwriting, letters that draw or write themselves, a signature, a line animating on, or a partly-drawn outline. It exists only on a stroke layer, because there has to be an outline to draw; on a fill or an extrude there is none. Animate it 0 → 1 over the clip and raise \`motion.stagger.delay\` at the same time, and the letters draw ONE AFTER ANOTHER instead of all at once. Each letter's progress is measured against its own longest contour, so every letter finishes exactly at 1 however long it is, and the counters of letters like o and a draw alongside the outer shape rather than after it. It exports as a real dashed stroke, so the SVG a designer opens is still the letterform.

EVERY LAYER COMPOSITES. \`layer.opacity\` is how strong that layer's ink is in the stack, 0 to 1 — it multiplies the glyph's own motion fade rather than replacing it, so a half-strength layer still fades out with the word. \`layer.blend\` is how the layer composites onto what is below it: normal, lighten, screen, add, multiply, darken or overlay. Both apply to fills, strokes and extrudes alike. Reach for them when the user asks for a layer to be subtler, to glow, or to darken the one underneath.

EXTRUDE IS A BLOCK SHADOW, not 3D. An extrude layer redraws the letterform several times behind the face, which is what gives retro block lettering and hard offset shadows; the FACE is whichever fill layer sits above it in the stack. Its four knobs exist only when the active layer is an EXTRUDE layer. \`layer.depth\` is how many copies (0 draws none), \`layer.distance\` is the gap in pixels between consecutive copies, so the block reaches depth × distance, and \`layer.angle\` is the direction in degrees — 0 steps right, 90 steps straight down, using the same convention as the fill angle above. \`layer.taper\` shrinks the copies as they recede: 1 fades the far end away for a vanishing-point look, 0 keeps the block even, and negative values flare it outwards.

OUTLINED BLOCK LETTERING. An extrude whose copies have been fused into one body can carry a SILHOUETTE — a single outline around the whole extruded mass, the classic outlined-3D look, never one outline per copy. \`layer.width\` is that outline's thickness in output pixels (0 = none, and that is the default) and \`layer.strokeColor\` is its colour. Both only exist while the active extrude layer is fused; on an unfused one there is no single contour to draw, so they are withheld rather than offered as knobs that would change nothing.

SHADER FILLS. Setting \`layer.paint.type\` to shader paints the layer with a live catalog shader effect rather than a flat pattern, and the flat colours stop applying: a shader fill is painted from the effect's own input, so \`layer.paint.a\` and \`layer.paint.b\` are withdrawn and writing them would change nothing. Four controls take their place. \`layer.paint.shader.effectId\` names the catalog effect. \`layer.paint.shader.anchor\` is object (every glyph carries its own copy of the field) or frame (one continuous field, and the letters are windows onto it) — the same distinction \`layer.anchor\` draws for the other fills, applied to the effect. \`layer.paint.shader.speed\` is the animation rate, 0 = frozen. \`layer.paint.shader.seed\` varies the generative field itself — reach for it whenever the user wants a different variation, a re-roll, or a new pattern from the same effect; the same number always reproduces the same pattern. Each effect also brings its OWN parameters, at \`layer.paint.shader.params.<param>\`: which ones exist depends entirely on the chosen effect, so they only appear in the control list once an effect is picked, and changing \`layer.paint.shader.effectId\` replaces the whole set. Be aware that many effects also declare a speed parameter of their own, which is a different knob from \`layer.paint.shader.speed\` — both must be non-zero for the fill to move.

\`text\` is the user's own copy and is not yours to rewrite; change how it LOOKS, not what it says.`
