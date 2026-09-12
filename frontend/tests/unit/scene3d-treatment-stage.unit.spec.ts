import { describe, it, expect } from 'vitest'
import { blurPasses, pixelateCellPx, stageSamples, rampValueAt, pixelateBand, rampDirection, rampSupport, colorGradeRGB, dissolveNoise, dissolveAlpha, halftoneDotRadius, halftoneCellDistance, HALFTONE_RADIUS_MAX, chromaticOffsetPx, chromaticSplitOffset, glitchShiftPx, glitchBandShift, dropShadowDistancePx, dropShadowOffset, dropShadowHaloPx, crossHatchSpacingPx, crossHatchLayerWeights, crossHatchLine, crossHatchInk } from '~/lib/scene3d/treatmentStage'

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

describe('chromaticOffsetPx', () => {
  it('scales the offset with image height, holding the look constant, with NO 1px floor', () => {
    expect(chromaticOffsetPx(8, 1000)).toBe(8)
    expect(chromaticOffsetPx(8, 2000)).toBe(16)
    expect(chromaticOffsetPx(0, 1000)).toBe(0) // amount 0 → no split at all
    expect(chromaticOffsetPx(0.1, 100)).toBeCloseTo(0.01) // below a pixel, unlike pixelateCellPx
  })
  it('never goes negative', () => {
    expect(chromaticOffsetPx(-5, 1000)).toBe(0)
  })
})

describe('chromaticSplitOffset', () => {
  it('amount 0 gives the zero vector — all three samples coincide, the object unchanged', () => {
    const o = chromaticSplitOffset(0, 45, 1000)
    expect(o.x).toBeCloseTo(0, 10)
    expect(o.y).toBeCloseTo(0, 10)
  })
  it('magnitude equals chromaticOffsetPx, independent of angle', () => {
    for (const angle of [0, 30, 90, 200, 359]) {
      const o = chromaticSplitOffset(8, angle, 1000)
      expect(Math.hypot(o.x, o.y)).toBeCloseTo(chromaticOffsetPx(8, 1000), 6)
    }
  })
  it('angle rotates the offset vector (y negated so 0°→right, 90°→down the screen)', () => {
    const right = chromaticSplitOffset(10, 0, 1000)
    expect(right.x).toBeCloseTo(10, 6)
    expect(right.y).toBeCloseTo(0, 6)
    const down = chromaticSplitOffset(10, 90, 1000)
    expect(down.x).toBeCloseTo(0, 6)
    expect(down.y).toBeCloseTo(-10, 6)
  })
  it('the R (+offset) and B (−offset) directions are exact opposites — the fringe pulls both ways', () => {
    const o = chromaticSplitOffset(7, 37, 1000)
    // R samples at +o, B at −o: opposite offsets of equal magnitude.
    expect(-o.x).toBeCloseTo(-1 * o.x, 6)
    expect(Math.hypot(o.x, o.y)).toBeCloseTo(Math.hypot(-o.x, -o.y), 6)
    expect(o.x).not.toBe(0)
    expect(o.y).not.toBe(0)
  })
})

describe('glitchShiftPx', () => {
  it('scales by height/1000, resolution-independent like the pixelate scale', () => {
    expect(glitchShiftPx(24, 1000)).toBe(24)
    expect(glitchShiftPx(24, 2000)).toBe(48)
  })
  it('amount 0 → no shift at all; there is no 1px floor (unlike pixelateCellPx)', () => {
    expect(glitchShiftPx(0, 1000)).toBe(0)
    expect(glitchShiftPx(0.1, 100)).toBeCloseTo(0.01)
  })
  it('a negative amount clamps to zero', () => {
    expect(glitchShiftPx(-5, 1000)).toBe(0)
  })
})

describe('glitchBandShift', () => {
  const bandShifts = (seed: number, n = 32): number[] =>
    Array.from({ length: n }, (_, band) => glitchBandShift(band, seed))

  it('is deterministic — the same (band, seed) always gives the same shift, run to run', () => {
    expect(bandShifts(1)).toEqual(bandShifts(1)) // seeded, never Math.random
  })
  it('a different seed produces a different set of band jumps', () => {
    expect(bandShifts(1)).not.toEqual(bandShifts(2))
  })
  it('every shift is a signed fraction in [-1, 1)', () => {
    for (const seed of [0, 1, 7, 42]) for (const s of bandShifts(seed)) {
      expect(s).toBeGreaterThanOrEqual(-1)
      expect(s).toBeLessThan(1)
    }
  })
  it('neighbouring bands jump different distances (the bands do not move as one)', () => {
    const shifts = bandShifts(3)
    expect(new Set(shifts.map((s) => s.toFixed(6))).size).toBeGreaterThan(shifts.length / 2)
  })
  it('more bands means more distinct jumps across the object — narrower, busier slices', () => {
    const distinct = (n: number) => new Set(bandShifts(5, n).map((s) => s.toFixed(6))).size
    expect(distinct(24)).toBeGreaterThan(distinct(6))
  })
})

describe('dropShadowDistancePx', () => {
  it('scales by height/1000, resolution-independent like the pixelate scale', () => {
    expect(dropShadowDistancePx(16, 1000)).toBe(16)
    expect(dropShadowDistancePx(16, 2000)).toBe(32)
  })
  it('distance 0 → the shadow sits under the object; there is no 1px floor', () => {
    expect(dropShadowDistancePx(0, 1000)).toBe(0)
    expect(dropShadowDistancePx(0.1, 100)).toBeCloseTo(0.01)
  })
  it('a negative distance clamps to zero', () => {
    expect(dropShadowDistancePx(-5, 1000)).toBe(0)
  })
})

