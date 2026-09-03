/**
 * Vector Type Studio — the ONE canvas render path.
 *
 * Four consumers need to turn `(config, time) -> pixels`: the editor surface's
 * preview loop, the node card's live preview, the cascade baker (PNG), and the
 * `StudioFrameSource` a downstream studio pulls frames from. Every one of them
 * goes through `drawVectorType` below.
 *
 * That is not tidiness — it is the "Smart Layout render parity" lesson: three
 * surfaces each grew their own copy of the render and drifted, and the drift is
 * invisible (each one renders SOMETHING). Placement, tracking, alignment and the
 * per-glyph stagger transform are decided here, once.
 *
 * ## The control semantics this implements (Task 5 spelled them out; nothing
 * upstream applies them)
 *
 *  - `size`     — em size in OUTPUT PIXELS, CSS `font-size` semantics.
 *                 `scale = size / unitsPerEm`.
 *  - `tracking` — extra advance per glyph in 1/1000 em, applied AFTER the font's
 *                 own shaping (so kerning survives). Not added after the last
 *                 glyph, so a centred run stays centred.
 *  - `align`    — horizontal anchoring of the run's INK inside the output box.
 *                 Vertical is always centred (v1 is single-line).
 *  - `strokeWidth` — OUTPUT pixels, so it does not shrink as `size` drops.
 *
 * ## The name collision, resolved
 *
 * `./render.ts` and `./motion.ts` both export `glyphTransform` and they mean
 * different things — WHERE the glyph sits vs WHAT motion adds to that. Both are
 * needed here, so both are aliased at the import site (`glyphPlacement` /
 * `glyphMotion`). Task 6 chose the collision deliberately so a module using both
 * has to say which it means; this is that module saying it.
 */
import type { Affine, VectorCommand, VectorPaint, VectorRect, VectorShape } from '~/lib/vector/svg'
import { IDENTITY_AFFINE, formatNumber, multiplyAffine } from '~/lib/vector/svg'
import { fillIsShader, paintPrimaryColor } from '~/lib/spacetype/fillTile'
import { isFill, type Paint } from '~/lib/compositor/paint'
import { paintIsVector, paintToVectorPaint } from '~/lib/paint/toVector'
import {
  OBJECT_SHADER_FIELD_PX,
  hasPaint,
  resolvePaint,
  type PaintSpread,
  type ShaderFieldFrameCtx,
} from '~/lib/paint/resolve'
import { withFieldFrame, type FieldRequest } from '~/lib/shaderfill/field'
import type { BlendKind } from '~/lib/studio/blend'
import {
  VT_ARC_MAX,
  VT_SKEW_MAX,
  VT_STRETCH_MAX,
  VT_STRETCH_MIN,
  migrateLegacyAppearance,
  vtBaseAppearance,
  type VectorTypeConfig,
  type VtAppearanceLayer,
  type VtFillAnchor,
  type VtLegacyPaint,
} from './config'
// The PURE half of extrude only. `./extrudeSolid.ts` — the paper.js boolean
// union — is deliberately NOT imported here and must never be: the union is far
// too slow for a draw loop (plan trap 5), and the import edge runs the other way
// so that adding a call from this file would have to create a cycle. What this
// module knows about `solid` is a `ReadonlyMap` of already-computed geometry a
// bake or an export awaited and handed in — plus a synchronous PEEK at the body
// cache (`./extrudeBodyCache.ts`), which is a `Map.get` in a module that imports
// no paper at all. Reading is free; computing is somebody else's job.
import {
  VT_EXTRUDE_FRAME_BUDGET,
  extrudeBudget,
  extrudeCopyCommands,
  extrudeCopyTransform,
  extrudeOffsets,
  vtCellPivot,
  vtGlyphOffset,
  vtSolidKey,
  type VtExtrudeCopy,
  type VtExtrudeSpec,
  type VtSolidBodies,
} from './extrude'
// The body STORE, not the union. Two functions, both synchronous, neither able
// to compute — see `./extrudeBodyCache.ts` for why the split exists at all.
import { peekSolidBody, solidBodyCacheKey } from './extrudeBodyCache'
import type { VtFont } from './font'
import type { GlyphOutline, TextOutlines } from './outline'
import { textOutlines } from './outline'
import { applyMotion, glyphConfig, glyphStackLeaf, resolveStagger } from './motion'
// Word grouping for `unit: 'word'` blink. Imports nothing itself, so this costs
// the render path a single pass over the shaped run.
import { wordIndexOfGlyph } from './words'
import { vtBlinkActive } from './blink'
import { vtScatterActive } from './scatter'
import { vtAxisCoords } from './axisPresets'
import {
  IDENTITY_GLYPH_MOTION,
  vtEmSize,
  vtGlyphMotion,
  vtHasPreset,
  type VtGlyphClip,
  type VtGlyphMotion,
} from './presetMotion'
import {
  CELL_DESCENT,
  blurRadiusToStdDeviation,
  commandsToPath2D,
  glyphCellClipRect,
  glyphTransform as glyphPlacement,
  outlinesToShapes,
  placeOutlines,
  placedInkBounds,
  shapesToSVG,
  type ResolvedPlacement,
  type RunCurve,
} from './render'
// The arc-length curve module — pure, zero imports of its own, and deliberately
// NOT paper.js: placement runs every frame (see `./curve.ts`'s header).
import { buildCurveTable } from './curve'
// The per-path arc length behind the DRAW-ON — pure, no paper.js, and for the
// same reason: a draw frame measures every glyph's outline (see
// `./pathLength.ts`'s header).
import { pathLength, vtDrawOnDash, type VtDashSpec } from './pathLength'
// The smart-stretch engine — pure geometry, no canvas, no paper.js, so it is
// safe on the draw path for the same reason `./curve.ts` and `./pathLength.ts`
// are. This file decides WHICH numbers each glyph is stretched by; `./stretch.ts`
// decides what a stretch does to an outline, and the split is deliberate: the
// remap is the part that has 87 tests of its own.
import { dampedStretch, fitStretch, planStretch, stretchGlyph, type StretchPlan } from './stretch'

/** The "small margin" fit leaves on each side of the box: 2% of its width. */
export const VT_FIT_INSET = 0.02

/** What a caller who owns a BOX can tell the frame about it. */
export interface VtFrameOptions {
  /** The box's available width in OUTPUT px (padding already removed) — the
   *  fit target. Passed by the three callers that own a box: `drawVectorType`,
   *  `vectorTypeSVG` and `prepareSolidExtrudes` (the solid union has to fuse
   *  around the geometry the other two draw, or the bake disagrees with the
   *  preview and its body cache never hits). `thumbPreview` deliberately does
   *  NOT: a thumbnail is a picture of the config, not a composition inside a
   *  box the user is fitting to, so `fit` is inert there and the dial rules.
   *  A frame asked for without a box renders the dial value — never wrong. */
  fitBoxWidth?: number
}

