import { describe, it, expect } from 'vitest'
import {
  addKeyframe, moveKeyframe, removeKeyframe, setTrack, type EffectDialTrack,
} from '~/lib/motion/effectTracks'

/**
 * F8 Task 5 · The pure keyframe reducers behind the timeline's per-dial track rows.
 *
 * `addKeyframe` inserts sorted and replaces a keyframe sitting at ~the same t;
 * `moveKeyframe` clamps t ≥ 0, keeps the moved keyframe's v/ease, and re-sorts (a
 * keyframe dragged past its neighbour reorders); `removeKeyframe` drops the right
 * one; `setTrack` replaces the track for a target immutably. None mutate inputs.
 */
const TARGET = 'layers.L1.effects.e-grain.amount'
const track = (kfs: EffectDialTrack['keyframes']): EffectDialTrack => ({ target: TARGET, keyframes: kfs })

describe('addKeyframe', () => {
  it('inserts a keyframe keeping the list sorted by t', () => {
    const t0 = track([{ t: 0, v: 0 }, { t: 2, v: 1 }])
    const next = addKeyframe(t0, 1, 0.5)
    expect(next.keyframes.map((k) => k.t)).toEqual([0, 1, 2])
    expect(next.keyframes[1]).toEqual({ t: 1, v: 0.5 })
  })

  it('clamps a negative t to 0', () => {
    const next = addKeyframe(track([{ t: 1, v: 1 }]), -3, 5)
    expect(next.keyframes[0]).toEqual({ t: 0, v: 5 })
  })

  it('replaces (does not stack) a keyframe already sitting at ~the same t', () => {
    const t0 = track([{ t: 0, v: 0 }, { t: 2, v: 1 }])
    const next = addKeyframe(t0, 2.0002, 0.9) // within KEYFRAME_EPS of t=2
    expect(next.keyframes).toHaveLength(2)
    expect(next.keyframes[1]!.v).toBe(0.9)
  })

  it('does not mutate the input track or its keyframes', () => {
    const t0 = track([{ t: 0, v: 0 }])
    const snap = JSON.parse(JSON.stringify(t0))
    addKeyframe(t0, 1, 1)
    expect(t0).toEqual(snap)
  })
})

describe('moveKeyframe', () => {
  it('moves a keyframe to a new t, keeping its v and ease', () => {
    const t0 = track([{ t: 0, v: 10, ease: 'linear' }, { t: 2, v: 20 }])
    const next = moveKeyframe(t0, 0, 0.5)
    const moved = next.keyframes.find((k) => k.v === 10)!
    expect(moved).toEqual({ t: 0.5, v: 10, ease: 'linear' })
  })

  it('clamps t to ≥ 0', () => {
    const next = moveKeyframe(track([{ t: 1, v: 1 }]), 0, -4)
    expect(next.keyframes[0]!.t).toBe(0)
  })

  it('re-sorts when a keyframe is dragged past its neighbour', () => {
    const t0 = track([{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2, v: 2 }])
    const next = moveKeyframe(t0, 0, 3) // first keyframe dragged past the others
    expect(next.keyframes.map((k) => k.t)).toEqual([1, 2, 3])
    expect(next.keyframes.map((k) => k.v)).toEqual([1, 2, 0])
  })

  it('returns the input unchanged for an out-of-range index', () => {
    const t0 = track([{ t: 0, v: 0 }])
    expect(moveKeyframe(t0, 5, 1)).toBe(t0)
  })

  it('does not mutate the input track or its keyframes', () => {
    const t0 = track([{ t: 0, v: 0 }, { t: 2, v: 1 }])
    const snap = JSON.parse(JSON.stringify(t0))
    moveKeyframe(t0, 1, 0.1)
    expect(t0).toEqual(snap)
  })
})

describe('removeKeyframe', () => {
  it('drops the keyframe at the given index', () => {
    const t0 = track([{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2, v: 2 }])
    const next = removeKeyframe(t0, 1)
    expect(next.keyframes.map((k) => k.t)).toEqual([0, 2])
  })

  it('returns the input unchanged for an out-of-range index', () => {
    const t0 = track([{ t: 0, v: 0 }])
    expect(removeKeyframe(t0, 9)).toBe(t0)
  })

  it('does not mutate the input', () => {
    const t0 = track([{ t: 0, v: 0 }, { t: 1, v: 1 }])
    const snap = JSON.parse(JSON.stringify(t0))
    removeKeyframe(t0, 0)
    expect(t0).toEqual(snap)
  })
})

describe('setTrack', () => {
  const A: EffectDialTrack = { target: 'layers.L1.effects.a.x', keyframes: [{ t: 0, v: 0 }] }
  const B: EffectDialTrack = { target: 'layers.L1.effects.b.y', keyframes: [{ t: 0, v: 1 }] }

  it('replaces the track for the target immutably', () => {
    const tracks = [A, B]
    const nextA: EffectDialTrack = { target: A.target, keyframes: [{ t: 0, v: 0 }, { t: 1, v: 1 }] }
    const out = setTrack(tracks, A.target, nextA)
    expect(out).not.toBe(tracks)
    expect(out[0]).toBe(nextA)
    expect(out[1]).toBe(B) // untouched track kept by reference
    expect(tracks[0]).toBe(A) // input array untouched
  })

  it('appends when no track drives the target (immutable upsert)', () => {
    const C: EffectDialTrack = { target: 'layers.L1.effects.c.z', keyframes: [{ t: 0, v: 2 }] }
    const out = setTrack([A], C.target, C)
    expect(out).toEqual([A, C])
  })

  it('does not mutate the input array', () => {
    const tracks = [A, B]
    setTrack(tracks, A.target, { target: A.target, keyframes: [] })
    expect(tracks).toEqual([A, B])
  })
})
