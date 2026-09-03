/**
 * Vector Type Studio — RANDOM PER-GLYPH AXIS SCATTER. PURE.
 *
 * Every letter of the word sits at its OWN randomly-chosen position on one
 * variable axis, drawn around the value the user configured. It is the axis
 * equivalent of a scramble — and unlike a scramble it does not change which
 * letters are on screen, only how each one is CUT.
 *
 * Nothing else animates a variable axis per glyph, because doing it needs real
 * outlines re-instanced at an interpolated coordinate for every letter of every
 * frame. That is exactly what this studio already does for a weight wave
 * (`./axisPresets.ts`); this module gives each glyph an independent destination
 * instead of a shared travelling one.
 *
 * ## Determinism, the same way blink got it
 *
 * There is no roll. Every value is `f(glyph, t)`, built from `./random.ts`:
 * `glyphRandom(i, seed, channel)` with NO time bucket, because a scatter's whole
 * idea is that a glyph's destination is FIXED — it is time that moves, not the
 * target. Two renderers handed the same `t` therefore compute the same offsets
 * and shape the same outlines, so the preview, the PNG bake, the video bake and
 * the SVG export agree by construction.
 *
 * **Its own channels.** Task 2 measured what sharing a stream costs: two effects
 * on one channel correlate at r = 1.000 — the letter that blinks off is the
 * letter that scatters furthest, on every word, every time. `'scatter'` and
 * `'scatter.rate'` are therefore named constants here, and `'blink'` /
 * `'blink.phase'` are named constants in `./blink.ts`, so neither feature can
 * take the other's stream by accident.
 *
 * ## The two modes, and which way each one runs
 *
 * | mode | at `t = 0` | later | ends |
 * |---|---|---|---|
 * | `settle` | fully scattered | resolving | **exactly at the base**, still |
 * | `wander` | **exactly at the base** | drifting, each glyph at its own rate | never |
 *
 * The user asked for "an animation that starts from a given weight/slant, and
 * then glyphs change to random weight/slant values". That sentence is `wander`,
 * literally: at `t = 0` every glyph's delta is 0, so the word is exactly the
 * design the panel shows, and from there each letter drifts off to its own
 * position and keeps going.
 *
 * `settle` runs the OTHER way — scattered first, base last — and it has to, for
 * a reason the whole studio depends on: **an entrance must end still, on the
 * user's own design.** Weight In ends at `rest`. `vtStillTime` exists precisely
 * so a still bake samples the instant the entrance has finished. If `settle` ran
 * base → scattered it would be an exit wearing an entrance's name, the resting
 * frame would be a random word, and the Weight slider in the panel would
 * disagree with the thumbnail beside it. So the two modes between them cover
 * both directions and each one's resting state is the design.
 *
 * A free property that falls out of this, and is asserted rather than trusted:
 * **`wander` at `t = 0` is byte-identical to no scatter at all.** Each glyph's
 * drift is a sine through the origin, and the clock is clamped at 0, so every
 * still bake in the product (the render-cascade PNG, the Collection param baker,
 * the node thumbnail) shows the configured word rather than a random one.
 *
 * ## Squeeze, do not clip
 *
 * A glyph's offset is a fraction of the axis's OWN range (`wght` is 100–1000 on
 * Roboto Flex, 100–900 on Inter, and `GRAD` is −200–150), so `spread` means the
 * same thing on every font. Near an end of the axis there is not room for the
 * full swing, and the obvious answer — clamp the target — is wrong: several
 * glyphs land on EXACTLY the same value and the scatter visibly loses letters to
 * a pile at the boundary, which reads as a rendering bug in an effect whose
 * entire point is that the letters differ. So each side is SCALED into its own
 * headroom instead, which keeps every glyph distinct. When a side has no room at
 * all (the user parked the slider on the axis maximum) those glyphs mirror into
 * the other side, so the effect stays visible everywhere on the axis rather than
 * freezing half the word.
 *
 * ## It ADDS
 *
 * `VtGlyphMotion.axes` carries DELTAS, and the composition rule for a delta in
 * this studio is addition (`presetMotion.ts`: offsets and rotation add, scale and
 * opacity multiply). Axes take the offset rule, and not by analogy: an axis
 * coordinate is a position on a scale with an arbitrary origin — `GRAD` runs
 * −200…150 about a default of 0 — so a multiplier has no fixed point and would
 * invert as the value crossed zero. Addition has identity 0, which is exactly
 * what "no scatter" produces, so a config with only a weight wave is bit-identical
 * to what it was before this module existed. A scatter and a wave are both
 * visible, the sum is clamped ONCE at `vtAxisCoords`, and the spec tests the
 * composition rather than each source alone.
 */
