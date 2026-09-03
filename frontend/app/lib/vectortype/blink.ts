/**
 * Vector Type Studio — BLINK. PURE.
 *
 * Letters (or whole words) dropping out and coming back. One boolean per unit
 * per instant, multiplied into `VtGlyphMotion.opacity` by `vtGlyphMotion`.
 *
 * ## The only real risk here is determinism, so read this part
 *
 * A blink is literally per-frame randomness, which is the one thing this studio
 * cannot have: the preview would flicker, the bake would flicker, and they would
 * flicker DIFFERENTLY. Nothing would error and the picture would look right.
 *
 * So there is no roll. Every value below is `f(unit, t)`, and it is built from
 * two pure pieces `./random.ts` already provides:
 *
 *   `timeBucket(t, period)` — WHICH BEAT `t` falls in, `floor(t / period)`
 *   `glyphRandom(i, seed, channel, bucket)` — a stable value for that unit,
 *                                             on that channel, in that beat
 *
 * Nothing is stored between calls, so call order, frame rate and render count
 * cannot enter. Two renderers handed the same `t` compute the same beat, the
 * same value and the same picture — the preview, the PNG bake, the video bake
 * and the SVG export all reach here through `vectorTypeFrame`.
 *
 * **The residual edge, and where the proof has to look.** Quantisation means
 * `t = 0.4999` and `t = 0.5001` are legitimately different pictures when a beat
 * boundary sits at 0.5. That is correct behaviour, not a defect — but it is also
 * exactly where a bake and a preview that compute `t` differently (`frame / fps`
 * versus an accumulated clock) would diverge, and NOWHERE ELSE. Any proof that
 * only samples the middle of beats will pass on a broken pair. The spec
 * therefore samples ON boundaries, from both sides, deliberately.
 *
 * ## Three controls, and why they are three and not two
 *
 * Threshold a uniform value at `v < p` and you have ONE number that is
 * simultaneously "what fraction of the letters are dark" and "what fraction of
 * the time a letter is dark". They are the same knob, so a studio offering both
 * would be offering the same control twice. They are separated here by putting
 * them on different mechanisms:
 *
 *   `amount`  — WHO. Per beat, per unit: is this one in the rotation at all?
 *   `stayLit` — WHEN, within the beat: how much of it the unit stays lit before
 *               it drops out. The duty cycle.
 *   `rate`    — HOW OFTEN the beat comes round.
 *
 * The dark window inside a beat is placed by a SECOND random channel, so the
 * selected units do not all drop out on the same instant. Without it every beat
 * is a strobe: the whole rotation goes dark together, comes back together, and
 * the effect reads as a metronome rather than as something breaking. The window
 * is positioned so it always fits inside its own beat (`start = offset ×
 * stayLit`, length `1 − stayLit`), which is what keeps a beat's decision inside
 * that beat instead of bleeding into the next one's.
 *
 * The price, stated because a control that lies is worse than a missing one:
 * since selection and duty are independent, the fraction of units dark AT AN
 * INSTANT is `amount × (1 − stayLit)`, not `amount`. `amount` is how many take
 * part in a blink; `stayLit` is how briefly. Both hints say so and the spec
 * measures the product.
 *
 * ## Letters or words
 *
 * `unit` selects what a "unit" is, and word grouping is `./words.ts`'s — spaces
 * separate, punctuation and hyphens do not, a run with no spaces is one word,
 * and a separator glyph belongs to NO word (`VT_NO_WORD`). Every glyph of a word
 * is handed the same unit index, so it gets the same beat, the same selection
 * and the same window: a word goes dark as one thing, which is the entire point
 * of the setting.
 */
import type { VectorTypeConfig } from './config'
import { glyphRandom, timeBucket } from './random'
import { VT_NO_WORD } from './words'
// The tracks now live inside `motion.moves` (each a 'tracks'-kind Move), not
// at a flat `motion.tracks` any more — `moveTracks` flattens every move's
// tracks back into one list, which is all this file ever needed a `tracks`
// array for (it only reads three leaf paths off it, run-level, below).
// `trackValueAt` reads one tagged track's value honoring its OWNING MOVE's
// ease/play (a track no longer carries its own `easing`/`loops`).
import { moveTracks, trackValueAt } from '~/lib/studio/moves/tracks'

