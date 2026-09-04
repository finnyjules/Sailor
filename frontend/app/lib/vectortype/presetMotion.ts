/**
 * Vector Type Studio — the shared motion engine, adapted to glyphs. PURE.
 *
 * `./motion.ts` animates the CONFIG (tracks over dotted paths, on a per-glyph
 * clock). This module animates the same glyphs from the OTHER motion source: the
 * Compositor's kinetic preset engine (`~/lib/motion/evaluate`), so Vector Type
 * gets Fade / Slide / Mask / Grow / Blur without a second evaluator — plus the
 * variable-AXIS presets in `./axisPresets.ts`, which cannot live in the shared
 * engine because their values are fractions of the loaded font's own axis
 * ranges. Both tables are dispatched from `unitStateFor` below, on one clock.
 *
 * The two sources are complementary and BOTH ACTIVE AT ONCE. A user with a
 * Slide-Up preset and an `axes.wght` track must see the word slide in *and* the
 * weight wave travel. `vtGlyphMotion` is the one place they meet.
 *
 * ## Three things this file exists to get right
 *
 * ### 1. The coordinate spaces differ — multiply by the em
 *
 * `UnitState.dx/dy/blur` are in UNIT-BOX HEIGHTS (a normalised space: 1 = the
 * height of the animated unit's own box). `VtGlyphTransform.dx/dy` are OUTPUT
 * PIXELS, because that is what `render.ts` places glyphs in and what
 * `drawVectorType` feeds to `ctx.translate`.
 *
 * Vector Type's unit box is the EM, whose height in output pixels is exactly
 * `config.size` (that is the control's definition — CSS `font-size` semantics,
 * `scale = size / unitsPerEm`). So every spatial quantity crossing this boundary
 * is multiplied by `size`.
 *
 * Forget it and a preset looks *almost right at one font size* and wrong at
 * every other, which is why the tests pin it at two sizes rather than one:
 * a missing multiply is invisible in a single-size test.
 *
 * The em is read at the RUN clock, not the glyph's — `size` is itself animatable,
 * and `vtPlacement` scales the whole run by `applyMotion(cfg, t).size`. Using a
 * per-glyph em here would make the offsets disagree with the geometry they move.
 *
 * ### 2. There is only ONE stagger, and it is Vector Type's
 *
 * `LayerAnimSpec.stagger` (seconds between units, inside `evaluateAnimation`) and
 * `motion.stagger` (delay + order + seed, feeding `glyphTime`) are two spellings
 * of the same idea. Two live stagger sources would fight — the engine's is
 * forward-only and defaults to 0.04 even when absent, so a user who set `order:
 * 'edges'` would get an edges wave with a forward wave underneath it.
 *
 * So: **`motion.stagger` wins, always.** The engine is driven at the glyph's own
 * `glyphTime()` clock with the spec's `stagger` forced to 0, which makes the
 * engine's own offset structurally inert rather than merely unused.
 * `mergeConfig` does not even store `stagger` for the same reason.
 *
 * The glyph's real `i`/`n` are still passed through, because seeded presets
 * (`glitch-in`, `wiggle`) key their randomness on the unit index — collapsing
 * that to `n = 1` would give every letter identical jitter.
 *
 * ### 3. Presets and tracks ADD; they never overwrite
 *
 * The previous plan shipped a bug of exactly this shape (a Collection sweep and a
 * motion track wrote the same path; `applyMotion` overwrote the sweep, and five
 * identical baked PNGs looked perfectly fine). Here the rule is spelled out and
 * tested: **offsets and rotation add, scale and opacity multiply.** Both operands
 * are identity-at-rest (0 / 1), so a config with only one source is bit-identical
 * to what that source produced alone.
 */
import type { LayerAnimSpec } from '~/lib/motion/types'
import type { PresetCapability, UnitState } from '~/lib/motion/evaluate'
import {
  ALL_PRESET_CAPABILITIES,
  evaluatePresetUnit,
  presetIdsFor,
  presetNeedsStagger,
} from '~/lib/motion/evaluate'
// The shared moves core: any number of moves live now, each its own
// `at`/`loop`/`bounce` window — see `presetTransform`'s header note below.
// `movePhase`/`moveWindows` replace this file's old `vtSlotPhase` (removed —
// it had no callers left once `presetTransform` switched to `movePhase`);
// `mergeEase` gives a raw/untrusted move a well-formed ease the same way
// `mergeTrack` gives one to a raw track, and `easeToEngineName` is how a
// move's ease reaches `vtPresetSpecs`'s engine-shaped `LayerAnimSpec.ease`
// string.
import { movePhase, moveWindows } from '~/lib/studio/moves/phase'
import { mergeEase, easeToEngineName } from '~/lib/studio/moves/ease'
import { moveTracks, trackValueAt } from '~/lib/studio/moves/tracks'
// TYPE-ONLY against ./font.ts (it loads fontkit at module scope); ./axisPresets
// is deliberately type-only against it too, so this stays a light import.
import type { VtAxis } from './font'
import {
  VT_EVAL,
  vtAxisDelta,
  vtAxisOffersFor,
  vtAxisPreset,
  vtAxisPresetIdsFor,
  type VtAxisOffer,
} from './axisPresets'
import {
  DEFAULT_CONFIG,
  DEFAULT_MOTION,
  VT_PRESET_DURATIONS,
  VT_PRESET_SLOTS,
  type VectorTypeConfig,
  type VtMove,
  type VtPresetSlot,
} from './config'
import {
  IDENTITY_GLYPH_TRANSFORM,
  glyphTime,
  glyphTransform,
  resolveStagger,
  type VtGlyphTransform,
} from './motion'
// The THIRD motion source (Task 3). Pure arithmetic over `./random`, so it costs
// this module nothing beyond the call.
import {
  vtBlinkActive,
  vtBlinkOpacity,
  vtBlinkUnitIndex,
  vtResolveBlink,
} from './blink'
// The FOURTH motion source (Task 4). Pure arithmetic over `./random` and the
// font's declared axis ranges, so it costs this module nothing beyond the call.
import {
  vtResolveScatter,
  vtScatterActive,
  vtScatterDelta,
  vtScatterStillTime,
} from './scatter'

