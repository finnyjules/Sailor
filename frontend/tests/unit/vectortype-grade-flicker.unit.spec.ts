/**
 * Vector Type — GRADE FLICKER (`~/lib/vectortype/axisPresets`, `grade-flicker`).
 *
 * A failing sign: every letter on its own `GRAD` state, re-picked on a fast beat
 * inside the loop cycle. Paired with the blink it is the broken-neon look, and
 * the reason it cannot be faked by a warp-based tool is one property:
 *
 *   **`GRAD` changes stroke weight WITHOUT changing advance width.**
 *
 * So the line never reflows. Nothing shuffles sideways, nothing re-wraps, and the
 * word stays exactly where the user placed it while its ink swings.
 *
 * That property is what this spec is mostly about, and it is measured rather than
 * asserted — the way `mp-task-10-report.md` measured it for Grade Pulse: shaped
 * advances identical to the un-animated run while ink moves, against a `wght`
 * control that DOES move advances. The honest limit of a unit test is stated up
 * front:
 *
 *   The checked-in fixture is a 2-axis Inter subset with **no `GRAD`**, so the
 *   0.000 %-versus-+20.8 % measurement needs the real 13-axis Roboto Flex file,
 *   and is recorded in `.superpowers/sdd/n-task-5-report.md` — measured twice
 *   there, once headlessly through `vectorTypeFrame` and once on the live canvas.
 *   What is provable here is the two halves that make that measurement mean
 *   something: (1) the preset emits the `GRAD` tag and NOTHING else, at every
 *   phase and every glyph — so it cannot move an advance even in principle; and
 *   (2) the advance metric is genuinely sensitive on this very fixture, because a
 *   `wght` change moves it by 17.8 %. A metric that could not move would make the
 *   GRAD result vacuous.
 *
 * The other half of the risk is determinism. Three features in this wave are
 * randomness, and the studio's promise is that the preview, the PNG bake, the
 * video bake and the SVG export draw the same frame at the same `t`. A
 * `Math.random()` flicker breaks that in the way that looks fine: all four
 * flicker convincingly, and differently. Every determinism test below is run
 * against a deliberately-broken rolling control.
 *
 * NO NETWORK.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { afterEach, describe, expect, it } from 'vitest'
import { normaliseAxes, type VtAxis, type VtFont } from '~/lib/vectortype/font'
import {
  DEFAULT_CONFIG,
  VT_PRESET_DURATIONS,
  mergeConfig,
  type VectorTypeConfig,
  type VtMove,
} from '~/lib/vectortype/config'
import { vectorTypeFrame, vtIsAnimated } from '~/lib/vectortype/canvas'
import {
  VT_AXIS_PRESETS,
  VT_GRADE_FLICKER_CHANNEL,
  VT_GRADE_FLICKER_LEVEL_CHANNEL,
  VT_GRADE_FLICKER_SEED,
  VT_GRADE_FLICKER_STEPS,
  vtAxisAvailability,
  vtAxisDelta,
  vtAxisOffersFor,
  vtAxisPreset,
  vtAxisPresetCapabilities,
  vtAxisTagAvailability,
  vtGradeFlickerStep,
  type VtAxisPreset,
} from '~/lib/vectortype/axisPresets'
import { VT_BLINK_CHANNEL, VT_BLINK_PHASE_CHANNEL } from '~/lib/vectortype/blink'
import { VT_SCATTER_CHANNEL, VT_SCATTER_RATE_CHANNEL } from '~/lib/vectortype/scatter'
import { glyphRandom } from '~/lib/vectortype/random'
import { presetTransform, vtGlyphMotion, vtKnowsPreset, vtPresetIdsFor } from '~/lib/vectortype/presetMotion'

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
const SOURCE = fileURLToPath(new URL('../../app/lib/vectortype/axisPresets.ts', import.meta.url))

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

/** The fixture carries " Sailorg" only, so every test word comes from that set. */
const WORD = 'Sailor'
const N = WORD.length

/** The real 2-axis Inter subset: opsz 14–32, wght 100–900/400. NO `GRAD`. */
const INTER = font.axes

/** Roboto Flex's own `fvar`, as DATA — the same table `vectortype-axis-presets`
 *  uses, so a many-axis face can be exercised without a 1.7 MB binary or a
 *  network fetch. `GRAD` runs −200…150 about a default of 0. */
const ROBOTO_FLEX: VtAxis[] = [
  { tag: 'wght', name: 'Weight', min: 100, default: 400, max: 1000 },
  { tag: 'wdth', name: 'Width', min: 25, default: 100, max: 151 },
  { tag: 'opsz', name: 'Optical size', min: 8, default: 14, max: 144 },
  { tag: 'slnt', name: 'Slant', min: -10, default: 0, max: 0 },
  { tag: 'GRAD', name: 'Grade', min: -200, default: 0, max: 150 },
  { tag: 'XOPQ', name: 'Thick stroke', min: 27, default: 96, max: 175 },
  { tag: 'XTRA', name: 'Counter width', min: 323, default: 468, max: 603 },
  { tag: 'YOPQ', name: 'Thin stroke', min: 25, default: 79, max: 135 },
  { tag: 'YTAS', name: 'Ascender height', min: 649, default: 750, max: 854 },
  { tag: 'YTDE', name: 'Descender depth', min: -305, default: -203, max: -98 },
  { tag: 'YTFI', name: 'Figure height', min: 560, default: 738, max: 788 },
  { tag: 'YTLC', name: 'Lowercase height', min: 416, default: 514, max: 570 },
  { tag: 'YTUC', name: 'Uppercase height', min: 528, default: 712, max: 760 },
]
const GRAD = ROBOTO_FLEX.find(a => a.tag === 'GRAD')!

