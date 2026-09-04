/**
 * Vector Type Studio — the config schema.
 *
 * The stored shape of a Vector Type node: what text, in which variable font, at
 * which axis positions, painted how. Everything the studio renders is a pure
 * function of this plus a time — there is no engine state — which is why motion
 * is a plain list of tracks over dotted paths rather than a rebuild protocol.
 *
 * `mergeConfig` is a STRICT REBUILD, not a deep merge: every field is
 * type-checked and rewritten from the default, so a config saved by an older
 * (or newer, or corrupted) version can only ever contribute values of the right
 * type. Nothing is trusted, including the axes record and the motion tracks.
 *
 * Deliberately NOT here: canvas size and background — both live outside the
 * config in every other studio.
 *
 * `motion.in/out/loop` are the SHARED kinetic engine's preset slots, added once
 * `./presetMotion.ts` existed to read them — same rule as `motion.stagger`
 * below. They compose with `tracks`; neither overwrites the other.
 *
 * `motion.stagger` IS here as of Task 6, which built the evaluator that reads it
 * (`./motion.ts`: `glyphTime` / `glyphTransform`). It was withheld until then
 * for the reason this schema exists — declaring keys no renderer reads is the
 * silent-dead-control failure — and it is declared now because the reader
 * landed, not because the shape got clearer.
 */
// The shared move vocabulary every parameter studio's clip is built from — see
// lib/studio/moves/types.ts's header. `VtMove` narrows `Move.kind` (a plain
// string there, so a studio adapter can add its own) to the four kinds this
// studio actually produces; `mergeMove` and `convertLegacyTracks` are the pure,
// studio-neutral merge/migration this file's `mergeMotion` builds on.
import type { Move, MoveEase, MoveEaseName } from '~/lib/studio/moves/types'
import { convertLegacyTracks, mergeMove, type LegacyMotionTrack } from '~/lib/studio/moves/merge'
// Two readers of a preset's NATIVE ease, for the SAME reason `mergeMotion`'s
// preset-slot migration below needs them: an axis preset carries its ease on
// itself (`VtAxisPreset.ease`); a kinetic preset's lives in the shared
// engine's private IN/OUT tables, reached through `nativeEaseFor`. Neither
// import is circular — `axisPresets.ts` only reaches `./font`/`./random`,
// and `lib/motion/evaluate.ts` only reaches its own `./types`/`./easing`.
import { vtAxisPreset } from './axisPresets'
import { nativeEaseFor } from '~/lib/motion/evaluate'
import { isFill, isGradient, type Gradient, type Paint } from '~/lib/compositor/paint'
// The migration-only legacy-track → preset matcher. A CIRCULAR import
// (`trackPresets.ts` imports `VT_STACK_PREFIX`/types back from this module):
// safe here because both sides only reach the other's binding from inside a
// function body (`mergeMotion` below; `PRESETS`' own `build` closures in
// trackPresets.ts), never at module top-level, so neither module needs the
// other to have finished initialising before its own top-level code runs.
import { vtMatchLegacyTrackPreset } from './trackPresets'
import { DEFAULT_FILL, normalizePaint, type Fill } from '~/lib/spacetype/fillTile'
// CPU-only (plain strings plus a GLSL source string), so it is safe in the
// Collection control resolver and every node card — the same bar `fillTile`
// clears above.
import { BLEND_MODES, type BlendKind } from '~/lib/studio/blend'
// Pure path arithmetic over a plain object — no renderer, no DOM. `mergeConfig`
// uses it to lift a positional motion track onto the id addressing every other
// persisted reference to a layer already uses (see `migrateStackTrackPaths`).
import { toIdPath } from '~/lib/studio/idPath'
// Pure colour arithmetic, zero imports beyond `lib/color/convert` — the schema
// needs the SPACE NAMES and the validator, so a stored space that no longer
// exists falls back rather than reaching a renderer as an unknown branch.
import { DEFAULT_COLOR_MIX_SPACE, isColorMixSpace, type ColorMixSpace } from '~/lib/color/mix'
// The blink block's shape, defaults and domains live with the evaluator that
// reads them, not here — `./blink.ts` imports nothing but `./random`,
// `./words`, a shared track helper and this module's TYPES, so the dependency
// runs config → blink and never back. Same direction as `./random.ts`, and for
// the same reason: the light module must not drag the heavy one behind it.
import {
  DEFAULT_BLINK,
  VT_BLINK_RATE_MAX,
  VT_BLINK_SEED_MAX,
  VT_BLINK_UNITS,
  type VtBlinkConfig,
} from './blink'
// Same arrangement, same direction, for the per-glyph axis SCATTER: the block's
// shape, defaults and domains live with `./scatter.ts`, which imports `./random`,
// `./axisPresets` (itself type-only against the font layer), a shared track
// helper and this module's TYPES.
import {
  DEFAULT_SCATTER,
  VT_SCATTER_MODES,
  VT_SCATTER_RATE_MAX,
  VT_SCATTER_SEED_MAX,
  VT_SCATTER_SETTLE_MAX,
  isVtScatterAxis,
  type VtScatterConfig,
} from './scatter'
import { DEFAULT_FONT_ID, VARIABLE_FONTS } from '~/data/variable-fonts'

/** Horizontal anchoring of the (single-line, v1) glyph run. */
export type VtAlign = 'left' | 'center' | 'right'

/**
 * Which BOX the fill is sampled against — i.e. what "100% along the gradient"
 * means. Three terms, where Space Type has two (`object | frame`):
 *
 *  - `glyph` — each letter carries its own copy of the fill. Where the renderer
 *              is today (`ctx.fillStyle` inside the per-glyph transform);
 *              `gradientUnits="objectBoundingBox"` in SVG.
 *  - `word`  — ONE fill spans the whole run and the letters are windows onto
 *              it. The middle term type needs and neither Space Type anchor
 *              expresses; a gradient across a word is the most-wanted
 *              treatment in the design doc.
 *  - `frame` — one fill spans the canvas and the type moves over it. Space
 *              Type's `frame`, and the anchor a moving run reads against.
 *
 * NOT ANIMATABLE, and declared so in `controls.ts`. It is a MODE: tweening it
 * would jump between sampling spaces rather than interpolate anything, exactly
 * the reason Space Type declares its own anchor `animatable: false`.
 */
export type VtFillAnchor = 'glyph' | 'word' | 'frame'

/** The three anchors, in picker order. Single source for the select's options
 *  and for `mergeConfig`'s whitelist, so the picker cannot offer a value the
 *  merge would throw away. */
export const VT_FILL_ANCHORS = ['glyph', 'word', 'frame'] as const

// ── The appearance stack ────────────────────────────────────────────────────

/** What one appearance layer paints. Array order is paint order, BACK TO FRONT,
 *  so a `stroke` below a `fill` is expressible — it was not before, because the
 *  single stroke was unconditionally drawn after the single fill. */
export type VtLayerKind = 'fill' | 'stroke' | 'extrude'

/** The three kinds, in add-menu order. Single source for the merge whitelist. */
export const VT_LAYER_KINDS = ['fill', 'stroke', 'extrude'] as const

/** Upper bound on the stack, matching Gradient's and Shader's `LAYER_MAX`. */
export const VT_LAYER_MAX = 6

/** Offset copies an extrude layer may draw. Bounds the cost, which is
 *  `depth × glyphs` paths per frame. */
export const VT_EXTRUDE_DEPTH_MAX = 32

/**
 * One entry in the appearance stack.
 *
 * ## EVERY per-layer property lives HERE, never inside `paint` — trap 1
 *
 * `normalizePaint` does not merge, it REBUILDS field by declared field on all
 * three arms (see `mergeFill` below). Anything smuggled onto a `Paint` survives
 * in memory and is DROPPED on the next load — a control that works until you
 * reopen the file. That is what already forced `fillAnchor` to be a sibling of
 * `fill` rather than a field inside it, and it is why `anchor`, `enabled`,
 * `opacity`, `blend`, `width` and every extrude knob are declared on the LAYER.
 *
 * ## Every field is REQUIRED, including the ones a given kind ignores
 *
 * The plan's sketch marks the kind-specific fields optional. They are stored
 * required and backfilled by `mergeLayer` instead, for two reasons:
 *
 *  - `setByIdPath`/`setByPath`/`makeConfigParams` all guard on the leaf's PARENT
 *    existing and refuse to fabricate containers. With optional leaves that
 *    guard is fine (the parent is the layer, which always exists) — but
 *    `lib/studio/idPath.ts`'s hand-off asks for the backfill explicitly, and a
 *    always-present leaf is what makes a slider readable before it is first
 *    dragged (`axes` is sparse and needs a fallback at every read site; this
 *    does not).
 *  - it is the same trade `Fill` already makes with `textColor`, which Vector
 *    Type never reads. An inert field costs a few bytes; a shape that differs
 *    per kind costs a branch at every consumer.
 *
 * A fill layer therefore carries a `width` nothing paints with, and the CONTROL
 * for it is `when`-gated to stroke layers so the user is never shown it.
 */
export interface VtAppearanceLayer {
  /**
   * STABLE identity. Minted once, never positional, and NEVER ALL DIGITS —
   * `lib/studio/path.ts`'s `isIndex` is `/^\d+$/`, so an id of `"3"` in
   * `appearance.3.width` would be read as an array index and silently address a
   * different layer. `vtLayerId` guarantees the `L` prefix; `mergeLayer` rejects
   * a stored id that is all digits (or carries a `.`, which would split the path)
   * and mints a fresh one.
   */
  id: string
  kind: VtLayerKind
  /** Visibility. Independent of `opacity`, so a hidden layer keeps its opacity
   *  for when it is shown again. Stored as a real boolean rather than Gradient's
   *  `enabled?: boolean` back-compat optional: there is no saved Vector Type data
   *  in which an absent `enabled` means anything, so the strict rebuild wins. */
  enabled: boolean
  /** The nine-type fill model, reused as-is — a stroke's colour is a `Paint`
   *  too, so a gradient stroke is expressible from day one. */
  paint: Paint
  /** Which box this layer's paint is sampled against. PER LAYER: a word-anchored
   *  gradient fill under a glyph-anchored stroke is the point. */
  anchor: VtFillAnchor
  /** 0..1, composed with (not replacing) the glyph's own motion opacity. */
  opacity: number
  blend: BlendKind
  /**
   * Outline width in OUTPUT pixels, so it does not shrink with `size`.
   *
   * TWO kinds read it, and they mean the same thing one level apart:
   *
   *  - `stroke` — the outline around the letterform itself;
   *  - `extrude` — the outline around the whole extruded BODY, i.e. the
   *    silhouette. Live only where a fused body exists (`solid`, and the union
   *    already landed); see `canvas.ts`'s `paintLayer`. It cannot be an outline
   *    per copy — that would draw internal seam lines through the block, which is
   *    the opposite of a silhouette.
   *
   * Inert on `fill`. Defaults per kind — `vtDefaultWidth` — because a fresh
   * stroke layer must be visible immediately while a fresh extrude must not grow
   * an outline nobody asked for.
   */
  width: number
  /**
   * `extrude` only — the SILHOUETTE stroke's colour, as a flat CSS colour
   * (`#rrggbb` / `#rrggbbaa`).
   *
   * ## Flat, deliberately — not a `Paint`
   *
   * The stroke vocabulary in this studio is a colour, not the nine-type fill
   * model. Widening it roughly doubles the extrude's control surface (a second
   * type / a / b / angle / density / anchor set) and multiplies the downstream
   * work — this studio's outline export flattens a paint to one colour today
   * (the SVG spine itself accepts a paint server on `stroke` since Shape Studio's
   * gradient outlines landed). A `stroke` LAYER's colour is its `paint` and is a full `Paint`;
   * this is the extrude's own outline and is one colour.
   *
   * On the LAYER, never inside `paint` — see this interface's header. A colour
   * smuggled onto a `Paint` survives in memory and is dropped on the next load.
   *
   * Inert on `fill` and `stroke`.
   */
  strokeColor: string
  /** `extrude` only — number of offset copies. */
  depth: number
  /** `extrude` only — offset direction in degrees. */
  angle: number
  /** `extrude` only — pixels between consecutive copies. */
  distance: number
  /** `extrude` only — per-copy scale falloff. */
  taper: number
  /** `extrude` only — union the copies into one body. Bake/export only: the
   *  boolean union is far too slow for a draw loop (plan trap 5). */
  solid: boolean
  /**
   * `stroke` only — **DRAW-ON**. How much of this layer's outline is drawn,
   * 0..1. `1` is the whole thing and is the default, so every config written
   * before this existed renders and exports byte-identically.
   *
   * ## It is a CONFIG LEAF, and that is the whole design
   *
   * Draw-on needs a progress from somewhere, and a leaf is the only one of the
   * three candidates that can name a layer. A gallery preset evaluates to a
   * per-unit `UnitState` (`dx / dy / scale / rotation / opacity / blur / clip /
   * copies`) and is never handed the config, so it has neither a channel to
   * write a per-layer value nor a way to say which layer (see
   * `./trackPresets.ts`'s header and Task 1's structural finding). A leaf, by
   * contrast, is animatable for FREE — this studio is `f(cfg, t) → paths` with
   * no engine to rebuild, so `animatableTargets` offers `appearance.<id>.draw`
   * the moment `controls.ts` declares the slider, and a 0 → 1 track over the
   * clip IS the draw-on, with the easing, loops, hold, delay and — the one that
   * makes it read as handwriting — the per-glyph STAGGER all already built.
   *
   * ## PER LAYER, not "the active stroke layer"
   *
   * There is no active layer at render time: `vtPaintLayers` is handed a config
   * and never a selection index, so "the active one" is a panel concept the
   * renderer cannot ask about. And a stack may legitimately hold a static
   * keyline under a drawing-on outline, which one shared flag could not express.
   *
   * ## Only on a `stroke` layer
   *
   * A dash acts on stroked ink and there is none on a `fill`. The other stroked
   * thing in this studio — a solid extrude's SILHOUETTE — is deliberately
   * excluded: that contour only exists once the async boolean union has landed
   * (no body, no stroke at all), so a draw-on there would appear a moment after
   * an edit and vanish on the next one. That is the dead-control failure this
   * studio's schema exists to prevent, not a lesser version of the feature.
   */
  draw: number
}

