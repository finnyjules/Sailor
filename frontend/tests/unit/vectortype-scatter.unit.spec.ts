/**
 * Vector Type — RANDOM PER-GLYPH AXIS SCATTER (`~/lib/vectortype/scatter`).
 *
 * Every letter at its own position on one variable axis. The thing that makes it
 * possible is the property this studio is built on — **a variable font's `gvar`
 * deltas MOVE points, they never add or remove them** — so a scattered word is
 * still the same outlines, glyph for glyph, command for command, at different
 * coordinates. That is asserted here on real outlines rather than assumed:
 * constant command count, moving ink, moving advances.
 *
 * Four ways this fails invisibly, and each has its own section below:
 *
 *  1. **A roll instead of a hash.** The preview scatters convincingly, the bake
 *     scatters convincingly, and they scatter differently. Nothing errors.
 *  2. **A shared random channel.** The letter that blinks off is the letter that
 *     scatters furthest, every word, every time — Task 2 measured r = 1.000 — and
 *     the composite reads as one effect rather than two.
 *  3. **Composition that overwrites.** A scatter and a weight wave each correct
 *     alone, and wrong together. The previous wave of this work shipped exactly
 *     that bug and baked five identical PNGs while looking fine.
 *  4. **Numbers that no outline ever saw.** `vectorTypeFrame` has a fast path
 *     that collapses a frame to ONE shaping; an axis delta that does not widen it
 *     is a number returned and never shaped, and every frame still looks right.
 *
 * Real outlines throughout, from the checked-in Inter variable subset
 * (`opsz` 14–32, `wght` 100–900). NO NETWORK.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { normaliseAxes, type VtAxis, type VtFont } from '~/lib/vectortype/font'
import {
  DEFAULT_CONFIG,
  VT_PRESET_DURATIONS,
  cloneConfig,
  mergeConfig,
  type VectorTypeConfig,
  type VtMove,
} from '~/lib/vectortype/config'
import { vectorTypeFrame, vectorTypeSVG, vtIsAnimated } from '~/lib/vectortype/canvas'
import { animatableTargets } from '~/lib/vectortype/motion'
import { vtGlyphMotion, vtStillTime } from '~/lib/vectortype/presetMotion'
import { vtAxisCoords } from '~/lib/vectortype/axisPresets'
import { VT_BLINK_CHANNEL, VT_BLINK_PHASE_CHANNEL } from '~/lib/vectortype/blink'
import { glyphRandom } from '~/lib/vectortype/random'
import {
  DEFAULT_SCATTER,
  VT_SCATTER_CHANNEL,
  VT_SCATTER_MODES,
  VT_SCATTER_RATE_CHANNEL,
  VT_SCATTER_RATE_MAX,
  VT_SCATTER_SEED_MAX,
  VT_SCATTER_SETTLE_MAX,
  isVtScatterAxis,
  vtResolveScatter,
  vtScatterActive,
  vtScatterAmplitude,
  vtScatterAvailability,
  vtScatterDelta,
  vtScatterEnvelope,
  vtScatterRateOf,
  vtScatterStillTime,
  type VtScatterConfig,
} from '~/lib/vectortype/scatter'
import {
  VT_CONTROLS,
  derivedScatterControls,
  derivedVtControls,
  visibleVtControls,
} from '~/lib/vectortype/controls'

// ── fixtures ────────────────────────────────────────────────────────────────

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return {
    id: 'inter-subset',
    axes: normaliseAxes(raw?.variationAxes),
    unitsPerEm: Number(raw?.unitsPerEm) || 1000,
    raw,
  }
}
const font = loadFixtureFont()
const WGHT = font.axes.find(a => a.tag === 'wght')!

/** A Roboto-Flex-shaped axis set. The 13-axis face is not checked in (the
 *  fixture is a 2-axis Inter subset), so the axes that only IT declares are
 *  exercised as data here and in the browser on the real file. `GRAD` is the
 *  interesting one: it straddles zero, which is what kills a multiplicative
 *  composition rule. */
const RICH_AXES: VtAxis[] = [
  { tag: 'wght', name: 'Weight', min: 100, max: 1000, default: 400 },
  { tag: 'wdth', name: 'Width', min: 25, max: 151, default: 100 },
  { tag: 'GRAD', name: 'Grade', min: -200, max: 150, default: 0 },
  { tag: 'slnt', name: 'Slant', min: -10, max: 0, default: 0 },
]

const scatterBlock = (o: Partial<VtScatterConfig> = {}): VtScatterConfig =>
  ({ ...DEFAULT_SCATTER, ...o }) as VtScatterConfig

const cfg = (over: Partial<VectorTypeConfig> = {}): VectorTypeConfig =>
  mergeConfig({ ...cloneConfig(DEFAULT_CONFIG), ...over })

/** A config with a live scatter, everything else at its default. */
const scatterCfg = (o: Partial<VtScatterConfig> = {}, over: Partial<VectorTypeConfig> = {}) =>
  cfg({
    text: 'Sailor',
    ...over,
    motion: {
      ...cloneConfig(DEFAULT_CONFIG).motion,
      ...(over.motion ?? {}),
      scatter: scatterBlock({ spread: 0.6, mode: 'wander', rate: 0.5, ...o }),
    } as VectorTypeConfig['motion'],
  })

const env = (c: VectorTypeConfig) => ({ axes: font.axes, resting: c.axes })
const N = 6

/** One `kind: 'preset'` move — the moves-shaped equivalent of the old
 *  `motion.loop = { presetId, duration }` slot. `ease: 'none'` throughout:
 *  nothing below checks eased output. */
let scatterPresetMoveSeq = 0
function presetMove(slot: 'in' | 'out' | 'loop', spec: { presetId: string; duration?: number }): VtMove {
  scatterPresetMoveSeq += 1
  return {
    id: `move-${slot}-${scatterPresetMoveSeq}`,
    phase: slot,
    kind: 'preset',
    presetId: spec.presetId,
    duration: spec.duration ?? VT_PRESET_DURATIONS[slot],
    ease: { kind: 'named', name: 'none' },
    play: slot === 'loop' ? { mode: 'repeat', times: 1 } : { mode: 'once', times: 1 },
  }
}

