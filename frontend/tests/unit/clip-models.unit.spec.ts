import { describe, expect, it } from 'vitest'
import { CLIP_MODELS, clipModel, clipPriceUsd } from '~/data/clip-models'

describe('clip models', () => {
  it('offers exactly the three rows the spec names, with sentence-case labels', () => {
    expect(CLIP_MODELS.map(m => m.id)).toEqual(['luma-ray-2-720p', 'seedance-2.0', 'hailuo-h3'])
    expect(CLIP_MODELS.map(m => m.label)).toEqual(['Luma, loops by itself', 'Seedance', 'Hailuo'])
  })
  it('lengths follow what each model accepts', () => {
    expect(clipModel('luma-ray-2-720p')!.durations).toEqual([5, 9])
    expect(clipModel('seedance-2.0')!.durations).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(clipModel('hailuo-h3')!.durations).toEqual([5, 6, 10])
    expect(CLIP_MODELS.every(m => m.durations.includes(m.defaultDuration))).toBe(true)
  })
  it('only Luma loops by itself', () => {
    expect(CLIP_MODELS.filter(m => m.loopsItself).map(m => m.id)).toEqual(['luma-ray-2-720p'])
  })
  it('prices scale with length from the 5 s row', () => {
    expect(clipPriceUsd('seedance-2.0', 5)).toBeCloseTo(0.6)
    expect(clipPriceUsd('seedance-2.0', 10)).toBeCloseTo(1.2)
    expect(clipPriceUsd('nope', 5)).toBeNull()
  })
})
