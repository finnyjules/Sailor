import { describe, it, expect } from 'vitest'
import { WHOLE_IMAGE_MODELS, REGION_MODELS } from '~/lib/compositor/imageEditModels'
describe('image edit models', () => {
  it('whole-image models: FLUX.2 default first, then nano pro/2, seedream, gpt image', () => {
    expect(WHOLE_IMAGE_MODELS[0]).toEqual({ value: 'kontext', label: 'FLUX.2' })
    expect(WHOLE_IMAGE_MODELS.map(m => m.value)).toEqual(['kontext', 'nano', 'nano2', 'seedream', 'gptimage'])
  })
  it('region models: FLUX Fill default, plus flux-general, qwen, gpt image', () => {
    expect(REGION_MODELS[0]).toEqual({ value: 'flux', label: 'FLUX Fill' })
    expect(REGION_MODELS.map(m => m.value)).toEqual(['flux', 'flux-general', 'qwen', 'gptimage'])
  })
})
