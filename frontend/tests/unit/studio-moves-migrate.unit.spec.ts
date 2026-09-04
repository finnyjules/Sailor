// frontend/tests/unit/studio-moves-migrate.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { convertLegacyTracks, mergeClip } from '~/lib/studio/moves/merge'
import { moveWindows } from '~/lib/studio/moves/phase'

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

    // phase: 'out', no in-moves (longestIn=0) -> at: max(0, clipDuration - duration) = 4 - 0.5 = 3.5,
    // duration stays 0.5 (clipDuration - at = 4 - 3.5 = 0.5, same as the raw duration: no compression needed)
    expect(b.at).toBeCloseTo(3.5, 6)
    expect(b.duration).toBeCloseTo(0.5, 6)
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

  it('an out that overlaps the longest in compresses its window instead of blending into the entrance', () => {
    // duration: 2, longestIn: 1.5 (the 'in' move's duration), out.duration: 1.5.
    // The OLD engine started the out at max(longestIn, clipDuration - duration) = max(1.5, 0.5) = 1.5
    // and eased it over the COMPRESSED window [1.5, 2] (0.5s), never over the raw 1.5s duration.
    // A buggy conversion that only floors `at` at 0 (not at longestIn) would place this at 0.5,
    // giving window [0.5, 2.0] — the exit would blend into the entrance at t=1.0, which never
    // happened in the old engine.
    const clip = mergeClip({
      moves: [
        { id: 'i', phase: 'in', kind: 'preset', presetId: 'fade-in', duration: 1.5, ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 } },
        { id: 'o', phase: 'out', kind: 'preset', presetId: 'fade-out', duration: 1.5, ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 } },
      ],
      duration: 2,
      fps: 30,
    })
    const out = clip.moves.find(m => m.id === 'o')!
    expect(out.at).toBeCloseTo(1.5, 6)
    expect(out.duration).toBeCloseTo(0.5, 6)

    const windows = moveWindows(clip.moves, 2)
    const outWindow = windows.find(w => w.move.id === 'o')!
    expect(outWindow.start).toBeCloseTo(1.5, 6)
    expect(outWindow.end).toBeCloseTo(2, 6)
  })
})
