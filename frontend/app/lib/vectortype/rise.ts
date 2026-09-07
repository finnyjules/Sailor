/**
 * Vector Type Studio — PER-GLYPH BASELINE RISE. PURE.
 *
 * Numbers in, pixels out. It imports `./random` for the seeded hash and the
 * bounds it clamps against from `./config`, and nothing else — no canvas, no
 * DOM, no fontkit, no paper. That is the bar `./scatter.ts` and `./random.ts`
 * hold themselves to, and it is the reason this file can be reasoned about (and
 * tested) without a font: every question about where a letter sits is
 * arithmetic, and arithmetic is checkable.
 *
 * One letter at its own height, which is the thing the studio could not do
 * before. `skewX` / `skewY` shear the WHOLE run by design — a shear applied
 * about each letter's own origin leans every letter while the word stays
 * upright, which is the wrong-looking one, and `config.ts` says so at the
 * control. This is a different operation: a rigid translation of one glyph
 * along its own baseline normal. Moving one letter relative to its neighbours
 * is the entire feature, so it is per-glyph where the shear is not.
 *
 * ## Up-positive in, y-down out — ONE negation, and it is here
 *
 * Every shape below is written the way a user reads it: Arch peaks at `+A` in
 * the middle, Ramp climbs from `−A` to `+A`, positive means UP. Canvas `dy`
 * grows DOWNWARD. So `vtRiseDy` negates exactly once, at the boundary where an
 * em fraction becomes a pixel, and everything on either side of that line has a
 * single consistent convention. A sign flip written into the stored value
 * instead would leave the saved config, a motion track's `from`/`to`, the
 * control's label and the golden test each carrying their own, and the next
 * person to add a shape would have to guess which.
 *
 * ## The clamp lives at the RENDER choke point, not in the merge
 *
 * `mergeConfig` deliberately does not bound `rise` or `riseCycles`, for the
 * reason its own comment gives at `skewX` and `arc`: a motion track's `from` /
 * `to` are arbitrary numbers that never pass through the merge, so a bound only
 * the merge honours is not a bound. Both entrances — a stored config and an
 * animated one — reach the screen through this function, so this is where
 * `±VT_RISE_MAX` and `[VT_RISE_CYCLES_MIN, VT_RISE_CYCLES_MAX]` are true.
 *
 * ## No time enters the hash
 *
 * `random` reads `glyphRandom(i, riseSeed, VT_RISE_CHANNEL)` with NO time
 * bucket. A letter's height is FIXED — it is an arrangement, not a flicker — so
 * the signature takes no `t` at all and the preview, the PNG bake, the video
 * bake and the SVG export agree by construction rather than by luck.
 *
 * **Its own channel.** The scatter work measured what sharing a stream costs:
 * two effects on one channel correlate at r = 1.000, so the letter that blinks
 * off is the letter that rises highest, on every word, every time, and the
 * composite reads as one effect instead of two. `VT_RISE_CHANNEL` is a named
 * constant here beside `VT_BLINK_CHANNEL` in `./blink.ts` and
 * `VT_SCATTER_CHANNEL` in `./scatter.ts` so no feature can take another's
 * stream by accident, and `vectortype-rise.unit.spec.ts` measures it rather
 * than asserting it.
 *
 * ## Off costs nothing
 *
 * `riseShape: 'off'` — the shipped default, and every config saved before this
 * feature existed — returns a literal `0` before any hashing or multiplying,
 * and `0` added to `dy` changes no pixel. So the run this studio has always
 * drawn is byte-identical to the run it draws now.
 */
import { glyphRandom } from './random'
import {
  DEFAULT_CONFIG,
  VT_RISE_CYCLES_MAX,
  VT_RISE_CYCLES_MIN,
  VT_RISE_MAX,
  VT_RISE_SHAPES,
  type VectorTypeConfig,
  type VtRiseShape,
} from './config'

/** The seeded-random stream the `random` shape draws from. Named, never a
 *  string literal at the call site — see the header on r = 1.000. */
export const VT_RISE_CHANNEL = 'rise'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const fin = (v: unknown, d: number): number => (isNum(v) ? v : d)

/** The stored shape, or `'off'` for anything this build does not know how to
 *  draw. Validated against the list rather than merely compared to `'off'`: a
 *  config written by a newer build, or hand-edited, would otherwise report
 *  itself ACTIVE and make every caller pay for per-glyph work that can only
 *  come back 0. */
function shapeOf(cfg: VectorTypeConfig | null | undefined): VtRiseShape {
  const s = cfg?.riseShape
  return (VT_RISE_SHAPES as readonly unknown[]).includes(s) ? (s as VtRiseShape) : 'off'
}

/** `rise` bounded to `±VT_RISE_MAX`, non-finite floored to 0. A `NaN` here is
 *  the whole failure mode of this module: it multiplies through to a `NaN` dy,
 *  which draws a glyph nowhere or everywhere, silently, and the run simply
 *  loses a letter with nothing logged. */
