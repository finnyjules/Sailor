import { describe, it, expect } from 'vitest'
import { computeRippleEdits, applyRippleEdits } from '../../shared/timeline/ripple'
import { createDefaultEditState } from '../../shared/timeline/types'
import type { EditState, Track, Clip } from '../../shared/timeline/types'

const img = (id: string, start: number, length: number): Clip =>
  ({ id, kind: 'image', asset_id: 'x', start_frame: start, in_frame: 0, length })
function state(tracks: Track[]): EditState {
  const s = createDefaultEditState()
  s.tracks = tracks
  return s
}
const v1 = (clips: Clip[], locked = false): Track => ({ id: 'v1', kind: 'video', name: 'Video 1', muted: false, locked, clips })
const clone = (s: EditState): EditState => JSON.parse(JSON.stringify(s))
const starts = (s: EditState) => Object.fromEntries(s.tracks.flatMap(t => t.clips).map(c => [c.id, c.start_frame]))

describe('ripple', () => {
  const before = state([v1([img('a', 0, 50), img('b', 50, 50), img('c', 100, 50)])])

  it('delete closes the gap', () => {
    const after = clone(before)
    after.tracks[0]!.clips = after.tracks[0]!.clips.filter(c => c.id !== 'b')
    const edits = computeRippleEdits(before, after)
    expect(edits).toEqual([{ trackId: 'v1', fromFrame: 100, delta: -50 }])
    expect(applyRippleEdits(after, edits)).toBe(true)
    expect(starts(after)).toEqual({ a: 0, c: 50 })
  })

  it('deleting two clips sums both gaps', () => {
    const after = clone(before)
    after.tracks[0]!.clips = after.tracks[0]!.clips.filter(c => c.id === 'c')
    applyRippleEdits(after, computeRippleEdits(before, after))
    expect(starts(after)).toEqual({ c: 0 })
  })

  it('shortening the right edge pulls later clips in', () => {
    const after = clone(before)
    after.tracks[0]!.clips[0]!.length = 30
    applyRippleEdits(after, computeRippleEdits(before, after))
    expect(starts(after)).toEqual({ a: 0, b: 30, c: 80 })
  })

  it('growing the right edge pushes later clips out', () => {
    const after = clone(before)
    after.tracks[0]!.clips[0]!.length = 70
    applyRippleEdits(after, computeRippleEdits(before, after))
    expect(starts(after)).toEqual({ a: 0, b: 70, c: 120 })
  })

  it('left trim: the clip slides back to its old start and the rest follows', () => {
    const after = clone(before)
    Object.assign(after.tracks[0]!.clips[1]!, { start_frame: 60, in_frame: 10, length: 40 })
    applyRippleEdits(after, computeRippleEdits(before, after))
    expect(starts(after)).toEqual({ a: 0, b: 50, c: 90 })
    expect(after.tracks[0]!.clips[1]!.length).toBe(40)
    expect(after.tracks[0]!.clips[1]!.in_frame).toBe(10)
  })

  it('left extend: the clip keeps its old start, later clips are pushed', () => {
    const b2 = state([v1([img('a', 0, 40), img('b', 50, 50), img('c', 100, 50)])])
    const after = clone(b2)
    Object.assign(after.tracks[0]!.clips[1]!, { start_frame: 45, length: 55 })
    applyRippleEdits(after, computeRippleEdits(b2, after))
    expect(starts(after)).toEqual({ a: 0, b: 50, c: 105 })
  })

  it('a plain move produces no edits', () => {
    const after = clone(before)
    after.tracks[0]!.clips[1]!.start_frame = 300
    expect(computeRippleEdits(before, after)).toEqual([])
  })

  it('a clip that changed track produces no edits', () => {
    const b2 = state([v1([img('a', 0, 50), img('b', 50, 50)]), { id: 'v2', kind: 'video', name: 'Video 2', muted: false, locked: false, clips: [] }])
    const after = clone(b2)
    after.tracks[1]!.clips.push(after.tracks[0]!.clips.pop()!)
    expect(computeRippleEdits(b2, after)).toEqual([])
  })

  it('locked tracks never shift, other tracks are untouched', () => {
    const b2 = state([v1([img('a', 0, 50), img('b', 50, 50)], true), { id: 'v2', kind: 'video', name: 'Video 2', muted: false, locked: false, clips: [img('z', 500, 10)] }])
    const after = clone(b2)
    after.tracks[0]!.clips[0]!.length = 10
    expect(applyRippleEdits(after, computeRippleEdits(b2, after))).toBe(false)
    expect(starts(after)).toEqual({ a: 0, b: 50, z: 500 })
  })

  it('never shifts a clip below frame 0 and reports no-change honestly', () => {
    const s = state([v1([img('a', 10, 5)])])
    expect(applyRippleEdits(s, [{ trackId: 'v1', fromFrame: 0, delta: -100 }])).toBe(true)
    expect(starts(s)).toEqual({ a: 0 })
    expect(applyRippleEdits(s, [])).toBe(false)
  })
})
