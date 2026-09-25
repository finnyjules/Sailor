import { describe, expect, it } from 'vitest'
import { CLIP_MODELS, clipModel, clipModelLabel, clipPriceCredits, clipPriceUsd, clipRequest } from '~/data/clip-models'
import { videoRate } from '#shared/pricing/videoRates'
import { requestPrice } from '#shared/pricing/clipSettings'
import { MODEL_COSTS } from '../../server/utils/priceBook'

describe('clip models', () => {
  it('offers five rows; the label carries the version, the resolution and the price at the default length', () => {
    expect(CLIP_MODELS.map(m => m.id)).toEqual(['seedance-2.0', 'hailuo-h3', 'hailuo-h3-max', 'kling-v3-pro', 'flux-3-draft'])
    expect(CLIP_MODELS.map(m => clipModelLabel(m))).toEqual([
      'Seedance 2.0 (720p · 228 credits)', 'Hailuo H3 (768p · 45 credits)', 'Hailuo H3 Max (768p · 60 credits)', 'Kling 3.0 Pro (1080p · 84 credits)', 'FLUX 3 draft (720p · 45 credits)',
    ])
  })
  it('lengths follow what each model accepts', () => {
    expect(clipModel('seedance-2.0')!.durations).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(clipModel('hailuo-h3')!.durations).toEqual([5, 6, 10])
    expect(clipModel('hailuo-h3-max')!.durations).toEqual([5, 6, 8, 10, 12, 15])
    expect(clipModel('kling-v3-pro')!.durations).toEqual([3, 4, 5, 6, 8, 10])
    expect(clipModel('flux-3-draft')!.durations).toEqual([5, 10, 15])
    expect(CLIP_MODELS.every(m => m.durations.includes(m.defaultDuration))).toBe(true)
  })
  // Task P5: priced per second of the request the route sends (clipRequest), the
  // figure runFal holds and charges (clip-pricing.unit.spec.ts pins the hold).
  it('price scales with length: the shared price of the request sent', () => {
    expect(clipPriceUsd('seedance-2.0', 5)).toBeCloseTo(1.517)
    expect(clipPriceUsd('seedance-2.0', 10)).toBeCloseTo(3.034)
    expect(clipPriceUsd('hailuo-h3', 10)).toBeCloseTo(0.6)
    expect(clipPriceUsd('hailuo-h3-max', 5)).toBeCloseTo(0.4)
    expect(clipPriceUsd('kling-v3-pro', 5)).toBeCloseTo(0.56)
    expect(clipPriceUsd('nope', 5)).toBeNull()
    for (const m of CLIP_MODELS) {
      for (const s of m.durations) {
        const req = clipRequest(m.id, s, '', '')
        expect(clipPriceCredits(m.id, s), `${m.id} ${s}`).toBe(requestPrice(req.endpoint, req.input)!.credits)
      }
    }
    expect(clipPriceCredits('nope', 5)).toBeNull()
  })
  // The flat MODEL_COSTS rows are now only a fail-safe ceiling: the longest clip.
  it('each endpoint’s price book row is the longest clip’s price', () => {
    for (const m of CLIP_MODELS) {
      const slug = clipRequest(m.id, m.defaultDuration, '', '').endpoint
      expect(MODEL_COSTS[slug]!.credits, m.id).toBe(Math.max(...m.durations.map(s => clipPriceCredits(m.id, s)!)))
    }
  })
  // The Generate-a-video catalogue has a verified card for the same models (by id);
  // Animate prices its own endpoints (shared/pricing/clipRates.ts) at the same figures.
  it('rows that also live in the shared video catalog have a verified rate card', () => {
    const shared = CLIP_MODELS.filter(m => videoRate(m.id))
    for (const m of shared) expect(videoRate(m.id)!.confidence, m.id).toBe('verified')
    expect(shared.map(m => m.id)).toEqual(['seedance-2.0', 'hailuo-h3', 'hailuo-h3-max'])   // Kling 3.0 Pro and FLUX 3 draft are clip-only
  })
})