/** What a blink treats as one thing. */
export const VT_BLINK_UNITS = ['letter', 'word'] as const
export type VtBlinkUnit = (typeof VT_BLINK_UNITS)[number]

/**
 * Which stream each of the two decisions reads.
 *
 * They are DIFFERENT channels for the reason Task 2 measured: two effects
 * sharing a stream correlate perfectly (r = 1.000), so the unit that is picked
 * for this beat would also be the one whose window sits earliest in it — an
 * ordering the eye reads as a pattern. `'blink'` is also the channel the axis
 * scatter and grade flicker must NOT use, which is why it is named rather than
 * implied.
 */
export const VT_BLINK_CHANNEL = 'blink'
export const VT_BLINK_PHASE_CHANNEL = 'blink.phase'

/** Blinks per second the rate slider tops out at. Above roughly this the effect
 *  is finer than a 30 fps bake can resolve and reads as noise rather than as a
 *  blink, so the extra travel would only be a way to make the export disagree
 *  with what the eye saw. */
export const VT_BLINK_RATE_MAX = 24
/** Matches `VT_STAGGER_SEED_MAX`: a re-roll knob, not a coordinate. */
export const VT_BLINK_SEED_MAX = 999

export interface VtBlinkConfig {
  /**
   * How much of the run takes part in each blink, 0..1.
   *
   * **0 is off**, and it is the shipped default — adding this feature must not
   * change one pixel of any config that existed before it.
   */
  amount: number
  /** Blinks per second. 0 = the effect does not run (see `vtBlinkDark`). */
  rate: number
  /** The share of each beat a unit stays lit before dropping out, 0..1.
   *  1 = it never drops out; 0 = it is dark for the whole beat. */
  stayLit: number
  unit: VtBlinkUnit
  /** Re-rolls WHICH units blink and when, without changing anything else. */
  seed: number
}

/** Off, and deliberately: `amount: 0` makes every pre-existing config render
 *  exactly as it did before blink existed. The other four are the values the
 *  effect should have the moment `amount` is raised — a fast, mostly-lit,
 *  per-letter flicker, which is what "blink" means to a designer before they
 *  touch anything. */
export const DEFAULT_BLINK: VtBlinkConfig = Object.freeze({
  amount: 0,
  rate: 6,
  stayLit: 0.7,
  unit: 'letter',
  seed: 1,
}) as VtBlinkConfig

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const fin = (v: unknown, d: number): number => (isNum(v) ? v : d)
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** The shared answer for "this config does not blink". Frozen because it is
 *  handed out rather than copied — see `vtResolveBlink`'s hot path. */
const BLINK_OFF: VtBlinkConfig = Object.freeze({ ...DEFAULT_BLINK, amount: 0 }) as VtBlinkConfig

/** Does any track drive `motion.blink.amount`? The one thing that can turn a
 *  blink on that the stored `amount` does not already say. */
function hasAmountTrack(tracks: unknown): boolean {
  if (!Array.isArray(tracks)) return false
  for (const tr of tracks) {
    if (tr && typeof tr === 'object' && typeof tr.path === 'string'
      && tr.path.trim() === 'motion.blink.amount') return true
  }
  return false
}

/**
 * Which unit glyph `glyphIndex` belongs to, or `VT_NO_WORD` for one that cannot
 * blink at all.
 *
 * `'letter'` is the identity: every glyph is its own unit. A separator glyph is
 * included — it carries no ink, so blinking it is invisible either way, and
 * excluding it would make the letter case need the word grouping it otherwise
 * does not.
 *
 * `'word'` reads `wordOf` (`wordIndexOfGlyph`), which already answers both
 * halves of the question: glyphs of one word share an index, and separators
 * carry `VT_NO_WORD`. A space cannot blink.
 *
 * **Without `wordOf`, word blink is INERT rather than silently per-letter.**
 * The grouping cannot be recovered from the glyph index alone — a ligature makes
 * glyph indices and character indices disagree — so the alternatives are "show
 * nothing" and "show a different effect from the one that was asked for". A
 * missing group reads as a bug and gets fixed; a letter blink where a word blink
 * was asked for reads as a taste call and does not. `vectorTypeFrame` always
 * supplies it, and the spec asserts that rather than trusting it.
 */