/** A one-sided reveal of the glyph's own box: `amount` is the fraction hidden
 *  from `side`. Structurally `UnitState['clip']`, restated as a named type
 *  because it is part of this module's published output. */
export interface VtGlyphClip {
  side: 'top' | 'bottom' | 'left' | 'right'
  amount: number
}

/**
 * THE OUTPUT SHAPE. Everything one glyph's motion produces at one instant.
 *
 * A superset of `VtGlyphTransform`, so anything already reading `dx/dy/scale/
 * rotate/opacity` off `VtFrame.transforms` keeps working untouched, and the new
 * fields ride along for the renderer that learns to consume them.
 *
 * Units, spelled out because the whole point of this module is the conversion:
 *
 * | field            | unit                              | rest  |
 * |------------------|-----------------------------------|-------|
 * | `dx`, `dy`       | OUTPUT PIXELS (y-DOWN, like canvas), along the GLYPH'S OWN axes — `dy` is a baseline shift, so on an arc'd run it moves the letter off its own baseline rather than down the screen (`vtGlyphOffset`). Identical on a straight run. | 0   |
 * | `scale`          | multiplier, uniform               | 1     |
 * | `scaleX`,`scaleY`| extra per-axis multipliers (flips) | 1     |
 * | `rotate`         | degrees, clockwise                | 0     |
 * | `opacity`        | 0..1 multiplier                   | 1     |
 * | `blur`           | OUTPUT PIXELS of blur radius      | 0     |
 * | `clip`           | fraction of the glyph box hidden  | null  |
 * | `axes`           | variable-font axis DELTAS by tag  | `{}`  |
 *
 * `blur`, `clip`, `scaleX/scaleY` and `axes` are PRODUCED here and consumed by
 * the canvas/SVG renderers in later tasks. They are always present (0 / null /
 * `{}` at rest) so a consumer never has to distinguish "absent" from "neutral".
 */
export interface VtGlyphMotion extends VtGlyphTransform {
  scaleX: number
  scaleY: number
  /** Blur radius in OUTPUT PIXELS (the engine's unit-box value × em). */
  blur: number
  clip: VtGlyphClip | null
  /** Axis DELTAS by OpenType tag, to be ADDED to the glyph's resting axis
   *  positions (`{ wght: -300 }` = 300 lighter than the config says). Empty at
   *  rest. Deltas, not absolutes, so an axis preset composes with whatever the
   *  user set and with an axis track. */
  axes: Record<string, number>
}

export const IDENTITY_GLYPH_MOTION: Readonly<VtGlyphMotion> = Object.freeze({
  ...IDENTITY_GLYPH_TRANSFORM,
  scaleX: 1,
  scaleY: 1,
  blur: 0,
  clip: null,
  axes: Object.freeze({}) as Record<string, number>,
})

const CLIP_SIDES = ['top', 'bottom', 'left', 'right'] as const

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const fin = (v: unknown, d: number): number => (isNum(v) ? v : d)
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * What this studio can draw, in the engine's own vocabulary.
 *
 * `drawVectorType` applies `blur`, `clip`, `scaleX/scaleY` and per-glyph `axes`
 * to real outlines, so Vector Type takes everything the engine offers EXCEPT
 * `copies`: a copy is an extra whole-unit draw, and `VtGlyphMotion` has no field
 * for one. Subtracted from `ALL_PRESET_CAPABILITIES` rather than re-typed, so a
 * capability added to the engine arrives here automatically and only the one
 * genuine gap is stated.
 *
 * ONE list, and everything reads it: `KNOWN_IDS` below (what a stored config may
 * name), `vtPresetIdsFor` (what the gallery offers) and the surface's
 * `:capabilities` prop (what the tiles are allowed to draw). Before this the
 * gallery filtered copy-based presets through a private set inside
 * `MotionPresetPicker` while `vtKnowsPreset` accepted them — so an imported
 * config reported "animated" over a frozen word.
 */
export const VT_PRESET_CAPABILITIES: readonly PresetCapability[] =
  Object.freeze(ALL_PRESET_CAPABILITIES.filter(c => c !== 'copies'))

/**
 * The preset ids this studio can render faithfully.
 *
 * UNION with `./axisPresets`, whose table is Vector-Type-only for a structural
 * reason: an axis preset's values are fractions of the LOADED FONT'S range, and
 * the shared engine does not know which font is loaded (see that module's
 * header). Both halves are derived — nothing here is hand-listed.
 */
const KNOWN_IDS: Record<VtPresetSlot, ReadonlySet<string>> = {
  in: new Set([...presetIdsFor('in', VT_PRESET_CAPABILITIES), ...Object.keys(VT_EVAL.in)]),
  out: new Set([...presetIdsFor('out', VT_PRESET_CAPABILITIES), ...Object.keys(VT_EVAL.out)]),
  loop: new Set([...presetIdsFor('loop', VT_PRESET_CAPABILITIES), ...Object.keys(VT_EVAL.loop)]),
}

/** True when SOME table — the engine's or this studio's — has a preset by that
 *  id for that slot. Font-independent on purpose: `vtHasPreset`/`vtIsAnimated`
 *  run against a raw stored blob with no font loaded, so "do we know this id"
 *  and "can this font run it" have to stay separate questions. The second is
 *  `vtAxisAvailability`'s. */
