import { describe, it, expect } from 'vitest'
import { blurPasses, stageSamples } from '~/lib/scene3d/treatmentStage'

describe('blurPasses', () => {
  it('scales the radius with amount and image height', () => {
    expect(blurPasses(0, 1000).radiusPx).toBe(0)
    expect(blurPasses(0.5, 1000).radiusPx).toBeCloseTo(30)
    expect(blurPasses(1, 500).radiusPx).toBeCloseTo(30)
  })
  it('splits a large radius into up to four separable pass pairs so taps never leave gaps', () => {
    const small = blurPasses(0.1, 1000) // 6px
    expect(small.passes).toBe(1)
    expect(small.step * 12).toBeCloseTo(6)
    const big = blurPasses(1, 1000) // 60px
    expect(big.passes).toBeGreaterThan(1)
    expect(big.passes).toBeLessThanOrEqual(4)
    expect(big.step * 12 * big.passes).toBeCloseTo(60)
    expect(big.step).toBeLessThanOrEqual(1.5)
  })
  it('a zero amount asks for zero passes', () => {
    expect(blurPasses(0, 1000).passes).toBe(0)
  })
})

describe('stageSamples', () => {
  it('keeps MSAA at viewport and 2048 sizes but drops it above the pixel ceiling', () => {
    expect(stageSamples(1920, 1080, 8)).toBe(4)
    expect(stageSamples(2048, 2048, 8)).toBe(4)
    expect(stageSamples(4096, 4096, 8)).toBe(0)
  })
  it('never asks for more samples than the device supports', () => {
    expect(stageSamples(1920, 1080, 2)).toBe(2)
  })
})
