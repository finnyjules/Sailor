import { describe, it, expect } from 'vitest'
import { blurPasses, pixelateCellPx, stageSamples, rampValueAt, pixelateBand, rampDirection, rampSupport } from '~/lib/scene3d/treatmentStage'

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

describe('pixelateCellPx', () => {
  it('scales cell size with image height, holding the look constant', () => {
    expect(pixelateCellPx(12, 1000)).toBe(12)
    expect(pixelateCellPx(12, 2048)).toBeCloseTo(24.58, 1)
    expect(pixelateCellPx(0.1, 100)).toBe(1)
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

describe('rampValueAt', () => {
  it('is 0 before the start and 1 after the end', () => {
    expect(rampValueAt(0, 0.2, 0.8)).toBe(0)
    expect(rampValueAt(0.2, 0.2, 0.8)).toBe(0)
    expect(rampValueAt(0.8, 0.2, 0.8)).toBe(1)
    expect(rampValueAt(1, 0.2, 0.8)).toBe(1)
  })

  it('interpolates linearly between them', () => {
    expect(rampValueAt(0.5, 0, 1)).toBeCloseTo(0.5, 6)
    expect(rampValueAt(0.5, 0.2, 0.8)).toBeCloseTo(0.5, 6)
    expect(rampValueAt(0.35, 0.2, 0.8)).toBeCloseTo(0.25, 6)
  })

  it('is a hard edge when the end is at or below the start', () => {
    expect(rampValueAt(0.49, 0.5, 0.5)).toBe(0)
    expect(rampValueAt(0.5, 0.5, 0.5)).toBe(1)
    expect(rampValueAt(0.3, 0.5, 0.1)).toBe(0)
    expect(rampValueAt(0.7, 0.5, 0.1)).toBe(1)
  })
})

describe('rampDirection', () => {
  it('0 degrees runs left to right', () => {
    const d = rampDirection(0)
    expect(d.x).toBeCloseTo(1, 6)
    expect(d.y).toBeCloseTo(0, 6)
  })

  it('90 degrees runs top to bottom, so its y is negative', () => {
    // Texture v = 1 is the visual TOP, so "downwards" is -y.
    const d = rampDirection(90)
    expect(d.x).toBeCloseTo(0, 6)
    expect(d.y).toBeCloseTo(-1, 6)
  })

  it('270 degrees runs bottom to top', () => {
    const d = rampDirection(270)
    expect(d.y).toBeCloseTo(1, 6)
  })
})

describe('rampSupport', () => {
  it('is the width along 0 degrees and the height along 90', () => {
    expect(rampSupport(4, 2, 0)).toBeCloseTo(4, 6)
    expect(rampSupport(4, 2, 90)).toBeCloseTo(2, 6)
  })

  it('spans corner to corner on the diagonal', () => {
    expect(rampSupport(1, 1, 45)).toBeCloseTo(Math.SQRT2, 6)
  })

  it('is never negative, whatever the angle', () => {
    for (const a of [0, 45, 90, 135, 180, 225, 270, 315]) {
      expect(rampSupport(3, 2, a)).toBeGreaterThan(0)
    }
  })
})

describe('pixelateBand', () => {
  it('band 0 at the sharp end, so the region is untouched', () => {
    expect(pixelateBand(0, 5)).toBe(0)
    expect(pixelateBand(0.19, 5)).toBe(0)
  })

  it('reaches the top band at the far end', () => {
    expect(pixelateBand(1, 5)).toBe(1)
    expect(pixelateBand(0.999, 5)).toBe(1)
  })

  it('produces exactly `bands` distinct values across the range', () => {
    const seen = new Set<number>()
    for (let i = 0; i <= 100; i++) seen.add(pixelateBand(i / 100, 5))
    expect(seen.size).toBe(5)
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('never decreases as the ramp rises', () => {
    let prev = -1
    for (let i = 0; i <= 200; i++) {
      const v = pixelateBand(i / 200, 5)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})
