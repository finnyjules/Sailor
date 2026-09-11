import { describe, it, expect } from 'vitest'
import { pickSafetensorsMember, withFalWeightsUrl } from '../../server/utils/loraFalWeights'

describe('pickSafetensorsMember', () => {
  it('prefers lora.safetensors over any other weights file', () => {
    expect(pickSafetensorsMember([
      'output/flux_train_replicate/config.yaml',
      'output/flux_train_replicate/optimizer.safetensors',
      'output/flux_train_replicate/lora.safetensors',
    ])).toBe('output/flux_train_replicate/lora.safetensors')
  })

  it('falls back to the first .safetensors when none is named lora', () => {
    expect(pickSafetensorsMember([
      'out/config.yaml',
      'out/weights.safetensors',
      'out/second.safetensors',
    ])).toBe('out/weights.safetensors')
  })

  it('is null when the tar has no weights at all', () => {
    expect(pickSafetensorsMember(['out/config.yaml', 'out/captions/0001.txt'])).toBeNull()
    expect(pickSafetensorsMember([])).toBeNull()
  })

  it('matches on the member basename, not a folder called lora.safetensors', () => {
    expect(pickSafetensorsMember(['lora.safetensors/inner.safetensors'])).toBe('lora.safetensors/inner.safetensors')
  })
})

describe('withFalWeightsUrl', () => {
  const meta = {
    name: 'Azure_Bloom',
    trigger: 'azure_bloom',
    replicate_model: 'finnyjules/jules-azure_bloom:161403ca',
    replicate_url: 'https://replicate.delivery/xezq/abc/trained_model.tar',
    trained_on: 'datasets/azure',
  }

  it('adds the field and keeps every other one', () => {
    const out = withFalWeightsUrl(meta, 'https://v3.fal.media/files/x/lora.safetensors')
    expect(out).toEqual({ ...meta, fal_weights_url: 'https://v3.fal.media/files/x/lora.safetensors' })
  })

  it('does not mutate the sidecar it was given', () => {
    withFalWeightsUrl(meta, 'https://v3.fal.media/files/x/lora.safetensors')
    expect('fal_weights_url' in meta).toBe(false)
  })

  it('replaces a stale url', () => {
    const out = withFalWeightsUrl({ ...meta, fal_weights_url: 'https://old' }, 'https://new')
    expect(out.fal_weights_url).toBe('https://new')
  })
})
