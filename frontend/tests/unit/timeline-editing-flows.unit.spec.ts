import { describe, it, expect, beforeEach } from 'vitest'
import { useTimelineStore } from '../../app/composables/useTimelineStore'
import { computeGroupResize, neighbourGaps, snapGroupDelta, type ResizeMember } from '../../shared/timeline/groupEdit'
import { settleOverlaps } from '../../shared/timeline/placement'
import { computeRippleEdits, applyRippleEdits } from '../../shared/timeline/ripple'
import { deleteClipsFrom } from '../../shared/timeline/edits'
import type { EditState, ImageClip } from '../../shared/timeline/types'

// The editor's pointer handlers are thin glue over these modules. These specs
// run the SAME sequences the handlers run (TimelineEditor.vue: onPointerMove's
// resize branch, onPointerUp, deleteSelection) against the real store, so the
// parts that only matter together are pinned: one undo step per gesture, ripple
// measured from the gesture's start, and a track hop that undo fully reverses.

function img(id: string, start: number, length: number): ImageClip {
  return { id, kind: 'image', asset_id: `asset-${id}`, start_frame: start, in_frame: 0, length }
}

describe('timeline editing flows', () => {
  const store = useTimelineStore()
  const v1 = () => store.state.value.tracks[0]!
  const layout = () => Object.fromEntries(
    store.state.value.tracks.flatMap(t => t.clips.map(c => [c.id, `${t.name}@${c.start_frame}+${c.length}`])),
  )

  beforeEach(() => {
    store.bind('test-node', () => undefined, () => {})
    // a [0,50)  b [50,100)  c [100,150) on Video 1
    store.mutate(s => { s.tracks[0]!.clips.push(img('a', 0, 50), img('b', 50, 50), img('c', 100, 50)) })
  })

  // What snapshotResizeMembers builds at pointer-down.
  function members(ids: string[], ripple: boolean): ResizeMember[] {
    const set = new Set(ids)
    return v1().clips.filter(c => set.has(c.id)).map(c => ({
      id: c.id, start_frame: c.start_frame, in_frame: c.in_frame ?? 0, length: c.length,
      anchored: false, sourceFrames: null, speed: 1,
      ...(ripple ? { gapBefore: null, gapAfter: null } : neighbourGaps(v1().clips, c.id, set)),
    }))
  }

  // What the resize branch of onPointerMove does on every pointer move.
  function trim(ms: ResizeMember[], edge: 'left' | 'right', delta: number) {
    const { patches } = computeGroupResize(ms, edge, delta)
    store.mutate(s => {
      for (const t of s.tracks) for (const c of t.clips) {
        const p = patches.get(c.id)
        if (p) { c.start_frame = p.start_frame; c.in_frame = p.in_frame; c.length = p.length }
      }
    })
  }

  it('ripple off: growing a clip stops at its neighbour', () => {
    store.beginGesture()
    const ms = members(['a'], false)
    trim(ms, 'right', 30)
    store.endGesture()
    expect(layout()).toEqual({ a: 'Video 1@0+50', b: 'Video 1@50+50', c: 'Video 1@100+50' })
    // Nothing changed, so the gesture added no undo step (only the setup one exists).
    store.undo()
    expect(v1().clips).toHaveLength(0)
  })

  it('ripple on: shortening a clip pulls the later clips in, and ONE undo restores it all', () => {
    store.beginGesture()
    const ms = members(['a'], true)
    for (const d of [-5, -12, -20]) trim(ms, 'right', d)          // several pointer moves
    const base = store.gestureBaseState()!
    store.mutate(s => { applyRippleEdits(s, computeRippleEdits(base, s)) })   // onPointerUp
    store.endGesture()
    expect(layout()).toEqual({ a: 'Video 1@0+30', b: 'Video 1@30+50', c: 'Video 1@80+50' })
    store.undo()
    expect(layout()).toEqual({ a: 'Video 1@0+50', b: 'Video 1@50+50', c: 'Video 1@100+50' })
  })

  it('ripple on: growing a clip past its neighbour pushes the rest out — no overlap left', () => {
    store.beginGesture()
    trim(members(['a'], true), 'right', 30)
    const base = store.gestureBaseState()!
    store.mutate(s => { applyRippleEdits(s, computeRippleEdits(base, s)) })
    store.endGesture()
    expect(layout()).toEqual({ a: 'Video 1@0+80', b: 'Video 1@80+50', c: 'Video 1@130+50' })
  })

  it('ripple on: a group trim of two neighbours sums both changes for the clips after them', () => {
    store.beginGesture()
    trim(members(['a', 'b'], true), 'right', -10)
    const base = store.gestureBaseState()!
    store.mutate(s => { applyRippleEdits(s, computeRippleEdits(base, s)) })
    store.endGesture()
    expect(layout()).toEqual({ a: 'Video 1@0+40', b: 'Video 1@40+40', c: 'Video 1@80+50' })
  })

  it('a clip dropped on another hops to a new track, and ONE undo puts it back and removes the track', () => {
    const videoTracksBefore = store.state.value.tracks.filter(t => t.kind === 'video').length
    store.beginGesture()
    // onPointerMove: snapGroupDelta with nothing to snap to, then apply the delta.
    const { delta } = snapGroupDelta([{ start: 100, end: 150 }], -80, [], 4)
    store.updateClip('c', { start_frame: 100 + delta })                    // c lands on a/b
    store.mutate(s => { settleOverlaps(s, new Set(['c']), () => 'hop-track') })   // onPointerUp
    store.endGesture()
    expect(layout().c).toBe(`Video ${videoTracksBefore + 1}@20+50`)
    expect(store.state.value.tracks.some(t => t.id === 'hop-track')).toBe(true)
    store.undo()
    expect(layout()).toEqual({ a: 'Video 1@0+50', b: 'Video 1@50+50', c: 'Video 1@100+50' })
    expect(store.state.value.tracks.some(t => t.id === 'hop-track')).toBe(false)
  })

  it('a clean drop adds no track', () => {
    const tracksBefore = store.state.value.tracks.length
    store.beginGesture()
    store.updateClip('c', { start_frame: 300 })
    store.mutate(s => { settleOverlaps(s, new Set(['c']), () => 'hop-track') })
    store.endGesture()
    expect(store.state.value.tracks).toHaveLength(tracksBefore)
    expect(layout().c).toBe('Video 1@300+50')
  })

  // deleteClips in the editor: one mutate around the shared deleteClipsFrom.
  function deleteIds(ids: Set<string>, ripple: boolean) {
    store.mutate(s => { deleteClipsFrom(s, ids, ripple) })
  }

  it('delete with ripple closes every gap in one undo step; transitions on deleted clips go too', () => {
    store.mutate(s => {
      s.transitions.push({ id: 't1', track_id: s.tracks[0]!.id, from_clip_id: 'a', to_clip_id: 'b', kind: 'crossfade', duration: 10 })
    })
    deleteIds(new Set(['a', 'b']), true)
    expect(layout()).toEqual({ c: 'Video 1@0+50' })
    expect(store.state.value.transitions).toEqual([])
    store.undo()
    expect(layout()).toEqual({ a: 'Video 1@0+50', b: 'Video 1@50+50', c: 'Video 1@100+50' })
    expect(store.state.value.transitions).toHaveLength(1)
  })

  it('delete without ripple leaves the gap', () => {
    deleteIds(new Set(['b']), false)
    expect(layout()).toEqual({ a: 'Video 1@0+50', c: 'Video 1@100+50' })
  })

  it('duplicating a clip that has a neighbour right after it hops the copy to another track — one undo step', () => {
    const [copyId] = store.duplicateClips(['a'])
    expect(layout()[copyId!]).toMatch(/^Video \d+@50\+50$/)
    expect(layout()[copyId!]).not.toBe('Video 1@50+50')
    expect(layout().b).toBe('Video 1@50+50')                 // the neighbour did not move
    store.undo()
    expect(Object.keys(layout()).sort()).toEqual(['a', 'b', 'c'])
    expect(store.state.value.tracks.every(t => t.clips.every(c => c.id !== copyId))).toBe(true)
  })

  it('duplicating the LAST clip stays on its track (there is room)', () => {
    const [copyId] = store.duplicateClips(['c'])
    expect(layout()[copyId!]).toBe('Video 1@150+50')
  })

  it('pasting onto occupied frames hops the pasted clips; pasting into free space does not', () => {
    store.copyClips(['a'])
    const [onTop] = store.pasteClips(60)
    expect(layout()[onTop!]).not.toMatch(/^Video 1@/)
    const [free] = store.pasteClips(400)
    expect(layout()[free!]).toBe('Video 1@400+50')
  })

  it('adding a clip on top of another hops it, as ONE undo step', () => {
    const before = JSON.stringify(layout())
    store.addClip(v1().id, img('n', 20, 30))
    expect(layout().n).not.toMatch(/^Video 1@/)
    store.undo()
    expect(JSON.stringify(layout())).toBe(before)
    expect(store.state.value.tracks.some(t => t.name !== 'Video 1' && t.kind === 'video' && t.clips.length > 0)).toBe(false)
  })

  it('asOneStep inside an open gesture does not close that gesture', () => {
    store.beginGesture()
    store.asOneStep(() => { store.updateClip('a', { length: 10 }) })
    expect(store.gestureBaseState()).not.toBeNull()
    store.endGesture()
  })
})
