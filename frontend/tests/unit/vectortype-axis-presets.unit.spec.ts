/**
 * Vector Type — VARIABLE-AXIS motion presets (`~/lib/vectortype/axisPresets`).
 *
 * This is the section of the gallery the studio exists for. Fade/Slide/Grow are
 * things every motion tool has; animating `wght`, `GRAD` or `opsz` as design
 * parameters is what real outlines at interpolated axis positions buy, and it
 * fails in three specific, invisible ways:
 *
 *  1. values hard-coded to one font's range (`wght: 700` means nothing on a
 *     300–1000 face and is out of range on a 100–500 one);
 *  2. a preset whose axis the loaded font does not have, silently doing nothing;
 *  3. AXES RETURNED BUT NEVER SHAPED — the numbers are right, the glyphs never
 *     move, and every frame still looks like the word. That is the `delay === 0`
 *     fast path in `vectorTypeFrame`, and it is the trap Task 4 handed over.
 *
 * All three are asserted here against real outlines, from the checked-in Inter
 * variable subset. NO NETWORK.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
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
  VT_EVAL,
  isVtAxisPresetId,
  vtAxisAvailability,
  vtAxisCoords,
  vtAxisDelta,
  vtAxisOffersFor,
  vtAxisPreset,
  vtAxisPresetCapabilities,
  vtAxisPresetIdsFor,
  type VtAxisPreset,
} from '~/lib/vectortype/axisPresets'
import {
  presetTransform,
  vtGlyphMotion,
  vtHasPreset,
  vtKnowsPreset,
  vtAxisOffers,
  vtPresetIdsFor,
  IDENTITY_GLYPH_MOTION,
  VT_PRESET_CAPABILITIES,
} from '~/lib/vectortype/presetMotion'
import { ALL_PRESET_CAPABILITIES, evaluateAnimation, presetIdsFor } from '~/lib/motion/evaluate'

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

/** The fixture carries " Sailorg" only, so every test word comes from that set. */
const WORD = 'Sailor'

/** The 2-axis font, straight off the parsed file: opsz 14–32, wght 100–900/400. */
const INTER = font.axes

/**
 * The 13-axis font, as DATA. Roboto Flex's own `fvar` table — the ranges the
 * file declares, per `data/variable-fonts.ts` and the studio design spec — used
 * here to exercise availability against a many-axis face without a network
 * fetch or a 1.7 MB checked-in binary. Availability reads nothing but this
 * list, so the data is the whole input.
 */
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