/** Same three curves gradientfx's `trackValue` implements. */
export type VtEasing = 'linear' | 'pingpong' | 'easeinout'

/**
 * One animation track — a dotted path plus a numeric or colour range and its
 * per-track timing (hold/cycleOffset/delay). `easing`/`loops` used to live
 * here too; they are GONE, not merely renamed — a track never carries its own
 * ease or play mode any more, because the MOVE that owns it does (a `'tracks'`
 * move's `ease`/`play`, applied to every track it holds; see
 * `~/lib/studio/moves/types`'s `Move`). That is what makes several tracks
 * share one timing rather than repeating it on each: `mergeMove` /
 * `convertLegacyTracks` are the only two places a track is produced without an
 * owning move already declared, and both hand back a move whose `ease`/`play`
 * came from exactly this pair on the legacy shape.
 *
 * No longer structurally checked against gradientfx's `MotionTrack` (which
 * still carries its own `easing`/`loops`) — the two vocabularies diverged on
 * purpose the moment ease/play moved onto the move, so that compile-time proof
 * would now fail by design rather than by drift and was removed rather than
 * kept red.
 */
export interface VtMotionTrack {
  /** Absolute dotted path into VectorTypeConfig, e.g. `axes.wght`. */
  path: string
  /**
   * The numeric range, and the PROGRESS DOMAIN for a colour track.
   *
   * A colour track (see `fromColor` below) stores `from: 0, to: 1` and its
   * endpoints in the colour fields. That is not a placeholder: `trackProgress`
   * reads neither of these, so the pair genuinely describes the 0..1 the mix is
   * taken at, and every timing knob — easing, loops, hold, cycleOffset, delay —
   * means exactly what it means on a numeric track.
   */
  from: number
  to: number
  /**
   * ## COLOUR TRACKS — the three fields that make one, all optional
   *
   * Present TOGETHER or not at all. A track is a colour track iff `fromColor`
   * and `toColor` both parse as hex; `mergeTrack` writes all three or none, so a
   * numeric track's saved JSON is byte-identical to what it was before colour
   * existed and no consumer has to defend against a half-colour track.
   *
   * ## Why they are optional fields on the ONE track type
   *
   * The alternative was a discriminated `kind: 'number' | 'color'` union, which
   * costs a branch at every one of the ~15 places that reads a track (the
   * timeline rows, `mergeTrack`, `migrateStackTrackPaths`, `pruneStackTracks`,
   * `listRemap`, `vtApplyTrackPreset`, `glyphStackLeaf`, the agent's writer …)
   * and buys nothing those places need — they all care about `path` and timing,
   * which are shared. It would also break `VT_TRACK_IS_GRADIENT_COMPATIBLE`
   * below, and with it the reuse of ONE easing engine across three studios.
   *
   * Extra properties do not affect structural assignability, so the guard still
   * compiles and `trackValue`/`trackProgress` still accept this shape unchanged.
   *
   * `#rrggbb` or `#rrggbbaa`, matching every other colour this studio stores.
   */
  fromColor?: string
  toColor?: string
  /** Which space the mix is taken in. Absent means `DEFAULT_COLOR_MIX_SPACE`
   *  (OKLab) — a naive RGB lerp drops through a dark, desaturated trough, and
   *  `lib/color/mix.ts` carries the measured numbers. */
  space?: ColorMixSpace
  /** Hold at extremes, 0..0.5. */
  hold: number
  /** Phase offset into the cycle, 0..1. */
  cycleOffset: number
  /** Start delay, seconds. */
  delay: number
}

/**
 * The queue every glyph waits in. `forward` = first letter first; `center` =
 * middle outwards; `edges` = outermost inwards; `random` = a SEEDED shuffle
 * (see `motion.stagger.seed` — a per-frame `Math.random()` would make the bake
 * flicker and the SVG export unreproducible).
 */
export type VtStaggerOrder = 'forward' | 'reverse' | 'center' | 'edges' | 'random'

/**
 * Per-glyph timing offset. Not a track: it does not animate anything by itself,
 * it SHIFTS THE CLOCK each glyph reads the tracks at — which is what turns a
 * single `axes.wght` track into a weight wave travelling across a word.
 */
export interface VtStaggerConfig {
  /** Seconds between consecutive glyphs in the queue. 0 = one shared clock. */
  delay: number
  order: VtStaggerOrder
  /** Shuffle seed for `order: 'random'`. Ignored by every other order. */
  seed: number
}

/**
 * `Move` narrowed to the four kinds this studio actually produces — `kind` is
 * a plain `string` on the shared shape (so a studio adapter can add its own),
 * but every move this studio's own code constructs (`mergeMotion`'s two
 * branches, `convertLegacyTracks`, the preset galleries) is one of these
 * four. Narrowing it here catches a move built with an out-of-range `kind`
 * at the assignment into `VtMotionConfig.moves`, rather than silently
 * accepting it and failing later at whatever reads `kind` expecting one of
 * these four.
 */
export type VtMove = Move & { kind: 'preset' | 'tracks' | 'blink' | 'scatter' }

export interface VtMotionConfig {
  /**
   * The stack of moves — every preset, track and entrance/exit/loop is one
   * move on the shared `Move` shape (`~/lib/studio/moves/types`). Replaces
   * the old three preset slots (`in`/`out`/`loop`) plus the flat `tracks`
   * array; `mergeMotion` converts a document saved before this existed (see
   * its old-shape branch) so an old document renders identically once
   * migrated.
   */
  moves: VtMove[]
  /** Clip length in seconds. */
  duration: number
  fps: number
  /** Export height base (1080 / 1440 / 2160). */
  size: number
  stagger: VtStaggerConfig
  /**
   * Letters (or whole words) dropping out and coming back — `./blink.ts`.
   *
   * Not a track and not a preset slot: it is a per-unit ON/OFF derived from a
   * seeded hash of `(unit, beat)`, so it needs settings of its own rather than a
   * `from`/`to` pair. `amount: 0` is the shipped default and means off, which is
   * what keeps every config written before this feature rendering identically.
   *
   * `amount`, `rate` and `stayLit` are ordinary animatable leaves — a track on
   * `motion.blink.amount` ramps a sign into failure — so they are declared here
   * as real config state rather than as evaluator-only knobs.
   */
  blink: VtBlinkConfig
  /**
   * Every glyph at its OWN random position on one variable axis — `./scatter.ts`.
   *
   * Not a track and not a preset slot, for the same reason `blink` is neither:
   * it is a per-glyph value derived from a seeded hash of the glyph index, so it
   * needs settings of its own rather than a `from`/`to` pair. `spread: 0` is the
   * shipped default and means off, which is what keeps every config written
   * before this feature rendering identically.
   *
   * `spread`, `settle` and `rate` are ordinary animatable leaves — a track on
   * `motion.scatter.spread` is how a word comes apart over a clip — so they are
   * declared here as real config state rather than as evaluator-only knobs.
   */
  scatter: VtScatterConfig
}

