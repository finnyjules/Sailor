import { describe, it, expect } from 'vitest'
import { RESTYLE_MODELS } from '~/data/scene3d-restyle-models'
import { MODEL_COSTS } from '../../server/utils/priceBook'

// The allowlist ↔ pricing tie (allowlist-entries-need-handler-audit): the restyle route
// dispatches ONLY the fixed set of app slugs in RESTYLE_MODELS, and runFal REFUSES any slug
// missing a MODEL_COSTS row ("unpriced model refused", requestMeter.ts). A pure data module
// on one side and the price book on the other cannot drift apart without this test going red.
describe('RESTYLE_MODELS ↔ MODEL_COSTS (allowlist / pricing tie)', () => {
  it('holds exactly the two ratified fal entries with the right control types and provider', () => {
    expect(RESTYLE_MODELS.map((m) => m.id)).toEqual([
      'fal-ai/flux-control-lora-depth',
      'fal-ai/flux/dev/image-to-image',
    ])
    expect(RESTYLE_MODELS.find((m) => m.id === 'fal-ai/flux-control-lora-depth')!.control).toBe('depth')
    expect(RESTYLE_MODELS.find((m) => m.id === 'fal-ai/flux/dev/image-to-image')!.control).toBe('image')
    for (const m of RESTYLE_MODELS) expect(m.provider).toBe('fal')
  })

  it('every RESTYLE_MODELS id has a MODEL_COSTS row with positive credits (else runFal refuses)', () => {
    for (const m of RESTYLE_MODELS) {
      const row = MODEL_COSTS[m.id]
      expect(row, m.id).toBeTruthy()
      expect(row!.credits, m.id).toBeGreaterThan(0)
      expect(row!.usd, m.id).toBeGreaterThan(0)
    }
  })
})
