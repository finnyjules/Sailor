/**
 * Vector Type — BLINK. Letters (or whole words) dropping out and coming back.
 *
 * The feature is three lines of arithmetic. The RISK is entirely determinism, so
 * that is what most of this file measures.
 *
 * A per-frame `Math.random()` would look completely convincing: the preview
 * flickers, the bake flickers, and they flicker differently. Nothing errors and
 * the picture looks right. So the blink is a pure function of `(unit, t)` built
 * on `./random.ts`'s quantised beat, and the proof has to be able to tell the
 * two apart. Three things make it able to:
 *
 *  1. **A live broken control.** A `Math.random()` blink is implemented inline
 *     in this file and put through the SAME assertions. Every determinism test
 *     below is shown to go red on it. Without that, "the two frames matched"
 *     proves only that the test ran.
 *  2. **Boundary sampling.** Task 2's report hands this task exactly one
 *     concern: the module guarantees the same `t` gives the same value, but not
 *     that a bake and a preview ASK about the same `t`. A disagreement between
 *     two clocks shows up at a beat edge and NOWHERE ELSE, so every determinism
 *     assertion here is run on times sitting exactly on `k / rate` as well as in
 *     the middle of beats — and the edges are shown to be real edges (the state
 *     genuinely differs across them) rather than places nothing happens.
 *  3. **Real pixels.** Opacity numbers matching is not the same as ink moving.
 *     `@resvg/resvg-js` rasterises the studio's own SVG export, and the metric
 *     carried alongside the pixel COUNT is an ink XOR — because a count is blind
 *     to which letters are dark, and "half the letters are out" is the same
 *     count whichever half it is.
 *
 * NO NETWORK: the same eight-character Inter variable subset (" Sailorg") every
 * other Vector Type spec uses. `"Sail or"` is the two-word run — every character
 * of it is in the subset.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it, vi } from 'vitest'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import {
  DEFAULT_CONFIG,
  cloneConfig,
  mergeConfig,
  type VectorTypeConfig,
  type VtMotionTrack,
  type VtMove,
} from '~/lib/vectortype/config'
import { vectorTypeFrame, vectorTypeSVG, vtIsAnimated } from '~/lib/vectortype/canvas'
import { vtGlyphMotion } from '~/lib/vectortype/presetMotion'
import { timeBucket } from '~/lib/vectortype/random'
import { VT_NO_WORD, wordIndexOfGlyph } from '~/lib/vectortype/words'
import {
  DEFAULT_BLINK,
  VT_BLINK_CHANNEL,
  VT_BLINK_PHASE_CHANNEL,
  VT_BLINK_UNITS,
  vtBlinkActive,
  vtBlinkDark,
  vtBlinkOpacity,
  vtBlinkUnitIndex,
  vtResolveBlink,
  type VtBlinkConfig,
} from '~/lib/vectortype/blink'
import { VT_CONTROLS } from '~/lib/vectortype/controls'

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

/** Real rasters are not free, and this spec renders a dozen of them while the
 *  rest of the suite runs in parallel. */
vi.setConfig({ testTimeout: 30_000 })

const ONE_WORD = 'Sailor'
/** Two words, seven glyphs, one of them a space — every character in the
 *  fixture's " Sailorg" subset. Glyphs 0..3 are `Sail`, glyph 4 is the SPACE,
 *  glyphs 5..6 are `or`. */
const TWO_WORDS = 'Sail or'

const blink = (over: Partial<VtBlinkConfig> = {}): VtBlinkConfig =>
  ({ ...DEFAULT_BLINK, ...over })

function cfg(over: Partial<VectorTypeConfig> = {}, b: Partial<VtBlinkConfig> = {}): VectorTypeConfig {
  const base = cloneConfig(DEFAULT_CONFIG)
  return mergeConfig({
    ...base,
    text: ONE_WORD,
    size: 100,
    ...over,
    motion: { ...base.motion, ...(over.motion ?? {}), blink: blink(b) },
  })
}

const track = (o: Partial<VtMotionTrack> & { path: string; from: number; to: number }): VtMotionTrack =>
  ({ easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0, ...o })

/** One `kind: 'tracks'` move wrapping a single track, matching the
 *  moves-shaped equivalent of the old flat `motion.tracks: [track(...)]`
 *  array — `easing: 'linear'`/`loops: 1` (the `track()` default above) maps
 *  to `ease: 'none'`/`play: once ×1`, the same mapping
 *  `~/lib/studio/moves/merge`'s `legacyTrackEasePlay` uses. */
let trackMoveSeq = 0
function trackMove(t: VtMotionTrack): VtMove {
  trackMoveSeq += 1
  const { path, from, to, hold, cycleOffset, delay } = t
  return {
    id: `move-t${trackMoveSeq}`,
    phase: 'loop',
    kind: 'tracks',
    presetId: 'custom',
    duration: 4,
    ease: { kind: 'named', name: 'none' },
    play: { mode: 'once', times: 1 },
    tracks: [{ path, from, to, hold, cycleOffset, delay }],
  }
}

/** Every glyph's composed opacity at time `t`, through the ONE function both
 *  renderers go through. `vectorTypeFrame` is what the editor preview, the node
 *  card, the PNG bake, the video bake and the SVG export all call. */
const opacities = (c: VectorTypeConfig, t: number): number[] =>
  vectorTypeFrame(font, c, t).transforms.map(tr => tr.opacity)