const flicker = (): VtAxisPreset => {
  const p = VT_AXIS_PRESETS.find(x => x.id === 'grade-flicker')
  if (!p) throw new Error('no grade-flicker preset')
  return p
}
const pulse = (): VtAxisPreset => {
  const p = VT_AXIS_PRESETS.find(x => x.id === 'grade-pulse')
  if (!p) throw new Error('no grade-pulse preset')
  return p
}

/** The GRAD delta this preset gives glyph `i` of an `n`-glyph run at loop phase. */
const at = (
  phase: number,
  i: number,
  n = N,
  axes: readonly VtAxis[] = ROBOTO_FLEX,
  resting?: Record<string, number>,
): number => vtAxisDelta(flicker(), phase, i, n, axes, resting).GRAD ?? 0

/** The whole run's deltas at one instant. */
const runAt = (phase: number, resting?: Record<string, number>): number[] =>
  Array.from({ length: N }, (_, i) => at(phase, i, N, ROBOTO_FLEX, resting))

function cfg(patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig {
  return mergeConfig({ ...DEFAULT_CONFIG, text: WORD, ...patch })
}

/** A config carrying one preset in one slot, with the stagger left at its
 *  shipped 0 — the FAST PATH, where a preset that emits axes has to widen the
 *  shaping itself or it returns numbers nothing ever draws. */
let flickerPresetMoveSeq = 0
function preset(
  slot: 'in' | 'out' | 'loop',
  spec: { presetId: string; duration?: number; ease?: string },
  motion: Partial<VectorTypeConfig['motion']> = {},
): VectorTypeConfig {
  flickerPresetMoveSeq += 1
  const mv: VtMove = {
    id: `move-${slot}-${flickerPresetMoveSeq}`,
    phase: slot,
    kind: 'preset',
    presetId: spec.presetId,
    duration: spec.duration ?? VT_PRESET_DURATIONS[slot],
    ease: { kind: 'named', name: 'none' },
    play: slot === 'loop' ? { mode: 'repeat', times: 1 } : { mode: 'once', times: 1 },
  }
  const baseMotion = {
    ...DEFAULT_CONFIG.motion,
    duration: 4,
    stagger: { delay: 0, order: 'forward', seed: 0 },
    ...motion,
  } as VectorTypeConfig['motion']
  const priorMoves = Array.isArray(baseMotion.moves) ? baseMotion.moves : []
  return cfg({
    motion: { ...baseMotion, moves: [...priorMoves, mv] },
  })
}

const CYCLE = 1.5
const live = (motion: Partial<VectorTypeConfig['motion']> = {}) =>
  preset('loop', { presetId: 'grade-flicker', duration: CYCLE }, motion)

const env = (axes: readonly VtAxis[] = ROBOTO_FLEX, resting?: Record<string, number>) => ({ axes, resting })

/** Pearson r. */
function pearson(a: number[], b: number[]): number {
  const n = a.length
  const ma = a.reduce((s, v) => s + v, 0) / n
  const mb = b.reduce((s, v) => s + v, 0) / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma
    const y = b[i]! - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db)
}

// ── The declaration ─────────────────────────────────────────────────────────

describe('the declaration — a GRAD tile beside Grade Pulse, not instead of it', () => {
  it('is a LOOP preset on GRAD, reachable through the table', () => {
    const p = flicker()
    expect(p.id).toBe('grade-flicker')
    expect(p.slot).toBe('loop')
    expect(p.axis).toBe('GRAD')                       // THE declaration — the frozen frame
    expect(p.axisName).toBe('Grade')
    expect(p.group).toBe('axis')
    expect(vtAxisPreset('loop', 'grade-flicker')).toBe(p)
    expect(vtAxisPreset('in', 'grade-flicker')).toBeNull()   // slot matters
    expect(vtKnowsPreset('loop', 'grade-flicker')).toBe(true)
  })

  it('carries the copy a tile needs, and requires `axes` BY PROBE', () => {
    const p = flicker()
    expect(p.label).toBe('Grade Flicker')
    expect(p.pitch.trim()).not.toBe('')
    // Derived by probing the function, exactly as the engine derives its own —
    // so a preset that never moved off `rest` would require nothing, and this
    // one does move.
    expect(vtAxisPresetCapabilities(p)).toEqual(['axes'])
  })

  it('a preset-only config reports ANIMATED — no frozen-word failure', () => {
    // The shader fill's failure mode, five times now: motion with nothing else
    // moving reports `duration: 0` and the surface draws one frame.
    expect(vtIsAnimated(live())).toBe(true)
  })

  it('sits next to Grade Pulse in the gallery, both on GRAD', () => {
    const ids = VT_AXIS_PRESETS.map(p => p.id)
    expect(ids.indexOf('grade-flicker')).toBe(ids.indexOf('grade-pulse') + 1)
    expect(VT_AXIS_PRESETS.filter(p => p.axis === 'GRAD').map(p => p.id))
      .toEqual(['grade-pulse', 'grade-flicker'])
  })
})