export function vtKnowsPreset(slot: VtPresetSlot, presetId: unknown): boolean {
  return typeof presetId === 'string' && KNOWN_IDS[slot].has(presetId.trim())
}

/**
 * WHICH slot's table a preset id belongs to — the at/loop model's
 * replacement for the retired `Move.phase`. A `kind: 'preset'` move no
 * longer carries a stored phase (`~/lib/studio/moves/types`'s `Move` has
 * `at`/`loop`/`bounce`, not `phase`/`play`), so anything that used to read
 * `mv.phase` to pick the right table — `evaluatePresetUnit`'s own `slot`
 * argument, `vtAxisPreset`'s `slot` — now looks the id up here instead.
 *
 * Total by construction: every kinetic id lives in exactly ONE of
 * `IN_EVAL`/`OUT_EVAL`/`LOOP_EVAL` (`~/lib/motion/evaluate.ts`'s own tables
 * are disjoint by id — `fade-in` vs `fade-out`, never both), and every axis
 * preset declares exactly one `VtAxisPreset.slot` (`axisPresets.ts`), so
 * `KNOWN_IDS`'s three sets never overlap and this never has to pick between
 * two true answers. `null` for an id neither table knows (dropped, same as
 * `vtKnowsPreset` returning false for every slot).
 */
export function vtPresetSlotOf(presetId: unknown): VtPresetSlot | null {
  if (typeof presetId !== 'string') return null
  const id = presetId.trim()
  for (const slot of VT_PRESET_SLOTS) if (KNOWN_IDS[slot].has(id)) return slot
  return null
}

/**
 * Everything a picker should offer for a slot, given the loaded font's axes.
 *
 * The engine's capability-gated ids (renderable by anything Vector Type draws)
 * plus the axis presets this font can actually run. Task 9's gallery calls this
 * for the ids and `vtAxisOffersFor` for the greyed-out tiles and their reasons —
 * it never assembles a list of its own.
 */
export function vtPresetIdsFor(slot: VtPresetSlot, axes?: readonly VtAxis[] | null): string[] {
  return [...presetIdsFor(slot, VT_PRESET_CAPABILITIES), ...vtAxisPresetIdsFor(slot, axes)]
}

/** The axis tiles for a slot, available ones and unavailable ones with their
 *  reasons. Re-exported here so a surface has ONE import for its preset menu. */
export function vtAxisOffers(
  slot: VtPresetSlot,
  axes?: readonly VtAxis[] | null,
  fontLabel?: string,
): VtAxisOffer[] {
  return vtAxisOffersFor(slot, axes, fontLabel)
}

/**
 * The slots that will actually animate, from a config of any vintage.
 *
 * Defensive for the reason `./motion.ts` is: only the editor surface holds a
 * `mergeConfig`-ed ref — the node card, the baker and the frame source read
 * `properties.sailor_vectorType` as parsed JSON. So a `motion` that is missing, a
 * string, or an array must behave as "no presets" rather than throw.
 *
 * An id the engine does not have is DROPPED here rather than passed on:
 * `evaluateAnimation` silently substitutes `fade-in`/`fade-out` for an unknown
 * id, so forwarding it would show the user a fade they never asked for.
 */
/**
 * Every LIVE `kind: 'preset'` move (any number per phase, N total), read off
 * `cfg.motion.moves` — the one place both `presetTransform` and the helpers
 * below get their moves from, so they can never disagree about which ones
 * exist.
 *
 * Tolerant of a config straight out of storage for the same reason every
 * other reader in this file is (see the module header, trap "the defensive
 * contract"): `motion`, `motion.moves`, and any one entry may be anything at
 * all. A move whose `kind` isn't `'preset'`, whose `phase` isn't one of the
 * three, or whose `presetId` names nothing this studio's engine tables (the
 * kinetic catalog OR the axis-preset table) knows about is DROPPED, not
 * defaulted — same rule the old per-slot reader followed ("KEEPS an unknown
 * preset id — and refuses to animate it").
 *
 * `ease`/`play` are run through `mergeEase`/`mergePlay` here rather than
 * trusted, so a raw move missing either (or carrying garbage) still gets a
 * well-formed one — the same "nothing is trusted" rule `mergeTrack` follows
 * for a raw track.
 *
 * NO `moves` KEY AT ALL falls back to `legacySlotMoves` below — a raw blob
 * that has never been through `mergeConfig` (the node card, the baker, the
 * frame source all read `properties.sailor_vectorType` straight off storage,
 * per the module header) may still carry the pre-moves `in`/`out`/`loop`
 * slots, and this is the one place both `presetTransform` and every helper
 * below reads its moves from — so THIS function has to speak both vintages,
 * not `mergeConfig` alone. An EMPTY `moves: []` is not this case (that is a
 * config that legitimately has no presets) — only a MISSING key falls
 * through, exactly `mergeMotion`'s own `hasNewShape` test.
 *
 * A raw entry is validated against the at/loop model directly (`at`/
 * `duration`/`loop`/`bounce`), not the retired `phase`/`play` — `vtMove.kind
 * === 'preset'` and a `presetId` `vtPresetSlotOf` recognises (in SOME
 * table — which one is resolved per-move, at fold time, by `presetTransform`
 * itself, not stored here) are what makes an entry usable.
 */
