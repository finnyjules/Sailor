import { describe, expect, it } from 'vitest'
import { CLIP_MODELS, clipModel, clipModelLabel, clipPriceUsd } from '~/data/clip-models'
import { VIDEO_MODEL_USD } from '~/data/video-prices'

describe('clip models', () => {
  it('offers four rows; the label carries the version, the resolution and the flat price', () => {
    expect(CLIP_MODELS.map(m => m.id)).toEqual(['seedance-2.0', 'hailuo-h3', 'hailuo-h3-max', 'kling-v3-pro'])
    expect(CLIP_MODELS.map(clipModelLabel)).toEqual([
      'Seedance 2.0 (720p · $0.60)', 'Hailuo H3 (768p · $0.30)', 'Hailuo H3 Max (768p · $0.40)', 'Kling 3.0 Pro (1080p · $0.56)',
    ])
  })
  it('lengths follow what each model accepts', () => {
    expect(clipModel('seedance-2.0')!.durations).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(clipModel('hailuo-h3')!.durations).toEqual([5, 6, 10])
    expect(clipModel('hailuo-h3-max')!.durations).toEqual([5, 6, 8, 10, 12, 15])
    expect(clipModel('kling-v3-pro')!.durations).toEqual([3, 4, 5, 6, 8, 10])
    expect(CLIP_MODELS.every(m => m.durations.includes(m.defaultDuration))).toBe(true)
  })
  // The hold the ledger takes is the flat MODEL_COSTS row for the slug regardless of
  // `seconds` (see the metering note in server/api/frame/animate.post.ts), so the quote
  // on the button must be that same flat number — a length-scaled quote promised a price
  // that was never charged.
  it('price is the flat catalog row regardless of length', () => {
    expect(clipPriceUsd('seedance-2.0')).toBeCloseTo(0.6)
    expect(clipPriceUsd('hailuo-h3')).toBeCloseTo(0.3)
    expect(clipPriceUsd('hailuo-h3-max')).toBeCloseTo(0.4)
    expect(clipPriceUsd('kling-v3-pro')).toBeCloseTo(0.56)
    expect(clipPriceUsd('nope')).toBeNull()
  })
  it('rows that also live in the shared video catalog quote the same price', () => {
    for (const m of CLIP_MODELS) {
      const shared = VIDEO_MODEL_USD[m.id]
      if (shared) expect(m.usd, m.id).toBeCloseTo(shared.usd)
    }
    expect(CLIP_MODELS.filter(m => VIDEO_MODEL_USD[m.id]).length).toBe(3)   // Kling 3.0 Pro is clip-only
  })
})