import type { VectorTypeConfig } from './config'
// TYPE-ONLY against ./font.ts (it loads fontkit at module scope) — the same rule
// ./axisPresets.ts and ./controls.ts hold themselves to, for the same reason:
// this module is reached from every node card.
import type { VtAxis } from './font'
import { vtAxisTagAvailability, type VtAxisTagOffer } from './axisPresets'
import { glyphRandom } from './random'
// See blink.ts's identical import: tracks now live inside `motion.moves`, and
// a tagged track's timing comes from its owning move now, not its own fields.
import { moveTracks, trackValueAt } from '~/lib/studio/moves/tracks'

/** How the scatter behaves over time. */
export const VT_SCATTER_MODES = ['settle', 'wander'] as const
export type VtScatterMode = (typeof VT_SCATTER_MODES)[number]

/**
 * The two streams this feature reads, named so nothing else can take them.
 *
 * `'scatter'` picks WHERE each glyph is headed; `'scatter.rate'` picks how fast
 * it drifts in `wander`. Separate for the reason Task 2 measured — on one stream
 * the letter that travels furthest would also be the fastest, and the eye reads
 * that pairing as a pattern rather than as noise. Neither is `./blink.ts`'s
 * `'blink'` or `'blink.phase'`.
 */
export const VT_SCATTER_CHANNEL = 'scatter'
export const VT_SCATTER_RATE_CHANNEL = 'scatter.rate'

/** Seconds the settle may take. Beyond this an "entrance" is longer than the
 *  default clip, so it would never finish inside a bake. */
export const VT_SCATTER_SETTLE_MAX = 10
/** Drifts per second the wander tops out at. Above this the letters change cut
 *  faster than a 30 fps bake resolves and it reads as noise, the same ceiling
 *  and the same reason as `VT_BLINK_RATE_MAX`. */
export const VT_SCATTER_RATE_MAX = 4
/** Matches `VT_BLINK_SEED_MAX` / `VT_STAGGER_SEED_MAX`: a re-roll, not a
 *  coordinate. */
export const VT_SCATTER_SEED_MAX = 999
/** The axis a fresh scatter aims at. Weight is the axis every variable font in
 *  the catalog declares, so the default is never the unavailable case. */
export const VT_SCATTER_DEFAULT_AXIS = 'wght'

export interface VtScatterConfig {
  /**
   * How far the glyphs spread, as a fraction of the AXIS'S OWN RANGE.
   *
   * **0 is off**, and it is the shipped default — adding this feature must not
   * change one pixel of any config that existed before it. At 1 the offsets span
   * the whole axis (±half the range about the base).
   */
  spread: number
  /** OpenType tag of the axis to scatter. Only tags the loaded font declares do
   *  anything; an unknown one is IGNORED with a reason, never applied wrongly. */
  axis: string
  mode: VtScatterMode
  /** `settle` only: seconds from fully scattered to the base value. */
  settle: number
  /** `wander` only: drifts per second, before each glyph's own rate multiplier. */
  rate: number
  /** Re-rolls where each glyph lands, and how fast it drifts there. */
  seed: number
}

/** Off, deliberately: `spread: 0` makes every pre-existing config render exactly
 *  as it did before scatter existed. The rest are the values the effect should
 *  have the moment `spread` is raised — a weight scatter that resolves in under
 *  a second, which is what "the letters find their weight" looks like. */
export const DEFAULT_SCATTER: VtScatterConfig = Object.freeze({
  spread: 0,
  axis: VT_SCATTER_DEFAULT_AXIS,
  mode: 'settle',
  settle: 0.8,
  rate: 0.3,
  seed: 1,
}) as VtScatterConfig

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const fin = (v: unknown, d: number): number => (isNum(v) ? v : d)
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const TWO_PI = Math.PI * 2

/** An OpenType axis tag is exactly four printable-ASCII characters. Restated
 *  from `./font.ts` rather than imported — that module loads fontkit at module
 *  scope and this one is deliberately type-only against it. */
const AXIS_TAG = /^[\x20-\x7E]{4}$/

/** True for a string that could name an axis. Not "the font has it" — that is
 *  `vtScatterAvailability`'s question, and the two must stay separate because a
 *  stored config is read with no font loaded. */
export function isVtScatterAxis(tag: unknown): boolean {
  return typeof tag === 'string' && AXIS_TAG.test(tag)
}

/** The shared answer for "this config does not scatter". Frozen because it is
 *  handed out rather than copied — see `vtResolveScatter`'s hot path. */