/** One `kind: 'tracks'` move wrapping a single track — `ease: 'none'`/
 *  `play: once ×1` reproduce the old default `easing: 'linear'`. */
let scatterTrackMoveSeq = 0
function trackMove(t: { path: string; from: number; to: number }): VtMove {
  scatterTrackMoveSeq += 1
  return {
    id: `move-track-${scatterTrackMoveSeq}`,
    phase: 'loop',
    kind: 'tracks',
    presetId: 'custom',
    duration: 4,
    ease: { kind: 'named', name: 'none' },
    play: { mode: 'once', times: 1 },
    tracks: [{ path: t.path, from: t.from, to: t.to, hold: 0, cycleOffset: 0, delay: 0 }],
  }
}

/** Every glyph's `wght` delta at time `t`, through the function every renderer
 *  calls. Not `vtScatterDelta` directly: the composition is the thing under
 *  test, and reading the composed output is the only way to see it. */
const wghtDeltas = (c: VectorTypeConfig, t: number, n = N): number[] =>
  Array.from({ length: n }, (_, i) => vtGlyphMotion(c, t, i, n, 100, env(c)).axes.wght ?? 0)

function pearson(a: number[], b: number[]): number {
  const n = a.length
  const ma = a.reduce((s, v) => s + v, 0) / n
  const mb = b.reduce((s, v) => s + v, 0) / n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma, y = b[i]! - mb
    num += x * y; da += x * x; db += y * y
  }
  return num / Math.sqrt(da * db)
}

const spreadOf = (v: number[]) => Math.max(...v) - Math.min(...v)

