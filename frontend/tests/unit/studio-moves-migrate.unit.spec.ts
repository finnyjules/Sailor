// frontend/tests/unit/studio-moves-migrate.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { convertLegacyTracks, mergeClip } from '~/lib/studio/moves/merge'

describe('studio moves migrate: 2026-09-03 phase/play -> at/loop/bounce', () => {
  it('converts an in/out/loop doc to at-anchored moves, identical placement', () => {
    const clip = mergeClip({
      moves: [
        { id: 'a', phase: 'in', kind: 'preset', presetId: 'fade-in', duration: 0.6, ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 } },
        { id: 'b', phase: 'out', kind: 'preset', presetId: 'fade-out', duration: 0.5, ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 } },
        { id: 'c', phase: 'loop', kind: 'preset', presetId: 'wave', duration: 1, ease: { kind: 'named', name: 'none' }, play: { mode: 'backAndForth', times: 1 } },
      ],
      duration: 4,
      fps: 30,
    })
    expect(clip.moves).toHaveLength(3)
    const a = clip.moves.find(m => m.id === 'a')!
    const b = clip.moves.find(m => m.id === 'b')!
    const c = clip.moves.find(m => m.id === 'c')!

    // phase: 'in' -> at: 0, loop: false
    expect(a.at).toBe(0)
    expect(a.loop).toBe(false)
    expect(a.bounce).toBeFalsy()

    // phase: 'out' -> at: max(0, clipDuration - duration) = 4 - 0.5 = 3.5
    expect(b.at).toBeCloseTo(3.5, 6)
    expect(b.loop).toBe(false)
    expect(b.bounce).toBeFalsy()

    // phase: 'loop' -> at: longestIn (the longest 'in' move's duration, 0.6),
    // loop: true; play.mode 'backAndForth' -> bounce: true
    expect(c.at).toBeCloseTo(0.6, 6)
    expect(c.loop).toBe(true)
    expect(c.bounce).toBe(true)
  })

  it('a new-shape (at/loop/bounce) doc round-trips unchanged', () => {
    const clip = mergeClip({
      moves: [{
        id: 'x', kind: 'tracks', presetId: 'custom', at: 1.2, duration: 1, loop: false,
        ease: { kind: 'named', name: 'none' },
        tracks: [{ path: 'axes.wght', from: 100, to: 900 }],
      }],
      duration: 4,
      fps: 30,
    })
    const x = clip.moves.find(m => m.id === 'x')!
    expect(x.at).toBe(1.2)
    expect(x.loop).toBe(false)
    expect(x.bounce).toBeFalsy()
  })

  it('convertLegacyTracks maps a legacy pingpong track to loop+bounce', () => {
    const moves = convertLegacyTracks([{ path: 'axes.wght', from: 100, to: 900, easing: 'pingpong', loops: 2 }], () => null, 4)
    expect(moves).toHaveLength(1)
    expect(moves[0]!.at).toBe(0)
    expect(moves[0]!.loop).toBe(true)
    expect(moves[0]!.bounce).toBe(true)
  })
})
