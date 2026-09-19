import { describe, it, expect } from 'vitest'
import { velocityBlurLenPx } from '~/lib/scene3d/treatmentStage'

// CPU twin for the S6 velocity-blur smear length (Task 2). Pure math, no WebGL: the same
// NDC→device-px mapping the stage's `velocityBlurComposite` uses to size its directional smear,
// and the `lenPx < 1` boundary that makes a still velocity blur a hard no-op (== amount 0).
describe('velocityBlurLenPx', () => {
  const W = 1000, H = 800

  it('maps a per-frame NDC displacement to device px, halving NDC’s [-1,1] span', () => {
    // A pure-x velocity of 0.2 NDC over one frame, shutter 1, amount 1 ⇒ 0.5·(0.2·W) = 100 px.
    expect(velocityBlurLenPx({ x: 0.2, y: 0 }, W, H, 1, 1)).toBeCloseTo(100, 6)
    // A pure-y velocity of 0.1 NDC ⇒ 0.5·(0.1·H) = 40 px.
    expect(velocityBlurLenPx({ x: 0, y: 0.1 }, W, H, 1, 1)).toBeCloseTo(40, 6)
  })

  it('takes the hypotenuse of the two axes', () => {
    // 0.5·hypot(0.06·1000, 0.08·800) = 0.5·hypot(60, 64) = 0.5·√(3600+4096) = 0.5·87.727… ≈ 43.86
    expect(velocityBlurLenPx({ x: 0.06, y: 0.08 }, W, H, 1, 1)).toBeCloseTo(0.5 * Math.hypot(60, 64), 6)
  })

  it('scales linearly with shutter and amount', () => {
    const base = velocityBlurLenPx({ x: 0.2, y: 0 }, W, H, 1, 1) // 100
    expect(velocityBlurLenPx({ x: 0.2, y: 0 }, W, H, 0.5, 1)).toBeCloseTo(base * 0.5, 6)
    expect(velocityBlurLenPx({ x: 0.2, y: 0 }, W, H, 1, 2)).toBeCloseTo(base * 2, 6)
    expect(velocityBlurLenPx({ x: 0.2, y: 0 }, W, H, 0.5, 0.5)).toBeCloseTo(base * 0.25, 6)
  })

  it('is 0 for a null velocity (a still object) — the hard no-op branch', () => {
    expect(velocityBlurLenPx(null, W, H, 0.5, 1)).toBe(0)
    expect(velocityBlurLenPx(null, W, H, 0.5, 1)).toBeLessThan(1)
  })

  it('is 0 at amount 0 regardless of velocity — routes to the same crisp composite as still', () => {
    expect(velocityBlurLenPx({ x: 0.9, y: 0.9 }, W, H, 1, 0)).toBe(0)
  })

  it('falls below the 1px no-op boundary for a sub-pixel smear, and rises above it once real', () => {
    // A tiny velocity: 0.5·(0.001·1000)·0.5·1 = 0.25 px ⇒ < 1 ⇒ no-op (identical to amount 0).
    expect(velocityBlurLenPx({ x: 0.001, y: 0 }, W, H, 0.5, 1)).toBeLessThan(1)
    // Just over: 0.5·(0.01·1000)·0.5·1 = 2.5 px ⇒ ≥ 1 ⇒ a real smear.
    expect(velocityBlurLenPx({ x: 0.01, y: 0 }, W, H, 0.5, 1)).toBeGreaterThanOrEqual(1)
  })
})
