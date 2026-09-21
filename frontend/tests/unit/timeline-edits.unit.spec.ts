import { describe, it, expect } from 'vitest'
import { deleteClipsFrom, restoreLostTransitions } from '../../shared/timeline/edits'
import { createDefaultEditState } from '../../shared/timeline/types'
import type { EditState, Track, Clip, Transition } from '../../shared/timeline/types'

const img = (id: string, start: number, length: number): Clip =>
  ({ id, kind: 'image', asset_id: 'x', start_frame: start, in_frame: 0, length })
const track = (id: string, clips: Clip[], locked = false): Track =>
  ({ id, kind: 'video', name: id, muted: false, locked, clips })
function state(tracks: Track[], transitions: Transition[] = []): EditState {
  const s = createDefaultEditState()
  s.tracks = tracks
  s.transitions = transitions
  return s
}
const xfade = (id: string, trackId: string, from: string, to: string): Transition =>
  ({ id, track_id: trackId, from_clip_id: from, to_clip_id: to, kind: 'crossfade', duration: 10 })
const starts = (s: EditState) => Object.fromEntries(s.tracks.flatMap(t => t.clips).map(c => [c.id, c.start_frame]))

describe('deleteClipsFrom', () => {
  it('removes the clips and the transitions that touched them; no ripple leaves the gap', () => {
    const s = state([track('v1', [img('a', 0, 50), img('b', 50, 50), img('c', 100, 50)])], [xfade('t1', 'v1', 'a', 'b'), xfade('t2', 'v1', 'b', 'c')])
    expect(deleteClipsFrom(s, new Set(['a']), false)).toBe(true)
    expect(starts(s)).toEqual({ b: 50, c: 100 })
    expect(s.transitions.map(t => t.id)).toEqual(['t2'])
  })

  it('with ripple, later clips on that track close every gap', () => {
    const s = state([track('v1', [img('a', 0, 50), img('b', 50, 50), img('c', 100, 50)])])
    expect(deleteClipsFrom(s, new Set(['a', 'b']), true)).toBe(true)
    expect(starts(s)).toEqual({ c: 0 })
  })

  it('never touches a locked track — its clips and their transitions stay', () => {
    const s = state([track('v1', [img('a', 0, 50), img('b', 50, 50)], true), track('v2', [img('z', 0, 10)])], [xfade('t1', 'v1', 'a', 'b')])
    expect(deleteClipsFrom(s, new Set(['a', 'z']), true)).toBe(true)
    expect(starts(s)).toEqual({ a: 0, b: 50 })
    expect(s.transitions).toHaveLength(1)
  })

  it('reports false and changes nothing when nothing of it can be deleted', () => {
    const s = state([track('v1', [img('a', 0, 50)], true)])
    const before = JSON.stringify(s)
    expect(deleteClipsFrom(s, new Set(['a']), true)).toBe(false)
    expect(deleteClipsFrom(s, new Set(['ghost']), true)).toBe(false)
    expect(deleteClipsFrom(s, new Set(), true)).toBe(false)
    expect(JSON.stringify(s)).toBe(before)
  })
})

describe('restoreLostTransitions', () => {
  const base = () => state([track('v1', [img('a', 0, 50), img('b', 50, 50)]), track('v2', [])], [xfade('t1', 'v1', 'a', 'b')])

  it('puts back a transition the clip lost while it was dragged over another track', () => {
    const now = base()
    now.transitions = []                      // dropped when b crossed to v2; b is back on v1
    expect(restoreLostTransitions(now, base(), 'b')).toBe(true)
    expect(now.transitions).toEqual([xfade('t1', 'v1', 'a', 'b')])
  })

  it('does nothing when nothing was lost, and never duplicates', () => {
    const now = base()
    expect(restoreLostTransitions(now, base(), 'b')).toBe(false)
    expect(now.transitions).toHaveLength(1)
  })

  it('does not restore while the clip sits on a different track than the transition', () => {
    const now = base()
    now.transitions = []
    now.tracks[1]!.clips.push(now.tracks[0]!.clips.pop()!)   // b is on v2
    expect(restoreLostTransitions(now, base(), 'b')).toBe(false)
    expect(now.transitions).toEqual([])
  })

  it('ignores transitions that belong to other clips, and a partner that is gone', () => {
    const now = base()
    now.transitions = []
    now.tracks[0]!.clips = now.tracks[0]!.clips.filter(c => c.id !== 'a')   // partner deleted
    expect(restoreLostTransitions(now, base(), 'b')).toBe(false)
    expect(restoreLostTransitions(base(), base(), 'unrelated')).toBe(false)
  })
})