function presetMoves(cfg: VectorTypeConfig | null | undefined): VtMove[] {
  const motion = cfg?.motion as { moves?: unknown } & Record<string, unknown> | undefined
  const raw = motion?.moves
  if (!Array.isArray(raw)) return legacySlotMoves(motion)
  const out: VtMove[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const m = entry as Record<string, unknown>
    if (m.kind !== 'preset') continue
    if (!vtPresetSlotOf(m.presetId)) continue
    out.push({
      id: typeof m.id === 'string' && m.id ? m.id : `move-${out.length}`,
      kind: 'preset',
      presetId: (m.presetId as string).trim(),
      at: Math.max(0, fin(m.at, 0)),
      duration: Math.max(0.05, fin(m.duration, 0.8)),
      loop: m.loop === true,
      ease: mergeEase(m.ease),
      ...(m.bounce === true ? { bounce: true } : {}),
      ...(m.params && typeof m.params === 'object' && !Array.isArray(m.params)
        ? { params: m.params as Record<string, number> }
        : {}),
    })
  }
  return out
}

/**
 * The pre-moves `in`/`out`/`loop` slots → one `preset` move per populated
 * slot, KEPT CHEAP — this runs on the defensive runtime path above, possibly
 * once per glyph per frame, so it is deliberately NOT `mergeConfig`'s own
 * old-shape migration (`mergeMotion`'s `hasOldShape` branch), which looks up
 * each preset's NATIVE ease for on-load render parity and is meant to run
 * ONCE. `ease: 'none'` here instead — the same neutral default the moves
 * gallery hands a freshly-picked preset before the user ever touches the
 * Ease dial — which is exact at both window boundaries (every ease function
 * agrees that 0 maps to 0 and 1 to 1) and only differs from the native ease
 * at an intermediate frame, which nothing on this defensive path promises.
 * Once a document is actually opened in the editor, `mergeConfig` runs and
 * this fallback never fires again for it.
 *
 * Placement follows the SAME rule `config.ts`'s real `mergeMotion` old-shape
 * conversion uses (`~/lib/studio/moves/merge`'s `resolvePlacement`, restated
 * here rather than imported so this stays the cheap, allocation-light path
 * its own doc promises): `in` -> `at: 0`; `loop` -> `at: longestIn` (the
 * `in` slot's own duration, found first since `VT_PRESET_SLOTS` visits `in`
 * before `loop`); `out` -> `at: max(longestIn, clip - duration)`, with
 * `duration` compressed to fit. `loop: slot === 'loop'` — this cheap path
 * skips `play.mode === 'repeat'` (the old slot schema never wrote a `play`
 * at all, so there is nothing to read) and `bounce` (no pre-moves slot was
 * ever a ping-pong).
 */
function legacySlotMoves(motion: Record<string, unknown> | undefined): VtMove[] {
  const out: VtMove[] = []
  const clip = Math.max(0.001, fin(motion?.duration, DEFAULT_MOTION.duration))
  let longestIn = 0
  for (const slot of VT_PRESET_SLOTS) {
    const rawSlot = motion?.[slot]
    if (!rawSlot || typeof rawSlot !== 'object' || Array.isArray(rawSlot)) continue
    const so = rawSlot as Record<string, unknown>
    const presetId = typeof so.presetId === 'string' ? so.presetId.trim() : ''
    if (!presetId || !vtKnowsPreset(slot, presetId)) continue
    const rawDuration = Math.max(0.05, fin(so.duration, VT_PRESET_DURATIONS[slot]))
    let at = 0
    let duration = rawDuration
    if (slot === 'in') { at = 0; longestIn = Math.max(longestIn, rawDuration) }
    else if (slot === 'loop') { at = longestIn }
    else { at = Math.max(longestIn, clip - rawDuration); duration = Math.max(0.05, clip - at) }
    out.push({
      id: `legacy-${slot}`,
      kind: 'preset',
      presetId,
      at,
      duration,
      loop: slot === 'loop',
      ease: { kind: 'named', name: 'none' },
      ...(so.params && typeof so.params === 'object' && !Array.isArray(so.params)
        ? { params: so.params as Record<string, number> }
        : {}),
    })
  }
  return out
}

/**
 * The slots that will actually animate, from a config of any vintage.
 *
 * A REPRESENTATIVE view, not an exhaustive one: `LayerAnimSpec` (the shared
 * kinetic engine's own shape) has room for exactly one spec per slot, so with
 * several `preset` moves sharing a phase — the whole point of the N-move
 * redesign — this reports the FIRST live one per phase. `presetTransform`
 * below is the exhaustive reader (it folds every one of them); this function
 * remains for callers that only ever need "is there a preset in this slot,
 * and roughly what" — `vtStillTime`, `vtStaggerStarvedMoves`, the axis-preset
 * gallery's still-thumbnail and `MotionPresetPicker`'s "currently picked"
 * pill — none of which yet knows how to show more than one.
 *
 * Defensive for the reason `./motion.ts` is: only the editor surface holds a
 * `mergeConfig`-ed ref — the node card, the baker and the frame source read
 * `properties.sailor_vectorType` as parsed JSON. So a `motion` that is missing, a
 * string, or an array must behave as "no presets" rather than throw.
 *
 * An id the engine does not have is DROPPED here rather than passed on:
 * `evaluateAnimation` silently substitutes `fade-in`/`fade-out` for an unknown
 * id, so forwarding it would show the user a fade they never asked for.
 */
export function vtPresetSpecs(cfg: VectorTypeConfig | null | undefined): Partial<Record<VtPresetSlot, LayerAnimSpec>> {
  const out: Partial<Record<VtPresetSlot, LayerAnimSpec>> = {}
  for (const mv of presetMoves(cfg)) {
    const slot = vtPresetSlotOf(mv.presetId)
    if (!slot || out[slot]) continue
    out[slot] = {
      presetId: mv.presetId!,
      duration: mv.duration,
      // See the header: the engine's own stagger is forced off so `motion.stagger`
      // is the single source. Not "left absent" — absent means 0.04.
      stagger: 0,
      ease: easeToEngineName(mv.ease),
      ...(mv.params ? { params: mv.params } : {}),
    }
  }
  return out
}

