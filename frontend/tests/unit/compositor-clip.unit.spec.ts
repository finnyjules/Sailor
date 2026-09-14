import { describe, expect, it } from 'vitest'
import { CLIP_TAKES_MAX, clipFrameIndex, clipFrameUrl, clipPlayedSeconds, takeIndexOf, withTake, withTakeSpeed, type ImageClip } from '~/lib/compositor/clip'

const clip = (over: Partial<ImageClip> = {}): ImageClip =>
  ({ dir: 'sailor_clips/clip_1', frames: 24, fps: 24, speed: 1, prompt: 'p', model: 'seedance-2.0', ...over })

describe('clipPlayedSeconds', () => {
  it('is frames / fps / speed', () => {
    expect(clipPlayedSeconds(clip())).toBe(1)
    expect(clipPlayedSeconds(clip({ speed: 0.5 }))).toBe(2)
    expect(clipPlayedSeconds(clip({ frames: 48, speed: 4 }))).toBe(0.5)
  })
  it('never divides by zero', () => {
    expect(clipPlayedSeconds(clip({ fps: 0 }))).toBe(0)
    expect(clipPlayedSeconds(clip({ speed: 0 }))).toBe(clipPlayedSeconds(clip({ speed: 1 })))
  })
})

describe('clipFrameIndex', () => {
  it('walks frames at the clip fps and wraps', () => {
    expect(clipFrameIndex(clip(), 0)).toBe(0)
    expect(clipFrameIndex(clip(), 0.5)).toBe(12)
    expect(clipFrameIndex(clip(), 1)).toBe(0)
    expect(clipFrameIndex(clip(), 1.25)).toBe(6)
  })
  it('speed scales the walk', () => {
    expect(clipFrameIndex(clip({ speed: 2 }), 0.25)).toBe(12)
    expect(clipFrameIndex(clip({ speed: 0.5 }), 1)).toBe(12)
  })
  it('picks the nearest frame when the Frame runs at another rate (24 in 30)', () => {
    // 1/30 s into a 24 fps clip is 0.8 frames → frame 1 (nearest), not 0 (floor)
    expect(clipFrameIndex(clip(), 1 / 30)).toBe(1)
    expect(clipFrameIndex(clip(), 2 / 30)).toBe(2)
  })
  it('offsets clones evenly around the loop at phase 1', () => {
    expect(clipFrameIndex(clip(), 0, 0, 4, 1)).toBe(0)
    expect(clipFrameIndex(clip(), 0, 1, 4, 1)).toBe(6)
    expect(clipFrameIndex(clip(), 0, 2, 4, 1)).toBe(12)
    expect(clipFrameIndex(clip(), 0, 3, 4, 1)).toBe(18)
  })
  it('phase 0 plays clones in unison, 0.5 halves the spread', () => {
    expect(clipFrameIndex(clip(), 0, 3, 4, 0)).toBe(0)
    expect(clipFrameIndex(clip(), 0, 2, 4, 0.5)).toBe(6)
  })
  it('is safe with negative time and a single frame', () => {
    expect(clipFrameIndex(clip(), -0.5)).toBe(12)
    expect(clipFrameIndex(clip({ frames: 1 }), 3.7)).toBe(0)
    expect(clipFrameIndex(clip({ frames: 0 }), 3.7)).toBe(0)
  })
})

describe('clipFrameUrl', () => {
  it('is a /view URL into the clip folder with a six-digit name', () => {
    expect(clipFrameUrl(clip(), 7)).toBe('/view?filename=000007.png&subfolder=sailor_clips%2Fclip_1&type=input')
  })
})

describe('takes', () => {
  it('appends each generation, oldest first', () => {
    const a = clip({ dir: 'a' }), b = clip({ dir: 'b' })
    expect(withTake(undefined, a)).toEqual([a])
    expect(withTake([a], b)).toEqual([a, b])
  })
  it('a re-generation of the same folder moves it to the end rather than duplicating it', () => {
    const a = clip({ dir: 'a' }), b = clip({ dir: 'b' })
    expect(withTake([a, b], { ...a, speed: 2 })).toEqual([b, { ...a, speed: 2 }])
  })
  it('caps at CLIP_TAKES_MAX by dropping the oldest reference', () => {
    let takes: ImageClip[] = []
    for (let i = 0; i < CLIP_TAKES_MAX + 3; i++) takes = withTake(takes, clip({ dir: `d${i}` }))
    expect(takes).toHaveLength(CLIP_TAKES_MAX)
    expect(takes[0]!.dir).toBe('d3')
    expect(takes[takes.length - 1]!.dir).toBe(`d${CLIP_TAKES_MAX + 2}`)
  })
  it('finds the active take by folder, -1 when none', () => {
    const a = clip({ dir: 'a' }), b = clip({ dir: 'b' })
    expect(takeIndexOf([a, b], b)).toBe(1)
    expect(takeIndexOf([a, b], clip({ dir: 'zzz' }))).toBe(-1)
    expect(takeIndexOf(undefined, a)).toBe(-1)
    expect(takeIndexOf([a], undefined)).toBe(-1)
  })
  it('remembers a speed change on the matching take only', () => {
    const a = clip({ dir: 'a' }), b = clip({ dir: 'b' })
    expect(withTakeSpeed([a, b], 'b', 2)).toEqual([a, { ...b, speed: 2 }])
    expect(withTakeSpeed(undefined, 'b', 2)).toBeUndefined()
  })
})
