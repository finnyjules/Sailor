import { describe, it, expect } from 'vitest'
import { trackHasRoom, resolvePlacement, relocateClips, settleOverlaps } from '../../shared/timeline/placement'
import { createDefaultEditState } from '../../shared/timeline/types'
import type { EditState, Track, Clip } from '../../shared/timeline/types'

const img = (id: string, start: number, length: number): Clip =>
  ({ id, kind: 'image', asset_id: 'x', start_frame: start, in_frame: 0, length })
const track = (id: string, kind: Track['kind'], clips: Clip[], locked = false): Track =>
  ({ id, kind, name: id, muted: false, locked, clips })
function state(tracks: Track[]): EditState {
  const s = createDefaultEditState()
  s.tracks = tracks
  return s
}

describe('trackHasRoom', () => {
  const t = track('v1', 'video', [img('a', 0, 50), img('b', 100, 50)])
  it('touching edges is fine, overlapping is not', () => {
    expect(trackHasRoom(t, [{ start: 50, end: 100 }], new Set())).toBe(true)
    expect(trackHasRoom(t, [{ start: 49, end: 100 }], new Set())).toBe(false)
  })
  it('ignored clips do not block', () => {
    expect(trackHasRoom(t, [{ start: 0, end: 50 }], new Set(['a']))).toBe(true)
  })
})

describe('resolvePlacement', () => {
  it('stays put when there is room', () => {
    const s = state([track('v1', 'video', [img('a', 0, 50)])])
    expect(resolvePlacement(s, 'v1', [{ start: 60, end: 80 }], new Set())).toEqual({ type: 'track', trackId: 'v1' })
  })

  it('takes the nearest free track of the same kind, skipping locked and other kinds', () => {
    const s = state([
      track('v1', 'video', [img('a', 0, 50)]),
      track('a1', 'audio', []),
      track('v2', 'video', [], true),
      track('v3', 'video', []),
    ])
    expect(resolvePlacement(s, 'v1', [{ start: 10, end: 20 }], new Set())).toEqual({ type: 'track', trackId: 'v3' })
  })

  it('on a distance tie the LATER track wins (it renders on top)', () => {
    const s = state([track('v0', 'video', []), track('v1', 'video', [img('a', 0, 50)]), track('v2', 'video', [])])
    expect(resolvePlacement(s, 'v1', [{ start: 10, end: 20 }], new Set())).toEqual({ type: 'track', trackId: 'v2' })
  })

  it('asks for a new track when nothing has room', () => {
    const s = state([track('v1', 'video', [img('a', 0, 50)]), track('v2', 'video', [img('b', 0, 50)])])
    expect(resolvePlacement(s, 'v1', [{ start: 10, end: 20 }], new Set())).toEqual({ type: 'new_track', kind: 'video' })
  })
})

describe('relocateClips', () => {
  it('moves clips, names the new track like the add-track button does, and drops their transitions', () => {
    const s = state([track('v1', 'video', [img('a', 0, 50), img('m', 10, 20)])])
    s.transitions = [{ id: 't', track_id: 'v1', from_clip_id: 'a', to_clip_id: 'm', kind: 'crossfade', duration: 10 }]
    expect(relocateClips(s, new Set(['m']), { type: 'new_track', kind: 'video' }, 'NEW')).toBe(true)
    expect(s.tracks.map(t => t.id)).toEqual(['v1', 'NEW'])
    expect(s.tracks[1]!.name).toBe('Video 2')
    expect(s.tracks[1]!.clips.map(c => c.id)).toEqual(['m'])
    expect(s.tracks[0]!.clips.map(c => c.id)).toEqual(['a'])
    expect(s.transitions).toEqual([])
  })

  it('does nothing when the clips already sit on the target track', () => {
    const s = state([track('v1', 'video', [img('m', 10, 20)])])
    expect(relocateClips(s, new Set(['m']), { type: 'track', trackId: 'v1' }, 'NEW')).toBe(false)
  })

  it('a transition whose two clips move together goes with them', () => {
    const s = state([track('v1', 'video', [img('a', 0, 50), img('m1', 10, 20), img('m2', 30, 20)]), track('v2', 'video', [])])
    s.transitions = [{ id: 't', track_id: 'v1', from_clip_id: 'm1', to_clip_id: 'm2', kind: 'crossfade', duration: 6 }]
    expect(relocateClips(s, new Set(['m1', 'm2']), { type: 'track', trackId: 'v2' }, 'NEW')).toBe(true)
    expect(s.transitions).toEqual([{ id: 't', track_id: 'v2', from_clip_id: 'm1', to_clip_id: 'm2', kind: 'crossfade', duration: 6 }])
  })
})

describe('settleOverlaps', () => {
  it('moves only the clips that actually collide, grouped per track', () => {
    const s = state([
      track('v1', 'video', [img('a', 0, 50), img('m1', 40, 20), img('m2', 200, 20)]),
      track('v2', 'video', []),
    ])
    let n = 0
    expect(settleOverlaps(s, new Set(['m1', 'm2']), () => `new${n++}`)).toBe(true)
    // m1 and m2 moved together as one group from v1 (keeps the selection on one row).
    expect(s.tracks[1]!.clips.map(c => c.id).sort()).toEqual(['m1', 'm2'])
    expect(s.tracks[0]!.clips.map(c => c.id)).toEqual(['a'])
  })

  it('two groups hopping from two tracks never land on top of each other', () => {
    // A selection spanning two lanes is dropped on occupied space in both.
    const s = state([
      track('v1', 'video', [img('a', 0, 100), img('m1', 50, 20)]),
      track('v2', 'video', [img('b', 0, 100), img('m2', 50, 20)]),
    ])
    let n = 0
    expect(settleOverlaps(s, new Set(['m1', 'm2']), () => `new${n++}`)).toBe(true)
    const home = (id: string) => s.tracks.find(t => t.clips.some(c => c.id === id))!.id
    expect(home('m1')).not.toBe(home('m2'))
    expect(s.tracks.map(t => t.id)).toEqual(['v1', 'v2', 'new0', 'new1'])
    expect(s.tracks.map(t => t.name)).toEqual(['v1', 'v2', 'Video 3', 'Video 4'])
  })

  it('leaves a clean drop alone', () => {
    const s = state([track('v1', 'video', [img('a', 0, 50), img('m', 60, 20)])])
    expect(settleOverlaps(s, new Set(['m']), () => 'x')).toBe(false)
  })

  it('never touches a locked track', () => {
    const s = state([track('v1', 'video', [img('a', 0, 50), img('m', 40, 20)], true)])
    expect(settleOverlaps(s, new Set(['m']), () => 'x')).toBe(false)
  })
})