// ── THE POINT: only GRAD is ever touched ────────────────────────────────────

describe('NO REFLOW — the preset can only ever move GRAD', () => {
  it('emits the GRAD tag and NOTHING else, at every phase and every glyph', () => {
    // This is the structural half of the no-reflow proof. `GRAD` cannot change an
    // advance (measured on the real 13-axis file: 0.000 % across its entire
    // range); `wght`, `wdth`, `XTRA` and `XOPQ` all can. So a preset that never
    // emits any tag but GRAD cannot reflow the line even in principle.
    const seen = new Set<string>()
    for (let k = 0; k <= 240; k++) {
      for (let i = 0; i < 12; i++) {
        for (const rest of [GRAD.min, 0, GRAD.max, -73.5]) {
          const d = vtAxisDelta(flicker(), k / 240, i, 12, ROBOTO_FLEX, { GRAD: rest })
          for (const tag of Object.keys(d)) seen.add(tag)
        }
      }
    }
    expect([...seen]).toEqual(['GRAD'])
  })

  it('and through the FULL composition — `vtGlyphMotion` moves no geometry either', () => {
    // The tag test above is about the preset. This is about everything the
    // renderer is handed: an axis preset re-cuts the word, it does not move it,
    // so every spatial field must stay at rest while `axes.GRAD` swings.
    let swung = 0
    for (let k = 0; k < 60; k++) {
      const t = (k / 60) * CYCLE
      for (let i = 0; i < N; i++) {
        const m = vtGlyphMotion(live(), t, i, N, 200, env())
        expect(Object.keys(m.axes).filter(tag => tag !== 'GRAD')).toEqual([])
        expect(m.dx).toBe(0)
        expect(m.dy).toBe(0)
        expect(m.scale).toBe(1)
        expect(m.scaleX).toBe(1)
        expect(m.scaleY).toBe(1)
        expect(m.rotate).toBe(0)
        expect(m.opacity).toBe(1)
        expect(m.blur).toBe(0)
        expect(m.clip).toBeNull()
        if ((m.axes.GRAD ?? 0) !== 0) swung++
      }
    }
    // …and the loop was not vacuous: the ink really was moving throughout.
    expect(swung).toBeGreaterThan(60)
  })

  it('THE METRIC WORKS — a `wght` change moves the advances on this very fixture', () => {
    // Without this the GRAD result would be unfalsifiable: a spec that measured
    // advances with a metric that cannot move proves nothing. Same font, same
    // word, same code path — only the axis differs.
    const adv = (w: number) => {
      const f = vectorTypeFrame(font, cfg({ axes: { wght: w } }), 0)
      return f.outlines.glyphs.map(g => g.advance)
    }
    const light = adv(100)
    const heavy = adv(900)
    const total = (a: number[]) => a.reduce((s, v) => s + v, 0)
    // Measured on this fixture: 5066 → 5966 units of advance, +17.8 %.
    expect(total(heavy) / total(light)).toBeGreaterThan(1.05)
    for (let i = 0; i < light.length; i++) {
      expect(heavy[i]!, `glyph ${i}`).toBeGreaterThan(light[i]!)
    }
    // The Inter fixture has NO GRAD, which is exactly why the 0.000 % half of
    // this measurement had to be taken in the browser on Roboto Flex.
    expect(INTER.map(a => a.tag)).not.toContain('GRAD')
  })
})

// ── Per glyph, not per word — the whole difference from Grade Pulse ─────────

