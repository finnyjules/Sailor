/**
 * Vector Type — PER-GLYPH BASELINE RISE (`~/lib/vectortype/rise`).
 *
 * Each letter of a run lifted off or dropped below the run's own baseline,
 * either at random or along a curve walked across the word. Arithmetic only:
 * numbers in, pixels out, no font and no canvas — so everything this feature
 * can get wrong is visible from here.
 *
 * Four ways it fails INVISIBLY, and each has its own section below:
 *
 *  1. **A sign convention that drifts.** The control reads up-positive and `dy`
 *     is y-down, so exactly one negation stands between "Arch" and "a bowl".
 *     Nothing errors if it is missing or doubled — the word simply arranges
 *     itself upside down, and only a person looking at it would know.
 *  2. **A shared random channel.** The scatter work measured two effects on one
 *     stream at r = 1.000: the letter that blinks off is the letter that rises
 *     highest, on every word, every time. So the decorrelation is MEASURED here
 *     against the real `'blink'` and `'scatter'` channel names, not assumed.
 *  3. **A `NaN` reaching `dy`.** A non-finite rise or em produces a glyph drawn
 *     nowhere at all, and the run just loses a letter. Every guard has a case.
 *  4. **Arithmetic quietly re-tuned later.** These offsets are baked into every
 *     saved design that uses the feature. The goldens below are FROZEN: a future
 *     edit that reshuffles them fails here, in CI, rather than in the field on
 *     work somebody already approved.
 *
 * `n = 7, rise = 0.5, em = 100` throughout the goldens, so a returned pixel is
 * `-shape · 50` and each number can be checked against the spec's table by eye.
 */
import { describe, expect, it } from 'vitest'
import {
  VT_RISE_CHANNEL,
  vtRiseActive,
  vtRiseDy,
} from '~/lib/vectortype/rise'
import {
  DEFAULT_CONFIG,
  VT_RISE_CYCLES_MAX,
  VT_RISE_CYCLES_MIN,
  VT_RISE_MAX,
  VT_RISE_SHAPES,
  mergeConfig,
  type VectorTypeConfig,
  type VtRiseShape,
} from '~/lib/vectortype/config'
import { glyphRandom } from '~/lib/vectortype/random'
import { VT_BLINK_CHANNEL } from '~/lib/vectortype/blink'
import { VT_SCATTER_CHANNEL } from '~/lib/vectortype/scatter'

// ── helpers ─────────────────────────────────────────────────────────────────

/** A config carrying nothing but a baseline block. Deliberately NOT merged:
 *  `vtRiseDy` is reached with raw stored configs and with a motion track's own
 *  numbers, so the tests hand it the same shape those do. */
function cfg(over: Partial<VectorTypeConfig>): VectorTypeConfig {
  return { ...DEFAULT_CONFIG, ...over }
}

/** Every glyph's `dy` for one word length. */
function word(c: VectorTypeConfig, n: number, em = 100): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(vtRiseDy(c, i, n, em))
  return out
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

/** Pearson correlation. `1` = the two series rise and fall together exactly.
 *  Same helper as `vectortype-random.unit.spec.ts`, for the same measurement. */
function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  let sa = 0, sb = 0
  for (let i = 0; i < n; i++) { sa += a[i]!; sb += b[i]! }
  const ma = sa / n, mb = sb / n
  let cov = 0, va = 0, vb = 0
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma, db = b[i]! - mb
    cov += da * db; va += da * da; vb += db * db
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0
}

// ── 1. golden offsets ───────────────────────────────────────────────────────