/** One frame's worth of resolved geometry: what to draw and how each glyph moves. */
export interface VtFrame {
  /** The run, in FONT UNITS, with tracking already folded into the pen positions. */
  outlines: TextOutlines
  /** The config at this instant, on the shared (un-staggered) clock. Paint, size,
   *  tracking and align are read from here — they are run-level, not per-glyph. */
  config: VectorTypeConfig
  /** Per-glyph motion, index-aligned with `outlines.glyphs`: the axis TRACKS and
   *  the entrance/exit/loop PRESETS composed into one state (see
   *  `./presetMotion.ts`). A superset of `VtGlyphTransform` — the extra fields
   *  (`blur`, `clip`, `scaleX/scaleY`, `axes`) are carried for the renderers that
   *  consume them; the five transform fields are what this module draws with. */
  transforms: VtGlyphMotion[]
  /** True when the glyphs were read on their OWN clocks — the travelling-wave
   *  path. Exposed so a caller can ASSERT the intended path executed rather than
   *  inferring it from the picture. Not the same as "more than one shaping": an
   *  axis PRESET re-shapes the run without a stagger (`shapings` says so). */
  staggered: boolean
  /** How many distinct `textOutlines` shapings this frame cost. 1 when every
   *  glyph shares one axis position; up to `glyphs.length + 1` when a wave is
   *  travelling or an axis preset has moved the run off its resting position. */
  shapings: number
  /**
   * What SMART STRETCH actually applied — not what the user typed.
   *
   * The two are different on purpose and in three ways, all of which happen
   * inside this function: `fit` overrules the width dial when the caller owns a
   * box, the `wdth` cascade spends part of the move on the font's real axis
   * (leaving a smaller residual for the remap), and a diagonal move is damped so
   * the two dials together cannot take a letterform somewhere neither would
   * alone. Reported for the same reason `staggered` and `shapings` are: a test —
   * and the surface's read-only dial — must be able to ASSERT which path ran
   * rather than infer it from a picture that always looks plausible.
   *
   * `S`/`SY` are the run-level values handed to the engine; `fitted` is the
   * width dial fit solved (null when fit was off or inert); `perGlyph` says at
   * least one glyph took its own pair, which is the travelling-wave path.
   *
   * `S`/`SY` here are always the RUN's values, even on a staggered frame —
   * per-glyph engine values can differ from them (and from each other) once a
   * staggered axis track has moved the cascade, because each glyph spends its
   * own `wdth` before its own remap. `perGlyph` only says whether glyphs took
   * their own DIALS; it is not a promise that `S`/`SY` describe every glyph.
   */
  stretch: { S: number; SY: number; damped: boolean; fitted: number | null; perGlyph: boolean }
  /**
   * How many of this frame's shader fields `withFieldFrame` had to FREEZE at
   * `t = 0` because the frame asked for more live fields than
   * `LIVE_FIELD_CEILING` allows.
   *
   * Reported rather than swallowed for the same reason Space Type and Shape
   * Studio report theirs: a silently truncated field reads to a user as "my
   * shader stopped working", and there is nothing in the picture that says
   * otherwise. `drawVectorType` sets this from the span it opens; the pure
   * geometry path (`vectorTypeFrame`) opens no span and always reports 0,
   * because no field decision was made there at all.
   *
   * This was 0 by construction while the studio carried ONE paint. The
   * appearance stack is what makes it reachable: six layers may each carry a
   * live shader fill, and `drawVectorType` asks `vtFieldRequests` once per
   * enabled layer.
   */
  frozenFields: number
  /**
   * How many EXTRUDE COPIES this frame's `VT_EXTRUDE_FRAME_BUDGET` removed.
   *
   * `0` for every frame a user can reach without deliberately stacking six
   * full-depth extrudes over a long line — see `VT_EXTRUDE_FRAME_BUDGET` for the
   * measured numbers. Reported for exactly the reason `frozenFields` is: an
   * extrude that quietly got shallower reads as "the depth slider stopped
   * working", and the picture does not say otherwise. `drawVectorType` also
   * `console.warn`s once per distinct shortfall.
   *
   * The pure geometry path (`vectorTypeFrame`) draws nothing and always reports
   * 0, because no copy was budgeted there at all.
   */
  extrudeDropped: number
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Non-zero, sign-preserving: a scale factor of exactly 0 makes the CTM
 *  singular and Chrome then drops the drawing op entirely. The card-flip presets
 *  drive `scaleX`/`scaleY` to their own 0.001 floor; this is the renderer's own
 *  guard so a future preset (or a track) cannot pass a bare 0 through. */
const nonZero = (v: number): number =>
  !Number.isFinite(v) ? 1 : Math.abs(v) >= 0.001 ? v : v < 0 ? -0.001 : 0.001

/**
 * Clip one glyph's cell box — and do it BEFORE the unit transform.
 *
 * That ordering is the whole trick, lifted from `lib/motion/animatedText.ts`
 * (the Compositor's working per-character reveal). The mask is a FIXED WINDOW
 * the letter slides through: `mask-up` starts the glyph a quarter-em low and
 * lifts it while the window opens, so what the viewer sees is a letter rising
 * out of a stationary edge. Clipping after `ctx.translate` would carry the
 * window along with the letter — every frame still shows a plausibly masked
 * glyph, so a thumbnail cannot tell the two apart, and the reveal is gone.
 *
 * WHERE the window is, is `glyphCellClipRect`'s answer and not this function's:
 * the SVG export needs the identical window for its `<clipPath>`, and a second
 * copy of the cell-box arithmetic is exactly the drift this file exists to
 * prevent. This is only the `ctx` calls that turn that window into a clip.
 *
 * On a CURVE the window is TURNED (see `glyphCellClipRect` for why that is still
 * a fixed window), and the turn is applied to the CONTEXT before the identical
 * rect is taken — the SVG writer turns the identical rect inside its
 * `<clipPath>` instead. The context is then put back with `setTransform` rather
 * than by rotating back: `ctx.clip()` has already baked the region into device
 * space, so restoring the matrix exactly costs nothing and cannot accumulate the
 * float noise a there-and-back rotation would.
 */
function clipGlyphCell(
  ctx: CanvasRenderingContext2D,
  origin: { x: number; y: number; rotate?: number },
  /** The glyph's advance in OUTPUT pixels — the cell's width. */
  advance: number,
  /** The em in OUTPUT pixels — the cell's height. */
  em: number,
  clip: VtGlyphClip,
): void {
  const r = glyphCellClipRect(origin, advance, em, clip)
  const rot = Number.isFinite(r.rotate as number) ? (r.rotate as number) : 0
  const restore = rot === 0 ? null : ctx.getTransform()
  if (restore) {
    const px = Number.isFinite(r.pivotX as number) ? (r.pivotX as number) : r.x + r.width / 2
    const py = Number.isFinite(r.pivotY as number) ? (r.pivotY as number) : r.y + r.height / 2
    ctx.translate(px, py)
    ctx.rotate((rot * Math.PI) / 180)
    ctx.translate(-px, -py)
  }
  // `beginPath` is safe here: this renderer draws `Path2D` objects and never
  // uses the context's own current path.
  ctx.beginPath()
  ctx.rect(r.x, r.y, r.width, r.height)
  ctx.clip()
  if (restore) ctx.setTransform(restore)
}

/** A stable key for a coords record, so two glyphs that land on the same axis
 *  position share one `getVariation` instance instead of paying for it twice. */
// Tolerates a MISSING record, because the configs that reach here are not all
// `mergeConfig` output: a legacy blob (and anything `applyMotion` cloned from
// one) can carry no `axes` at all, and the engine below already treats that as
// "no axis position" rather than an error. Keying it as the empty set is the
// same answer, one step earlier.
function coordsKey(coords: Record<string, number> | null | undefined): string {
  const c = coords ?? {}
  const tags = Object.keys(c).sort()
  let out = ''
  for (const tag of tags) out += `${tag}:${c[tag]};`
  return out
}

/**
 * The range policy, enforced where it can actually bite.
 *
 * `mergeConfig` clamps the stored dials, but MOTION runs after it: `applyMotion`
 * writes a track's raw value straight onto the config, so a `stretch` track from
 * 0 to 4 hands this file numbers Phase A never proved and the remap has no
 * meaning for (a dial of 0 is a run of zero width). The frame is the last
 * boundary before the engine, so the clamp lives here — on the run's dials and
 * on every staggered glyph's alike. A non-finite dial is not clamped but
 * REPLACED: NaN has no nearest legal value, and 1 is the one answer that draws
 * the font as drawn.
 */
function clampDial(v: number): number {
  if (!Number.isFinite(v)) return 1
  return v < VT_STRETCH_MIN ? VT_STRETCH_MIN : v > VT_STRETCH_MAX ? VT_STRETCH_MAX : v
}

/**
 * The fit solve, remembered.
 *
 * `fitStretch` binary-searches 24 candidates, and every candidate is a full
 * shape-and-remap of the whole run — ~295 ms on a six-glyph word here, against
 * a frame budget of 16.
 *
 * What it is asked is the RESTING composition: the font, the text, the axes and
 * the dials as the user set them, before any track claims one. That is not a
 * memo trick, it is what fit MEANS — "this word fills this box" is a decision
 * taken while the thing is standing still, and a run whose fit was re-solved on
 * the animated config would answer a different question sixty times a second
 * (the shipped Spring Up preset moves `stretchY`, so it did exactly that: a
 * ~300 ms solve per frame and a `fitted` readout that shivered). Solved at
 * rest, the answer is a constant for the whole animation and the memo is simply
 * where that constant lives.
 *
 * Bounded, because a long editing session types a lot of words: 64 entries,
 * oldest INSERTION evicted (a Map iterates in insertion order). Not an LRU —
 * the working set of a studio session is one config, and a bigger cache would
 * buy nothing an eviction rule could not.
 */
const FIT_MEMO_MAX = 64
const fitMemo = new Map<string, number>()

function memoisedFit(
  font: VtFont, text: string, axes: Record<string, number>, targetUnits: number, SY: number,
): number {
  // The target is rounded to 1/100 of a font unit: a box edge dragged by a
  // sub-hundredth of a unit cannot move the solve, but it would miss the key.
  // `SY` is part of the key because it is part of the QUESTION — the solve
  // measures through the damping, so the same box asked with a different height
  // dial has a different answer. It is the RESTING height dial (see above), so
  // an animated one cannot move this key.
  const key = `${font.id}|${text}|${coordsKey(axes)}|${targetUnits.toFixed(2)}|${SY.toFixed(4)}`
  const hit = fitMemo.get(key)
  if (hit !== undefined) return hit
  const solved = fitStretch(font, text, axes, targetUnits, VT_STRETCH_MIN, VT_STRETCH_MAX, SY)
  fitMemo.set(key, solved)
  if (fitMemo.size > FIT_MEMO_MAX) {
    const oldest = fitMemo.keys().next().value
    if (oldest !== undefined) fitMemo.delete(oldest)
  }
  return solved
}

/**
 * The `wdth` cascade, remembered — for the same reason and at the same price.
 *
 * `planStretch` calibrates by MEASURING: 24 candidate axis positions, each a
 * full shape of the run, because axis units are not percent and every family
 * maps them differently. On any font with a `wdth` axis that is the cost of
 * every non-1 stretch, on every frame — and a staggered width wave now asks for
 * one plan PER GLYPH, so the same solve that was once per frame is n times per
 * frame. It answers to (font, text, resting axes, dial), all of which are held
 * still by an animation clock that only moves the dial in small steps.
 *
 * The dial is keyed to four decimals: finer than any control emits and finer
 * than the remap can show, so two frames a hair apart still share an answer.
 * Same bound and same eviction rule as the fit memo above — 64 entries, oldest
 * insertion out — which on a six-glyph wave is about ten frames of history.
 */
const PLAN_MEMO_MAX = 64
const planMemo = new Map<string, StretchPlan>()

function memoPlan(font: VtFont, text: string, axes: Record<string, number>, dial: number): StretchPlan {
  const key = `${font.id}|${text}|${coordsKey(axes)}|${dial.toFixed(4)}`
  const hit = planMemo.get(key)
  if (hit) return hit
  const solved = planStretch(font, text, axes, dial)
  planMemo.set(key, solved)
  if (planMemo.size > PLAN_MEMO_MAX) {
    const oldest = planMemo.keys().next().value
    if (oldest !== undefined) planMemo.delete(oldest)
  }
  return solved
}

/**
 * Shape the run at time `t`, giving each glyph its OWN axis position whenever
 * something has moved it there — a staggered axis TRACK, or an axis PRESET.
 *
 * This is the studio's headline capability, and it is the expensive one: a
 * travelling wave means glyph *i* sits at a different axis position from glyph
 * *i+1*, so fontkit must instance the font once per distinct coordinate set.
 * Two mitigations, both cheap:
 *
 *  - a frame where NO glyph's axes moved collapses to a SINGLE shaping (Task 6
 *    proved the collapse is exact), so the common case pays nothing. Note it is
 *    the axis motion that decides, NOT `delay === 0`: an axis preset moves the
 *    outline with the stagger off, and gating on the delay alone would return
 *    axis numbers that nothing ever shaped.
 *  - identical coordinate sets are memoised within the frame, so a `center` or
 *    `edges` order — where glyphs pair up — costs about half, and a preset with
 *    no stagger costs exactly one extra shaping for the whole run.
 *
 * Advances come from each glyph's own instance, so the word BREATHES as the wave
 * passes. That is the font's real metric at that axis position; freezing the
 * layout at the base weight would make heavy glyphs collide.
 */
export function vectorTypeFrame(
  font: VtFont,
  cfg: VectorTypeConfig,
  t: number,
  frameOpts: VtFrameOptions = {},
): VtFrame {
  const base = applyMotion(cfg, t)
  const upem = font.unitsPerEm || 1000
  // A legacy appearance blob that never went through `mergeConfig` can carry no
  // `axes` at all — `coordsKey` already tolerates that, but `planStretch`
  // throws on a missing record the moment the dial isn't 1. Normalised once,
  // here, so every read below (run and per-glyph alike) sees a real record.
  const runAxes = base.axes ?? {}

  // ── SMART STRETCH: resolve the run-level dials ONCE ────────────────────────
  // Fit solves the width dial against the box the caller owns; a config whose
  // fit is on but whose caller passed no box (thumbnails, solids) falls back
  // to the dial value — inert, never wrong. Empty text is the other inert case:
  // there is no run to fill a box with, and reporting a `fitted` of 1 would put
  // a number on a read-only control that nothing solved.
  const runSY = clampDial(base.stretchY)
  // The height dial AS THE USER SET IT — `cfg`, not `base`, so no track has
  // touched it. Fit answers for this one and the width is damped against it
  // below; `runSY` (the animated one) is what the HEIGHT itself renders at.
  const fitSY = clampDial(cfg.stretchY)
  let dialS = clampDial(base.stretch)
  let fitted: number | null = null
  const fitBox = frameOpts.fitBoxWidth
  if (
    cfg.fit === 'width' && cfg.text
    && typeof fitBox === 'number' && Number.isFinite(fitBox) && fitBox > 0 && cfg.size > 0
  ) {
    // Same px↔unit line `vtPlacement` uses (`config.size / upem`) — read off the
    // RESTING size for the same reason as the dials: fit is the composition at
    // rest. A `size` track therefore keeps the fitted dial and lets the run
    // over- or under-fill the box mid-animation; that is the trade, and it is
    // the right one — the alternative is a word that refuses to grow.
    const targetUnits = (fitBox * (1 - 2 * VT_FIT_INSET)) / (cfg.size / upem)
    // The height dial goes INTO the solve, because the frame damps the answer
    // on the way out: solved against an undamped pipeline, `fit: 'width'` with
    // `stretchY: 2` lands a tenth of the box short and `fitted` reports a value
    // nothing ever applied. `fitted` is still the DIAL — what the read-only
    // control shows — and the damped version of it is what the engine gets.
    fitted = memoisedFit(font, cfg.text, cfg.axes ?? {}, targetUnits, fitSY)
    dialS = fitted
  }
  // The wdth cascade spends the real axis before geometry and before damping:
  // a designer-drawn width is never damped.
  const plan = memoPlan(font, base.text, runAxes, dialS)
  // Two damping questions, one plan. HEIGHT is damped against the width the
  // frame is actually drawing; WIDTH under fit is damped against the RESTING
  // height the solve answered for — damp it against a travelling `stretchY`
  // and the run reopens exactly the width the solve closed, drifting out of
  // the box on every frame of a Spring Up while still reporting `fitted`.
  const heightDamped = dampedStretch(plan.residual, runSY)
  const widthDamped = fitted !== null && fitSY !== runSY
    ? dampedStretch(plan.residual, fitSY)
    : heightDamped
  const runDamped = {
    S: widthDamped.S,
    SY: heightDamped.SY,
    damped: heightDamped.damped || widthDamped.damped,
  }

  const shaped = textOutlines(font, base.text, plan.coords)
  const n = shaped.glyphs.length

  const stagger = resolveStagger(cfg)
  const staggered = stagger.delay > 0 && n > 1

  // MOTION FIRST, then geometry. An axis PRESET (`./axisPresets.ts`) puts each
  // glyph at its own axis position through `transforms[i].axes`, exactly as a
  // staggered axis track does through `glyphConfig` — so the shaping below has
  // to know both before it can decide how many shapings this frame needs.
  //
  // One em for the whole run, resolved once: `vtPlacement` scales every glyph by
  // the SAME `size`, so a per-glyph em would move the letters in units the
  // geometry does not share.
  const em = vtEmSize(cfg, t)
  // WHICH WORD each glyph belongs to, computed ONCE per frame from the shaped
  // run — the only place in the product that has both the glyph indices the
  // transforms are keyed on and the code points a word boundary is defined over.
  // `unit: 'word'` blink is inert without it (see `vtBlinkUnitIndex`), so this
  // is not an optimisation: it is what makes the setting work at all. Passed for
  // every frame rather than gated on the blink being on, because the cost is one
  // pass over an array a `Path2D` rebuild dwarfs.
  const wordOf = wordIndexOfGlyph(shaped.glyphs)
  // ── SMART STRETCH: a staggered run is planned PER GLYPH ────────────────────
  // The cascade is not a run-level discount that can be shared out afterwards.
  // Every glyph asks for its own dial, and the pipeline that answers a dial —
  // spend the real `wdth`, hand the remainder to the remap, damp it against the
  // height dial — has to run for THAT dial, from the resting position, or the
  // glyph is charged for an axis move it never got. (Scaling each glyph's dial
  // by the run's `residual/dial` was a line through the origin; the real
  // relationship passes through (1, 1), so a trough glyph asking for exactly 1
  // came out visibly condensed.)
  //
  // The plan's coords become the glyph's RESTING axes, which is what makes this
  // whole; the spent `wdth` is then the position the shaping cache keys on and
  // the position a `wdth` PRESET composes on top of through `vtAxisCoords`,
  // exactly as for the un-staggered run.
  //
  // Under fit the dial is the run's solved one for every glyph — see the fit
  // note in the per-glyph values below.
  const resting: Record<string, number>[] = []
  const transforms: VtGlyphMotion[] = []
  const glyphDials: { S: number; SY: number }[] = []
  let perGlyphStretch = false
  for (let i = 0; i < n; i++) {
    let rest = plan.coords
    let S = runDamped.S, SY = runDamped.SY
    if (staggered) {
      // ONE `glyphConfig` for this glyph. It replays every track on the glyph's
      // own clock and clones the config to do it, so the axes and the dials are
      // read off the SAME evaluation rather than paying for two.
      const gc = glyphConfig(cfg, t, i, n)
      const gcAxes = gc.axes ?? {}
      // FIT WINS over a per-glyph width wave. When the run was fitted, the
      // solve's whole promise is that the run fills the box; letting a
      // staggered `stretch` track re-widen each glyph would break that promise
      // letter by letter for a wave nobody can read against the box edge it is
      // fighting. So under fit every glyph takes the run's width dial and only
      // the HEIGHT keeps its own clock — height was never part of the promise.
      const ownS = fitted ?? clampDial(gc.stretch)
      const ownSY = clampDial(gc.stretchY)
      // Read off the DIALS, not the resulting geometry: two dials a float
      // apart mean the wave is on, and comparing the engine's outputs made the
      // answer depend on how much of the move the cascade happened to absorb.
      if (ownS !== dialS || ownSY !== runSY) perGlyphStretch = true
      const own = memoPlan(font, base.text, gcAxes, ownS)
      // Damp the WIDTH against the RESTING height dial under fit, not the
      // glyph's own: the fit solve answered for `fitSY`, and damping is a
      // function of BOTH dials together, so re-damping against a travelling
      // `ownSY` reopens exactly the width the solve closed — the run under-
      // fills the box one glyph at a time even though every glyph reports the
      // fitted width. The solve's whole promise is that the run fills the box,
      // and that promise is measured at `fitSY`, so the width has to be too.
      // The height keeps its own clock either way — it was never part of the
      // promise fit makes, which is why ONE damping call serves both and only
      // the fitted width needs a second.
      const ownDamped = dampedStretch(own.residual, ownSY)
      S = fitted !== null ? dampedStretch(own.residual, fitSY).S : ownDamped.S
      SY = ownDamped.SY
      rest = own.coords
    }
    resting.push(rest)
    transforms.push(vtGlyphMotion(cfg, t, i, n, em, { axes: font.axes, resting: rest, wordOf }))
    glyphDials.push({ S, SY })
  }

  // THE FAST PATH, widened (Task 4's hand-off). `delay === 0` is the DEFAULT, and
  // it used to collapse to a single shaping unconditionally — which was right
  // while only tracks could move an axis, and silently wrong the moment a preset
  // could: every axis preset would have returned numbers that nothing shaped.
  // A zero delta is never emitted, so a frame with no axis motion still takes
  // the one-shaping path and pays nothing.
  const axisMotion = transforms.some(tr => Object.keys(tr.axes).length > 0)
  const perGlyph = staggered || axisMotion
  const cache = new Map<string, TextOutlines>()
  cache.set(coordsKey(shaped.coords), shaped)

  const source: GlyphOutline[] = []
  // The coords every glyph shared, when they did share one set — so
  // `outlines.coords` reports what was actually shaped rather than the resting
  // position the presets moved off. Null once two glyphs disagree: a travelling
  // wave has no single answer, and `staggered`/`shapings` are what describe it.
  let uniform: Record<string, number> | null = shaped.coords
  if (perGlyph) {
    let firstKey: string | null = null
    uniform = null
    for (let i = 0; i < n; i++) {
      // Fully resolved absolute coords — resting position plus the preset's
      // delta, clamped to each axis's own range. Equal to what `textOutlines`
      // resolves internally, so the cache key describes the real shaping.
      const coords = vtAxisCoords(font.axes, resting[i], transforms[i]?.axes)
      const key = coordsKey(coords)
      if (i === 0) { firstKey = key; uniform = coords }
      else if (key !== firstKey) uniform = null
      let run = cache.get(key)
      if (!run) {
        run = textOutlines(font, base.text, coords)
        cache.set(key, run)
      }
      source.push((run.glyphs[i] ?? shaped.glyphs[i]) as GlyphOutline)
    }
  } else {
    source.push(...shaped.glyphs)
  }

  // ── SMART STRETCH: the remap, on the font's shared zones ───────────────────
  // Each glyph's numbers were resolved with its resting axes above; this is
  // only where they are spent. What matters here is the CONTEXT: the zones come
  // from the RUN's shaping (`shaped.metrics`), never from the glyph's own bbox,
  // so an `i` and an `l` at different stretch values still put the baseline,
  // x-height and cap-height in the same place — that shared solve is the whole
  // reason `stretchGlyph` takes a context at all.
  const stretchCtx = { metrics: shaped.metrics, unitsPerEm: upem }
  const stretched: GlyphOutline[] = source.map((g, i) => {
    const { S, SY } = glyphDials[i] ?? runDamped
    // The identity is returned UNTOUCHED rather than round-tripped through the
    // engine: this is the default frame, and "stretch = 1 changes nothing" has
    // to be an equality, not an approximation, or every existing golden moves.
    if (S === 1 && SY === 1) return g
    const sg = stretchGlyph(g, S, SY, stretchCtx)
    return { ...g, commands: sg.commands, bbox: sg.bbox, advance: sg.advance }
  })

  // Re-accumulate the pen with tracking. Not added after the LAST glyph: CSS
  // letter-spacing does add it there, and the result is a run whose ink is
  // half a space off-centre at every non-zero tracking.
  const extra = (base.tracking / 1000) * upem
  const glyphs: GlyphOutline[] = []
  let penX = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < stretched.length; i++) {
    const g = stretched[i] as GlyphOutline
    const placed: GlyphOutline = { ...g, x: penX, y: g.y }
    glyphs.push(placed)
    if (g.commands.length) {
      minX = Math.min(minX, placed.x + g.bbox.minX)
      minY = Math.min(minY, placed.y + g.bbox.minY)
      maxX = Math.max(maxX, placed.x + g.bbox.maxX)
      maxY = Math.max(maxY, placed.y + g.bbox.maxY)
    }
    penX += g.advance + (i < stretched.length - 1 ? extra : 0)
  }

  const bbox = Number.isFinite(minX)
    ? { minX, minY, maxX, maxY }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0 }

  return {
    // `metrics` rides along from the run's shaping: it is the font's shared
    // alignment lines, so every consumer downstream (the SVG writer, the extrude
    // solid, a second stretch pass) measures against the SAME zones this frame
    // stretched against instead of re-deriving them from the placed bboxes.
    outlines: { glyphs, width: penX, unitsPerEm: upem, coords: uniform ?? shaped.coords, bbox, metrics: shaped.metrics },
    config: base,
    transforms,
    // What smart stretch actually applied — see `VtFrame.stretch`. The dial the
    // user typed is untouched in `config`: this function is pure, and a fitted
    // run reports its solved value here rather than writing it back.
    stretch: { S: runDamped.S, SY: runDamped.SY, damped: runDamped.damped, fitted, perGlyph: perGlyphStretch },
    // Unchanged meaning: a TRAVELLING wave, i.e. glyphs on their own clocks. An
    // axis preset at delay 0 shapes off the resting position but every glyph
    // shares it, so it is not a wave and must not claim to be one — `shapings`
    // is what says how many distinct positions were paid for.
    staggered,
    shapings: cache.size,
    // No `withFieldFrame` span is opened here — this function resolves GEOMETRY,
    // not paint. `drawVectorType` overwrites this with its span's real count.
    frozenFields: 0,
    // Likewise: no copy was drawn here, so none was budgeted away.
    extrudeDropped: 0,
  }
}

export interface VtBoxOptions {
  /** Logical output width in pixels. */
  width: number
  /** Logical output height in pixels. */
  height: number
  /** Output-unit margin kept clear on every side. Default 0. */
  padding?: number
}

// ── The run's curve ─────────────────────────────────────────────────────────

/** Into `VT_ARC_MAX`, with a non-finite value landing on 0 — the same guard, for
 *  the same reason, as `clampSkew`: a track can drive this past the slider's own
 *  ends, and a `NaN` reaching a placement puts every glyph at `NaN` with nothing
 *  in the console. */
export function vtArcSweep(cfg: VectorTypeConfig | null | undefined): number {
  const v = cfg?.arc as number
  if (!Number.isFinite(v)) return 0
  return v < -VT_ARC_MAX ? -VT_ARC_MAX : v > VT_ARC_MAX ? VT_ARC_MAX : v
}

/**
 * Is this run bent at all?
 *
 * The same question `vtRunCurve` answers with `null`, asked WITHOUT the outlines
 * and the scale — because `vtPaintLayers` needs it (a curved run overspills its
 * axis-aligned paint box, exactly as a sheared one does) and runs before either
 * exists. `vtIsSheared` exists for the identical reason; two readings of "is
 * there a bend" would be one too many.
 */
export function vtIsCurved(cfg: VectorTypeConfig | null | undefined): boolean {
  return vtArcSweep(cfg) !== 0
}

/**
 * The run's CURVE in output units — the ONE definition of it, `null` when the
 * run is straight.
 *
 * `length` is the run's own advance width in output pixels, so the curve is
 * exactly as long as the text and every glyph lands at the arc length its shaped
 * advance puts it at. `./curve.ts`'s `line` keeps its arc length constant as it
 * bends (its radius is `length / sweep`), which is why bending does not stretch
 * the letter spacing and why `arc: 0` is byte-identical to the flat run.
 *
 * `curvature = ±1` is a full turn in that module's vocabulary, hence `/ 360`.
 *
 * The TABLE is built once here, per run per frame, and handed to every glyph —
 * `pointAtLength` would otherwise rebuild it per letter.
 */
export function vtRunCurve(
  cfg: VectorTypeConfig | null | undefined,
  outlines: TextOutlines,
  scale: number,
): RunCurve | null {
  const sweep = vtArcSweep(cfg)
  if (sweep === 0) return null
  const length = (Number.isFinite(outlines.width) ? outlines.width : 0) * (Number.isFinite(scale) ? scale : 0)
  // A zero-width run has no curve to be placed on and would give the table a
  // zero length, which `pointAtLength` answers with one point for every glyph.
  if (!(length > 0)) return null
  return { table: buildCurveTable({ type: 'line', length, curvature: sweep / 360 }) }
}

/**
 * Where the run lands in the output box: `size` decides the scale (this is NOT a
 * fit-to-box — the type is the size the user asked for, and overflowing is a
 * legitimate composition), `align` decides the horizontal anchor, and the ink is
 * always vertically centred.
 *
 * The anchoring is measured against the run's PLACED ink (`placedInkBounds`)
 * rather than against `outlines.bbox` scaled. For a flat run the two are the
 * same arithmetic and a test asserts the identity term by term; for a CURVED one
 * only the first is true, because a rotated glyph's axis-aligned box is not its
 * unrotated box scaled. So an arc'd run stays centred in the box as it bends,
 * instead of drifting out of frame — one promise, honoured on both.
 */