/** The indices that are DARK at `t`, as a comparable string. A set, not a count:
 *  "three letters are out" is the same number whichever three they are. */
const darkSet = (c: VectorTypeConfig, t: number): string =>
  opacities(c, t).map((o, i) => (o === 0 ? i : -1)).filter(i => i >= 0).join(',')

const darkCount = (c: VectorTypeConfig, t: number): number =>
  opacities(c, t).filter(o => o === 0).length

// ── the broken control ──────────────────────────────────────────────────────

/**
 * What this feature would be if the trap had been walked into: the same three
 * controls, the same shape of answer, and a fresh roll each call.
 *
 * It satisfies every *visual* description of the effect. It is put through the
 * determinism assertions below to prove they can tell the difference — a proof
 * that a matching pair of frames is evidence rather than a tautology.
 */
function brokenBlinkDark(b: VtBlinkConfig, _t: number, unitIndex: number): boolean {
  if (unitIndex < 0 || b.amount <= 0) return false
  return Math.random() < b.amount * (1 - b.stayLit)
}

// ── 1. there is no roll anywhere on the path ────────────────────────────────

describe('no fresh randomness reaches the draw path', () => {
  it('runs a whole blinking frame with Math.random replaced by a trap', () => {
    // The dynamic proof, and the strong one: not "the source does not contain
    // the string" but "the execution never called it". Everything from
    // `vectorTypeFrame` down — shaping, motion, the blink itself — runs under a
    // Math.random that throws.
    const real = Math.random
    const c = cfg({ text: TWO_WORDS }, { amount: 0.6, rate: 6, stayLit: 0.5 })
    try {
      Math.random = () => { throw new Error('Math.random() reached the draw path') }
      for (const t of [0, 0.1, 1 / 6, 0.4999, 0.5001, 1.25, 3.75]) {
        expect(() => vectorTypeFrame(font, c, t)).not.toThrow()
        expect(() => vtBlinkDark(blink({ amount: 0.6 }), t, 2)).not.toThrow()
      }
    } finally {
      Math.random = real
    }
  })

  it('the trap catches the broken control, so the test above is not vacuous', () => {
    const real = Math.random
    try {
      Math.random = () => { throw new Error('Math.random() reached the draw path') }
      expect(() => brokenBlinkDark(blink({ amount: 0.6 }), 0.3, 2)).toThrow()
    } finally {
      Math.random = real
    }
  })

  it('blink.ts itself contains no roll and no wall clock, comments aside', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../app/lib/vectortype/blink.ts', import.meta.url)),
      'utf8',
    )
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/Math\.random/)
    expect(code).not.toMatch(/Date\.now/)
    expect(code).not.toMatch(/performance\.now/)
    // …and the stripper really did leave the code behind.
    expect(code).toMatch(/export function vtBlinkDark/)
  })
})

// ── 2. the derivation, at both ends of every control ────────────────────────

describe('the on/off derivation', () => {
  const T = Array.from({ length: 200 }, (_, k) => k * 0.017)

  it('amount 0 is OFF — the shipped default, and nothing is ever dark', () => {
    expect(DEFAULT_BLINK.amount).toBe(0)
    for (const t of T) for (let i = 0; i < 12; i++) {
      expect(vtBlinkDark(blink({ amount: 0 }), t, i)).toBe(false)
    }
  })

  it('stayLit 1 never goes dark: the dark window has zero length', () => {
    for (const t of T) for (let i = 0; i < 12; i++) {
      expect(vtBlinkDark(blink({ amount: 1, stayLit: 1 }), t, i)).toBe(false)
    }
  })

  it('rate 0 is zero blinks per second, not a frozen half-dark word', () => {
    for (const t of T) for (let i = 0; i < 12; i++) {
      expect(vtBlinkDark(blink({ amount: 1, rate: 0, stayLit: 0 }), t, i)).toBe(false)
    }
  })

  it('amount 1 with stayLit 0 is the far end: everything, always', () => {
    for (const t of T) for (let i = 0; i < 12; i++) {
      expect(vtBlinkDark(blink({ amount: 1, stayLit: 0 }), t, i)).toBe(true)
    }
  })

  it('a unit index below zero can never blink — a space, or an unresolved word', () => {
    for (const t of T) {
      expect(vtBlinkDark(blink({ amount: 1, stayLit: 0 }), t, VT_NO_WORD)).toBe(false)
      expect(vtBlinkDark(blink({ amount: 1, stayLit: 0 }), t, -7)).toBe(false)
    }
  })

  it('a non-finite clock selects no beat rather than a NaN one', () => {
    for (const t of [NaN, Infinity, -Infinity]) {
      expect(vtBlinkDark(blink({ amount: 1, stayLit: 0.5 }), t, 3)).toBe(false)
    }
  })

  it('t = 0 is fully lit whenever anything stays lit at all', () => {
    // A free and load-bearing property: the still bakes (the render cascade PNG,
    // the Collection param baker, the node thumbnail) sample t = 0, and a
    // thumbnail with random letters missing reads as a broken render. The dark
    // window starts at `offset × stayLit`, which is above zero for every unit
    // whose offset is, so phase 0 is inside nobody's window.
    for (const stayLit of [0.05, 0.3, 0.5, 0.7, 0.95]) {
      for (let i = 0; i < 64; i++) {
        expect(vtBlinkDark(blink({ amount: 1, stayLit }), 0, i), `unit ${i} stayLit ${stayLit}`).toBe(false)
      }
    }
  })

  it('the opacity is a hard 1 or 0, never a ramp', () => {
    const b = blink({ amount: 0.5 })
    for (const t of T) for (let i = 0; i < 8; i++) {
      expect([0, 1]).toContain(vtBlinkOpacity(b, t, i))
    }
  })

  it('vtBlinkActive gates on all three, so an off blink costs nothing', () => {
    expect(vtBlinkActive(blink({ amount: 0 }))).toBe(false)
    expect(vtBlinkActive(blink({ amount: 0.5, rate: 0 }))).toBe(false)
    expect(vtBlinkActive(blink({ amount: 0.5, stayLit: 1 }))).toBe(false)
    expect(vtBlinkActive(blink({ amount: 0.5 }))).toBe(true)
    expect(vtBlinkActive(null)).toBe(false)
  })
})