describe('golden offsets — FROZEN', () => {
  // These are the pixels every saved design using this feature will draw
  // forever. They are literal on purpose: an edit to the shape arithmetic that
  // reshuffles a word must fail HERE, loudly, and not silently redraw work a
  // user already signed off. Up-positive in the spec's table, negated once into
  // y-down here, so a POSITIVE table entry appears as a NEGATIVE `dy`.
  const N = 7
  const RISE = 0.5
  const EM = 100

  it('ramp — first letter lowest, last letter highest, evenly stepped', () => {
    const got = word(cfg({ riseShape: 'ramp', rise: RISE }), N, EM)
    const want = [50, 33.333333333333336, 16.666666666666668, 0,
      -16.666666666666668, -33.333333333333336, -50]
    got.forEach((v, i) => expect(v, `glyph ${i}`).toBeCloseTo(want[i]!, 9))
  })

  it('arch — both ends down, middle up', () => {
    const got = word(cfg({ riseShape: 'arch', rise: RISE }), N, EM)
    const want = [50, -5.555555555555557, -38.88888888888889, -50,
      -38.88888888888889, -5.555555555555557, 50]
    got.forEach((v, i) => expect(v, `glyph ${i}`).toBeCloseTo(want[i]!, 9))
  })

  it('wave — one full sine across the word at cycles 1', () => {
    const got = word(cfg({ riseShape: 'wave', rise: RISE, riseCycles: 1, risePhase: 0 }), N, EM)
    const want = [0, -43.30127018922193, -43.301270189221946, 0,
      43.30127018922193, 43.30127018922193, 0]
    got.forEach((v, i) => expect(v, `glyph ${i}`).toBeCloseTo(want[i]!, 9))
  })

  it('zigzag — alternating, even glyphs up', () => {
    const got = word(cfg({ riseShape: 'zigzag', rise: RISE }), N, EM)
    const want = [-50, 50, -50, 50, -50, 50, -50]
    got.forEach((v, i) => expect(v, `glyph ${i}`).toBeCloseTo(want[i]!, 9))
  })

  it('random — the hash outputs, pinned', () => {
    const got = word(cfg({ riseShape: 'random', rise: RISE, riseSeed: 7 }), N, EM)
    // Read off `glyphRandom(i, 7, 'rise')` once and frozen. Unlike the four
    // curves above these cannot be derived by hand, which is exactly why they
    // are worth pinning: an edit to the hash, the channel name or the seed
    // handling reshuffles every saved Random arrangement, and nothing else in
    // the suite would notice.
    const want = [
      33.66017697844654,
      11.073301802389324,
      -24.22323462087661,
      16.206497279927135,
      26.930463570170105,
      -40.44377312529832,
      -13.586678844876587,
    ]
    got.forEach((v, i) => expect(v, `glyph ${i}`).toBeCloseTo(want[i]!, 9))
  })

  it('every shape stays inside ±rise·em, the range the control promises', () => {
    for (const shape of VT_RISE_SHAPES) {
      for (const v of word(cfg({ riseShape: shape, rise: RISE }), 24, EM)) {
        expect(Math.abs(v), shape).toBeLessThanOrEqual(RISE * EM + 1e-9)
      }
    }
  })

  it('the sign is UP for a positive rise — the single negation is in place', () => {
    // Ramp's last glyph is `+A` in the spec's up-positive table, so its `dy`
    // must be NEGATIVE. A missing negation and a doubled one both look like a
    // working feature; only the sign says which one shipped.
    const last = vtRiseDy(cfg({ riseShape: 'ramp', rise: 0.5 }), 6, 7, 100)
    expect(last).toBeLessThan(0)
    // ...and a negative rise flips the whole arrangement rather than doing
    // nothing, which is what makes an arch into a bowl.
    const flipped = vtRiseDy(cfg({ riseShape: 'ramp', rise: -0.5 }), 6, 7, 100)
    expect(flipped).toBeCloseTo(-last, 9)
  })
})

// ── 2. off emits nothing ────────────────────────────────────────────────────

