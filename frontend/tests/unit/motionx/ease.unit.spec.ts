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

describe('applyEase — spring { type: "spring", bounce }', () => {
  const s = (bounce: number) => ({ type: 'spring' as const, bounce })
  it('starts at 0, is near the target at the end of the bar, and settles to exactly 1', () => {
    expect(applyEase(0, s(0.2))).toBe(0)
    expect(applyEase(-1, s(0.2))).toBe(0)
    expect(Math.abs(applyEase(1, s(0.2)) - 1)).toBeLessThan(0.12)
    expect(applyEase(6, s(0.2))).toBe(1)
  })
  it('bounce 0 never overshoots; a bouncy spring does, past the end of the bar', () => {
    const ps = Array.from({ length: 60 }, (_, i) => i / 20)
    expect(Math.max(...ps.map((p) => applyEase(p, s(0))))).toBeLessThanOrEqual(1)
    expect(Math.max(...ps.map((p) => applyEase(p, s(0.6))))).toBeGreaterThan(1.05)
  })
  it('matches DialKit/Motion: visualDuration+bounce → closed-form oscillator', () => {
    // bounce .2, t = 0.5·visualDuration: w0 = 2π/1.2, ζ = .8
    const w0 = (2 * Math.PI) / 1.2, z = 0.8, wd = w0 * Math.sqrt(1 - z * z), t = 0.5
    const want = 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t))
    expect(applyEase(0.5, s(0.2))).toBeCloseTo(want, 9)
  })
  it('easeEquals + isSpringEase', async () => {
    const { easeEquals, isSpringEase } = await import('~/lib/motionx/ease')
    expect(easeEquals(s(0.2), s(0.2))).toBe(true)
    expect(easeEquals(s(0.2), s(0.3))).toBe(false)
    expect(easeEquals(s(0.2), 'linear')).toBe(false)
    expect(isSpringEase(s(0.1))).toBe(true)
    expect(isSpringEase([0, 0, 1, 1])).toBe(false)
  })
})

describe('applyEase — steps { type: "steps", count }', () => {
  const s = (count: number) => ({ type: 'steps' as const, count })

  it('n = 4: exact values at the named sample points', () => {
    const e = s(4)
    expect(applyEase(0, e)).toBe(0)
    expect(applyEase(0.1, e)).toBeCloseTo(0, 10)
    expect(applyEase(0.25, e)).toBeCloseTo(0.25, 10)
    expect(applyEase(0.26, e)).toBeCloseTo(0.25, 10)
    expect(applyEase(0.5, e)).toBeCloseTo(0.5, 10)
    expect(applyEase(0.99, e)).toBeCloseTo(0.75, 10)
    expect(applyEase(1, e)).toBe(1)
  })

  it('exactly n jumps over a fine sweep, for n = 1, 6, 24', () => {
    for (const n of [1, 6, 24]) {
      const e = s(n)
      const N = 20000
      let jumps = 0
      let prev = applyEase(0, e)
      for (let i = 1; i <= N; i++) {
        const v = applyEase(i / N, e)
        if (Math.abs(v - prev) > 1e-9) jumps++
        prev = v
      }
      expect(jumps, `n=${n}`).toBe(n)
    }
  })

  it('is monotonic (never decreases) and stays within [0, 1] — no overshoot, so no spring tail', () => {
    const e = s(6)
    let prev = -Infinity
    for (let i = -50; i <= 250; i++) {
      const v = applyEase(i / 100, e)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      if (i >= 0 && i <= 100) { expect(v).toBeGreaterThanOrEqual(prev); prev = v }
    }
  })

  it('clamps a bad count: 0/-3 -> 1, 2.6 -> 3 (rounded), 999 -> 64, NaN -> 6', () => {
    expect(applyEase(0.5, s(0))).toBeCloseTo(applyEase(0.5, s(1)), 10)
    expect(applyEase(0.5, s(-3))).toBeCloseTo(applyEase(0.5, s(1)), 10)
    expect(applyEase(0.5, s(2.6))).toBeCloseTo(applyEase(0.5, s(3)), 10)
    expect(applyEase(0.999, s(999))).toBeCloseTo(applyEase(0.999, s(64)), 10)
    expect(applyEase(0.3, s(NaN))).toBeCloseTo(applyEase(0.3, s(6)), 10)
  })

  it('isStepsEase', async () => {
    const { isStepsEase } = await import('~/lib/motionx/ease')
    expect(isStepsEase(s(6))).toBe(true)
    expect(isStepsEase({ type: 'spring', bounce: 0.2 })).toBe(false)
    expect(isStepsEase('linear')).toBe(false)
    expect(isStepsEase([0, 0, 1, 1])).toBe(false)
  })

  it('easeEquals compares by normalised n', async () => {
    const { easeEquals } = await import('~/lib/motionx/ease')
    expect(easeEquals(s(6), s(6))).toBe(true)
    expect(easeEquals(s(6), s(6.4))).toBe(true)     // both round to 6
    expect(easeEquals(s(6), s(7))).toBe(false)
    expect(easeEquals(s(6), 'linear')).toBe(false)
    expect(easeEquals(s(6), [0, 0, 1, 1])).toBe(false)
    expect(easeEquals(s(6), { type: 'spring', bounce: 0.2 } as never)).toBe(false)
  })

  it('easeToBezier(steps) is the linear bézier — only used to seed the curve editor', async () => {
    const { easeToBezier } = await import('~/lib/motionx/ease')
    expect(easeToBezier(s(6))).toEqual([0, 0, 1, 1])
  })
})