// ── 3. the controls each change the result, measurably ──────────────────────

/** The share of (unit, instant) samples that are dark. The number a user reads
 *  off the screen as "how much is blinking". */
function darkFraction(b: VtBlinkConfig, units = 200, samples = 400): number {
  let dark = 0
  for (let i = 0; i < units; i++) {
    for (let s = 0; s < samples; s++) {
      // An irrational-ish step so the sampling grid cannot resonate with the beat.
      if (vtBlinkDark(b, s * 0.0137 + 0.0031, i)) dark++
    }
  }
  return dark / (units * samples)
}

/** How many times a unit's state flips over a fixed window. The number that
 *  distinguishes "faster" from "more". */
function transitions(b: VtBlinkConfig, unit: number, span = 4, steps = 20000): number {
  let flips = 0
  let prev = vtBlinkDark(b, 0, unit)
  for (let s = 1; s <= steps; s++) {
    const now = vtBlinkDark(b, (s * span) / steps, unit)
    if (now !== prev) flips++
    prev = now
  }
  return flips
}

describe('the three controls do three different things', () => {
  it('AMOUNT scales how much is out, monotonically', () => {
    const f = [0.25, 0.5, 0.75, 1].map(amount => darkFraction(blink({ amount, stayLit: 0.5 })))
    for (let i = 1; i < f.length; i++) expect(f[i]!).toBeGreaterThan(f[i - 1]!)
    // …and it is the fraction it claims: amount × the dark share of the beat.
    for (const [i, amount] of [0.25, 0.5, 0.75, 1].entries()) {
      expect(f[i]!).toBeCloseTo(amount * 0.5, 2)
    }
  })

  it('STAY LIT changes how long, not how many — and the product is the picture', () => {
    for (const stayLit of [0.2, 0.5, 0.8]) {
      expect(darkFraction(blink({ amount: 0.6, stayLit }))).toBeCloseTo(0.6 * (1 - stayLit), 2)
    }
  })

  it('RATE changes how often WITHOUT changing how much is out', () => {
    const slow = blink({ amount: 0.6, rate: 3, stayLit: 0.5 })
    const fast = blink({ amount: 0.6, rate: 12, stayLit: 0.5 })
    // Four times the rate, about four times the flips, on the same unit.
    const fSlow = transitions(slow, 5)
    const fFast = transitions(fast, 5)
    expect(fFast).toBeGreaterThan(fSlow * 3)
    // …and the same amount of darkness, which is what makes it a SEPARATE knob.
    expect(darkFraction(slow)).toBeCloseTo(darkFraction(fast), 2)
  })

  it('the units do not all drop out on the same instant', () => {
    // The reason the dark window is placed by its own channel. With one shared
    // phase every beat would be a strobe: the dark count would be 0 for part of
    // the beat and the full rotation for the rest, and never anything between.
    const b = blink({ amount: 0.8, rate: 4, stayLit: 0.5 })
    const counts = new Set<number>()
    for (let s = 0; s < 400; s++) {
      const t = s * 0.0011 + 0.03
      let n = 0
      for (let i = 0; i < 24; i++) if (vtBlinkDark(b, t, i)) n++
      counts.add(n)
    }
    // A strobe would give two or three distinct counts; independent windows give
    // a spread.
    expect(counts.size).toBeGreaterThan(6)
  })

  it('SEED re-rolls who and when, and nothing else', () => {
    const a = blink({ amount: 0.5, seed: 1 })
    const b = blink({ amount: 0.5, seed: 2 })
    let differ = 0
    for (let i = 0; i < 200; i++) for (let s = 0; s < 20; s++) {
      if (vtBlinkDark(a, s * 0.037 + 0.01, i) !== vtBlinkDark(b, s * 0.037 + 0.01, i)) differ++
    }
    expect(differ).toBeGreaterThan(200)
    // Same statistics, different picture.
    expect(darkFraction(a)).toBeCloseTo(darkFraction(b), 2)
  })

  it('the two channels are different, or selection and timing would correlate', () => {
    expect(VT_BLINK_CHANNEL).not.toBe(VT_BLINK_PHASE_CHANNEL)
  })
})

// ── 4. DETERMINISM — the whole risk of the feature ──────────────────────────

/** Times that sit EXACTLY on a beat edge for `rate`, plus their immediate
 *  neighbours. `1 / 6` is deliberately not a binary fraction: an edge at a round
 *  0.125 would hide any arithmetic that is only correct on exact values. */
