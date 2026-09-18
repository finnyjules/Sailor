import { describe, it, expect } from 'vitest'
import { overscanFov, gateRect, orthoOverscanScale, orthoGateRect } from '~/lib/scene3d/resolutionGate'

describe('orthographic gate math', () => {
  it('overscan scale is always ≥ 1/fill (never zooms in)', () => {
    for (const out of [0.5, 1, 1.75, 2.4]) {
      for (const pane of [0.8, 1.4, 2.2]) {
        expect(orthoOverscanScale(pane, out, 0.9)).toBeGreaterThanOrEqual(1 / 0.9 - 1e-9)
      }
    }
  })
  it('a square output in a wide pane pillar-boxes (fill height, narrower width)', () => {
    const { wFrac, hFrac } = orthoGateRect(1.6, 1.0, 0.9)
    expect(hFrac).toBeCloseTo(0.9, 3)
    expect(wFrac).toBeLessThan(hFrac)
  })
  it('a portrait output in a wide pane is height-limited (fill height, narrow width)', () => {
    const { wFrac, hFrac } = orthoGateRect(1.6, 0.5, 0.9)
    expect(hFrac).toBeCloseTo(0.9, 3)
    expect(wFrac).toBeLessThan(hFrac)
  })
  it('fractions never exceed 1', () => {
    for (const out of [0.5, 1, 2.4]) for (const pane of [0.8, 1.4, 2.2]) {
      const { wFrac, hFrac } = orthoGateRect(pane, out, 0.9)
      expect(wFrac).toBeLessThanOrEqual(1); expect(hFrac).toBeLessThanOrEqual(1)
    }
  })
})

describe('resolution gate math', () => {
  it('never zooms IN (overscan fov is always ≥ base fov)', () => {
    for (const out of [0.5, 1, 1.75, 2.4]) {
      for (const pane of [0.8, 1.4, 2.2]) {
        expect(overscanFov(45, pane, out) + 1e-9).toBeGreaterThanOrEqual(45)
      }
    }
  })

  it('a square output in a wide pane pillar-boxes (full-ish height, narrower width)', () => {
    const { wFrac, hFrac } = gateRect(45, 1.6, 1.0, 0.9)
    expect(hFrac).toBeCloseTo(0.9, 3)                 // height is the fill-limited axis
    expect(wFrac).toBeCloseTo(0.9 * 1.0 / 1.6, 3)     // narrower — pillar-boxed
    expect(wFrac).toBeLessThan(hFrac)
  })

  it('a wide output in a narrower pane letter-boxes (full-ish width, shorter height)', () => {
    const { wFrac, hFrac } = gateRect(45, 1.4, 1.75, 0.9)
    expect(wFrac).toBeCloseTo(0.9, 3)                 // width is the fill-limited axis
    expect(hFrac).toBeLessThan(wFrac)                 // shorter — letter-boxed
  })

  it('with fill=1 and matching aspects the gate fills the pane exactly', () => {
    const { wFrac, hFrac } = gateRect(50, 1.5, 1.5, 1)
    expect(wFrac).toBeCloseTo(1, 5)
    expect(hFrac).toBeCloseTo(1, 5)
    expect(overscanFov(50, 1.5, 1.5, 1)).toBeCloseTo(50, 5) // no overscan needed when it already fits
  })

  it('the gate rectangle never exceeds the pane (fractions ≤ 1)', () => {
    for (const out of [0.4, 1, 1.9, 3]) {
      const { wFrac, hFrac } = gateRect(60, 1.3, out)
      expect(wFrac).toBeLessThanOrEqual(1)
      expect(hFrac).toBeLessThanOrEqual(1)
    }
  })
})
