import { describe, it, expect } from 'vitest'
import { WHOLE_IMAGE_MODELS, REGION_MODELS } from '~/lib/compositor/imageEditModels'
describe('image edit models', () => {
  it('whole-image models: FLUX.2 (kontext route) default first, then nano pro + nano 2', () => {
    expect(WHOLE_IMAGE_MODELS[0]).toEqual({ value: 'kontext', label: 'FLUX.2' })
    expect(WHOLE_IMAGE_MODELS.map(m => m.value)).toEqual(['kontext', 'nano', 'nano2'])
  })
  it('region models: FLUX Fill default, plus flux-general + qwen (all mask-native)', () => {
    expect(REGION_MODELS[0]).toEqual({ value: 'flux', label: 'FLUX Fill' })
    expect(REGION_MODELS.map(m => m.value)).toEqual(['flux', 'flux-general', 'qwen'])
  })
})