export interface VectorTypeConfig {
  /** The word(s) to set. Long strings are a real performance cost (hundreds of
   *  anchor points per glyph, re-shaped per frame); bounding the INPUT is the
   *  surface's job — truncating here would silently rewrite a saved project. */
  text: string
  /** Catalog id from `~/data/variable-fonts`. Frozen control key. */
  fontId: string
  /**
   * Axis positions by OpenType tag, e.g. `{ wght: 700, XOPQ: 96 }`.
   *
   * SPARSE BY DESIGN: an absent tag means "the font's own default for that
   * axis" (`resolveCoords` in ./outline.ts fills it in), so `{}` is a complete,
   * valid config for any font. Tags the current font does not declare are KEPT
   * here and dropped at render time by `clampCoords` — switching font away and
   * back must not silently discard the axis values you set.
   */
  axes: Record<string, number>
  /** Em size in output pixels (CSS `font-size` semantics). */
  size: number
  /** Extra advance per glyph in 1/1000 em (CSS `letter-spacing` in em × 1000),
   *  applied after the font's own shaping. 0 = the font's spacing untouched. */
  tracking: number
  align: VtAlign
  /**
   * WHOLE-RUN shear, in degrees. `skewX` leans the run horizontally (x displaced
   * by `tan(skewX) · y`), `skewY` vertically.
   *
   * ## Whole-run, not per-glyph — and that is the entire design
   *
   * A shear applied about each glyph's OWN origin makes every letter slant while
   * the WORD stays upright; the letters lean and the baseline does not, which is
   * the wrong-looking one. The shear is composed once, about the run's ink
   * centre, and every glyph rides it — see `vtRunShear` in `./canvas.ts`, which
   * is the single place it is built for both renderers.
   *
   * ## It is a SHEAR, not an oblique
   *
   * A variable font's `slnt` axis re-draws the letterforms at an angle — the
   * counters stay round, the stems stay the right thickness, the designer drew
   * it. A shear is a matrix applied to finished geometry: round shapes become
   * ellipses and horizontal stems thin out. It is the cruder effect, on purpose
   * — it works on EVERY font (including the ones with no `slnt` axis at all) and
   * it leans the whole composition rather than each letter. The control hint
   * says so out loud rather than implying the two are equivalent.
   *
   * ## Still EXACTLY-correct vector
   *
   * A shear is affine, so it is a legal SVG `transform` and the export is
   * geometry rather than an approximation — the property that separates this
   * from the deferred perspective work, whose projection SVG path data cannot
   * express.
   *
   * Bounded by `VT_SKEW_MAX`, and that bound is load-bearing rather than
   * cosmetic — see its own note.
   */
  skewX: number
  skewY: number
  /**
   * Bend the run onto an ARC, in degrees of **total sweep**. `0` is a straight
   * baseline and exactly the run this studio has always drawn.
   *
   * ## Why sweep and not radius
   *
   * The two are the same number said differently — the run keeps its own arc
   * length as it bends, so `radius = runWidth / arcRadians` — but only one of
   * them is a usable control. A radius slider has its flat end at INFINITY and
   * spends most of its travel doing nothing visible; sweep is linear, its flat
   * end is 0, and a sign flips the bow. `±360` closes the run into a full circle,
   * which is the natural end of the range rather than an arbitrary cap.
   *
   * Positive arches the run UPWARD (a rainbow); negative bowls it downward.
   *
   * ## The run does not change length as it bends
   *
   * The curve is `./curve.ts`'s `line` — a span bowed by `curvature`, whose
   * radius is `length / sweep` and whose arc length is therefore `length` at
   * every curvature. So bending the type does not stretch or squeeze the letter
   * spacing: every glyph sits at exactly the arc length its shaped advance puts
   * it at, and at `arc: 0` the placement is byte-identical to the flat one. That
   * continuity is what makes an animated arc a smooth bend rather than a pop.
   *
   * ## Still EXACTLY-correct vector
   *
   * Each glyph is TRANSLATED onto the curve and ROTATED to the tangent — a rigid
   * body move, which is affine, so the letterforms are untouched and the export
   * is real geometry. Bending the letterforms themselves is a different (and
   * deliberately deferred) feature: that is point-level deformation with the same
   * rational-Bézier approximation problem as perspective.
   *
   * Bounded by `VT_ARC_MAX`.
   */
  arc: number
  /**
   * Typographic stretch of the run — width (`stretch`) and height (`stretchY`),
   * 1 = as drawn. NOT a scale: white space stretches, ink doesn't (stems and
   * crossbars keep their weight, counters take the change, rounds flatten
   * like a real Extended cut). Spends a real `wdth` axis first when the font
   * has one. Per glyph under a staggered track — a wave of width or height —
   * on the same alignment zones, so the x-height never scatters.
   */
  stretch: number
  stretchY: number
  /** `'width'` solves `stretch` so the run fills the output box (minus a small
   *  margin); the dial shows the solved value and goes read-only. */
  fit: VtFit
  /**
   * The appearance stack — multiple fills, multiple strokes, extrudes, painted
   * BACK TO FRONT. Illustrator's Appearance panel, in a config.
   *
   * ## This REPLACES `fill` / `fillAnchor` / `stroke` / `strokeWidth`
   *
   * Those four are GONE, not kept as derived accessors, and the reason is
   * mechanical rather than aesthetic:
   *
   *  - a derived GETTER cannot survive `cloneConfig`. It spreads (`{ ...cfg }`),
   *    which invokes getters and copies their result as a plain value — so every
   *    clone would freeze a stale snapshot, and `applyMotion` writes THROUGH the
   *    clone. The renderer would then read a value the stack no longer holds.
   *  - a derived FIELD is a second writable copy. `makeConfigParams` writes are
   *    plain property assignments with no hook, so a control pointed at
   *    `strokeWidth` would update the copy and not the layer; the next
   *    `mergeConfig` re-derives it and the edit vanishes on reload. That is
   *    exactly the "works until you reopen the file" failure trap 1 is about.
   *
   * So there is one source of truth. `vtBaseAppearance` (below) is the single,
   * clearly-labelled BRIDGE that answers "which fill and which stroke would the
   * old single-pair renderer have drawn" — it is what `canvas.ts` reads until
   * Task 3 replaces it with a real layer loop, and it also absorbs a legacy blob
   * that never went through `mergeConfig`.
   *
   * A migrated legacy config holds one `fill` layer, plus one `stroke` layer
   * ABOVE it when the saved `strokeWidth` was greater than zero. See
   * `migrateLegacyAppearance`.
   *
   * MAY BE EMPTY: the user removing every layer is a legitimate state, and it is
   * distinguishable from "an older config that never had a stack" because the
   * key is present as an array. An empty stack paints nothing.
   */
  appearance: VtAppearanceLayer[]
  motion: VtMotionConfig
}

/**
 * The retired flat paint fields, kept as a TYPE only.
 *
 * Nothing on `VectorTypeConfig` carries these any more. The shape is declared so
 * `migrateLegacyAppearance` and `vtBaseAppearance` can name what they read, and
 * so a reader of this file can see exactly what a pre-stack saved node holds.
 */
export interface VtLegacyPaint {
  /**
   * Glyph body paint — the product's whole fill vocabulary, not a colour. Now
   * `appearance[fill].paint`.
   *
   * A REAL `Paint` (`string | Gradient | Fill`), stored verbatim, NOT a
   * Vector-Type-shaped near-copy. Shape Studio declared its own `SurfaceFill`
   * (a `Fill` minus `textColor`) and the function that mapped one back to the
   * other silently dropped a field and shipped broken — see the doc comment at
   * `shapefx/config.ts:60-70`. There is no mapping function here to get wrong.
   *
   * `mergeConfig` normalises this so the common case is always a `Fill`: a
   * LEGACY `'#rrggbb'` string (what every node saved before this existed holds)
   * is LIFTED to `{ type: 'solid', a: <the string>, … }` — see `mergeFill`. A
   * `Gradient` (multi-stop / radial, which `Fill` cannot express) is the one
   * arm that survives as itself, because collapsing it would be data loss.
   *
   * `textColor` on the `Fill` arm is inert here — it is the type colour for a
   * Space Type slot row. It is carried because `Fill` is adopted WHOLE; the
   * alternative is exactly the near-copy this comment opens by refusing.
   */
  fill?: Paint
  /**
   * Which space the fill is sampled in. See `VtFillAnchor`. Now
   * `appearance[fill].anchor`.
   *
   * ## A SIBLING of `fill`, not a field inside it — and that is FORCED
   *
   * The plan spells this control `fill.anchor`, and it cannot be stored there.
   * `normalizePaint` (which this schema is required to reuse, because it owns
   * the depth-1 shader-nesting guard) does not merge — it REBUILDS, field by
   * declared field, on all three arms:
   *
   *  - a bare colour string has nowhere to put an anchor at all;
   *  - `normalizeGradient` rebuilds a `Gradient` as `{ type, angle?, stops }`;
   *  - `normalizeFill` rebuilds a `Fill` as `{ type, a, b, textColor, angle,
   *    density, shader? }`.
   *
   * An `anchor` smuggled onto any of them survives in memory and is DROPPED on
   * the next load — a control that works until you reopen the file, which is
   * precisely the class of failure trap 5 is about. Space Type has no
   * counter-example: its only anchor lives on `ShaderSpec` (`fills.ts:54`),
   * i.e. inside a struct that actually declares the field.
   *
   * So the anchor was a top-level key, spelled `fillAnchor` — the REAL dotted
   * path, because a control key one segment off the storage it claims to address
   * writes to a phantom object (the lesson `derivedAxisControls` records). The
   * stack keeps the rule and moves the key to `layer.anchor`.
   */
  fillAnchor?: VtFillAnchor
  /**
   * Outline colour, `#rrggbb`. Only painted when `strokeWidth > 0`.
   *
   * v1 declined to widen this to a `Paint`, on the grounds that the extra knobs
   * doubled the control surface for a feature `strokeWidth: 0` hid by default.
   * The stack overturns BOTH halves of that reasoning at once: a stroke is now a
   * layer, so it is visible because it is in the list rather than because a width
   * was raised, and its paint is the same `Paint` a fill carries — one
   * vocabulary, no second control surface. The invisible stroke is precisely what
   * prompted this work.
   */
  stroke?: string
  /** Outline width in OUTPUT pixels (so it did not shrink with `size`). 0 = no
   *  stroke, and the default — which is why the stroke was invisible. Now
   *  `appearance[stroke].width`. */
  strokeWidth?: number
}

export const DEFAULT_STAGGER: VtStaggerConfig = { delay: 0, order: 'forward', seed: 0 }

export const DEFAULT_MOTION: VtMotionConfig = {
  moves: [], duration: 4, fps: 30, size: 1080,
  stagger: { ...DEFAULT_STAGGER }, blink: { ...DEFAULT_BLINK }, scatter: { ...DEFAULT_SCATTER },
}

/**
 * The id the BASE FILL layer carries — in a fresh config and in every migrated
 * legacy one.
 *
 * Deterministic on purpose. A migration that minted a different id on each load
 * would defeat the entire point of stable ids: a motion track or a Collection
 * binding written against the layer would stop resolving the next time the file
 * opened. `L`-prefixed, so it can never be read as an array index.
 */
export const VT_BASE_FILL_ID = 'Lfill'
/** The id a MIGRATED stroke layer carries. Same reasoning as `VT_BASE_FILL_ID`. */
export const VT_BASE_STROKE_ID = 'Lstroke'

/**
 * Width a NEW stroke layer gets.
 *
 * Non-zero, deliberately, and it is the headline fix of this work: the old
 * `strokeWidth` defaulted to 0 and its colour control was `when`-gated behind a
 * non-zero width, so a user who went looking for the stroke found nothing and
 * reasonably concluded there wasn't one. A stroke layer is visible because it is
 * in the list.
 */
export const VT_DEFAULT_STROKE_WIDTH = 3

/**
 * Width a NEW EXTRUDE layer's silhouette outline gets: **zero**, i.e. off.
 *
 * The opposite default from `VT_DEFAULT_STROKE_WIDTH`, and for the same reason
 * that one is non-zero. A stroke LAYER is a thing the user added to the stack and
 * must be visible immediately — that is what it is for. An extrude's outline is a
 * property OF an extrude, one knob among five, and an extrude added for its block
 * shadow must not silently come with a black keyline around it. It is the ticker
 * band-stroke pattern (`spacetype/effects/ticker.ts`: `strokeWidth` default 0,
 * `strokeColor` default `#000000`) — the width is the switch, the colour is ready
 * for when it is thrown.
 */
export const VT_DEFAULT_EXTRUDE_STROKE_WIDTH = 0

/** The extrude silhouette's colour on a fresh layer. Real black rather than an
 *  empty string or `transparent`: `width` is the on/off switch, so the colour is
 *  free to be a value a picker can show honestly. */
export const VT_DEFAULT_STROKE_COLOR = '#000000'

/**
 * The `width` a layer of this kind gets when nothing stored one.
 *
 * ONE function, two callers — `vtLayer` (a fresh layer) and `mergeLayer` (a
 * stored layer with no width). A second copy of the per-kind rule is exactly how
 * a layer created through the UI and the same layer round-tripped through storage
 * would end up with different outlines.
 */
export function vtDefaultWidth(kind: VtLayerKind): number {
  return kind === 'extrude' ? VT_DEFAULT_EXTRUDE_STROKE_WIDTH : VT_DEFAULT_STROKE_WIDTH
}

/** Field-by-field defaults for a layer, minus the id (which is never shared).
 *
 *  EXPORTED so `controls.ts` can seed the layer sliders' `default` from the one
 *  the merge actually ships, rather than a second hand-written copy — the same
 *  reason its paint controls read `DEFAULT_FILL`. A slider whose default drifts
 *  from the stored value shows the wrong number until the user drags it. */