const RATE = 6
const EDGES = Array.from({ length: 24 }, (_, k) => (k + 1) / RATE)
const MIDS = Array.from({ length: 24 }, (_, k) => (k + 0.5) / RATE)

/**
 * Every instant in `[from, to)` at which one unit's state flips, located by
 * bisecting the SHIPPED function.
 *
 * Bisection rather than arithmetic on purpose: restating `start = offset ×
 * stayLit` here would make the test agree with a bug that lived in that
 * expression. This asks the function where it changes its mind and takes the
 * answer, so the boundaries sampled are the ones the renderer actually has.
 *
 * The returned time is the FIRST at which the new state holds, to within a
 * double's resolution — so `t` is on the new side and `t − 1e-9` on the old.
 */
function windowEdges(b: VtBlinkConfig, unit: number, from: number, to: number): number[] {
  const dark = (t: number) => vtBlinkDark(b, t, unit)
  const out: number[] = []
  const step = (to - from) / 4000
  for (let t = from; t + step < to; t += step) {
    if (dark(t) === dark(t + step)) continue
    let lo = t
    let hi = t + step
    const before = dark(lo)
    for (let k = 0; k < 80; k++) {
      const mid = (lo + hi) / 2
      if (mid === lo || mid === hi) break
      if (dark(mid) === before) lo = mid
      else hi = mid
    }
    out.push(hi)
  }
  return out
}

describe('determinism — the same t is the same picture, including on beat edges', () => {
  const c = () => cfg({ text: TWO_WORDS }, { amount: 0.7, rate: RATE, stayLit: 0.5 })

  it('the same frame rendered twice is identical — on edges and in the middle', () => {
    const a = c()
    for (const t of [...EDGES, ...MIDS]) {
      expect(opacities(a, t), `t=${t}`).toEqual(opacities(a, t))
    }
  })

  it('a BAKE at t matches the PREVIEW at t, on every beat edge', () => {
    // Two genuinely different config objects reaching the renderer by the two
    // real routes: the surface holds a `mergeConfig`-ed ref; the node card, the
    // PNG baker and the frame source read `properties.sailor_vectorType` as
    // parsed JSON. Same `t`, so the pictures must be identical.
    const preview = c()
    const bake = mergeConfig(JSON.parse(JSON.stringify(preview)))
    expect(bake).not.toBe(preview)
    for (const t of [...EDGES, ...MIDS]) {
      expect(opacities(bake, t), `bake vs preview at t=${t}`).toEqual(opacities(preview, t))
    }
  })

  it('a RAW stored blob — no mergeConfig at all — agrees too', () => {
    // The path with no normalisation in front of it. `vtResolveBlink` defaults
    // field by field for exactly this.
    const preview = c()
    const raw = JSON.parse(JSON.stringify(preview)) as VectorTypeConfig
    for (const t of EDGES) {
      expect(opacities(raw, t), `raw blob at t=${t}`).toEqual(opacities(preview, t))
    }
  })

  it('the edges sampled are REAL beat edges — the beat really changes there', () => {
    // Without this the tests above could be passing because `k / rate` is not
    // actually a boundary. It is: either side lands in a different beat, so the
    // hash is being asked a different question on each side.
    const period = 1 / RATE
    for (const t of EDGES) {
      expect(timeBucket(t + 1e-7, period), `edge ${t}`).toBe(timeBucket(t - 1e-7, period) + 1)
    }
  })

  it('THE FINDING: a beat edge is always FULLY LIT, so the seam is invisible', () => {
    // Worth stating because it is the opposite of what the trap suggests. The
    // dark window is placed INSIDE its own beat (`start = offset × stayLit`,
    // length `1 − stayLit`), so it can never touch either end of the beat: at
    // phase 0 nothing has dropped out yet and by phase 1 everything is back.
    //
    // Two consequences. The good one: the quantisation has no seam — a clock
    // disagreement AT a beat edge cannot produce a different picture, because
    // both sides are the fully lit frame. The one that matters for this spec:
    // the beat edge is therefore NOT where a clock bug would show, so the
    // boundary proof cannot stop here. The real discontinuities are the window
    // edges inside the beat, and the block below samples those too.
    const a = c()
    const lit = new Array(TWO_WORDS.length).fill(1)
    for (const t of EDGES) {
      expect(opacities(a, t), `on edge ${t}`).toEqual(lit)
      expect(opacities(a, t - 1e-9), `just before edge ${t}`).toEqual(lit)
      expect(opacities(a, t + 1e-9), `just after edge ${t}`).toEqual(lit)
    }
  })

  it('consecutive beats really re-pick who blinks', () => {
    // …and the beat is not decorative: sampled in the middle of each beat, where
    // the windows are, the picture changes from beat to beat.
    const a = c()
    const seen = new Set(MIDS.map(t => darkSet(a, t)))
    expect(seen.size).toBeGreaterThan(4)
  })

  it('THE OTHER BOUNDARY: the window edges inside a beat, found by bisection', () => {
    // The instants where the picture actually changes. Located on the SHIPPED
    // function by bisection rather than by restating its arithmetic, so this
    // cannot agree with a bug by construction — then sampled exactly on, and to
    // either side of, each one.
    const a = c()
    const edges = windowEdges(blink({ amount: 0.7, rate: RATE, stayLit: 0.5 }), 2, 0, 4)
    expect(edges.length).toBeGreaterThan(4)
    const bake = mergeConfig(JSON.parse(JSON.stringify(a)))
    for (const t of edges) {
      // It is a real discontinuity: the two sides differ.
      expect(darkSet(a, t - 1e-9), `t=${t}`).not.toBe(darkSet(a, t + 1e-9))
      // And ON it, every route agrees to the bit.
      expect(opacities(a, t)).toEqual(opacities(a, t))
      expect(opacities(bake, t), `bake vs preview ON a window edge t=${t}`).toEqual(opacities(a, t))
      expect(opacities(bake, t - 1e-9)).toEqual(opacities(a, t - 1e-9))
      expect(opacities(bake, t + 1e-9)).toEqual(opacities(a, t + 1e-9))
    }
  })

  it('two clocks that AGREE on t agree on the picture; the divergence is measured', () => {
    // The concern Task 2 handed over. A bake computes frame time as `frame /
    // fps`; a preview that ACCUMULATES `+= 1 / fps` drifts from it in floating
    // point. Where they name the same instant they must draw the same frame;
    // where they do not, this records how far apart they get and how often that
    // lands on a different beat — the honest number, not an assumption.
    const a = c()
    const fps = 30
    let acc = 0
    let maxDrift = 0
    let differingFrames = 0
    for (let f = 0; f < 600; f++) {
      const exact = f / fps
      maxDrift = Math.max(maxDrift, Math.abs(acc - exact))
      // The guarantee: the same number in gives the same picture out.
      expect(darkSet(a, exact)).toBe(darkSet(a, exact))
      if (darkSet(a, acc) !== darkSet(a, exact)) differingFrames++
      acc += 1 / fps
    }
    // Reported rather than asserted to zero: this is a property of the two
    // clocks, not of the blink. Recorded so a regression that made it WORSE is
    // visible.
    expect(maxDrift).toBeLessThan(1e-9)
    expect(differingFrames).toBe(0)
  })

  it('the broken control fails every one of those assertions', () => {
    // A `Math.random()` blink through the same set-comparison the tests above
    // use. If this passed, none of them would be evidence.
    const b = blink({ amount: 0.7, stayLit: 0.5 })
    const set = (t: number) =>
      Array.from({ length: 40 }, (_, i) => (brokenBlinkDark(b, t, i) ? i : -1)).filter(i => i >= 0).join(',')
    let same = 0
    for (const t of EDGES) if (set(t) === set(t)) same++
    expect(same).toBe(0)
  })

  it('the SVG export and the canvas frame agree, glyph for glyph, on an edge', () => {
    // Two renderers, one `vectorTypeFrame`. The export writes the composed
    // opacity onto each glyph's path, so a blink that reached only the canvas
    // would show up as a count mismatch here.
    const a = c()
    for (const t of [EDGES[3]!, EDGES[7]!, MIDS[5]!]) {
      const dark = darkCount(a, t)
      const svg = vectorTypeSVG(font, a, t, { width: 520, height: 300, background: '#ffffff' }).svg
      const zeros = (svg.match(/opacity="0"/g) ?? []).length
      expect(zeros, `t=${t}`).toBe(dark)
    }
  })
})

