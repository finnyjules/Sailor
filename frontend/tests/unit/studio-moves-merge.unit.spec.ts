// frontend/tests/unit/studio-moves-merge.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { convertLegacyTracks, mergeMove } from '~/lib/studio/moves/merge'
import { animatableTargetsFromControls, applyMoveTracks } from '~/lib/studio/moves/tracks'
import type { MotionClip } from '~/lib/studio/moves/types'

describe('studio moves merge', () => {
  it('mergeMove drops a move with no presetId and no tracks', () => {
    expect(mergeMove({ id: 'a', phase: 'loop', kind: 'preset' })).toBeUndefined()
  })
  it('a pingpong legacy track becomes a custom back-and-forth move', () => {
    const moves = convertLegacyTracks([{ path: 'axes.wght', from: 100, to: 900, easing: 'pingpong', loops: 2 }], () => null)
    expect(moves).toHaveLength(1)
    expect(moves[0]!.kind).toBe('tracks'); expect(moves[0]!.presetId).toBe('custom')
    expect(moves[0]!.play).toEqual({ mode: 'backAndForth', times: 2 }); expect(moves[0]!.ease).toEqual({ kind: 'named', name: 'none' })
  })
  it('a matched preset collapses its tracks to one move', () => {
    const moves = convertLegacyTracks([{ path: 'layout.stretch', from: 1, to: 1.5, easing: 'linear', loops: 1 }], (t) => t.some(x => x.path === 'layout.stretch') ? 'stretch-wave' : null)
    expect(moves).toHaveLength(1); expect(moves[0]!.presetId).toBe('stretch-wave')
  })
})

describe('applyMoveTracks', () => {
  const io = {
    getByPath: (cfg: any, path: string) => cfg[path],
    setByPath: (cfg: any, path: string, value: unknown) => { cfg[path] = value },
    setByIdPath: (cfg: any, path: string, value: unknown) => { cfg[path] = value; return true },
  }
  const clip: MotionClip = {
    duration: 4,
    fps: 30,
    moves: [{
      id: 'm1', phase: 'loop', kind: 'tracks', presetId: 'custom', duration: 4,
      ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 },
      tracks: [{ path: 'a', from: 0, to: 10 }],
    }],
  }

  it('writes the linear midpoint at half the clip', () => {
    const out = applyMoveTracks({ a: -1 }, clip, 2, io) as any
    expect(out.a).toBeCloseTo(5, 6)
  })
  it('writes the start value at t = 0', () => {
    const out = applyMoveTracks({ a: -1 }, clip, 0, io) as any
    expect(out.a).toBeCloseTo(0, 6)
  })
  it('writes the end value once t reaches or passes the clip', () => {
    const out = applyMoveTracks({ a: -1 }, clip, 4, io) as any
    expect(out.a).toBeCloseTo(10, 6)
    const out2 = applyMoveTracks({ a: -1 }, clip, 9, io) as any
    expect(out2.a).toBeCloseTo(10, 6)
  })
})

describe('animatableTargetsFromControls', () => {
  it('skips a control with no numeric range and includes one that has it', () => {
    const targets = animatableTargetsFromControls(
      [
        { key: 'opacity', label: 'Opacity', min: 0, max: 1, group: 'Layer' },
        { key: 'label', label: 'Label' },
        { key: 'locked', label: 'Locked', min: 0, max: 1, animatable: false },
      ],
      {},
    )
    expect(targets).toEqual([{ path: 'opacity', label: 'Opacity', group: 'Layer', min: 0, max: 1 }])
  })
})