const SCATTER_OFF: VtScatterConfig = Object.freeze({ ...DEFAULT_SCATTER, spread: 0 }) as VtScatterConfig

/**
 * Could this block ever move a glyph? The cheap guard every caller takes before
 * doing per-glyph work.
 *
 * Each refusal is a slider at an end of its travel meaning what a user would
 * expect, not an arithmetic accident:
 *
 *  - `spread <= 0` — no spread is no scatter. **The off switch**, and the default.
 *  - a malformed `axis` — there is no axis to move.
 *  - `settle <= 0` in `settle` mode — an entrance of zero length has already
 *    finished at every `t`, so the word is at the base forever. Not "instant
 *    scatter": the resting state of a settle is the base, and a zero-length
 *    settle is all resting state.
 *  - `rate <= 0` in `wander` mode — zero drifts per second is no drift, and the
 *    drift is a sine through the origin, so the word sits at the base. NOT a
 *    frozen scatter, which would strand the letters at random cuts the moment a
 *    rate slider reached the bottom.
 */
export function vtScatterActive(sc: VtScatterConfig | null | undefined): boolean {
  if (!sc) return false
  if (!(clamp01(fin(sc.spread, 0)) > 0)) return false
  if (!isVtScatterAxis(sc.axis)) return false
  if (sc.mode === 'wander') return fin(sc.rate, 0) > 0
  return fin(sc.settle, 0) > 0
}

/**
 * Whether the loaded font can run this scatter, and if not, WHY — the same
 * shape, the same sentences and the same DISABLED-WITH-A-REASON contract the
 * axis presets use (`vtAxisAvailability`), because it is literally the same
 * function underneath.
 *
 * Hiding it would be the wrong call here for the reason `./axisPresets.ts`'s
 * header gives: "this font has no GRAD axis" names a choice the user owns and
 * can change in one click, so the reason is worth more than the tile.
 */
export function vtScatterAvailability(
  sc: VtScatterConfig | null | undefined,
  axes: readonly VtAxis[] | null | undefined,
  fontLabel?: string,
): VtAxisTagOffer {
  const tag = isVtScatterAxis(sc?.axis) ? (sc!.axis as string) : VT_SCATTER_DEFAULT_AXIS
  return vtAxisTagAvailability(tag, undefined, axes, fontLabel)
}

/**
 * One glyph's own destination, as a SIGNED OFFSET in the axis's own units.
 *
 * `spread` is a fraction of the axis's whole range, halved because the swing is
 * two-sided: at `spread: 1` the offsets fill the axis (±half the range), which
 * is the most a scatter about a centred base can mean.
 *
 * Then the headroom rule from the header — each side scaled into the room it
 * actually has, and mirrored when it has none. Two consequences worth stating:
 *
 *  - the returned value ALWAYS lands inside `[axis.min, axis.max]` when added to
 *    `rest`, so nothing downstream has to clamp this on its own (`vtAxisCoords`
 *    still clamps the SUM with the axis presets, which is a different question);
 *  - glyphs stay distinct near the ends of the axis, where a clamp would have
 *    collapsed several of them onto the boundary.
 */
export function vtScatterAmplitude(
  sc: VtScatterConfig,
  axis: VtAxis,
  index: number,
  rest: number,
): number {
  const span = Math.max(0, axis.max - axis.min)
  if (!(span > 0)) return 0
  const spread = clamp01(fin(sc?.spread, 0))
  const amp = span * spread * 0.5
  if (!(amp > 0)) return 0

  const base = Math.min(axis.max, Math.max(axis.min, isNum(rest) ? rest : axis.default))
  let up = Math.min(amp, axis.max - base)
  let down = Math.min(amp, base - axis.min)
  // No room on one side: those glyphs scatter the other way rather than sitting
  // still. At the very top of an axis "spread around the base" can only mean
  // "spread below it", and saying so is better than freezing half the word.
  if (!(up > 0)) up = -down
  if (!(down > 0)) down = -up

  const seed = Math.trunc(fin(sc?.seed, DEFAULT_SCATTER.seed))
  const i = isNum(index) ? Math.max(0, Math.trunc(index)) : 0
  // [-1, 1) — signed, so the sign picks the side and the magnitude picks how far.
  const s = glyphRandom(i, seed, VT_SCATTER_CHANNEL) * 2 - 1
  return s >= 0 ? s * up : s * down
}