describe('every letter on its OWN state — where the pulse moves as one', () => {
  it('one instant, several different grades across the word', () => {
    // Grade Pulse: the whole word identical at any instant (its own spec pins
    // this). Flicker: a spread of states, most of them steady.
    const pulseAt = (phase: number) =>
      new Set(Array.from({ length: N }, (_, i) => vtAxisDelta(pulse(), phase, i, N, ROBOTO_FLEX).GRAD ?? 0))
    let manyValued = 0
    for (let k = 0; k < VT_GRADE_FLICKER_STEPS; k++) {
      const phase = (k + 0.5) / VT_GRADE_FLICKER_STEPS
      expect(pulseAt(phase).size).toBe(1)               // the control, at the same instants
      if (new Set(runAt(phase)).size > 2) manyValued++
    }
    expect(manyValued).toBeGreaterThan(VT_GRADE_FLICKER_STEPS / 2)
  })

  it('mostly steady, sometimes moving — a flicker, not noise', () => {
    // Over the whole cycle × the whole word: roughly half the glyph-steps sit
    // exactly on the user's design (delta 0, and so NO axis emitted at all).
    let zero = 0
    let total = 0
    for (let k = 0; k < VT_GRADE_FLICKER_STEPS; k++) {
      for (let i = 0; i < 40; i++) {
        total++
        if (at((k + 0.5) / VT_GRADE_FLICKER_STEPS, i, 40) === 0) zero++
      }
    }
    // FLICKER_STEADY is 0.5, so the expectation is half. Wide bounds, because
    // this is a property of a hash, not a quota.
    expect(zero / total).toBeGreaterThan(0.35)
    expect(zero / total).toBeLessThan(0.65)
  })

  it('goes BOTH ways — heavier and lighter, where the pulse only ever darkens', () => {
    const all: number[] = []
    for (let k = 0; k < VT_GRADE_FLICKER_STEPS; k++) {
      for (let i = 0; i < 40; i++) all.push(at((k + 0.5) / VT_GRADE_FLICKER_STEPS, i, 40))
    }
    expect(Math.max(...all)).toBeGreaterThan(0)
    expect(Math.min(...all)).toBeLessThan(0)
    // The pulse, at the same instants, is one-sided by construction.
    const beats = Array.from({ length: 33 }, (_, k) => vtAxisDelta(pulse(), k / 32, 0, N, ROBOTO_FLEX).GRAD ?? 0)
    expect(Math.min(...beats)).toBe(0)
    // Surges outnumber sags — up is the direction GRAD means.
    const moved = all.filter(v => v !== 0)
    expect(moved.filter(v => v > 0).length).toBeGreaterThan(moved.filter(v => v < 0).length)
  })

  it('every flicker is VISIBLE — no glyph-step lands a hair off rest', () => {
    // Without a floor on the magnitude, a uniform level would put half the
    // moving glyph-steps within a few axis units of rest: the effect measures as
    // busy and looks almost static.
    const moved: number[] = []
    for (let k = 0; k < VT_GRADE_FLICKER_STEPS; k++) {
      for (let i = 0; i < 60; i++) {
        const v = at((k + 0.5) / VT_GRADE_FLICKER_STEPS, i, 60)
        if (v !== 0) moved.push(Math.abs(v))
      }
    }
    expect(moved.length).toBeGreaterThan(100)
    // FLICKER_MIN 0.45 × FLICKER_ROOM 0.8 × 150 up / 200 down ⇒ ≥ 54 units.
    expect(Math.min(...moved)).toBeGreaterThan(50)
  })

  it('the run length does NOT change a glyph\'s state — no spatial wavelength', () => {
    // Weight Wave keys on i/n (one wavelength across the run) so its glyphs move
    // when the word grows. A flicker is per-letter: glyph 2 of "Sailor" and
    // glyph 2 of a 40-letter run are in the same state.
    for (const phase of [0.05, 0.3, 0.62, 0.91]) {
      for (let i = 0; i < 6; i++) {
        expect(at(phase, i, 6)).toBe(at(phase, i, 40))
      }
    }
  })
})

// ── Time enters as a BUCKET ─────────────────────────────────────────────────

describe('quantised in time — the step, not the phase, reaches the hash', () => {
  it('the step is floor(phase × steps), clamped into the cycle', () => {
    expect(vtGradeFlickerStep(0)).toBe(0)
    expect(vtGradeFlickerStep(0.999999)).toBe(VT_GRADE_FLICKER_STEPS - 1)
    expect(vtGradeFlickerStep(1)).toBe(VT_GRADE_FLICKER_STEPS - 1)      // the probe's edge
    expect(vtGradeFlickerStep(7)).toBe(VT_GRADE_FLICKER_STEPS - 1)      // junk from storage
    expect(vtGradeFlickerStep(-3)).toBe(0)
    // Non-finite is floored to 0, the convention `./random.ts` states for every
    // one of its own arguments — NOT clamped to the last step. A clock that is
    // not a number has no step, and step 0 is the one every glyph shares.
    expect(vtGradeFlickerStep(NaN)).toBe(0)
    expect(vtGradeFlickerStep(Infinity)).toBe(0)
    expect(vtGradeFlickerStep(-Infinity)).toBe(0)
    for (let k = 0; k < VT_GRADE_FLICKER_STEPS; k++) {
      expect(vtGradeFlickerStep(k / VT_GRADE_FLICKER_STEPS)).toBe(k)
      expect(vtGradeFlickerStep((k + 0.99) / VT_GRADE_FLICKER_STEPS)).toBe(k)
    }
  })

  it('the value is CONSTANT inside a step and JUMPS at the edge', () => {
    let jumps = 0
    for (let k = 0; k < VT_GRADE_FLICKER_STEPS; k++) {
      const lo = k / VT_GRADE_FLICKER_STEPS
      const hi = (k + 1) / VT_GRADE_FLICKER_STEPS
      const inside = Array.from({ length: 9 }, (_, j) => runAt(lo + ((j + 0.5) / 9) * (hi - lo)))
      for (const s of inside) expect(s).toEqual(inside[0]!)
      if (k > 0 && JSON.stringify(inside[0]) !== JSON.stringify(runAt(lo - 1e-9))) jumps++
    }
    // A hard cut at (nearly) every edge — that is what makes it read as a fault
    // rather than as a wobble.
    expect(jumps).toBeGreaterThan(VT_GRADE_FLICKER_STEPS - 4)
  })

  it('sampled ON the step edges, the two sides differ and each side is itself', () => {
    // The bucket edge is the one place a clock disagreement could show, so it is
    // sampled explicitly rather than only in the middle of a step.
    for (let k = 1; k < VT_GRADE_FLICKER_STEPS; k++) {
      const edge = k / VT_GRADE_FLICKER_STEPS
      expect(runAt(edge)).toEqual(runAt(edge + 1e-9))
      expect(runAt(edge - 1e-9)).toEqual(runAt(edge - 1e-7))
    }
  })

  it('THE RATE IS THE LOOP DURATION — no new control, no second clock', () => {
    // A 0.5 s cycle flickers three times as often as a 1.5 s one, because the
    // steps are per-cycle. Counted as changes to the whole run's state.
    const changes = (cycle: number) => {
      const c = preset('loop', { presetId: 'grade-flicker', duration: cycle })
      let n = 0
      let prev = ''
      for (let k = 0; k <= 900; k++) {
        const t = (k / 900) * 3
        const state = JSON.stringify(
          Array.from({ length: N }, (_, i) => presetTransform(c, t, i, N, 200, env()).axes.GRAD ?? 0))
        if (state !== prev) n++
        prev = state
      }
      return n
    }
    const slow = changes(1.5)
    const fast = changes(0.5)
    expect(fast).toBeGreaterThan(slow * 2)
  })
})