export function vtBlinkUnitIndex(
  unit: VtBlinkUnit,
  glyphIndex: number,
  wordOf?: readonly number[] | null,
): number {
  const i = isNum(glyphIndex) ? Math.trunc(glyphIndex) : -1
  if (i < 0) return VT_NO_WORD
  if (unit !== 'word') return i
  if (!Array.isArray(wordOf)) return VT_NO_WORD
  const w = wordOf[i]
  return isNum(w) && w >= 0 ? Math.trunc(w) : VT_NO_WORD
}

/**
 * Is unit `unitIndex` dark at time `t`? The whole effect, in one pure boolean.
 *
 * The refusals first, each one a slider at an end of its travel meaning
 * something a user would expect rather than an arithmetic accident:
 *
 *  - `unitIndex < 0` — not a blinkable unit (a space, or word blink with no
 *    grouping). Never dark.
 *  - `amount <= 0` — nothing takes part. **The off switch.**
 *  - `stayLit >= 1` — the unit stays lit for the whole beat, so the dark window
 *    has zero length. Never dark.
 *  - `rate <= 0` — zero blinks per second is zero blinks. NOT "a frozen beat":
 *    a frozen beat would leave a random half of the run permanently dark, which
 *    is a picture nobody asked for by dragging a rate slider to the bottom.
 *  - non-finite `t` — a clock that is not a number cannot select a beat.
 *
 * Then the two decisions, both keyed on the SAME beat so they cannot disagree:
 *
 *   beat   = timeBucket(t, 1 / rate)        — the quantised instant
 *   phase  = t / period − beat              — where in the beat we are, 0..1
 *   picked = glyphRandom(…, 'blink', beat) < amount
 *   start  = glyphRandom(…, 'blink.phase', beat) × stayLit
 *   dark   = picked && start <= phase < start + (1 − stayLit)
 *
 * `phase` is derived from the same division `timeBucket` performs, so it cannot
 * drift from the beat by a floating-point ulp at the boundary — the one place
 * two independent expressions for the same quantity would show up.
 *
 * The window is half-open (`>= start`, `< end`) for the same reason the beat is:
 * a closed end would make the instant of a boundary belong to two windows, and
 * "which one wins" is exactly the kind of question a bake and a preview answer
 * differently.
 */
export function vtBlinkDark(blink: VtBlinkConfig, t: number, unitIndex: number): boolean {
  if (!isNum(unitIndex) || unitIndex < 0) return false
  if (!isNum(t)) return false

  const amount = clamp01(fin(blink?.amount, 0))
  if (amount <= 0) return false

  const stayLit = clamp01(fin(blink?.stayLit, DEFAULT_BLINK.stayLit))
  if (stayLit >= 1) return false

  const rate = fin(blink?.rate, DEFAULT_BLINK.rate)
  if (!(rate > 0)) return false

  const seed = Math.trunc(fin(blink?.seed, DEFAULT_BLINK.seed))
  const period = 1 / rate
  const beat = timeBucket(t, period)
  const phase = t / period - beat

  const i = Math.trunc(unitIndex)
  if (!(glyphRandom(i, seed, VT_BLINK_CHANNEL, beat) < amount)) return false

  const start = glyphRandom(i, seed, VT_BLINK_PHASE_CHANNEL, beat) * stayLit
  return phase >= start && phase < start + (1 - stayLit)
}

/**
 * The blink as an opacity MULTIPLIER: 1 lit, 0 dark.
 *
 * A hard cut, not a fade. "Letters randomly appear and disappear" is a switch,
 * and a ramp would need its own shape control to say how fast — a fade is what
 * the `glyph.opacity` track and the fade presets are already for, and this
 * multiplies with both.
 */
