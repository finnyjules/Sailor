import { describe, it, expect } from 'vitest'
import { WHOLE_IMAGE_MODELS, REGION_MODELS } from '~/lib/compositor/imageEditModels'
describe('image edit models', () => {
  it('whole-image models: kontext default first, values are api ids', () => {
    expect(WHOLE_IMAGE_MODELS[0]).toEqual({ value: 'kontext', label: 'Kontext' })
    expect(WHOLE_IMAGE_MODELS.map(m => m.value)).toEqual(['kontext', 'nano'])
  })
  it('region models: flux fill only (nano region not wired yet)', () => {
    expect(REGION_MODELS[0]).toEqual({ value: 'flux', label: 'FLUX Fill' })
    expect(REGION_MODELS.map(m => m.value)).toEqual(['flux'])
  })
})