function cfg(patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig {
  return mergeConfig({ ...DEFAULT_CONFIG, text: WORD, ...patch })
}

/** One `kind: 'tracks'` move wrapping a single track — `ease: 'none'`/
 *  `play: once ×1` reproduce the old default `easing: 'linear'`/`loops: 1`. */
let axisTrackMoveSeq = 0
function trackMove(path: string, from: number, to: number): VtMove {
  axisTrackMoveSeq += 1
  return {
    id: `move-track-${axisTrackMoveSeq}`,
    phase: 'loop',
    kind: 'tracks',
    presetId: 'custom',
    duration: 4,
    ease: { kind: 'named', name: 'none' },
    play: { mode: 'once', times: 1 },
    tracks: [{ path, from, to, hold: 0, cycleOffset: 0, delay: 0 }],
  }
}

/** A config carrying one preset move in one slot, plus whatever other motion
 *  the caller adds (including its own `moves`, e.g. a `trackMove`). `ease:
 *  'none'` throughout: nothing here checks eased output, only that the
 *  preset runs and reports itself — see Task 6's report for why that is a
 *  safe stand-in for the preset's own native ease. */
let axisPresetMoveSeq = 0
function preset(
  slot: 'in' | 'out' | 'loop',
  spec: { presetId: string; duration?: number; ease?: string },
  patch: Partial<VectorTypeConfig> = {},
  motion: Partial<VectorTypeConfig['motion']> = {},
): VectorTypeConfig {
  axisPresetMoveSeq += 1
  const mv: VtMove = {
    id: `move-${slot}-${axisPresetMoveSeq}`,
    phase: slot,
    kind: 'preset',
    presetId: spec.presetId,
    duration: spec.duration ?? VT_PRESET_DURATIONS[slot],
    ease: { kind: 'named', name: 'none' },
    play: slot === 'loop' ? { mode: 'repeat', times: 1 } : { mode: 'once', times: 1 },
  }
  const baseMotion = { ...DEFAULT_CONFIG.motion, duration: 4, ...motion } as VectorTypeConfig['motion']
  const priorMoves = Array.isArray(baseMotion.moves) ? baseMotion.moves : []
  return cfg({
    ...patch,
    motion: { ...baseMotion, moves: [...priorMoves, mv] },
  })
}

const byId = (id: string): VtAxisPreset => {
  const p = VT_AXIS_PRESETS.find(x => x.id === id)
  if (!p) throw new Error(`no preset ${id}`)
  return p
}

const env = (axes: readonly VtAxis[] = INTER, resting?: Record<string, number>) => ({ axes, resting })

// ── The catalog ─────────────────────────────────────────────────────────────

describe('the catalog — six presets, each naming a REAL axis', () => {
  it('is exactly the six, with the axis each one needs', () => {
    expect(VT_AXIS_PRESETS.map(p => [p.id, p.slot, p.axis])).toEqual([
      ['weight-in', 'in', 'wght'],
      ['weight-wave', 'loop', 'wght'],
      ['width-breathe', 'loop', 'wdth'],
      ['grade-pulse', 'loop', 'GRAD'],
      // The two GRAD tiles sit together in the gallery: one word beating as a
      // whole, one letter-by-letter fault. Both no-reflow, neither a variant of
      // the other — see `vectortype-grade-flicker.unit.spec.ts`.
      ['grade-flicker', 'loop', 'GRAD'],
      ['optical-drift', 'loop', 'opsz'],
    ])
  })

  it('every declared tag is an axis a shipping font actually has', () => {
    // Not just "four characters" — a typo'd `WGHT` or `weight` passes that and
    // then never matches a font for the rest of time.
    const real = new Set(ROBOTO_FLEX.map(a => a.tag))
    for (const p of VT_AXIS_PRESETS) {
      expect(p.axis, p.id).toMatch(/^[\x20-\x7E]{4}$/)
      expect(real.has(p.axis), `${p.id} → ${p.axis}`).toBe(true)
    }
  })

  it('ids are unique and every one is reachable through the table', () => {
    expect(new Set(VT_AXIS_PRESETS.map(p => p.id)).size).toBe(VT_AXIS_PRESETS.length)
    for (const p of VT_AXIS_PRESETS) {
      expect(vtAxisPreset(p.slot, p.id)).toBe(p)
      expect(isVtAxisPresetId(p.id)).toBe(true)
    }
    // The table is DERIVED from the list — nothing extra, nothing missing.
    const tabled = (['in', 'out', 'loop'] as const).flatMap(s => Object.keys(VT_EVAL[s]))
    expect(tabled.sort()).toEqual(VT_AXIS_PRESETS.map(p => p.id).sort())
  })

  it('carries the copy a tile needs', () => {
    for (const p of VT_AXIS_PRESETS) {
      expect(p.label.trim(), p.id).not.toBe('')
      expect(p.pitch.trim(), p.id).not.toBe('')
      expect(p.axisName.trim(), p.id).not.toBe('')
      expect(p.group).toBe('axis')
    }
  })

  it('refuses an id in the wrong slot, and junk', () => {
    expect(vtAxisPreset('loop', 'weight-in')).toBeNull()
    expect(vtAxisPreset('in', 'weight-wave')).toBeNull()
    expect(vtAxisPreset('in', null)).toBeNull()
    expect(vtAxisPreset('in', 42 as any)).toBeNull()
    expect(isVtAxisPresetId('slide-up')).toBe(false)
  })
})

// ── Capability derivation (Task 3b's mechanism, not a second list) ──────────

describe('capabilities — derived by probing, exactly as the engine does', () => {
  it('every axis preset requires `axes`', () => {
    for (const p of VT_AXIS_PRESETS) expect(vtAxisPresetCapabilities(p), p.id).toEqual(['axes'])
  })

  it('the probe is not vacuous — a preset that never moves requires nothing', () => {
    const inert: VtAxisPreset = { ...byId('weight-wave'), id: 'inert', fn: (_e, _i, _n, ctx) => ctx.rest }
    expect(vtAxisPresetCapabilities(inert)).toEqual([])
  })

  it('the SHARED engine is untouched — the Compositor can never be offered these', () => {
    for (const slot of ['in', 'out', 'loop'] as const) {
      const engine = presetIdsFor(slot, ALL_PRESET_CAPABILITIES)
      for (const p of VT_AXIS_PRESETS) expect(engine).not.toContain(p.id)
    }
  })

  it('Vector Type knows them, so a preset-only config reports ANIMATED', () => {
    expect(vtKnowsPreset('in', 'weight-in')).toBe(true)
    expect(vtKnowsPreset('loop', 'weight-wave')).toBe(true)
    expect(vtKnowsPreset('loop', 'weight-in')).toBe(false)      // slot matters
    const c = preset('loop', { presetId: 'weight-wave', duration: 2 })
    expect(vtHasPreset(c)).toBe(true)
    expect(vtIsAnimated(c)).toBe(true)
  })

  it('vtPresetIdsFor unions the engine list with what THIS font can run', () => {
    const loopInter = vtPresetIdsFor('loop', INTER)
    const loopFlex = vtPresetIdsFor('loop', ROBOTO_FLEX)
    // engine ids survive untouched, in order, in both
    // The studio's OWN capability set, which is what `vtPresetIdsFor` gates on
    // — `ALL_…` would re-admit the copy-based presets it cannot draw.
    const engine = presetIdsFor('loop', VT_PRESET_CAPABILITIES)
    expect(loopInter.slice(0, engine.length)).toEqual(engine)
    expect(loopInter).toContain('weight-wave')
    expect(loopInter).not.toContain('grade-pulse')             // Inter has no GRAD
    expect(loopInter).not.toContain('grade-flicker')            // …nor for the flicker
    expect(loopFlex).toContain('grade-pulse')
    expect(loopFlex).toContain('grade-flicker')
    // Every LOOP preset in the table, since Roboto Flex has all four tags.
    expect(loopFlex.length).toBe(engine.length + VT_AXIS_PRESETS.filter(p => p.slot === 'loop').length)
    // No font loaded yet ⇒ the honest answer is the engine's list alone.
    expect(vtPresetIdsFor('loop')).toEqual(engine)
    // …and the tiles a surface greys out come from the same one import.
    expect(vtAxisOffers('loop', INTER, 'Inter').filter(o => !o.available).map(o => o.reason))
      .toEqual(vtAxisOffersFor('loop', INTER, 'Inter').filter(o => !o.available).map(o => o.reason))
  })
})

// ── Range-relative values ───────────────────────────────────────────────────

describe('values are fractions of the FONT\'S OWN range, never absolutes', () => {
  const NARROW: VtAxis[] = [{ tag: 'wght', name: 'Weight', min: 300, default: 500, max: 800 }]
  const HAIRLINE: VtAxis[] = [{ tag: 'wght', name: 'Weight', min: 50, default: 400, max: 1000 }]

  it('Weight In starts at each font\'s own lightest cut', () => {
    const wIn = byId('weight-in')
    // e = 0: the axis MINIMUM, whatever it is — 100 on Inter, 300 on the narrow
    // face, 50 on a face that goes lighter than either.
    expect(vtAxisDelta(wIn, 0, 0, 1, INTER)).toEqual({ wght: 100 - 400 })
    expect(vtAxisDelta(wIn, 0, 0, 1, NARROW)).toEqual({ wght: 300 - 500 })
    expect(vtAxisDelta(wIn, 0, 0, 1, HAIRLINE)).toEqual({ wght: 50 - 400 })
    // A hard-coded value would give the same delta on all three.
    expect(vtAxisDelta(wIn, 0, 0, 1, INTER)).not.toEqual(vtAxisDelta(wIn, 0, 0, 1, NARROW))
  })

  it('and INTERPOLATES against that same range, not just at the endpoints', () => {
    // The endpoints alone are a weak test: the final clamp to [min,max] would
    // hide a hard-coded start value on any font whose minimum is higher than it.
    // Mid-flight the clamp is not in play, so this is where a fixed number shows.
    const wIn = byId('weight-in')
    expect(vtAxisDelta(wIn, 0.5, 0, 1, NARROW)).toEqual({ wght: -100 })   // 500 → 400, half way to 300
    expect(vtAxisDelta(wIn, 0.5, 0, 1, INTER)).toEqual({ wght: -150 })    // 400 → 250, half way to 100
    expect(vtAxisDelta(wIn, 0.25, 0, 1, NARROW)).toEqual({ wght: -150 })
  })

  it('Weight In ENDS STILL — the delta is exactly zero at the end of the entrance', () => {
    expect(vtAxisDelta(byId('weight-in'), 1, 0, 1, INTER)).toEqual({})
    // and it is monotone on the way there
    const seq = Array.from({ length: 9 }, (_, k) => vtAxisDelta(byId('weight-in'), k / 8, 0, 1, INTER).wght ?? 0)
    for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeGreaterThan(seq[i - 1]!)
  })

  it('Weight In honours where the USER parked the weight, not the font default', () => {
    // rest 700 ⇒ still ends at 700, still starts at the font's min.
    const at = (e: number) => vtAxisDelta(byId('weight-in'), e, 0, 1, INTER, { wght: 700 }).wght ?? 0
    expect(700 + at(0)).toBeCloseTo(100, 10)
    expect(at(1)).toBe(0)
  })

  it('the wave\'s amplitude scales with the axis span', () => {
    const wave = byId('weight-wave')
    const peak = (axes: VtAxis[]) => Math.max(...Array.from({ length: 65 },
      (_, k) => Math.abs(vtAxisDelta(wave, k / 64, 0, 1, axes).wght ?? 0)))
    // 0.35 of the span: 800 → 280 on Inter, 500 → 175 on the narrow face.
    expect(peak(INTER)).toBeCloseTo(280, 6)
    expect(peak(NARROW)).toBeCloseTo(175, 6)
    expect(peak(INTER) / peak(NARROW)).toBeCloseTo(800 / 500, 10)
  })

  it('never leaves the axis range, from ANY resting position', () => {
    for (const p of VT_AXIS_PRESETS) {
      const axes = ROBOTO_FLEX
      const axis = axes.find(a => a.tag === p.axis)!
      for (const rest of [axis.min, axis.default, axis.max, (axis.min + axis.max) / 2]) {
        for (let k = 0; k <= 32; k++) {
          const d = vtAxisDelta(p, k / 32, 0, 1, axes, { [axis.tag]: rest })[axis.tag] ?? 0
          const v = rest + d
          expect(v, `${p.id} rest ${rest} e ${k / 32}`).toBeGreaterThanOrEqual(axis.min)
          expect(v, `${p.id} rest ${rest} e ${k / 32}`).toBeLessThanOrEqual(axis.max)
        }
      }
    }
  })

  it('a LOOP preset still moves when the user is parked at an axis end', () => {
    // Amplitude-as-symmetric-headroom would be exactly 0 here — a tile that
    // visibly does nothing. The centre is pulled inside the range instead.
    const wave = byId('weight-wave')
    const peak = Math.max(...Array.from({ length: 65 },
      (_, k) => Math.abs(vtAxisDelta(wave, k / 64, 0, 1, INTER, { wght: 900 }).wght ?? 0)))
    expect(peak).toBeGreaterThan(100)
  })
})

// ── Grade Pulse is its own thing ────────────────────────────────────────────

describe('Grade Pulse is NOT Weight Wave with a different tag', () => {
  const sweep = (p: VtAxisPreset, i = 0, n = 1) =>
    Array.from({ length: 65 }, (_, k) => vtAxisDelta(p, k / 64, i, n, ROBOTO_FLEX)[p.axis] ?? 0)

  it('targets GRAD — weight WITHOUT width, so nothing reflows', () => {
    expect(byId('grade-pulse').axis).toBe('GRAD')
    expect(byId('weight-wave').axis).toBe('wght')
  })

  it('is ONE-SIDED — a beat, where the wave is a swing', () => {
    const beat = sweep(byId('grade-pulse'))
    const wave = sweep(byId('weight-wave'))
    expect(Math.min(...beat)).toBe(0)                         // never goes the other way
    expect(Math.max(...beat)).toBeGreaterThan(0)
    expect(beat.filter(v => v === 0).length).toBeGreaterThan(beat.length / 3)  // rests, flat
    expect(Math.min(...wave)).toBeLessThan(0)                 // crosses in both directions
    expect(Math.max(...wave)).toBeGreaterThan(0)
  })

  it('beats as ONE WORD, while the wave TRAVELS along it', () => {
    const n = WORD.length
    const at = (p: VtAxisPreset, phase: number) =>
      Array.from({ length: n }, (_, i) => vtAxisDelta(p, phase, i, n, ROBOTO_FLEX)[p.axis] ?? 0)
    // Grade: every glyph identical at one instant.
    expect(new Set(at(byId('grade-pulse'), 0.25)).size).toBe(1)
    // Weight: a crest, i.e. every glyph at its own point on the sine. (Four
    // distinct values, not six: one full wavelength spans the run, so the
    // glyphs either side of the crest sit at the same height — that IS a wave.)
    expect(new Set(at(byId('weight-wave'), 0.25)).size).toBeGreaterThanOrEqual(4)
    // …and it MOVES, FORWARDS through the word: one wavelength spans the run, so
    // advancing the phase by 1/n walks the crest on by exactly one glyph —
    // glyph i+1 then shows what glyph i showed before.
    const now = at(byId('weight-wave'), 0.25)
    const later = at(byId('weight-wave'), 0.25 + 1 / n)
    for (let i = 0; i < n - 1; i++) expect(later[i + 1]!, `glyph ${i}`).toBeCloseTo(now[i]!, 8)
  })

  it('Width Breathe moves the whole word together too — a width wave reads as broken', () => {
    const n = WORD.length
    const w = Array.from({ length: n },
      (_, i) => vtAxisDelta(byId('width-breathe'), 0.3, i, n, ROBOTO_FLEX).wdth ?? 0)
    expect(new Set(w).size).toBe(1)
  })
})

// ── Availability ────────────────────────────────────────────────────────────

describe('availability is per FONT, and says why', () => {
  it('a 2-axis font runs three of the six, and refuses three BY NAME', () => {
    const offers = [...vtAxisOffersFor('in', INTER), ...vtAxisOffersFor('loop', INTER)]
    // EVERY preset is offered, none hidden — the module's stated contract, and
    // the reason this counts the table rather than a literal.
    expect(offers.length).toBe(VT_AXIS_PRESETS.length)
    const ok = offers.filter(o => o.available).map(o => o.preset.id)
    const no = offers.filter(o => !o.available)
    expect(ok.sort()).toEqual(['optical-drift', 'weight-in', 'weight-wave'])
    expect(no.map(o => o.preset.id).sort()).toEqual(['grade-flicker', 'grade-pulse', 'width-breathe'])
    for (const o of no) {
      expect(o.reason, o.preset.id).toBeTruthy()
      expect(o.reason!).toContain(o.preset.axis)      // the TAG the user must go find
      expect(o.reason!).toContain(o.preset.axisName)
      expect(o.axis).toBeNull()
    }
  })

  it('a 13-axis font runs all six, with no reasons attached', () => {
    const offers = [...vtAxisOffersFor('in', ROBOTO_FLEX), ...vtAxisOffersFor('loop', ROBOTO_FLEX)]
    expect(offers.length).toBe(VT_AXIS_PRESETS.length)
    expect(offers.every(o => o.available)).toBe(true)
    expect(offers.every(o => o.reason === undefined)).toBe(true)
    // The font's REAL range comes back with the offer, so a tile can show it.
    expect(offers.find(o => o.preset.id === 'grade-pulse')!.axis).toEqual(
      { tag: 'GRAD', name: 'Grade', min: -200, default: 0, max: 150 })
  })

  it('names the font when it is given one', () => {
    const o = vtAxisAvailability(byId('grade-pulse'), INTER, 'Inter')
    expect(o.reason).toBe('Inter has no GRAD (Grade) axis — pick a font that does.')
  })

  it('a DEGENERATE axis is refused too — an axis with no range is a static value', () => {
    // Roboto Flex's `slnt` really is declared min = max = 0 in this table.
    const stuck: VtAxis[] = [{ tag: 'wght', name: 'Weight', min: 400, default: 400, max: 400 }]
    const o = vtAxisAvailability(byId('weight-in'), stuck)
    expect(o.available).toBe(false)
    expect(o.reason).toContain('no range')
    expect(vtAxisDelta(byId('weight-in'), 0, 0, 1, stuck)).toEqual({})
  })

  it('no font at all is "nothing runs", not a crash', () => {
    expect(vtAxisPresetIdsFor('loop', null)).toEqual([])
    expect(vtAxisPresetIdsFor('loop', undefined)).toEqual([])
    expect(vtAxisPresetIdsFor('loop', [])).toEqual([])
    expect(vtAxisDelta(byId('weight-wave'), 0.2, 0, 1, null)).toEqual({})
    expect(vtAxisOffersFor('loop', null).every(o => !o.available && !!o.reason)).toBe(true)
  })

  it('an unavailable preset is a NO-OP at render time, never a fallback fade', () => {
    // `evaluateAnimation` substitutes fade-in for an unknown id. If an axis
    // preset leaked through to the engine, picking "Grade Pulse" on Inter would
    // fade the word — a motion the user never asked for.
    const c = preset('in', { presetId: 'weight-in', duration: 1 })
    const t = presetTransform(c, 0.5, 0, WORD.length, 100, env([{ tag: 'opsz', name: 'Optical size', min: 14, default: 14, max: 32 }]))
    expect(t.opacity).toBe(1)
    expect(t.dx).toBe(0)
    expect(t.dy).toBe(0)
    expect(t.axes).toEqual({})
  })
})

// ── The clock, restated and pinned ──────────────────────────────────────────
//
// These used to drive the old `vtSlotPhase` (a private restatement of the
// engine's own in/out/loop windowing, kept only so the axis presets could
// land on the same instant an engine preset would). `vtSlotPhase` was removed
// once `presetTransform` switched to the shared `movePhase`/`moveWindows`
// (`~/lib/studio/moves/phase`) — the SAME windowing code every move (preset
// or track) now goes through. So the parity claim these tests exist to pin —
// "our progress/windowing agrees with `evaluateAnimation`'s own" — is now
// asserted through `presetTransform`, the real production entry point,
// instead of a since-deleted private helper.

describe('the axis clock is the ENGINE\'s clock', () => {
  const motion = { fps: 30, duration: 4 }

  it('IN progress matches evaluateAnimation exactly', () => {
    const spec = { presetId: 'fade-in', duration: 1.2, ease: 'none', stagger: 0 }
    const c = preset('in', { presetId: 'fade-in', duration: 1.2 })
    for (let k = 0; k <= 20; k++) {
      const gt = (k / 20) * 1.2 * 0.999
      const mine = presetTransform(c, gt, 0, 1, 100)
      const engine = evaluateAnimation({ offset: 0, duration: 4, in: spec } as any, gt, motion, 1)
      // fade-in with ease 'none' has opacity === e on both sides, so the two
      // only agree if `presetTransform`'s progress/windowing (via `movePhase`)
      // matches the engine's own.
      expect(mine.opacity, `t=${gt}`).toBeCloseTo(engine.units![0]!.opacity, 12)
    }
  })

  it('OUT progress matches evaluateAnimation exactly, window and all', () => {
    const spec = { presetId: 'fade-out', duration: 1, ease: 'none', stagger: 0 }
    const c = preset('out', { presetId: 'fade-out', duration: 1 })
    for (let k = 0; k <= 20; k++) {
      const gt = 3 + (k / 20) * 0.999
      const mine = presetTransform(c, gt, 0, 1, 100)
      const engine = evaluateAnimation({ offset: 0, duration: 4, out: spec } as any, gt, motion, 1)
      // fade-out's opacity is `1 - e` on BOTH sides, so comparing opacity
      // directly still pins the underlying progress/windowing agreement.
      expect(mine.opacity, `t=${gt}`).toBeCloseTo(engine.units![0]!.opacity, 12)
    }
  })

  it('LOOP phase matches — including the in→loop handoff', () => {
    const inSpec = { presetId: 'fade-in', duration: 1, stagger: 0 }
    const loop = { presetId: 'spin-loop', duration: 1.5, stagger: 0 }
    const withIn = preset('in', { presetId: 'fade-in', duration: 1 })
    const c = preset('loop', { presetId: 'spin-loop', duration: 1.5 }, {}, withIn.motion)
    for (let k = 0; k <= 20; k++) {
      const gt = 1 + (k / 20) * 2.9
      const mine = presetTransform(c, gt, 0, 1, 100)
      const engine = evaluateAnimation({ offset: 0, duration: 4, in: inSpec, loop } as any, gt, motion, 1)
      // spin-loop's rotation IS 360·phase, on both sides.
      expect(mine.rotate, `t=${gt}`).toBeCloseTo(engine.units![0]!.rotation, 10)
    }
  })

  it('nothing live contributes no motion', () => {
    const empty = cfg({ motion: { ...DEFAULT_CONFIG.motion, duration: 4, moves: [] } })
    expect(presetTransform(empty, 1, 0, 1, 100)).toEqual({ ...IDENTITY_GLYPH_MOTION, axes: {} })

    // The In move's own window (duration 1) has already closed by t=2, and
    // nothing else is live — same "nothing live" case `vtSlotPhase` used to
    // report as `null`, restated as "the identity motion, not a guess".
    const inOnly = preset('in', { presetId: 'fade-in', duration: 1 })
    expect(presetTransform(inOnly, 2, 0, 1, 100)).toEqual({ ...IDENTITY_GLYPH_MOTION, axes: {} })
  })
})

// ── THE POINT: outlines actually change ─────────────────────────────────────

describe('an axis preset changes the GLYPH OUTLINES — with stagger delay 0', () => {
  // delay 0 is the DEFAULT stagger, and it is the fast path Task 4 warned about:
  // one shaping for the whole run. An axis preset must widen it or it returns
  // perfectly good numbers that nothing ever shapes.
  const IN_DUR = 1
  const weightIn = () => preset('in', { presetId: 'weight-in', duration: IN_DUR }, {},
    { stagger: { delay: 0, order: 'forward', seed: 0 } })

  const ink = (f: ReturnType<typeof vectorTypeFrame>) => {
    const b = f.outlines.bbox
    return { w: b.maxX - b.minX, h: b.maxY - b.minY, area: (b.maxX - b.minX) * (b.maxY - b.minY) }
  }
  const args = (f: ReturnType<typeof vectorTypeFrame>) =>
    f.outlines.glyphs.flatMap(g => g.commands.flatMap(c => c.args))
  const cmds = (f: ReturnType<typeof vectorTypeFrame>) =>
    f.outlines.glyphs.flatMap(g => g.commands.map(c => c.command))

  it('the stagger really is 0 — the fast path is the one under test', () => {
    expect(weightIn().motion.stagger.delay).toBe(0)
    expect(vectorTypeFrame(font, weightIn(), 0).staggered).toBe(false)
  })

  it('shapes the run at the PRESET\'s weight, not the resting one', () => {
    const start = vectorTypeFrame(font, weightIn(), 0)
    const end = vectorTypeFrame(font, weightIn(), IN_DUR)
    // The config never moved — only the preset did. This is the assertion that
    // fails if `transforms[i].axes` is computed and then ignored.
    expect(start.config.axes.wght).toBeUndefined()
    expect(start.outlines.coords.wght).toBeCloseTo(100, 6)   // the axis MINIMUM
    expect(end.outlines.coords.wght).toBeCloseTo(400, 6)     // the font's default = rest
    expect(start.transforms[0]!.axes).toEqual({ wght: -300 })
    expect(end.transforms[0]!.axes).toEqual({})
  })

  it('the OUTLINES differ — same topology, different coordinates and different ink', () => {
    const start = vectorTypeFrame(font, weightIn(), 0)
    const end = vectorTypeFrame(font, weightIn(), IN_DUR)
    // gvar moves points, never adds them: identical command sequence…
    expect(cmds(start)).toEqual(cmds(end))
    expect(cmds(start).length).toBeGreaterThan(100)
    // …and genuinely different geometry.
    expect(args(start)).not.toEqual(args(end))
    expect(start.outlines.width).not.toBeCloseTo(end.outlines.width, 3)
    expect(ink(start).area).toBeLessThan(ink(end).area)      // 100 wght is thinner AND narrower
    // Report numbers (see mp-task-7-report.md): at 2048 upem the run measures
    // 5066 units of advance and 4850×1536 of ink at wght 100, against 5455 and
    // 5293×1565 at wght 400 — 7% narrower, 11% less ink, same 156 commands.
    expect(end.outlines.width / start.outlines.width).toBeGreaterThan(1.05)
  })

  it('costs ONE extra shaping, and drops back to the fast path when the delta is 0', () => {
    expect(vectorTypeFrame(font, weightIn(), 0).shapings).toBe(2)   // base + the preset's position
    expect(vectorTypeFrame(font, weightIn(), IN_DUR).shapings).toBe(1)
  })

  it('NEGATIVE CONTROL — the same run without the preset does not move at all', () => {
    const plain = cfg({ motion: { ...DEFAULT_CONFIG.motion, duration: 4 } as VectorTypeConfig['motion'] })
    const a = vectorTypeFrame(font, plain, 0)
    const b = vectorTypeFrame(font, plain, IN_DUR)
    expect(args(a)).toEqual(args(b))
    expect(a.shapings).toBe(1)
    // …and the preset's END frame is byte-identical to it, so the entrance
    // really does hand the word back untouched.
    expect(args(vectorTypeFrame(font, weightIn(), IN_DUR))).toEqual(args(a))
  })

  it('the WAVE gives every glyph its own outline in ONE frame — at delay 0', () => {
    const c = preset('loop', { presetId: 'weight-wave', duration: 2 }, {},
      { stagger: { delay: 0, order: 'forward', seed: 0 } })
    const f = vectorTypeFrame(font, c, 0.7)
    expect(f.staggered).toBe(false)                 // no stagger — the wave is spatial
    expect(f.shapings).toBeGreaterThan(3)           // distinct axis positions, really shaped
    const adv = f.outlines.glyphs.map(g => Math.round(g.advance))
    expect(new Set(adv).size).toBeGreaterThan(1)    // the word BREATHES across the crest
    const deltas = f.transforms.map(t => t.axes.wght)
    expect(new Set(deltas).size).toBe(WORD.length)
  })

  it('composes with an axis TRACK instead of replacing it', () => {
    const c = preset('loop', { presetId: 'weight-wave', duration: 2 },
      {},
      {
        stagger: { delay: 0, order: 'forward', seed: 0 },
        moves: [trackMove('axes.wght', 100, 900)],
      })
    const f = vectorTypeFrame(font, c, 2.3)         // linear 100→900 over 4 s ⇒ 560
    expect(f.config.axes.wght).toBeCloseTo(560, 6)
    // Every glyph sits at the TRACK's weight plus its own place on the crest,
    // and the crest is centred on the track's value rather than on the default.
    for (let i = 0; i < WORD.length; i++) {
      const d = f.transforms[i]!.axes.wght ?? 0
      expect(d, `glyph ${i}`).not.toBe(0)
      expect(560 + d).toBeGreaterThanOrEqual(100)
      expect(560 + d).toBeLessThanOrEqual(900)
    }
    // …and the geometry really was shaped there: more than one distinct weight,
    // all of them straddling 560 rather than 400.
    expect(f.shapings).toBeGreaterThan(3)
  })
})

// ── The defensive contract ──────────────────────────────────────────────────

describe('a config straight out of storage', () => {
  it('runs an axis preset from a blob that never saw mergeConfig', () => {
    const raw = {
      text: WORD, size: 200,
      motion: { duration: 4, in: { presetId: 'weight-in', duration: 1 } },
    } as any
    expect(vtHasPreset(raw)).toBe(true)
    expect(presetTransform(raw, 0, 0, WORD.length, 200, env()).axes).toEqual({ wght: -300 })
  })

  it('emits nothing at all before a font has loaded', () => {
    const c = preset('in', { presetId: 'weight-in', duration: 1 })
    expect(presetTransform(c, 0, 0, WORD.length, 100).axes).toEqual({})
    expect(vtGlyphMotion(c, 0, 0, WORD.length).axes).toEqual({})
  })

  it('never emits NaN, whatever the blob says', () => {
    const raw = {
      text: WORD, size: 'big',
      motion: { duration: 'soon', stagger: { delay: NaN }, loop: { presetId: 'weight-wave', duration: NaN } },
    } as any
    const m = vtGlyphMotion(raw, 0.5, 0, WORD.length, undefined, env())
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true)
    }
    for (const [tag, v] of Object.entries(m.axes)) expect(Number.isFinite(v), tag).toBe(true)
  })

  it('vtAxisCoords resolves exactly what a shaping needs — clamped, complete, sparse-safe', () => {
    expect(vtAxisCoords(INTER, {}, {})).toEqual({ opsz: 14, wght: 400 })
    expect(vtAxisCoords(INTER, { wght: 700 }, { wght: -300 })).toEqual({ opsz: 14, wght: 400 })
    expect(vtAxisCoords(INTER, { wght: 200 }, { wght: -500 })).toEqual({ opsz: 14, wght: 100 }) // clamped
    expect(vtAxisCoords(INTER, { XXXX: 5 } as any, null)).toEqual({ opsz: 14, wght: 400 })      // unknown dropped
    expect(vtAxisCoords(INTER, { wght: NaN }, { wght: 'x' } as any)).toEqual({ opsz: 14, wght: 400 })
    expect(vtAxisCoords(null, null, null)).toEqual({})
  })
})