describe('off is byte-identical to the run before this feature', () => {
  it('the shipped default is inactive', () => {
    expect(DEFAULT_CONFIG.riseShape).toBe('off')
    expect(vtRiseActive(DEFAULT_CONFIG)).toBe(false)
  })

  it('emits EXACTLY 0 — not -0, not 1e-17', () => {
    for (let i = 0; i < 8; i++) {
      // `toBe`, not `toBeCloseTo`: `dy` is summed into a transform, and a -0 or
      // a rounding crumb here is a number that came out of arithmetic that was
      // supposed to be skipped entirely.
      expect(vtRiseDy(DEFAULT_CONFIG, i, 8, 100)).toBe(0)
    }
  })

  it('emits 0 whatever the other four knobs say', () => {
    const c = cfg({ riseShape: 'off', rise: 0.9, riseCycles: 3, risePhase: 120, riseSeed: 42 })
    expect(vtRiseActive(c)).toBe(false)
    expect(vtRiseDy(c, 3, 9, 100)).toBe(0)
  })

  it('a rise of 0 is off whatever the shape says', () => {
    for (const shape of VT_RISE_SHAPES) {
      const c = cfg({ riseShape: shape, rise: 0 })
      expect(vtRiseActive(c), shape).toBe(false)
      expect(vtRiseDy(c, 2, 7, 100), shape).toBe(0)
    }
  })

  it('tolerates a config straight out of storage', () => {
    // The same tolerance `vtBlinkActive` / `vtScatterActive` hold: only the
    // editor surface ever holds a merged config.
    expect(vtRiseActive(null)).toBe(false)
    expect(vtRiseActive(undefined)).toBe(false)
    expect(vtRiseActive({} as VectorTypeConfig)).toBe(false)
    expect(vtRiseDy(null as unknown as VectorTypeConfig, 0, 4, 100)).toBe(0)
    expect(vtRiseDy({} as VectorTypeConfig, 0, 4, 100)).toBe(0)
  })

  it('an unknown shape reads as off rather than as arbitrary work', () => {
    const c = cfg({ riseShape: 'spiral' as VtRiseShape, rise: 0.5 })
    expect(vtRiseActive(c)).toBe(false)
    expect(vtRiseDy(c, 2, 7, 100)).toBe(0)
  })
})

// ── 3. determinism ──────────────────────────────────────────────────────────

describe('determinism — the preview and the bake must agree', () => {
  it('the same (index, seed) gives the same value on a second call', () => {
    const c = cfg({ riseShape: 'random', rise: 0.4, riseSeed: 12 })
    for (let i = 0; i < 32; i++) {
      expect(vtRiseDy(c, i, 32, 100)).toBe(vtRiseDy(c, i, 32, 100))
    }
  })

  it('two seeds give two different arrangements at the same rise', () => {
    const a = word(cfg({ riseShape: 'random', rise: 0.4, riseSeed: 1 }), 64)
    const b = word(cfg({ riseShape: 'random', rise: 0.4, riseSeed: 2 }), 64)
    expect(a).not.toEqual(b)
    // Not just "one letter moved": most of the word rearranges, which is what
    // a user dragging the seed slider is asking for.
    const moved = a.filter((v, i) => Math.abs(v - b[i]!) > 1).length
    expect(moved).toBeGreaterThanOrEqual(48)
    // And they are two arrangements of the same effect, not two strengths of it.
    expect(pearson(a, b)).toBeLessThan(0.4)
  })

  it('the mathematical shapes ignore the seed entirely', () => {
    for (const shape of ['wave', 'ramp', 'arch', 'zigzag'] as const) {
      const a = word(cfg({ riseShape: shape, rise: 0.4, riseSeed: 0 }), 9)
      const b = word(cfg({ riseShape: shape, rise: 0.4, riseSeed: 400 }), 9)
      expect(a, shape).toEqual(b)
    }
  })

  it('a glyph\'s height is FIXED — no time enters the hash', () => {
    // `vtRiseDy` takes no `t` at all, which is the design: a rise is a static
    // arrangement, not a flicker. Asserted through the signature by calling it
    // the only way there is and getting one answer.
    const c = cfg({ riseShape: 'random', rise: 0.4, riseSeed: 3 })
    expect(vtRiseDy.length).toBe(4)
    expect(new Set(Array.from({ length: 5 }, () => vtRiseDy(c, 4, 10, 100))).size).toBe(1)
  })
})

// ── 4. channel independence, MEASURED ───────────────────────────────────────