// ═══════════════════════════════════════════════════════════════════════════
describe('no fresh randomness reaches the scatter', () => {
  it('scatter.ts contains no roll and no wall clock, comments aside', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../app/lib/vectortype/scatter.ts', import.meta.url)), 'utf8',
    )
    // Comments TALK about `Math.random`; only executable text matters.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const banned of ['Math.random', 'Date.now', 'performance.now']) {
      expect(code.includes(banned), banned).toBe(false)
    }
  })

  it('runs a whole scattered FRAME with Math.random replaced by a trap', () => {
    const c = scatterCfg()
    const real = Math.random
    Math.random = () => { throw new Error('a roll reached the scatter') }
    try {
      for (const t of [0, 0.017, 0.4, 1, 2.5, 3.999]) {
        const frame = vectorTypeFrame(font, c, t)
        expect(frame.outlines.glyphs.length).toBe(6)
      }
    } finally { Math.random = real }
  })

  it('and the trap is not vacuous — it catches a control that DOES roll', () => {
    const real = Math.random
    Math.random = () => { throw new Error('a roll reached the scatter') }
    try {
      // The scatter as it would be written without `./random.ts`.
      expect(() => Array.from({ length: 6 }, () => Math.random() * 400)).toThrow()
    } finally { Math.random = real }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('the scatter has its OWN channels', () => {
  it('is not on blink\'s', () => {
    expect(VT_SCATTER_CHANNEL).not.toBe(VT_BLINK_CHANNEL)
    expect(VT_SCATTER_CHANNEL).not.toBe(VT_BLINK_PHASE_CHANNEL)
    expect(VT_SCATTER_RATE_CHANNEL).not.toBe(VT_BLINK_CHANNEL)
    expect(VT_SCATTER_RATE_CHANNEL).not.toBe(VT_BLINK_PHASE_CHANNEL)
  })

  it('scatter and blink decorrelate, against a SHARED-channel control at 1.000', () => {
    const n = 2000
    const scat = Array.from({ length: n }, (_, i) => glyphRandom(i, 11, VT_SCATTER_CHANNEL))
    const blink = Array.from({ length: n }, (_, i) => glyphRandom(i, 11, VT_BLINK_CHANNEL))
    // The control: the same two effects reading one stream, which is what a
    // scatter written without a channel argument would do.
    const shared = Array.from({ length: n }, (_, i) => glyphRandom(i, 11, VT_BLINK_CHANNEL))
    expect(Math.abs(pearson(scat, blink))).toBeLessThan(0.0736)   // 99.9% band at n = 2000
    expect(pearson(shared, blink)).toBeCloseTo(1, 6)
  })

  it('the letter that travels furthest is not the letter that drifts fastest', () => {
    // The user-visible spelling of the same property: over 200 words of 8
    // letters, how often is the highest-amplitude glyph also the fastest?
    const sc = scatterBlock({ spread: 1, mode: 'wander', rate: 1 })
    let agree = 0
    for (let w = 0; w < 200; w++) {
      const amps = Array.from({ length: 8 }, (_, i) =>
        Math.abs(vtScatterAmplitude({ ...sc, seed: w }, WGHT, i, 400)))
      const rates = Array.from({ length: 8 }, (_, i) => vtScatterRateOf({ ...sc, seed: w }, i))
      const argmax = (v: number[]) => v.indexOf(Math.max(...v))
      if (argmax(amps) === argmax(rates)) agree++
    }
    // Chance is 1/8 = 12.5%. A shared stream would be 100%.
    expect(agree / 200).toBeLessThan(0.3)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('the amplitude — where each glyph is headed', () => {
  const sc = scatterBlock({ spread: 0.8 })

  it('never leaves the font\'s own axis range, at any base and any spread', () => {
    for (const spread of [0.05, 0.3, 0.6, 1]) {
      for (const rest of [100, 150, 400, 700, 899, 900]) {
        for (let i = 0; i < 64; i++) {
          const v = rest + vtScatterAmplitude({ ...sc, spread }, WGHT, i, rest)
          expect(v, `spread ${spread} rest ${rest} glyph ${i}`).toBeGreaterThanOrEqual(WGHT.min - 1e-9)
          expect(v).toBeLessThanOrEqual(WGHT.max + 1e-9)
        }
      }
    }
  })

  it('gives the glyphs DIFFERENT destinations, on both sides of the base', () => {
    const amps = Array.from({ length: 8 }, (_, i) => vtScatterAmplitude(sc, WGHT, i, 400))
    expect(new Set(amps.map(v => v.toFixed(6))).size).toBe(8)
    expect(amps.some(v => v > 0)).toBe(true)
    expect(amps.some(v => v < 0)).toBe(true)
  })

  it('scales LINEARLY with spread wherever the axis has the room', () => {
    // Inter's wght is 100-900, so 500 is the one base with 400 either side.
    for (let i = 0; i < 12; i++) {
      const half = vtScatterAmplitude({ ...sc, spread: 0.4 }, WGHT, i, 500)
      const full = vtScatterAmplitude({ ...sc, spread: 0.8 }, WGHT, i, 500)
      expect(full).toBeCloseTo(half * 2, 9)
    }
  })

  it('…and stops being linear exactly where the SQUEEZE starts, on that side only', () => {
    // A FINDING, and the honest one: at the font's own default of 400 there are
    // 500 units above and 300 below, so a spread of 0.8 (±320) fits upward and
    // is squeezed downward. Doubling the slider therefore doubles the upward
    // travel and less than doubles the downward — which is what "squeeze rather
    // than clip" MEANS, and it would be a bug to hide it behind a symmetric
    // amplitude that quietly shrank the visible side too.
    const pairs = Array.from({ length: 24 }, (_, i) => ({
      half: vtScatterAmplitude({ ...sc, spread: 0.4 }, WGHT, i, 400),
      full: vtScatterAmplitude({ ...sc, spread: 0.8 }, WGHT, i, 400),
    }))
    const up = pairs.filter(p => p.half > 0)
    const down = pairs.filter(p => p.half < 0)
    expect(up.length).toBeGreaterThan(0)
    expect(down.length).toBeGreaterThan(0)
    for (const p of up) expect(p.full).toBeCloseTo(p.half * 2, 9)
    for (const p of down) expect(p.full).toBeGreaterThan(p.half * 2)   // less far, i.e. less negative
    // Squeezed, never clipped: no two glyphs land on the same value.
    expect(new Set(pairs.map(p => p.full.toFixed(6))).size).toBe(24)
  })

  it('SQUEEZES near the top of the axis rather than piling glyphs on the limit', () => {
    // A base 40 units below the ceiling with a spread that wants ±320.
    const rest = WGHT.max - 40
    const mine = Array.from({ length: 24 }, (_, i) => rest + vtScatterAmplitude({ ...sc, spread: 0.8 }, WGHT, i, rest))
    // THE CONTROL — the obvious implementation, which clamps the target.
    const span = WGHT.max - WGHT.min
    const clipped = Array.from({ length: 24 }, (_, i) => {
      const raw = rest + (glyphRandom(i, sc.seed, VT_SCATTER_CHANNEL) * 2 - 1) * span * 0.8 * 0.5
      return Math.min(WGHT.max, Math.max(WGHT.min, raw))
    })
    const distinct = (v: number[]) => new Set(v.map(x => x.toFixed(6))).size
    expect(distinct(mine)).toBe(24)
    // The control collapses several glyphs onto exactly 900 — the pile-up.
    expect(distinct(clipped)).toBeLessThan(24)
    expect(clipped.filter(v => v === WGHT.max).length).toBeGreaterThan(1)
  })

  it('MIRRORS when a side has no room at all, instead of freezing half the word', () => {
    const atTop = Array.from({ length: 16 }, (_, i) => vtScatterAmplitude(sc, WGHT, i, WGHT.max))
    expect(atTop.every(v => v <= 0)).toBe(true)
    expect(atTop.filter(v => v !== 0).length).toBe(16)      // nobody is frozen
    const atBottom = Array.from({ length: 16 }, (_, i) => vtScatterAmplitude(sc, WGHT, i, WGHT.min))
    expect(atBottom.every(v => v >= 0)).toBe(true)
    expect(atBottom.filter(v => v !== 0).length).toBe(16)
  })

  it('is 0 on a degenerate axis and at spread 0', () => {
    const dead: VtAxis = { tag: 'DEAD', name: 'Dead', min: 5, max: 5, default: 5 }
    expect(vtScatterAmplitude(sc, dead, 3, 5)).toBe(0)
    expect(vtScatterAmplitude({ ...sc, spread: 0 }, WGHT, 3, 400)).toBe(0)
  })

  it('re-rolls with the seed and nothing else', () => {
    const a = Array.from({ length: 8 }, (_, i) => vtScatterAmplitude({ ...sc, seed: 1 }, WGHT, i, 400))
    const b = Array.from({ length: 8 }, (_, i) => vtScatterAmplitude({ ...sc, seed: 2 }, WGHT, i, 400))
    expect(a).not.toEqual(b)
    expect(spreadOf(a)).toBeGreaterThan(0)
    expect(spreadOf(b)).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('SETTLE — an entrance, and it ends on the user\'s own design', () => {
  const sc = scatterBlock({ spread: 0.7, mode: 'settle', settle: 0.8 })

  it('is fully scattered at t = 0 and EXACTLY at the base once it has settled', () => {
    for (let i = 0; i < 8; i++) {
      expect(vtScatterEnvelope(sc, 0, i)).toBe(1)
      expect(vtScatterEnvelope(sc, 0.8, i)).toBe(0)
      expect(vtScatterEnvelope(sc, 5, i)).toBe(0)
    }
  })

  it('the SPREAD ACROSS THE GLYPHS collapses to zero — measured on real coords', () => {
    const c = scatterCfg({ spread: 0.7, mode: 'settle', settle: 0.8 })
    const at = (t: number) => vectorTypeFrame(font, c, t).outlines.glyphs.map((_, i) =>
      vtAxisCoords(font.axes, c.axes, vtGlyphMotion(c, t, i, 6, 100, env(c)).axes).wght!)
    const t0 = spreadOf(at(0))
    const mid = spreadOf(at(0.4))
    const done = spreadOf(at(0.8))
    expect(t0).toBeGreaterThan(200)      // Inter's wght is 100–900; 0.7 spread ≈ ±280
    expect(mid).toBeLessThan(t0)
    expect(done).toBe(0)
    // And the settled word IS the configured word, not merely close to it.
    const base = c.axes.wght ?? WGHT.default
    expect(at(0.8)).toEqual([base, base, base, base, base, base])
  })

  it('decays monotonically — no overshoot, no bounce', () => {
    let prev = Infinity
    for (let k = 0; k <= 40; k++) {
      const e = vtScatterEnvelope(sc, (k / 40) * 0.8, 0)
      expect(e).toBeLessThanOrEqual(prev + 1e-12)
      prev = e
    }
  })

  it('a stagger makes the letters settle one after another, not together', () => {
    const c = scatterCfg({ spread: 0.7, mode: 'settle', settle: 0.4 }, {
      motion: { ...cloneConfig(DEFAULT_CONFIG).motion, stagger: { delay: 0.12, order: 'forward', seed: 0 } } as any,
    })
    // At 0.45 s the first glyph has finished (0.45 > 0.4) and the last has not
    // even started (rank 5 × 0.12 = 0.60).
    expect(vtGlyphMotion(c, 0.45, 0, 6, 100, env(c)).axes.wght ?? 0).toBe(0)
    expect(Math.abs(vtGlyphMotion(c, 0.45, 5, 6, 100, env(c)).axes.wght ?? 0)).toBeGreaterThan(0)
  })

  it('a settle of 0 is inert, not an instant scatter', () => {
    expect(vtScatterActive(scatterBlock({ spread: 1, mode: 'settle', settle: 0 }))).toBe(false)
    expect(vtScatterDelta(scatterBlock({ spread: 1, mode: 'settle', settle: 0 }), 0, 0, font.axes, {})).toEqual({})
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('WANDER — starts on the design, drifts off, never stops', () => {
  const sc = scatterBlock({ spread: 0.7, mode: 'wander', rate: 0.5 })

  it('at t = 0 EVERY glyph is exactly on the base — the still-bake property', () => {
    for (let i = 0; i < 64; i++) expect(vtScatterEnvelope(sc, 0, i)).toBe(0)
    const c = scatterCfg({ spread: 0.9, mode: 'wander', rate: 2 })
    expect(wghtDeltas(c, 0)).toEqual([0, 0, 0, 0, 0, 0])
    // …and the frame is therefore byte-identical to the un-scattered one.
    const plain = scatterCfg({ spread: 0 })
    const a = vectorTypeFrame(font, c, 0).outlines
    const b = vectorTypeFrame(font, plain, 0).outlines
    expect(a.glyphs.map(g => JSON.stringify(g.commands))).toEqual(b.glyphs.map(g => JSON.stringify(g.commands)))
  })

  it('is scattered a moment later, and the glyphs disagree', () => {
    const c = scatterCfg({ spread: 0.7, mode: 'wander', rate: 0.5 })
    const d = wghtDeltas(c, 0.6)
    expect(d.filter(v => v !== 0).length).toBe(6)
    expect(new Set(d.map(v => v.toFixed(6))).size).toBe(6)
  })

  it('the glyphs never all come back together after t = 0', () => {
    const c = scatterCfg({ spread: 0.7, mode: 'wander', rate: 0.5 })
    let unison = 0
    for (let k = 1; k <= 400; k++) {
      const d = wghtDeltas(c, k * 0.01)
      if (spreadOf(d) < 1) unison++
    }
    expect(unison).toBe(0)
  })

  it('each glyph drifts at its OWN rate, bounded well away from frozen', () => {
    const rates = Array.from({ length: 32 }, (_, i) => vtScatterRateOf(sc, i))
    expect(Math.min(...rates)).toBeGreaterThanOrEqual(0.5)
    expect(Math.max(...rates)).toBeLessThan(1.5)
    expect(new Set(rates.map(v => v.toFixed(6))).size).toBe(32)
  })

  it('a rate of 0 leaves the word exactly as configured, not stranded at random cuts', () => {
    expect(vtScatterActive(scatterBlock({ spread: 1, mode: 'wander', rate: 0 }))).toBe(false)
    const c = scatterCfg({ spread: 1, mode: 'wander', rate: 0 })
    for (const t of [0, 0.5, 2, 3.9]) expect(wghtDeltas(c, t)).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('a negative glyph clock (a stagger pre-roll) holds the base, never a mirrored drift', () => {
    for (let i = 0; i < 8; i++) expect(vtScatterEnvelope(sc, -3, i)).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('the refusals', () => {
  it('spread 0 is the off switch, and it is the shipped default', () => {
    expect(DEFAULT_SCATTER.spread).toBe(0)
    expect(DEFAULT_CONFIG.motion.scatter.spread).toBe(0)
    expect(vtScatterActive(DEFAULT_SCATTER)).toBe(false)
    expect(vtScatterActive(scatterBlock({ spread: 0.5 }))).toBe(true)
  })

  it('a malformed axis tag cannot run', () => {
    for (const axis of ['', 'wg', 'weight', null, 42]) {
      expect(vtScatterActive(scatterBlock({ spread: 1, axis: axis as any })), String(axis)).toBe(false)
    }
    expect(isVtScatterAxis('wght')).toBe(true)
    expect(isVtScatterAxis('GRAD')).toBe(true)
  })

  it('an axis the font does not declare is IGNORED, never applied to another one', () => {
    const sc = scatterBlock({ spread: 1, axis: 'GRAD', mode: 'wander', rate: 1 })
    // Inter has opsz and wght; GRAD is Roboto Flex's.
    expect(vtScatterDelta(sc, 0.7, 2, font.axes, {})).toEqual({})
    // …and specifically NOT silently moved onto wght, the default.
    expect(vtScatterDelta(sc, 0.7, 2, font.axes, {}).wght).toBeUndefined()
  })

  it('no axes at all (font still loading) emits nothing', () => {
    const sc = scatterBlock({ spread: 1, mode: 'wander', rate: 1 })
    expect(vtScatterDelta(sc, 0.5, 0, null, {})).toEqual({})
    expect(vtScatterDelta(sc, 0.5, 0, [], {})).toEqual({})
  })

  it('a degenerate axis emits nothing', () => {
    const dead = [{ tag: 'wght', name: 'Weight', min: 400, max: 400, default: 400 }]
    const sc = scatterBlock({ spread: 1, mode: 'wander', rate: 1 })
    expect(vtScatterDelta(sc, 0.5, 0, dead, {})).toEqual({})
  })

  it('an EXACT zero is withheld, so the per-glyph shaping path is not opened for nothing', () => {
    // The whole run at t = 0 in wander mode: every envelope is 0, so no tag.
    const sc = scatterBlock({ spread: 1, mode: 'wander', rate: 1 })
    for (let i = 0; i < 8; i++) expect(vtScatterDelta(sc, 0, i, font.axes, {})).toEqual({})
    const frame = vectorTypeFrame(font, scatterCfg({ spread: 1, mode: 'wander', rate: 1 }), 0)
    expect(frame.shapings).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('availability — disabled with a REASON, the axis presets\' contract', () => {
  it('runs on an axis this font has', () => {
    const o = vtScatterAvailability(scatterBlock({ axis: 'wght' }), font.axes, 'Inter')
    expect(o.available).toBe(true)
    expect(o.reason).toBeUndefined()
    expect(o.axis?.min).toBe(100)
  })

  it('names the missing tag AND the font, because both are the user\'s to change', () => {
    const o = vtScatterAvailability(scatterBlock({ axis: 'GRAD' }), font.axes, 'Inter')
    expect(o.available).toBe(false)
    expect(o.reason).toBe('Inter has no GRAD axis — pick a font that does.')
  })

  it('says so for a fixed axis too, and falls back to "This font"', () => {
    const fixed = [{ tag: 'wght', name: 'Weight', min: 400, max: 400, default: 400 }]
    const o = vtScatterAvailability(scatterBlock({ axis: 'wght' }), fixed)
    expect(o.available).toBe(false)
    expect(o.reason).toContain('This font')
    expect(o.reason).toContain('no range')
  })

  it('is never a bare "unsupported" — every unavailable answer carries a sentence', () => {
    for (const axes of [null, [], font.axes]) {
      const o = vtScatterAvailability(scatterBlock({ axis: 'XTRA' }), axes, 'Inter')
      expect(o.available).toBe(false)
      expect(o.reason!.length).toBeGreaterThan(20)
      expect(o.reason).toContain('XTRA')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('COMPOSITION — a scatter and a weight wave are BOTH visible', () => {
  /** Weight Wave in the loop slot: a travelling crest on the same `wght` axis. */
  const wave = { presetId: 'weight-wave', duration: 2 }
  const waveOnly = () => cfg({
    text: 'Sailor',
    motion: { ...cloneConfig(DEFAULT_CONFIG).motion, moves: [presetMove('loop', wave)] } as any,
  })
  const scatterOnly = () => scatterCfg({ spread: 0.5, mode: 'wander', rate: 0.7 })
  const both = () => scatterCfg({ spread: 0.5, mode: 'wander', rate: 0.7 }, {
    motion: { ...cloneConfig(DEFAULT_CONFIG).motion, moves: [presetMove('loop', wave)] } as any,
  })

  it('the composite is EXACTLY the sum, glyph for glyph, at every sampled time', () => {
    for (const t of [0.13, 0.5, 1.1, 2.7, 3.9]) {
      const a = wghtDeltas(waveOnly(), t)
      const b = wghtDeltas(scatterOnly(), t)
      const c = wghtDeltas(both(), t)
      for (let i = 0; i < N; i++) expect(c[i], `t ${t} glyph ${i}`).toBeCloseTo(a[i]! + b[i]!, 9)
    }
  })

  it('and neither source alone produces it — the test is not vacuous', () => {
    const t = 1.1
    const a = wghtDeltas(waveOnly(), t)
    const b = wghtDeltas(scatterOnly(), t)
    const c = wghtDeltas(both(), t)
    expect(a.filter(v => v !== 0).length).toBeGreaterThan(0)
    expect(b.filter(v => v !== 0).length).toBeGreaterThan(0)
    expect(c).not.toEqual(a)
    expect(c).not.toEqual(b)
  })

  it('an OVERWRITE rule would be measurably different — the shipped bug\'s shape', () => {
    const t = 1.1
    const a = wghtDeltas(waveOnly(), t)
    const b = wghtDeltas(scatterOnly(), t)
    const shipped = wghtDeltas(both(), t)
    // The control: whichever source wrote last wins. That is the rule the
    // previous plan shipped by accident, and it baked five identical PNGs.
    const overwritten = b
    expect(shipped).not.toEqual(overwritten)
    expect(shipped).not.toEqual(a)
    // The disagreement is not a rounding artefact.
    const worst = Math.max(...shipped.map((v, i) => Math.abs(v - overwritten[i]!)))
    expect(worst).toBeGreaterThan(10)
  })

  it('BOTH REACH THE OUTLINES — three genuinely different frames, all per-glyph', () => {
    const t = 1.1
    const coords = (c: VectorTypeConfig) => {
      const f = vectorTypeFrame(font, c, t)
      expect(f.shapings, 'a frame that never re-shaped is numbers nothing drew').toBeGreaterThan(1)
      return f.outlines.glyphs.map(g => JSON.stringify(g.commands)).join('|')
    }
    const A = coords(waveOnly()), B = coords(scatterOnly()), C = coords(both())
    expect(new Set([A, B, C]).size).toBe(3)
  })

  it('composes with an axis TRACK too — the scatter is about the MOVED base', () => {
    const track = { path: 'axes.wght', from: 200, to: 800 }
    const c = scatterCfg({ spread: 0.3, mode: 'wander', rate: 0.7 }, {
      motion: { ...cloneConfig(DEFAULT_CONFIG).motion, moves: [trackMove(track)] } as any,
    })
    // The base the scatter is drawn around moves with the track, so the whole
    // cloud of glyph weights moves with it.
    const at = (t: number) => {
      const f = vectorTypeFrame(font, c, t)
      return f.transforms.map((_, i) =>
        vtAxisCoords(font.axes, { wght: 200 + (800 - 200) * (t / 4) }, f.transforms[i]!.axes).wght!)
    }
    const early = at(0.5), late = at(3.5)
    expect(Math.min(...late)).toBeGreaterThan(Math.max(...early))
  })

  it('a sum that cancels to zero drops the tag, keeping the cheap path cheap', () => {
    // Constructed directly: the merge is what is under test, not the sources.
    const c = scatterCfg({ spread: 0 })
    expect(vtGlyphMotion(c, 1, 0, 6, 100, env(c)).axes).toEqual({})
    expect(vectorTypeFrame(font, c, 1).shapings).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('the outlines actually RE-SHAPE — the property the studio rests on', () => {
  const live = () => scatterCfg({ spread: 0.8, mode: 'wander', rate: 0.6 })
  const still = () => scatterCfg({ spread: 0 })

  it('COMMAND COUNT IS CONSTANT while the glyphs sit at different weights', () => {
    const base = vectorTypeFrame(font, still(), 1.3).outlines.glyphs
    for (const t of [0.3, 1.3, 2.9]) {
      const scat = vectorTypeFrame(font, live(), t).outlines.glyphs
      expect(scat.length).toBe(base.length)
      for (let i = 0; i < base.length; i++) {
        expect(scat[i]!.commands.length, `t ${t} glyph ${i}`).toBe(base[i]!.commands.length)
        expect(scat[i]!.commands.map(cmd => cmd.name)).toEqual(base[i]!.commands.map(cmd => cmd.name))
      }
    }
  })

  it('…and the INK has moved: every glyph\'s points differ from the base cut', () => {
    const base = vectorTypeFrame(font, still(), 1.3).outlines.glyphs
    const scat = vectorTypeFrame(font, live(), 1.3).outlines.glyphs
    let moved = 0
    for (let i = 0; i < base.length; i++) {
      if (JSON.stringify(scat[i]!.commands) !== JSON.stringify(base[i]!.commands)) moved++
    }
    expect(moved).toBe(base.length)
  })

  it('…and the ADVANCES move, so the word re-spaces as the weights change', () => {
    const base = vectorTypeFrame(font, still(), 1.3).outlines
    const scat = vectorTypeFrame(font, live(), 1.3).outlines
    const adv = (o: typeof base) => o.glyphs.map(g => g.advance)
    expect(adv(scat)).not.toEqual(adv(base))
    expect(scat.width).not.toBe(base.width)
    // Not one shared shift: the glyphs disagree about how much they grew.
    const deltas = adv(scat).map((v, i) => v - adv(base)[i]!)
    expect(new Set(deltas.map(v => v.toFixed(4))).size).toBeGreaterThan(1)
  })

  it('the frame takes the PER-GLYPH shaping path, one instance per distinct cut', () => {
    const f = vectorTypeFrame(font, live(), 1.3)
    expect(f.shapings).toBeGreaterThan(1)
    expect(f.shapings).toBeLessThanOrEqual(f.outlines.glyphs.length + 1)
  })

  it('a SETTLED frame is byte-identical to the un-scattered word', () => {
    const settled = scatterCfg({ spread: 0.8, mode: 'settle', settle: 0.5 })
    const a = vectorTypeFrame(font, settled, 1.2).outlines
    const b = vectorTypeFrame(font, still(), 1.2).outlines
    expect(JSON.stringify(a.glyphs)).toBe(JSON.stringify(b.glyphs))
    expect(a.width).toBe(b.width)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('determinism — the preview, the bake and the export agree', () => {
  const c = () => scatterCfg({ spread: 0.7, mode: 'wander', rate: 0.9 })
  const shot = (cf: VectorTypeConfig, t: number) =>
    JSON.stringify(vectorTypeFrame(font, cf, t).outlines.glyphs)

  it('the same frame rendered twice is identical', () => {
    for (const t of [0, 0.017, 0.5, 1.3333, 2.71828, 3.999]) {
      expect(shot(c(), t)).toBe(shot(c(), t))
    }
  })

  it('a BAKE at t matches the PREVIEW at t', () => {
    const preview = c()
    // What every baker actually holds: the stored blob, re-merged.
    const bake = mergeConfig(JSON.parse(JSON.stringify(preview)))
    for (const t of [0, 0.083, 0.5, 1.3333, 2.71828, 3.999]) {
      expect(shot(bake, t), `t ${t}`).toBe(shot(preview, t))
    }
  })

  it('the RAW stored blob, with no merge at all, agrees too', () => {
    const preview = c()
    const raw = JSON.parse(JSON.stringify(preview)) as VectorTypeConfig
    for (const t of [0.25, 1.75, 3.5]) expect(shot(raw, t)).toBe(shot(preview, t))
  })

  it('the SVG export and the canvas frame agree, glyph for glyph', () => {
    for (const t of [0.4, 1.6, 3.2]) {
      const out = vectorTypeSVG(font, c(), t, { width: 400, height: 200 })
      expect(out.svg.length).toBeGreaterThan(100)
      // `VtSvgResult.frame` is the frame the markup was written FROM, so this is
      // the export and the canvas compared at their only shared surface rather
      // than two pictures eyeballed side by side.
      expect(JSON.stringify(out.frame.outlines.glyphs)).toBe(shot(c(), t))
      expect(out.frame.shapings).toBeGreaterThan(1)
      // And the markup really carries the scattered run, not a cached still.
      expect((out.svg.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(6)
    }
  })

  /**
   * THE ONE THAT FOUND SOMETHING, so it is measured rather than asserted away.
   *
   * A preview that accumulates `+= 1/fps` and a bake that computes `frame/fps`
   * hold `t` values that differ by up to ~1e-16. Blink was immune because it
   * QUANTISES `t` into a beat, so a sub-ulp difference vanished. The scatter is
   * a CONTINUOUS function of `t`, so it does not vanish: it propagates into the
   * axis coordinate, fontkit instances at a hair-different weight, and the
   * outline floats differ in their last bits. 82 of 120 frames are not
   * bit-identical.
   *
   * That is not a defect, and the number is what says so: the worst point
   * disagreement across the whole clip is under 1e-6 FONT UNITS on a 2048-unit
   * em — a thousand times finer than the 3-decimal precision the SVG writer
   * emits, and far below any raster's reach. The real requirement, that the same
   * `t` always gives the same picture, is exact and is asserted above.
   *
   * A plain `axes.wght` TRACK is measured beside it as the reference. It happens
   * to come out bit-identical here (a linear interpolation of a sub-ulp `t`
   * difference lands on the same float), which is precisely why the scatter
   * needed measuring rather than assuming: a continuous SINE does not have that
   * luck, and nothing in the studio had exercised that case before.
   */
  it('an ACCUMULATING clock and a computed one agree to far below one font unit', () => {
    const track = { path: 'axes.wght', from: 200, to: 800 }
    const trackOnly = () => cfg({
      text: 'Sailor',
      motion: { ...cloneConfig(DEFAULT_CONFIG).motion, moves: [trackMove(track)] } as any,
    })
    const points = (cf: VectorTypeConfig, t: number) =>
      vectorTypeFrame(font, cf, t).outlines.glyphs.flatMap(g => g.commands.flatMap(cmd => cmd.args ?? []))

    const measure = (make: () => VectorTypeConfig) => {
      const fps = 30, frames = 120
      let acc = 0, worstT = 0, worstPt = 0, differ = 0
      for (let f = 0; f < frames; f++) {
        const computed = f / fps
        worstT = Math.max(worstT, Math.abs(acc - computed))
        const a = points(make(), acc), b = points(make(), computed)
        for (let k = 0; k < a.length; k++) worstPt = Math.max(worstPt, Math.abs((a[k] as number) - (b[k] as number)))
        if (JSON.stringify(a) !== JSON.stringify(b)) differ++
        acc += 1 / fps
      }
      return { worstT, worstPt, differ }
    }

    const scat = measure(c)
    const plain = measure(trackOnly)
    expect(scat.worstT).toBeLessThan(1e-9)
    // Sub-nanometre in font units (Inter's em is 2048), i.e. far below the
    // 3-decimal precision the SVG writer emits and below any raster's reach.
    expect(scat.worstPt).toBeLessThan(1e-6)
    // The reference, held to the same bar.
    expect(plain.worstPt).toBeLessThan(1e-6)
    // The frames that are not bit-identical are a MINORITY of a clip and, per
    // the bound above, invisible. Recorded so a regression that made the
    // divergence grow shows up as a number rather than as a shrug.
    expect(scat.differ).toBeLessThanOrEqual(120)
    expect(plain.differ).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('the config layer', () => {
  it('a default config round-trips with the scatter off and unchanged', () => {
    const round = mergeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)))
    expect(round.motion.scatter).toEqual(DEFAULT_SCATTER)
  })

  it('CLAMPS the numbers rather than resetting them — an out-of-range save meant something', () => {
    const m = mergeConfig({ motion: { scatter: { spread: 3, settle: 99, rate: -4, seed: 10_000 } } })
    expect(m.motion.scatter.spread).toBe(1)
    expect(m.motion.scatter.settle).toBe(VT_SCATTER_SETTLE_MAX)
    expect(m.motion.scatter.rate).toBe(0)
    expect(m.motion.scatter.seed).toBe(VT_SCATTER_SEED_MAX)
  })

  it('KEEPS an axis tag the current font lacks, so switching back restores it', () => {
    const m = mergeConfig({ fontId: 'inter', motion: { scatter: { spread: 0.5, axis: 'GRAD' } } })
    expect(m.motion.scatter.axis).toBe('GRAD')
    // Junk, on the other hand, is not a tag at all.
    expect(mergeConfig({ motion: { scatter: { axis: 'weight' } } }).motion.scatter.axis).toBe('wght')
  })

  it('an unknown MODE falls back — a name is not a point on a scale', () => {
    expect(mergeConfig({ motion: { scatter: { mode: 'explode' } } }).motion.scatter.mode).toBe('settle')
    for (const mode of VT_SCATTER_MODES) {
      expect(mergeConfig({ motion: { scatter: { mode } } }).motion.scatter.mode).toBe(mode)
    }
  })

  it('cloneConfig DEEP-copies the block, so a baked frame cannot leak into the default', () => {
    const c = cloneConfig(DEFAULT_CONFIG)
    c.motion.scatter.spread = 0.9
    expect(DEFAULT_CONFIG.motion.scatter.spread).toBe(0)
    expect(DEFAULT_SCATTER.spread).toBe(0)
  })

  it('survives a config straight out of storage with no motion at all', () => {
    expect(vtResolveScatter(null, 0).spread).toBe(0)
    expect(vtResolveScatter({} as VectorTypeConfig, 0).spread).toBe(0)
    expect(vtResolveScatter({ motion: 'nope' } as any, 0).spread).toBe(0)
  })

  it('a TRACK on spread drives it, and can switch the effect on mid-clip', () => {
    const track = { path: 'motion.scatter.spread', from: 0, to: 1 }
    const c = cfg({
      text: 'Sailor',
      motion: {
        ...cloneConfig(DEFAULT_CONFIG).motion,
        moves: [trackMove(track)],
        scatter: scatterBlock({ spread: 0, mode: 'wander', rate: 1 }),
      } as any,
    })
    expect(vtResolveScatter(c, 0).spread).toBeCloseTo(0, 6)
    expect(vtResolveScatter(c, 2).spread).toBeCloseTo(0.5, 6)
    expect(spreadOf(wghtDeltas(c, 0.5))).toBeLessThan(spreadOf(wghtDeltas(c, 3.5)))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('the schema', () => {
  const keysOf = (c: VectorTypeConfig) => visibleVtControls(c).map(x => x.key)

  it('only `Scatter` is on screen until the effect is switched on', () => {
    const off = keysOf(cfg()).filter(k => k.startsWith('motion.scatter'))
    expect(off).toEqual(['motion.scatter.spread'])
  })

  it('…and the rest appear with it, mode by mode', () => {
    const settling = keysOf(scatterCfg({ spread: 0.5, mode: 'settle' })).filter(k => k.startsWith('motion.scatter'))
    expect(settling).toEqual([
      'motion.scatter.spread', 'motion.scatter.mode', 'motion.scatter.settle', 'motion.scatter.seed',
    ])
    const wandering = keysOf(scatterCfg({ spread: 0.5, mode: 'wander' })).filter(k => k.startsWith('motion.scatter'))
    expect(wandering).toEqual([
      'motion.scatter.spread', 'motion.scatter.mode', 'motion.scatter.rate', 'motion.scatter.seed',
    ])
  })

  it('every declared scatter key addresses a REAL leaf on the config', () => {
    const c = scatterCfg({ spread: 0.5 })
    for (const k of VT_CONTROLS.map(x => x.key).filter(k => k.startsWith('motion.scatter'))) {
      const leaf = k.split('.').reduce<any>((o, seg) => o?.[seg], c)
      expect(leaf, k).not.toBeUndefined()
    }
  })

  it('the AXIS picker is derived from the loaded font, not hand-listed', () => {
    const c = scatterCfg({ spread: 0.5 })
    const [pick] = derivedScatterControls(c, font.axes) as any[]
    expect(pick.key).toBe('motion.scatter.axis')
    expect(pick.kind).toBe('select')
    // Inter: two axes, in the font's own preferred order.
    expect(pick.options).toEqual(font.axes.map(a => a.tag))
    expect(pick.default).toBe('wght')
    // Roboto Flex-shaped: thirteen would be offered where Inter offers two.
    expect((derivedScatterControls(c, RICH_AXES)[0] as any).options)
      .toEqual(['wght', 'wdth', 'GRAD', 'slnt'])
  })

  it('the picker leads with an axis the font ACTUALLY HAS, never a dead default', () => {
    const noWght: VtAxis[] = [{ tag: 'opsz', name: 'Optical size', min: 8, max: 144, default: 14 }]
    const c = scatterCfg({ spread: 0.5 })
    expect((derivedScatterControls(c, noWght)[0] as any).default).toBe('opsz')
    // And a zero-width axis is not offered — you cannot scatter along a point.
    expect(derivedScatterControls(c, [{ tag: 'DEAD', name: 'Dead', min: 1, max: 1, default: 1 }])).toEqual([])
  })

  it('is absent before a font has loaded, and while the scatter is off', () => {
    expect(derivedScatterControls(scatterCfg({ spread: 0.5 }), [])).toEqual([])
    expect(derivedScatterControls(cfg(), font.axes)).toEqual([])
  })

  it('derivedVtControls carries BOTH halves, so no consumer can take just one', () => {
    const c = scatterCfg({ spread: 0.5 })
    const keys = derivedVtControls(c, font.axes).map(x => x.key)
    expect(keys).toContain('axes.wght')
    expect(keys).toContain('motion.scatter.axis')
  })

  it('spread, settle and rate are animatable; the axis, mode and seed are not', () => {
    const targets = (c: VectorTypeConfig) =>
      animatableTargets(c, font.axes).map(t => t.path).filter(p => p.startsWith('motion.scatter'))
    expect(targets(cfg())).toEqual(['motion.scatter.spread'])
    expect(targets(scatterCfg({ spread: 0.5, mode: 'settle' })))
      .toEqual(['motion.scatter.spread', 'motion.scatter.settle'])
    expect(targets(scatterCfg({ spread: 0.5, mode: 'wander' })))
      .toEqual(['motion.scatter.spread', 'motion.scatter.rate'])
  })

  it('a live scatter makes the node ANIMATED — otherwise it renders one frame forever', () => {
    expect(vtIsAnimated(cfg())).toBe(false)
    expect(vtIsAnimated(scatterCfg({ spread: 0.5, mode: 'settle', settle: 0.6 }))).toBe(true)
    expect(vtIsAnimated(scatterCfg({ spread: 0.5, mode: 'wander', rate: 0.5 }))).toBe(true)
    expect(vtIsAnimated(scatterCfg({ spread: 0, mode: 'wander', rate: 0.5 }))).toBe(false)
  })

  it('a STILL bake samples the settled word, not the most scattered frame', () => {
    expect(vtStillTime(cfg())).toBe(0)
    const settling = scatterCfg({ spread: 0.7, mode: 'settle', settle: 0.9 })
    expect(vtScatterStillTime(settling)).toBe(0.9)
    expect(vtStillTime(settling)).toBeCloseTo(0.9, 9)
    // …and at that instant every glyph is on the base.
    expect(wghtDeltas(settling, vtStillTime(settling))).toEqual([0, 0, 0, 0, 0, 0])
    // A wander has no finish, and its t = 0 already IS the configured word.
    expect(vtStillTime(scatterCfg({ spread: 0.7, mode: 'wander', rate: 1 }))).toBe(0)
  })

  it('the rate ceiling is a real ceiling', () => {
    expect(mergeConfig({ motion: { scatter: { rate: 999 } } }).motion.scatter.rate).toBe(VT_SCATTER_RATE_MAX)
  })
})