function riseOf(cfg: VectorTypeConfig | null | undefined): number {
  const r = fin(cfg?.rise, 0)
  return r < -VT_RISE_MAX ? -VT_RISE_MAX : r > VT_RISE_MAX ? VT_RISE_MAX : r
}

/** `riseCycles` bounded into its declared range. Non-finite falls back to the
 *  DEFAULT rather than to the floor: an absent key means "this config predates
 *  the feature", and that config's wave should look like a fresh one's. */
function cyclesOf(cfg: VectorTypeConfig | null | undefined): number {
  const c = fin(cfg?.riseCycles, DEFAULT_CONFIG.riseCycles)
  return c < VT_RISE_CYCLES_MIN ? VT_RISE_CYCLES_MIN : c > VT_RISE_CYCLES_MAX ? VT_RISE_CYCLES_MAX : c
}

/**
 * True when this baseline block could ever move a letter. The cheap gate every
 * caller takes BEFORE any per-glyph work, exactly as `vtBlinkActive` and
 * `vtScatterActive` are — and the reason a config with the shape off is
 * byte-identical to one from before the feature existed.
 *
 * Optional-chained throughout, and tolerant of a raw config straight out of
 * storage — a missing key, a `null`, a shape string this build has never heard
 * of. Only the editor surface ever holds a merged config; every renderer is
 * handed whatever was saved.
 */
export function vtRiseActive(cfg: VectorTypeConfig | null | undefined): boolean {
  if (!cfg) return false
  if (shapeOf(cfg) === 'off') return false
  // The CLAMPED rise, not the raw one: a stored `NaN` and a track that swung to
  // `Infinity` both mean "no rise", and this gate has to agree with `vtRiseDy`
  // about that or a caller pays for a glyph loop that returns 0 every time.
  return riseOf(cfg) !== 0
}

/**
 * One glyph's own baseline offset, in PIXELS, y-DOWN — the number that is added
 * into `VtGlyphMotion.dy`.
 *
 * `index` is the glyph's position in the run and `count` the run's length;
 * `em` is the resolved type size in pixels, which is what turns the stored
 * fraction into a distance. `rise` is a fraction of the em and not a pixel
 * count so that a design holds its proportions when Size moves — 0.25 is a
 * quarter of the type size at every size.
 *
 * Because this feeds `dy`, which `vtGlyphOffset` measures along the glyph's OWN
 * axes, a risen letter on an arc'd run leaves ITS baseline — outward from the
 * ring — rather than sliding straight down the screen. That is the
 * typographically correct reading of "raise this letter", and it is free.
 */
export function vtRiseDy(
  cfg: VectorTypeConfig | null | undefined,
  index: number,
  count: number,
  em: number,
): number {
  // Literal 0, before any hashing or arithmetic — see the header. Not `-0`
  // either: this is summed into a transform, and a value that came out of
  // arithmetic that was meant to be skipped is a value worth not producing.
  if (!vtRiseActive(cfg)) return 0

  const i = isNum(index) ? Math.max(0, Math.trunc(index)) : 0
  const n = isNum(count) ? Math.max(0, Math.trunc(count)) : 0
  // `u` walks the word, 0 → 1. A single glyph (or an empty run) has no span to
  // walk, so it sits at the start of the curve rather than dividing by zero.
  const u = n > 1 ? i / (n - 1) : 0

  const shape = shapeOf(cfg)
  const amp = riseOf(cfg)

  // Up-positive, in em, as the spec's table and `config.ts`'s doc comment write
  // them. Everything in this switch reads the way a user reads the picture.
  let offset = 0
  switch (shape) {
    case 'random': {
      const seed = Math.trunc(fin(cfg?.riseSeed, DEFAULT_CONFIG.riseSeed))
      // NO time bucket: a letter's height is fixed. See the header.
      offset = glyphRandom(i, seed, VT_RISE_CHANNEL) * 2 - 1
      break
    }
    case 'wave': {
      const phase = fin(cfg?.risePhase, DEFAULT_CONFIG.risePhase) / 360
      offset = Math.sin(2 * Math.PI * (u * cyclesOf(cfg) + phase))
      break
    }
    case 'ramp':
      // −A at the first letter, +A at the last: zero-centred, so switching it
      // on rearranges the word without sliding its visual centre.
      offset = 2 * u - 1
      break
    case 'arch': {
      const v = 2 * u - 1
      offset = 1 - 2 * v * v
      break
    }
    case 'zigzag':
      offset = i % 2 === 0 ? 1 : -1
      break
    default:
      // Unreachable — `vtRiseActive` already rejected `off` and anything
      // unknown. Present so a sixth shape added to `VT_RISE_SHAPES` without a
      // case here returns 0 rather than `undefined`.
      return 0
  }

  // THE SINGLE NEGATION. The table above is up-positive because that is how a
  // user thinks about a letter rising; `dy` is y-DOWN because that is canvas.
  // Every convention on either side of this line is consistent, and this is the
  // one place they meet.
  return -(offset * amp * fin(em, 0))
}