/**
 * The stagger a typing preset needs to type, in seconds between glyphs.
 *
 * Small on purpose: at 6 glyphs it spreads the entrance over 0.30 s, which reads
 * as typing without making the entrance feel slower than the duration the user
 * set. It is a STARTING POINT, not a lock — the Stagger slider owns it from the
 * moment it is applied.
 */
export const VT_TYPING_STAGGER = 0.06

/**
 * The delay to adopt when a stagger-dependent preset is picked, or null to leave
 * `motion.stagger.delay` alone.
 *
 * WHY A BUMP RATHER THAN HIDING THE TILE. `typewriter` works perfectly here at
 * any non-zero delay (Task 10 measured it typing at 0.15); it is only the
 * shipped DEFAULT of 0 that makes it inert. Hiding it would delete a working —
 * and, in a type studio, conspicuously expected — preset to dodge a default.
 * Task 4's single-stagger rule is untouched: this moves Vector Type's own
 * stagger, the one source there is, and does not resurrect the engine's.
 *
 * The change must be VISIBLE, and it is, in three places: the Stagger slider in
 * the Motion section moves, the surface writes it through the same `setControl`
 * path a user drag takes (so it is an ordinary undoable edit, not a hidden
 * mutation), and the Presets section says what it did.
 *
 * Null whenever the user already has a stagger — their value is never
 * overwritten — and null for every preset that does not need one, so picking
 * `appear` (the same step function, but doing exactly what its label promises)
 * has no side effect on a setting that is global across slots and tracks.
 */
export function vtStaggerBumpFor(presetId: unknown, currentDelay: unknown): number | null {
  if (!presetNeedsStagger(presetId)) return null
  return isNum(currentDelay) && currentDelay > 0 ? null : VT_TYPING_STAGGER
}

/**
 * Every live `kind: 'preset'` MOVE that CANNOT express itself at the config's
 * stored stagger — i.e. a tile that is silently doing nothing. Returns moves,
 * not slots: several `preset` moves can share one phase now, and each is its
 * own tile in the gallery, so the caller (`VectorTypeSurface.vue`) only ever
 * needed the count (`.length`) — a slot-shaped answer would have hidden a
 * second starved move sharing a phase with a healthy one.
 *
 * The bump above covers the moment of picking. This covers everything else: a
 * config imported from JSON, an agent-written one, or a user who dragged Stagger
 * back to 0 afterwards. The surface renders it as a warning next to the slot, so
 * "the preview is frozen and I do not know why" is never the user's problem to
 * work out.
 */
export function vtStaggerStarvedMoves(cfg: VectorTypeConfig | null | undefined): VtMove[] {
  const { delay } = resolveStagger(cfg as VectorTypeConfig)
  if (isNum(delay) && delay > 0) return []
  return presetMoves(cfg).filter(mv => presetNeedsStagger(mv.presetId))
}

/** True when any slot names a preset the engine can actually run. The `?` in
 *  `vtIsAnimated`'s widening (trap 2: a preset-only config used to report
 *  "not animated" and render frozen). */
export function vtHasPreset(cfg: VectorTypeConfig | null | undefined): boolean {
  return presetMoves(cfg).length > 0
}

/** Clip length in seconds, however the blob spells it. */
function clipDuration(cfg: VectorTypeConfig | null | undefined): number {
  return Math.max(0.001, fin(cfg?.motion?.duration, DEFAULT_MOTION.duration))
}

/**
 * The em height in OUTPUT PIXELS at run time `t` — the number every spatial
 * conversion in this file goes through.
 *
 * `size` is animatable, so this is not simply `cfg.size`: it is `cfg.size` as a
 * `size` track would have written it. Evaluated directly from the tracks rather
 * than via `applyMotion` so that resolving one number does not clone the config
 * once per glyph per frame.
 */
export function vtEmSize(cfg: VectorTypeConfig | null | undefined, t: number): number {
  let em = fin(cfg?.size, DEFAULT_CONFIG.size)
  const tracks = moveTracks(cfg?.motion)
  if (tracks.length) {
    const d = clipDuration(cfg)
    for (const tr of tracks) {
      if (!tr || typeof tr !== 'object' || tr.path?.trim?.() !== 'size') continue
      if (!isNum(tr.from) || !isNum(tr.to)) continue
      em = trackValueAt(tr, t, d)
    }
  }
  return isNum(em) ? em : DEFAULT_CONFIG.size
}

/**
 * The instant a SINGLE still frame should be sampled at — 0 for a config with no
 * entrance, the moment the entrance has finished for one that has.
 *
 * The still bakes (the render cascade's PNG, the Collection param baker) render
 * `t = 0`. An entrance preset's whole point is that `t = 0` is FULLY OUT, so with
 * presets live those bakes would produce a blank or half-formed PNG and nothing
 * would error — the exact failure mode this plan keeps finding. A track could do
 * this too (`glyph.opacity` 0→1), but a preset does it by default, so the still
 * time has to be derived rather than assumed.
 *
 * The word is at rest one in-duration after the LAST glyph starts, i.e. after the
 * whole stagger queue has run. Capped at the exit's start (and at the clip) so a
 * clip too short to hold a resting frame gives the latest one that is not already
 * leaving, rather than a frame past the end.
 *
 * A SETTLING SCATTER is an entrance too, and it is counted here for exactly the
 * same reason (`vtScatterStillTime`). Its `t = 0` is the MOST scattered frame
 * there is, so without this line a config whose only motion is a settle would
 * bake its PNG, its node thumbnail and every Collection row at maximum scatter —
 * the panel reading `Weight 400` over a picture with nine weights in it, and
 * nothing erroring. A `wander` contributes 0, correctly: it never finishes, and
 * its `t = 0` already IS the configured word.
 */