export const LAYER_DEFAULTS: Omit<VtAppearanceLayer, 'id' | 'paint'> = {
  kind: 'fill',
  enabled: true,
  // `glyph` is the identity-preserving anchor: it is what the renderer already
  // did, and for a solid fill all three anchors are the same picture.
  anchor: 'glyph',
  opacity: 1,
  blend: 'normal',
  // The default for `kind: 'fill'`, which is this record's own kind —
  // `vtDefaultWidth('fill')` is exactly this. An EXTRUDE overrides it to 0 at
  // both build sites; see `vtDefaultWidth`.
  width: VT_DEFAULT_STROKE_WIDTH,
  strokeColor: VT_DEFAULT_STROKE_COLOR,
  // Extrude defaults — a readable block shadow, not a hairline. `135°` steps
  // DOWN-LEFT: the angle convention is canvas's own (`dx = cos θ`, `dy = sin θ`,
  // y pointing down), shared with `fillTile`'s gradient angle so the two "angle"
  // sliders in one panel cannot rotate in opposite directions. See
  // `./extrude.ts`. (This comment said "down-right" when the field was stored but
  // unread; Task 4 is what made it a claim about pixels.)
  depth: 8,
  angle: 135,
  distance: 3,
  taper: 0,
  solid: false,
  // FULLY DRAWN. The identity value, and the reason adding this field changes no
  // existing picture and no existing export: at 1 both renderers emit no dash at
  // all rather than a dash that happens to cover everything.
  draw: 1,
}

/**
 * Build one appearance layer.
 *
 * `paint` is always a FRESH object (`{ ...DEFAULT_FILL }`, or the caller's own),
 * never a shared module constant — the previous task on this file paid for the
 * version of that bug where `DEFAULT_CONFIG.fill` was one object and a motion
 * frame's angle leaked into the module-level default.
 *
 * EXPORTED because `mergeConfig` is not the only place a config is BUILT:
 * `thumbPreview.ts` assembles one from a `VtThumbSpec` and has nothing to merge.
 */
export function vtLayer(over: Partial<VtAppearanceLayer> = {}): VtAppearanceLayer {
  // Assigned key by key rather than spread, so an explicit `undefined` on the
  // override (which a spread would happily reinstate over the default) cannot
  // produce a layer with a missing field.
  const out: VtAppearanceLayer = { ...LAYER_DEFAULTS, id: '', paint: { ...DEFAULT_FILL } }
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v
  }
  // `width` defaults PER KIND, and `LAYER_DEFAULTS` can only carry one of them —
  // so an `extrude` built here would otherwise inherit the stroke layer's 3 and
  // arrive with a silhouette outline nobody asked for. Only when the caller said
  // nothing: an explicit width, including 0, is the caller's answer.
  if (over.width === undefined) out.width = vtDefaultWidth(out.kind)
  if (!out.id) out.id = vtLayerId()
  return out
}

/**
 * Mint a layer id.
 *
 * NEVER ALL DIGITS — the `L` prefix guarantees it, and that is not decoration:
 * `lib/studio/path.ts` treats an all-digits path segment as an array index, so a
 * numeric id in `appearance.<id>.width` would resolve to a POSITION and silently
 * address the wrong layer. `newLayerId()` in the other two stacks has the same
 * prefix for the same reason.
 *
 * Uniqueness comes from a monotonic counter plus the clock, not from randomness
 * alone, so two layers added in the same millisecond cannot collide.
 */
let vtIdSeq = 0
export function vtLayerId(): string {
  vtIdSeq = (vtIdSeq + 1) % 0xffff
  return `L${Date.now().toString(36)}${vtIdSeq.toString(36)}`
}

export const DEFAULT_CONFIG: VectorTypeConfig = {
  text: 'Vector',
  fontId: DEFAULT_FONT_ID,
  axes: {},
  size: 120,
  tracking: 0,
  align: 'center',
  // No shear — `vtRunShear` returns `null` for this pair, so an unskewed run is
  // byte-identical to what it drew and exported before the control existed.
  skewX: 0,
  skewY: 0,
  // No bend — `vtRunCurve` returns `null` for this, so the placement is the
  // straight-baseline one it has always been, to the bit.
  arc: 0,
  // As drawn. `stretchOutlines` returns the outlines untouched at (1, 1), so a
  // config that never touched the dials renders byte-identically.
  stretch: 1,
  stretchY: 1,
  fit: 'off',
  // One white fill and nothing else — the same picture the legacy
  // `fill: '#ffffff'` + `strokeWidth: 0` default painted, said in the stack's
  // vocabulary. The default config's PIXELS are unchanged by this task.
  appearance: [vtLayer({ id: VT_BASE_FILL_ID })],
  // Spread is shallow: `stagger`, `blink` and `scatter` must be copied too, or
  // DEFAULT_CONFIG and DEFAULT_MOTION would share one mutable object.
  motion: {
    ...DEFAULT_MOTION, moves: [],
    stagger: { ...DEFAULT_STAGGER }, blink: { ...DEFAULT_BLINK }, scatter: { ...DEFAULT_SCATTER },
  },
}

/** Every catalog font id, in catalog order. Exported so the control schema
 *  offers exactly the set `mergeConfig` will accept — a second hand-written
 *  list would silently drift the moment a family is added or removed. */
export const VT_FONT_IDS: string[] = VARIABLE_FONTS.map(f => f.id)

export const VT_ALIGNS = ['left', 'center', 'right'] as const
export const VT_EASINGS = ['linear', 'pingpong', 'easeinout'] as const
export const VT_STAGGER_ORDERS = ['forward', 'reverse', 'center', 'edges', 'random'] as const
/** Upper bound on the per-glyph delay. A whole second between letters is
 *  already longer than most clips; beyond that the tail never enters. */
export const VT_STAGGER_DELAY_MAX = 1
/** Seeds are small integers so the "re-roll the shuffle" control is a short drag. */
export const VT_STAGGER_SEED_MAX = 999
/**
 * The bound on `skewX` / `skewY`, per axis, in degrees — and it is a MATH
 * constraint wearing a taste constraint's clothes.
 *
 * The shear is `[1, tan(skewY), tan(skewX), 1, 0, 0]`, whose determinant is
 * `1 − tan(skewX)·tan(skewY)`. That is ZERO along the whole curve
 * `tan(skewX)·tan(skewY) = 1` — most reachably at 45°/45°, two sliders a user
 * can land on by accident — and a singular run transform collapses the word onto
 * a line. Worse than the picture: `invertAffine` refuses a singular matrix, so
 * the `gradientTransform` that pins a word-anchored ramp in document space
 * silently disappears and the export stops matching the canvas. NEAR-singular is
 * no better; the SVG writer rounds the matrix to `precision` before inverting,
 * and a 1e-3 rounding amplifies without bound as the determinant approaches 0.
 *
 * 40° holds `|tan|` to 0.8391, so the product cannot exceed 0.7041 and the
 * determinant cannot fall below **0.2959** anywhere in the declared range. The
 * transform is well-conditioned by construction rather than by hoping nobody
 * drags both sliders. (A test asserts that floor across the whole square.)
 *
 * It costs nothing anyone wants: a designed oblique is 8–15°, the Compositor's
 * own Slant sliders reach 60° on a raster layer that has no inverse to protect,
 * and a 40° lean is already past caricature.
 */
export const VT_SKEW_MAX = 40
/** The dials' range. Each axis alone is proven to 0.5–2.5 in the lab; the
 *  studio damps the SECOND axis when both deviate (see `dampedStretch`). */
export const VT_STRETCH_MIN = 0.5
export const VT_STRETCH_MAX = 2.5
export const VT_FITS = ['off', 'width'] as const
export type VtFit = (typeof VT_FITS)[number]
/**
 * The bound on `arc`, in degrees of total sweep.
 *
 * A full turn is the natural end of the range rather than a taste call: at
 * `±360` the run's two ends meet and the type closes into a ring, and past that
 * it would begin to overlap itself — the same letters drawn twice in the same
 * place, which is a picture with no reading of it that is right. The clamp lives
 * at the render choke point (`vtArcSweep`) rather than only in `mergeConfig`,
 * because a motion track's `from`/`to` never pass through the merge and a bound
 * only the merge honours is not a bound.
 */
export const VT_ARC_MAX = 360
/** Export heights the motion block accepts, matching gradientfx's. */
export const VT_MOTION_SIZES = [1080, 1440, 2160] as const

/** The three preset slots, in evaluation order. */
export const VT_PRESET_SLOTS = ['in', 'out', 'loop'] as const
export type VtPresetSlot = (typeof VT_PRESET_SLOTS)[number]

/** Phase length a slot gets when a stored spec has none, matching what the
 *  Compositor's editor writes (`MotionLayerEditor.assign`) so the same preset
 *  reads the same speed in both studios. */
export const VT_PRESET_DURATIONS: Record<VtPresetSlot, number> = { in: 0.8, out: 0.8, loop: 1.5 }

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  (typeof v === 'string' && (allowed as readonly string[]).includes(v)) ? (v as T) : d
const oneOfNum = (v: unknown, allowed: readonly number[], d: number): number =>
  (typeof v === 'number' && allowed.includes(v)) ? v : d
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * An OpenType axis tag is exactly four printable-ASCII characters.
 *
 * A deliberate one-line twin of `isValidAxisTag` in ./font.ts rather than an
 * import: font.ts loads fontkit at module scope, and this module is pulled into
 * the Collection control resolver and every node card. The two are pinned to
 * agree by a test (vectortype-controls.unit.spec.ts) rather than by hope.
 */
export function isAxisTag(tag: unknown): boolean {
  return typeof tag === 'string' && /^[\x20-\x7E]{4}$/.test(tag)
}

/**
 * Rebuild the glyph paint — and LIFT A LEGACY COLOUR STRING.
 *
 * ## Trap 5, and it is the whole reason this function exists
 *
 * Every Vector Type node saved before this task holds `fill: '#ffffff'` — a
 * bare string. `Paint` still ACCEPTS a bare string, so nothing would throw and
 * nothing would look wrong at first glance; what would break is every dotted
 * control key (`fill.type`, `fill.a`, …), which would resolve against a string
 * and silently address nothing. So the string is lifted to a solid `Fill`
 * HERE, at the one function every read path goes through, rather than defended
 * against at each renderer.
 *
 * Only `a` is seeded from the legacy colour. `b`/`angle`/`density` come from
 * `DEFAULT_FILL`, which is what a fresh solid fill has always had, and
 * `textColor` stays at its default because Vector Type never reads it (see the
 * note on `VectorTypeConfig.fill`).
 *
 * ## Why the lift happens BEFORE `normalizePaint`, not inside it
 *
 * `normalizePaint`'s first arm passes a string through UNCHANGED, deliberately
 * — for `ShaderSpec.input` a flat colour IS a valid terminal value. That
 * contract is not ours to change, so the lift is a pre-step and everything
 * after it is `normalizePaint` verbatim: no second normaliser, and in
 * particular no second copy of its DEPTH-1 shader-nesting guard, which is what
 * stops a shader-inside-a-shader from hanging the renderer.
 *
 * `depth: 0` is the top level, so `type: 'shader'` is accepted here and refused
 * one level down inside the spec's own `input`.
 *
 * EXPORTED because `mergeConfig` is not the only place a config is BUILT.
 * `thumbPreview.ts` assembles one directly from a `VtThumbSpec` (it is not
 * loading a stored blob, so it has nothing to merge), and a tile whose `fill`
 * did not go through the same lift would be a config `mergeConfig` rejects —
 * which is exactly what its own round-trip test pins.
 */
