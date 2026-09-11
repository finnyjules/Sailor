import { describe, expect, it } from 'vitest'
import { clipClocks, clipFrameFor, createImageLayer, __setClipFramesForTest, type ImageLayer } from '~/composables/useCompositorLayers'
import { DEFAULT_CLONER } from '~/composables/useCloner'

const still = (): ImageLayer => createImageLayer('rose.png', 1)
const living = (): ImageLayer => ({
  ...still(),
  clip: { dir: 'sailor_clips/clip_x', frames: 24, fps: 24, speed: 1, prompt: 'p', model: 'seedance-2.0' },
})

describe('clipClocks', () => {
  it('is empty when no image layer carries a clip', () => {
    expect(clipClocks([still()])).toEqual([])
  })
  it('reports one clock per clip, using the PLAYED length', () => {
    const l = living(); l.clip!.speed = 0.5
    expect(clipClocks([still(), l])).toEqual([{ duration: 2, fps: 24 }])
  })
  it('ignores a clip with no frames', () => {
    const l = living(); l.clip!.frames = 0
    expect(clipClocks([l])).toEqual([])
  })
})

describe('clipFrameFor', () => {
  it('is null for a layer without a clip (the still path is untouched)', () => {
    expect(clipFrameFor(still(), 0.5, 0, 1)).toBeNull()
  })
  it('is null for a clip whose frames are not loaded yet (the still shows meanwhile)', () => {
    expect(clipFrameFor(living(), 0.5, 0, 1)).toBeNull()
  })

  it('with a populated cache, picks the frame the clock lands on', () => {
    const l = living()
    const sentinels = Array.from({ length: 24 }, (_, i) => ({ i }))
    __setClipFramesForTest(l.clip!, sentinels)
    expect(clipFrameFor(l, 0.5, 0, 1)).toBe(sentinels[12])
  })

  it('offsets each clone of a phased cloner to a different frame', () => {
    const l = living()
    l.cloner = { ...DEFAULT_CLONER, enabled: true, phase: 1 }
    const sentinels = Array.from({ length: 24 }, (_, i) => ({ i }))
    __setClipFramesForTest(l.clip!, sentinels)
    expect(clipFrameFor(l, 0, 1, 4)).toBe(sentinels[6])
    expect(clipFrameFor(l, 0, 3, 4)).toBe(sentinels[18])
  })

  it('phase 0 plays every clone together — no offset', () => {
    const l = living()
    l.cloner = { ...DEFAULT_CLONER, enabled: true, phase: 0 }
    const sentinels = Array.from({ length: 24 }, (_, i) => ({ i }))
    __setClipFramesForTest(l.clip!, sentinels)
    expect(clipFrameFor(l, 0, 3, 4)).toBe(sentinels[0])
  })

  it('is null when the layer\'s frame count does not match the cached array (key miss)', () => {
    const l = living()
    l.clip!.frames = 48
    const sentinels = Array.from({ length: 24 }, (_, i) => ({ i }))
    // Seed under the OLD (24-frame) clip shape, then read back with a layer whose
    // clip.frames is 48 — clipKey includes frames, so this must miss the cache.
    __setClipFramesForTest({ ...l.clip!, frames: 24 }, sentinels)
    expect(clipFrameFor(l, 0.5, 0, 1)).toBeNull()
  })
})