/**
 * This glyph's own drift rate multiplier for `wander`, in `[0.5, 1.5)`.
 *
 * On its OWN channel, so the letter that travels furthest is not also the
 * fastest. The point of the multiplier is that the periods are incommensurate:
 * with one shared rate every glyph returns to the base on the same frame and the
 * wander reads as a pulse. Bounded well away from 0 so no glyph is effectively
 * frozen, and away from 2 so the fastest letter is not twice the pace of the
 * slowest — the drift should read as one texture, not as a race.
 */
export function vtScatterRateOf(sc: VtScatterConfig, index: number): number {
  const seed = Math.trunc(fin(sc?.seed, DEFAULT_SCATTER.seed))
  const i = isNum(index) ? Math.max(0, Math.trunc(index)) : 0
  return 0.5 + glyphRandom(i, seed, VT_SCATTER_RATE_CHANNEL)
}

/**
 * How much of a glyph's full amplitude is showing at glyph-clock time `gt`, in
 * `[-1, 1]`. The whole difference between the two modes lives here.
 *
 * `settle` is `1 → 0` on a decelerating curve — `power2.out`, the same easing
 * `Weight In` uses, spelled inline rather than imported so this module keeps the
 * zero-dependency shape `./random.ts` and `./curve.ts` hold. It reaches EXACTLY
 * 0 at `gt >= settle`, so an entrance ends on the user's own design with no
 * residue.
 *
 * `wander` is a sine THROUGH THE ORIGIN, which is the property that makes
 * `t = 0` the configured word: no per-glyph phase offset is added, because a
 * random phase would put every glyph somewhere random on the very first frame
 * and every still bake in the product samples that frame. The decorrelation
 * comes from the per-glyph RATE instead, which costs nothing at `t = 0` and
 * disperses the run within a fraction of a cycle.
 *
 * `gt` is clamped at 0 rather than allowed to go negative: a stagger shifts each
 * glyph's clock backwards, and `unitStateFor` pins that pre-roll to progress 0
 * for the same reason — before its turn a glyph should hold the state its
 * animation starts in.
 */
export function vtScatterEnvelope(sc: VtScatterConfig, gt: number, index: number): number {
  const t = Math.max(0, isNum(gt) ? gt : 0)
  if (sc?.mode === 'wander') {
    const rate = fin(sc?.rate, DEFAULT_SCATTER.rate)
    if (!(rate > 0)) return 0
    return Math.sin(TWO_PI * rate * vtScatterRateOf(sc, index) * t)
  }
  const settle = fin(sc?.settle, DEFAULT_SCATTER.settle)
  if (!(settle > 0)) return 0
  const p = clamp01(t / settle)
  // power2.out — decelerating into place. 0 at p = 0 (fully scattered), exactly
  // 1 at p = 1 (fully resolved), so `1 - eased` is exactly 0 at the end.
  const eased = 1 - (1 - p) * (1 - p)
  return 1 - eased
}

/**
 * The scatter's contribution for one glyph, as an axis DELTA keyed by tag — the
 * shape `VtGlyphMotion.axes` carries, so it composes with an axis preset by
 * addition and with everything else by being ignored.
 *
 * Empty — not `0`, and not a throw — whenever it cannot run: no axes loaded, the
 * font lacks the tag, the axis is degenerate, or the arithmetic came out at
 * exactly zero. That matches `vtAxisDelta` exactly, and it matters downstream:
 * `vectorTypeFrame` decides whether the frame needs per-glyph shaping by asking
 * whether ANY glyph emitted an axis, so an emitted zero would send a whole frame
 * down the expensive path to draw a picture identical to the cheap one.
 */
export function vtScatterDelta(
  sc: VtScatterConfig,
  gt: number,
  index: number,
  axes: readonly VtAxis[] | null | undefined,
  resting?: Record<string, number> | null,
): Record<string, number> {
  if (!vtScatterActive(sc)) return {}
  const list = Array.isArray(axes) ? axes : []
  const axis = list.find(a => a?.tag === sc.axis) ?? null
  if (!axis || !(axis.max > axis.min)) return {}

  const raw = resting?.[axis.tag]
  const rest = isNum(raw) ? Math.min(axis.max, Math.max(axis.min, raw)) : axis.default
  const amp = vtScatterAmplitude(sc, axis, index, rest)
  if (!isNum(amp) || amp === 0) return {}
  const delta = amp * vtScatterEnvelope(sc, gt, index)
  if (!isNum(delta) || delta === 0) return {}
  return { [axis.tag]: delta }
}

/** Does any track drive `motion.scatter.spread`? The one thing that can turn a
 *  scatter on that the stored `spread` does not already say. */
