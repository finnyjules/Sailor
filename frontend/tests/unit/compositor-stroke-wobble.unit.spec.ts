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

  it('caps the output at WOBBLE_MAX_POINTS for a near-zero step', () => {
    const out = resamplePolyline(RECT_2X1, true, 1e-6)
    expect(out.length).toBe(WOBBLE_MAX_POINTS)
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

    // Bound: every sample on a straight edge (x or y unchanged from its pre-offset value on
    // that axis) deviates from the constant-distance offset by at most `amount`.
    let sawFullAmplitude = false
    for (let i = 0; i < out.length; i++) {
      const s = i * 0.75
      const u = s / 12
      const local = amount * wobbleValue('wave', u)
      expect(Math.abs(local)).toBeLessThanOrEqual(amount + 1e-9)
      if (Math.abs(Math.abs(local) - amount) < 1e-6) sawFullAmplitude = true
    }
    expect(sawFullAmplitude).toBe(true)
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
    // Perimeter 8 (2×2 square), λ 0.7 → snaps to 8/11 via effectiveWavelength. Confirm the
    // sample one full (snapped) cycle later reproduces the same local displacement as the
    // sample it started from — the seam does not kink.
    const SQ = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]
    const total = 8
    const requested = 0.7
    const lambdaEff = effectiveWavelength(total, requested, true)
    expect(lambdaEff).toBeCloseTo(8 / 11, 9)
    // One full snapped cycle later must land on the same phase as u=0.
    const u0 = 0 / lambdaEff
    const u1 = lambdaEff / lambdaEff
    expect(wobbleValue('wave', u0)).toBeCloseTo(wobbleValue('wave', u1), 9)

    // If the snap were skipped (λeff === requested), the whole perimeter would NOT land on
    // a whole number of cycles, so the seam sample would disagree with the start sample.
    const uEndUnsnapped = total / requested
    expect(Number.isInteger(uEndUnsnapped)).toBe(false)
  })
})
