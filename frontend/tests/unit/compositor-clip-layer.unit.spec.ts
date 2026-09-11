import { describe, expect, it } from 'vitest'
import {
  clipClocks, clipFrameFor, createImageLayer, sweepClipCache,
  __setClipFramesForTest, __clipCacheKeysForTest, type ImageLayer,
} from '~/composables/useCompositorLayers'
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

/**
 * The frame cache is bounded in two directions. Both matter because one clip is N
 * full-size decoded bitmaps — a 10 s 24 fps clip at 1024px is ~240 frames, hundreds of
 * MB — so "keep everything forever" is a leak measured in gigabytes per session.
 *
 * `sweepClipCache` is exercised directly rather than through `ensureLayerImages`: that
 * function bails out immediately with no `window`, and this is a node-env file. The
 * sweep runs BEFORE that bail in the real function, so the two agree.
 */
describe('clip cache bounds', () => {
  const clipLayer = (dir: string): ImageLayer => ({
    ...still(),
    clip: { dir, frames: 24, fps: 24, speed: 1, prompt: 'p', model: 'seedance-2.0' },
  })
  const seed = (dir: string) => __setClipFramesForTest(clipLayer(dir).clip!, [{ i: 0 }])

  it('drops every clip the layer list no longer references', () => {
    sweepClipCache([])
    seed('sailor_clips/a')
    seed('sailor_clips/b')
    expect(__clipCacheKeysForTest()).toEqual(['sailor_clips/a:24', 'sailor_clips/b:24'])
    sweepClipCache([clipLayer('sailor_clips/a')])
    expect(__clipCacheKeysForTest()).toEqual(['sailor_clips/a:24'])
  })

  it('a still-only layer list clears the cache entirely', () => {
    sweepClipCache([])
    seed('sailor_clips/a')
    sweepClipCache([still()])
    expect(__clipCacheKeysForTest()).toEqual([])
  })

  it('keeps only the two newest clips', () => {
    sweepClipCache([])
    seed('sailor_clips/a')
    seed('sailor_clips/b')
    seed('sailor_clips/c')
    expect(__clipCacheKeysForTest()).toEqual(['sailor_clips/b:24', 'sailor_clips/c:24'])
  })
})