// ── 5. letters versus words ─────────────────────────────────────────────────

describe('unit: letter', () => {
  const c = () => cfg({ text: ONE_WORD }, { amount: 0.6, rate: RATE, stayLit: 0.5, unit: 'letter' })

  it('the SET of dark letters changes over time, not just how many', () => {
    const a = c()
    const sets = new Set<string>()
    const counts = new Map<number, Set<string>>()
    for (let s = 0; s < 240; s++) {
      const t = s * 0.013 + 0.01
      const set = darkSet(a, t)
      sets.add(set)
      const n = set === '' ? 0 : set.split(',').length
      if (!counts.has(n)) counts.set(n, new Set())
      counts.get(n)!.add(set)
    }
    expect(sets.size).toBeGreaterThan(8)
    // The metric a COUNT is blind to: the same number of letters out, but a
    // different set of them. At least one count must have been reached by more
    // than one arrangement.
    expect([...counts.values()].some(v => v.size > 1)).toBe(true)
  })

  it('every letter takes a turn — none is permanently on or off', () => {
    const a = c()
    const n = ONE_WORD.length
    const everDark = new Array(n).fill(false)
    const everLit = new Array(n).fill(false)
    for (let s = 0; s < 400; s++) {
      const ops = opacities(a, s * 0.0091 + 0.005)
      for (let i = 0; i < n; i++) (ops[i] === 0 ? everDark : everLit)[i] = true
    }
    expect(everDark).toEqual(new Array(n).fill(true))
    expect(everLit).toEqual(new Array(n).fill(true))
  })
})

