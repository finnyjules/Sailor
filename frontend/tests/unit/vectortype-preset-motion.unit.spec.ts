/**
 * Vector Type — the shared motion engine adapted to glyphs (`presetMotion.ts`).
 *
 * Five failures these tests exist to prevent. Every one of them is silent — the
 * word still renders, so nothing errors and a screenshot looks plausible.
 *
 * 1. THE UNIT CONVERSION. `UnitState.dx/dy/blur` are unit-box heights; a glyph
 *    transform is output pixels. A missing `× em` looks almost right at one font
 *    size and wrong at every other, so every conversion is pinned at TWO sizes —
 *    a single-size test cannot tell 0.25 from 0.25·em and would pass either way.
 * 2. A PRESET-ONLY CONFIG REPORTING "NOT ANIMATED". `vtIsAnimated` gated on
 *    `tracks.length > 0`, which would have frozen the preview, the node card and
 *    the frame source for every user who only picked a preset.
 * 3. PRESETS AND TRACKS OVERWRITING EACH OTHER. The previous plan shipped exactly
 *    this (a Collection sweep and a motion track wrote one path; the sweep lost,
 *    and five identical PNGs looked fine). The composition is asserted through
 *    the REAL render path, with both sources live in one frame.
 * 4. TWO STAGGERS FIGHTING. `LayerAnimSpec.stagger` and `motion.stagger` are the
 *    same idea; only Vector Type's own may be live.
 * 5. N STACKED MOVES SILENTLY COLLAPSING TO ONE. The moves redesign (Task 5)
 *    generalises "one preset per phase" to "any number stacked" — two In moves
 *    must BOTH show, not just the last one merged.
 *
 * ## The move shape, since Task 4
 *
 * `motion.moves: VtMove[]` replaced the old three preset slots
 * (`motion.in`/`out`/`loop`) and the flat `motion.tracks` array — every preset,
 * every track, every entrance/exit/loop is one move (`~/lib/studio/moves/types`'s
 * `Move`, narrowed to Vector Type's four kinds in `config.ts`). `preset()` and
 * `trackMove()` below build one; `cfg()` always round-trips through
 * `mergeConfig`, so these tests exercise the real merge path (`mergeMove`,
 * `mergeEase`, `mergePlay`) as well as the evaluator.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { PRESET_CAPABILITIES } from '~/lib/motion/evaluate'
import type { MoveEase, MoveEaseName } from '~/lib/studio/moves/types'
import {
  DEFAULT_CONFIG,
  cloneConfig,
  mergeConfig,
  type VectorTypeConfig,
  type VtMotionTrack,
  type VtMove,
} from '~/lib/vectortype/config'
import {
  IDENTITY_GLYPH_MOTION,
  presetTransform,
  vtEmSize,
  vtGlyphMotion,
  vtHasPreset,
  vtKnowsPreset,
  vtPresetSpecs,
  vtStillTime,
} from '~/lib/vectortype/presetMotion'
import { vectorTypeFrame, vtIsAnimated } from '~/lib/vectortype/canvas'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'

// ── fixtures ────────────────────────────────────────────────────────────────

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return { id: 'inter-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}
const font = loadFixtureFont()
/** The fixture only carries " Sailorg". */
const WORD = 'Sailor'

