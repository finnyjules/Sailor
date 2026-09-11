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
  // The hold the ledger takes is the flat MODEL_COSTS row for the slug regardless of
  // `seconds` (see the metering note in server/api/frame/animate.post.ts), so the quote
  // on the button must be that same flat number — a length-scaled quote promised a price
  // that was never charged.
  it('price is the flat catalog row regardless of length', () => {
    expect(clipPriceUsd('seedance-2.0')).toBeCloseTo(0.6)
    expect(clipPriceUsd('hailuo-h3')).toBeCloseTo(0.3)
    expect(clipPriceUsd('luma-ray-2-720p')).toBeCloseTo(0.4)
    expect(clipPriceUsd('nope')).toBeNull()
  })
})