export function mergeFill(raw: unknown): Paint {
  const seed = typeof raw === 'string' ? { ...DEFAULT_FILL, a: raw } : raw
  return finitePaint(normalizePaint(seed, 0))
}

/**
 * Repair non-finite `angle`/`density` on the `Fill` arm.
 *
 * NOT a second normaliser, and deliberately not a change to `normalizePaint`:
 * it runs AFTER it, adds no arms, and enforces nothing about shape. It enforces
 * the one invariant this schema holds everywhere else and `normalizeFill` does
 * not — `num()` above rejects `NaN`/`Infinity` on every other numeric field,
 * because a non-finite number does not fall back at the renderer, it propagates
 * (`Math.max(1, Math.round(NaN))` is `NaN`, and `fillTileBox`'s cell maths then
 * produces a blank tile with no error anywhere).
 *
 * `normalizeFill` keeps a `NaN` density because Space Type's own consumers have
 * always tolerated it; changing that is not this task's to make, so the repair
 * lives here where the stricter contract already is.
 *
 * Recursion is bounded by the SAME depth-1 guard: at depth 1 `normalizeFill`
 * refuses `type: 'shader'` and drops a `shader` field from any non-shader fill,
 * so a shader's `input` can never itself carry one and this cannot loop.
 */
function finitePaint(p: Paint): Paint {
  if (!isFill(p)) return p
  const out: Fill = {
    ...p,
    angle: Number.isFinite(p.angle) ? p.angle : DEFAULT_FILL.angle,
    density: Number.isFinite(p.density) ? p.density : DEFAULT_FILL.density,
  }
  if (out.shader) out.shader = { ...out.shader, input: finitePaint(out.shader.input) }
  return out
}

/** Deep copy of a `Paint` — see `cloneConfig`, which needs one because motion
 *  writes THROUGH the clone (`fill.angle`/`fill.density` are animatable, and a
 *  shared `fill` object would write frame 37 back into the config the surface
 *  is holding and then save it). Tolerant of a config straight out of storage,
 *  same as its caller: a string clones as itself. */
function clonePaint(p: Paint): Paint {
  if (typeof p !== 'object' || p === null) return p
  if (isGradient(p)) return { ...p, stops: (p as Gradient).stops.map(s => ({ ...s })) } as Gradient
  const f = p as Fill
  if (!f.shader) return { ...f }
  return {
    ...f,
    shader: { ...f.shader, params: { ...f.shader.params }, input: clonePaint(f.shader.input) },
  }
}

// ── The appearance stack: rebuild, migrate, and the render bridge ───────────

/**
 * The config key the appearance stack lives at, and the prefix every absolute
 * stack path carries.
 *
 * ONE constant, because four things have to agree about which dotted paths are
 * member paths and which are ordinary config leaves: `animatableTargets` (which
 * builds them), `applyMotion` (which resolves them), `pruneStackTracks` (which
 * drops the dangling ones) and `migrateStackTrackPaths` below (which lifts the
 * positional ones). `axes.wght` is `<something>.<something>` too, and running it
 * through an id resolver would refuse it — there is no `axes` ARRAY — and
 * silently stop every variable axis animating.
 *
 * It lives HERE rather than in `./motion.ts` (which owned it until the migration
 * needed it) because `motion.ts` imports this module: the constant has to sit at
 * the bottom of that edge or the two form a cycle. `motion.ts` re-exports both
 * names, so every existing importer is unchanged.
 */
export const VT_STACK_LIST = 'appearance'
export const VT_STACK_PREFIX = `${VT_STACK_LIST}.`

/**
 * A stored id worth keeping, or `''`.
 *
 * Three rejections, and every one of them is a real addressing hazard rather
 * than tidiness:
 *
 *  - ALL DIGITS — `lib/studio/path.ts`'s `isIndex` is `/^\d+$/`, so `"3"` in
 *    `appearance.3.width` is read as an ARRAY INDEX. An id that resolves to a
 *    position is worse than no id: it silently addresses a real but wrong layer,
 *    which is the exact failure the stable-id decision exists to prevent.
 *  - CONTAINS A DOT — the path grammar is dot-separated, so `a.b` would split.
 *  - EMPTY / not a string.
 */
function validLayerId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (!id || id.includes('.') || /^\d+$/.test(id)) return ''
  return id
}

/**
 * The stored `width`, or the extrude default for a BACKFILLED one.
 *
 * ## The problem this exists for
 *
 * `width` was documented INERT on an extrude until the silhouette landed, and its
 * only control was gated to `stroke` layers — so no user has ever authored one.
 * But `mergeLayer` defaulted every kind to `VT_DEFAULT_STROKE_WIDTH` (3) and then
 * SAVED it, so every extrude layer stored before the silhouette carries a
 * backfilled `3` that means nothing. Left alone, the first thing the new `solid`
 * toggle would do to such a layer is grow a 3 px black keyline nobody asked for —
 * the toggle's own debut, mis-attributed to the toggle.
 *
 * ## The two conjuncts, and why each one is load-bearing
 *
 *  1. **`strokeColor` is absent from the STORED object.** `mergeLayer` has
 *     emitted that field since the silhouette landed, so every layer this app has
 *     saved since has it. The branch therefore fires AT MOST ONCE per layer, ever,
 *     and can never see a width a user authored through the toggle. This is the
 *     one place in this file that infers a vintage from a sibling key, and it is
 *     confined to the field whose meaning changed in the same commit that added
 *     that key.
 *  2. **`solid` is not `true`.** An unfused extrude has no single contour, so its
 *     width cannot paint: no control offers it (`layerHasWidth` wants a stroke
 *     layer or a SOLID extrude), the canvas reads it only behind `solid &&`, and
 *     the SVG only on a fused body. So this rewrite is provably a NO-OP on the
 *     picture at the moment it runs — it changes nothing anyone can see, only what
 *     they will see when they later turn `solid` on. It also spares the one
 *     authoring path that CAN legitimately hand us a fused extrude with no
 *     `strokeColor`: a hand-written config or an agent-written one, which is how
 *     the silhouette was verified before it had a toggle.
 *
 * The alternative — leaving it — is a keyline; the alternative that keys on
 * `solid` alone would zero a width every time a user toggled `solid` off and
 * reloaded, which is the same forgetting bug one level out.
 */
function mergedWidth(o: Record<string, unknown>, kind: VtLayerKind): number {
  // A negative width is not "the other side" — it is a broken value, and
  // `ctx.lineWidth` ignores it silently.
  //
  // The FALLBACK is per kind (`vtDefaultWidth`): a stored stroke layer with no
  // width must still be visible, and a stored extrude with no width must not
  // grow an outline. Same rule as `vtLayer`'s, from the same function.
  const stored = Math.max(0, num(o.width, vtDefaultWidth(kind)))
  if (kind !== 'extrude') return stored
  if (o.strokeColor !== undefined || o.solid === true) return stored
  return vtDefaultWidth(kind)
}

/**
 * Rebuild ONE layer. Strict, like every other merge here: an unknown kind
 * collapses to `fill`, a non-finite number falls back, an unknown blend becomes
 * `normal`, and nothing arrives on the layer that was not declared.
 *
 * `paint` goes through `mergeFill`, so a layer whose paint is a bare colour
 * string (hand-written JSON, or a stroke migrated from its `#rrggbb`) is lifted
 * exactly as the old flat `fill` was.
 */
function mergeLayer(raw: unknown, id: string): VtAppearanceLayer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const kind = oneOf(o.kind, VT_LAYER_KINDS, 'fill')
  return {
    id,
    kind,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    paint: mergeFill(o.paint),
    anchor: oneOf(o.anchor, VT_FILL_ANCHORS, LAYER_DEFAULTS.anchor),
    opacity: clamp(num(o.opacity, LAYER_DEFAULTS.opacity), 0, 1),
    blend: oneOf(o.blend, BLEND_MODES, LAYER_DEFAULTS.blend),
    // Per kind, and with the one-shot backfill normalisation — see `mergedWidth`.
    width: mergedWidth(o, kind),
    // A flat colour, rebuilt like everything else here. Not run through
    // `mergeFill`: this is a `string`, not a `Paint` — see the field's doc for why
    // the extrude's outline is deliberately not the nine-type fill model.
    strokeColor: str(o.strokeColor, LAYER_DEFAULTS.strokeColor),
    depth: clamp(Math.round(num(o.depth, LAYER_DEFAULTS.depth)), 0, VT_EXTRUDE_DEPTH_MAX),
    angle: num(o.angle, LAYER_DEFAULTS.angle),
    distance: num(o.distance, LAYER_DEFAULTS.distance),
    taper: clamp(num(o.taper, LAYER_DEFAULTS.taper), -1, 1),
    solid: typeof o.solid === 'boolean' ? o.solid : false,
    // Backfilled to 1 — FULLY DRAWN — so a stack saved before draw-on existed
    // loads with every stroke intact rather than invisible.
    draw: clamp(num(o.draw, LAYER_DEFAULTS.draw), 0, 1),
  }
}

/**
 * Rebuild a stored stack.
 *
 * TWO PASSES over the ids, and the order matters. Pass one claims every valid,
 * non-duplicate stored id; pass two mints for the rest. Minting inside a single
 * pass would let a positional fallback (`L0`) steal an id a LATER layer legibly
 * holds, and that layer would then be renamed on load — silently breaking any
 * binding written against it.
 *
 * A DUPLICATE id keeps the first occurrence and re-mints the second: duplicates
 * are a data bug (a duplicate-layer action that forgot to mint), and
 * `resolveIdPath` resolves a duplicate to the LOWEST index, so leaving both
 * would make one binding address two layers.
 *
 * A layer that was never given an id gets a POSITIONAL fallback (`L<index>`).
 * That is stable across loads of an unchanged file, which is the most that can
 * be promised for data that never had an identity — it is not stable across a
 * reorder, but nothing can be bound to it yet either.
 *
 * Bounded by `VT_LAYER_MAX`; extras are dropped rather than rendered, matching
 * Gradient and Shader.
 */
function mergeAppearance(raw: unknown[]): VtAppearanceLayer[] {
  const capped = raw.slice(0, VT_LAYER_MAX)
  const taken = new Set<string>()
  const ids: (string | null)[] = capped.map((entry) => {
    const id = validLayerId((entry as Record<string, unknown> | null)?.id)
    if (!id || taken.has(id)) return null
    taken.add(id)
    return id
  })
  const out: VtAppearanceLayer[] = []
  for (let i = 0; i < capped.length; i++) {
    let id = ids[i]
    if (!id) {
      let n = i
      do { id = `L${n}`; n++ } while (taken.has(id))
      taken.add(id)
    }
    const layer = mergeLayer(capped[i], id)
    // A non-object entry is not a layer with bad values, it is not a layer —
    // dropped, the same way `mergeTrack` drops a track with no path.
    if (layer) out.push(layer)
  }
  return out
}

/**
 * TRAP 4 — turn a pre-stack saved config into an appearance stack.
 *
 * EVERY saved Vector Type node holds the flat `fill` / `fillAnchor` / `stroke` /
 * `strokeWidth`, and `mergeConfig` is the only place that knows how to read
 * them. The three rules:
 *
 *  1. `fill` + `fillAnchor` become ONE `fill` layer, id `VT_BASE_FILL_ID`.
 *  2. A `strokeWidth > 0` stroke becomes one `stroke` layer ABOVE it (later in
 *     the array = painted in front), reproducing the old fixed order.
 *  3. `strokeWidth === 0` produces NO stroke layer. That stroke was never
 *     visible — it is the default, and the whole reason users concluded this
 *     studio had no stroke. Materialising it would put a dead layer in every
 *     migrated node's stack.
 *
 * ONE EXCEPTION to rule 3, and it exists to avoid destroying user work: if a
 * MOTION TRACK animates `strokeWidth` between two values that are not both zero,
 * the stroke was visible — just not at rest. Dropping the layer would silently
 * delete an animation the user built. So the layer is created with the stored
 * (zero) width and the remapped track drives it, which paints exactly what the
 * old renderer painted at every t.
 */
