import { describe, it, expect, beforeEach } from 'vitest'
import { useTimelineStore } from '../../app/composables/useTimelineStore'
import type { ImageClip } from '../../shared/timeline/types'

function img(id: string, start: number, length: number): ImageClip {
  return { id, kind: 'image', asset_id: `asset-${id}`, start_frame: start, in_frame: 0, length }
}

describe('gesture transactions', () => {
  const store = useTimelineStore()

  beforeEach(() => {
    // bind() resets state and both history stacks
    store.bind('test-node', () => undefined, () => {})
  })

  it('coalesces many dispatches into one undo step', () => {
    const trackId = store.state.value.tracks[0]!.id
    store.addClip(trackId, img('a', 0, 30))          // 1 undo step
    store.beginGesture()
    for (let f = 1; f <= 20; f++) store.updateClip('a', { start_frame: f })
    store.endGesture()                                // 1 more undo step
    expect(store.state.value.tracks[0]!.clips[0]!.start_frame).toBe(20)
    store.undo()                                      // undoes the WHOLE drag
    expect(store.state.value.tracks[0]!.clips[0]!.start_frame).toBe(0)
    store.undo()                                      // undoes the add
    expect(store.state.value.tracks[0]!.clips).toHaveLength(0)
    expect(store.canUndo.value).toBe(false)
  })

  it('endGesture with no changes pushes nothing', () => {
    store.beginGesture()
    store.endGesture()
    expect(store.canUndo.value).toBe(false)
  })

  it('a failed dispatch inside a gesture does not corrupt history', () => {
    const trackId = store.state.value.tracks[0]!.id
    store.addClip(trackId, img('a', 0, 30))
    store.beginGesture()
    store.updateClip('ghost', { start_frame: 5 })    // applyCommand returns false
    store.updateClip('a', { start_frame: 5 })
    store.endGesture()
    store.undo()
    expect(store.state.value.tracks[0]!.clips[0]!.start_frame).toBe(0)
  })

  it('gestureBaseState is the snapshot taken at beginGesture, and null outside a gesture', () => {
    expect(store.gestureBaseState()).toBeNull()
    const trackId = store.state.value.tracks[0]!.id
    store.addClip(trackId, img('g1', 0, 30))
    store.beginGesture()
    store.updateClip('g1', { length: 10 })
    const base = store.gestureBaseState()!
    expect(base.tracks[0]!.clips.find(c => c.id === 'g1')!.length).toBe(30)
    // It is a copy: editing it must not touch the live state.
    base.tracks[0]!.clips = []
    expect(store.state.value.tracks[0]!.clips.length).toBeGreaterThan(0)
    store.endGesture()
    expect(store.gestureBaseState()).toBeNull()
  })
})
