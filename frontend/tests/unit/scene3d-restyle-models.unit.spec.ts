import { describe, it, expect } from 'vitest'
import { RESTYLE_MODELS, pickRestyleModel } from '~/data/scene3d-restyle-models'
import { MODEL_COSTS } from '../../server/utils/priceBook'

// The allowlist ↔ pricing tie (allowlist-entries-need-handler-audit): the restyle route
// dispatches ONLY the fixed set of app slugs in RESTYLE_MODELS, and runFal REFUSES any slug
// missing a MODEL_COSTS row ("unpriced model refused", requestMeter.ts). A pure data module
// on one side and the price book on the other cannot drift apart without this test going red.
describe('RESTYLE_MODELS ↔ MODEL_COSTS (allowlist / pricing tie)', () => {
  it('holds the two selectable models plus the route-internal depth+style model', () => {
    expect(RESTYLE_MODELS.map((m) => m.id)).toEqual([
      'fal-ai/flux-control-lora-depth',
      'fal-ai/flux/dev/image-to-image',
      'fal-ai/flux-general',
    ])
    expect(RESTYLE_MODELS.find((m) => m.id === 'fal-ai/flux-control-lora-depth')!.control).toBe('depth')
    expect(RESTYLE_MODELS.find((m) => m.id === 'fal-ai/flux/dev/image-to-image')!.control).toBe('image')
    const styled = RESTYLE_MODELS.find((m) => m.id === 'fal-ai/flux-general')!
    expect(styled.control).toBe('depth+style')
    expect(styled.selectable).toBe(false) // route-internal — never on the user model dropdown
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

  it('pickRestyleModel routes to depth+style ONLY when refs are present', () => {
    const depth = RESTYLE_MODELS.find((m) => m.control === 'depth')!
    const styled = RESTYLE_MODELS.find((m) => m.control === 'depth+style')!
    expect(pickRestyleModel('fal-ai/flux-control-lora-depth', true)).toBe(styled)
    expect(pickRestyleModel('fal-ai/flux-control-lora-depth', false)).toBe(depth)
    // A caller must never be able to pick the internal model directly (it's not selectable).
    expect(pickRestyleModel('fal-ai/flux-general', false)).toBe(depth)
    // Unknown / missing id falls back to the first entry.
    expect(pickRestyleModel(undefined, false)).toBe(RESTYLE_MODELS[0])
  })
})