describe('unit: word', () => {
  const c = () => cfg({ text: TWO_WORDS }, { amount: 0.7, rate: RATE, stayLit: 0.5, unit: 'word' })

  /** The grouping the renderer actually computes, from the shaped run. */
  const groups = () => wordIndexOfGlyph(vectorTypeFrame(font, c(), 0).outlines.glyphs)

  it('the fixture run really is two words with a separator between them', () => {
    // The premise of every assertion below, stated rather than assumed — and
    // this is the ligature check Task 2 asked for: the grouping is taken from a
    // REAL fontkit-shaped run, not a hand-built glyph array.
    expect(groups()).toEqual([0, 0, 0, 0, VT_NO_WORD, 1, 1])
  })

  it('a whole word goes dark as ONE thing — every glyph shares the state', () => {
    const a = c()
    const g = groups()
    let sawWordDark = 0
    for (let s = 0; s < 400; s++) {
      const t = s * 0.0091 + 0.005
      const ops = opacities(a, t)
      for (const w of [0, 1]) {
        const mine = ops.filter((_, i) => g[i] === w)
        expect(new Set(mine).size, `word ${w} split apart at t=${t}: ${mine.join(',')}`).toBe(1)
        if (mine[0] === 0) sawWordDark++
      }
    }
    // …and it is not vacuously true because nothing ever blinked.
    expect(sawWordDark).toBeGreaterThan(50)
  })

  it('the two words are INDEPENDENT — one is out while the other is lit', () => {
    const a = c()
    const g = groups()
    let split = 0
    for (let s = 0; s < 400; s++) {
      const ops = opacities(a, s * 0.0091 + 0.005)
      const w0 = ops[g.indexOf(0)]!
      const w1 = ops[g.indexOf(1)]!
      if (w0 !== w1) split++
    }
    expect(split).toBeGreaterThan(50)
  })

  it('the SPACE never blinks — VT_NO_WORD keeps it out by construction', () => {
    const a = c()
    const g = groups()
    const sep = g.indexOf(VT_NO_WORD)
    expect(sep).toBe(4)
    for (let s = 0; s < 400; s++) {
      expect(opacities(a, s * 0.0091 + 0.005)[sep]).toBe(1)
    }
  })

  it('word blink survives a STAGGER, which letter-level clocks would tear apart', () => {
    // The reason blink reads the RUN clock. On the glyph clock the four letters
    // of `Sail` sit at four different stagger ranks, so they would be in four
    // different beats and the word would come apart letter by letter.
    const a = cfg(
      { text: TWO_WORDS, motion: { ...DEFAULT_CONFIG.motion, stagger: { delay: 0.12, order: 'forward', seed: 0 } } as any },
      { amount: 0.7, rate: RATE, stayLit: 0.5, unit: 'word' },
    )
    const g = groups()
    for (let s = 0; s < 300; s++) {
      const ops = opacities(a, s * 0.0091 + 0.005)
      for (const w of [0, 1]) {
        expect(new Set(ops.filter((_, i) => g[i] === w)).size).toBe(1)
      }
    }
  })

  it('word blink is INERT without the grouping, never silently per-letter', () => {
    // The only route that can reach this is a caller that is not
    // `vectorTypeFrame`. Showing nothing is a bug that gets found; showing a
    // letter blink where a word blink was asked for is a taste call that does not.
    const a = c()
    for (let s = 0; s < 60; s++) {
      const t = s * 0.031 + 0.005
      for (let i = 0; i < 7; i++) {
        expect(vtGlyphMotion(a, t, i, 7).opacity).toBe(1)
      }
    }
  })

  it('vectorTypeFrame SUPPLIES the grouping — asserted, not trusted', () => {
    // The pair above and below is the assertion: the same config is inert
    // through a bare `vtGlyphMotion` and blinks through `vectorTypeFrame`, so
    // the only thing that can be doing it is the `wordOf` the frame passes.
    const a = c()
    let dark = 0
    for (let s = 0; s < 200; s++) dark += darkCount(a, s * 0.0091 + 0.005)
    expect(dark).toBeGreaterThan(100)
  })

  it('a run with no spaces is ONE word, so the whole word blinks together', () => {
    const a = cfg({ text: ONE_WORD }, { amount: 1, rate: RATE, stayLit: 0.5, unit: 'word' })
    let allDark = 0
    for (let s = 0; s < 200; s++) {
      const ops = opacities(a, s * 0.0091 + 0.005)
      expect(new Set(ops).size).toBe(1)
      if (ops[0] === 0) allDark++
    }
    expect(allDark).toBeGreaterThan(20)
  })

  it('vtBlinkUnitIndex maps letters, words and separators the way the run does', () => {
    const g = [0, 0, 0, 0, VT_NO_WORD, 1, 1]
    expect(g.map((_, i) => vtBlinkUnitIndex('letter', i, g))).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(g.map((_, i) => vtBlinkUnitIndex('word', i, g))).toEqual(g)
    expect(vtBlinkUnitIndex('word', 0, null)).toBe(VT_NO_WORD)
    expect(vtBlinkUnitIndex('word', 0, undefined)).toBe(VT_NO_WORD)
    expect(vtBlinkUnitIndex('letter', -1, g)).toBe(VT_NO_WORD)
  })
})

// ── 6. real pixels ──────────────────────────────────────────────────────────

interface Ink { bits: Uint8Array; n: number }

/** Rasterise one exported frame at 1:1 and reduce the inked pixels to a mask.
 *  Real pixels, from resvg — not a canvas recorder's opinion. */
function ink(svg: string): Ink {
  const img = new Resvg(svg, { fitTo: { mode: 'original' } }).render()
  const px = img.pixels
  const total = img.width * img.height
  const bits = new Uint8Array(total)
  let n = 0
  for (let i = 0; i < total; i++) {
    // White background, black type: any dark pixel is ink.
    if (px[i * 4 + 3]! > 40 && px[i * 4]! < 120) { bits[i] = 1; n++ }
  }
  return { bits, n }
}