export function vtStillTime(cfg: VectorTypeConfig | null | undefined): number {
  const moves = presetMoves(cfg)
  const settle = vtScatterStillTime(cfg)
  if (!moves.length && !(settle > 0)) return 0
  const duration = clipDuration(cfg)
  // `moveWindows` gives, per move, the `[start,end]` window it lives in — an
  // Out move's `start` is exactly `outStart` used to be, computed per-move by
  // the SAME shared rule `presetTransform` composes with, so this cannot
  // drift out of step with what actually renders. Which moves are In/Out is
  // no longer stored on the move itself (`Move` dropped `phase`) — resolved
  // here the same way `presetTransform` resolves it, from the preset id's
  // own table (`vtPresetSlotOf`). The LATEST In window's END across every In
  // move generalises the old single `specs.in.duration` (an In move's `end`
  // is `at + duration`, and every In move this studio itself ever places
  // starts at `at: 0` — see `legacySlotMoves`/`config.ts`'s migration — so
  // this equals the old value there and generalises correctly for any other
  // placement). The EARLIEST out window across every Out move is the one
  // that first starts hiding the word.
  const windows = moveWindows(moves, duration)
  const longestIn = windows
    .filter(w => vtPresetSlotOf(w.move.presetId) === 'in')
    .reduce((max, w) => Math.max(max, w.end), 0)
  const glyphs = Math.max(1, [...String(cfg?.text ?? '')].length)
  const { delay } = resolveStagger(cfg as VectorTypeConfig)
  const rest = Math.max(longestIn, settle) + delay * (glyphs - 1)
  const outStarts = windows.filter(w => vtPresetSlotOf(w.move.presetId) === 'out').map(w => w.start)
  const outStart = outStarts.length ? Math.min(...outStarts) : duration
  return Math.max(0, Math.min(rest, outStart, duration - 1e-6))
}

/**
 * The environment an AXIS preset needs and the engine cannot supply: the loaded
 * font's real axis ranges, and where this glyph currently rests on them.
 *
 * Optional everywhere. Omit it and axis presets emit nothing at all — the
 * honest answer before a font has loaded, and the same rule `animatableTargets`
 * follows when it is handed no axes.
 */
export interface VtGlyphEnv {
  /** The loaded font's declared axes (`VtFont.axes`). */
  axes: readonly VtAxis[]
  /** This glyph's resting axis values — the config's `axes` as an axis TRACK
   *  would have written them at this glyph's clock. Defaults to `cfg.axes`. */
  resting?: Record<string, number> | null
  /**
   * Which WORD each glyph of the run belongs to — `wordIndexOfGlyph` over the
   * shaped run, index-aligned with it, `VT_NO_WORD` (`-1`) for a separator.
   *
   * Needed only by `unit: 'word'` blink, and needed from OUT HERE for the reason
   * the whole `words.ts` module takes a glyph run rather than a string: a
   * ligature makes glyph indices and character indices disagree, so the grouping
   * cannot be recovered from `cfg.text` and an index. `vectorTypeFrame` has the
   * shaped run and computes it once per frame.
   *
   * Omit it and word blink is INERT — never a silent fallback to letter blink.
   * See `vtBlinkUnitIndex`.
   */
  wordOf?: readonly number[] | null
}

/** @deprecated The env is no longer axis-only — it also carries the run's word
 *  grouping. Kept as an alias so existing importers compile unchanged. */
export type VtAxisEnv = VtGlyphEnv

/**
 * Fold one engine `UnitState` (already at its move's own eased progress) INTO
 * the running accumulator, by the composition rule every doc comment in this
 * file states and this is now the one place that applies it:
 *
 *   dx, dy, rotate, blur   ADD      (identity 0)
 *   scale, scaleX, scaleY  MULTIPLY (identity 1)
 *   opacity                MULTIPLY (identity 1), clamped once at the end
 *   axes                   ADD per tag (via `addAxes`, dropping zero sums)
 *   clip                   the LARGEST `amount` wins; ties keep the first
 *
 * Mutates `acc` in place — this is a tight per-glyph-per-frame inner loop
 * (`presetTransform` calls it once per live move), and `Accumulator` never
 * escapes this module, so there is no aliasing risk to defend against.
 */
interface Accumulator {
  dx: number; dy: number; rotate: number; blur: number
  scale: number; scaleX: number; scaleY: number; opacity: number
  axes: Record<string, number>
  clipSide: VtGlyphClip['side'] | null
  clipAmount: number
}

function foldUnit(acc: Accumulator, u: UnitState): void {
  acc.dx += fin(u.dx, 0)
  acc.dy += fin(u.dy, 0)
  acc.rotate += fin(u.rotation, 0)
  acc.blur += Math.max(0, fin(u.blur, 0))
  acc.scale *= fin(u.scale, 1)
  acc.scaleX *= fin(u.scaleX, 1)
  acc.scaleY *= fin(u.scaleY, 1)
  acc.opacity *= clamp01(fin(u.opacity, 1))
  if (u.axes && typeof u.axes === 'object') acc.axes = addAxes(acc.axes, u.axes)
  if (u.clip && (CLIP_SIDES as readonly string[]).includes(u.clip.side) && isNum(u.clip.amount)) {
    const amount = clamp01(u.clip.amount)
    if (amount > acc.clipAmount) { acc.clipAmount = amount; acc.clipSide = u.clip.side }
  }
}

