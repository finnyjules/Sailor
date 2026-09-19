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

describe('applyEase — cubic-bézier [x1,y1,x2,y2]', () => {
  it('hits endpoints and clamps like the named eases', () => {
    const e: [number, number, number, number] = [0.42, 0, 0.58, 1]
    expect(applyEase(0, e)).toBe(0)
    expect(applyEase(1, e)).toBe(1)
    expect(applyEase(-1, e)).toBe(0)
    expect(applyEase(2, e)).toBe(1)
  })
  it('the linear bézier is the identity', () => {
    for (const p of [0.1, 0.25, 0.5, 0.9]) expect(applyEase(p, [0, 0, 1, 1])).toBeCloseTo(p, 5)
  })
  it('the exact quadratic béziers reproduce easeIn / easeOut', () => {
    for (const p of [0.1, 0.3, 0.5, 0.8]) {
      expect(applyEase(p, [1 / 3, 0, 2 / 3, 1 / 3])).toBeCloseTo(applyEase(p, 'easeIn'), 5)
      expect(applyEase(p, [1 / 3, 2 / 3, 2 / 3, 1])).toBeCloseTo(applyEase(p, 'easeOut'), 5)
    }
  })
  it('matches CSS ease-in-out at known samples and is symmetric', () => {
    const e: [number, number, number, number] = [0.42, 0, 0.58, 1]
    expect(applyEase(0.5, e)).toBeCloseTo(0.5, 5)
    expect(applyEase(0.25, e)).toBeCloseTo(0.1291, 3)
    expect(applyEase(0.25, e) + applyEase(0.75, e)).toBeCloseTo(1, 5)
  })
  it('lets y overshoot past 1 (back-out) while x stays solvable', () => {
    const back: [number, number, number, number] = [0.34, 1.56, 0.64, 1]
    const peak = Math.max(...[0.3, 0.4, 0.5, 0.6, 0.7].map((p) => applyEase(p, back)))
    expect(peak).toBeGreaterThan(1)
    expect(applyEase(1, back)).toBe(1)
  })
  it('tolerates junk: x clamped to 0..1, non-finite parts fall back to linear', () => {
    expect(applyEase(0.5, [-3, 0, 9, 1])).toBeGreaterThanOrEqual(0)
    expect(applyEase(0.5, [NaN, 0, 1, 1] as never)).toBeCloseTo(0.5, 5)
  })
})

describe('easeToBezier / bezierLabel', () => {
  it('maps named eases to handles (exact for linear / in / out)', async () => {
    const { easeToBezier } = await import('~/lib/motionx/ease')
    expect(easeToBezier('linear')).toEqual([0, 0, 1, 1])
    expect(easeToBezier([0.1, 0.2, 0.3, 0.4])).toEqual([0.1, 0.2, 0.3, 0.4])
    for (const n of ['easeIn', 'easeOut', 'easeInOut'] as const) {
      const b = easeToBezier(n)
      for (const p of [0.2, 0.5, 0.8]) expect(applyEase(p, b)).toBeCloseTo(applyEase(p, n), 1)
    }
  })
  it('easeEquals compares names and handle tuples by value', async () => {
    const { easeEquals } = await import('~/lib/motionx/ease')
    expect(easeEquals('easeIn', 'easeIn')).toBe(true)
    expect(easeEquals([0, 0, 1, 1], [0, 0, 1, 1])).toBe(true)
    expect(easeEquals('linear', [0, 0, 1, 1])).toBe(false)
  })
})