describe('dropShadowOffset', () => {
  it('distance 0 gives the zero vector — the shadow directly under the object', () => {
    const o = dropShadowOffset(0, 45, 1000)
    expect(o.x).toBeCloseTo(0, 10)
    expect(o.y).toBeCloseTo(0, 10)
  })
  it('magnitude equals dropShadowDistancePx, independent of angle', () => {
    for (const angle of [0, 30, 90, 200, 359]) {
      const o = dropShadowOffset(16, angle, 1000)
      expect(Math.hypot(o.x, o.y)).toBeCloseTo(dropShadowDistancePx(16, 1000), 6)
    }
  })
  it('angle rotates the offset vector (y negated so 0°→right, 90°→down the screen)', () => {
    const right = dropShadowOffset(10, 0, 1000)
    expect(right.x).toBeCloseTo(10, 6)
    expect(right.y).toBeCloseTo(0, 6)
    const down = dropShadowOffset(10, 90, 1000)
    expect(down.x).toBeCloseTo(0, 6)
    expect(down.y).toBeCloseTo(-10, 6)
  })
})

describe('dropShadowHaloPx', () => {
  it('is the offset distance plus the softness blur radius', () => {
    // softness 0 → no blur reach, so the halo is just the offset distance.
    expect(dropShadowHaloPx(16, 0, 1000)).toBeCloseTo(16)
    // softness reach == blur radius at that amount, added on top of the offset.
    expect(dropShadowHaloPx(16, 0.5, 1000)).toBeCloseTo(16 + blurPasses(0.5, 1000).radiusPx)
    // distance 0 → the reach is the blur alone.
    expect(dropShadowHaloPx(0, 0.5, 1000)).toBeCloseTo(blurPasses(0.5, 1000).radiusPx)
  })
  it('grows with both distance and softness, resolution-scaled', () => {
    expect(dropShadowHaloPx(16, 0.5, 2000)).toBeGreaterThan(dropShadowHaloPx(16, 0.5, 1000))
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

describe('cross-hatch: tone-driven rotated line screen', () => {
  it('spacing scales with height, floors at 1px, and holds the pixelate look', () => {
    expect(crossHatchSpacingPx(6, 1000)).toBe(6)
    expect(crossHatchSpacingPx(6, 2000)).toBe(12)
    expect(crossHatchSpacingPx(0, 1000)).toBe(1) // never collapses the lattice
  })

  it('layer weights: a bright pixel (tone >= threshold) gets no ink at all', () => {
    expect(crossHatchLayerWeights(0.8, 0.6)).toEqual([0, 0, 0])
    expect(crossHatchLayerWeights(0.6, 0.6)).toEqual([0, 0, 0])
  })

  it('layer weights: darker tone brings on more screens, and no weight ever decreases as it darkens', () => {
    const total = (tone: number) => crossHatchLayerWeights(tone, 0.6).reduce((a, b) => a + b, 0)
    // Well below the threshold two/three screens are active; near black all three are full.
    expect(total(0.5)).toBeGreaterThan(0)
    expect(total(0.3)).toBeGreaterThan(total(0.5))
    expect(total(0.0)).toBeGreaterThan(total(0.3))
    expect(crossHatchLayerWeights(0, 0.6)).toEqual([1, 1, 1])
    let prev = [-1, -1, -1]
    for (let i = 0; i <= 60; i++) {
      const w = crossHatchLayerWeights(0.6 - i / 100, 0.6)
      w.forEach((v, k) => expect(v).toBeGreaterThanOrEqual(prev[k]!))
      prev = w
    }
  })

  it('the line screen is deterministic, periodic in the spacing and rotated by the angle', () => {
    // Angle 0 → lines run horizontally (perpendicular axis is y), so the pattern repeats along y.
    expect(crossHatchLine(0, 0, 8, 0)).toBeCloseTo(crossHatchLine(0, 8, 8, 0), 6)
    // Peaks on a line (~1), troughs midway between lines (~0).
    expect(crossHatchLine(0, 0, 8, 0)).toBeGreaterThan(0.9)
    expect(crossHatchLine(0, 4, 8, 0)).toBeLessThan(0.1)
    // Rotating 90° swaps which axis the lines run along: the walk down y now stays on one line.
    const alongY0 = [0, 2, 4, 6].map((y) => crossHatchLine(0, y, 8, 0))
    const alongY90 = [0, 2, 4, 6].map((y) => crossHatchLine(0, y, 8, Math.PI / 2))
    expect(alongY0).not.toEqual(alongY90)
    // Same inputs → same output, run to run.
    expect(crossHatchLine(3, 5, 7, 1.2)).toBe(crossHatchLine(3, 5, 7, 1.2))
  })

  it('ink: bright objects stay clean, dark objects pick up ink where the screens fall', () => {
    // Bright tone: no ink anywhere regardless of pixel.
    for (let x = 0; x < 16; x++) expect(crossHatchInk(x, 0, 0.9, 8, 0, 0.6)).toBe(0)
    // Dark tone: some pixels ink up (on the lines), some stay clean (between them).
    let maxInk = 0
    for (let x = 0; x < 32; x++) maxInk = Math.max(maxInk, crossHatchInk(x, 0, 0.05, 8, 0, 0.6))
    expect(maxInk).toBeGreaterThan(0.5)
    // Deterministic.
    expect(crossHatchInk(5, 9, 0.2, 6, 0.7, 0.6)).toBe(crossHatchInk(5, 9, 0.2, 6, 0.7, 0.6))
  })
})
