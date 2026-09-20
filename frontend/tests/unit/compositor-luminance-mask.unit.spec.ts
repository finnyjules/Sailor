import { describe, it, expect } from 'vitest'
import { luminanceMaskAlpha } from '~/lib/compositor/luminanceMask'

/**
 * F6 Task 3 — the pure CPU twin of the `backdrop_luminance_mask` effect: maps a backdrop
 * luminance (0..1) to the alpha the layer's OWN content keeps. Reveals where the backdrop is
 * bright (lum ≥ threshold) by default; `invert` reveals where dark. `softness` is the full
 * width of the smoothstep transition band centred on `threshold`. The surrounding canvas
 * recombine (own-content offscreen × this mask, destination-in, stamp) needs a real 2D
 * context and is covered by the live Playwright gate (compositor-layer-effects.spec.ts).
 */
describe('luminanceMaskAlpha', () => {
  const T = 0.5

  it('reveals (≈1) well above the band, hides (≈0) well below it', () => {
    expect(luminanceMaskAlpha(1, T, 0.2, false)).toBeGreaterThan(0.99)
    expect(luminanceMaskAlpha(0, T, 0.2, false)).toBeLessThan(0.01)
  })

  it('is ≈0.5 exactly at the threshold (softness 0.4)', () => {
    expect(luminanceMaskAlpha(0.5, 0.5, 0.4, false)).toBeCloseTo(0.5, 5)
  })

  it('invert flips each case', () => {
    expect(luminanceMaskAlpha(1, T, 0.2, true)).toBeLessThan(0.01)
    expect(luminanceMaskAlpha(0, T, 0.2, true)).toBeGreaterThan(0.99)
    expect(luminanceMaskAlpha(0.5, 0.5, 0.4, true)).toBeCloseTo(0.5, 5)
  })

  it('softness 0 is a (near-)hard step: just below → 0, just above → 1', () => {
    // hw = max(0, 1e-6)/2, so the transition band is ~1e-6 wide — a hard step for any
    // luminance not sitting within a millionth of the pivot.
    expect(luminanceMaskAlpha(0.49, 0.5, 0, false)).toBe(0)
    expect(luminanceMaskAlpha(0.51, 0.5, 0, false)).toBe(1)
    // inverted hard step
    expect(luminanceMaskAlpha(0.49, 0.5, 0, true)).toBe(1)
    expect(luminanceMaskAlpha(0.51, 0.5, 0, true)).toBe(0)
  })

  it('within the band the value rises monotonically from 0 to 1', () => {
    const lo = luminanceMaskAlpha(0.45, 0.5, 0.4, false) // band [0.3, 0.7]
    const mid = luminanceMaskAlpha(0.5, 0.5, 0.4, false)
    const hi = luminanceMaskAlpha(0.55, 0.5, 0.4, false)
    expect(lo).toBeLessThan(mid)
    expect(mid).toBeLessThan(hi)
    expect(lo).toBeGreaterThan(0)
    expect(hi).toBeLessThan(1)
  })

  it('clamps out-of-range inputs (lum, threshold, softness) to [0,1] behaviour', () => {
    // lum beyond 1 behaves like 1; lum below 0 behaves like 0.
    expect(luminanceMaskAlpha(5, 0.5, 0.2, false)).toBeGreaterThan(0.99)
    expect(luminanceMaskAlpha(-5, 0.5, 0.2, false)).toBeLessThan(0.01)
    // threshold clamped: threshold 2 → effectively 1, so any in-range lum reveals nothing.
    expect(luminanceMaskAlpha(0.5, 2, 0.2, false)).toBeLessThan(0.01)
    // threshold -1 → effectively 0, so any in-range lum reveals fully.
    expect(luminanceMaskAlpha(0.5, -1, 0.2, false)).toBeGreaterThan(0.99)
    // softness beyond 1 clamps to 1 (widest band) and never throws or exceeds [0,1].
    const a = luminanceMaskAlpha(0.5, 0.5, 5, false)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThanOrEqual(1)
  })

  it('always returns a finite value in [0,1]', () => {
    for (const lum of [0, 0.25, 0.5, 0.75, 1]) {
      for (const s of [0, 0.1, 0.5, 1]) {
        for (const inv of [false, true]) {
          const a = luminanceMaskAlpha(lum, 0.5, s, inv)
          expect(Number.isFinite(a)).toBe(true)
          expect(a).toBeGreaterThanOrEqual(0)
          expect(a).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})