describe('the rise has its OWN random channel', () => {
  const N = 240
  const SEED = 11

  const rises = Array.from({ length: N }, (_, i) =>
    vtRiseDy(cfg({ riseShape: 'random', rise: 0.5, riseSeed: SEED }), i, N, 100))

  it('the channel name is a named constant, not a literal at the call site', () => {
    expect(VT_RISE_CHANNEL).toBe('rise')
    expect(VT_RISE_CHANNEL).not.toBe(VT_BLINK_CHANNEL)
    expect(VT_RISE_CHANNEL).not.toBe(VT_SCATTER_CHANNEL)
  })

  it('decorrelates from blink over 240 glyphs', () => {
    const blink = Array.from({ length: N }, (_, i) => glyphRandom(i, SEED, VT_BLINK_CHANNEL))
    expect(Math.abs(pearson(rises, blink))).toBeLessThan(0.2)
  })

  it('decorrelates from scatter over 240 glyphs', () => {
    const scatter = Array.from({ length: N }, (_, i) => glyphRandom(i, SEED, VT_SCATTER_CHANNEL))
    expect(Math.abs(pearson(rises, scatter))).toBeLessThan(0.2)
  })

  it('the CONTROL: sharing a channel would correlate at 1.000', () => {
    // Why the named constant earns its place. Read off the rise's own channel,
    // the same numbers the module uses come back perfectly correlated — so if
    // blink ever took this stream, the letter that rises highest would be the
    // letter that blinks off, on every word.
    const same = Array.from({ length: N }, (_, i) => glyphRandom(i, SEED, VT_RISE_CHANNEL))
    expect(Math.abs(pearson(rises, same))).toBeCloseTo(1, 6)
  })

  it('random fills its range rather than hugging the middle', () => {
    const lo = rises.filter(v => v < -25).length
    const hi = rises.filter(v => v > 25).length
    expect(lo).toBeGreaterThan(N * 0.15)
    expect(hi).toBeGreaterThan(N * 0.15)
  })
})

// ── 5. zero-centred ─────────────────────────────────────────────────────────

describe('a shape rearranges the letters without sliding the word', () => {
  it('ramp averages to zero across the word', () => {
    expect(mean(word(cfg({ riseShape: 'ramp', rise: 0.5 }), 12))).toBeCloseTo(0, 9)
    expect(mean(word(cfg({ riseShape: 'ramp', rise: 0.5 }), 13))).toBeCloseTo(0, 9)
  })

  it('wave averages to zero over WHOLE cycles', () => {
    // Whole cycles matter: `u` is sampled on `[0, 1]` inclusive, so a partial
    // cycle stops part-way up the sine and leaves a genuine net offset — that
    // is the shape the user asked for, not a bug, and averaging it would be
    // measuring the wrong thing. Two full cycles over 9 glyphs samples each
    // quarter symmetrically.
    expect(mean(word(cfg({ riseShape: 'wave', rise: 0.5, riseCycles: 2 }), 9))).toBeCloseTo(0, 9)
    expect(mean(word(cfg({ riseShape: 'wave', rise: 0.5, riseCycles: 1 }), 13))).toBeCloseTo(0, 9)
  })

  it('phase turns the wave rather than sliding the word', () => {
    // A phase test measured as a MEAN would be measuring the wrong thing: `u`
    // is sampled on `[0, 1]` inclusive, so a whole-cycle wave samples its start
    // phase twice, and at phase 0 that duplicate happens to be the zero
    // crossing while at phase 90 it is the peak. The property that actually
    // holds — and the one a user sees — is that phase is a rotation: a full
    // turn is the identity, and half a turn is the wave upside down.
    const at = (p: number) => word(cfg({ riseShape: 'wave', rise: 0.5, riseCycles: 2, risePhase: p }), 9)
    const base = at(0)
    at(360).forEach((v, i) => expect(v, `glyph ${i}`).toBeCloseTo(base[i]!, 9))
    at(180).forEach((v, i) => expect(v, `glyph ${i}`).toBeCloseTo(-base[i]!, 9))
  })

  it('zigzag averages to zero across an even word', () => {
    expect(mean(word(cfg({ riseShape: 'zigzag', rise: 0.5 }), 12))).toBeCloseTo(0, 9)
  })

  it('arch is SYMMETRIC about the word\'s centre, ends at -A and peak at +A', () => {
    // The spec's Tests section lists Arch with Ramp and Wave as "mean ~0". Its
    // OWN prose gives the property Arch actually has, and the one the eye
    // reads: "Arch dips to −A at both ends so its peak is paid for" — a range
    // centred on zero and a curve mirrored about the middle of the word. The
    // documented quadratic `1 − 2(2u − 1)²` cannot ALSO have zero mean: its
    // integral over `u ∈ [0, 1]` is exactly 1/3, so it sits `A/3` above the
    // baseline in the limit, and sampled at `n` even steps its mean offset is
    // exactly `A·(n − 5)/(3(n − 1))`. (`−A·cos(2πu)` is the one shape with both
    // properties, if a future revision wants them.) Asserted exactly rather
    // than to a tolerance loose enough to hide a real regression.
    const n = 13
    const A = 0.5, EM = 100
    const got = word(cfg({ riseShape: 'arch', rise: A }), n, EM)
    for (let i = 0; i < n; i++) expect(got[i], `glyph ${i}`).toBeCloseTo(got[n - 1 - i]!, 9)
    expect(got[0]).toBeCloseTo(A * EM, 9)                  // an end, down the page
    expect(got[(n - 1) / 2]).toBeCloseTo(-A * EM, 9)        // the peak, up the page
    expect(mean(got)).toBeCloseTo(-A * EM * (n - 5) / (3 * (n - 1)), 9)
  })

  it('no shape drags the word off by more than its own rise', () => {
    for (const shape of VT_RISE_SHAPES) {
      const m = mean(word(cfg({ riseShape: shape, rise: 0.5, riseCycles: 2 }), 16))
      expect(Math.abs(m), shape).toBeLessThanOrEqual(0.5 * 100)
    }
  })
})