function cfg(patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig {
  return mergeConfig({ ...cloneConfig(DEFAULT_CONFIG), text: WORD, ...patch })
}

const ease = (name: MoveEaseName): MoveEase => ({ kind: 'named', name })

let moveSeq = 0
/** One `preset`-kind move. `ease: 'none'` throughout, so progress is LINEAR
 *  and every expected number below is exact arithmetic rather than a curve
 *  sampled to 3 decimals. */
function presetMove(
  phase: 'in' | 'out' | 'loop',
  spec: { presetId: string; duration?: number; params?: Record<string, number> },
  over: Partial<VtMove> = {},
): VtMove {
  moveSeq += 1
  return {
    id: `move-${moveSeq}`,
    phase,
    kind: 'preset',
    presetId: spec.presetId,
    duration: spec.duration ?? 1,
    ease: ease('none'),
    play: phase === 'loop' ? { mode: 'repeat', times: 1 } : { mode: 'once', times: 1 },
    ...(spec.params ? { params: spec.params } : {}),
    ...over,
  }
}

/** One `tracks`-kind move wrapping a single track — the Custom-move shape a
 *  hand-authored track now takes. `ease: 'none'`/`play: once` reproduce the
 *  old default (linear, single pass) unless overridden. */
function trackMove(
  phase: 'in' | 'out' | 'loop',
  path: string,
  from: number,
  to: number,
  over: Partial<VtMotionTrack> = {},
  moveOver: Partial<VtMove> = {},
): VtMove {
  moveSeq += 1
  return {
    id: `move-${moveSeq}`,
    phase,
    kind: 'tracks',
    presetId: 'custom',
    duration: 1,
    ease: ease('none'),
    play: { mode: 'once', times: 1 },
    tracks: [{ path, from, to, hold: 0, cycleOffset: 0, delay: 0, ...over }],
    ...moveOver,
  }
}

/** A config carrying exactly one preset move in `slot`, and nothing else —
 *  the direct replacement for the old `preset(slot, spec)` helper. */
function preset(
  slot: 'in' | 'out' | 'loop',
  spec: { presetId: string; duration?: number; params?: Record<string, number> },
  patch: Partial<VectorTypeConfig> = {},
): VectorTypeConfig {
  const patchMotion = (patch.motion ?? {}) as Partial<VectorTypeConfig['motion']>
  const priorMoves = Array.isArray(patchMotion.moves) ? patchMotion.moves : []
  return cfg({
    ...patch,
    motion: {
      ...DEFAULT_CONFIG.motion,
      duration: 4,
      ...patchMotion,
      moves: [presetMove(slot, spec), ...priorMoves],
    } as VectorTypeConfig['motion'],
  })
}

// ── the config schema ───────────────────────────────────────────────────────

describe('mergeConfig — moves', () => {
  it('keeps a well-formed preset move, field by field', () => {
    const m = mergeConfig({
      motion: { moves: [presetMove('in', { presetId: 'slide-up', duration: 1.25, params: { overshoot: 2 } }, { ease: ease('slowDown') })] },
    }).motion
    expect(m.moves).toHaveLength(1)
    expect(m.moves[0]).toMatchObject({ phase: 'in', kind: 'preset', presetId: 'slide-up', duration: 1.25, params: { overshoot: 2 } })
    expect(m.moves[0]!.ease).toEqual(ease('slowDown'))
  })

  it('leaves the list empty when nothing is stored — a default config round-trips', () => {
    const m = mergeConfig({}).motion
    expect(m.moves).toEqual([])
    expect(mergeConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG)
  })

  it('survives a hostile blob', () => {
    // null / non-object / array / missing presetId → the move is dropped, not defaulted
    for (const junk of [null, undefined, 'slide-up', 7, [], { duration: 2 }, { kind: 'preset', presetId: '   ' }, { kind: 'preset', presetId: 42 }]) {
      expect(mergeConfig({ motion: { moves: [junk] } }).motion.moves, JSON.stringify(junk) ?? 'undefined').toEqual([])
    }
    // NaN / missing / absurd durations fall back or clamp; nothing NaN escapes
    expect(mergeConfig({ motion: { moves: [{ kind: 'preset', presetId: 'fade-in', duration: NaN }] } }).motion.moves[0]!.duration).toBeCloseTo(1, 10)
    expect(mergeConfig({ motion: { moves: [{ kind: 'preset', presetId: 'fade-in', duration: 0 } as any] } }).motion.moves[0]!.duration).toBe(0.05)
    expect(mergeConfig({ motion: { moves: [{ kind: 'preset', presetId: 'fade-in', duration: 1e9 } as any] } }).motion.moves[0]!.duration).toBe(60)
    // knobs: non-numeric values dropped, empty record not stored
    expect(mergeConfig({ motion: { moves: [{ kind: 'preset', presetId: 'wiggle', params: { amplitude: 0.3, cycles: '2', junk: null } } as any] } }).motion.moves[0]!.params)
      .toEqual({ amplitude: 0.3 })
    expect(mergeConfig({ motion: { moves: [{ kind: 'preset', presetId: 'wiggle', params: { cycles: 'x' } } as any] } }).motion.moves[0]).not.toHaveProperty('params')
    // a garbage ease falls back to the default rather than surviving unrecognised
    expect(mergeConfig({ motion: { moves: [{ kind: 'preset', presetId: 'fade-in', ease: 42 } as any] } }).motion.moves[0]!.ease.kind).toBe('named')
  })

  it('KEEPS an unknown preset id — and refuses to animate it', () => {
    // Same rule as an axis tag the current font lacks: the config layer does not
    // own the catalog, so a newer version's preset survives an older load.
    const c = mergeConfig({ motion: { moves: [presetMove('in', { presetId: 'quantum-swirl', duration: 1 })] } })
    expect(c.motion.moves).toHaveLength(1)
    expect(c.motion.moves[0]!.presetId).toBe('quantum-swirl')
    // …but nothing downstream guesses. The evaluator drops the move instead of
    // substituting a fade, so the user sees no motion rather than one they never picked.
    expect(vtKnowsPreset('in', 'quantum-swirl')).toBe(false)
    expect(vtPresetSpecs(c).in).toBeUndefined()
    expect(vtHasPreset(c)).toBe(false)
    expect(vtIsAnimated(c)).toBe(false)
    expect(presetTransform(c, 0.5, 0, 6)).toEqual({ ...IDENTITY_GLYPH_MOTION, axes: {} })
  })

  it('the engine\'s own per-unit stagger stays forced off — Vector Type has exactly one', () => {
    // A move carries no `stagger` concept at all any more (the old
    // `LayerAnimSpec.stagger` was a slot-spec field; `vtPresetSpecs` always
    // forces `stagger: 0` for the engine regardless of what a raw blob says),
    // so the behavioural guarantee is what is asserted directly: a raw,
    // never-merged move naming a stagger has no effect on the per-glyph
    // offset — `motion.stagger` (this studio's own single clock) is the only
    // source, and with it absent every glyph reads the same instant.
    const raw = {
      text: WORD, size: 100,
      motion: { duration: 4, moves: [{ id: 'm', phase: 'in', kind: 'preset', presetId: 'slide-up', duration: 1, ease: ease('none'), play: { mode: 'once', times: 1 }, stagger: 0.25 }] },
    } as any
    const a = presetTransform(raw, 0.5, 0, 6)
    const b = presetTransform(raw, 0.5, 5, 6)
    expect(a.dy).toBe(b.dy)     // no per-unit offset from a stray `stagger` key
    expect(vtPresetSpecs(raw).in!.stagger).toBe(0)
  })

  it('cloneConfig shares no move object with its source', () => {
    const a = mergeConfig({ motion: { moves: [presetMove('loop', { presetId: 'wiggle', duration: 2, params: { amplitude: 0.3 } })] } })
    const b = cloneConfig(a)
    b.motion.moves[0]!.duration = 9
    b.motion.moves[0]!.params!.amplitude = 9
    expect(a.motion.moves[0]!.duration).toBe(2)
    expect(a.motion.moves[0]!.params!.amplitude).toBe(0.3)
  })
})

// ── TRAP 1: the coordinate spaces ───────────────────────────────────────────

describe('presetTransform — unit-box heights → OUTPUT PIXELS', () => {
  // slide-up at linear progress 0.5 gives UnitState.dy = (1 - 0.5) × 0.5 = 0.25
  // unit-box heights. In pixels that is 0.25 × em, and the em IS `size`.
  const at = (size: number) => presetTransform(preset('in', { presetId: 'slide-up' }, { size }), 0.5, 0, WORD.length)

  it('scales dy with the em — pinned at two sizes', () => {
    expect(at(100).dy).toBeCloseTo(25, 10)   // 0.25 × 100
    expect(at(200).dy).toBeCloseTo(50, 10)   // 0.25 × 200 — a missing multiply gives 0.25 at BOTH
    expect(at(200).dy / at(100).dy).toBe(2)
  })

  it('scales dx with the em too, and keeps the sign convention', () => {
    const px = (size: number) => presetTransform(preset('in', { presetId: 'slide-left' }, { size }), 0.5, 0, WORD.length).dx
    expect(px(100)).toBeCloseTo(25, 10)
    expect(px(200)).toBeCloseTo(50, 10)
    // slide-up starts BELOW its resting place and rises: +dy is DOWN in both the
    // engine's space and the canvas's (y-down), so the sign passes straight
    // through. A flip here would make every slide preset arrive from the wrong side.
    expect(at(100).dy).toBeGreaterThan(0)
    expect(presetTransform(preset('in', { presetId: 'slide-down' }, { size: 100 }), 0.5, 0, WORD.length).dy).toBeLessThan(0)
  })

  it('scales BLUR with the em — same trap, different field', () => {
    // BLUR_MAX (0.12 unit-box heights) × (1 − 0.5) = 0.06 → 6px at em 100.
    const px = (size: number) => presetTransform(preset('in', { presetId: 'blur-in' }, { size }), 0.5, 0, WORD.length).blur
    expect(px(100)).toBeCloseTo(6, 10)
    expect(px(200)).toBeCloseTo(12, 10)
    expect(PRESET_CAPABILITIES['blur-in']).toContain('blur')
  })

  it('does NOT scale the dimensionless fields', () => {
    const spin = (size: number) => presetTransform(preset('in', { presetId: 'spin-in' }, { size }), 0.5, 0, WORD.length)
    expect(spin(100).rotate).toBeCloseTo(spin(400).rotate, 10)
    expect(spin(100).scale).toBeCloseTo(spin(400).scale, 10)
    expect(spin(100).opacity).toBeCloseTo(spin(400).opacity, 10)
  })

  it('reads the em from an ANIMATED size, so offsets match the geometry', () => {
    // `size` is animatable. `vtPlacement` scales the run by the animated value,
    // so the offsets must be in that same em — not the resting one.
    const c = preset('in', { presetId: 'slide-up' }, {
      size: 100,
      motion: { ...DEFAULT_CONFIG.motion, duration: 4, moves: [trackMove('loop', 'size', 100, 500)] } as VectorTypeConfig['motion'],
    })
    expect(vtEmSize(c, 0)).toBe(100)
    expect(vtEmSize(c, 2)).toBe(300)                     // half-way through 100→500
    expect(presetTransform(c, 0.5, 0, WORD.length).dy).toBeCloseTo(0.25 * vtEmSize(c, 0.5), 10)
  })

  it('carries clip through untouched — a fraction is not a length', () => {
    const m = presetTransform(preset('in', { presetId: 'mask-up' }, { size: 100 }), 0.5, 0, WORD.length)
    expect(m.clip).toEqual({ side: 'top', amount: 0.5 })
    const big = presetTransform(preset('in', { presetId: 'mask-up' }, { size: 400 }), 0.5, 0, WORD.length)
    expect(big.clip).toEqual({ side: 'top', amount: 0.5 })
    expect(big.dy).toBe(m.dy * 4)   // …while the mask's OFFSET is a length, and does scale
  })
})

// ── TRAP 2: the animated gate ───────────────────────────────────────────────

describe('vtIsAnimated — two sources, both counted', () => {
  it('a preset-only config reports ANIMATED', () => {
    for (const slot of ['in', 'out', 'loop'] as const) {
      const id = slot === 'in' ? 'fade-in' : slot === 'out' ? 'fade-out' : 'wave'
      const c = preset(slot, { presetId: id })
      expect(c.motion.moves.filter(m => m.kind === 'tracks')).toHaveLength(0)
      expect(vtIsAnimated(c), slot).toBe(true)
    }
  })

  it('still says no to a config with neither, and to junk out of storage', () => {
    expect(vtIsAnimated(cfg())).toBe(false)
    expect(vtIsAnimated(undefined)).toBe(false)
    expect(vtIsAnimated({ motion: 'later' } as any)).toBe(false)
    expect(vtIsAnimated({ motion: { moves: [{ kind: 'preset', presetId: '' }] } } as any)).toBe(false)
    expect(vtIsAnimated({ motion: { moves: 'slide-up' } } as any)).toBe(false)
  })

  it('a preset-only config still bakes a VISIBLE still', () => {
    // t = 0 of an entrance is deliberately empty; a still baked there is blank.
    expect(vtStillTime(cfg())).toBe(0)
    const c = preset('in', { presetId: 'fade-in', duration: 1 })
    expect(vtStillTime(c)).toBe(1)
    expect(presetTransform(c, vtStillTime(c), 0, WORD.length).opacity).toBe(1)
    // …and the stagger queue is waited out, so the LAST glyph is up too.
    const st = preset('in', { presetId: 'fade-in', duration: 1 }, {
      motion: { ...DEFAULT_CONFIG.motion, duration: 4, stagger: { delay: 0.1, order: 'forward', seed: 0 } } as VectorTypeConfig['motion'],
    })
    expect(vtStillTime(st)).toBeCloseTo(1 + 0.1 * (WORD.length - 1), 10)
    expect(presetTransform(st, vtStillTime(st), WORD.length - 1, WORD.length).opacity).toBe(1)
  })
})

// ── TRAP 3: composition ─────────────────────────────────────────────────────

describe('presets ∘ tracks — both are visible, neither wins', () => {
  const base = (extra: Partial<VectorTypeConfig['motion']> = {}) => preset('in', { presetId: 'slide-up' }, {
    size: 100,
    motion: { ...DEFAULT_CONFIG.motion, duration: 4, ...extra } as VectorTypeConfig['motion'],
  })

  it('offsets and rotation ADD', () => {
    const withTrack = base({ moves: [trackMove('loop', 'glyph.dy', 10, 10)] })
    // preset alone = 25px, track alone = 10px, together = 35px. Overwriting
    // either way would give 25 or 10 and still look like motion.
    expect(presetTransform(withTrack, 0.5, 0, WORD.length).dy).toBeCloseTo(25, 10)
    expect(vtGlyphMotion(base(), 0.5, 0, WORD.length).dy).toBeCloseTo(25, 10)
    expect(vtGlyphMotion(cfg({ motion: { ...DEFAULT_CONFIG.motion, moves: [trackMove('loop', 'glyph.dy', 10, 10)] } }), 0.5, 0, WORD.length).dy).toBe(10)
    expect(vtGlyphMotion(withTrack, 0.5, 0, WORD.length).dy).toBeCloseTo(35, 10)
  })

  it('scale and opacity MULTIPLY', () => {
    const c = preset('in', { presetId: 'grow-in' }, {
      size: 100,
      motion: {
        ...DEFAULT_CONFIG.motion, duration: 4,
        moves: [trackMove('loop', 'glyph.scale', 2, 2), trackMove('loop', 'glyph.opacity', 0.5, 0.5)],
      } as VectorTypeConfig['motion'],
    })
    const m = vtGlyphMotion(c, 0.5, 0, WORD.length)
    // grow-in at linear 0.5: scale 0.5, opacity min(1, 2×0.5) = 1
    expect(m.scale).toBeCloseTo(2 * 0.5, 10)
    expect(m.opacity).toBeCloseTo(0.5 * 1, 10)
  })

  it('opacity stays inside 0..1 however the two compose', () => {
    const c = preset('in', { presetId: 'fade-in' }, {
      motion: { ...DEFAULT_CONFIG.motion, duration: 4, moves: [trackMove('loop', 'glyph.opacity', 4, 4)] } as VectorTypeConfig['motion'],
    })
    expect(vtGlyphMotion(c, 3.9, 0, WORD.length).opacity).toBe(1)
  })

  it('THE SCENARIO: a Slide-Up preset and an axis track, in one real frame', () => {
    // Through `vectorTypeFrame`, not through the adapter — this is the path the
    // preview, the node card, the bake and the SVG export all cross.
    const c = preset('in', { presetId: 'slide-up' }, {
      size: 100,
      motion: { ...DEFAULT_CONFIG.motion, duration: 4, moves: [trackMove('loop', 'axes.wght', 100, 900)] } as VectorTypeConfig['motion'],
    })
    const frame = vectorTypeFrame(font, c, 0.5)
    // the TRACK ran: the run was shaped at the animated weight (0.5/4 of 100→900)
    expect(frame.config.axes.wght).toBeCloseTo(200, 10)
    expect(frame.outlines.coords.wght).toBeCloseTo(200, 10)
    // the PRESET ran: every glyph is offset by 0.25 em and half-faded
    expect(frame.transforms).toHaveLength(WORD.length)
    expect(frame.transforms[0]!.dy).toBeCloseTo(25, 10)
    expect(frame.transforms[0]!.opacity).toBeCloseTo(0.5, 10)

    // …and neither source changed what the other produced.
    const trackOnly = vectorTypeFrame(font, cfg({
      size: 100,
      motion: { ...DEFAULT_CONFIG.motion, duration: 4, moves: [trackMove('loop', 'axes.wght', 100, 900)] } as VectorTypeConfig['motion'],
    }), 0.5)
    const presetOnly = vectorTypeFrame(font, preset('in', { presetId: 'slide-up' }, { size: 100 }), 0.5)
    expect(trackOnly.outlines.coords.wght).toBeCloseTo(frame.outlines.coords.wght!, 10)
    expect(presetOnly.transforms[0]!.dy).toBeCloseTo(frame.transforms[0]!.dy, 10)
  })
})

// ── TRAP 4: one stagger ─────────────────────────────────────────────────────

describe('stagger — motion.stagger wins, and it is the only one', () => {
  const staggered = (delay: number, order: VectorTypeConfig['motion']['stagger']['order'] = 'forward') =>
    preset('in', { presetId: 'fade-in' }, {
      motion: { ...DEFAULT_CONFIG.motion, duration: 4, stagger: { delay, order, seed: 0 } } as VectorTypeConfig['motion'],
    })

  it('with delay 0 every glyph is identical', () => {
    const c = staggered(0)
    const o = [...WORD].map((_, i) => presetTransform(c, 0.5, i, WORD.length).opacity)
    expect(new Set(o).size).toBe(1)
  })

  it('with a delay the entrance TRAVELS — later glyphs are further behind', () => {
    const c = staggered(0.1)
    const o = [...WORD].map((_, i) => presetTransform(c, 0.5, i, WORD.length).opacity)
    for (let i = 1; i < o.length; i++) expect(o[i]!).toBeLessThan(o[i - 1]!)
    // glyph i reads (t − i·delay), so its linear progress is (0.5 − 0.1i)/1
    expect(o[0]!).toBeCloseTo(0.5, 10)
    expect(o[3]!).toBeCloseTo(0.2, 10)
  })

  it('honours ORDER, which the engine\'s own stagger cannot express', () => {
    const fwd = [...WORD].map((_, i) => presetTransform(staggered(0.1, 'forward'), 0.5, i, WORD.length).opacity)
    const rev = [...WORD].map((_, i) => presetTransform(staggered(0.1, 'reverse'), 0.5, i, WORD.length).opacity)
    expect(rev).toEqual([...fwd].reverse())
  })

  it('a glyph whose turn has not come is HELD at the start, never hidden', () => {
    // Before its turn a staggered glyph must not vanish (right for an entrance,
    // catastrophic for a loop — every glyph would blink out for its first
    // `rank·delay` seconds), and past the end the whole run would disappear on
    // the final frame of a bake. `presetTransform` clamps the pre-roll to
    // progress 0 (an entrance's own "fully out" state) instead.
    const c = staggered(0.5)
    expect(presetTransform(c, 0, 5, WORD.length).opacity).toBe(0)          // pre-roll of an entrance: fully out
    const loop = preset('loop', { presetId: 'wave', duration: 2 }, {
      motion: { ...DEFAULT_CONFIG.motion, duration: 4, stagger: { delay: 0.5, order: 'forward', seed: 0 } } as VectorTypeConfig['motion'],
    })
    for (let i = 0; i < WORD.length; i++) expect(presetTransform(loop, 0, i, WORD.length).opacity, `glyph ${i}`).toBe(1)
  })

  it('the last frame of the clip still MOVES', () => {
    // t === duration is outside the clip; un-clamped, the final frame of every
    // bake would fall back to a motionless run — a loop that visibly stops on
    // its last frame. `presetTransform` clamps `t` into the clip instead.
    const c = preset('loop', { presetId: 'wave', duration: 3 }, { size: 100 })
    // wave dy = −0.25·sin(2π·phase) unit-box heights; phase = (4⁻/3) mod 1 = ⅓
    const expected = -0.25 * Math.sin((2 * Math.PI) / 3) * 100
    expect(expected).toBeCloseTo(-21.65, 2)
    expect(presetTransform(c, 4, 0, WORD.length).dy).toBeCloseTo(expected, 3)
    expect(vectorTypeFrame(font, c, 4).transforms[0]!.dy).toBeCloseTo(expected, 3)
    expect(presetTransform(c, 4, 0, WORD.length).opacity).toBe(1)
  })
})

// ── TRAP 5: N STACKED MOVES ──────────────────────────────────────────────────

describe('stacked moves', () => {
  it('two In moves both live at t=0.5 compose — opacity partial AND vertical offset present', () => {
    const c = cfg({
      size: 100,
      motion: {
        ...DEFAULT_CONFIG.motion, duration: 4,
        moves: [
          presetMove('in', { presetId: 'fade-in', duration: 1 }),
          presetMove('in', { presetId: 'slide-up', duration: 1 }),
        ],
      } as VectorTypeConfig['motion'],
    })
    const m = presetTransform(c, 0.5, 0, WORD.length)
    // fade-in alone: opacity 0.5. slide-up alone: opacity 0.5 too, dy = 0.25·em.
    // Composed: opacity MULTIPLIES (0.5 × 0.5 = 0.25), dy ADDS (only slide-up
    // contributes one, so it passes through) — both effects visibly present,
    // neither move silently overwritten by the other.
    expect(m.opacity).toBeCloseTo(0.25, 10)
    expect(m.dy).toBeCloseTo(25, 10)
    // A single fade-in alone would read 0.5, not 0.25 — the number that would
    // come out if the second move had silently won instead of composing.
    const fadeAlone = presetTransform(preset('in', { presetId: 'fade-in', duration: 1 }, { size: 100 }), 0.5, 0, WORD.length)
    expect(fadeAlone.opacity).toBeCloseTo(0.5, 10)
    expect(m.opacity).not.toBeCloseTo(fadeAlone.opacity, 5)
  })

  it('a preset move and a custom axis track compose without throwing', () => {
    const c = cfg({
      size: 100,
      motion: {
        ...DEFAULT_CONFIG.motion, duration: 4,
        moves: [
          presetMove('in', { presetId: 'slide-up', duration: 1 }),
          trackMove('loop', 'axes.wght', 100, 900),
        ],
      } as VectorTypeConfig['motion'],
    })
    expect(() => presetTransform(c, 0.5, 0, WORD.length)).not.toThrow()
    const m = presetTransform(c, 0.5, 0, WORD.length)
    expect(m.dy).toBeCloseTo(25, 10)     // the preset move still ran
    expect(m.axes).toEqual({})           // presetTransform alone does not read tracks — axes.wght is applyMotion's job
    expect(() => vectorTypeFrame(font, c, 0.5)).not.toThrow()
    const frame = vectorTypeFrame(font, c, 0.5)
    expect(frame.outlines.coords.wght).toBeCloseTo(200, 10)  // the track ran through applyMotion
    expect(frame.transforms[0]!.dy).toBeCloseTo(25, 10)      // …and the preset ran too
  })

  it('no live move → identity {dx:0,dy:0,scale:1,opacity:1}', () => {
    // Every move's window has closed (both durations are 1s, sampled at t=2 of
    // a longer clip with no loop to hand off to): nothing is live, and the
    // fold must return true identity rather than a stale/partial state.
    const c = cfg({
      motion: {
        ...DEFAULT_CONFIG.motion, duration: 4,
        moves: [
          presetMove('in', { presetId: 'fade-in', duration: 1 }),
          presetMove('out', { presetId: 'fade-out', duration: 1 }),
        ],
      } as VectorTypeConfig['motion'],
    })
    const m = presetTransform(c, 2, 0, WORD.length)
    expect(m.dx).toBe(0)
    expect(m.dy).toBe(0)
    expect(m.scale).toBe(1)
    expect(m.opacity).toBe(1)
    expect(m).toEqual({ ...IDENTITY_GLYPH_MOTION, axes: {} })
  })
})

// ── the defensive contract ──────────────────────────────────────────────────

describe('a config straight out of storage', () => {
  it('evaluates presets from a blob that never saw mergeConfig', () => {
    // The surface holds a merged ref; the node card, the baker and the frame
    // source read parsed JSON. Same choke-point rule as ./motion.ts.
    const raw = {
      text: WORD, size: 200,
      motion: { duration: 4, moves: [{ id: 'm', phase: 'in', kind: 'preset', presetId: 'slide-up', duration: 1, ease: ease('none'), play: { mode: 'once', times: 1 } }] },
    } as any
    expect(vtHasPreset(raw)).toBe(true)
    expect(vtIsAnimated(raw)).toBe(true)
    expect(presetTransform(raw, 0.5, 0, WORD.length).dy).toBeCloseTo(50, 10)
  })

  it('never emits NaN, whatever the blob says', () => {
    const raw = {
      text: WORD, size: 'big',
      motion: {
        duration: 'soon', fps: null, stagger: { delay: NaN },
        moves: [{ id: 'm', phase: 'in', kind: 'preset', presetId: 'slide-up', duration: NaN, ease: ease('none'), play: { mode: 'once', times: 1 } }],
      },
    } as any
    const m = vtGlyphMotion(raw, 0.5, 0, WORD.length)
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true)
    }
    expect(vtEmSize(raw, 0)).toBe(DEFAULT_CONFIG.size)
  })

  it('costs nothing when no preset is set', () => {
    const c = cfg()
    expect(presetTransform(c, 1.5, 2, WORD.length)).toEqual({ ...IDENTITY_GLYPH_MOTION, axes: {} })
    expect(vtGlyphMotion(c, 1.5, 2, WORD.length)).toEqual({ ...IDENTITY_GLYPH_MOTION, axes: {} })
  })
})
