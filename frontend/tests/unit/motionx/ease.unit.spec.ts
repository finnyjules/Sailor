import { describe, it, expect } from 'vitest'
import { applyEase } from '~/lib/motionx/ease'

describe('applyEase', () => {
  it('clamps and hits endpoints', () => {
    for (const e of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      expect(applyEase(-1, e)).toBe(0)
      expect(applyEase(2, e)).toBe(1)
      expect(applyEase(0, e)).toBe(0)
      expect(applyEase(1, e)).toBe(1)
    }
  })
  it('is monotonic and matches known midpoints', () => {
    expect(applyEase(0.5, 'linear')).toBeCloseTo(0.5, 6)
    expect(applyEase(0.5, 'easeIn')).toBeCloseTo(0.25, 6)
    expect(applyEase(0.5, 'easeOut')).toBeCloseTo(0.75, 6)
    expect(applyEase(0.5, 'easeInOut')).toBeCloseTo(0.5, 6)
  })
})