export function migrateLegacyAppearance(legacy: VtLegacyPaint, strokeIsAnimated = false): VtAppearanceLayer[] {
  const out: VtAppearanceLayer[] = [vtLayer({
    id: VT_BASE_FILL_ID,
    kind: 'fill',
    paint: mergeFill(legacy?.fill),
    anchor: oneOf(legacy?.fillAnchor, VT_FILL_ANCHORS, LAYER_DEFAULTS.anchor),
  })]
  const width = Math.max(0, num(legacy?.strokeWidth, 0))
  if (width > 0 || strokeIsAnimated) {
    out.push(vtLayer({
      id: VT_BASE_STROKE_ID,
      kind: 'stroke',
      // The legacy stroke was `#rrggbb`; `mergeFill` lifts it to a solid `Fill`
      // exactly as it lifts a legacy flat fill, so both arms of a migrated stack
      // speak one vocabulary.
      paint: mergeFill(typeof legacy?.stroke === 'string' ? legacy.stroke : '#000000'),
      width,
    }))
  }
  return out
}

/**
 * Rewrite a pre-stack motion track path onto the migrated stack, or `null` to
 * drop the track.
 *
 * POSITIONAL, not id-addressed, and deliberately: `applyMotion` resolves through
 * `getByPath`/`setByPath`, which understand positions only. Task 9 moves the
 * whole motion system onto `resolveIdPath`; until then an id-shaped path here
 * would silently animate nothing.
 *
 * Only the two animatable legacy paint keys existed — `fill.angle` /
 * `fill.density` (sliders on the `Fill` arm) and `strokeWidth`. `fillAnchor` and
 * `stroke` were a select and a colour, neither animatable, so no saved track can
 * point at them.
 */
function remapLegacyTrackPath(path: string, appearance: VtAppearanceLayer[]): string | null {
  if (path === 'strokeWidth') {
    const i = appearance.findIndex(l => l.kind === 'stroke')
    return i === -1 ? null : `appearance.${i}.width`
  }
  if (path.startsWith('fill.')) {
    const i = appearance.findIndex(l => l.kind === 'fill')
    return i === -1 ? null : `appearance.${i}.paint.${path.slice('fill.'.length)}`
  }
  if (path === 'fill' || path === 'fillAnchor' || path === 'stroke') return null
  return path
}

/**
 * Lift every POSITIONAL stack track path onto the layer's stable id.
 *
 * ## Why this exists
 *
 * `appearance.1.width` and `appearance.Lstroke.width` are two addressing schemes
 * for the same thing, and until this function both were live in one config: a
 * track written before ids landed is positional, a track written after it is
 * id-addressed, and so is every Collection binding and every agent key. Nothing
 * migrated the old form, so a project saved mid-development carried a reference
 * that only stays correct while `VT_APPEARANCE_REMAP` is called at every single
 * mutation site, forever, by every future author. An id path needs no such
 * promise: reorder is a no-op because there is nothing to rewrite.
 *
 * `mergeConfig` is the right home because it is the one place a stored blob is
 * rebuilt, and because the rewrite is only sound against a REBUILT stack (see
 * below).
 *
 * ## Rewrite only what resolves, and never guess
 *
 * `toIdPath` returns `undefined` for four different reasons and all four mean
 * "leave this path exactly as it is":
 *
 *  - the path is ALREADY id-addressed (the common case after the first load);
 *  - the index is out of range — the track is already dead, and `resolveIdPath`
 *    refuses it at render time. Inventing an id for it would resurrect it onto a
 *    real layer, which is strictly worse than a track that animates nothing;
 *  - the layer at that index has no usable id. `mergeAppearance` mints one for
 *    every layer, so this is only reachable from a caller that hands raw layers
 *    in;
 *  - the path is not a member path at all.
 *
 * Nothing is ever DROPPED here. A dangling track is `pruneStackTracks`'s job,
 * asked at the mutation site where the user can see what happened; silently
 * deleting a row during a load is the one behaviour a merge must not have.
 *
 * ## The indices must be the MERGED stack's
 *
 * `mergeAppearance` can drop a member (a non-object entry) and caps the stack at
 * `VT_LAYER_MAX`, so raw index 2 is not necessarily merged index 2. The rewrite
 * is therefore done against the merged array — which is also the array
 * `applyMotion` resolves a surviving positional path against today, so this
 * function preserves the picture exactly rather than "fixing" it into a
 * different one.
 *
 * Returns the SAME array when nothing changed, so a caller can compare by
 * identity and a Vue watcher does not fire on a no-op load.
 */
export function migrateStackTrackPaths(
  tracks: VtMotionTrack[],
  appearance: VtAppearanceLayer[],
): VtMotionTrack[] {
  // `toIdPath` reads `cfg[list]`, and the only list it needs is this one — so it
  // is asked about a bare `{ appearance }` rather than a half-built config.
  const host = { [VT_STACK_LIST]: appearance }
  let changed = false
  const out = tracks.map((t) => {
    if (!t.path.startsWith(VT_STACK_PREFIX)) return t
    const id = toIdPath(host, t.path)
    if (!id || id === t.path) return t
    changed = true
    return { ...t, path: id }
  })
  return changed ? out : tracks
}

/**
 * The moves-shaped twin of `migrateStackTrackPaths` above: lifts every
 * POSITIONAL stack track path onto the layer's stable id, across every
 * `'tracks'`-kind MOVE's own `tracks` array rather than a flat top-level one —
 * a track's home is now inside the move that owns its ease/play (see
 * `VtMotionConfig.moves`), so this is what `mergeConfig` calls instead.
 *
 * Same rule, same reasoning as `migrateStackTrackPaths` (only what resolves is
 * rewritten; nothing is ever dropped here), and the same identity contract:
 * returns the SAME `moves` array when nothing changed, and a move whose own
 * tracks did not change is itself returned BY REFERENCE, so an unrelated
 * move's identity survives a load that only touched one other move.
 */
function migrateMoveTrackPaths(moves: VtMove[], appearance: VtAppearanceLayer[]): VtMove[] {
  const host = { [VT_STACK_LIST]: appearance }
  let changedAny = false
  const out = moves.map((mv) => {
    if (mv.kind !== 'tracks' || !Array.isArray(mv.tracks) || !mv.tracks.length) return mv
    let changed = false
    const tracks = mv.tracks.map((t) => {
      if (!t.path.startsWith(VT_STACK_PREFIX)) return t
      const id = toIdPath(host, t.path)
      if (!id || id === t.path) return t
      changed = true
      return { ...t, path: id }
    })
    if (!changed) return mv
    changedAny = true
    return { ...mv, tracks }
  })
  return changedAny ? out : moves
}

/**
 * ## THE BRIDGE — Task 3 deletes this, and nothing else should grow a caller
 *
 * "Which single fill and which single stroke would the pre-stack renderer have
 * drawn?" — the bottom-most ENABLED layer of each kind. It exists so `canvas.ts`
 * and the studio surface keep painting while Task 3 replaces the fill/stroke
 * pair with a real back-to-front layer loop. On a one-fill stack (a fresh config
 * and every migrated legacy node) it is not an approximation at all: it is the
 * same picture, pixel for pixel. On a taller stack it draws the bottom pair only
 * — a SIMPLIFICATION of the stack, never a different picture.
 *
 * `fill` is returned BY REFERENCE, so a `layer.paint.*` control write lands on
 * the layer rather than on a copy. That is what lets the paint controls keep
 * working through the bridge.
 *
 * It also tolerates a RAW, never-merged blob, because `applyMotion` clones
 * whatever it is handed and the plan's trap 4 is precisely that
 * `ensureConfigDefaults`-style normalisation is not on the universal load path.
 * With no `appearance` array it falls back to reading the legacy flat fields —
 * so a node card rendering straight from stored JSON still paints the user's
 * colours instead of defaulting to white.
 */
export interface VtBaseAppearance {
  /** The base fill layer's paint, or `undefined` when the stack has no enabled
   *  fill layer (a legitimate state: the user removed it). */
  fill: Paint | undefined
  fillAnchor: VtFillAnchor
  /** The base stroke layer's paint. `undefined` when there is no stroke layer,
   *  which is also when `strokeWidth` is 0. */
  stroke: Paint | undefined
  /** OUTPUT pixels. 0 = no stroke, exactly as the flat field meant. */
  strokeWidth: number
}

export function vtBaseAppearance(cfg: VectorTypeConfig | VtLegacyPaint | null | undefined): VtBaseAppearance {
  const stack = (cfg as VectorTypeConfig | null)?.appearance
  if (!Array.isArray(stack)) {
    const legacy = (cfg ?? {}) as VtLegacyPaint
    const width = Math.max(0, num(legacy.strokeWidth, 0))
    return {
      fill: legacy.fill ?? undefined,
      fillAnchor: oneOf(legacy.fillAnchor, VT_FILL_ANCHORS, LAYER_DEFAULTS.anchor),
      stroke: width > 0 && typeof legacy.stroke === 'string' ? legacy.stroke : undefined,
      strokeWidth: width,
    }
  }
  const fill = stack.find(l => l?.kind === 'fill' && l.enabled !== false)
  const stroke = stack.find(l => l?.kind === 'stroke' && l.enabled !== false)
  const width = Math.max(0, num(stroke?.width, 0))
  return {
    fill: fill?.paint,
    fillAnchor: oneOf(fill?.anchor, VT_FILL_ANCHORS, LAYER_DEFAULTS.anchor),
    stroke: width > 0 ? stroke?.paint : undefined,
    strokeWidth: width,
  }
}

/** Rebuild the axes record: four-char tags mapped to finite numbers, nothing else.
 *  A stringified number is REJECTED rather than coerced — `Number('')` is 0 and
 *  `Number('700abc')` is NaN, so coercion here would invent axis positions. */
function mergeAxes(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [tag, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAxisTag(tag)) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    out[tag] = v
  }
  return out
}

/**
 * `#abc` / `#aabbcc` / `#aabbccdd` → the lower-case long form; anything else →
 * null.
 *
 * REJECTS rather than clamps, which is the opposite of what `clampHex` does (it
 * returns black for junk) and the difference matters here: a track whose colour
 * silently became black would animate the fill to black, which reads as a
 * rendering bug. A track whose colour fails to parse is not a colour track at
 * all, so it keeps animating whatever its numeric `from`/`to` say — nothing, for
 * a colour LEAF, which is visible and recoverable.
 */
function mergeTrackColor(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(s) || /^#[0-9a-f]{8}$/.test(s)) return s
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
  return null
}

/** Rebuild one motion track, or null if it targets nothing. A track without a
 *  path cannot be evaluated or edited — it would sit in the timeline forever
 *  doing nothing — so it is dropped rather than defaulted to some path. */
