import { describe, it, expect } from 'vitest'
import {
  wobbleValue, resamplePolyline, effectiveWavelength, WOBBLE_MAX_POINTS,
  offsetPolyline, type WobbleSpec,
} from '~/lib/compositor/strokeShapes'

describe('wobbleValue', () => {
  it('wave matches sin at the quarter points', () => {
    for (const u of [0, 0.25, 0.5, 0.75]) {
      expect(wobbleValue('wave', u)).toBeCloseTo(Math.sin(u * Math.PI * 2), 12)
    }
  })

  it('zigzag gives exactly 0, 1, 0, −1 at the quarter points, matching sin\'s shape', () => {
    expect(wobbleValue('zigzag', 0)).toBeCloseTo(0, 12)
    expect(wobbleValue('zigzag', 0.25)).toBeCloseTo(1, 12)
    expect(wobbleValue('zigzag', 0.5)).toBeCloseTo(0, 12)
    expect(wobbleValue('zigzag', 0.75)).toBeCloseTo(-1, 12)
  })

  it('zigzag is linear between the quarter points', () => {
    expect(wobbleValue('zigzag', 0.125)).toBeCloseTo(0.5, 12)
    expect(wobbleValue('zigzag', 0.375)).toBeCloseTo(0.5, 12)
    expect(wobbleValue('zigzag', 0.625)).toBeCloseTo(-0.5, 12)
    expect(wobbleValue('zigzag', 0.875)).toBeCloseTo(-0.5, 12)
  })

  it('both shapes are periodic: u and u+1 agree', () => {
    for (const shape of ['wave', 'zigzag'] as const) {
      for (const u of [0, 0.1, 0.33, 0.5, 0.9, 1.4, -0.3]) {
        expect(wobbleValue(shape, u)).toBeCloseTo(wobbleValue(shape, u + 1), 9)
      }
    }
  })

  it('both shapes stay within [-1, 1] across 100 samples', () => {
    for (const shape of ['wave', 'zigzag'] as const) {
      for (let i = 0; i < 100; i++) {
        const v = wobbleValue(shape, i / 37)
        expect(v).toBeGreaterThanOrEqual(-1 - 1e-9)
        expect(v).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })
})

// A 2×1 rectangle (perimeter 6) is the fixture throughout this file, deliberately — see
// resamplePolyline's header. Its flattened outline is only 4 points; a wobble applied to
// those 4 points directly could not put anything in the middle of an edge.
const RECT_2X1 = [
  { x: -1, y: -0.5 }, { x: 1, y: -0.5 }, { x: 1, y: 0.5 }, { x: -1, y: 0.5 },
]

describe('resamplePolyline — a rectangle is the fixture, not a circle', () => {
  it('a 2×1 rect (perimeter 6) resampled at 0.1 yields ~60 points, each consecutive pair 0.1 apart', () => {
    const out = resamplePolyline(RECT_2X1, true, 0.1)
    expect(out.length).toBeGreaterThanOrEqual(58)
    expect(out.length).toBeLessThanOrEqual(60)
    for (let i = 1; i < out.length; i++) {
      const d = Math.hypot(out[i]!.x - out[i - 1]!.x, out[i]!.y - out[i - 1]!.y)
      expect(d).toBeCloseTo(0.1, 9)
    }
  })

  it('every resampled point still lies on the rectangle\'s own outline', () => {
    const out = resamplePolyline(RECT_2X1, true, 0.1)
    for (const p of out) {
      const onVertical = Math.abs(Math.abs(p.x) - 1) < 1e-9 && p.y >= -0.5 - 1e-9 && p.y <= 0.5 + 1e-9
      const onHorizontal = Math.abs(Math.abs(p.y) - 0.5) < 1e-9 && p.x >= -1 - 1e-9 && p.x <= 1 + 1e-9
      expect(onVertical || onHorizontal).toBe(true)
    }
  })

  it('a closed resample\'s last point is one step from the first, not on top of it', () => {
    const out = resamplePolyline(RECT_2X1, true, 0.1)
    const first = out[0]!, last = out[out.length - 1]!
    const gap = Math.hypot(last.x - first.x, last.y - first.y)
    expect(gap).toBeGreaterThan(0.05)
    expect(gap).toBeCloseTo(0.1, 6)
  })

  // FINDING 1 (final review). The cap used to TRUNCATE the walk: `count` was clamped to
  // WOBBLE_MAX_POINTS but the walk still advanced `s = i * step` at the REQUESTED step, so
  // the resampled outline simply stopped part-way round the shape and every consumer closed
  // it with a straight chord slashed across the middle. Measured on a 0.4 x 0.4 rect at
  // 1200 px: Every = 5 px covered 65% of the perimeter, 2 px 26%, 1 px 13% — one drag of a
  // `min="0"` scrub field away. The cap must COARSEN the step instead, so a too-small Every
  // costs fidelity (a lower-resolution wave) and never the shape.
  it('caps the output at WOBBLE_MAX_POINTS for a near-zero step, and still walks the WHOLE outline', () => {
    const out = resamplePolyline(RECT_2X1, true, 1e-6)
    expect(out.length).toBe(WOBBLE_MAX_POINTS)

    const perimeter = 6
    const coarse = perimeter / WOBBLE_MAX_POINTS
    let walked = 0, maxGap = 0
    for (let i = 1; i < out.length; i++) {
      const d = Math.hypot(out[i]!.x - out[i - 1]!.x, out[i]!.y - out[i - 1]!.y)
      walked += d
      maxGap = Math.max(maxGap, d)
    }
    // No pair is further apart than the coarsened step (a chord across a corner is shorter,
    // never longer), and the walk covers essentially the whole perimeter.
    expect(maxGap).toBeLessThanOrEqual(coarse + 1e-9)
    expect(walked).toBeGreaterThan(perimeter * 0.99)
    // And the ring CLOSES: the last sample is one step short of the first, not a chord away.
    const first = out[0]!, last = out[out.length - 1]!
    expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeLessThanOrEqual(coarse * 1.5)
  })

  it('returns the input unchanged for a degenerate step', () => {
    expect(resamplePolyline(RECT_2X1, true, 0)).toEqual(RECT_2X1)
    expect(resamplePolyline(RECT_2X1, true, -1)).toEqual(RECT_2X1)
    expect(resamplePolyline(RECT_2X1, true, NaN)).toEqual(RECT_2X1)
    expect(resamplePolyline(RECT_2X1, true, Infinity)).toEqual(RECT_2X1)
  })
})

describe('effectiveWavelength — the closed-cycle snap', () => {
  it('a perimeter of 8 with λ 0.7 snaps to 8/11', () => {
    expect(effectiveWavelength(8, 0.7, true)).toBeCloseTo(8 / 11, 9)
  })

  it('a perimeter of 8 with λ 1 stays 1 (already a whole number of cycles)', () => {
    expect(effectiveWavelength(8, 1, true)).toBeCloseTo(1, 9)
  })

  it('an open outline never snaps', () => {
    expect(effectiveWavelength(8, 0.7, false)).toBeCloseTo(0.7, 9)
    expect(effectiveWavelength(8, 20, false)).toBeCloseTo(20, 9)
  })

  it('a λ larger than the whole perimeter still yields exactly one cycle', () => {
    expect(effectiveWavelength(8, 20, true)).toBeCloseTo(8, 9)
  })
})

describe('offsetPolyline — wobble, on the rect fixture', () => {
  // Perimeter 12 (4×2 rect), λ = 12 exactly (one cycle all the way round) so
  // effectiveWavelength leaves it untouched (round(12/12) = 1) and every sample's `u` is a
  // clean fraction of 16 — no snapping arithmetic to reproduce in the test.
  const RECT_4X2 = [
    { x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 },
  ]
  const distance = 0.2
  const amount = 0.05

  it('an un-wobbled call returns a result identical to before (no wobble argument at all)', () => {
    const a = offsetPolyline(RECT_4X2, true, distance)
    const b = offsetPolyline(RECT_4X2, true, distance, undefined)
    const c = offsetPolyline(RECT_4X2, true, distance, null)
    expect(a).toEqual(b)
    expect(a).toEqual(c)
    expect(a).toHaveLength(4) // proves NO resampling happened without a live wobble
  })

  it('a degenerate wobble (zero amount, zero length, unrecognised shape) is the same as no wobble', () => {
    const plain = offsetPolyline(RECT_4X2, true, distance)
    const zeroAmount: WobbleSpec = { shape: 'wave', amount: 0, length: 3, phase: 0 }
    const zeroLength: WobbleSpec = { shape: 'wave', amount: amount, length: 0, phase: 0 }
    expect(offsetPolyline(RECT_4X2, true, distance, zeroAmount)).toEqual(plain)
    expect(offsetPolyline(RECT_4X2, true, distance, zeroLength)).toEqual(plain)
  })

  it('resamples the rect before wobbling it, so the outline has far more than 4 points', () => {
    const wobble: WobbleSpec = { shape: 'wave', amount, length: 12, phase: 0 }
    const out = offsetPolyline(RECT_4X2, true, distance, wobble)
    // λeff/16 = 12/16 = 0.75, perimeter 12 → 16 points. If the resample step were skipped,
    // wobbling the raw 4 corners could never produce this many.
    expect(out.length).toBeGreaterThan(4)
    expect(out.length).toBe(16)
  })

  it('deviates from the un-wobbled offset by at most `amount`, and reaches it at the quarter-cycle', () => {
    // λeff = 12 (perimeter, one whole cycle), step = 12/16 = 0.75. Walking from vertex 0
    // (-2,-1), the bottom edge runs s ∈ [0, 4). Sample i=4 sits at s=3, exactly on that
    // edge (not a corner), at u = s/λeff = 3/12 = 0.25 — sin's peak, exactly.
    const wobble: WobbleSpec = { shape: 'wave', amount, length: 12, phase: 0 }
    const out = offsetPolyline(RECT_4X2, true, distance, wobble)
    const plain = offsetPolyline(RECT_4X2, true, distance) // 4 corners only — different point set

    // The bottom-edge corner (-2,-1) offsets straight down (no wobble) to (-2, -1-distance);
    // establishes the sign convention empirically rather than assuming it.
    const bottomCornerPlain = plain.find(p => Math.abs(p.x + 2 - distance) < 1e-6 || Math.abs(p.y + 1 - distance) < 1e-6)
      ?? plain[0]!
    const outwardSign = bottomCornerPlain.y < -1 ? -1 : 1

    const p4 = out[4]!
    expect(p4.x).toBeCloseTo(1, 6) // (-2 + 0.75*4, -1) = (1, -1) before displacement
    const expectedY = -1 + outwardSign * (distance + amount * 1)
    expect(p4.y).toBeCloseTo(expectedY, 6)

    // Bound, measured on the RETURNED POLYLINE rather than on the test's own copy of the
    // formula (FINDING 3, final review: this loop used to compute `amount * wobbleValue(...)`
    // itself and assert that number was within `amount` — true of the formula whatever
    // `offsetPolyline` returned). The control is the constant-distance offset of the SAME
    // resampled point set, so `out[i] - ctrl[i]` IS the wobble's own contribution.
    // A second control at `distance + amount` gives the vector one full amplitude travels at
    // each vertex — including the miter stretch a bisector legitimately adds near a corner,
    // which the constant-distance offset applies to `distance` in exactly the same way. The
    // projection onto it is therefore the wobble's own value, in units of `amount`.
    const base = resamplePolyline(RECT_4X2, true, 0.75)
    const ctrl = offsetPolyline(base, true, distance)
    const ctrlPlus = offsetPolyline(base, true, distance + amount)
    expect(ctrl).toHaveLength(out.length)
    let maxDev = 0
    for (let i = 0; i < out.length; i++) {
      const ux = ctrlPlus[i]!.x - ctrl[i]!.x, uy = ctrlPlus[i]!.y - ctrl[i]!.y
      const len2 = ux * ux + uy * uy
      const dev = ((out[i]!.x - ctrl[i]!.x) * ux + (out[i]!.y - ctrl[i]!.y) * uy) / len2
      expect(Math.abs(dev)).toBeLessThanOrEqual(1 + 1e-9)
      // And it is the wave itself, read off the polyline the function returned.
      expect(dev).toBeCloseTo(wobbleValue('wave', (i * 0.75) / 12), 9)
      maxDev = Math.max(maxDev, Math.abs(dev))
    }
    expect(maxDev, 'the crest actually reaches the full amplitude').toBeCloseTo(1, 9)
  })

  // FINDING 1 (final review), at the seam a USER reaches: `Every` is a scrubbable px field
  // with `min="0"`, so a short drag asks for a step far below the point cap. The band's
  // painter closes the polyline it gets (`paintWobbledBand`'s `closePath`), so a walk that
  // stops part-way round is drawn as a chord slashed across the shape.
  it('an Every so small it trips the point cap still walks the WHOLE outline, and the ring closes', () => {
    // Perimeter 12, λ 0.04 → λeff 0.04 (300 whole cycles), step λeff/16 = 0.0025 → 4800
    // samples wanted, above the 4000 cap. The cap must coarsen the step to 12/4000 = 0.003.
    const wobble: WobbleSpec = { shape: 'wave', amount, length: 0.04, phase: 0 }
    const out = offsetPolyline(RECT_4X2, true, distance, wobble)
    expect(out.length).toBe(WOBBLE_MAX_POINTS)

    let walked = 0, maxGap = 0
    for (let i = 1; i < out.length; i++) {
      const d = Math.hypot(out[i]!.x - out[i - 1]!.x, out[i]!.y - out[i - 1]!.y)
      walked += d
      maxGap = Math.max(maxGap, d)
    }
    // The displaced ring is at least as long as the 12-unit outline it rides on.
    expect(walked).toBeGreaterThan(12 * 0.99)
    // And the closing chord is an ordinary segment, not a slash across the shape.
    const first = out[0]!, last = out[out.length - 1]!
    expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeLessThanOrEqual(maxGap * 1.5)
  })

  it('marching shapes: shapeStrokeGuideFit passes wobble through to offsetPolyline', async () => {
    const { shapeStrokeGuideFit } = await import('~/lib/compositor/strokeShapes')
    const d = 'M -2 -1 L 2 -1 L 2 1 L -2 1 Z'
    const plain = shapeStrokeGuideFit(d, distance)!
    const wobble: WobbleSpec = { shape: 'wave', amount, length: 12, phase: 0 }
    const wobbled = shapeStrokeGuideFit(d, distance, undefined, wobble)!
    expect(plain).toBeTruthy()
    expect(wobbled).toBeTruthy()
    // A wobbled guide is built from a resampled (much longer) outline, so its arc length
    // differs measurably from the plain constant-offset guide's.
    expect(wobbled.guide.length).not.toBeCloseTo(plain.guide.length, 3)
  })
})

describe('offsetPolyline — mutation-check fixtures (see Step 6 of the brief)', () => {
  it('a rect with an active wobble is NOT just the 4-point plain offset', () => {
    const RECT_4X2 = [{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }]
    const wobble: WobbleSpec = { shape: 'wave', amount: 0.05, length: 12, phase: 0 }
    const out = offsetPolyline(RECT_4X2, true, 0.2, wobble)
    // The trap: if resampling were skipped, this would be exactly 4 points (one per
    // original corner) no matter what the wobble amount is.
    expect(out.length).not.toBe(4)
  })

  it('a closed wobble whose wavelength does not evenly divide the perimeter still meets itself in phase at the seam', () => {
    // FINDING 3 (final review): this test used to assert
    // `wobbleValue('wave', 0) ≈ wobbleValue('wave', 1)` — true of the sine for EVERY
    // wavelength, snapped or not — and never called `offsetPolyline` at all. It now reads
    // the wobble back OUT of the returned polyline and asserts the seam property there.
    //
    // Perimeter 8 (2×2 square), λ 0.7 → snaps to 8/11 via effectiveWavelength, so the walk
    // is 11 whole cycles of exactly 16 samples each: 176 points, and sample i and sample
    // i+16 must carry the SAME displacement all the way round INCLUDING across the wrap.
    // Without the snap the sample count is not a multiple of the cycle and the wrap kinks.
    const SQ = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]
    const total = 8
    const requested = 0.7
    const distance = 0.2
    const amount = 0.05
    const lambdaEff = effectiveWavelength(total, requested, true)
    expect(lambdaEff).toBeCloseTo(8 / 11, 9)

    const step = lambdaEff / 16
    const out = offsetPolyline(SQ, true, distance, { shape: 'wave', amount, length: requested, phase: 0 })
    expect(out.length).toBe(176)

    // Read each sample's wobble back off the OUTPUT, free of the corner miter scale: two
    // constant-distance offsets of the same resampled points give the local normal (`unit`)
    // that a displacement of exactly `amount` produces at that vertex, so projecting the
    // wobbled point onto it recovers `wobbleValue` itself.
    const base = resamplePolyline(SQ, true, step)
    const ctrl = offsetPolyline(base, true, distance)
    const ctrlPlus = offsetPolyline(base, true, distance + amount)
    const readout = out.map((p, i) => {
      const ux = ctrlPlus[i]!.x - ctrl[i]!.x, uy = ctrlPlus[i]!.y - ctrl[i]!.y
      const len2 = ux * ux + uy * uy
      return ((p.x - ctrl[i]!.x) * ux + (p.y - ctrl[i]!.y) * uy) / len2
    })
    // THE SEAM, asserted first because it is what this test is for: one snapped cycle on,
    // all the way round, WRAPPING PAST THE LAST SAMPLE — which only holds because the cycle
    // count snapped to a whole 11 and the sample count is therefore a multiple of 16.
    for (let i = 0; i < readout.length; i++) {
      expect(readout[(i + 16) % readout.length]!, `sample ${i} and one cycle later`).toBeCloseTo(readout[i]!, 9)
    }
    // And it really is the wave, measured off the polyline rather than recomputed.
    for (let i = 0; i < readout.length; i++) {
      expect(readout[i]!).toBeCloseTo(wobbleValue('wave', (i * step) / lambdaEff), 9)
    }
  })
})