export function vtPlacement(frame: VtFrame, opts: VtBoxOptions): ResolvedPlacement {
  const { outlines, config } = frame
  const upem = outlines.unitsPerEm || 1000
  const scale = (Number.isFinite(config.size) ? config.size : 0) / upem
  const pad = opts.padding ?? 0
  const availW = Math.max(0, opts.width - pad * 2)
  const availH = Math.max(0, opts.height - pad * 2)
  const curve = vtRunCurve(config, outlines, scale)
  // The placed ink at the ORIGIN, so what comes back is the offset to correct.
  const b = placedInkBounds(outlines, { scale, rotate: 0, x: 0, y: 0, flipY: true, curve })
  const inkW = b.maxX - b.minX
  const inkH = b.maxY - b.minY

  let x: number
  if (config.align === 'left') x = pad
  else if (config.align === 'right') x = pad + (availW - inkW)
  else x = pad + (availW - inkW) / 2

  return {
    scale,
    rotate: 0,
    x: x - b.minX,
    y: pad + (availH - inkH) / 2 - b.minY,
    flipY: true,
    curve,
  }
}

// ── Where a fill is sampled: the three anchors ──────────────────────────────
//
// Space Type has two anchors (`object | frame`) and type needs a middle term. A
// gradient across a WORD and a gradient across each LETTER are completely
// different treatments, and neither existing anchor can say the first one.
//
// All three are expressed as a box in OUTPUT (logical) pixels plus that box's
// CENTRE, because `resolvePaint` builds its gradients and pattern matrices
// CENTRED on the origin (`lib/paint/resolve.ts`'s header; the other convention
// in this codebase — `paintTileBox`'s corner origin — is documented at
// `lib/compositor/paint.ts:44-48`, and the two are deliberately NOT harmonised).
// So `w`/`h` are what the resolver is asked for, and `cx`/`cy` are where the
// drawing transform has to be for that centred geometry to land on the right
// pixels.

/** A fill's sampling box in OUTPUT pixels, with the centre the resolver's
 *  centred-origin geometry is built around. */
export interface VtPaintBox { cx: number; cy: number; w: number; h: number }

/** Never-degenerate, order-independent: a box built from two opposite corners in
 *  either order. `1e-3` matches `resolveFill`/`resolveShaderFill`'s own floor, so
 *  a zero-extent box (an empty run, a hairline glyph) cannot make the pattern
 *  matrix singular. */
function paintBoxFrom(ax: number, ay: number, bx: number, by: number): VtPaintBox {
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx)
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by)
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: Math.max(x1 - x0, 1e-3), h: Math.max(y1 - y0, 1e-3) }
}

/** The axis-aligned box of a rect's four corners taken through a placement's own
 *  turn — the shape both paint boxes need once a glyph can be rotated. Kept as
 *  one helper so "the placed box" has one meaning here. */