/**
 * What the PRESETS alone add to glyph `index` at time `t` — folded across
 * EVERY live `kind: 'preset'` move, generalising the old "one spec per slot"
 * evaluator from one preset per phase to any number stacked (Vector Type
 * moves spec §2).
 *
 * Per move: `movePhase` (`~/lib/studio/moves/phase`) is asked whether this
 * move is live at the glyph's own clock and, if so, its own eased 0→1
 * progress (`in`/`out`) or 0..1 cycle phase (`loop`) — the SAME windowing
 * `applyMotion`'s tracks and the shared moves panel use, so an entrance
 * window shown on a band strip can never disagree with what actually plays.
 * A move that is not live contributes nothing (its fold is skipped
 * entirely, which is what makes multiplicative fields — scale, opacity —
 * start from identity rather than from a live move's own value).
 *
 * AXIS PRESETS FIRST, exactly as before: they are not in the engine's
 * tables (their values are fractions of the loaded font's own range, which
 * the engine cannot know), so a `preset` move whose id names one is resolved
 * against `./axisPresets.ts` and contributes ONLY an axis delta — no offset,
 * no scale, no fade. Everything else goes through the engine's own tables via
 * `evaluatePresetUnit` (`~/lib/motion/evaluate`), fed the move's own eased
 * progress directly rather than re-deriving it, so this file's phase/ease
 * math is the ONLY phase/ease math a preset move's motion goes through.
 *
 * The unit conversion lives here and nowhere else: `dx`, `dy` and `blur` come
 * out of the engine in unit-box heights and leave in output pixels, multiplied
 * by the em at run time `t` (see the header, trap 1) — done ONCE, after every
 * move has folded in unit-box space, so N moves cost one multiply each, not N.
 *
 * `em` may be passed explicitly by a caller that has already resolved it — the
 * renderer knows the exact size it is drawing at, and passing it keeps the
 * transform and the geometry from resolving `size` twice.
 */
export function presetTransform(
  cfg: VectorTypeConfig,
  t: number,
  index: number,
  count: number,
  em: number = vtEmSize(cfg, t),
  env?: VtGlyphEnv | null,
): VtGlyphMotion {
  const moves = presetMoves(cfg)
  if (!moves.length) return { ...IDENTITY_GLYPH_MOTION, axes: {} }

  const duration = clipDuration(cfg)
  const n = Math.max(1, Math.floor(count))
  const i = Math.min(n - 1, Math.max(0, Math.floor(index)))

  // The glyph's own clock — the SAME `glyphTime` the tracks are read at, so one
  // stagger drives both sources and a wave cannot travel at two speeds.
  //
  // CLAMPED into the clip, never allowed to fall outside it. `movePhase`
  // reports NOT LIVE outside a move's own window: before its turn a staggered
  // glyph would vanish (right for an entrance, catastrophic for a loop — every
  // glyph would blink out for its first `rank·delay` seconds), and past the
  // end the whole run would disappear on the final frame of a bake. Clamping
  // instead pins the pre-roll to progress 0 (an entrance's own "fully out"
  // state) and the tail to the last frame's state, which is exactly what
  // `trackValue` does with a single-play track.
  const raw = glyphTime(cfg, t, i, n)
  const gt = Math.min(Math.max(0, isNum(raw) ? raw : 0), duration - 1e-6)

  const acc: Accumulator = {
    dx: 0, dy: 0, rotate: 0, blur: 0, scale: 1, scaleX: 1, scaleY: 1, opacity: 1,
    axes: {}, clipSide: null, clipAmount: 0,
  }
  let any = false

  for (const mv of moves) {
    // The move's own `at`/`duration`/`loop`/`bounce` are a self-contained
    // window now — no `longestIn` to thread through (that was the OLD
    // slot-per-phase model's job; an at-anchored move already knows where it
    // starts).
    const e = movePhase(mv, gt, duration)
    if (e == null) continue
    any = true

    // Which table (`in`/`out`/`loop`) this preset id belongs to is no longer
    // stored on the move (`Move` dropped `phase`) — resolved from the id
    // itself, the same lookup `vtKnowsPreset`/`vtPresetIdsFor` are built on.
    const slot = vtPresetSlotOf(mv.presetId)
    if (!slot) continue

    const axisPreset = vtAxisPreset(slot, mv.presetId)
    if (axisPreset) {
      const axes = env?.axes
      if (!axes?.length) continue
      const resting = env?.resting ?? (cfg?.axes as Record<string, number> | undefined) ?? null
      const delta = vtAxisDelta(axisPreset, e, i, n, axes, resting)
      if (Object.keys(delta).length) acc.axes = addAxes(acc.axes, delta)
      continue
    }

    const u = evaluatePresetUnit(slot, mv.presetId!, e, i, n, mv.params ?? {})
    foldUnit(acc, u)
  }

  if (!any) return { ...IDENTITY_GLYPH_MOTION, axes: {} }

  const emPx = isNum(em) ? em : DEFAULT_CONFIG.size
  // A zero-amount clip hides nothing; emitting it would make every consumer
  // set up a clipping region per glyph for no visual difference.
  const clip: VtGlyphClip | null = acc.clipAmount > 0 && acc.clipSide
    ? { side: acc.clipSide, amount: acc.clipAmount }
    : null

  return {
    dx: acc.dx * emPx,
    dy: acc.dy * emPx,
    scale: acc.scale,
    scaleX: acc.scaleX,
    scaleY: acc.scaleY,
    rotate: acc.rotate,
    opacity: clamp01(acc.opacity),
    blur: Math.max(0, acc.blur * emPx),
    clip,
    axes: acc.axes,
  }
}

