import { describe, it, expect } from 'vitest'
import { diffImages, matches, LIVE_MATCH } from '~/lib/embed/frame/compare'

/** `n` opaque pixels of one grey level. */
function grey(n: number, v: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(n * 4)
  for (let p = 0; p < px.length; p += 4) { px[p] = v; px[p + 1] = v; px[p + 2] = v; px[p + 3] = 255 }
  return px
}

describe('diffImages', () => {
  it('identical pictures differ by nothing', () => {
    const a = grey(100, 120)
    expect(diffImages(a, new Uint8ClampedArray(a))).toEqual({ mean: 0, shareOver: 0 })
  })

  it('one pixel in 100 off by 30 in one channel: a share of 0.01 and a mean of 30 over 300 channels', () => {
    const a = grey(100, 120)
    const b = new Uint8ClampedArray(a)
    b[4 * 7] = 150
    const d = diffImages(a, b)
    expect(d.shareOver).toBeCloseTo(0.01, 10)
    expect(d.mean).toBeCloseTo(30 / 300, 10)
  })

  it('a channel off by exactly 24 is not over; 25 is', () => {
    const a = grey(10, 100)
    const b = new Uint8ClampedArray(a); b[1] = 124
    expect(diffImages(a, b).shareOver).toBe(0)
    b[1] = 125
    expect(diffImages(a, b).shareOver).toBeCloseTo(0.1, 10)
  })

  it('alpha counts toward the share over, not toward the mean (the Task 4 harness metric)', () => {
    const a = grey(4, 100)
    const b = new Uint8ClampedArray(a); b[3] = 0
    expect(diffImages(a, b)).toEqual({ mean: 0, shareOver: 0.25 })
  })

  it('pictures of different sizes cannot be compared', () => {
    expect(() => diffImages(grey(4, 0), grey(5, 0))).toThrow(/size/)
  })
})

describe('matches', () => {
  it('uses the thresholds exactly', () => {
    expect(LIVE_MATCH).toEqual({ maxMean: 2, maxShareOver: 0.005 })
    expect(matches({ mean: 0, shareOver: 0 })).toBe(true)
    expect(matches({ mean: 1.999, shareOver: 0.00499 })).toBe(true)
    // Both limits are strict: at the limit is a mismatch, as the Task 4 harness measured.
    expect(matches({ mean: 2, shareOver: 0 })).toBe(false)
    expect(matches({ mean: 0, shareOver: 0.005 })).toBe(false)
    expect(matches({ mean: 0.1, shareOver: 0.01 })).toBe(false)
  })
})