// ── 6. edge cases ───────────────────────────────────────────────────────────

describe('nothing here can return NaN', () => {
  // A NaN `dy` moves a glyph nowhere or everywhere, silently: the run keeps
  // drawing and simply loses a letter. Every guard gets a case.
  const shapes = VT_RISE_SHAPES

  it('a single glyph has no span to walk', () => {
    for (const shape of shapes) {
      const v = vtRiseDy(cfg({ riseShape: shape, rise: 0.5 }), 0, 1, 100)
      expect(Number.isFinite(v), shape).toBe(true)
    }
  })

  it('an empty run', () => {
    for (const shape of shapes) {
      const v = vtRiseDy(cfg({ riseShape: shape, rise: 0.5 }), 0, 0, 100)
      expect(Number.isFinite(v), shape).toBe(true)
    }
  })

  it('a negative or non-finite index', () => {
    for (const shape of shapes) {
      for (const i of [-1, -99, Number.NaN, Number.POSITIVE_INFINITY]) {
        const v = vtRiseDy(cfg({ riseShape: shape, rise: 0.5 }), i, 7, 100)
        expect(Number.isFinite(v), `${shape} @ ${i}`).toBe(true)
      }
    }
  })

  it('a non-finite count', () => {
    for (const shape of shapes) {
      for (const n of [Number.NaN, Number.POSITIVE_INFINITY, -4]) {
        const v = vtRiseDy(cfg({ riseShape: shape, rise: 0.5 }), 2, n, 100)
        expect(Number.isFinite(v), `${shape} @ ${n}`).toBe(true)
      }
    }
  })

  it('a non-finite rise floors to no rise at all', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const c = cfg({ riseShape: 'ramp', rise: bad })
      expect(vtRiseActive(c)).toBe(false)
      expect(vtRiseDy(c, 0, 7, 100)).toBe(0)
    }
    expect(vtRiseDy(cfg({ riseShape: 'ramp', rise: undefined as unknown as number }), 0, 7, 100))
      .toBe(0)
  })

  it('a rise past the slider bound clamps HERE, at the render choke point', () => {
    // A motion track's `from`/`to` never pass through `mergeConfig`, so a bound
    // only the merge honours is not a bound.
    const huge = word(cfg({ riseShape: 'ramp', rise: 40 }), 7, 100)
    const atMax = word(cfg({ riseShape: 'ramp', rise: VT_RISE_MAX }), 7, 100)
    expect(huge).toEqual(atMax)
    const negHuge = word(cfg({ riseShape: 'ramp', rise: -40 }), 7, 100)
    const atMin = word(cfg({ riseShape: 'ramp', rise: -VT_RISE_MAX }), 7, 100)
    expect(negHuge).toEqual(atMin)
  })

  it('cycles clamp into their own range at the same choke point', () => {
    const w = (c: number) => word(cfg({ riseShape: 'wave', rise: 0.5, riseCycles: c }), 9)
    expect(w(500)).toEqual(w(VT_RISE_CYCLES_MAX))
    expect(w(0)).toEqual(w(VT_RISE_CYCLES_MIN))
    expect(w(-3)).toEqual(w(VT_RISE_CYCLES_MIN))
    expect(w(Number.NaN)).toEqual(w(DEFAULT_CONFIG.riseCycles))
  })

  it('a non-finite phase and a non-finite seed', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Number.isFinite(
        vtRiseDy(cfg({ riseShape: 'wave', rise: 0.5, risePhase: bad }), 2, 7, 100))).toBe(true)
      expect(Number.isFinite(
        vtRiseDy(cfg({ riseShape: 'random', rise: 0.5, riseSeed: bad }), 2, 7, 100))).toBe(true)
    }
  })

  it('a non-finite or absent em', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      for (const shape of shapes) {
        const v = vtRiseDy(cfg({ riseShape: shape, rise: 0.5 }), 2, 7, bad)
        expect(Number.isFinite(v), `${shape} @ ${bad}`).toBe(true)
      }
    }
  })

  it('a zero em is a zero offset, not a divide', () => {
    expect(vtRiseDy(cfg({ riseShape: 'ramp', rise: 0.5 }), 0, 7, 0)).toBe(0)
  })

  it('scales linearly with em, because rise is a FRACTION of it', () => {
    const at100 = word(cfg({ riseShape: 'arch', rise: 0.4 }), 8, 100)
    const at400 = word(cfg({ riseShape: 'arch', rise: 0.4 }), 8, 400)
    at100.forEach((v, i) => expect(at400[i]).toBeCloseTo(v * 4, 9))
  })
})

