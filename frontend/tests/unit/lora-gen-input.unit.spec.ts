import { describe, it, expect } from 'vitest'
import { buildFalLoraGenInput, buildLoraGenInput } from '../../server/utils/loraGenInput'

describe('buildLoraGenInput', () => {
  it('keeps the existing defaults exactly', () => {
    expect(buildLoraGenInput({ prompt: 'p' })).toEqual({
      prompt: 'p',
      aspect_ratio: '1:1',
      megapixels: '1',
      num_inference_steps: 22,
      guidance_scale: 3.5,
      num_outputs: 1,
      output_format: 'png',
      lora_scale: 1,
    })
  })
  it('passes seed only when finite', () => {
    expect(buildLoraGenInput({ prompt: 'p', seed: 101101 }).seed).toBe(101101)
    expect('seed' in buildLoraGenInput({ prompt: 'p' })).toBe(false)
    expect('seed' in buildLoraGenInput({ prompt: 'p', seed: Number.NaN })).toBe(false)
  })
  it('honors overrides', () => {
    const out = buildLoraGenInput({ prompt: 'p', aspectRatio: '4:3', loraScale: 0.7, guidanceScale: 4 })
    expect(out.aspect_ratio).toBe('4:3')
    expect(out.lora_scale).toBe(0.7)
    expect(out.guidance_scale).toBe(4)
  })
})

describe('buildFalLoraGenInput', () => {
  const WEIGHTS = 'https://v3.fal.media/files/x/lora.safetensors'

  it('pins the exact fal-ai/flux-lora payload', () => {
    expect(buildFalLoraGenInput('p', {}, WEIGHTS)).toEqual({
      prompt: 'p',
      image_size: 'square_hd',
      num_inference_steps: 22,
      guidance_scale: 3.5,
      num_images: 1,
      output_format: 'png',
      loras: [{ path: WEIGHTS, scale: 1 }],
    })
  })

  it('passes seed only when finite', () => {
    expect(buildFalLoraGenInput('p', { seed: 101101 }, WEIGHTS).seed).toBe(101101)
    expect('seed' in buildFalLoraGenInput('p', {}, WEIGHTS)).toBe(false)
    expect('seed' in buildFalLoraGenInput('p', { seed: Number.NaN }, WEIGHTS)).toBe(false)
  })

  it('carries the LoRA scale and guidance through', () => {
    const out = buildFalLoraGenInput('p', { loraScale: 0.7, guidanceScale: 4 }, WEIGHTS)
    expect(out.loras).toEqual([{ path: WEIGHTS, scale: 0.7 }])
    expect(out.guidance_scale).toBe(4)
  })

  it('maps the aspect ratio through falImageSize', () => {
    expect(buildFalLoraGenInput('p', { aspectRatio: '16:9' }, WEIGHTS).image_size).toBe('landscape_16_9')
    expect(buildFalLoraGenInput('p', { aspectRatio: '3:2' }, WEIGHTS).image_size).toEqual({ width: 1024, height: 688 })
  })
})