// ── Its own channels ────────────────────────────────────────────────────────

describe('its OWN random channels — never blink\'s, never the scatter\'s', () => {
  it('the constants are distinct from every channel already taken', () => {
    const taken = [VT_BLINK_CHANNEL, VT_BLINK_PHASE_CHANNEL, VT_SCATTER_CHANNEL, VT_SCATTER_RATE_CHANNEL]
    expect(taken).not.toContain(VT_GRADE_FLICKER_CHANNEL)
    expect(taken).not.toContain(VT_GRADE_FLICKER_LEVEL_CHANNEL)
    expect(VT_GRADE_FLICKER_CHANNEL).not.toBe(VT_GRADE_FLICKER_LEVEL_CHANNEL)
  })

  it('and they DECORRELATE, measured against a shared-channel control', () => {
    // The worst case: the same seed and the same bucket on both channels, which
    // is exactly the arrangement a copy-pasted constant would produce.
    const n = 2000
    const idx = Array.from({ length: n }, (_, i) => i)
    const mine = idx.map(i => glyphRandom(i, VT_GRADE_FLICKER_SEED, VT_GRADE_FLICKER_CHANNEL, 3))
    const level = idx.map(i => glyphRandom(i, VT_GRADE_FLICKER_SEED, VT_GRADE_FLICKER_LEVEL_CHANNEL, 3))
    const blink = idx.map(i => glyphRandom(i, VT_GRADE_FLICKER_SEED, VT_BLINK_CHANNEL, 3))
    const scatter = idx.map(i => glyphRandom(i, VT_GRADE_FLICKER_SEED, VT_SCATTER_CHANNEL, 3))
    // THE CONTROL: one channel against itself is r = 1 exactly. That is what
    // reusing `'blink'` here would have produced — not a correlation, the SAME
    // series, i.e. the letter that goes dark is the letter that surges hardest.
    expect(pearson(mine, mine)).toBeCloseTo(1, 12)
    // 99.9 % band for independent series at n = 2000 is ±0.0736.
    expect(Math.abs(pearson(mine, blink))).toBeLessThan(0.0736)
    expect(Math.abs(pearson(mine, scatter))).toBeLessThan(0.0736)
    expect(Math.abs(pearson(mine, level))).toBeLessThan(0.0736)
    expect(Math.abs(pearson(level, blink))).toBeLessThan(0.0736)
  })

  it('the user-visible spelling: the hardest surge is not the biggest step', () => {
    // "Which letter goes furthest" and "which way it went" must be independent
    // draws, or the eye reads the ordering as a pattern. 200 words of 8 letters,
    // asking whether the loudest glyph on one channel is the loudest on the
    // other; chance is 1/8.
    let agree = 0
    for (let w = 0; w < 200; w++) {
      const state = Array.from({ length: 8 }, (_, i) => glyphRandom(i, VT_GRADE_FLICKER_SEED, VT_GRADE_FLICKER_CHANNEL, w))
      const lvl = Array.from({ length: 8 }, (_, i) => glyphRandom(i, VT_GRADE_FLICKER_SEED, VT_GRADE_FLICKER_LEVEL_CHANNEL, w))
      const arg = (a: number[]) => a.indexOf(Math.max(...a))
      if (arg(state) === arg(lvl)) agree++
    }
    expect(agree / 200).toBeLessThan(0.3)     // measured ~0.13 against chance 0.125
  })
})

// ── Determinism ─────────────────────────────────────────────────────────────