// ── 7. merge ────────────────────────────────────────────────────────────────

describe('schema round-trip', () => {
  it('absent keys take the defaults', () => {
    const m = mergeConfig({ text: 'hi' } as Partial<VectorTypeConfig>)
    expect(m.riseShape).toBe('off')
    expect(m.rise).toBe(0)
    expect(m.riseCycles).toBe(1)
    expect(m.risePhase).toBe(0)
    expect(m.riseSeed).toBe(0)
  })

  it('an unknown shape falls back to off rather than to a broken render', () => {
    for (const bad of ['spiral', '', 'RAMP', 42, null, undefined, {}]) {
      const m = mergeConfig({ riseShape: bad } as unknown as Partial<VectorTypeConfig>)
      expect(m.riseShape, String(bad)).toBe('off')
    }
  })

  it('every declared shape survives the merge', () => {
    for (const shape of VT_RISE_SHAPES) {
      expect(mergeConfig({ riseShape: shape } as Partial<VectorTypeConfig>).riseShape).toBe(shape)
    }
  })

  it('a saved config round-trips unchanged', () => {
    const saved = mergeConfig({
      riseShape: 'wave', rise: -0.35, riseCycles: 2.5, risePhase: 210, riseSeed: 77,
    } as Partial<VectorTypeConfig>)
    const again = mergeConfig(JSON.parse(JSON.stringify(saved)) as Partial<VectorTypeConfig>)
    expect(again.riseShape).toBe('wave')
    expect(again.rise).toBe(-0.35)
    expect(again.riseCycles).toBe(2.5)
    expect(again.risePhase).toBe(210)
    expect(again.riseSeed).toBe(77)
    // ...and it renders identically on both sides of the trip.
    expect(word(saved, 9)).toEqual(word(again, 9))
  })

  it('the merge deliberately does NOT clamp rise — the render does', () => {
    // Stated as a test so the day someone "fixes" the merge, the reason is here:
    // a motion track's `from`/`to` bypass it, so the guarantee has to live at
    // the render choke point, which both entrances go through.
    expect(mergeConfig({ rise: 40 } as Partial<VectorTypeConfig>).rise).toBe(40)
    expect(vtRiseDy(cfg({ riseShape: 'ramp', rise: 40 }), 0, 7, 100))
      .toBe(vtRiseDy(cfg({ riseShape: 'ramp', rise: VT_RISE_MAX }), 0, 7, 100))
  })
})
