import { describe, it, expect, beforeEach } from 'vitest'
import { applyCommand } from '../../shared/timeline/commands'
import { createDefaultEditState, type EditState, type ImageClip, type Transition } from '../../shared/timeline/types'

function img(id: string, start: number, length: number): ImageClip {
  return { id, kind: 'image', asset_id: `asset-${id}`, start_frame: start, in_frame: 0, length }
}

function tr(id: string, trackId: string, from: string, to: string): Transition {
  return { id, track_id: trackId, from_clip_id: from, to_clip_id: to, kind: 'crossfade', duration: 10 }
}

describe('applyCommand', () => {
  let s: EditState
  let videoTrackId: string

  beforeEach(() => {
    s = createDefaultEditState()
    videoTrackId = s.tracks[0]!.id
  })

  it('add_clip / remove_clip round-trips; remove drops referencing transitions', () => {
    expect(applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('a', 0, 30) })).toBe(true)
    expect(applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('b', 30, 30) })).toBe(true)
    expect(applyCommand(s, { type: 'add_transition', transition: tr('t1', videoTrackId, 'a', 'b') })).toBe(true)
    expect(s.transitions).toHaveLength(1)
    expect(applyCommand(s, { type: 'remove_clip', clip_id: 'a' })).toBe(true)
    expect(s.tracks[0]!.clips.map(c => c.id)).toEqual(['b'])
    expect(s.transitions).toEqual([])
  })

  it('returns false (and leaves state untouched) for unknown targets', () => {
    const before = JSON.stringify(s)
    expect(applyCommand(s, { type: 'remove_clip', clip_id: 'ghost' })).toBe(false)
    expect(applyCommand(s, { type: 'move_clip', clip_id: 'ghost', to_track_id: videoTrackId, start_frame: 0 })).toBe(false)
    expect(JSON.stringify(s)).toBe(before)
  })

  it('move_clip to ANOTHER track drops the transitions that reference it', () => {
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('a', 0, 30) })
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('b', 30, 30) })
    applyCommand(s, { type: 'add_transition', transition: tr('t1', videoTrackId, 'a', 'b') })
    applyCommand(s, { type: 'add_track', track_id: 'v2', kind: 'video', name: 'Video 2' })
    expect(applyCommand(s, { type: 'move_clip', clip_id: 'a', to_track_id: 'v2', start_frame: 0 })).toBe(true)
    expect(s.transitions).toEqual([])
  })

  it('move_clip WITHIN its track keeps the transitions', () => {
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('a', 0, 30) })
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('b', 30, 30) })
    applyCommand(s, { type: 'add_transition', transition: tr('t1', videoTrackId, 'a', 'b') })
    expect(applyCommand(s, { type: 'move_clip', clip_id: 'a', to_track_id: videoTrackId, start_frame: 5 })).toBe(true)
    expect(s.transitions).toHaveLength(1)
    expect(s.transitions[0]!.from_clip_id).toBe('a')
    expect(s.transitions[0]!.to_clip_id).toBe('b')
  })

  it('split_clip splits length/in_frame and rebases keyframes onto the halves', () => {
    const clip = img('a', 10, 20)
    clip.keyframes = [
      { frame: 0, x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 },
      { frame: 15, x: 1, y: 0, rotation: 0, scale: 1, opacity: 1 },
    ]
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip })
    expect(applyCommand(s, { type: 'split_clip', clip_id: 'a', frame: 18, new_clip_id: 'a2' })).toBe(true)

    const [left, right] = s.tracks[0]!.clips
    expect(left!.id).toBe('a')
    expect(left!.length).toBe(8)
    expect(left!.keyframes).toEqual([{ frame: 0, x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 }])
    expect(right!.id).toBe('a2')
    expect(right!.start_frame).toBe(18)
    expect(right!.in_frame).toBe(8)
    expect(right!.length).toBe(12)
    expect(right!.keyframes).toEqual([{ frame: 7, x: 1, y: 0, rotation: 0, scale: 1, opacity: 1 }])
  })

  it('split_clip rejects cuts outside the clip body', () => {
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('a', 10, 20) })
    expect(applyCommand(s, { type: 'split_clip', clip_id: 'a', frame: 10, new_clip_id: 'x' })).toBe(false)
    expect(applyCommand(s, { type: 'split_clip', clip_id: 'a', frame: 30, new_clip_id: 'x' })).toBe(false)
  })

  it('split_clip remaps an end-junction transition to the new right half', () => {
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('a', 0, 30) })
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('b', 30, 30) })
    applyCommand(s, { type: 'add_transition', transition: tr('t1', videoTrackId, 'a', 'b') })
    applyCommand(s, { type: 'split_clip', clip_id: 'a', frame: 15, new_clip_id: 'a2' })
    expect(s.transitions[0]!.from_clip_id).toBe('a2')
    expect(s.transitions[0]!.to_clip_id).toBe('b')
  })

  it('ripple_delete closes the gap on that track only', () => {
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('a', 0, 30) })
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('b', 30, 30) })
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('c', 60, 30) })
    expect(applyCommand(s, { type: 'ripple_delete', clip_id: 'b' })).toBe(true)
    const ids = s.tracks[0]!.clips.map(c => [c.id, c.start_frame])
    expect(ids).toEqual([['a', 0], ['c', 30]])
  })

  it('add_keyframe captures the interpolated transform at a global frame', () => {
    const clip = img('a', 10, 20)
    clip.x = 0.4
    clip.scale = 2
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip })
    expect(applyCommand(s, { type: 'add_keyframe', clip_id: 'a', frame: 15 })).toBe(true)
    const stateClip = s.tracks[0]!.clips[0]!
    expect(stateClip.keyframes).toEqual([
      { frame: 5, x: 0.4, y: 0, rotation: 0, scale: 2, opacity: 1, ease: 'linear' },
    ])
  })

  it('set_clip_transform writes scalars when unkeyed, keyframe at frame when keyed', () => {
    const clip = img('a', 0, 30)
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip })
    applyCommand(s, { type: 'set_clip_transform', clip_id: 'a', frame: 5, patch: { x: 0.25 } })
    const stateClip = s.tracks[0]!.clips[0]!
    expect(stateClip.x).toBe(0.25)
    expect(stateClip.keyframes).toBeUndefined()

    applyCommand(s, { type: 'add_keyframe', clip_id: 'a', frame: 0 })
    applyCommand(s, { type: 'set_clip_transform', clip_id: 'a', frame: 10, patch: { x: 0.9 } })
    expect(stateClip.keyframes).toHaveLength(2)
    expect(stateClip.keyframes![1]).toMatchObject({ frame: 10, x: 0.9 })
  })

  it('add_transition requires both clips and replaces the same junction', () => {
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('a', 0, 30) })
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('b', 30, 30) })
    expect(applyCommand(s, { type: 'add_transition', transition: tr('t1', videoTrackId, 'a', 'ghost') })).toBe(false)
    applyCommand(s, { type: 'add_transition', transition: tr('t1', videoTrackId, 'a', 'b') })
    applyCommand(s, { type: 'add_transition', transition: { ...tr('t2', videoTrackId, 'a', 'b'), kind: 'wipe_left' } })
    expect(s.transitions).toHaveLength(1)
    expect(s.transitions[0]!.id).toBe('t2')
    expect(applyCommand(s, { type: 'update_transition', transition_id: 't2', patch: { duration: 4 } })).toBe(true)
    expect(s.transitions[0]!.duration).toBe(4)
    expect(applyCommand(s, { type: 'remove_transition', transition_id: 't2' })).toBe(true)
    expect(s.transitions).toEqual([])
  })

  it('remove_track drops its transitions', () => {
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('a', 0, 30) })
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('b', 30, 30) })
    applyCommand(s, { type: 'add_transition', transition: tr('t1', videoTrackId, 'a', 'b') })
    expect(applyCommand(s, { type: 'remove_track', track_id: videoTrackId })).toBe(true)
    expect(s.transitions).toEqual([])
  })

  it('remove_keyframe returns false without mutating on miss or empty array', () => {
    const clip = img('a', 0, 30)
    ;(clip as any).keyframes = []
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip })
    const before = JSON.stringify(s)
    expect(applyCommand(s, { type: 'remove_keyframe', clip_id: 'a', frame: 5 })).toBe(false)
    expect(JSON.stringify(s)).toBe(before)
  })

  it('split_clip rounds fractional cut frames', () => {
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('a', 0, 20) })
    expect(applyCommand(s, { type: 'split_clip', clip_id: 'a', frame: 10.4, new_clip_id: 'a2' })).toBe(true)
    const [left, right] = s.tracks[0]!.clips
    expect(left!.length).toBe(10)
    expect(right!.start_frame).toBe(10)
    expect(right!.in_frame).toBe(10)
    expect(right!.length).toBe(10)
  })

  it('add_transition rejects clips not on the named track', () => {
    applyCommand(s, { type: 'add_track', track_id: 'v2', kind: 'video', name: 'Video 2' })
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('a', 0, 30) })
    applyCommand(s, { type: 'add_clip', track_id: 'v2', clip: img('b', 30, 30) })
    expect(applyCommand(s, { type: 'add_transition', transition: tr('t1', videoTrackId, 'a', 'b') })).toBe(false)
    expect(applyCommand(s, { type: 'add_transition', transition: tr('t1', 'bogus', 'a', 'b') })).toBe(false)
    expect(s.transitions).toEqual([])
  })

  it('add_transition leaves state untouched when validation fails, and clones on success', () => {
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('a', 0, 30) })
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip: img('b', 30, 30) })
    const t = tr('t1', videoTrackId, 'a', 'b')
    applyCommand(s, { type: 'add_transition', transition: t })
    t.duration = 999
    expect(s.transitions[0]!.duration).toBe(10)
  })

  it('add_clip clones its payload — caller mutations do not leak into state', () => {
    const clip = img('a', 0, 30)
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip })
    clip.start_frame = 999
    expect(s.tracks[0]!.clips[0]!.start_frame).toBe(0)
  })

  it('keyframe maintenance: remove / move / ease (clip-local frames)', () => {
    const clip = img('a', 0, 30)
    clip.keyframes = [
      { frame: 0, x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 },
      { frame: 20, x: 1, y: 0, rotation: 0, scale: 1, opacity: 1 },
    ]
    applyCommand(s, { type: 'add_clip', track_id: videoTrackId, clip })
    const stateClip = s.tracks[0]!.clips[0]!
    expect(applyCommand(s, { type: 'move_keyframe', clip_id: 'a', from_frame: 20, to_frame: 10 })).toBe(true)
    expect(stateClip.keyframes![1]!.frame).toBe(10)
    expect(applyCommand(s, { type: 'set_keyframe_ease', clip_id: 'a', frame: 10, ease: 'easeInOut' })).toBe(true)
    expect(stateClip.keyframes![1]!.ease).toBe('easeInOut')
    expect(applyCommand(s, { type: 'remove_keyframe', clip_id: 'a', frame: 10 })).toBe(true)
    expect(applyCommand(s, { type: 'remove_keyframe', clip_id: 'a', frame: 0 })).toBe(true)
    expect(stateClip.keyframes).toBeUndefined()
  })
})

