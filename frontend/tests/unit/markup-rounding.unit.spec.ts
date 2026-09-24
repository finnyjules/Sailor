/**
 * Task P3 (carried a): the markup never charges a credit for binary float
 * noise, and never undercharges a real fraction of a credit.
 *
 * Before the fix, `Math.ceil(usd × 100 × markup)` read 0.035 × 200 as
 * 7.000000000000001 and charged 8 credits for a 7-credit price.
 */
import { describe, expect, it } from 'vitest'
import { creditsForUsd } from '#shared/pricing/markup'

describe('creditsForUsd rounding', () => {
  it('exact prices do not round up from float noise', () => {
    // Each product is an exact whole number of credits; binary float adds a tail.
    expect(creditsForUsd(0.035)).toBe(7) // 7.000000000000001 before the fix
    expect(creditsForUsd(0.07)).toBe(14) // 14.000000000000002
    expect(creditsForUsd(0.28)).toBe(42) // 42.00000000000001 (1.5×)
    expect(creditsForUsd(0.014)).toBe(3) // 2.8000000000000003 → 3 either way
    expect(creditsForUsd(0.128)).toBe(20) // 19.200000000000003 → 20 either way
  })

  it('a real fraction of a credit still rounds up (never undercharges)', () => {
    expect(creditsForUsd(0.0350001)).toBe(8) // 7.00002 credits
    expect(creditsForUsd(0.03500001)).toBe(8) // 7.000002 credits
    expect(creditsForUsd(0.0675)).toBe(14) // 13.5
    expect(creditsForUsd(0.047)).toBe(10) // 9.4
    expect(creditsForUsd(0.10001)).toBe(16) // 15.0015 at 1.5×
    expect(creditsForUsd(0.3034 * 5)).toBe(228) // 227.55
  })

  it('the $0.10 boundary reads the price, not its float tail', () => {
    expect(creditsForUsd(0.1)).toBe(20)
    // (0.1 + 0.2) / 3 is 0.10000000000000002 in binary: still a 10-cent price, 2×.
    expect(creditsForUsd((0.1 + 0.2) / 3)).toBe(20)
    expect(creditsForUsd(0.3 - 0.2)).toBe(20) // 0.09999999999999998
    expect(creditsForUsd(0.1000001)).toBe(16) // a real step over the line: 1.5×
  })

  it('keeps the floor and the zero cases', () => {
    expect(creditsForUsd(0.0001)).toBe(1)
    expect(creditsForUsd(0.003)).toBe(1)
    expect(creditsForUsd(0)).toBe(0)
    expect(creditsForUsd(-1)).toBe(0)
    expect(creditsForUsd(Number.NaN)).toBe(0)
  })

  it('never undercharges across a sweep of cent and sub-cent prices', () => {
    // For every price with up to 5 decimals, credits × $0.01 ≥ usd × markup
    // (to within float noise far below a credit).
    for (let micro = 10; micro <= 200000; micro += 7) {
      const usd = micro / 100000
      const markup = usd <= 0.1 ? 2 : 1.5
      const c = creditsForUsd(usd)
      expect(c + 1e-6, `usd=${usd}`).toBeGreaterThanOrEqual(usd * 100 * markup)
      // …and never a whole credit more than the price.
      expect(c - 1, `usd=${usd}`).toBeLessThan(Math.max(1, usd * 100 * markup))
    }
  })
})