describe('determinism — the same `t` twice, and a bake matching the preview', () => {
  const realRandom = Math.random
  afterEach(() => { Math.random = realRandom })

  /** A rolling flicker, implemented inline, put through the SAME assertions —
   *  so a passing pair of frames is evidence rather than a tautology. */
  const rolling = (): VtAxisPreset => ({
    ...flicker(),
    id: 'rolling-control',
    fn: (_phase, _i, _n, ctx) => ctx.rest + (Math.random() - 0.5) * 200,
  })

  it('the same phase evaluated twice is the same word — 240 samples', () => {
    for (let k = 0; k <= 240; k++) {
      const phase = k / 240
      expect(runAt(phase)).toEqual(runAt(phase))
    }
    // THE BROKEN CONTROL: the rolling version fails this immediately.
    const r = rolling()
    const once = Array.from({ length: N }, (_, i) => vtAxisDelta(r, 0.4, i, N, ROBOTO_FLEX).GRAD)
    const twice = Array.from({ length: N }, (_, i) => vtAxisDelta(r, 0.4, i, N, ROBOTO_FLEX).GRAD)
    expect(once).not.toEqual(twice)
  })

  it('a BAKE matches the PREVIEW — including on every step edge', () => {
    // The two real routes to the renderer: the surface holds a `mergeConfig`-ed
    // ref, while the node card, the PNG baker and the frame source read
    // `properties.sailor_vectorType` as parsed JSON.
    const preview = live()
    const baked = mergeConfig(JSON.parse(JSON.stringify(preview)))
    const raw = JSON.parse(JSON.stringify(preview))
    const shot = (c: any, t: number) =>
      Array.from({ length: N }, (_, i) => presetTransform(c, t, i, N, 200, env()).axes.GRAD ?? 0)
    const times: number[] = []
    for (let k = 0; k < VT_GRADE_FLICKER_STEPS; k++) {
      const edge = (k / VT_GRADE_FLICKER_STEPS) * CYCLE
      times.push(edge, edge + 1e-9, edge - 1e-9, edge + CYCLE / (2 * VT_GRADE_FLICKER_STEPS))
    }
    let moved = 0
    for (const t of times) {
      const p = shot(preview, t)
      expect(shot(baked, t), `bake @ ${t}`).toEqual(p)
      expect(shot(raw, t), `raw blob @ ${t}`).toEqual(p)
      if (p.some(v => v !== 0)) moved++
    }
    expect(moved).toBeGreaterThan(times.length / 3)      // not vacuously all-zero
  })

  it('an ACCUMULATING clock disagrees ONLY on a step edge — measured, not assumed', () => {
    // The bake computes `frame / fps`; a preview that accumulated `+= 1 / fps`
    // would sit an ulp away. THE FINDING, stated rather than hidden: 3 frames in
    // 600 do disagree, and every one of them is a frame whose time lands EXACTLY
    // on a step edge, where two float spellings of the same instant fall either
    // side of the floor. That is quantisation — the same ambiguity blink has and
    // merely hides (its beat edges are always fully lit) — not drift, and the
    // real requirement, same `t` → same picture, is exact and asserted above.
    const c = live()
    const shot = (t: number) =>
      Array.from({ length: N }, (_, i) => presetTransform(c, t, i, N, 200, env()).axes.GRAD ?? 0)
    const STEP_SECONDS = CYCLE / VT_GRADE_FLICKER_STEPS
    let acc = 0
    let differ = 0
    let maxDrift = 0
    let worstEdgeDistance = 0
    for (let f = 0; f < 600; f++) {
      const computed = f / 30
      maxDrift = Math.max(maxDrift, Math.abs(acc - computed))
      if (JSON.stringify(shot(acc)) !== JSON.stringify(shot(computed))) {
        differ++
        const edge = Math.abs(computed - Math.round(computed / STEP_SECONDS) * STEP_SECONDS)
        worstEdgeDistance = Math.max(worstEdgeDistance, edge)
      }
      acc += 1 / 30
    }
    // Under 1 % of frames, and the clocks themselves never drift measurably.
    expect(differ).toBeLessThan(6)
    expect(maxDrift).toBeLessThan(1e-9)
    // EVERY disagreement is on an edge, to the last bit. If a real drift ever
    // appeared, this is the assertion that would go red.
    expect(worstEdgeDistance).toBeLessThan(1e-12)
  })

  it('no roll reaches the path — a whole FRAME runs with Math.random trapped', () => {
    // Not "the source has no `Math.random`" but "the execution never called it".
    let calls = 0
    Math.random = () => { calls++; throw new Error('Math.random reached the flicker path') }
    for (const t of [0, 0.017, 0.4, CYCLE / 2, CYCLE - 1e-9, CYCLE, 3.7]) {
      for (let i = 0; i < N; i++) vtGlyphMotion(live(), t, i, N, 200, env())
      vectorTypeFrame(font, live(), t)
    }
    expect(calls).toBe(0)
    // …and the trap is shown to CATCH a control that does roll, so it is not
    // vacuous.
    expect(() => vtAxisDelta(rolling(), 0.4, 0, N, ROBOTO_FLEX)).toThrow(/Math\.random/)
  })

  it('the source carries no wall clock and no roll, comments aside', () => {
    const src = readFileSync(SOURCE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const bad of ['Math.random', 'Date.now', 'performance.now', 'new Date']) {
      expect(src, bad).not.toContain(bad)
    }
  })

  it('the seed is FIXED, so the tile looks the same every time it plays', () => {
    expect(VT_GRADE_FLICKER_SEED).not.toBe(0)              // see VT_RANDOM_SALT
    expect(Number.isInteger(VT_GRADE_FLICKER_SEED)).toBe(true)
    // Frozen: a change here re-rolls every saved clip that uses the tile, so it
    // should go red loudly rather than quietly. These are goldens.
    expect(runAt(0).map(v => Math.round(v * 1e6) / 1e6)).toMatchSnapshot('grade-flicker @ phase 0')
    expect(runAt(0.5).map(v => Math.round(v * 1e6) / 1e6)).toMatchSnapshot('grade-flicker @ phase 0.5')
  })
})