function turnedBoxFrom(
  origin: { x: number; y: number; rotate: number },
  ax: number, ay: number, bx: number, by: number,
): VtPaintBox {
  const rad = (origin.rotate * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [px, py] of [[ax, ay], [bx, ay], [ax, by], [bx, by]] as const) {
    const x = origin.x + px * cos - py * sin
    const y = origin.y + px * sin + py * cos
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return paintBoxFrom(x0, y0, x1, y1)
}

/**
 * `glyph` — ONE letter's own box, so each letter carries its own copy of the fill.
 *
 * The box is the glyph's INK bounds, not its cell. It is the more useful of the
 * two: an ink box gives every letter the FULL ramp over its own extent, where a
 * cell box would give a vertical gradient the same band on every letter and
 * collapse the visible difference from `word`.
 *
 * ## PLACED ink, which on a curve is not the same box
 *
 * The bounds are taken through the glyph's OWN placement, rotation included —
 * the four corners of its font-space box turned by the tangent and unioned. A
 * turned letter's axis-aligned extent is not its unturned extent, and the old
 * arithmetic (which only translated and scaled) put the box somewhere the letter
 * was not: measured at 76.7 % / 80.8 % of core ink disagreeing with the export
 * at arc 150° / 330°, the only live break of this studio's 0.0000 % guarantee.
 *
 * **And the box stays AXIS-ALIGNED, deliberately.** The alternative — a box
 * glued to the letter's own frame, so the ramp turns with it — was considered
 * and rejected: it fans the ramp direction around the arc, and it disagrees with
 * the extrude on the same run, which fixes ONE absolute light direction whatever
 * angle a letter sits at. One scene, one set of directions.
 *
 * A glyph with no ink (a space) has no bounding box to speak of, so it falls back
 * to its CELL — the same box `glyphCellClipRect` masks against, turned the same
 * way.
 */
export function vtGlyphPaintBox(
  glyph: GlyphOutline,
  place: ResolvedPlacement,
  /** The em in OUTPUT pixels — only used for the no-ink fallback. */
  em: number,
): VtPaintBox {
  const origin = glyphPlacement(glyph, place)
  const s = place.scale
  // y is FLIPPED by the placement, so the source's MAX y is the output's TOP.
  const fy = place.flipY ? -s : s
  const b = glyph.bbox
  const inked = glyph.commands.length > 0 && Number.isFinite(b.minX) && Number.isFinite(b.minY)
  // The straight run keeps the original two-corner expression rather than
  // folding `cos 0`/`sin 0` through the general form, so every flat config lands
  // on exactly the doubles it always did.
  if (origin.rotate === 0) {
    if (!inked) {
      const y1 = origin.y + em * CELL_DESCENT
      return paintBoxFrom(origin.x, y1 - em, origin.x + glyph.advance * s, y1)
    }
    return paintBoxFrom(origin.x + b.minX * s, origin.y + b.minY * fy, origin.x + b.maxX * s, origin.y + b.maxY * fy)
  }
  if (!inked) {
    // The cell, in the glyph's own frame: the baseline runs along its x, so the
    // descent hangs below it on the local y.
    return turnedBoxFrom(origin, 0, em * CELL_DESCENT - em, glyph.advance * s, em * CELL_DESCENT)
  }
  return turnedBoxFrom(origin, b.minX * s, b.minY * fy, b.maxX * s, b.maxY * fy)
}

/**
 * `word` — the RUN's ink box, so one fill spans the whole word and the letters
 * are windows onto it. Exactly the glyph box one level up: the same ink-bounds
 * rule applied to the whole run.
 *
 * ## On a curve it is the PLACED ink, not the straight run's box
 *
 * `outlines.bbox` is the run's bounds in FONT units on a straight baseline, so
 * scaling and translating it answers a question about a run that is not the one
 * being drawn: measured at arc 150°–330° it kept the straight run's size
 * (284.3 × 84.1 px at every sweep, against a true placed ink of 239.1 × 233.5)
 * and its centre drifted 47 px — a third of the run's own height — off the ink
 * it is supposed to span. `placedInkBounds` is that same union taken through
 * each glyph's own placement, which is the box the ink actually occupies.
 *
 * **It spans the arc's bounding box, not the arc**, and that is the decision
 * rather than a leftover. `word` means "one fill, and the letters are windows
 * onto it" — a single ramp across a rectangle, which is what a linear gradient
 * IS. A ramp that followed the curve would be a different feature (a gradient
 * ALONG a path, parameterised by arc length, needing a paint server per glyph on
 * both surfaces); it is not what this anchor promises and it is not what a user
 * dragging an `angle` slider is asking for.
 *
 * A straight run takes the original expression, so it is byte-identical: the
 * placed union and the scaled `outlines.bbox` are the same box, but they are not
 * the same FLOATING-POINT arithmetic (`(gx + bx)·s` against `gx·s + bx·s`), and
 * this box is also `vtRunShear`'s pivot.
 *
 * An empty run (no text, or nothing but spaces) has no ink, so it falls back to
 * the frame box rather than to a sliver at the origin.
 */
export function vtRunPaintBox(
  outlines: TextOutlines,
  place: ResolvedPlacement,
  opts: VtBoxOptions,
): VtPaintBox {
  const b = outlines.bbox
  const s = place.scale
  const fy = place.flipY ? -s : s
  if (!Number.isFinite(b.minX) || (b.maxX === b.minX && b.maxY === b.minY)) return vtFramePaintBox(opts)
  if (!place.curve && !place.rotate) {
    return paintBoxFrom(place.x + b.minX * s, place.y + b.minY * fy, place.x + b.maxX * s, place.y + b.maxY * fy)
  }
  const p = placedInkBounds(outlines, place)
  return paintBoxFrom(p.minX, p.minY, p.maxX, p.maxY)
}

// ── The whole-run shear ─────────────────────────────────────────────────────

/** Into `VT_SKEW_MAX`, with a non-finite value landing on 0 rather than on
 *  `NaN` — a track can drive this past the slider's own ends, and a `NaN` in the
 *  CTM makes Chrome drop the drawing op with nothing in the console. */
const clampSkew = (v: number): number =>
  !Number.isFinite(v) ? 0 : v < -VT_SKEW_MAX ? -VT_SKEW_MAX : v > VT_SKEW_MAX ? VT_SKEW_MAX : v

/**
 * Does this config lean at all?
 *
 * The same question `vtRunShear` answers with `null`, asked WITHOUT the outlines
 * and the placement — because `vtPaintLayers` needs it (a sheared run overspills
 * its paint box) and runs before either exists. Two readings of "is there a
 * shear" would be one reading too many.
 */
export function vtIsSheared(cfg: VectorTypeConfig | null | undefined): boolean {
  return clampSkew(cfg?.skewX as number) !== 0 || clampSkew(cfg?.skewY as number) !== 0
}

/**
 * The run's SHEAR as an affine in OUTPUT space — the ONE definition of it, and
 * `null` when there is none.
 *
 * Both renderers call this. The canvas hands it to a single `ctx.transform(…)`;
 * the SVG writer emits it as the leading `matrix(…)` of each glyph's `transform`
 * list. A second derivation would drift, and the drift would be invisible — both
 * surfaces would still show a leaning word.
 *
 * ## WHOLE-RUN, about the run's ink centre
 *
 * A shear about each glyph's own origin leans every LETTER while the word stays
 * put. This is composed once for the run and every glyph rides the same matrix,
 * so the word leans as one piece.
 *
 * The pivot is `vtRunPaintBox`'s centre — the run's own ink box, already
 * computed by both renderers for the `word` fill anchor, so there is no second
 * idea of where the run is. Centre rather than baseline for two reasons: the run
 * stays where the user put it as the slider moves (the same pivot the Compositor
 * shears a layer about — `useCompositorLayers`' `applyXform`), and `skewY` has
 * no "baseline" to speak of, so a per-axis pivot rule would be two rules.
 *
 * `T(p) · [1, tan(skewY), tan(skewX), 1, 0, 0] · T(−p)`, folded into six numbers:
 * the linear part is the shear and the translation is `p − S·p`.
 *
 * ## Composed OUTSIDE the motion, and outside the mask window
 *
 * The full element transform is `shear · motion`, i.e. the artwork is placed and
 * animated first and the whole thing is then leaned — which is what "skew the
 * composition" means, and what makes `skewX` read the same whether a glyph is
 * spinning or still. The cell CLIP is taken before either (canvas) and rides an
 * untransformed wrapper `<g>` (SVG), so `glyphCellClipRect`'s stated invariant
 * survives untouched: the window is FIXED in output space and the letter slides
 * through it. A sheared letter slides through an upright window; that is the
 * reveal the mask presets are drawn against, not a bug.
 */
export function vtRunShear(
  cfg: VectorTypeConfig,
  outlines: TextOutlines,
  place: ResolvedPlacement,
  opts: VtBoxOptions,
): Affine | null {
  if (!vtIsSheared(cfg)) return null
  const kx = clampSkew(cfg?.skewX as number)
  const ky = clampSkew(cfg?.skewY as number)
  const c = Math.tan((kx * Math.PI) / 180)
  const b = Math.tan((ky * Math.PI) / 180)
  const { cx, cy } = vtRunPaintBox(outlines, place, opts)
  return [1, b, c, 1, -c * cy, -b * cx]
}

/** `frame` — the whole output box, so the type moves over a fill pinned to the
 *  canvas. Logical units, not device: the drawing transform already carries
 *  `pixelRatio`, so a 220px card and a 1024px bake sample the same composition. */
export function vtFramePaintBox(opts: VtBoxOptions): VtPaintBox {
  return {
    cx: opts.width / 2,
    cy: opts.height / 2,
    w: Math.max(opts.width, 1e-3),
    h: Math.max(opts.height, 1e-3),
  }
}

/**
 * One layer's anchor, with "anything unrecognised means `glyph`" — a layer can
 * reach here from a raw blob that never went through `mergeAppearance`, because
 * `applyMotion` clones whatever it is handed (see `cloneConfig`'s doc), so an
 * absent or bogus value must land on the pre-anchor behaviour rather than
 * defaulting into one of the two run-level sampling spaces.
 *
 * `vtFillAnchor` — the BASE-layer accessor that answered this question for a
 * renderer that could only draw one fill — is GONE, as its own banner said Task 6
 * would delete it. Both renderers now ask every layer for its own anchor: that is
 * the point of the stack, and a word-anchored gradient fill under a
 * glyph-anchored stroke is two paint spaces the collapsed accessor could not name.
 */
function vtLayerAnchor(layer: VtAppearanceLayer): VtFillAnchor {
  const a = layer.anchor
  return a === 'word' || a === 'frame' ? a : 'glyph'
}

/**
 * The appearance stack this config PAINTS, back to front.
 *
 * ═══ THIS REPLACES `vtBaseAppearance` ON THE CANVAS PATH ═══
 *
 * Task 2 shipped a bridge that collapsed the stack to the bottom-most enabled
 * fill plus the bottom-most enabled stroke, because the renderer only knew how to
 * draw one of each. It is gone from here: `drawVectorType` now walks the array.
 *
 * It keeps the ONE thing the bridge was load-bearing for — plan trap 4. A config
 * reaching the renderer has NOT necessarily been through `mergeConfig`:
 * `applyMotion`/`cloneConfig` clone whatever blob they are handed, and the node
 * card, the bake and the frame source can each read stored JSON directly. So a
 * config with no `appearance` ARRAY is a pre-stack blob and is migrated on the
 * spot, through `config.ts`'s own `migrateLegacyAppearance` rather than a second
 * copy of the lift. A saved legacy node therefore paints its fill AND its stroke,
 * not a white default.
 *
 * `appearance: []` is the opposite case and is honoured: the array is present, so
 * the user really did remove every layer, and an empty stack paints nothing.
 */
export function vtDrawLayers(cfg: VectorTypeConfig | null | undefined): VtAppearanceLayer[] {
  const stack = cfg?.appearance
  return Array.isArray(stack) ? stack : migrateLegacyAppearance((cfg ?? {}) as VtLegacyPaint)
}

/**
 * A layer's blend as a canvas composite op.
 *
 * `Record<BlendKind, …>` on purpose: a blend kind added to `lib/studio/blend.ts`
 * without an op here stops COMPILING, rather than silently falling back to
 * `source-over` and reading as "the blend control does nothing". The Compositor
 * and the playback engine each keep their own wider map (they carry
 * `soft_light`/`hard_light`/`difference`, which `BlendKind` does not); this one is
 * exactly the seven the studios share.
 */
const VT_BLEND_OP: Record<BlendKind, GlobalCompositeOperation> = {
  normal: 'source-over',
  lighten: 'lighten',
  screen: 'screen',
  // Canvas spells additive blending `lighter`, not `add`.
  add: 'lighter',
  multiply: 'multiply',
  darken: 'darken',
  overlay: 'overlay',
}

/**
 * The SAME seven blends, in CSS's spelling — what the SVG export writes as
 * `mix-blend-mode` on a layer's paths.
 *
 * `Record<BlendKind, …>` for the identical reason `VT_BLEND_OP` is: a blend kind
 * added to `lib/studio/blend.ts` with no entry here stops COMPILING rather than
 * exporting silently as `normal`, which is a wrong picture in a file nobody can
 * re-render.
 *
 * Canvas spells additive blending `lighter`; CSS spells it `plus-lighter`. They
 * are the same operation. (`plus-lighter` is the one entry with imperfect
 * renderer support — Chrome and Safari have it, and a renderer that does not
 * falls back to `normal`, i.e. to the pre-stack export rather than to something
 * wrong.)
 */
const VT_BLEND_CSS: Record<BlendKind, string> = {
  normal: 'normal',
  lighten: 'lighten',
  screen: 'screen',
  add: 'plus-lighter',
  multiply: 'multiply',
  darken: 'darken',
  overlay: 'overlay',
}

/** A paint that resolves to a plain CSS colour needs none of the anchoring
 *  machinery — no box, no paint-space matrix, no per-glyph `Path2D`. This is the
 *  DEFAULT config (`solid`) and every legacy string fill, so it is the path
 *  almost every frame in the product takes. */
function flatPaint(paint: Paint): string | null {
  if (typeof paint === 'string') return paint
  if (isFill(paint) && paint.type === 'solid') return paint.a
  return null
}

/**
 * The shader field this config's fill needs, sized EXACTLY the way
 * `resolveShaderFill` sizes it at paint time — frame-anchored fields at the
 * frame's own size, object-anchored ones at the fixed `OBJECT_SHADER_FIELD_PX`.
 * The two must agree or `beginFieldFrame` budgets a key the resolver never asks
 * for and the fill silently freezes at t=0; see `OBJECT_SHADER_FIELD_PX`'s doc
 * for the version of that bug that already shipped once.
 *
 * ONE paint in, so 0 or 1 requests out — the caller asks once PER APPEARANCE
 * LAYER and concatenates, which is how a six-layer stack can now genuinely
 * overflow `LIVE_FIELD_CEILING` (it could not while there was one paint). The
 * host still has to open its own `withFieldFrame` span, because the span is what
 * makes a field LIVE at all. Without one every field renders frozen at t=0.
 */
function vtFieldRequests(
  paint: Paint,
  /** DEVICE pixels — the frame `field.base` is captured in. */
  W: number,
  H: number,
  t: number,
  fps: number,
  bake: boolean,
): FieldRequest[] {
  if (!isFill(paint) || !fillIsShader(paint)) return []
  const frameAnchored = paint.shader.anchor === 'frame'
  return [{
    spec: paint.shader,
    w: frameAnchored ? Math.max(1, Math.round(W)) : OBJECT_SHADER_FIELD_PX,
    h: frameAnchored ? Math.max(1, Math.round(H)) : OBJECT_SHADER_FIELD_PX,
    t,
    fps,
    bake,
  }]
}

/**
 * One appearance layer, resolved down to what the draw loop needs — computed
 * ONCE for the whole run, never per glyph.
 *
 * `runPm`/`runStyle` are the reason this is a struct rather than a tuple: they
 * used to be two hoisted locals, which was correct while there was one paint and
 * silently wrong with a stack (a word-anchored gradient on layer 0 and another on
 * layer 2 do not share a paint space, and one pair of locals would have given the
 * second one the first one's ramp). They are per LAYER, filled in once at the top
 * of `drawGlyphRun`, so a run-anchored gradient or shader field is still built
 * once for the run rather than once per letter.
 */
interface VtPaintLayer {
  /** The layer's STABLE id — how a precomputed solid body is addressed
   *  (`vtSolidKey`). Never its position in the stack: a map keyed by index would
   *  hand a reordered layer somebody else's body, and the picture would still be
   *  a solid extrude (trap 2). */
  id: string
  kind: 'fill' | 'stroke' | 'extrude'
  paint: Paint
  /** The plain CSS colour this paint resolves to, or `null` when it needs the
   *  anchoring machinery. The fast path, and the common one. */
  flat: string | null
  anchor: VtFillAnchor
  /** OUTPUT pixels; `0` on a fill layer, and a stroke layer with `0` never gets
   *  here at all. */
  width: number
  /**
   * The SILHOUETTE outline an `extrude` layer draws around its fused body —
   * `null` on every other layer, and on an extrude that has not asked for one.
   *
   * ## It is one contour, or it is nothing
   *
   * A silhouette cannot be derived from N overlapping paths; it requires the
   * union. So this is resolved here — the layer's own `width` and `strokeColor`,
   * both gated on the layer being `solid` — but it is only DRAWN where a body
   * actually exists. No body, no stroke: no error, no blocking, and in particular
   * no fallback to stroking the copies individually, which would draw an outline
   * around each and put internal seam lines straight through the block. That is
   * the failure signature this whole feature is defined against, not a degraded
   * version of it.
   *
   * A FLAT colour, deliberately (not a `Paint`) — see
   * `VtAppearanceLayer.strokeColor`.
   */
  outline: { color: string; width: number } | null
  /** 0..1, MULTIPLIED with the glyph's motion opacity — see `paintLayer`. */
  opacity: number
  /**
   * DRAW-ON: how much of a `stroke` layer's outline is drawn, 0..1.
   *
   * `1` on every other kind and on any layer that has not asked for it, and `1`
   * means **no dash at all** rather than a dash covering everything — that is
   * what keeps every frame and every export written before draw-on existed
   * byte-identical.
   *
   * Resolved here rather than at the two draw sites, so the canvas and the SVG
   * cannot come to two different readings of `layer.draw` (the failure the
   * `blendCss`/`op` pair beside it is also written this way to avoid). The
   * per-glyph DASH is not resolved here, because it depends on the glyph — see
   * `vtDrawOnDash`.
   */
  draw: number
  op: GlobalCompositeOperation
  /** The same blend in CSS's spelling, for the SVG export's `mix-blend-mode`.
   *  Resolved HERE, beside the canvas op, so the two cannot be derived from
   *  different readings of `layer.blend`. */
  blendCss: string
  /**
   * Whether this layer's INK reaches outside its own paint box — see
   * `PaintSpread` in `~/lib/paint/resolve`.
   *
   * A `fill` layer paints the glyph outline it anchored its paint to, so its ink
   * IS the box and `'box'` is exact. Two kinds are not:
   *
   *  - an `extrude` draws the same path again at `depth` OFFSETS, so the block
   *    trails `depth × distance` output pixels away from the letter it was
   *    anchored to (and further still once the copies are fused into one body,
   *    which is bigger than any single copy);
   *  - a `stroke` is a centred pen, so half of `width` lies OUTSIDE the contour
   *    the ink box was measured from.
   *
   * Under `'box'` those pixels came out empty whenever the paint was a `Fill` —
   * 68 % of a glyph-anchored extrude's ink, 47 % of a 20 px stroke's — while the
   * SVG export painted all of it. Solid paints were never affected (a flat colour
   * has no box), which is why this survived to a user report ("the extrude only
   * looks right when the fill is solid").
   *
   * Resolved HERE, off the same `kind`/`copies` this function already decides,
   * rather than at the two `resolvePaint` call sites — which would be two places
   * to keep in step, and the hoisted run-anchored one is far away from the
   * per-glyph one.
   */
  spread: PaintSpread
  runPm: DOMMatrix | null
  runStyle: string | CanvasGradient | CanvasPattern | null
  /**
   * The offset copies an `extrude` layer draws, BACK TO FRONT — `null` on a
   * `fill` or a `stroke`, which draw the glyph path exactly once.
   *
   * Resolved ONCE for the run (the offsets depend only on the layer's four
   * numbers, never on which glyph is being drawn) and then replayed per glyph,
   * so a 24-letter word at depth 8 does one `extrudeOffsets` call, not 24.
   *
   * An extrude with `depth: 0` produces an EMPTY array and the layer is dropped
   * by `vtPaintLayers` before it gets here, so this is never `[]`.
   */
  copies: VtExtrudeCopy[] | null
  /**
   * The user asked for the copies to be FUSED into one body (`solid: true`).
   *
   * A request, not a capability: this flag alone changes nothing. The union is
   * async and lives in `./extrudeSolid.ts`; a frame only draws a body if one has
   * ALREADY been computed — either handed in as `opts.solid` (a bake, an export)
   * or found in the paper-free body cache by a synchronous peek (the live path,
   * once the surface's debounced watcher has united this exact geometry). Until
   * then a `solid: true` extrude draws the un-unioned stack, which is the
   * fallback plan trap 5 exists to protect — the two differ only where
   * translucent copies overlap.
   */
  solid: boolean
}

/**
 * The stack, resolved for drawing: enabled layers with something to paint, in
 * array order — BACK TO FRONT. Array order is paint order, so a `stroke` layer
 * BELOW a `fill` layer draws first and the fill covers its inner half. That
 * ordering was not expressible before this task, because the single stroke was
 * unconditionally drawn after the single fill.
 *
 * Four reasons a layer is dropped here rather than inside the glyph loop, so the
 * cost is paid once and a layer that cannot show up also cannot ask for a shader
 * FIELD (which would count against `LIVE_FIELD_CEILING` and freeze a field that
 * is actually visible):
 *
 *  - `enabled === false`;
 *  - `opacity <= 0` — no ink at any blend mode;
 *  - `hasPaint` says the paint cannot paint — a `none`/`transparent`/empty
 *    string, or a gradient with no stops. A MERGED layer's paint is always a
 *    `Fill`, which always paints, so this guards the raw-blob and hand-written
 *    stacks rather than anything `mergeConfig` produces;
 *  - a `stroke` whose width is not above zero. That is the OLD default, and it is
 *    why users concluded this studio had no stroke; a stroke layer added through
 *    the UI gets `VT_DEFAULT_STROKE_WIDTH`.
 *
 * ── EXTRUDE ─────────────────────────────────────────────────────────────────
 * An `extrude` layer is the same glyph path FILLED `depth` more times, at the
 * offsets `extrudeOffsets` derives (see `./extrude.ts` for the geometry and the
 * angle convention). It is a fill of N copies, never a stroke: `width` is inert
 * on it, exactly as it is on a fill layer.
 *
 * A `depth: 0` extrude is dropped here for the same reason a zero-width stroke
 * is — it paints nothing, so it must not be able to spend a shader FIELD.
 *
 * `solid: true` (fusing the copies into ONE body via paper.js `unite`) is
 * recorded on the resolved layer but NOT acted on here, and that is the whole
 * shape of plan trap 5: the union is far too slow for a draw loop, so this path
 * resolves the un-unioned copies whatever `solid` says. A frame only draws a
 * fused body when a BAKE or an EXPORT awaited `prepareSolidExtrudes`
 * (`./extrudeSolid.ts`) and handed the geometry in as `VtDrawOptions.solid`.
 *
 * @param glyphs How many glyphs the run has — the other half of the
 *   `depth × glyphs` cost, needed to spend `VT_EXTRUDE_FRAME_BUDGET`.
 */
function vtPaintLayers(
  cfg: VectorTypeConfig | null | undefined,
  glyphs: number,
): { layers: VtPaintLayer[]; extrudeDropped: number } {
  const out: VtPaintLayer[] = []
  /**
   * A SHEARED run overspills its own paint box, so every layer needs `'extend'`.
   *
   * `vtRunPaintBox` and `vtGlyphPaintBox` are both AXIS-ALIGNED and both derived
   * from the run's UNSHEARED ink (they have to be — the export anchors its paint
   * servers to exactly those rects). Lean the run and its ink leaves them, which
   * is word for word the condition `PaintSpread` documents: *"the ink reaches
   * OUTSIDE its own paint box, and the paint has to follow it there"*.
   *
   * MEASURED, not reasoned about. Without this, a `word`-anchored gradient at
   * `skewY: 22` painted 7,406 of the run's 10,673 ink pixels on canvas and the
   * SVG painted all of them — 30.6 % of the union missing, and missing in a way
   * that reads as "the top and bottom of the word are cut off" rather than as a
   * colour bug. `'extend'` is 0.0000 %. It changes nothing INSIDE the box, so
   * every unskewed config is byte-identical.
   */
  const sheared = vtIsSheared(cfg)
  /**
   * A CURVED run overspills its paint box for the same reason, harder.
   *
   * `vtRunPaintBox` and `vtGlyphPaintBox` are axis-aligned and derived from the
   * run's STRAIGHT ink (they have to be — the export anchors its paint servers to
   * exactly those rects), so bending the run walks its ink clean out of them: a
   * glyph turned 30° has corners outside its own unrotated box, and the run's box
   * does not even sit where the arc'd run does.
   *
   * MEASURED, not reasoned about, exactly as the shear was — see the task report
   * for the numbers, which are far worse than the shear's 30.6 %. `'extend'`
   * changes nothing INSIDE the box, so every straight config is byte-identical.
   * Where the box SHOULD be on an arc is a separate question and a deliberate
   * one; this only stops the ink outside it coming out empty.
   */
  const curved = vtIsCurved(cfg)
  /** Every extrude layer paired with the config layer it came from, so the
   *  budget's caps can be applied after the whole stack is known — a budget
   *  spent front-to-back has to see every extrude before it can decide which one
   *  gives copies up. */
  const extrudes: Array<{ L: VtPaintLayer; spec: VtExtrudeSpec }> = []
  for (const layer of vtDrawLayers(cfg)) {
    if (!layer || typeof layer !== 'object') continue
    if (layer.enabled === false) continue
    // Anything unrecognised is dropped: drawing a kind this loop does not
    // understand as if it were a fill is a wrong picture, not a partial one.
    if (layer.kind !== 'fill' && layer.kind !== 'stroke' && layer.kind !== 'extrude') continue
    const paint = layer.paint
    if (!hasPaint(paint)) continue
    const opacity = clamp01(Number.isFinite(layer.opacity) ? layer.opacity : 1)
    if (opacity <= 0) continue
    const width = Number.isFinite(layer.width) ? Math.max(0, layer.width) : 0
    if (layer.kind === 'stroke' && width <= 0) continue
    // Cheap pre-check on the raw depth so a `depth: 0` extrude never reaches the
    // budget or the field span. The real offsets are built below, once the
    // budget has had its say.
    if (layer.kind === 'extrude' && !(Number.isFinite(layer.depth) && Math.round(layer.depth) > 0)) continue
    const solid = layer.kind === 'extrude' && layer.solid === true
    // The silhouette. `hasPaint` is the same "does this actually paint" question
    // the layer's own paint answers above, asked of a flat colour: `''`, `'none'`
    // and `'transparent'` are all "no outline", so a hand-written or agent-written
    // config cannot produce a `ctx.stroke` that costs a pass and paints nothing.
    // Gated on `solid`, because an unfused extrude has no single contour to draw.
    const outlined = solid && width > 0 && hasPaint(layer.strokeColor)
    const L: VtPaintLayer = {
      id: typeof layer.id === 'string' ? layer.id : '',
      kind: layer.kind,
      paint,
      flat: flatPaint(paint),
      anchor: vtLayerAnchor(layer),
      width,
      outline: outlined ? { color: layer.strokeColor, width } : null,
      opacity,
      // Asked of the KIND as well as of the value: `draw` is inert on a fill
      // (there is no stroked ink to dash) and on an extrude's silhouette (which
      // only exists once the async union has landed), so those two are pinned to
      // `1` here rather than left to be ignored further down. A layer dropped to
      // 1 costs nothing at all — see `VtPaintLayer.draw`.
      draw: layer.kind === 'stroke' ? clamp01(Number.isFinite(layer.draw) ? layer.draw : 1) : 1,
      op: VT_BLEND_OP[layer.blend] ?? 'source-over',
      blendCss: VT_BLEND_CSS[layer.blend] ?? 'normal',
      // Asked of the KIND, not of `copies` — the extrude's copy list is filled in
      // by the budget pass below, and a layer whose reach depends on how much
      // budget was left would paint differently on a busy frame.
      spread: sheared || curved || layer.kind === 'extrude' || layer.kind === 'stroke' ? 'extend' : 'box',
      runPm: null,
      runStyle: null,
      copies: null,
      solid,
    }
    if (layer.kind === 'extrude') extrudes.push({ L, spec: layer })
    out.push(L)
  }

  if (!extrudes.length) return { layers: out, extrudeDropped: 0 }

  // ONE budget for the frame, spent across every extrude layer at once — see
  // `VT_EXTRUDE_FRAME_BUDGET`. Nothing is silently truncated: `dropped` is
  // returned, surfaced on `VtFrame`, and logged by `drawVectorType`.
  const { caps, dropped } = extrudeBudget(extrudes.map(e => e.spec.depth), glyphs)
  extrudes.forEach((e, i) => { e.L.copies = extrudeOffsets(e.spec, caps[i] as number) })
  // A layer the budget shortened to nothing paints nothing; drop it rather than
  // leave an empty copy list the draw loop would iterate zero times while still
  // paying to resolve its paint.
  return {
    layers: out.filter(L => L.kind !== 'extrude' || (L.copies?.length ?? 0) > 0),
    extrudeDropped: dropped,
  }
}

/**
 * The SOLID extrude layers of `cfg`, each with the EXACT copies the draw loop
 * would have drawn for them.
 *
 * The one seam between the renderer and the union. `prepareSolidExtrudes`
 * (`./extrudeSolid.ts`) calls this rather than walking the config itself, so the
 * bodies it builds are built from the same stack resolution, the same defaults
 * and — the part a second walk would certainly get wrong — the same spent
 * `VT_EXTRUDE_FRAME_BUDGET`. A union of 32 copies over a stack the preview
 * shortened to 19 is a bake that does not match its own preview.
 *
 * A layer with an empty id is skipped: `vtSolidKey` would collide every such
 * layer onto one key, and handing glyph 3 the wrong body is worse than handing
 * it none (it falls back to the copies and merely looks un-fused). Every layer
 * `mergeConfig` produces has an id; a hand-written raw blob may not.
 */
export function vtSolidExtrudeLayers(
  cfg: VectorTypeConfig | null | undefined,
  glyphs: number,
): Array<{ id: string; copies: VtExtrudeCopy[] }> {
  return vtPaintLayers(cfg, glyphs).layers
    .filter(L => L.kind === 'extrude' && L.solid && L.id !== '' && (L.copies?.length ?? 0) > 0)
    .map(L => ({ id: L.id, copies: L.copies as VtExtrudeCopy[] }))
}

/**
 * How much of one layer's outline glyph `index` has drawn, 0..1 — **the ONE
 * derivation both renderers use.**
 *
 * Two things are folded in here so neither surface can do only one of them:
 *
 *  1. `L.draw`, the layer's own leaf, already at its run-level value for this
 *     frame (`vtPaintLayers` read it off the post-`applyMotion` config);
 *  2. the per-glyph STAGGER, via `glyphStackLeaf` — the same tracks re-read on
 *     this glyph's own clock, which is what turns one 0 → 1 track into the
 *     letters drawing one after another instead of the whole word drawing at
 *     once. `glyphStackLeaf` returns the fallback untouched when nothing
 *     staggers, so an unstaggered clip and a hand-set `draw` are unaffected.
 *
 * `1` on every non-stroke layer: a dash needs stroked ink, and a solid extrude's
 * silhouette does not exist until the async union has landed (see
 * `VtAppearanceLayer.draw`).
 *
 * The RAW config, not `frame.config`: the stagger has to shift the clock the
 * TRACKS are read at, and `frame.config` has already had them applied at `t`.
 */
export function vtGlyphDrawProgress(
  cfg: VectorTypeConfig | null | undefined,
  L: Pick<VtPaintLayer, 'id' | 'kind' | 'draw'>,
  t: number,
  index: number,
  count: number,
): number {
  if (L.kind !== 'stroke') return 1
  if (!cfg) return clamp01(L.draw)
  return clamp01(glyphStackLeaf(cfg, L.id, 'draw', L.draw, t, index, count))
}

/**
 * The uniform scale a matrix applies, as √|det|.
 *
 * Only strokes need it, and only when the paint space is not the geometry space.
 * `ctx.lineWidth` is in CURRENT TRANSFORM units, so a stroke drawn under the
 * glyph's own CTM is scaled by the glyph's motion — which is exactly right, and
 * what a flat stroke has always done. A word- or frame-anchored PAINT, though, is
 * drawn with the transform set to the run's paint space, which carries no motion
 * at all; without this factor the same stroke would keep a constant width while
 * the letter scaled, and only for the non-flat paints. So the width is
 * pre-multiplied by `scale(CTM) / scale(pm)` to put it back.
 *
 * √|det| is the right scalar because it is the one canvas itself would apply to a
 * circular pen. Under a NON-uniform CTM (the card-flip presets) canvas strokes
 * with an elliptical pen and this is the average of the two axes instead —
 * documented rather than hidden; it affects a gradient-stroked card flip only.
 */
function matScale(m: DOMMatrix): number {
  const det = Math.abs(m.a * m.d - m.b * m.c)
  return det > 0 && Number.isFinite(det) ? Math.sqrt(det) : 1
}

/** The last shortfall warned about, so a 60fps preview of an over-budget config
 *  logs once rather than sixty times a second. Reset by any different shortfall,
 *  so raising the depth further does warn again. */
let lastExtrudeWarn = 0

/**
 * Say out loud that the frame budget shortened an extrude.
 *
 * `console.warn`, not a silent cap: the plan's own bar, and Space Type's and
 * Shape Studio's precedent for a truncated field. `frame.extrudeDropped` carries
 * the same number to any host that wants to show it in the UI.
 */
function warnExtrudeBudget(dropped: number, glyphs: number): void {
  if (dropped === lastExtrudeWarn) return
  lastExtrudeWarn = dropped
  console.warn(
    `[vectortype] extrude shortened: ${dropped} offset copies dropped over ${glyphs} glyphs ` +
    `(frame budget ${VT_EXTRUDE_FRAME_BUDGET} copies). Lower the depth, or shorten the text.`,
  )
}

export interface VtDrawOptions extends VtBoxOptions {
  /** Painted before the glyphs. `null`/omitted leaves the canvas transparent. */
  background?: string | null
  /** True for a final export/bake. Opts shader-fill fields out of the 512px live
   *  preview clamp AND out of `LIVE_FIELD_CEILING`, exactly as `paintLayerStack`'s
   *  own `bake` flag does — same function, same time, different resolution, which
   *  is what keeps a bake from drifting from the preview it was made in. Default
   *  `false` is byte-identical to the live path. */
  bake?: boolean
  /** Device/preview multiplier. The canvas must be `width*pixelRatio` wide. Lets
   *  a 220px card show the SAME composition a 1024px bake produces, rather than
   *  a differently-laid-out one. */
  pixelRatio?: number
  /**
   * Precomputed SOLID extrude bodies — the copies of a `solid: true` extrude
   * already fused into one path per glyph.
   *
   * ═══ THE BAKE/EXPORT BOUNDARY (plan trap 5) ═══
   *
   * **Nothing on a live path passes this, and nothing on a live path may.** A
   * boolean union of `depth × glyphs` paths is not a 60fps operation — it is not
   * within an order of magnitude of one — so the preview, the node card and the
   * frame source all omit it. A bake or an export `await`s
   * `prepareSolidExtrudes(font, cfg, t, opts)` (`./extrudeSolid.ts`) once and
   * hands the result in here.
   *
   * A live path that wants a body **peeks the cache instead** (see `solidBody`):
   * a `Map.get` that returns what somebody else already united, or nothing. That
   * is a read, not a trigger, and it is the only shape of live access this
   * boundary permits.
   *
   * It is a MAP OF GEOMETRY rather than a function on purpose: this renderer is
   * synchronous, so it could not await a union even if someone gave it one, and
   * with no callable here there is nothing for a future draw loop to call by
   * mistake.
   *
   * A missing entry is not an error. It means "no body for this (layer, glyph)",
   * and the layer falls back to its offset copies — which is exactly what the
   * live preview shows, so the fallback is a picture the user has already seen.
   */
  solid?: VtSolidBodies | null
}

/**
 * Draw one frame. Returns the resolved frame so a caller can assert on what
 * actually happened (`staggered`, `shapings`, glyph count) instead of trusting
 * that the picture came from the path it thinks it did.
 */
export function drawVectorType(
  ctx: CanvasRenderingContext2D,
  font: VtFont,
  cfg: VectorTypeConfig,
  t: number,
  opts: VtDrawOptions,
): VtFrame {
  const k = opts.pixelRatio && opts.pixelRatio > 0 ? opts.pixelRatio : 1
  const W = Math.max(1, Math.round(opts.width * k))
  const H = Math.max(1, Math.round(opts.height * k))

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  // The frame's own base transform, captured in DEVICE pixels while the context
  // is still identity. This is what a frame-anchored SHADER field is positioned
  // against: `resolveShaderFill` composes `CTM⁻¹ · base`, which cancels whatever
  // the fill-time transform happens to be, so the field lands on the device
  // canvas 1:1 regardless of which of the three anchors is drawing — and a 2×
  // bake asks for (and gets) a 2× field instead of a stretched 1× one.
  const deviceBase = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null
  ctx.clearRect(0, 0, W, H)
  if (opts.background) {
    ctx.fillStyle = opts.background
    ctx.fillRect(0, 0, W, H)
  }
  ctx.setTransform(k, 0, 0, k, 0, 0)

  // The box `fit: 'width'` solves against is the SAME one `vtPlacement` reads
  // (`availW = opts.width − 2·pad`) — written once here rather than inside the
  // frame, because only a caller that owns a box knows there is one to fit to.
  const frame = vectorTypeFrame(font, cfg, t, { fitBoxWidth: Math.max(0, opts.width - 2 * (opts.padding ?? 0)) })
  const place = vtPlacement(frame, opts)
  // `outlinesToPath2D` is exactly these two lines, split apart because the
  // PLACED COMMAND LISTS are needed as well as the paths: they are the first of
  // the four inputs a solid body is cached under, so `solidBody` below cannot
  // build a cache key without them. Same work, same order, no second placement.
  const placed = placeOutlines(frame.outlines, place)
  const paths = placed.map(cmds => commandsToPath2D(cmds))
  // The WHOLE-RUN shear, resolved ONCE for the run — `frame.config` is the
  // post-motion config, so an animated skew moves. `null` (both angles 0) makes
  // the block in `paintGlyph` a no-op and the frame byte-identical to before.
  const shear = vtRunShear(frame.config, frame.outlines, place, opts)
  // ── THE APPEARANCE STACK ────────────────────────────────────────────────────
  // Every enabled layer, back to front, resolved ONCE for the run. Task 2's
  // `vtBaseAppearance` bridge — which collapsed the stack to the bottom-most fill
  // plus the bottom-most stroke — is GONE from this path; `vtPaintLayers` walks
  // the array and keeps the one property the bridge was load-bearing for (a raw,
  // never-merged pre-stack blob still paints its fill AND its stroke).
  //
  // Each layer's paint goes through `lib/paint/resolve` — the SAME resolver the
  // Compositor paints with — because `ctx.fillStyle`/`strokeStyle` SILENTLY
  // IGNORE a non-string assignment. A `flat` layer (a `solid` fill, every lifted
  // legacy string) is the fast path and needs none of the anchoring machinery.
  //
  // An EXTRUDE layer resolves to a list of offset copies here too, budgeted
  // against the glyph count — the cost of an extrude is `depth × glyphs` filled
  // paths, and the glyph count is only known now.
  const { layers, extrudeDropped } = vtPaintLayers(frame.config, frame.outlines.glyphs.length)
  frame.extrudeDropped = extrudeDropped
  if (extrudeDropped > 0) warnExtrudeBudget(extrudeDropped, frame.outlines.glyphs.length)

  // The em in output pixels, from the placement rather than re-read from the
  // config, so the cell box a mask is measured against cannot drift from the
  // geometry it masks.
  const em = place.scale * (frame.outlines.unitsPerEm || 1000)

  // This host's OWN shader-fill frame state. Vector Type is a second field host,
  // not a guest in the Compositor's: it opens its own `withFieldFrame` span below
  // (Task 1's hand-off #4 — a shader fill painted outside any span works, because
  // token 0 skips the isolation check, but every field freezes at t=0), and it
  // threads this struct into every `resolvePaint` call rather than reaching for a
  // module global. `fps` comes from the config's own clock so the field quantises
  // its time the same way the motion does.
  const field: ShaderFieldFrameCtx = {
    frameW: W,
    frameH: H,
    t,
    fps: frame.config.motion?.fps ?? 30,
    base: deviceBase,
    bake: !!opts.bake,
    token: 0,
  }
  // ONE span for the whole stack, budgeted from every layer that can actually
  // ask for a field. A layer dropped by `vtPaintLayers` (disabled, zero-opacity,
  // an extrude) contributes nothing, so it cannot spend the live-field budget a
  // VISIBLE layer needs — which is the failure `frozenFields` reports.
  const requests = layers.flatMap(L =>
    L.flat === null ? vtFieldRequests(L.paint, W, H, t, field.fps, field.bake) : [])

  return withFieldFrame(requests, (frozenCount, token) => {
    // `resolveShaderFill` reads the token from here to pass into every
    // `resolveField` call, the same way it reads `t`/`fps`/`bake`.
    field.token = token
    // Surfaced, never swallowed — see `VtFrame.frozenFields`. The studio surface
    // turns a non-zero count into a visible hint; a host that drops it on the
    // floor is a host whose shader silently stops moving.
    frame.frozenFields = frozenCount
    drawGlyphRun()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    return frame
  })

  /**
   * The glyph loop, in a closure only so the `withFieldFrame` span above can wrap
   * it without re-indenting 90 lines of unrelated motion code.
   *
   * THE ANCHORS, mechanically. Each anchor picks a PAINT SPACE — a matrix `pm` —
   * and the fill is resolved and drawn with the context transform set to it:
   *
   *   glyph — `pm` is the glyph's own CTM (motion included) translated to the
   *           glyph's ink centre, so the fill rides the letter: a spinning letter
   *           spins its gradient with it.
   *   word  — `pm` is the frame's base transform translated to the RUN's ink
   *           centre. It does not depend on `i` at all, so one fill spans the
   *           whole word and the letters are windows onto it — a letter that
   *           moves slides across a fill that stays where the word is.
   *   frame — the same, but the box is the whole output box, so the type moves
   *           over a fill pinned to the canvas.
   *
   * The glyph's path is in the glyph's own CTM space, so it is pre-multiplied by
   * `pm⁻¹ · CTM` before filling: the GEOMETRY still lands exactly where the motion
   * put it, while the PAINT is anchored to `pm`. For `glyph` that product is a
   * bare translate; for `word`/`frame` it is the full cancellation of the glyph's
   * own motion, which is what makes those two anchors stand still.
   *
   * AND THE ANCHOR IS PER LAYER — that is the point of the stack. A word-anchored
   * gradient fill and a glyph-anchored stroke over it are two different paint
   * spaces alive in the same glyph span, which is why `runPm`/`runStyle` moved
   * from two locals onto `VtPaintLayer`.
   */
  function drawGlyphRun(): void {
    // PER LAYER, and hoisted for `word` and `frame`: their paint space and their
    // resolved style are the same for every letter, so the tile / gradient /
    // shader field is built ONCE for the run rather than once per glyph. Resolving
    // these inside the glyph loop would rebuild a word-anchored gradient for every
    // letter — the same picture, at N times the cost.
    for (const L of layers) {
      if (L.flat !== null || L.anchor === 'glyph') continue
      const box = L.anchor === 'frame' ? vtFramePaintBox(opts) : vtRunPaintBox(frame.outlines, place, opts)
      ctx.save()
      ctx.translate(box.cx, box.cy)
      L.runPm = ctx.getTransform()
      L.runStyle = resolvePaint(ctx, L.paint, { w: box.w, h: box.h }, field, L.spread)
      ctx.restore()
    }

    /**
     * The `Path2D` for one (layer, glyph)'s already-computed SOLID body, or
     * `null`.
     *
     * **This function does no geometry.** It cannot: the union is `async` and
     * lives behind an import edge this module does not have. There are exactly
     * two places a body can come from, and both are somebody else's finished
     * work:
     *
     *  1. **`opts.solid`** — the map a BAKE or an EXPORT awaited from
     *     `prepareSolidExtrudes` and handed in. Authoritative when present: a
     *     bake asked for these bodies at this exact time and must draw those,
     *     not whatever the preview happens to have warm.
     *  2. **`peekSolidBody`** — a synchronous `Map.get` against the paper-free
     *     body cache (`./extrudeBodyCache.ts`). This is the LIVE path's read,
     *     and it is safe precisely because the key is the union's whole
     *     geometric input: a hit is by construction the body of the copies this
     *     frame is about to draw, so there is no staleness to reason about. A
     *     MISS is the normal cold answer — the layer falls back to its offset
     *     copies, which is the picture the preview has always shown — and the
     *     surface's debounced watcher is what turns a miss into a hit a moment
     *     later. Nothing here waits for it. (`resolveField`'s posture exactly:
     *     `null` while the field is cooking, and the caller draws on.)
     *
     * Memoised per frame on `vtSolidKey`, so a six-layer stack does not rebuild
     * the same body — or the same ~1 kB cache key — six times.
     */
    const solidPaths = new Map<string, Path2D | null>()
    function solidBody(
      L: VtPaintLayer,
      index: number,
      origin: { x: number; y: number; rotate?: number },
      advance: number,
    ): Path2D | null {
      if (!L.id) return null
      const key = vtSolidKey(L.id, index)
      const hit = solidPaths.get(key)
      if (hit !== undefined) return hit
      let cmds = opts.solid?.get(key)
      if (!cmds?.length && L.copies?.length) {
        const glyphCommands = placed[index]
        // The live read. Building the key is a string join over this glyph's
        // commands — measured at ~30 µs, against a union that is 27–1,100 ms —
        // and it is what makes the answer exact rather than plausible.
        if (glyphCommands?.length) {
          cmds = peekSolidBody(solidBodyCacheKey(glyphCommands, L.copies, origin, advance))
        }
      }
      const built = cmds && cmds.length ? commandsToPath2D(cmds) : null
      solidPaths.set(key, built)
      return built
    }

    /**
     * One layer's ink on one glyph.
     *
     * ## Opacity MULTIPLIES; blend REPLACES
     *
     * `globalAlpha = motionOpacity × layerOpacity`. Multiply, not replace, and it
     * is not a coin toss: the two mean different things and both must survive.
     * The motion opacity is the glyph FADING (an entrance, an exit, a per-glyph
     * stagger), the layer opacity is how strong that layer's ink is in the stack.
     * Replacing would make a 50 % layer ignore a fade-out and stay at half
     * strength over a word that has already left; and a fade-out would flatten
     * every layer to the same opacity, destroying the stack's own weighting.
     * Multiplying is also the only rule that keeps `1` inert on either side.
     *
     * The BLEND is the layer's alone — there is no motion blend to compose with —
     * and it is set per layer rather than once per glyph so that a `multiply`
     * layer under a `normal` layer works. It is part of the saved drawing state,
     * so the glyph's own `restore()` is what stops it leaking, exactly as with
     * `ctx.filter`.
     *
     * ## EXTRUDE: the same path, N more times, BEHIND
     *
     * An extrude layer replays this glyph's path once per entry in `L.copies`,
     * in array order — which `extrudeOffsets` guarantees is BACK TO FRONT, so
     * the copy nearest the face lands last. There is no copy at offset zero: the
     * FACE is whatever `fill` layer sits ABOVE the extrude in the stack, which
     * is what makes "an extrude under a gradient fill" a stack expression rather
     * than a second paint model. It is filled, never stroked, on every kind of
     * paint — `width` is as inert on an extrude as it is on a fill.
     *
     * ### SOLID: the same ink, fused — whenever a body already exists
     *
     * When `solid: true` AND a body for this (layer, glyph) already exists —
     * handed in by a bake, or peeked out of the paper-free cache on a live
     * frame — the copy loop is replaced by ONE fill of the union. The difference
     * is exactly the overlaps: N translucent copies double-darken where they
     * cross, one body cannot. At full opacity the two are the same picture. The
     * union itself never happens here and cannot — see `solidBody` and
     * `VtDrawOptions.solid`.
     *
     * ### The paint space does NOT move with the copy — decided, not defaulted
     *
     * A copy translates the GEOMETRY inside the layer's paint space; `pm` and the
     * resolved `style` are computed once for this glyph and shared by every copy.
     * So a `word`-anchored gradient extrude is ONE ramp that the whole extruded
     * mass is a window onto — copy k samples it wherever copy k has been pushed
     * to — and the block reads as one solid body lit by one gradient.
     *
     * The alternative (moving `pm` with each copy, so every copy samples the ramp
     * identically) would make each copy an independent recolouring of the face
     * and the extrude would read as N stacked stickers, not a body. It would also
     * contradict what the anchor MEANS: `word` says "this paint is pinned to the
     * run", and a paint that slides along with the geometry it paints is pinned to
     * nothing. One rule, no per-anchor special case — and it is observable: with a
     * word-anchored A→B gradient and a horizontal extrude, the copies step
     * through the ramp; if they did not, every copy would be the face's colour.
     */
    function paintLayer(
      L: VtPaintLayer,
      glyphPath: Path2D,
      glyph: GlyphOutline,
      glyphAlpha: number,
      /** The glyph's placed origin — the taper pivot's anchor. */
      origin: { x: number; y: number; rotate?: number },
      /** The glyph's advance in output px — the taper pivot's other half. */
      advance: number,
      /** This glyph's index, so a precomputed solid body can be found. */
      index: number,
    ): void {
      ctx.globalAlpha = glyphAlpha * L.opacity
      ctx.globalCompositeOperation = L.op
      // ── SOLID: one fused body instead of N overlapping copies ───────────────
      // Only when a BAKE or an EXPORT has already awaited the union and handed it
      // in (see `VtDrawOptions.solid`). The body is in the same placed output
      // space as the glyph's own path, so it is drawn by the SAME code below with
      // the copy loop simply switched off — same paint, same anchor, same motion
      // transform, same clip. No entry (every live frame) → the copies below.
      const body = L.solid && L.copies ? solidBody(L, index, origin, advance) : null
      // The fused body REPLACES the glyph path AND cancels the copy loop: it
      // already contains every copy, so drawing it once per copy would paint the
      // same shape N times — the double-darkening this feature exists to remove.
      const path = body ?? glyphPath
      const copies = body ? null : L.copies
      // ── THE SILHOUETTE ──────────────────────────────────────────────────────
      // One outline around the whole extruded body, and ONLY when that body
      // exists. `body === null` is the cold frame — the union has not landed for
      // this exact geometry — and the honest answer there is the un-unioned
      // copies, UNSTROKED. Stroking them individually would outline each copy and
      // run seam lines through the block, which is not a lesser silhouette; it is
      // a different, wrong picture. Nothing here waits, computes or errors: this
      // is `resolveField`'s posture, one module along.
      const outline = body && L.outline ? L.outline : null
      /**
       * ── DRAW-ON ────────────────────────────────────────────────────────────
       * The dash that makes this letter half-drawn, measured against THIS
       * GLYPH's own placed geometry (`placed[index]`, the very command list the
       * `Path2D` above was replayed from and the SVG writer's `d` comes out of).
       *
       * Per glyph and not per run, because every letterform is a different
       * length: one pattern across the word would draw an `l` and an `M` to
       * wildly different fractions of themselves at the same progress.
       *
       * The PROGRESS is `vtGlyphDrawProgress`'s, which folds in the per-glyph
       * stagger — so letter 3 can be behind letter 0 — and the SVG writer calls
       * the identical function.
       *
       * `null` at full draw and on every non-stroke layer, and `null` means the
       * dash is never touched at all — so a config without a draw-on paints
       * exactly the bytes it always did. The state is scoped by `paintGlyph`'s
       * own `save`/`restore` (the dash list is part of the canvas drawing state,
       * like `ctx.filter` above it); nothing resets it by hand, because a second
       * reset site is a second place to forget one.
       */
      const progress = vtGlyphDrawProgress(cfg, L, t, index, frame.outlines.glyphs.length)
      const dash = progress < 1 ? vtDrawOnDash(pathLength(placed[index]).longest, progress) : null
      /**
       * The silhouette pass — a no-op unless a fused body was found.
       *
       * Drawn AFTER the body's fill, so the outline sits on top of its own ink
       * rather than half-buried under it; a centred pen puts half the width
       * inside the contour either way, and this is the order Illustrator's
       * appearance stack uses for a stroke over a fill.
       *
       * `widthScale` is `matScale(gm)/matScale(pm)` on the anchored path and
       * exactly 1 on the flat one — `ctx.lineWidth` is in the CURRENT transform's
       * units, and the anchored branch has left the glyph's own for a paint
       * space. Same factor, same reason, as the stroke LAYER a few lines down.
       */
      const strokeOutline = (p: Path2D, widthScale = 1): void => {
        if (!outline) return
        ctx.lineWidth = outline.width * widthScale
        ctx.lineJoin = 'round'
        ctx.strokeStyle = outline.color
        ctx.stroke(p)
      }
      if (L.flat !== null) {
        const stroking = L.kind === 'stroke'
        if (stroking) {
          ctx.lineWidth = L.width
          ctx.lineJoin = 'round'
          ctx.strokeStyle = L.flat
          // Untouched at `dash === null`. The dash list is in the CURRENT
          // transform's units — the same rule `lineWidth` follows — and on this
          // branch that transform is the glyph's own, which is the space
          // `placed[index]` is measured in. So no factor, exactly as the width
          // needs none here.
          if (dash) {
            ctx.setLineDash(dash.dash)
            ctx.lineDashOffset = dash.offset
          }
        } else {
          ctx.fillStyle = L.flat
        }
        // nonzero, always: glyph counters (the hole in an 'o') depend on it.
        const once = () => (stroking ? ctx.stroke(path) : ctx.fill(path, 'nonzero'))
        if (!copies) {
          once()
          strokeOutline(path)
          return
        }
        for (const c of copies) {
          // The copy transform is applied to the CONTEXT rather than folded into
          // a matrix, because the flat path deliberately never touches
          // `getTransform`/`Path2D.addPath` at all — that is what makes it the
          // fast path, and it is the path almost every frame in the product takes.
          ctx.save()
          applyCopy(c, origin, advance)
          once()
          ctx.restore()
        }
        return
      }
      // The glyph's own CTM, motion already applied by the caller.
      const gm = ctx.getTransform()
      const box = L.runPm ? null : vtGlyphPaintBox(glyph, place, em)
      const pm = L.runPm ?? gm.translate(box!.cx, box!.cy)
      // Pull the path back into the paint space so the paint is anchored to `pm`
      // while the glyph still draws where the motion put it. ONE matrix for the
      // glyph, reused by every extrude copy — the copy's own step is composed on
      // the right of it, i.e. applied in the GLYPH's space, where `dx`/`dy` are
      // the output pixels the control promises.
      const toPaint = pm.inverse().multiply(gm)
      ctx.save()
      ctx.setTransform(pm)
      const style = L.runStyle ?? resolvePaint(ctx, L.paint, { w: box!.w, h: box!.h }, field, L.spread)
      // The paint space is not the geometry space here, so a length expressed in
      // the glyph's units has to be put back into the paint space's — see
      // `matScale`. ONE factor, read by the stroke width, the silhouette's width
      // and the draw-on dash below, because they are the same conversion and
      // three copies of it is three places for one of them to go stale. Exactly
      // 1 at the `glyph` anchor, where `pm` is `gm` translated.
      const outlineScale = matScale(gm) / matScale(pm)
      const stroking = L.kind === 'stroke'
      if (stroking) {
        ctx.lineWidth = L.width * outlineScale
        ctx.lineJoin = 'round'
        ctx.strokeStyle = style
        // The DASH is a length too, and the path was just pulled into the paint
        // space by `toPaint` — so it takes the identical factor the width does.
        // Getting this wrong would draw a plausible-looking dash at the wrong
        // fraction, and only on a word- or frame-anchored stroke.
        if (dash) {
          ctx.setLineDash([dash.dash[0] * outlineScale, dash.dash[1] * outlineScale])
          ctx.lineDashOffset = dash.offset * outlineScale
        }
      } else {
        ctx.fillStyle = style
      }
      const drawAt = (m: DOMMatrix) => {
        const local = new Path2D()
        local.addPath(path, m)
        if (stroking) ctx.stroke(local)
        else ctx.fill(local, 'nonzero')
        strokeOutline(local, outlineScale)
      }
      if (!copies) drawAt(toPaint)
      else for (const c of copies) drawAt(copyMatrix(toPaint, c, origin, advance))
      ctx.restore()
    }

    // WHERE a copy goes — including the pivot a tapered one scales about — is
    // `extrudeCopyTransform`'s answer, not this file's. It is the same pivot the
    // motion `scaleX`/`scaleY` block below uses (the glyph CELL's centre
    // horizontally, the BASELINE vertically) and, since Task 5, the same one the
    // SOLID union steps its copies with. Three derivations of a
    // translate-and-scale would drift, and a union that disagreed with the
    // preview by a pixel is a plausible picture that is not the one on screen.

    /** Apply one copy's step to the CONTEXT, in the glyph's own space. */
    function applyCopy(c: VtExtrudeCopy, origin: { x: number; y: number; rotate?: number }, advance: number): void {
      const t = extrudeCopyTransform(c, origin, advance)
      ctx.translate(t.x, t.y)
      if (t.scale !== 1) ctx.scale(t.scale, t.scale)
    }

    /** The same step, as a matrix composed onto `base` — the anchored path, where
     *  the context transform is the PAINT space and the copy must move in the
     *  glyph's. */
    function copyMatrix(
      base: DOMMatrix,
      c: VtExtrudeCopy,
      origin: { x: number; y: number; rotate?: number },
      advance: number,
    ): DOMMatrix {
      const t = extrudeCopyTransform(c, origin, advance)
      const stepped = base.translate(t.x, t.y)
      return t.scale === 1 ? stepped : stepped.scale(t.scale, t.scale)
    }

    /**
     * Paint ONE layer's ink on ONE glyph, inside that glyph's own drawing state
     * — its motion alpha, its blur, its cell clip and its motion transform.
     *
     * The state is rebuilt per (layer, glyph) rather than once per glyph,
     * because the stack loop is now the OUTER one (see below). That is a handful
     * of extra `ctx` calls per layer; the alternative is a wrong picture.
     */
    function paintGlyph(L: VtPaintLayer, i: number): void {
      const glyph = frame.outlines.glyphs[i] as GlyphOutline
      const path = paths[i] as Path2D
      const tr = frame.transforms[i] ?? IDENTITY_GLYPH_MOTION
      // The glyph's own placed origin — motion rotates and scales AROUND it, so a
      // spinning glyph spins in place rather than swinging about the canvas corner.
      const origin = glyphPlacement(glyph, place)

      ctx.save()
      // The glyph's own fade, before any layer weighting. Set here as well as in
      // `paintLayer` so an EMPTY stack still leaves the context in the state this
      // loop documents, and so the clip/blur below run under it.
      const glyphAlpha = clamp01(tr.opacity)
      ctx.globalAlpha = glyphAlpha

      // BLUR. `ctx.filter` is part of the saved drawing state, so the `restore()`
      // at the bottom of this loop body is what stops it leaking into the next
      // glyph — and a leak is invisible until a glyph that should be sharp is not.
      // Nothing resets it by hand: a second reset site is a second place to forget
      // one.
      //
      // The `* k` is load-bearing, not decoration. A canvas filter's blur radius
      // is in DEVICE pixels and IGNORES the current transform — measured in Chrome
      // at ctm scale 0.5, 1 and 2, where `blur(4px)` grew a rect's device-pixel
      // footprint by exactly 18px in all three. `tr.blur` is in LOGICAL output
      // pixels (`presetMotion` already multiplied by the em), so without this the
      // 220px node card would blur ~5× harder than the 1024px bake of the same
      // config — trap 1 again, one layer down.
      const blurPx = Number.isFinite(tr.blur) ? Math.max(0, tr.blur) * k : 0
      // Below ~1/20 device px there is nothing to see, and setting a filter costs
      // a separate compositing pass per glyph.
      if (blurPx >= 0.05) ctx.filter = `blur(${blurPx}px)`

      const advance = glyph.advance * place.scale
      // CLIP — before the transform below, deliberately. See `clipGlyphCell`.
      if (tr.clip && tr.clip.amount > 0.001) {
        clipGlyphCell(ctx, origin, advance, em, tr.clip)
      }

      // THE WHOLE-RUN SHEAR, and it goes HERE — after the clip and before the
      // motion. After the clip, because the mask window is fixed in output space
      // and the SVG writer's `<clipPath>` rides an untransformed wrapper `<g>`;
      // shearing the context first would lean the canvas's window and not the
      // file's. Before the motion, because the element transform is
      // `shear · motion`: the run is animated and then the whole composition
      // leans, rather than each letter carrying a shear into its own spin.
      //
      // One `ctx.transform` — the same six numbers the export writes as its
      // leading `matrix(…)`, from the same `vtRunShear`.
      if (shear) ctx.transform(shear[0], shear[1], shear[2], shear[3], shear[4], shear[5])

      const sx = nonZero(tr.scale * (Number.isFinite(tr.scaleX) ? tr.scaleX : 1))
      const sy = nonZero(tr.scale * (Number.isFinite(tr.scaleY) ? tr.scaleY : 1))
      if (tr.dx || tr.dy || tr.rotate || sx !== 1 || sy !== 1) {
        // IN THE GLYPH'S OWN FRAME — `dy` is a baseline shift, so on a curve it
        // moves the letter off ITS baseline rather than down the screen. See
        // `vtGlyphOffset` for the decision and the four reasons; on a straight
        // run it returns `(dx, dy)` unchanged, by a branch.
        const d = vtGlyphOffset(tr.dx, tr.dy, origin.rotate)
        ctx.translate(origin.x + d.x, origin.y + d.y)
        if (tr.rotate) ctx.rotate((tr.rotate * Math.PI) / 180)
        // Non-uniform, so the card-flip presets are DRAWN rather than degenerating
        // into a bare opacity ramp (Task 4 produced `scaleX`/`scaleY` and flagged
        // that nothing applied them). `scale` and `scaleX/Y` multiply: the uniform
        // one is the tracks' and the presets' shared channel, the per-axis pair is
        // the flip on top of it.
        //
        // THE PIVOT IS NOT THE ORIGIN. The origin is the glyph's LEFT edge on the
        // baseline. Vertically that is exactly right — type scales about its
        // baseline, which is why `card-flip-v` always read correctly. Horizontally
        // it pins each letter's left edge, so at `scaleX 0.43` the letters narrow
        // by 57 % while the word narrows by 7 %: six thin letters with wide gaps,
        // not six cards turning in place. So the horizontal pivot is the glyph
        // CELL's centre and the vertical one stays on the baseline.
        //
        // Rotation is deliberately left OUTSIDE this, still turning about the
        // origin: it was not the reported defect, `spin`/`sway`/`rock` are
        // verified against it, and moving two pivots at once would make any
        // regression impossible to attribute.
        //
        // On a CURVE the cell centre is half an advance along the glyph's own
        // TANGENT, not along the output's x — `vtCellPivot`, the same function
        // `extrudeCopyTransform` and the two SVG transform writers use, so the
        // four surfaces that scale a glyph cannot disagree about the point it
        // turns about.
        if (sx !== 1 || sy !== 1) {
          const h = vtCellPivot(advance, origin.rotate)
          ctx.translate(h.x, h.y)
          ctx.scale(sx, sy)
          ctx.translate(-h.x, -h.y)
        }
        ctx.translate(-origin.x, -origin.y)
      }
      paintLayer(L, path, glyph, glyphAlpha, origin, advance, i)
      ctx.restore()
    }

    /**
     * THE STACK, BACK TO FRONT — and the LAYER loop is the OUTER one.
     *
     * Array order is paint order, so a stroke layer below a fill draws first and
     * the fill covers its inner half — the ordering the single fixed
     * fill-then-stroke pair could not express.
     *
     * ## Why the layer loop is outside the glyph loop, and not inside it
     *
     * Task 3 shipped this glyph-major (`for glyph: for layer`), which is
     * indistinguishable from layer-major for as long as no layer's ink leaves
     * its own glyph cell. EXTRUDE is the first layer kind with REACH: its copies
     * step `depth × distance` px away, straight over the neighbouring letters.
     * Glyph-major then draws letter 2's block shadow ON TOP OF letter 1's face,
     * because letter 1's face was already finished — measured live at the
     * default 135° angle: 4,674 of the face's 11,092 px eaten at `distance: 8`,
     * and letters visibly bitten out of the word.
     *
     * Layer-major is what "an ordered appearance stack" means: a layer covers the
     * WHOLE RUN before the next one starts, so an extrude is behind every face,
     * not just behind its own letter's. It costs a per-glyph state setup per
     * layer (alpha, blur, clip, transform — a handful of `ctx` calls), and for
     * the one-layer default it is byte-identical to what was there.
     */
    for (const L of layers) {
      for (let i = 0; i < paths.length; i++) paintGlyph(L, i)
    }
  }
}

/** Size `canvas` and draw into it. The convenience wrapper every consumer uses. */
export function drawVectorTypeToCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  font: VtFont,
  cfg: VectorTypeConfig,
  t: number,
  opts: VtDrawOptions,
): VtFrame | null {
  const k = opts.pixelRatio && opts.pixelRatio > 0 ? opts.pixelRatio : 1
  const W = Math.max(1, Math.round(opts.width * k))
  const H = Math.max(1, Math.round(opts.height * k))
  if (canvas.width !== W) canvas.width = W
  if (canvas.height !== H) canvas.height = H
  const ctx = (canvas as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null
  if (!ctx) return null
  return drawVectorType(ctx, font, cfg, t, opts)
}

// ── The vector output ───────────────────────────────────────────────────────
//
// This module is called `canvas.ts` because pixels were its first job, but what
// it really owns is `(config, time) -> a placed, motion-composed frame`. The SVG
// writer below is the SECOND consumer of exactly that, and it lives here rather
// than in `render.ts` for the reason the rest of this file exists: framing,
// tracking, alignment and the per-glyph motion composition must be decided ONCE.
// A separate export path that re-derived any of them would drift, and the drift
// would be invisible — both outputs would still look like the word.
//
// Nothing here is the SVG serialiser. That is `~/lib/vector/svg`, which knows
// nothing about type and is Shape Studio's next consumer; `render.ts` is the
// type-specific adapter over it. This function only decides WHAT to hand it.

/**
 * One glyph's element transform — the run's SHEAR plus that glyph's MOTION — as
 * an SVG `transform` list.
 *
 * Mirrors `drawVectorType`'s canvas sequence exactly:
 *
 *   matrix(shear) · translate(origin + d) · rotate · translate(adv/2, 0) · scale
 *                                         · translate(-adv/2, 0) · translate(-origin)
 *
 * `d` is `vtGlyphOffset(tr.dx, tr.dy, origin.rotate)` — the motion offset in the
 * glyph's OWN frame — and `adv/2` is `vtCellPivot` for the same reason. Both are
 * the identity expression on a straight run.
 *
 * An SVG transform list composes left-to-right the same way successive `ctx`
 * operations do, and SVG's `rotate(deg)` turns the same direction as
 * `ctx.rotate(rad)` because both spaces are y-down here (the flip is already
 * baked into the coordinates by `transformCommands`). So the two are the same
 * transform written twice, not two transforms that happen to agree.
 *
 * The SHEAR leads, matching the `ctx.transform` the canvas issues before its
 * motion block — see `vtRunShear` for why the composition is that way round. It
 * is written as one `matrix(…)` rather than as SVG's own `skewX`/`skewY` pair
 * because those two do NOT compose to the requested shear: `skewX(a) skewY(b)`
 * is `[1 + tan a·tan b, tan b, tan a, 1]`, whose top-left term is not 1. One
 * primitive is also one thing for `glyphSvgMatrix` to agree with.
 *
 * The pair of `adv/2` translates around the scale is the horizontal pivot — see
 * the long note at the canvas site for why it is the cell centre and not the
 * origin. It is written here in the same shape rather than folded into the
 * outer translates on purpose: a reader comparing the two functions has to be
 * able to see that they are the same list.
 *
 * Returns `undefined` for identity so an unanimated, unskewed export carries no
 * attribute.
 */
function glyphSvgTransform(
  origin: { x: number; y: number; rotate?: number },
  advance: number,
  tr: VtGlyphMotion,
  /** The run's shear, from `vtRunShear`. `null` = none. */
  shear: Affine | null,
  precision = 3,
): string | undefined {
  const sx = nonZero(tr.scale * (Number.isFinite(tr.scaleX) ? tr.scaleX : 1))
  const sy = nonZero(tr.scale * (Number.isFinite(tr.scaleY) ? tr.scaleY : 1))
  const still = !tr.dx && !tr.dy && !tr.rotate && sx === 1 && sy === 1
  if (still && !shear) return undefined
  const n = (v: number) => formatNumber(v, precision)
  const parts: string[] = []
  if (shear) parts.push(`matrix(${shear.map(n).join(' ')})`)
  if (still) return parts.join(' ')
  const d = vtGlyphOffset(tr.dx, tr.dy, origin.rotate)
  parts.push(`translate(${n(origin.x + d.x)} ${n(origin.y + d.y)})`)
  if (tr.rotate) parts.push(`rotate(${n(tr.rotate)})`)
  // Single-argument when uniform: that is the same transform, and it keeps an
  // ordinary export readable. The two-argument form appears only for a card
  // flip, which is exactly when the axes really do differ.
  if (sx !== 1 || sy !== 1) {
    const h = vtCellPivot(advance, origin.rotate)
    parts.push(`translate(${n(h.x)} ${n(h.y)})`)
    parts.push(sx === sy ? `scale(${n(sx)})` : `scale(${n(sx)} ${n(sy)})`)
    parts.push(`translate(${n(-h.x)} ${n(-h.y)})`)
  }
  parts.push(`translate(${n(-origin.x)} ${n(-origin.y)})`)
  return parts.join(' ')
}

/**
 * The SAME transform as `glyphSvgTransform`, as a matrix.
 *
 * A run- or frame-anchored paint server has to be pinned in document space, and
 * the only thing that does that is a `gradientTransform` holding the INVERSE of
 * the glyph's own transform (`VectorGradient.units` says why the untransformed
 * wrapper `<g>` cannot). That needs the transform as numbers, not as a string.
 *
 * Written as the same sequence of parts, in the same order, from the same
 * inputs, ROUNDED THE SAME WAY — so the matrix is the exact transform the
 * `transform` attribute spells out, not an approximation of it. A unit test
 * parses the string and composes it to hold the two together; two hand-written
 * compositions of the same list is precisely the drift this file exists to
 * prevent.
 *
 * `null` for identity, matching `glyphSvgTransform`'s `undefined`.
 *
 * The SHEAR is the same six numbers, rounded the same way and composed in the
 * same place (first), so a skewed word-anchored ramp is pinned by the inverse of
 * the transform the file actually carries. That inverse now has OFF-DIAGONAL
 * terms — the whole reason `VT_SKEW_MAX` bounds the determinant away from zero.
 */
function glyphSvgMatrix(
  origin: { x: number; y: number; rotate?: number },
  advance: number,
  tr: VtGlyphMotion,
  /** The run's shear, from `vtRunShear`. `null` = none. */
  shear: Affine | null,
  precision = 3,
): Affine | null {
  const sx = nonZero(tr.scale * (Number.isFinite(tr.scaleX) ? tr.scaleX : 1))
  const sy = nonZero(tr.scale * (Number.isFinite(tr.scaleY) ? tr.scaleY : 1))
  const still = !tr.dx && !tr.dy && !tr.rotate && sx === 1 && sy === 1
  if (still && !shear) return null
  // Through the string formatter and back, so the matrix carries the numbers the
  // file carries rather than the full-precision ones behind them.
  const q = (v: number) => Number.parseFloat(formatNumber(v, precision))
  const T = (x: number, y: number): Affine => [1, 0, 0, 1, x, y]
  let m: Affine = shear
    ? [q(shear[0]), q(shear[1]), q(shear[2]), q(shear[3]), q(shear[4]), q(shear[5])]
    : IDENTITY_AFFINE
  if (still) return m
  const d = vtGlyphOffset(tr.dx, tr.dy, origin.rotate)
  m = multiplyAffine(m, T(q(origin.x + d.x), q(origin.y + d.y)))
  if (tr.rotate) {
    const rad = (q(tr.rotate) * Math.PI) / 180
    const c = Math.cos(rad), s = Math.sin(rad)
    m = multiplyAffine(m, [c, s, -s, c, 0, 0])
  }
  if (sx !== 1 || sy !== 1) {
    const h = vtCellPivot(advance, origin.rotate)
    const hx = q(h.x)
    const hy = q(h.y)
    m = multiplyAffine(m, T(hx, hy))
    m = multiplyAffine(m, [q(sx), 0, 0, q(sy), 0, 0])
    m = multiplyAffine(m, T(-hx, -hy))
  }
  return multiplyAffine(m, T(q(-origin.x), q(-origin.y)))
}

/** A `VtPaintBox` (centre + extent, the canvas resolver's convention) as a
 *  document-space rect, which is what a `userSpaceOnUse` paint server spans. */
function paintBoxRect(box: VtPaintBox): VectorRect {
  return { x: box.cx - box.w / 2, y: box.cy - box.h / 2, width: box.w, height: box.h }
}

// ── TIER 3: the honest raster embed ─────────────────────────────────────────
//
// `ombre`, `noise` and `shader` have no vector form and never will. `ombre` and
// `noise` are per-pixel stochastic dithers — there is no SVG primitive for "this
// pixel, by hash" — and a `shader` is a WebGL2 fragment program, pixels by
// construction with no geometry to recover. The user chose all nine fill types
// knowing three of them are like this; the deal is that the export is CORRECT and
// DECLARED, not that it is quietly replaced by a flat colour (which is what the
// Compositor's writer does, and what this replaces).
//
// So they come out as `<pattern><image href="data:image/png;base64,…">`. Real,
// working, self-contained SVG — simply raster. Task 7 is what tells the user.
//
// THE SPINE STAYS PURE (plan trap 3). `lib/vector/svg.ts` is documented "no DOM,
// no canvas, no fetch", which is the property that makes it reusable — Shape
// Studio is its intended second consumer. A data URL needs a canvas, so the
// encoding happens HERE and the finished string is passed in;
// `VectorPattern.image` is a string the writer was handed, never one it built.

/** Above this, a supersampled embed costs more file than it can possibly show.
 *  It caps the SUPERSAMPLING only — never the 1:1 floor; see `rasterScaleFor`. */
const RASTER_MAX_PX = 4096

/**
 * Pixels per document unit for this export's embeds.
 *
 * THE FLOOR IS 1, ALWAYS. The point of this whole function is the thing it
 * cannot do: return less than export resolution. `resolveField` clamps a LIVE
 * request to 512 px, which is right for a 30 fps preview and catastrophic for an
 * export — a 1600-unit-wide shader fill would embed a 512 px bitmap stretched
 * over it. The clamp is opted out of with `bake: true` (see `rasteriseForExport`),
 * and the size asked for is derived from the document, so nothing here can quietly
 * re-introduce it. `RASTER_MAX_PX` only trims SUPERSAMPLING on a huge document.
 *
 * THE DEFAULT IS A MEASUREMENT, not a taste. A shader field is a CONTINUOUS
 * function being sampled, so supersampling it is strictly better: measured against
 * the canvas at 1:1, a 2× embed of three different effects diffs 0.0000 % of core
 * ink pixels (worst 0) — free crispness for a designer who scales the artwork up.
 * `ombre` and `noise` are the opposite: their raster grid IS the artwork, a
 * per-pixel hash, and supersampling it produces a genuinely FINER grain — 56–91 %
 * of core pixels differ, with the 8×8 block mean off by 10–17/255, i.e. a visibly
 * different fill rather than a sharper one. So a dither embeds at exactly 1:1 and
 * a field at 2×.
 *
 * An EXPLICIT `rasterScale` still wins for either — a caller that wants a 4×
 * dither is asking for a finer grain deliberately, and this is not the place to
 * argue.
 */
function rasterScaleFor(opts: VtSvgOptions, boxes: readonly (VtPaintBox | null)[], paint: Paint): number {
  const sampled = isFill(paint) && fillIsShader(paint)
  const asked = Number.isFinite(opts.rasterScale as number) ? (opts.rasterScale as number) : (sampled ? 2 : 1)
  const s = Math.max(1, Math.min(4, asked))
  let side = Math.max(opts.width, opts.height, 1)
  for (const b of boxes) if (b) side = Math.max(side, b.w, b.h)
  return Math.min(s, Math.max(1, RASTER_MAX_PX / side))
}

/**
 * One paint box → a PNG data URL, by drawing the SAME resolver the canvas paints
 * with over the SAME box. Not a second rendering of the fill: `resolvePaint` is
 * `lib/paint/resolve`'s, so what is embedded is by construction what
 * `drawVectorType` would have put on screen.
 *
 * ── THE COPY (plan trap 4) ─────────────────────────────────────────────────
 * `resolveField` hands back a canvas OWNED by its LRU cache, and its ownership
 * contract says consumers MUST NOT copy it — an earlier revision that copied
 * everywhere measured as the dominant cost in a ~4× regression, which is why the
 * contract exists at all. Filling with the resulting `CanvasPattern` copies those
 * pixels into the canvas below, and `toDataURL` copies them again.
 *
 * That is legitimate HERE AND NOWHERE ELSE. An export is one-shot: there is no
 * frame budget to blow, and an SVG cannot reference a live canvas — the pixels
 * have to become bytes in the file or there is no export. Every per-frame path
 * (`drawVectorType`, the node card, the frame source) still binds the field
 * directly through `ctx.fillStyle` and copies nothing.
 *
 * The gate is that this function is MODULE-PRIVATE and called from exactly one
 * place, `vectorTypeSVG` below. It is not exported, so it cannot be picked up by
 * a render loop; if you find yourself widening that, you are about to pay the 4×.
 */
function rasterisePaintBox(paint: Paint, box: VtPaintBox, scale: number, field: ShaderFieldFrameCtx): string | null {
  const w = Math.max(1, Math.round(box.w * scale))
  const h = Math.max(1, Math.round(box.h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const x0 = box.cx - box.w / 2
  const y0 = box.cy - box.h / 2
  // The FRAME's own base transform, in this raster's pixels — the same capture
  // `drawVectorType` makes while its context is still identity, and what a
  // FRAME-anchored shader field is positioned against (`resolveShaderFill`
  // composes `CTM⁻¹ · base`). Here the raster covers only `box`, so the frame's
  // origin sits at `-x0·scale, -y0·scale`: a frame-anchored field stays pinned to
  // the document even when the box it is being sampled through is one letter's.
  ctx.setTransform(1, 0, 0, 1, -x0 * scale, -y0 * scale)
  field.base = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null
  // Document units → raster pixels, then the resolver's CENTRED-origin
  // convention: exactly `drawGlyphRun`'s `translate(box.cx, box.cy)` before
  // `resolvePaint`, so the geometry the resolver builds lands on the same pixels.
  ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale)
  ctx.translate(box.cx, box.cy)
  ctx.fillStyle = resolvePaint(ctx, paint, { w: box.w, h: box.h }, field)
  ctx.fillRect(-box.w / 2, -box.h / 2, box.w, box.h)
  return canvas.toDataURL('image/png')
}

/**
 * The embeds for one export: one data URL per paint box, index-aligned.
 *
 * Opens this export's own `withFieldFrame` span with `bake: true`, which is what
 * takes a shader fill's field off the 512 px live clamp AND out of
 * `LIVE_FIELD_CEILING` — an export has no frame budget to protect. The requests
 * come from `vtFieldRequests`, the same function `drawVectorType` uses, so the
 * key the span budgets is the key `resolveShaderFill` then asks for; deriving it
 * twice is how a field silently freezes at `t = 0`.
 *
 * Every box shares ONE span and one field: at the `glyph` anchor six letters
 * resolve the same descriptor six times and hit the field cache five of them.
 *
 * A `null` BOX (a glyph with no ink — a space, whose path is empty and whose
 * shape the writer drops) costs nothing: no canvas, no encode. A `null` RESULT
 * means there was no canvas to draw on at all (SSR, a worker, the unit test
 * environment) and the caller falls back to a flat colour, which is the
 * pre-task-6 behaviour rather than a blank fill.
 */
function rasteriseForExport(
  paint: Paint,
  boxes: readonly (VtPaintBox | null)[],
  opts: VtSvgOptions,
  t: number,
  fps: number,
): (string | null)[] {
  if (typeof document === 'undefined' || !boxes.some(Boolean)) return boxes.map(() => null)
  const scale = rasterScaleFor(opts, boxes, paint)
  // The document at embed resolution — what a frame-anchored field is asked for.
  const frameW = Math.max(1, Math.round(opts.width * scale))
  const frameH = Math.max(1, Math.round(opts.height * scale))
  const requests = vtFieldRequests(paint, frameW, frameH, t, fps, true)
  return withFieldFrame(requests, (_frozen, token) => {
    const field: ShaderFieldFrameCtx = { frameW, frameH, t, fps, base: null, bake: true, token }
    return boxes.map(box => (box ? rasterisePaintBox(paint, box, scale, field) : null))
  })
}

export interface VtSvgOptions extends VtBoxOptions {
  /** Painted as a full-bleed rect behind the glyphs, matching the canvas.
   *  `null`/omitted leaves the document transparent. */
  background?: string | null
  /** Decimal places in path data. Default 3 — sub-tenth-of-a-pixel. */
  precision?: number
  /**
   * Pixels per document unit in a TIER-3 raster embed (`ombre`, `noise`,
   * `shader` — see `rasteriseForExport`). Clamped to 1..4; the DEFAULT depends
   * on the fill and is a measurement, not a preference (see `rasterScaleFor`).
   *
   * `1` is exactly export resolution: the viewBox is 1:1 with the rendered size,
   * so one raster pixel per document unit is what a 100 % view shows. It is
   * never clamped BELOW that, which is the property that matters — the live
   * 512 px field clamp must not reach the export.
   */
  rasterScale?: number
  /**
   * Precomputed SOLID extrude bodies — exactly `VtDrawOptions.solid`, and for
   * exactly the same reason (plan trap 5): the union is `async` and this writer
   * is not, so the geometry has to arrive already computed.
   *
   * With one, a `solid: true` extrude layer emits **ONE `<path>` per glyph**
   * instead of `depth` overlapping ones — a designer opening the file gets one
   * selectable block shadow rather than eight stacked letters. Without one it
   * emits the copies, which is the picture the live preview shows, so omitting
   * it is a valid export and never an error.
   *
   * The export site awaits `prepareSolidExtrudes` (which memoises, so a sequence
   * bake pays for one frame's unions) and passes the map straight through.
   */
  solid?: VtSolidBodies | null
}

export interface VtSvgResult {
  svg: string
  /** The same `VtFrame` the canvas would have drawn, so a caller can assert the
   *  export came from the path it thinks it did (glyph count, `staggered`,
   *  `shapings`) rather than trusting the picture. */
  frame: VtFrame
}

/**
 * Draw one frame as VECTOR — Sailor's first real vector deliverable.
 *
 * The SVG twin of `drawVectorType`, and deliberately the same three lines of
 * setup: `vectorTypeFrame` for the geometry at time `t`, `vtPlacement` for where
 * it lands in the output box, `glyphPlacement` for each glyph's own origin. Only
 * the replay differs.
 *
 * What comes out is editable geometry: one `<path>` per glyph whose `d` is the
 * glyph's real outline at its real axis position, with `fill`/`stroke` as
 * attributes (never baked into the geometry) and per-glyph motion as a
 * `transform`. No raster, no `<image>`, nothing traced.
 *
 * `t` is a real clock, so exporting mid-animation exports THAT frame — pass the
 * time the surface is showing and the file matches the screen.
 */
export function vectorTypeSVG(
  font: VtFont,
  cfg: VectorTypeConfig,
  t: number,
  opts: VtSvgOptions,
): VtSvgResult {
  // The box `fit: 'width'` solves against is the SAME one `vtPlacement` reads
  // (`availW = opts.width − 2·pad`) — written once here rather than inside the
  // frame, because only a caller that owns a box knows there is one to fit to.
  const frame = vectorTypeFrame(font, cfg, t, { fitBoxWidth: Math.max(0, opts.width - 2 * (opts.padding ?? 0)) })
  const place = vtPlacement(frame, opts)
  const precision = opts.precision ?? 3
  const W = Math.max(1, opts.width)
  const H = Math.max(1, opts.height)
  // The em in output pixels, from the PLACEMENT — same line as `drawVectorType`,
  // so the cell box a mask is measured against cannot drift between the two.
  const em = place.scale * (frame.outlines.unitsPerEm || 1000)
  const glyphs = frame.outlines.glyphs
  const fps = frame.config.motion?.fps ?? 30

  // ── THE APPEARANCE STACK, BACK TO FRONT ─────────────────────────────────────
  //
  // `vtPaintLayers` — the SAME resolution `drawVectorType` draws from, including
  // the same drops (disabled, zero-opacity, a zero-width stroke, a `depth: 0`
  // extrude) and the same spent `VT_EXTRUDE_FRAME_BUDGET`. Task 2's
  // `vtBaseAppearance` collapse is gone from here too: it took the bottom-most
  // fill plus the bottom-most stroke and exported those, so a three-layer stack
  // exported as one layer and every extrude exported as nothing at all.
  //
  // ## The order is LAYER-MAJOR, and that is not cosmetic
  //
  // Shapes are emitted in the order SVG paints them, so this loop nests exactly
  // as the canvas loop does: a layer covers the WHOLE RUN before the next one
  // starts. Task 4 measured what glyph-major costs — an extrude has REACH, so
  // letter 2's block shadow lands on top of letter 1's finished face and 42 % of
  // the face is eaten at the default angle. A file with the letters bitten out of
  // it is not a rendering difference; it is the wrong artwork.
  const { layers } = vtPaintLayers(frame.config, glyphs.length)
  const motionOf = (i: number): VtGlyphMotion => frame.transforms[i] ?? IDENTITY_GLYPH_MOTION
  const advanceOf = (glyph: GlyphOutline): number => glyph.advance * place.scale
  // The WHOLE-RUN shear, from the same function `drawVectorType` hands to its
  // one `ctx.transform` — same config, same placement, same box. Resolved once
  // for the document, not once per glyph: it does not depend on `i`.
  const shear = vtRunShear(frame.config, frame.outlines, place, opts)
  /** Is any glyph in this run PLACED at an angle? Asked once for the document,
   *  because it decides how the `glyph` anchor is written — see `layerPaint`.
   *  `vtIsCurved` is the same question `vtRunCurve` answers with `null`, and the
   *  run-level `rotate` is folded in so the answer does not depend on which of
   *  the two put the letters at an angle. */
  const turned = vtIsCurved(frame.config) || place.rotate !== 0

  /**
   * ── DRAW-ON: the dash length per glyph ──────────────────────────────────────
   *
   * The longest contour of glyph `i`'s PLACED outline — the number
   * `vtDrawOnDash` measures progress against, and the one the canvas computes
   * from `placed[index]` in `drawVectorType`. Same function, same geometry, so
   * the two surfaces cannot come to two different dashes.
   *
   * LAZY and MEMOISED, in that order. Lazy because the placement pass costs a
   * transform per command and a document with no draw-on must not pay for one;
   * memoised because it is per GLYPH while the layer loop below is the outer one
   * — a stack with three drawing strokes would otherwise measure every letter
   * three times.
   */
  let placedForDash: VectorCommand[][] | null = null
  const dashLengths = new Map<number, number>()
  const glyphDrawLength = (i: number): number => {
    const hit = dashLengths.get(i)
    if (hit !== undefined) return hit
    if (!placedForDash) placedForDash = placeOutlines(frame.outlines, place)
    const len = pathLength(placedForDash[i]).longest
    dashLengths.set(i, len)
    return len
  }

  // ── THE FILL ────────────────────────────────────────────────────────────────
  // Gradients — both the multi-stop `Gradient` and the two-colour `Fill` form —
  // export as REAL paint servers, anchored the way the canvas anchors them:
  //
  //   glyph → `objectBoundingBox`, so each letter carries its own copy of the
  //           ramp over its own ink and it rides that letter's motion. SVG maps
  //           the unit square onto the glyph's bounds with the same independent
  //           x/y stretch `vtGlyphPaintBox` + the canvas resolver produce.
  //   word  → `userSpaceOnUse` over `vtRunPaintBox`, the run's ink.
  //   frame → `userSpaceOnUse` over the whole output box.
  //
  // The two user-space anchors need the glyph's own transform CANCELLED, or the
  // ramp travels with the letter and "the type moves over a fill that stays
  // put" is silently lost — every frame still looks like a gradient on a word.
  // The wrapper `<g>` that holds a clip or a filter still does NOT do this: those
  // are applied to the element carrying them, while `fill` is inherited and a
  // paint server resolves in the user space of the element actually PAINTED.
  // Measured, not assumed. The inverse matrix is what pins it.
  //
  // The four PROCEDURAL fills — `grid`, `checkerboard`, `stripes` and `qr` —
  // export as real `<pattern>` geometry, anchored the same three ways. A pattern
  // is always `userSpaceOnUse` (a tile sized as a fraction of each shape could
  // not say "square cells"), so the `glyph` anchor hands over the glyph's own
  // paint box in document units too — which is why `box` is passed on BOTH arms
  // below. That box is in the glyph's pre-motion coordinates, the same space the
  // path data is in, so the pattern rides the letter exactly as the canvas's
  // per-glyph paint space does.
  //
  // ── TIER 3, THE RASTER EMBED ────────────────────────────────────────────────
  // `ombre`, `noise` and `shader` have no vector form at any tier, so they are
  // rasterised over their own paint box and embedded as
  // `<pattern><image href="data:image/png…">` — see `rasteriseForExport`. One
  // embed for the whole run under `word`/`frame`, one PER LETTER under `glyph`
  // (each letter's box is its own, so one shared image would be the wrong
  // picture on five of six letters).
  //
  // ── WHAT STILL BRIDGES ──────────────────────────────────────────────────────
  // `paintPrimaryColor` remains as the LAST resort, and only that: it is reached
  // when there is no canvas to rasterise on at all (SSR, a worker, the unit test
  // environment) or the paint is a blob no arm recognises. In a browser all nine
  // fill types now export as a paint server, real `<pattern>` geometry, or a
  // declared raster — none of them as a silently flattened colour.
  //
  // ── AND ALL OF IT IS PER LAYER ──────────────────────────────────────────────
  // The anchor, the paint box, the raster embed and the flat fallback are the
  // LAYER's, not the config's — a word-anchored gradient fill under a
  // glyph-anchored stroke is two paint spaces in one document, which is the whole
  // point of the stack. `rasteriseForExport` opens one field span per layer that
  // needs one; a layer whose paint has a vector form asks for none.
  const shapes: VectorShape[] = []
  for (const L of layers) {
    const runBox = L.anchor === 'glyph'
      ? null
      : L.anchor === 'frame' ? vtFramePaintBox(opts) : vtRunPaintBox(frame.outlines, place, opts)
    const runRect = runBox ? paintBoxRect(runBox) : null
    // `paintIsVector` answers by KIND (it passes a unit box), so this is "has no
    // vector form", not "did not get one here".
    //
    // `isFill` is the other half of the gate and it is not belt-and-braces: only
    // a `Fill` ever reaches the arm that consumes a raster, and without it an
    // absent or unrecognised paint — which has no vector form either — would be
    // handed to the resolver, come back as `undefined`, and embed a canvas-default
    // BLACK rectangle in place of the flat fallback.
    const rasterBoxes: (VtPaintBox | null)[] = !isFill(L.paint) || paintIsVector(L.paint)
      ? []
      : runBox
        ? [runBox]
        // An ink-less glyph (a space) is dropped by the writer, so it gets no box
        // and costs no encode — its paint box would be the CELL fallback anyway.
        : glyphs.map(g => (g.commands.length ? vtGlyphPaintBox(g, place, em) : null))
    const rasters = rasteriseForExport(L.paint, rasterBoxes, opts, t, fps)
    const flatFill = paintPrimaryColor(L.paint, '#ffffff')
    // An EXTRUDE's shapes are NOT the glyph's outline — they are offset copies of
    // it, or one fused body — so SVG's own bounding box is the COPY's box rather
    // than the letter's, and `objectBoundingBox` would give every copy its own
    // private ramp aligned to itself. The canvas does the opposite: `pm` is built
    // once per (layer, glyph) from the GLYPH's ink box and every copy samples that
    // one paint space wherever it has been pushed to (Task 4's decision). So a
    // glyph-anchored extrude is written `userSpaceOnUse` over the glyph's box,
    // with NO `gradientTransform` — which resolves in the painted element's user
    // space and therefore still rides the letter's motion, exactly as `pm` does.
    const expanded = L.kind === 'extrude'
    const layerPaint = (glyph: GlyphOutline, i: number): VectorPaint => {
      if (runRect) {
        const elementTransform = glyphSvgMatrix(glyphPlacement(glyph, place), advanceOf(glyph), motionOf(i), shear, precision)
        return paintToVectorPaint(L.paint, {
          units: 'userSpaceOnUse',
          box: runRect,
          elementTransform,
          raster: rasters[0],
        }) ?? flatFill
      }
      const box = vtGlyphPaintBox(glyph, place, em)
      return paintToVectorPaint(L.paint, {
        // `objectBoundingBox` hands the BOX to the browser, which is a second
        // derivation of it — and it agreed with `vtGlyphPaintBox` only for as
        // long as a glyph's placed path had the same bounds as its font-space
        // bbox translated and scaled. TURN the glyph and the two part company:
        // the browser measures the rotated outline, the canvas measures the
        // corners of the unrotated box turned, and neither is wrong so much as
        // they are two answers. Measured at 76.7 % / 80.8 % of core ink
        // disagreeing at arc 150° / 330° — the only live break of this studio's
        // 0.0000 % guarantee.
        //
        // So a turned run stops delegating and writes `userSpaceOnUse` over the
        // box the canvas computed, which is exactly the move the EXTRUDE arm
        // already made one line up and for the same reason. Still no
        // `gradientTransform`: with nothing to cancel, a user-space server
        // resolves in the painted element's own user space and therefore still
        // rides that letter's motion, exactly as a bounding-box one does.
        //
        // A straight run keeps `objectBoundingBox` and every existing export is
        // byte-identical.
        units: expanded || turned ? 'userSpaceOnUse' : 'objectBoundingBox',
        aspect: box.w / box.h,
        box: paintBoxRect(box),
        raster: rasters[i],
      }) ?? flatFill
    }

    const stroking = L.kind === 'stroke'
    /**
     * This layer's DRAW-ON dash for glyph `i`, or `null` for "write no dash".
     *
     * Both halves are per glyph: the reference LENGTH (every letterform is a
     * different length) and the PROGRESS (`vtGlyphDrawProgress`, which folds in
     * the stagger). The canvas calls the same two functions on the same two
     * inputs, which is what makes the two surfaces agree by construction rather
     * than by inspection. `null` at full draw is why a fully-drawn stroke carries
     * no attribute and every export written before this feature is identical.
     */
    const dashFor = (i: number): VtDashSpec | null => {
      if (!stroking) return null
      const p = vtGlyphDrawProgress(cfg, L, t, i, glyphs.length)
      return p < 1 ? vtDrawOnDash(glyphDrawLength(i), p) : null
    }
    /**
     * The already-computed fused body for this layer's glyph `i`, or `null`.
     *
     * Hoisted out of `expand` because THREE options need the same answer and they
     * must not disagree: the expansion (one path or `depth`), the stroke colour
     * and the stroke width. A glyph whose union has not landed emits its copies
     * and must carry NO stroke — a layer-wide stroke would outline every one of
     * them, which is the per-copy picture this feature exists to avoid. Asking
     * once is what makes "stroked" and "fused" the same condition by construction.
     *
     * `opts.solid` is the only source here, deliberately: this writer is
     * synchronous and the union is async, so an export awaits `prepareSolidExtrudes`
     * and hands the map in (Task 6's boundary). No peek, no trigger.
     */
    const solidBodyFor = (i: number): readonly VectorCommand[] | null => {
      if (!L.solid || !L.id || !opts.solid) return null
      const body = opts.solid.get(vtSolidKey(L.id, i))
      return body && body.length ? body : null
    }
    shapes.push(...outlinesToShapes(frame.outlines, {
      ...place,
      // A stroke layer paints NO fill — `null` is the spine's explicit
      // `fill="none"`, and without it the letter would come out solid black under
      // its own outline.
      //
      // A stroke's paint is flattened to its primary COLOUR, which is a real
      // limitation and not a choice: `VectorShape.stroke` is `string | null`, so
      // the spine cannot reference a paint server from a stroke at all. A
      // gradient-stroked layer therefore exports as its `a` colour. Widening the
      // spine is a change to a studio-agnostic file with a second consumer coming;
      // it is named in the task report rather than made in passing.
      fill: stroking ? null : layerPaint,
      // The stroke is an ATTRIBUTE, not outlined into geometry: a designer opening
      // this can restyle or remove it, and the path still describes the letterform
      // rather than the letterform's outer contour.
      // ── AND THE EXTRUDE'S SILHOUETTE ─────────────────────────────────────────
      // The body already comes out as ONE `<path>` per glyph, so the silhouette
      // needs no new element and no change to the spine (`lib/vector/svg.ts`
      // already writes `stroke` + `stroke-width` alongside a `fill`): it is two
      // attributes on the path that is already there. Per glyph, and only where a
      // body exists — see `solidBodyFor`.
      stroke: stroking
        ? paintPrimaryColor(L.paint, '#000000')
        : L.outline ? (_g, i) => (solidBodyFor(i) ? L.outline!.color : null) : undefined,
      strokeWidth: stroking
        ? L.width
        : L.outline ? (_g, i) => (solidBodyFor(i) ? L.outline!.width : undefined) : undefined,
      // ── THE DRAW-ON, AS TWO REAL ATTRIBUTES ──────────────────────────────────
      // `stroke-dasharray` and `stroke-dashoffset`, on the path that is already
      // there — not a `<clipPath>`, not a mask, not the letterform outlined into
      // a partly-drawn shape. That distinction is the point of doing draw-on in
      // this studio at all: the file a designer opens still describes the
      // letterform, and the reveal is two attributes they can restyle, re-time
      // or delete.
      //
      // The units are the document's, which is the same space the `d` data is in
      // and the same space the canvas measures its dash in.
      dash: stroking ? (_g, i) => dashFor(i)?.dash ?? null : undefined,
      dashOffset: stroking ? (_g, i) => dashFor(i)?.offset : undefined,
      fillRule: 'nonzero',
      // The glyph's motion fade TIMES the layer's own opacity — multiplied, never
      // replaced, for the reason spelled out at `paintLayer`: they mean different
      // things and both have to survive.
      opacity: (_g, i) => clamp01(motionOf(i).opacity) * L.opacity,
      // BLUR. `stdDeviation` is in USER UNITS and the viewBox below is 1:1 with
      // the rendered size, so it is the same number of output pixels the canvas
      // blurs by — the canvas multiplies by `pixelRatio` because ITS radius is in
      // device pixels and ignores the CTM; an SVG has no device-pixel step to
      // compensate for. No factor of two: see `blurRadiusToStdDeviation`.
      blur: (_g, i) => blurRadiusToStdDeviation(motionOf(i).blur),
      // CLIP. Identical rect to the canvas's — literally the same function — and
      // it lands on a wrapper `<g>` with no transform, so the glyph's own
      // `transform` slides it THROUGH a stationary window.
      clip: (glyph, i) => {
        const tr = motionOf(i)
        if (!tr.clip || tr.clip.amount <= 0.001) return null
        return glyphCellClipRect(glyphPlacement(glyph, place), advanceOf(glyph), em, tr.clip)
      },
      attrs: (glyph, i) => {
        // Same two inputs the canvas loop uses for the pivot — the placed origin
        // and the cell's own advance — so neither renderer can drift into its own
        // idea of where a glyph turns.
        const transform = glyphSvgTransform(glyphPlacement(glyph, place), advanceOf(glyph), motionOf(i), shear, precision)
        const out: Record<string, string | number> = {}
        if (transform) out.transform = transform
        // The layer's BLEND, which had nowhere to go while the export was one
        // fill plus one stroke. `normal` writes nothing.
        if (L.blendCss !== 'normal') out.style = `mix-blend-mode:${L.blendCss}`
        return out
      },
      // ── K SHAPES PER GLYPH ────────────────────────────────────────────────
      // The whole of Task 6 in one option. A fill or a stroke layer expands to
      // nothing and emits the glyph's own single path, byte-identical to the
      // pre-stack export. An extrude expands to its `depth` offset copies —
      // through `extrudeCopyCommands`, the same function the boolean union
      // unites, never a second derivation of the step — or, when a caller has
      // awaited the union and handed the body in, to exactly ONE path holding the
      // whole block shadow.
      expand: expanded
        ? (commands, glyph, i) => {
            const body = solidBodyFor(i)
            if (body) return [[...body]]
            return extrudeCopyCommands(commands, L.copies ?? [], glyphPlacement(glyph, place), advanceOf(glyph))
          }
        : undefined,
    }))
  }

  const svg = shapesToSVG(shapes, {
    // The document is the OUTPUT BOX, not a crop of the ink — so the SVG frames
    // the composition exactly as the PNG does and the two can be swapped.
    width: W,
    height: H,
    viewBox: [0, 0, W, H],
    background: opts.background ?? null,
    precision,
    // Matches `ctx.lineJoin = 'round'` in drawVectorType — for the letterform
    // stroke AND for the extrude's silhouette, which has more sharp joins than a
    // letterform does (every step between two copies is a corner). SVG's default
    // is `miter`, so a document that omitted this would export spikes the preview
    // does not show.
    //
    // Asked of the SHAPES rather than of the layers, because an extrude's outline
    // is decided PER GLYPH: a layer that wants one but whose union has not landed
    // emits copies and no stroke at all, and a document with nothing stroked must
    // not carry the attribute.
    ...(shapes.some(s => typeof s.stroke === 'string' && s.stroke !== '')
      ? { groupAttrs: { 'stroke-linejoin': 'round' } }
      : {}),
  })

  return { svg, frame }
}

/** A filesystem-safe stem for an export, derived from the text being set. */
export function vtExportName(cfg: VectorTypeConfig | null | undefined): string {
  const slug = String(cfg?.text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug || 'vector-type'
}

/**
 * True when this config has something that MOVES — i.e. a preview loop is worth
 * running, and the frame source should report a real duration.
 *
 * TWO sources now, and both must count. This gated on `tracks.length > 0` alone
 * until presets arrived, which would have made every preset-only config render
 * FROZEN: the surface and the node card would draw a single frame, the frame
 * source would report `duration: 0`, and nothing would error. A picked preset
 * that visibly does nothing reads as "this feature is broken", so the widening
 * ships in the same commit as the evaluator.
 *
 * Stagger alone still is not motion: it shifts a clock nothing is reading.
 *
 * THREE sources as of the fills work, and the third is not a nicety. A LIVE
 * shader fill (`speed !== 0`) animates on its own clock with the type standing
 * perfectly still, so without it here a shader-filled config renders exactly one
 * frame — and worse, `resolveField` returns `null` until the effect catalog has
 * landed, so that one frame is the graceful fallback (the shader's flat input
 * paint) and NOTHING ever re-renders to replace it. The self-heal in
 * `lib/shaderfill/field.ts` is explicitly "callers that re-invoke `resolveField`
 * every frame get it for free"; this is what makes Vector Type one of them.
 * Mirrors the Compositor's `hasAnimatedShaderFill`, including why `speed: 0` must
 * NOT count: a deliberately frozen field would otherwise be impossible to
 * express, and every still node on the canvas would spin a loop forever.
 *
 * FOUR as of blink, and it has the shader fill's failure mode exactly: a blink
 * with no track and no preset is motion with nothing else moving, so without
 * this line the surface would draw one frame, the frame source would report
 * `duration: 0`, and the user would see a word that never blinks with no error
 * anywhere. `vtBlinkActive` is the same gate the evaluator takes, so a blink
 * switched off (`amount: 0`, the shipped default) does not spin a still node.
 *
 * FIVE as of the axis scatter, and it is the same line again for the same
 * reason: a scatter with no track and no preset is motion with nothing else
 * moving, and both its modes genuinely move — a `settle` resolves over its own
 * seconds, a `wander` never stops. `vtScatterActive` is the gate the evaluator
 * takes, so `spread: 0` (the shipped default) does not spin a still node.
 */
export function vtIsAnimated(cfg: VectorTypeConfig | null | undefined): boolean {
  const tracks = cfg?.motion?.tracks
  if (Array.isArray(tracks) && tracks.length > 0) return true
  if (vtHasPreset(cfg)) return true
  if (vtBlinkActive(cfg?.motion?.blink)) return true
  if (vtScatterActive(cfg?.motion?.scatter)) return true
  // ═══ TASK 3 BRIDGE ═══ any layer with a moving shader fill animates the node,
  // so this folds over the whole stack rather than asking the base layer only —
  // getting that wrong freezes a node card that should be playing.
  const layers = Array.isArray(cfg?.appearance) ? cfg.appearance : []
  const paints: (Paint | undefined)[] = layers.length
    ? layers.map(l => l?.paint)
    : [vtBaseAppearance(cfg).fill]
  return paints.some(p => isFill(p) && fillIsShader(p) && p.shader.speed !== 0)
}
