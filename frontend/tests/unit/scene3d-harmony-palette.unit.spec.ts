import { describe, it, expect } from 'vitest'
import { rampStopsOf, parseMaterialForTest } from './helpers/scene3d-material'
import { applySeedStopsToMaterial, type SceneMaterial } from '~/lib/scene3d/config'

const base: SceneMaterial = { type: 'gradient', color: '#222222', roughness: 0.5, metalness: 0 }

describe('scene3d harmony palette', () => {
  it('manual mode returns the authored/synthesized stops unchanged', () => {
    const stops = rampStopsOf({ ...base, gradientB: '#ffffff' })
    expect(stops.length).toBe(2)
    expect(stops[0]!.color).toBe('#222222')
  })

  it('harmony mode generates a monotonic dark→light ramp', () => {
    const stops = rampStopsOf({
      ...base, paletteMode: 'harmony', paletteHue: 210, paletteSat: 0.5,
      paletteLight: 0.6, paletteHarmony: 'analogous',
    })
    expect(stops.length).toBeGreaterThanOrEqual(4)
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]!.pos).toBeGreaterThan(stops[i - 1]!.pos)
    }
  })

  it('harmony mode is deterministic in its inputs', () => {
    const mk = () => rampStopsOf({ ...base, paletteMode: 'harmony', paletteHue: 40, paletteSat: 0.6, paletteLight: 0.5, paletteHarmony: 'triadic' })
    expect(mk()).toEqual(mk())
  })

  it('palette fields round-trip through parseMaterial', () => {
    const m = parseMaterialForTest({ type: 'gradient', color: '#222', roughness: 0.5, metalness: 0, paletteMode: 'harmony', paletteHue: 123, paletteSat: 0.4, paletteLight: 0.7, paletteHarmony: 'complementary' })
    expect(m.paletteMode).toBe('harmony')
    expect(m.paletteHue).toBe(123)
    expect(m.paletteHarmony).toBe('complementary')
  })

  it('applying seed stops flips paletteMode to manual and keeps exact colors', () => {
    const mat: any = { paletteMode: 'harmony', gradientStops: [] }
    applySeedStopsToMaterial(mat, [{ pos: 0, color: '#b64a1f' }, { pos: 1, color: '#f4e3d0' }])
    expect(mat.paletteMode).toBe('manual')
    expect(mat.gradientStops.map((s: any) => s.color)).toEqual(['#b64a1f', '#f4e3d0'])
  })
})
