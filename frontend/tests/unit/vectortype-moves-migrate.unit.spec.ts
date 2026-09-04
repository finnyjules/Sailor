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
    // `Move` dropped `phase`/`play` — a migrated slot is identified by its
    // own `presetId` now, and its old `play.mode` shows up as `loop`/`bounce`
    // (`~/lib/studio/moves/merge`'s `resolvePlacement`: `in`/`out` are
    // one-shot transitions, `loop` is `loop: true`).
    const inMove = cfg.motion.moves.find((m: Move) => m.presetId === 'fade-in')!
    expect(inMove.at).toBe(0)
    expect(inMove.loop).toBe(false)
    const outMove = cfg.motion.moves.find((m: Move) => m.presetId === 'fade-out')!
    expect(outMove.loop).toBe(false)
    const loopMove = cfg.motion.moves.find((m: Move) => m.presetId === 'wave')!
    expect(loopMove.loop).toBe(true)
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
    // `pingpong` -> an open-ended ping-pong cycle (`~/lib/studio/moves/merge`'s
    // `legacyTrackPlacement`: `loop: true, bounce: true` — the retired `play:
    // { mode: 'backAndForth' }` this replaces; the old `loops` COUNT has no
    // home in the at/loop model, an accepted, documented loss for a
    // continuous cycle — see that function's own doc).
    expect(m.loop).toBe(true)
    expect(m.bounce).toBe(true)
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
    expect(m.loop).toBe(true)
    expect(m.bounce).toBe(true)
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
    // The OLD (pre-moves) evaluator ran a `loops`-cycle sawtooth across the
    // clip whenever `loops > 1` (clamping only at `loops <= 1`) — a bug this
    // test used to pin against a `mode: 'once'` clamp that reached full value
    // at local progress `1/3` and froze there.
    //
    // Under the at/loop model, `loop: true` (this file's own `loop = times >
    // 1` rule, `~/lib/studio/moves/merge`'s `legacyTrackPlacement`) IS the
    // wrap, restoring the "does not freeze" half of that fix — but the exact
    // `loops` COUNT has no home in `at`/`loop`/`bounce` (there is no "N cycles
    // across the clip" knob any more): `convertLegacyTracks` gives the
    // converted move's `duration` the CLIP's own length regardless of
    // `loops`, so a saved `loops: 3` track now wraps ONCE per clip, not
    // three times. An accepted, documented loss (`legacyTrackPlacement`'s own
    // doc), not a bug this test should still assert against.
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
    // Wraps, not clamps: `loop: true` is what makes `trackRawProgress` do
    // `phase % 1` (./tracks.ts) instead of `clamp(phase, 0, 1)`.
    expect(move.loop).toBe(true)
    expect(move.duration).toBe(4)

    // ONE cycle over the 4s clip (not three): at t=2 — the midpoint of both
    // the clip and the move's own 4s cycle — from + (to-from) * 0.5 = 500,
    // the same number the old 3-cycle-per-clip evaluator happened to land on
    // at this exact sample (t=2 is also the midpoint of the 2nd of 3
    // 4/3s-long cycles: (2/4×3) mod 1 = 0.5), so this assertion is unchanged
    // even though the underlying cycle rate is not. The buggy `mode: 'once'`
    // clamp this test was written against instead gave
    // `clamp(1.5, 0, 1)` = 900.
    const atTwo = applyMotion(cfg, 2)
    expect((atTwo as any).size).toBeCloseTo(500, 6)
    expect((atTwo as any).size).not.toBeCloseTo(900, 6)

    // At the clip's own end (t=4, one full cycle of this move's own 4s
    // period) it is back at `from` — proof this is a repeating wrap, not a
    // clamp that would instead hold at `to` (900) past its pass. `toBeCloseTo`
    // rather than a bounds check: the wrap seam is exact sawtooth arithmetic
    // (`((gt-at)/dur) mod 1` — `~/lib/studio/moves/phase.ts`), not a
    // floating-point edge to hedge against.
    const atOneCycle = applyMotion(cfg, 4)
    const size = (atOneCycle as any).size as number
    expect(size).toBeCloseTo(100, 6)
    expect(size).not.toBeCloseTo(900, 6)
  })
})