function mergeTrack(raw: unknown, remap?: (path: string) => string | null): VtMotionTrack | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const raws = typeof o.path === 'string' ? o.path.trim() : ''
  if (!raws) return null
  // `remap` is supplied only when this config was MIGRATED from the flat paint
  // fields, and it may return null for a track whose target no longer exists —
  // dropped, for the same reason a path-less track is.
  const path = remap ? remap(raws) : raws
  if (!path) return null
  const out: VtMotionTrack = {
    path,
    from: num(o.from, 0),
    to: num(o.to, 0),
    hold: clamp(num(o.hold, 0), 0, 0.5),
    cycleOffset: clamp(num(o.cycleOffset, 0), 0, 1),
    delay: Math.max(0, num(o.delay, 0)),
  }
  // ALL THREE COLOUR FIELDS OR NONE. A track carrying only `fromColor` is not
  // half a colour track, it is a numeric track with a stray key — and writing
  // the stray key back would make every consumer test `both` rather than
  // `either`, which is exactly the kind of half-state this rebuild exists to
  // make unreachable. `space` falls back (it is a name, not a point on a scale).
  const fromColor = mergeTrackColor(o.fromColor)
  const toColor = mergeTrackColor(o.toColor)
  if (fromColor && toColor) {
    out.fromColor = fromColor
    out.toColor = toColor
    out.space = isColorMixSpace(o.space) ? o.space : DEFAULT_COLOR_MIX_SPACE
  }
  return out
}

/** Rebuild the stagger block. Same strictness as everything else here: an
 *  unknown order, a NaN delay or a fractional seed can only ever yield the
 *  default, never a value the evaluator has to defend against. */
function mergeStagger(raw: unknown): VtStaggerConfig {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  return {
    // Negative delays are not "reverse" — `order` already says that — so they
    // clamp to 0 rather than silently inverting the queue.
    delay: clamp(num(o.delay, DEFAULT_STAGGER.delay), 0, VT_STAGGER_DELAY_MAX),
    order: oneOf(o.order, VT_STAGGER_ORDERS, DEFAULT_STAGGER.order),
    seed: clamp(Math.round(num(o.seed, DEFAULT_STAGGER.seed)), 0, VT_STAGGER_SEED_MAX),
  }
}

/**
 * Rebuild the blink block.
 *
 * Same strictness as `mergeStagger`, and one decision worth naming: `amount`,
 * `rate` and `stayLit` CLAMP into range rather than falling back to the default.
 * A stored `amount: 3` came from a config that meant "as much as possible", and
 * resetting it to the default 0 would silently switch a saved animation off —
 * the failure this whole file exists to prevent. An unknown `unit` has no such
 * reading (it is a name, not a point on a scale), so that one falls back.
 */
function mergeBlink(raw: unknown): VtBlinkConfig {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  return {
    amount: clamp(num(o.amount, DEFAULT_BLINK.amount), 0, 1),
    rate: clamp(num(o.rate, DEFAULT_BLINK.rate), 0, VT_BLINK_RATE_MAX),
    stayLit: clamp(num(o.stayLit, DEFAULT_BLINK.stayLit), 0, 1),
    unit: oneOf(o.unit, VT_BLINK_UNITS, DEFAULT_BLINK.unit),
    seed: clamp(Math.round(num(o.seed, DEFAULT_BLINK.seed)), 0, VT_BLINK_SEED_MAX),
  }
}

/**
 * Rebuild the scatter block.
 *
 * Same rule as `mergeBlink`: the numbers CLAMP into range rather than falling
 * back, because a stored `spread: 3` came from a config that meant "as far as
 * possible" and resetting it to 0 would silently switch a saved animation off.
 * `mode` falls back (a name is not a point on a scale).
 *
 * `axis` is the odd one out and it is deliberate: any well-formed OpenType tag
 * is KEPT, even one the current font does not declare, exactly as `mergeAxes`
 * keeps a tag the current font lacks. A user who set up a `GRAD` scatter on
 * Roboto Flex, switched to Inter to check something and switched back must find
 * their scatter still aimed at `GRAD`. It degrades to IGNORED-with-a-reason in
 * between (`vtScatterAvailability`), never to "applied to the wrong axis".
 */
function mergeScatter(raw: unknown): VtScatterConfig {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  return {
    spread: clamp(num(o.spread, DEFAULT_SCATTER.spread), 0, 1),
    axis: isVtScatterAxis(o.axis) ? (o.axis as string) : DEFAULT_SCATTER.axis,
    mode: oneOf(o.mode, VT_SCATTER_MODES, DEFAULT_SCATTER.mode),
    settle: clamp(num(o.settle, DEFAULT_SCATTER.settle), 0, VT_SCATTER_SETTLE_MAX),
    rate: clamp(num(o.rate, DEFAULT_SCATTER.rate), 0, VT_SCATTER_RATE_MAX),
    seed: clamp(Math.round(num(o.seed, DEFAULT_SCATTER.seed)), 0, VT_SCATTER_SEED_MAX),
  }
}

/**
 * A legacy engine-name ease string (e.g. `power2.out`, `sine.inOut`) → the
 * nearest of the ten NAMED eases, or `null` when it names none of them (a
 * bezier string, or nothing at all) — `mergeMove`'s own `mergeEase` then falls
 * back to `DEFAULT_EASE`, exactly the rule the spec calls for: "ease from the
 * spec's `ease` string if it names one of the ten, else default."
 *
 * A ROUGH map, on purpose: the old preset engine's own vocabulary (Compositor's
 * `MotionPresetPicker`) is a different, larger set than the ten this stack
 * offers, so this is "the closest family", not a lossless round-trip. It only
 * ever runs once, at the migration of a document that pre-dates moves.
 */
function legacyPresetEaseName(ease: string | undefined): MoveEaseName | null {
  if (!ease) return null
  const e = ease.trim()
  if (e === 'none' || e === 'linear') return 'none'
  if (e.startsWith('power')) return e.includes('.in') && !e.includes('inOut') ? 'accelerate' : 'smooth'
  if (e === 'sine.inOut') return 'natural'
  if (e.startsWith('back')) return 'overshoot'
  if (e.startsWith('elastic')) return 'elastic'
  if (e.startsWith('bounce')) return 'bounce'
  if (e.startsWith('steps')) return 'steps'
  return null
}

/**
 * The ease a migrated `in`/`out`/`loop` preset slot gets when the STORED slot
 * carried no `ease` string of its own — which is every real saved document,
 * since `ease` was never a field the pre-moves slot schema wrote. This is the
 * render-parity fix: the old engine did not run a slot at a fixed `smooth` —
 * it ran each preset at ITS OWN native ease (an axis preset's `.ease`, a
 * kinetic preset's IN/OUT-table ease, both looked up and mapped through the
 * SAME `legacyPresetEaseName` above; a loop's phase LINEARLY, un-eased). A
 * migrated move that instead defaults to `smooth` — the moves engine's own
 * default, applied when `mergeMove` is handed no `ease` at all — silently
 * changes every migrated preset's motion: grow-in stops overshooting,
 * elastic-drop bounces on the wrong curve, fade-out decelerates instead of
 * accelerating, and every loop preset's wave deforms (a non-`none` ease
 * warps a periodic phase into something that no longer closes the loop).
 *
 * `loop` short-circuits to `none` rather than going through a table lookup:
 * no loop preset ever had an ease of its own to look up (the old engine ran
 * `LOOP_EVAL` directly against the raw cycle phase — see
 * `lib/motion/evaluate.ts`'s `evaluateAnimation`), so `none` (linear) is the
 * one faithful answer, not a fallback.
 *
 * For `in`/`out`: an axis preset (`vtAxisPreset`) is checked first because a
 * presetId can only ever be ONE of the two tables (axis ids and kinetic ids
 * are drawn from disjoint namespaces — see `presetMotion.ts`'s
 * `vtAxisPresetIdsFor`/`presetIdsFor`), so the order is never ambiguous; a
 * kinetic id simply misses the axis table and falls through to
 * `nativeEaseFor`. Whatever native ease string is found — engine-shaped
 * (`back.out(1.7)`, `power3.out`, …) either way — goes through the SAME
 * `legacyPresetEaseName` map above, so an axis preset and a kinetic preset
 * land on a `MoveEaseName` by identical rules. A preset id neither table
 * recognises (should not happen — this only ever runs against a `presetId`
 * that was itself validated moments earlier by `mergeMove`) or a native ease
 * that names none of the ten falls back to `smooth`, the same safe default
 * the un-migrated code path already used.
 */
function legacyPresetNativeEase(slot: VtPresetSlot, presetId: string): MoveEase {
  if (slot === 'loop') return { kind: 'named', name: 'none' }
  const native = vtAxisPreset(slot, presetId)?.ease ?? nativeEaseFor(slot, presetId)
  const mapped = legacyPresetEaseName(native)
  return { kind: 'named', name: mapped ?? 'smooth' }
}

/**
 * Rebuild the motion block, converting an OLD-shape document to `moves` as it
 * loads.
 *
 * TWO INPUT SHAPES, told apart by which keys are present — never by a version
 * number, because none was ever stored:
 *
 *  - **NEW** — a `moves` array. Every entry goes straight through the shared,
 *    studio-neutral `mergeMove` (its own `mergeTrackFn` is `mergeTrack`, so a
 *    `'tracks'`-kind move's tracks are validated exactly as a bare track
 *    always was — path, range, hold/cycleOffset/delay, and the colour triple).
 *  - **OLD** — the three preset slots (`in`/`out`/`loop`) and/or a flat
 *    `tracks` array, with no `moves` key at all. CONVERTED, once, here:
 *
 *      1. each slot with a `presetId` becomes ONE preset move at that phase —
 *         `play` is `repeat ×1` for `loop` (the old loop ran forever, and
 *         `repeat` is what "no play mode" meant before play modes existed)
 *         and `once` for `in`/`out`, matching how those two always played;
 *      2. the flat `tracks` array is handed to the shared, studio-neutral
 *         `convertLegacyTracks` (`~/lib/studio/moves/merge`) with THIS clip's
 *         `duration` as the converted move's cycle length — a pre-moves loop
 *         always ran one cycle over the whole clip, so anything else would
 *         change the old loop's SPEED, not just its representation.
 *
 * Blink and Scatter are untouched by either branch: they were never slots or
 * tracks, they are their own config blocks in both the old and new shapes, and
 * `mergeMotion` reads them the same way regardless — see `mergeBlink` /
 * `mergeScatter` below.
 *
 * A raw motion block with NEITHER a `moves` key nor any old-shape key (a
 * completely fresh document, or a corrupted one) produces `moves: []` — the
 * same default a brand-new config has, so nothing is invented from nothing.
 */
const VT_MOVE_KINDS: ReadonlySet<string> = new Set(['preset', 'tracks', 'blink', 'scatter'] satisfies VtMove['kind'][])

/**
 * Narrow a shared `Move` (`kind` is a plain `string` there) to this studio's
 * `VtMove` — CHECKED at runtime, not merely asserted, because this is the one
 * seam a move crosses from the studio-neutral merge module
 * (`~/lib/studio/moves/merge`'s `mergeMove` / `convertLegacyTracks`) into this
 * studio's own `moves` array, and both take untrusted, possibly-corrupted
 * JSON as input. In practice neither producer ever emits anything outside the
 * four: `mergeMove` collapses every non-`'tracks'` input to `'preset'`
 * (`~/lib/studio/moves/merge.ts` — `o.kind === 'tracks' ? 'tracks' : 'preset'`)
 * and `convertLegacyTracks` only ever builds `'tracks'`-kind moves — so this
 * never actually drops anything today. It stays a real check rather than a
 * cast so a future producer that adds a fifth kind fails by dropping the move
 * (same "nothing is trusted" rule the rest of this merge follows) instead of
 * by lying to the type system.
 */
function asVtMove(mv: Move | null | undefined): VtMove | null {
  return mv && VT_MOVE_KINDS.has(mv.kind) ? (mv as VtMove) : null
}

