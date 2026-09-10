import { describe, expect, it } from 'vitest'
import { clipClocks, clipFrameFor, createImageLayer, type ImageLayer } from '~/composables/useCompositorLayers'

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
})