/**
 * THE COMPOSITION. Preset ∘ tracks ∘ blink for glyph `index` at time `t`.
 *
 *   dx, dy, rotate  ADD        (identity 0 — either source alone passes through)
 *   scale           MULTIPLIES (identity 1)
 *   opacity         MULTIPLIES (identity 1), clamped to 0..1
 *   blur, clip, axes, scaleX/scaleY  come from the presets; tracks cannot
 *                   express them (a track carries one number down one config path)
 *
 * Multiplying opacity rather than adding is what makes "fade in *and* pulse"
 * read as a pulse inside a fade instead of saturating at 1 the moment both are
 * partly on. Multiplying scale means a Grow preset scales whatever the track
 * already scaled, rather than one of the two winning.
 *
 * ## Blink is the THIRD source, and it multiplies for a reason
 *
 * `./blink.ts` returns 1 or 0, so multiplying makes it compose exactly as the
 * rule already says opacity composes: a letter blinked out during a fade-in is
 * out, and one that is lit is at whatever the fade had reached. Adding would
 * make a dark letter reappear the moment anything else raised its opacity, and
 * overwriting would make the blink win over an exit and leave the word visible
 * after the clip had faded it away.
 *
 * ## Blink is on the RUN clock, not the glyph's
 *
 * `tr` and `pr` are read at `glyphTime()`; blink is read at `t`. That asymmetry
 * is deliberate and it is what makes `unit: 'word'` mean anything: two glyphs of
 * one word sit at different stagger ranks, so on the glyph clock they would be
 * in different beats and the word would come apart letter by letter. The stagger
 * shifts when a glyph reads its TRACKS; the blink beat is a property of the run.
 *
 * ## The SCATTER is the fourth source, and its axes ADD
 *
 * `./scatter.ts` returns an axis DELTA, the same currency `presetTransform`
 * already emits, so the two are summed per tag and the sum is clamped ONCE, by
 * `vtAxisCoords`, against the font's own range. Addition rather than replacement
 * is what makes "a weight wave AND a scatter" read as a scattered wave instead
 * of one source winning; addition rather than multiplication because an axis
 * coordinate is a position on a scale with an arbitrary origin (`GRAD` runs
 * −200…150 about 0), where a multiplier has no fixed point and inverts as the
 * value crosses zero. Identity is 0, which is exactly what "no scatter" emits,
 * so a config with only a wave is bit-identical to what it was before.
 *
 * Unlike the blink, the scatter is read on the GLYPH'S clock — there is no unit
 * above the glyph here for a run clock to protect, and staggering the settle so
 * the letters find their weight one after another is exactly what the stagger is
 * for.
 *
 * This is the function every renderer should call. `glyphTransform` (tracks only)
 * and `presetTransform` (presets only) remain exported for tests and for callers
 * that genuinely want one source.
 */
export function vtGlyphMotion(
  cfg: VectorTypeConfig,
  t: number,
  index: number,
  count: number,
  em?: number,
  env?: VtGlyphEnv | null,
): VtGlyphMotion {
  const tr = glyphTransform(cfg, t, index, count)
  const pr = presetTransform(cfg, t, index, count, em ?? vtEmSize(cfg, t), env)
  const blink = vtResolveBlink(cfg, t)
  // `vtBlinkActive` is the cheap gate: with blink off (the shipped default) the
  // per-glyph hashing below never runs, so every config written before this
  // feature composes to exactly what it composed to before.
  const lit = vtBlinkActive(blink)
    ? vtBlinkOpacity(blink, t, vtBlinkUnitIndex(blink.unit, index, env?.wordOf))
    : 1
  // Same cheap gate for the scatter, and the same guarantee behind it: `spread`
  // is the only control that can switch it on, and it ships at 0.
  const scatter = vtResolveScatter(cfg, t)
  let axes = pr.axes
  if (vtScatterActive(scatter)) {
    const gt = glyphTime(cfg, t, index, count)
    const resting = env?.resting ?? (cfg?.axes as Record<string, number> | undefined) ?? null
    axes = addAxes(pr.axes, vtScatterDelta(scatter, isNum(gt) ? gt : 0, index, env?.axes, resting))
  }
  return {
    dx: tr.dx + pr.dx,
    dy: tr.dy + pr.dy,
    scale: tr.scale * pr.scale,
    scaleX: pr.scaleX,
    scaleY: pr.scaleY,
    rotate: tr.rotate + pr.rotate,
    opacity: clamp01(tr.opacity * pr.opacity * lit),
    blur: pr.blur,
    clip: pr.clip,
    axes,
  }
}

/**
 * Two axis-delta records summed per tag, dropping any tag that cancels to 0.
 *
 * The zero drop is not tidiness: `vectorTypeFrame` decides whether a frame needs
 * PER-GLYPH SHAPING by asking whether any glyph emitted an axis at all, so a tag
 * carrying 0 would send the whole run down the expensive path — one fontkit
 * instance per distinct coordinate set — to draw a picture identical to the
 * cheap one. `vtAxisDelta` withholds a zero delta for the same reason, and the
 * sum has to keep that property or the two sources together would break what
 * either alone preserves.
 *
 * Returns the left operand UNCHANGED when the right one is empty, so the common
 * case allocates nothing and a preset-only frame is object-identical to what it
 * was before the scatter existed.
 */
function addAxes(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const tags = Object.keys(b)
  if (!tags.length) return a
  const out: Record<string, number> = { ...a }
  for (const tag of tags) {
    const v = fin(out[tag], 0) + fin(b[tag], 0)
    if (v === 0) delete out[tag]
    else out[tag] = v
  }
  return out
}