function mergeMotion(raw: unknown, remap?: (path: string) => string | null): VtMotionConfig {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  // Every 'tracks'-kind move's own tracks go through the SAME per-track
  // validation a bare track always used — `mergeTrack` — including the
  // pre-stack `remap`, so a track inside a move is exactly as strict as one
  // used to be at the top level. `mergeMove` wants `undefined`, not `null`,
  // for "no track" — `mergeTrack` returns `null`, so the two are bridged here.
  const mergeTrackFn = (t: unknown): VtMotionTrack | undefined => mergeTrack(t, remap) ?? undefined
  const duration = clamp(num(o.duration, DEFAULT_MOTION.duration), 0.1, 60)

  const hasNewShape = Array.isArray(o.moves)
  const hasOldShape = !hasNewShape && (('tracks' in o) || VT_PRESET_SLOTS.some(slot => slot in o))
  const moves: VtMove[] = []

  if (hasNewShape) {
    for (const rawMove of o.moves as unknown[]) {
      const m = asVtMove(mergeMove(rawMove, mergeTrackFn))
      if (m) moves.push(m)
    }
  } else if (hasOldShape) {
    // 1) The three preset slots → one preset move per populated slot.
    for (const slot of VT_PRESET_SLOTS) {
      const rawSlot = o[slot]
      if (!rawSlot || typeof rawSlot !== 'object' || Array.isArray(rawSlot)) continue
      const so = rawSlot as Record<string, unknown>
      const presetId = typeof so.presetId === 'string' ? so.presetId.trim() : ''
      if (!presetId) continue
      // A stored `ease` string (never written by any real pre-moves document,
      // but honoured if present) is mapped and kept as-is — an EXPLICIT ease
      // is never overridden. Its absence is the real-world case, and gets the
      // preset's own NATIVE ease (`legacyPresetNativeEase`), not the moves
      // engine's `smooth` default — see that function's doc for why.
      const storedEase = typeof so.ease === 'string' ? so.ease : undefined
      const ease: MoveEase = storedEase !== undefined
        ? { kind: 'named', name: legacyPresetEaseName(storedEase) ?? 'smooth' }
        : legacyPresetNativeEase(slot, presetId)
      const m = asVtMove(mergeMove({
        id: `move-${slot}`,
        phase: slot,
        kind: 'preset',
        presetId,
        duration: num(so.duration, VT_PRESET_DURATIONS[slot]),
        ease,
        play: slot === 'loop' ? { mode: 'repeat', times: 1 } : { mode: 'once', times: 1 },
        params: so.params,
      }, mergeTrackFn))
      if (m) moves.push(m)
    }
    // 2) The flat `tracks` array → the shared, studio-neutral legacy
    // conversion — a matched run-level preset collapses to one move, and
    // every leftover track becomes its own Custom move (see
    // `convertLegacyTracks`'s own doc for the exact rule).
    const rawTracks = Array.isArray(o.tracks) ? (o.tracks as unknown[]) : []
    const legacyTracks: LegacyMotionTrack[] = []
    for (const t of rawTracks) {
      // `mergeTrack` is the ONE place a track's path/range/timing/colour are
      // validated — reused here rather than re-parsed, so a legacy track
      // converts under exactly the same rules a bare one always did.
      const merged = mergeTrack(t, remap)
      if (!merged) continue
      const to = (t && typeof t === 'object' ? (t as Record<string, unknown>) : {})
      legacyTracks.push({
        path: merged.path,
        from: merged.from,
        to: merged.to,
        hold: merged.hold,
        cycleOffset: merged.cycleOffset,
        delay: merged.delay,
        ...(merged.fromColor ? { fromColor: merged.fromColor } : {}),
        ...(merged.toColor ? { toColor: merged.toColor } : {}),
        // `mix` is the shared shape's generic name for what this studio calls
        // `space` — carried across so a migrated colour track (e.g. a
        // Colour Cycle track saved with `space: 'oklch'`) keeps its mix space
        // rather than silently falling back to the default.
        ...(merged.space ? { mix: merged.space } : {}),
        // Raw, barely-typed: `convertLegacyTracks`'s own `legacyTrackEasePlay`
        // falls back the same way `mergeTrack` used to for an unrecognised
        // `easing` or a non-finite `loops` — only the TS shape (`string` /
        // `number`, not `unknown`) needs narrowing here.
        ...(typeof to.easing === 'string' ? { easing: to.easing } : {}),
        ...(typeof to.loops === 'number' ? { loops: to.loops } : {}),
      })
    }
    for (const mv of convertLegacyTracks(legacyTracks, vtMatchLegacyTrackPreset, duration)) {
      const v = asVtMove(mv)
      if (v) moves.push(v)
    }
  }

  return {
    moves,
    duration,
    fps: clamp(Math.round(num(o.fps, DEFAULT_MOTION.fps)), 1, 60),
    size: oneOfNum(o.size, VT_MOTION_SIZES, DEFAULT_MOTION.size),
    stagger: mergeStagger(o.stagger),
    blink: mergeBlink(o.blink),
    scatter: mergeScatter(o.scatter),
  }
}

/**
 * Rebuild an untrusted parsed value into a valid VectorTypeConfig.
 *
 * Every field is checked against its own type and domain; anything that fails
 * falls back to the default. `null`, `{}`, an array, a string, a config from a
 * version that spelled a field differently — all yield a usable config.
 */
export function mergeConfig(raw: unknown): VectorTypeConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const d = DEFAULT_CONFIG
  // A stack is PRESENT when the key is an array — including an EMPTY one, which
  // is the user having removed every layer and must not be re-migrated back into
  // a fill. Anything else (absent, null, an object) is a pre-stack config and
  // goes through the trap-4 migration.
  const stored = Array.isArray(o.appearance) ? (o.appearance as unknown[]) : null
  // Read the raw track paths BEFORE the merge, because whether a legacy
  // zero-width stroke becomes a layer depends on whether anything animates it.
  const strokeIsAnimated = !stored && legacyStrokeIsAnimated(o.motion)
  const appearance = stored
    ? mergeAppearance(stored)
    : migrateLegacyAppearance(o as VtLegacyPaint, strokeIsAnimated)
  const motion = mergeMotion(o.motion, stored ? undefined : path => remapLegacyTrackPath(path, appearance))
  // Both vintages of positional path are lifted here, and BOTH need it: a track
  // saved before ids existed, and the `appearance.<i>.width` that
  // `remapLegacyTrackPath` just wrote a line above for a legacy `strokeWidth`
  // animation. Same rewrite, one call, after the stack it is addressed against
  // is final. `migrateMoveTrackPaths` is `migrateStackTrackPaths`'s moves-shaped
  // twin — a track's home is a move's `tracks` array now, not a flat one.
  const moves = migrateMoveTrackPaths(motion.moves, appearance)
  return {
    text: str(o.text, d.text),
    // An unknown font id is NOT kept: every later stage (the proxy, the loader,
    // the axis controls) resolves it against the catalog, so keeping it would
    // leave the studio pointing at a font that can never load.
    fontId: oneOf(o.fontId, VT_FONT_IDS, d.fontId),
    axes: mergeAxes(o.axes),
    size: num(o.size, d.size),
    tracking: num(o.tracking, d.tracking),
    align: oneOf(o.align, VT_ALIGNS, d.align),
    // NOT clamped here, deliberately — `size` is not either. The bound belongs
    // at the RENDER choke point (`vtRunShear`), because a motion track's
    // `from`/`to` are arbitrary numbers that never pass through this merge, and
    // a guarantee only one of the two entrances honours is not a guarantee.
    skewX: num(o.skewX, d.skewX),
    skewY: num(o.skewY, d.skewY),
    // Same reasoning, same choke point — `vtArcSweep`.
    arc: num(o.arc, d.arc),
    stretch: clamp(num(o.stretch, d.stretch), VT_STRETCH_MIN, VT_STRETCH_MAX),
    stretchY: clamp(num(o.stretchY, d.stretchY), VT_STRETCH_MIN, VT_STRETCH_MAX),
    fit: oneOf(o.fit, VT_FITS, d.fit),
    appearance,
    motion: moves === motion.moves ? motion : { ...motion, moves },
  }
}

/** Does a pre-stack config animate its `strokeWidth` away from zero? See rule 3's
 *  exception in `migrateLegacyAppearance`. Reads the RAW motion block, because
 *  this question is asked before the merge that would normalise it. */
function legacyStrokeIsAnimated(rawMotion: unknown): boolean {
  const o = (rawMotion && typeof rawMotion === 'object' ? rawMotion : {}) as Record<string, unknown>
  const tracks = Array.isArray(o.tracks) ? o.tracks : []
  return tracks.some((t) => {
    const tr = (t ?? {}) as Record<string, unknown>
    if (typeof tr.path !== 'string' || tr.path.trim() !== 'strokeWidth') return false
    return num(tr.from, 0) > 0 || num(tr.to, 0) > 0
  })
}

/** A deep copy safe to mutate — what motion evaluation clones before applying
 *  tracks, and what the surface hands to a preview render. */
export function cloneConfig(cfg: VectorTypeConfig): VectorTypeConfig {
  // Tolerant of a config straight out of storage (`motion`/`moves`/`stagger`
  // absent), because `applyMotion` clones BEFORE anything normalises — see the
  // choke-point note in ./motion.ts. Values are copied, never invented: a
  // missing block clones as empty and the evaluator resolves defaults itself.
  const m = cfg.motion
  // Every move carries nested OBJECTS a shallow spread would leave shared with
  // the source — `ease`/`play`, a `'tracks'` move's own `tracks` array, and a
  // `'preset'` move's `params` knob record. Same reasoning as `blink`/`scatter`
  // below: `applyMotion` writes THROUGH this clone, so anything left shared
  // would let frame 37's value land back in the config the surface is holding.
  const cloneMove = (mv: VtMove): VtMove => ({
    ...mv,
    ease: mv.ease.kind === 'bezier'
      ? { kind: 'bezier', cps: [...mv.ease.cps] as [number, number, number, number] }
      : { ...mv.ease },
    play: { ...mv.play },
    ...(mv.params ? { params: { ...mv.params } } : {}),
    ...(mv.tracks ? { tracks: mv.tracks.map(t => ({ ...t })) } : {}),
  })
  const moves: VtMove[] = Array.isArray(m?.moves) ? m.moves.map(cloneMove) : []
  return {
    ...cfg,
    axes: { ...cfg.axes },
    // The stack and every paint in it are mutable OBJECTS, so the shallow spread
    // above would leave the clone sharing them. `layer.paint.angle` /
    // `layer.paint.density` / `layer.width` are animatable, and `applyMotion`
    // writes THROUGH this clone: without the deep copy, frame 37's angle lands in
    // the config the surface is holding — and, because `DEFAULT_CONFIG` holds one
    // layer object, in the module-level default too. Tolerant of a raw stored
    // blob (no `appearance` at all), same as its caller.
    //
    // Spread CONDITIONALLY: a raw legacy blob has no `appearance`, and writing an
    // empty array onto the clone would tell `vtBaseAppearance` "the user removed
    // every layer" instead of "this was never migrated" — the clone would then
    // render nothing where the blob renders the user's colours.
    ...(Array.isArray(cfg.appearance)
      ? { appearance: cfg.appearance.map(l => (l && typeof l === 'object' ? { ...l, paint: clonePaint(l.paint) } : l)) }
      : {}),
    motion: {
      ...m,
      stagger: { ...m?.stagger } as VtStaggerConfig,
      // `motion.blink.amount` / `.rate` / `.stayLit` are animatable leaves, so
      // `applyMotion` writes THROUGH this clone. Without the copy, frame 37's
      // blink rate lands in the config the surface is holding — and, because
      // `DEFAULT_CONFIG` holds one blink object, in the module-level default too.
      blink: { ...m?.blink } as VtBlinkConfig,
      // Same story for `motion.scatter.spread` / `.settle` / `.rate`.
      scatter: { ...m?.scatter } as VtScatterConfig,
      moves,
    },
  }
}
