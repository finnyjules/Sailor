// frontend/tests/unit/vectortype-moves-migrate.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { cloneConfig, DEFAULT_CONFIG, mergeConfig } from '~/lib/vectortype/config'
import { applyMotion } from '~/lib/vectortype/motion'
import type { Move } from '~/lib/studio/moves/types'

describe('vt motion migration', () => {
  it('converts in/out/loop slots to preset moves', () => {
    const old = cloneConfig(DEFAULT_CONFIG) as any
    old.motion = {
      duration: 4,
      fps: 30,
      size: 1080,
      in: { presetId: 'fade-in', duration: 0.6, ease: 'power2.out' },
      out: { presetId: 'fade-out', duration: 0.5 },
      loop: { presetId: 'wave', duration: 1.2 },
      tracks: [],
      stagger: { delay: 0, order: 'forward', seed: 0 },
      blink: { amount: 0 },
      scatter: { spread: 0 },
    }
    const cfg = mergeConfig(old)
    expect(cfg.motion.moves).toHaveLength(3)
    const inMove = cfg.motion.moves.find((m: Move) => m.phase === 'in')!
    expect(inMove.presetId).toBe('fade-in')
    expect(inMove.play.mode).toBe('once')
    const outMove = cfg.motion.moves.find((m: Move) => m.phase === 'out')!
    expect(outMove.presetId).toBe('fade-out')
    expect(outMove.play.mode).toBe('once')
    const loopMove = cfg.motion.moves.find((m: Move) => m.phase === 'loop')!
    expect(loopMove.presetId).toBe('wave')
    expect(loopMove.play.mode).toBe('repeat')
  })

  it('a pingpong legacy track becomes a custom back-and-forth move', () => {
    const old = cloneConfig(DEFAULT_CONFIG) as any
    old.motion = {
      duration: 4,
      fps: 30,
      size: 1080,
      tracks: [{ path: 'axes.wght', from: 100, to: 900, easing: 'pingpong', loops: 2, hold: 0, cycleOffset: 0, delay: 0 }],
      stagger: { delay: 0, order: 'forward', seed: 0 },
      blink: { amount: 0 },
      scatter: { spread: 0 },
    }
    const m = mergeConfig(old).motion.moves[0]!
    expect(m.kind).toBe('tracks')
    expect(m.presetId).toBe('custom')
    expect(m.play).toEqual({ mode: 'backAndForth', times: 2 })
    expect(m.ease).toEqual({ kind: 'named', name: 'none' })
  })

  it('a saved Stretch Wave loop track keeps its own oscillation timing instead of being mislabeled as Stretch In', () => {
    // `stretch-in` and `stretch-wave` both write a single `stretch` path, so
    // this legacy track — pingpong/loops: 2, exactly what applying the
    // Stretch Wave gallery preset produces — is ambiguous by path alone.
    // Before the fix, `vtMatchLegacyTrackPreset` picked the earlier table
    // entry (`stretch-in`) and the matched-preset branch in
    // `convertLegacyTracks` discarded this track's own easing/loops for the
    // preset's fixed `ease: none` / `play: repeat x1` — silently flattening a
    // saved oscillating clip into a one-shot on load, and risking overwrite
    // on re-save. It must instead fall through to the per-track Custom
    // branch, which preserves the real stored timing and values.
    const old = cloneConfig(DEFAULT_CONFIG) as any
    old.motion = {
      duration: 4,
      fps: 30,
      size: 1080,
      tracks: [{ path: 'stretch', from: 0.88, to: 1.15, easing: 'pingpong', loops: 2, hold: 0, cycleOffset: 0, delay: 0 }],
      stagger: { delay: 0, order: 'forward', seed: 0 },
      blink: { amount: 0 },
      scatter: { spread: 0 },
    }
    const m = mergeConfig(old).motion.moves[0]!
    expect(m.kind).toBe('tracks')
    expect(m.presetId).toBe('custom')
    expect(m.play).toEqual({ mode: 'backAndForth', times: 2 })
    expect(m.tracks[0]!.from).toBe(0.88)
    expect(m.tracks[0]!.to).toBe(1.15)
  })

  it('a new-shape config round-trips unchanged (empty moves)', () => {
    expect(mergeConfig(cloneConfig(DEFAULT_CONFIG)).motion.moves).toEqual([])
  })

  it('a converted legacy track move takes its duration from the clip, not a hardcoded value', () => {
    const old = cloneConfig(DEFAULT_CONFIG) as any
    old.motion = {
      duration: 6,
      fps: 30,
      size: 1080,
      tracks: [{ path: 'axes.wght', from: 100, to: 900, easing: 'pingpong', loops: 1, hold: 0, cycleOffset: 0, delay: 0 }],
      stagger: { delay: 0, order: 'forward', seed: 0 },
      blink: { amount: 0 },
      scatter: { spread: 0 },
    }
    const cfg = mergeConfig(old)
    expect(cfg.motion.duration).toBe(6)
    expect(cfg.motion.moves[0]!.duration).toBe(6)
  })

  it('a non-pingpong legacy track with loops > 1 WRAPS across the clip, matching the old evaluator, instead of ramping once and freezing', () => {
    // The OLD evaluator ran a `loops`-cycle sawtooth across the clip whenever
    // `loops > 1` (clamping only at `loops <= 1`). `legacyTrackEasePlay` used
    // to map every `linear`/`easeinout` track to `play: { mode: 'once' }`
    // regardless of `loops`, and `mode: 'once'` CLAMPS — so a saved `loops: 3`
    // track reached full value at local progress `1/3` and held there for the
    // rest of the clip. This is the exact failing doc from the review.
    const old = cloneConfig(DEFAULT_CONFIG) as any
    old.motion = {
      duration: 4,
      fps: 30,
      size: 1080,
      tracks: [{ path: 'size', from: 100, to: 900, easing: 'linear', loops: 3, hold: 0, cycleOffset: 0, delay: 0 }],
      stagger: { delay: 0, order: 'forward', seed: 0 },
      blink: { amount: 0 },
      scatter: { spread: 0 },
    }
    const cfg = mergeConfig(old)
    const move = cfg.motion.moves[0]!
    // Wraps, not clamps: `repeat` is what makes `trackRawProgress` do
    // `phase % 1` (./tracks.ts) instead of `clamp(phase, 0, 1)`.
    expect(move.play).toEqual({ mode: 'repeat', times: 3 })

    // OLD value at t=2 of a 4s clip, loops=3: from + (to-from) * ((2/4*3) % 1)
    // = 100 + 800 * 0.5 = 500. The buggy `mode: 'once'` clamp instead gives
    // from + (to-from) * clamp(1.5, 0, 1) = 900.
    const atTwo = applyMotion(cfg, 2)
    expect((atTwo as any).size).toBeCloseTo(500, 6)
    expect((atTwo as any).size).not.toBeCloseTo(900, 6)

    // Just past one full cycle (4/3 s) it is back near `from` — proof this is
    // a repeating wrap, not a single ramp that happens to pass through 500.
    // Offset slightly off the exact wrap seam (4/3) to avoid asserting on a
    // floating-point boundary; a bounds check (not toBeCloseTo) keeps this
    // robust to exactly where the offset lands within the new cycle.
    const atOneCycle = applyMotion(cfg, 4 / 3 + 0.05)
    const size = (atOneCycle as any).size as number
    expect(size).toBeGreaterThan(100 - 1)
    expect(size).toBeLessThan(300)
  })
})