/** Symmetric difference over union — the geometry metric a pixel COUNT is blind
 *  to. Two frames with the same number of letters out but different letters
 *  score 0 on a count difference and high here. */
function inkXor(a: Ink, b: Ink): number {
  let diff = 0
  let union = 0
  for (let i = 0; i < a.bits.length; i++) {
    if (a.bits[i] !== b.bits[i]) diff++
    if (a.bits[i] || b.bits[i]) union++
  }
  return union ? diff / union : 0
}

const rasterAt = (c: VectorTypeConfig, t: number): Ink =>
  ink(vectorTypeSVG(font, c, t, { width: 520, height: 300, background: '#ffffff' }).svg)

describe('real ink, measured', () => {
  const black = () => {
    const base = cloneConfig(DEFAULT_CONFIG)
    const layer0 = { ...base.appearance[0]!, paint: { ...(base.appearance[0]!.paint as any), type: 'solid', a: '#000000' } }
    return { ...base, appearance: [layer0] }
  }

  const blinking = (): VectorTypeConfig =>
    mergeConfig({
      ...black(), text: ONE_WORD, size: 100,
      motion: { ...DEFAULT_CONFIG.motion, blink: blink({ amount: 0.7, rate: RATE, stayLit: 0.4 }) },
    })

  const still = (): VectorTypeConfig =>
    mergeConfig({ ...black(), text: ONE_WORD, size: 100 })

  it('the ink COUNT changes over time, and the ink itself moves', () => {
    const t0 = MIDS[2]!
    const t1 = MIDS[5]!
    const a = blinking()
    const f0 = rasterAt(a, t0)
    const f1 = rasterAt(a, t1)
    expect(f0.n).toBeGreaterThan(0)
    expect(f1.n).toBeGreaterThan(0)
    expect(f0.n).not.toBe(f1.n)
    expect(inkXor(f0, f1)).toBeGreaterThan(0.1)
  })

  it('THE BROKEN CONTROL: the same config with blink off does not move at all', () => {
    const s = still()
    const f0 = rasterAt(s, MIDS[2]!)
    const f1 = rasterAt(s, MIDS[5]!)
    expect(f0.n).toBe(f1.n)
    expect(inkXor(f0, f1)).toBe(0)
    // …and it is the same picture the studio drew before blink existed.
    expect(f0.n).toBeGreaterThan(0)
  })

  it('the same t rasterises to the same pixels, twice, ON A BOUNDARY', () => {
    const a = blinking()
    const edge = windowEdges(blink({ amount: 0.7, rate: RATE, stayLit: 0.4 }), 2, 0, 2)[1]!
    for (const t of [EDGES[4]!, edge]) {
      const one = rasterAt(a, t)
      const two = rasterAt(a, t)
      expect(one.n).toBe(two.n)
      expect(inkXor(one, two)).toBe(0)
    }
  })

  it('a boundary is visible in the PIXELS, not merely in the numbers', () => {
    const a = blinking()
    const edges = windowEdges(blink({ amount: 0.7, rate: RATE, stayLit: 0.4 }), 2, 0, 2).slice(0, 3)
    expect(edges.length).toBeGreaterThan(0)
    for (const t of edges) {
      const before = rasterAt(a, t - 1e-9)
      const after = rasterAt(a, t + 1e-9)
      expect(before.n, `t=${t}`).not.toBe(after.n)
      expect(inkXor(before, after), `t=${t}`).toBeGreaterThan(0.01)
    }
  })
})

// ── 7. composition, config and the schema ───────────────────────────────────

describe('blink composes rather than replacing', () => {
  it('multiplies with a glyph.opacity track — dark stays dark', () => {
    const a = cfg(
      { text: ONE_WORD, motion: { ...DEFAULT_CONFIG.motion, moves: [trackMove(track({ path: 'glyph.opacity', from: 0.5, to: 0.5 }))] } as any },
      { amount: 1, rate: RATE, stayLit: 0.5 },
    )
    let sawHalf = false
    let sawZero = false
    for (let s = 0; s < 200; s++) {
      for (const o of opacities(a, s * 0.0091 + 0.005)) {
        expect([0, 0.5]).toContain(o)
        if (o === 0.5) sawHalf = true
        if (o === 0) sawZero = true
      }
    }
    expect(sawHalf).toBe(true)
    expect(sawZero).toBe(true)
  })

  it('a track on motion.blink.amount ramps the effect in', () => {
    const a = cfg(
      { text: ONE_WORD, motion: { ...DEFAULT_CONFIG.motion, duration: 4, moves: [trackMove(track({ path: 'motion.blink.amount', from: 0, to: 1 }))] } as any },
      { amount: 0, rate: RATE, stayLit: 0.5 },
    )
    expect(vtResolveBlink(a, 0).amount).toBeCloseTo(0, 6)
    expect(vtResolveBlink(a, 2).amount).toBeCloseTo(0.5, 6)
    expect(vtResolveBlink(a, 4).amount).toBeCloseTo(1, 6)
    // …and it reaches the pictures: nothing blinks early, plenty does late.
    const early = Array.from({ length: 60 }, (_, s) => darkCount(a, 0.001 + s * 0.0007)).reduce((x, y) => x + y, 0)
    const late = Array.from({ length: 60 }, (_, s) => darkCount(a, 3.5 + s * 0.0007)).reduce((x, y) => x + y, 0)
    expect(early).toBe(0)
    expect(late).toBeGreaterThan(early)
  })

  it('an OFF blink leaves every opacity exactly as it was before the feature', () => {
    const a = cfg({ text: TWO_WORDS })
    expect(a.motion.blink.amount).toBe(0)
    for (const t of [...EDGES, ...MIDS]) expect(opacities(a, t)).toEqual(new Array(7).fill(1))
  })

  it('vtIsAnimated counts a blink, and only a live one', () => {
    expect(vtIsAnimated(cfg({ text: ONE_WORD }))).toBe(false)
    expect(vtIsAnimated(cfg({ text: ONE_WORD }, { amount: 0.5 }))).toBe(true)
    expect(vtIsAnimated(cfg({ text: ONE_WORD }, { amount: 0.5, rate: 0 }))).toBe(false)
    expect(vtIsAnimated(cfg({ text: ONE_WORD }, { amount: 0.5, stayLit: 1 }))).toBe(false)
  })
})

