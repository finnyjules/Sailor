/**
 * Task P3 (carried a): the markup never charges a credit for binary float
 * noise, and never undercharges a real fraction of a credit.
 *
 * Before the fix, `Math.ceil(usd × 100 × markup)` read 0.035 × 200 as
 * 7.000000000000001 and charged 8 credits for a 7-credit price.
 */
import { describe, expect, it } from 'vitest'
import { creditsForUsd, usdChargedAtCost } from '#shared/pricing/markup'

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

  it('is exact for every price to 8 decimals (a sweep, plus each side of every whole credit)', () => {
    // Exact integer maths: usd = k / 10^8 dollars. Credits = ceil(k × 200 / 10^8)
    // up to $0.10 (k ≤ 10^7), ceil(k × 150 / 10^8) above, never below 1.
    const want = (k: bigint): number => {
      const [num, den] = k <= 10_000_000n ? [k * 200n, 100_000_000n] : [k * 150n, 100_000_000n]
      const c = (num + den - 1n) / den
      return Number(c < 1n ? 1n : c)
    }
    const ks: bigint[] = []
    for (let k = 1n; k <= 300_000_000n; k += 9973n) ks.push(k)
    // Each side of a whole credit: at 2× a credit is every 500,000 (k × 200 / 10^8 = k / 500,000);
    // at 1.5× every 2,000,000 / 3, whole at k = 2,000,000 × j (3j credits).
    for (let j = 1n; j <= 20n; j++) ks.push(j * 500_000n - 1n, j * 500_000n, j * 500_000n + 1n)
    for (let j = 1n; j <= 150n; j++) ks.push(j * 2_000_000n - 1n, j * 2_000_000n, j * 2_000_000n + 1n)
    ks.push(9_999_999n, 10_000_000n, 10_000_001n, 3_500_000n, 3_500_001n)
    const off: string[] = []
    for (const k of ks) {
      const usd = Number(k) / 1e8
      const got = creditsForUsd(usd)
      if (got !== want(k)) off.push(`$${usd.toFixed(8)}: ${got}, exact ${want(k)}`)
    }
    expect(off.slice(0, 5)).toEqual([])
    expect(ks.length).toBeGreaterThan(30000)
  })
})

/**
 * Task: the fallback-chain pricing rule (editRates.ts editMaxUsd) covers a
 * rarely-taken fallback at cost, never at the house markup — `usdChargedAtCost`
 * is the inverse of `creditsForUsd`'s policy: the provider price whose
 * marked-up credits equal a raw cost charged with no markup at all.
 */
describe('usdChargedAtCost', () => {
  it('creditsForUsd(usdChargedAtCost(c)) recovers ceil(c × 100) — charged at cost, no markup', () => {
    for (const c of [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.50, 1.00]) {
      expect(creditsForUsd(usdChargedAtCost(c)), `cost=${c}`).toBe(Math.ceil(c * 100))
    }
  })

  it('zero for zero or negative input', () => {
    expect(usdChargedAtCost(0)).toBe(0)
    expect(usdChargedAtCost(-1)).toBe(0)
    expect(usdChargedAtCost(-0.05)).toBe(0)
  })
})