function hasSpreadTrack(tracks: unknown): boolean {
  if (!Array.isArray(tracks)) return false
  for (const tr of tracks) {
    if (tr && typeof tr === 'object' && typeof tr.path === 'string'
      && tr.path.trim() === 'motion.scatter.spread') return true
  }
  return false
}

/**
 * The scatter block at time `t`, with any tracks aimed at it applied.
 *
 * `motion.scatter.spread` / `.settle` / `.rate` are ordinary animatable config
 * leaves — a track on `spread` is how a word comes apart over the length of a
 * clip rather than at a fixed intensity from frame one. They are read DIRECTLY
 * from the tracks here, exactly as `vtEmSize` reads `size` and `vtResolveBlink`
 * reads its own three, rather than via `applyMotion`: `vtGlyphMotion` is handed
 * the raw config and cloning it per glyph per frame to resolve three numbers is
 * the wrong price.
 *
 * Read on the RUN clock. The per-GLYPH clock is applied later, to the envelope
 * (`vtScatterEnvelope`), which is where the stagger belongs: it should decide
 * when each letter settles, not what the spread slider currently reads.
 *
 * Tolerant of a config straight out of storage — a missing `motion`, a missing
 * `scatter`, a non-array `tracks` — because only the editor surface holds a
 * `mergeConfig`-ed config; the node card, the baker and the frame source read
 * `properties.sailor_vectorType` as parsed JSON.
 */
export function vtResolveScatter(cfg: VectorTypeConfig | null | undefined, t: number): VtScatterConfig {
  const raw = (cfg?.motion as { scatter?: Partial<VtScatterConfig> } | undefined)?.scatter
  const tracks = moveTracks(cfg?.motion)

  // THE HOT PATH, and the reason a config with scatter off is byte-identical to
  // one written before this feature: `spread` is the only control that can
  // switch the effect on, so with it at 0 and nothing animating it, no value of
  // `axis`, `mode`, `settle`, `rate` or `seed` can move a glyph.
  if (!(fin(raw?.spread, DEFAULT_SCATTER.spread) > 0) && !hasSpreadTrack(tracks)) return SCATTER_OFF

  const out: VtScatterConfig = {
    spread: clamp01(fin(raw?.spread, DEFAULT_SCATTER.spread)),
    axis: isVtScatterAxis(raw?.axis) ? (raw!.axis as string) : DEFAULT_SCATTER.axis,
    mode: (VT_SCATTER_MODES as readonly string[]).includes(raw?.mode as string)
      ? (raw!.mode as VtScatterMode)
      : DEFAULT_SCATTER.mode,
    settle: Math.max(0, fin(raw?.settle, DEFAULT_SCATTER.settle)),
    rate: Math.max(0, fin(raw?.rate, DEFAULT_SCATTER.rate)),
    seed: Math.trunc(fin(raw?.seed, DEFAULT_SCATTER.seed)),
  }

  if (!Array.isArray(tracks) || !tracks.length) return out
  const duration = Math.max(0.001, fin(cfg?.motion?.duration, 4))
  for (const tr of tracks) {
    if (!tr || typeof tr !== 'object') continue
    if (!isNum(tr.from) || !isNum(tr.to)) continue
    const path = typeof tr.path === 'string' ? tr.path.trim() : ''
    // Last writer wins, matching `vtEmSize` and `vtResolveBlink`: two tracks on
    // one path overwrite rather than compose, and that rule is stated once for
    // the whole studio.
    if (path === 'motion.scatter.spread') out.spread = clamp01(trackValueAt(tr, t, duration))
    else if (path === 'motion.scatter.settle') out.settle = Math.max(0, trackValueAt(tr, t, duration))
    else if (path === 'motion.scatter.rate') out.rate = Math.max(0, trackValueAt(tr, t, duration))
  }
  return out
}

/**
 * The instant a SETTLING scatter has finished, on the run clock — 0 for anything
 * that is not settling.
 *
 * `vtStillTime` folds this in so a still bake shows the settled word. Without
 * it, a config whose only motion is a settle would bake its PNG, its node
 * thumbnail and its Collection rows at `t = 0`, which is the MOST scattered
 * frame there is: the panel would say `Weight 400` over a picture with nine
 * different weights in it, and nothing would error.
 *
 * `wander` returns 0 and that is not an oversight — a wander has no finish, and
 * `t = 0` is exactly the configured word (see the header), so 0 is already the
 * right instant to sample.
 */
export function vtScatterStillTime(cfg: VectorTypeConfig | null | undefined): number {
  const sc = vtResolveScatter(cfg, 0)
  if (!vtScatterActive(sc) || sc.mode !== 'settle') return 0
  return Math.max(0, sc.settle)
}