// ── Range safety ────────────────────────────────────────────────────────────

describe('inside the font\'s own range, from ANY resting position', () => {
  it('never leaves [min, max], across the cycle × the word × the range', () => {
    for (const rest of [GRAD.min, -100, 0, 75, GRAD.max]) {
      for (let k = 0; k <= 64; k++) {
        for (let i = 0; i < 12; i++) {
          const v = rest + at(k / 64, i, 12, ROBOTO_FLEX, { GRAD: rest })
          expect(v, `rest ${rest} phase ${k / 64} glyph ${i}`).toBeGreaterThanOrEqual(GRAD.min)
          expect(v, `rest ${rest} phase ${k / 64} glyph ${i}`).toBeLessThanOrEqual(GRAD.max)
        }
      }
    }
  })

  it('MIRRORS at an axis end instead of piling letters on the limit', () => {
    // The scatter measured this failure: a symmetric swing clamped at an end
    // puts several glyphs on exactly the same value, which reads as a rendering
    // bug in an effect whose point is that the letters differ.
    for (const [rest, sign] of [[GRAD.max, -1], [GRAD.min, 1]] as const) {
      const moved: number[] = []
      for (let k = 0; k < VT_GRADE_FLICKER_STEPS; k++) {
        for (let i = 0; i < 24; i++) {
          const v = at((k + 0.5) / VT_GRADE_FLICKER_STEPS, i, 24, ROBOTO_FLEX, { GRAD: rest })
          if (v !== 0) moved.push(v)
        }
      }
      expect(moved.length, `rest ${rest}`).toBeGreaterThan(80)
      // Everything went the ONE way there is room to go…
      expect(moved.every(v => Math.sign(v) === sign), `rest ${rest}`).toBe(true)
      // …and they are still spread out, not stacked on the limit.
      expect(new Set(moved.map(v => Math.round(v))).size, `rest ${rest}`).toBeGreaterThan(20)
    }
  })

  it('a degenerate or absent axis is silence, not a crash', () => {
    const stuck: VtAxis[] = [{ tag: 'GRAD', name: 'Grade', min: 0, default: 0, max: 0 }]
    expect(vtAxisDelta(flicker(), 0.3, 0, N, stuck)).toEqual({})
    expect(vtAxisDelta(flicker(), 0.3, 0, N, INTER)).toEqual({})
    expect(vtAxisDelta(flicker(), 0.3, 0, N, null)).toEqual({})
    expect(vtAxisDelta(flicker(), NaN, 0, N, ROBOTO_FLEX).GRAD ?? 0).not.toBeNaN()
    for (const junk of [NaN, Infinity, -Infinity]) {
      const d = vtAxisDelta(flicker(), junk, junk, junk, ROBOTO_FLEX)
      for (const v of Object.values(d)) expect(Number.isFinite(v)).toBe(true)
    }
  })
})

// ── Gracefully absent ───────────────────────────────────────────────────────

