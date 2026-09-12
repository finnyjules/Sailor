import { describe, it, expect } from 'vitest'
import { blurPasses, pixelateCellPx, stageSamples, rampValueAt, pixelateBand, rampDirection, rampSupport, colorGradeRGB, dissolveNoise, dissolveAlpha, halftoneDotRadius, halftoneCellDistance, HALFTONE_RADIUS_MAX } from '~/lib/scene3d/treatmentStage'

describe('dissolveNoise / dissolveAlpha', () => {
  const grid = (fn: (u: number, v: number) => number, n = 16): number[] => {
    const out: number[] = []
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out.push(fn((i + 0.5) / n, (j + 0.5) / n))
    return out
  }

  it('noise is deterministic and bounded to [0, 1)', () => {
    const a = grid((u, v) => dissolveNoise(u, v, 20, 20, 3))
    const b = grid((u, v) => dissolveNoise(u, v, 20, 20, 3))
    expect(a).toEqual(b) // same seed & lattice → identical field, run to run
    for (const x of a) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1) }
  })
  it('a different seed produces a different field', () => {
    const a = grid((u, v) => dissolveNoise(u, v, 20, 20, 1))
    const b = grid((u, v) => dissolveNoise(u, v, 20, 20, 2))
    expect(a).not.toEqual(b)
  })

  const P = { scale: 24, softness: 0.15, seed: 1, cellsX: 18, cellsY: 18 }
  it('amount 0 keeps the whole object (alpha 1 everywhere)', () => {
    for (const a of grid((u, v) => dissolveAlpha(u, v, { ...P, amount: 0 }))) expect(a).toBe(1)
  })
  it('amount 1 dissolves the object entirely (alpha 0 everywhere)', () => {
    for (const a of grid((u, v) => dissolveAlpha(u, v, { ...P, amount: 1 }))) expect(a).toBe(0)
  })
  it('alpha is also deterministic for a fixed seed', () => {
    const f = (u: number, v: number) => dissolveAlpha(u, v, { ...P, amount: 0.5 })
    expect(grid(f)).toEqual(grid(f))
  })
  it('softness widens the soft transition band (more part-dissolved pixels)', () => {
    const band = (soft: number) =>
      grid((u, v) => dissolveAlpha(u, v, { ...P, amount: 0.5, softness: soft }), 48)
        .filter((a) => a > 0.001 && a < 0.999).length
    expect(band(0)).toBe(0) // softness 0 is a hard tear — every pixel is fully in or fully out
    expect(band(0.3)).toBeGreaterThan(band(0.1))
  })
})

describe('colorGradeRGB', () => {
  const NEUTRAL = { brightness: 1, contrast: 1, saturation: 1, hue: 0 }
  const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 5))

  it('neutral params are the identity', () => {
    close(colorGradeRGB([0.2, 0.6, 0.9], NEUTRAL), [0.2, 0.6, 0.9])
    close(colorGradeRGB([0, 0, 0], NEUTRAL), [0, 0, 0])
  })
  it('saturation 0 collapses to Rec.709 luma (greyscale)', () => {
    const l = 0.2126 * 0.2 + 0.7152 * 0.6 + 0.0722 * 0.9
    close(colorGradeRGB([0.2, 0.6, 0.9], { ...NEUTRAL, saturation: 0 }), [l, l, l])
  })
  it('brightness scales every channel', () => {
    close(colorGradeRGB([0.2, 0.4, 0.5], { ...NEUTRAL, brightness: 1.5 }), [0.3, 0.6, 0.75])
  })
  it('contrast pivots around mid-grey and clamps below zero', () => {
    close(colorGradeRGB([0.5, 0.5, 0.5], { ...NEUTRAL, contrast: 2 }), [0.5, 0.5, 0.5])
    close(colorGradeRGB([0.25, 0.25, 0.25], { ...NEUTRAL, contrast: 2 }), [0, 0, 0]) // (0.25-0.5)*2+0.5 = 0
  })
  it('hue rotation leaves a neutral grey untouched and stays clamped non-negative', () => {
    close(colorGradeRGB([0.4, 0.4, 0.4], { ...NEUTRAL, hue: 120 }), [0.4, 0.4, 0.4])
    const rotated = colorGradeRGB([0.8, 0.1, 0.1], { ...NEUTRAL, hue: 120 })
    rotated.forEach((v) => expect(v).toBeGreaterThanOrEqual(0))
    // a 120° rotation about the grey axis cycles R→G→B, so green should now dominate
    expect(rotated[1]).toBeGreaterThan(rotated[0]!)
    expect(rotated[1]).toBeGreaterThan(rotated[2]!)
  })
})

describe('halftoneDotRadius', () => {
  it('a bright region grows no dot, a dark region fills to the cell corners', () => {
    expect(halftoneDotRadius(1, 1, 1)).toBe(0) // white → nothing
    expect(halftoneDotRadius(0, 1, 1)).toBeCloseTo(HALFTONE_RADIUS_MAX, 6) // black → solid
  })
  it('a transparent region grows no dot, whatever its tone (no spill past the silhouette)', () => {
    expect(halftoneDotRadius(0, 0, 1)).toBe(0)
  })
  it('dot area tracks darkness — radius is √(darkness) of the max', () => {
    // luminance 0.75 → darkness 0.25 → radius = √0.25 = 0.5 of the max
    expect(halftoneDotRadius(0.75, 1, 1)).toBeCloseTo(0.5 * HALFTONE_RADIUS_MAX, 6)
  })
  it('contrast pushes mid-tones toward the extremes deterministically', () => {
    const mid = halftoneDotRadius(0.4, 1, 1)
    expect(halftoneDotRadius(0.4, 1, 2)).toBeGreaterThan(mid) // a dark mid gets fatter
    expect(halftoneDotRadius(0.6, 1, 2)).toBeLessThan(halftoneDotRadius(0.6, 1, 1)) // a light mid thins
  })
})

describe('halftoneCellDistance', () => {
  it('is 0 at a cell centre and ~0.707 at a corner', () => {
    expect(halftoneCellDistance(5, 5, 10, 0)).toBeCloseTo(0, 6) // centre of the 0..10 cell
    expect(halftoneCellDistance(0, 0, 10, 0)).toBeCloseTo(Math.SQRT1_2, 6) // a corner
  })
  it('is deterministic and bounded to [0, ~0.707]', () => {
    for (let y = 0; y < 40; y += 3) for (let x = 0; x < 40; x += 3) {
      const d = halftoneCellDistance(x, y, 7, Math.PI / 5)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(Math.SQRT1_2 + 1e-9)
      expect(halftoneCellDistance(x, y, 7, Math.PI / 5)).toBe(d) // same inputs → same value
    }
  })
  it('rotating the screen moves the pattern (angle changes the field)', () => {
    const flat = halftoneCellDistance(5, 5, 10, 0)
    const tilted = halftoneCellDistance(5, 5, 10, Math.PI / 4)
    expect(tilted).not.toBeCloseTo(flat, 3)
  })
})

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
