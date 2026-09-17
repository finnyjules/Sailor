import { describe, it, expect } from 'vitest'
import { ambientFloorByte } from '~/lib/scene3d/pathtrace/envEquirect'

// ambientFloorByte stands in for the raster's AmbientLight (which three-gpu-pathtracer never
// samples). It is pre-divided by the preset's envIntensity so that, once the tracer scales the
// env by that intensity, the fill lands back near the doc's `ambient`.
describe('ambientFloorByte', () => {
  it('is zero when there is no ambient (byte-identical env, no fill)', () => {
    expect(ambientFloorByte(0, 0.35)).toBe(0)
    expect(ambientFloorByte(0, 1)).toBe(0)
  })

  it('compensates for a dim (dramatic) preset so the fill survives intensity scaling', () => {
    // rim-on-dark: ambient 0.15, dramatic envIntensity 0.35 → 0.15/0.35 ≈ 0.429 → 109
    expect(ambientFloorByte(0.15, 0.35)).toBe(109)
  })

  it('scales down for a brighter preset (less division needed)', () => {
    // three-point: ambient 0.5, studio envIntensity 0.9 → 0.556 → 142
    expect(ambientFloorByte(0.5, 0.9)).toBe(142)
  })

  it('clamps to a full-white floor rather than overflowing the byte', () => {
    expect(ambientFloorByte(1.0, 0.35)).toBe(255)
    expect(ambientFloorByte(0.9, 0.1)).toBe(255)
  })

  it('guards a zero/absent envIntensity instead of dividing by zero', () => {
    expect(Number.isFinite(ambientFloorByte(0.05, 0))).toBe(true)
    // floor uses max(envIntensity, 0.1): 0.05 / 0.1 = 0.5 → 128
    expect(ambientFloorByte(0.05, 0)).toBe(128)
  })

  it('never returns a negative floor for a negative ambient', () => {
    expect(ambientFloorByte(-1, 0.5)).toBe(0)
  })
})