describe('a font without GRAD — disabled WITH THE REASON, from the shared generator', () => {
  it('the sentence is `vtAxisTagAvailability`\'s, not a hand-written one', () => {
    const offer = vtAxisAvailability(flicker(), INTER, 'Inter')
    expect(offer.available).toBe(false)
    expect(offer.axis).toBeNull()
    expect(offer.reason).toBe('Inter has no GRAD (Grade) axis — pick a font that does.')
    // BYTE-IDENTICAL to the one generator, so the studio cannot grow a second
    // vocabulary for "this font cannot do that".
    expect(offer.reason).toBe(vtAxisTagAvailability('GRAD', 'Grade', INTER, 'Inter').reason)
    // …and the same sentence Grade Pulse and a GRAD scatter show.
    expect(offer.reason).toBe(vtAxisAvailability(pulse(), INTER, 'Inter').reason)
  })

  it('OFFERED and greyed, never hidden — and available on Roboto Flex', () => {
    const inter = vtAxisOffersFor('loop', INTER, 'Inter')
    const flex = vtAxisOffersFor('loop', ROBOTO_FLEX, 'Roboto Flex')
    expect(inter.map(o => o.preset.id)).toContain('grade-flicker')     // the tile is there
    expect(inter.find(o => o.preset.id === 'grade-flicker')!.available).toBe(false)
    const ok = flex.find(o => o.preset.id === 'grade-flicker')!
    expect(ok.available).toBe(true)
    expect(ok.reason).toBeUndefined()
    expect(ok.axis).toEqual({ tag: 'GRAD', name: 'Grade', min: -200, default: 0, max: 150 })
    // The picker's id list, which is the clickable half, does NOT offer it.
    expect(vtPresetIdsFor('loop', INTER)).not.toContain('grade-flicker')
    expect(vtPresetIdsFor('loop', ROBOTO_FLEX)).toContain('grade-flicker')
  })

  it('a stored config naming it on Inter is a NO-OP — never a fallback fade', () => {
    // `evaluateAnimation` substitutes a fade for an id it does not know, so a
    // leak here would fade a word the user never asked to fade.
    const c = live()
    for (const t of [0, 0.3, 0.75, 1.2]) {
      const m = vtGlyphMotion(c, t, 0, N, 200, env(INTER))
      expect(m.axes).toEqual({})
      expect(m.opacity).toBe(1)
      expect(m.dx).toBe(0)
      expect(m.dy).toBe(0)
      expect(m.scale).toBe(1)
    }
    // On the real 2-axis fixture: nothing emitted, ONE shaping, and the frame is
    // identical to the same word with no preset at all.
    const f = vectorTypeFrame(font, c, 0.4)
    const plain = vectorTypeFrame(font, cfg(), 0.4)
    expect(f.transforms.every(tr => Object.keys(tr.axes).length === 0)).toBe(true)
    expect(f.shapings).toBe(1)
    const args = (x: typeof f) => x.outlines.glyphs.flatMap(g => g.commands.flatMap(cc => cc.args))
    expect(args(f)).toEqual(args(plain))
  })

  it('before a font has loaded, it emits nothing at all', () => {
    expect(presetTransform(live(), 0.4, 0, N, 200).axes).toEqual({})
    expect(vtGlyphMotion(live(), 0.4, 0, N, 200).axes).toEqual({})
  })
})

// ── Composition — the broken-neon pair ─────────────────────────────────────

describe('composes with the blink and with a GRAD scatter', () => {
  it('BLINK × FLICKER — letters go dark AND the lit ones waver, at one instant', () => {
    // The headline pairing. Blink multiplies into opacity, the flicker adds into
    // `axes`, so they are visible at the same time rather than one winning.
    const c = preset('loop', { presetId: 'grade-flicker', duration: CYCLE }, {
      blink: { amount: 0.8, rate: 6, stayLit: 0.4, unit: 'letter', seed: 1 },
    } as any)
    let bothAtOnce = 0
    for (let k = 0; k < 200; k++) {
      const t = (k / 200) * 3
      const run = Array.from({ length: N }, (_, i) => vtGlyphMotion(c, t, i, N, 200, env()))
      const dark = run.some(m => m.opacity === 0)
      const wavering = run.some(m => (m.axes.GRAD ?? 0) !== 0 && m.opacity > 0)
      if (dark && wavering) bothAtOnce++
    }
    expect(bothAtOnce).toBeGreaterThan(20)
    // And the blink did not disturb the grades: the axis half is identical with
    // the blink switched off, because they are different fields and different
    // channels.
    const off = preset('loop', { presetId: 'grade-flicker', duration: CYCLE })
    for (const t of [0.2, 0.9, 1.7]) {
      for (let i = 0; i < N; i++) {
        expect(vtGlyphMotion(c, t, i, N, 200, env()).axes)
          .toEqual(vtGlyphMotion(off, t, i, N, 200, env()).axes)
      }
    }
  })

  it('a GRAD SCATTER on top ADDS — neither source wins', () => {
    const c = preset('loop', { presetId: 'grade-flicker', duration: CYCLE }, {
      scatter: { spread: 0.5, axis: 'GRAD', mode: 'wander', settle: 0.8, rate: 0.3, seed: 1 },
    } as any)
    const bare = preset('loop', { presetId: 'grade-flicker', duration: CYCLE })
    const scatterOnly = preset('loop', { presetId: 'weight-in', duration: 0.0001 }, {
      scatter: { spread: 0.5, axis: 'GRAD', mode: 'wander', settle: 0.8, rate: 0.3, seed: 1 },
    } as any)
    let checked = 0
    for (const t of [0.35, 0.8, 1.4, 2.6]) {
      for (let i = 0; i < N; i++) {
        const both = vtGlyphMotion(c, t, i, N, 200, env()).axes.GRAD ?? 0
        const f = vtGlyphMotion(bare, t, i, N, 200, env()).axes.GRAD ?? 0
        const s = vtGlyphMotion(scatterOnly, t, i, N, 200, env()).axes.GRAD ?? 0
        expect(both, `t ${t} glyph ${i}`).toBeCloseTo(f + s, 9)
        if (f !== 0 && s !== 0) checked++
      }
    }
    // Non-vacuous: both sources were genuinely contributing somewhere.
    expect(checked).toBeGreaterThan(3)
  })
})