export function vtBlinkOpacity(blink: VtBlinkConfig, t: number, unitIndex: number): number {
  return vtBlinkDark(blink, t, unitIndex) ? 0 : 1
}

/** True when this blink block could ever darken anything. The cheap guard every
 *  caller takes before doing per-glyph work — and the reason a config with blink
 *  switched off is byte-identical to one from before the feature existed. */
export function vtBlinkActive(blink: VtBlinkConfig | null | undefined): boolean {
  if (!blink) return false
  return clamp01(fin(blink.amount, 0)) > 0
    && fin(blink.rate, 0) > 0
    && clamp01(fin(blink.stayLit, 1)) < 1
}

/**
 * The blink block at run time `t`, with any tracks aimed at it applied.
 *
 * `motion.blink.rate` / `.amount` / `.stayLit` are ordinary animatable config
 * leaves, so a track can ramp a flicker up as a sign fails. They are read
 * DIRECTLY from the tracks here, exactly as `vtEmSize` reads `size`, rather than
 * via `applyMotion`: `vtGlyphMotion` is handed the raw config and calling
 * `applyMotion` per glyph per frame would clone the whole config to resolve
 * three numbers.
 *
 * Run-level, on the run's clock — NOT the glyph's. A stagger shifts when each
 * glyph reads its tracks; it must not also shift which beat each glyph is in, or
 * `amount` would stop meaning "how many are out at once" and the word-grouping
 * guarantee would break (two glyphs of one word on two different clocks are two
 * different beats). `seed` and `unit` are not animatable, so they are read
 * straight through.
 *
 * Tolerant of a config straight out of storage — a missing `motion`, a missing
 * `blink`, a non-array `tracks` — for the reason `./motion.ts`'s header gives:
 * only the editor surface holds a merged config.
 */
export function vtResolveBlink(cfg: VectorTypeConfig | null | undefined, t: number): VtBlinkConfig {
  const raw = (cfg?.motion as { blink?: Partial<VtBlinkConfig> } | undefined)?.blink
  const tracks = moveTracks(cfg?.motion)

  // THE HOT PATH. `vtGlyphMotion` runs once per glyph per frame for every config
  // in the product, and the overwhelming majority of them will never blink — so
  // the off case allocates nothing at all. Sound because `amount` is the only
  // control that can switch the effect on: with it at 0 and nothing animating
  // it, no value of `rate`, `stayLit`, `unit` or `seed` can darken a glyph.
  if (!(fin(raw?.amount, DEFAULT_BLINK.amount) > 0) && !hasAmountTrack(tracks)) return BLINK_OFF

  const out: VtBlinkConfig = {
    amount: clamp01(fin(raw?.amount, DEFAULT_BLINK.amount)),
    rate: Math.max(0, fin(raw?.rate, DEFAULT_BLINK.rate)),
    stayLit: clamp01(fin(raw?.stayLit, DEFAULT_BLINK.stayLit)),
    unit: (VT_BLINK_UNITS as readonly string[]).includes(raw?.unit as string)
      ? (raw!.unit as VtBlinkUnit)
      : DEFAULT_BLINK.unit,
    seed: Math.trunc(fin(raw?.seed, DEFAULT_BLINK.seed)),
  }

  if (!Array.isArray(tracks) || !tracks.length) return out
  const duration = Math.max(0.001, fin(cfg?.motion?.duration, 4))
  for (const tr of tracks) {
    if (!tr || typeof tr !== 'object') continue
    if (!isNum(tr.from) || !isNum(tr.to)) continue
    const path = typeof tr.path === 'string' ? tr.path.trim() : ''
    // Last writer wins, matching `vtEmSize`: two tracks on one path overwrite
    // rather than compose, and that rule is stated once for the whole studio.
    if (path === 'motion.blink.amount') out.amount = clamp01(trackValueAt(tr, t, duration))
    else if (path === 'motion.blink.rate') out.rate = Math.max(0, trackValueAt(tr, t, duration))
    else if (path === 'motion.blink.stayLit') out.stayLit = clamp01(trackValueAt(tr, t, duration))
  }
  return out
}