import type { Track, MotionClip } from '../../shared/timeline/types'

function motionState(): { state: EditState; clip: MotionClip } {
  const clip: MotionClip = {
    id: 'm1', kind: 'motion', start_frame: 0, in_frame: 0, length: 90,
    x: 0, y: 0, rotation: 0, scale: 1, opacity: 1,
    layer: { id: 'l', kind: 'text', text: 'AB', fontFamily: 'Inter', fontSize: 0.1, color: '#fff', align: 'center' },
  }
  const track: Track = { id: 't1', kind: 'video', name: 'V1', muted: false, locked: false, clips: [clip] }
  const state: EditState = {
    version: 2, canvas: { width: 1280, height: 720, fps: 30, bg_color: '#000' },
    tracks: [track], transitions: [], total_frames: 90,
  }
  return { state, clip: state.tracks[0]!.clips[0] as MotionClip }
}

describe('axis keyframe commands', () => {
  it('add_axis_keyframe creates the array and inserts sorted', () => {
    const { state } = motionState()
    expect(applyCommand(state, { type: 'add_axis_keyframe', clip_id: 'm1', t: 1, axes: { wght: 900 } })).toBe(true)
    expect(applyCommand(state, { type: 'add_axis_keyframe', clip_id: 'm1', t: 0, axes: { wght: 100 } })).toBe(true)
    const kfs = (state.tracks[0]!.clips[0] as MotionClip).layer.axisKeyframes!
    expect(kfs.map(k => k.t)).toEqual([0, 1])
    expect(kfs[0]!.axes).toEqual({ wght: 100 })
  })
  it('add_axis_keyframe at an existing t merges axes', () => {
    const { state } = motionState()
    applyCommand(state, { type: 'add_axis_keyframe', clip_id: 'm1', t: 0, axes: { wght: 100 } })
    applyCommand(state, { type: 'add_axis_keyframe', clip_id: 'm1', t: 0, axes: { wdth: 75 } })
    const kfs = (state.tracks[0]!.clips[0] as MotionClip).layer.axisKeyframes!
    expect(kfs).toHaveLength(1)
    expect(kfs[0]!.axes).toEqual({ wght: 100, wdth: 75 })
  })
  it('set_axis_keyframe_axes patches an existing keyframe', () => {
    const { state } = motionState()
    applyCommand(state, { type: 'add_axis_keyframe', clip_id: 'm1', t: 0.5, axes: { wght: 400 } })
    expect(applyCommand(state, { type: 'set_axis_keyframe_axes', clip_id: 'm1', t: 0.5, axes: { wght: 700 } })).toBe(true)
    expect((state.tracks[0]!.clips[0] as MotionClip).layer.axisKeyframes![0]!.axes.wght).toBe(700)
  })
  it('set_axis_keyframe_ease sets ease', () => {
    const { state } = motionState()
    applyCommand(state, { type: 'add_axis_keyframe', clip_id: 'm1', t: 0, axes: { wght: 100 } })
    expect(applyCommand(state, { type: 'set_axis_keyframe_ease', clip_id: 'm1', t: 0, ease: 'power2.out' })).toBe(true)
    expect((state.tracks[0]!.clips[0] as MotionClip).layer.axisKeyframes![0]!.ease).toBe('power2.out')
  })
  it('move_axis_keyframe re-times and re-sorts', () => {
    const { state } = motionState()
    applyCommand(state, { type: 'add_axis_keyframe', clip_id: 'm1', t: 0, axes: { wght: 100 } })
    applyCommand(state, { type: 'add_axis_keyframe', clip_id: 'm1', t: 1, axes: { wght: 900 } })
    expect(applyCommand(state, { type: 'move_axis_keyframe', clip_id: 'm1', from_t: 0, to_t: 0.5 })).toBe(true)
    const kfs = (state.tracks[0]!.clips[0] as MotionClip).layer.axisKeyframes!
    expect(kfs.map(k => k.t)).toEqual([0.5, 1])
  })
  it('remove_axis_keyframe deletes; empties to undefined', () => {
    const { state } = motionState()
    applyCommand(state, { type: 'add_axis_keyframe', clip_id: 'm1', t: 0, axes: { wght: 100 } })
    expect(applyCommand(state, { type: 'remove_axis_keyframe', clip_id: 'm1', t: 0 })).toBe(true)
    expect((state.tracks[0]!.clips[0] as MotionClip).layer.axisKeyframes).toBeUndefined()
  })
  it('no-ops (false) on a non-motion clip', () => {
    const { state } = motionState()
    state.tracks[0]!.clips[0]!.kind = 'video' as any
    expect(applyCommand(state, { type: 'add_axis_keyframe', clip_id: 'm1', t: 0, axes: { wght: 1 } })).toBe(false)
  })
})
