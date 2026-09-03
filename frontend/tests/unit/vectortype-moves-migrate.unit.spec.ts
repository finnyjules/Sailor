// frontend/tests/unit/vectortype-moves-migrate.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { cloneConfig, DEFAULT_CONFIG, mergeConfig } from '~/lib/vectortype/config'
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
})