describe('the config layer', () => {
  it('round-trips the block through mergeConfig', () => {
    const a = cfg({}, { amount: 0.4, rate: 9, stayLit: 0.25, unit: 'word', seed: 77 })
    expect(a.motion.blink).toEqual({ amount: 0.4, rate: 9, stayLit: 0.25, unit: 'word', seed: 77 })
    expect(mergeConfig(JSON.parse(JSON.stringify(a))).motion.blink).toEqual(a.motion.blink)
  })

  it('CLAMPS an out-of-range value rather than switching the effect off', () => {
    const m = mergeConfig({ ...DEFAULT_CONFIG, motion: { ...DEFAULT_CONFIG.motion, blink: { amount: 3, rate: -4, stayLit: 9, seed: 1e9 } } as any })
    expect(m.motion.blink.amount).toBe(1)
    expect(m.motion.blink.rate).toBe(0)
    expect(m.motion.blink.stayLit).toBe(1)
    expect(m.motion.blink.seed).toBe(999)
  })

  it('falls back on an unknown UNIT, because a name is not a point on a scale', () => {
    const m = mergeConfig({ ...DEFAULT_CONFIG, motion: { ...DEFAULT_CONFIG.motion, blink: { unit: 'syllable' } } as any })
    expect(m.motion.blink.unit).toBe(DEFAULT_BLINK.unit)
    expect(VT_BLINK_UNITS).toEqual(['letter', 'word'])
  })

  it('a missing block is the default, and a raw blob resolves field by field', () => {
    const m = mergeConfig({ text: 'Sail', motion: {} })
    expect(m.motion.blink).toEqual(DEFAULT_BLINK)
    expect(vtResolveBlink(null, 0)).toEqual(DEFAULT_BLINK)
    expect(vtResolveBlink({ motion: { blink: { amount: 0.5 } } } as any, 0)).toEqual({ ...DEFAULT_BLINK, amount: 0.5 })
  })

  it('an OFF blink resolves to a shared frozen object, not one per glyph', () => {
    // `vtGlyphMotion` runs once per glyph per frame for every config in the
    // product. The off case — which is nearly all of them — must not allocate.
    const a = cfg({ text: ONE_WORD })
    const first = vtResolveBlink(a, 0)
    expect(vtResolveBlink(a, 1.5)).toBe(first)
    expect(vtResolveBlink(cfg({ text: TWO_WORDS }), 3)).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(first.amount).toBe(0)
    // …and a LIVE one still resolves properly rather than taking that path.
    expect(vtResolveBlink(cfg({}, { amount: 0.5 }), 0)).not.toBe(first)
  })

  it('cloneConfig gives the clone its OWN blink object', () => {
    // `motion.blink.rate` is an animatable leaf, so `applyMotion` writes through
    // the clone. A shared object would land frame 37's rate in DEFAULT_CONFIG.
    const a = cfg({}, { amount: 0.5 })
    const copy = cloneConfig(a)
    copy.motion.blink.rate = 99
    expect(a.motion.blink.rate).toBe(DEFAULT_BLINK.rate)
    expect(DEFAULT_CONFIG.motion.blink.rate).toBe(DEFAULT_BLINK.rate)
  })

  it('declares five controls, one master and four gated on it', () => {
    const keys = VT_CONTROLS.filter(c => c.key.startsWith('motion.blink.')).map(c => c.key)
    expect(keys).toEqual([
      'motion.blink.amount',
      'motion.blink.rate',
      'motion.blink.stayLit',
      'motion.blink.unit',
      'motion.blink.seed',
    ])
    const amount = VT_CONTROLS.find(c => c.key === 'motion.blink.amount')!
    expect(amount.when).toBeUndefined()
    for (const k of keys.slice(1)) {
      const c = VT_CONTROLS.find(x => x.key === k)!
      expect(c.when, k).toBeTypeOf('function')
      expect(c.when!(cfg({}, { amount: 0 }), null), k).toBe(false)
      expect(c.when!(cfg({}, { amount: 0.5 }), null), k).toBe(true)
    }
  })

  it('the seed is not animatable and the other three are', () => {
    const of = (k: string) => VT_CONTROLS.find(c => c.key === k)!
    expect(of('motion.blink.seed').animatable).toBe(false)
    for (const k of ['motion.blink.amount', 'motion.blink.rate', 'motion.blink.stayLit']) {
      expect(of(k).animatable, k).toBeUndefined()
    }
  })
})
