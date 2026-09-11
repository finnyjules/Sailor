import { describe, expect, it } from 'vitest'
import { FAL_FILL_REMOVE_PROMPT } from '../../server/utils/falFill'
import {
  removeBgInput,
  kontextInput,
  text2imgInput,
  poseInput,
  fluxFillDevInput,
  nanoGenInput,
} from '../../server/utils/inpaintFalInputs'

describe('removeBgInput', () => {
  it('builds the fal-ai/birefnet/v2 payload', () => {
    expect(removeBgInput('data:image/png;base64,AAA')).toEqual({
      image_url: 'data:image/png;base64,AAA',
      model: 'General Use (Light)',
      operating_resolution: '2048x2048',
      output_format: 'png',
      refine_foreground: true,
    })
  })
})

describe('kontextInput', () => {
  it('builds the fal-ai/flux-kontext/dev payload', () => {
    expect(kontextInput('make the sky a sunset', 'data:image/png;base64,AAA', 42)).toEqual({
      prompt: 'make the sky a sunset',
      image_url: 'data:image/png;base64,AAA',
      seed: 42,
      num_images: 1,
      output_format: 'png',
      resolution_mode: 'match_input',
    })
  })
})

describe('text2imgInput', () => {
  it('flux-schnell: fal-ai/flux/schnell with 4-step distillation', () => {
    expect(text2imgInput('flux-schnell', 'a red apple', '1:1', 7)).toEqual({
      app: 'fal-ai/flux/schnell',
      input: {
        prompt: 'a red apple',
        image_size: 'square_hd',
        num_inference_steps: 4,
        seed: 7,
        num_images: 1,
        output_format: 'png',
      },
    })
  })

  it('flux-dev: fal-ai/flux/dev with 28 steps and guidance_scale 3', () => {
    expect(text2imgInput('flux-dev', 'a red apple', '16:9', 7)).toEqual({
      app: 'fal-ai/flux/dev',
      input: {
        prompt: 'a red apple',
        image_size: 'landscape_16_9',
        num_inference_steps: 28,
        guidance_scale: 3,
        seed: 7,
        num_images: 1,
        output_format: 'png',
      },
    })
  })

  it('seedream-4.5: fal-ai/bytedance/seedream/v4.5/text-to-image with a 3200 long side, no output_format', () => {
    expect(text2imgInput('seedream-4.5', 'a red apple', '16:9', 7)).toEqual({
      app: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
      input: {
        prompt: 'a red apple',
        image_size: { width: 3200, height: 1808 },
        seed: 7,
        num_images: 1,
      },
    })
  })

  it('flux-2-pro: fal-ai/flux-2-pro with NO num_images', () => {
    const call = text2imgInput('flux-2-pro', 'a red apple', '1:1', 7)
    expect(call).toEqual({
      app: 'fal-ai/flux-2-pro',
      input: {
        prompt: 'a red apple',
        image_size: 'square_hd',
        seed: 7,
        output_format: 'png',
      },
    })
    expect(call.input).not.toHaveProperty('num_images')
  })

  it('falls back to flux-schnell for an unknown tier', () => {
    expect(text2imgInput('nonsense', 'a red apple', '1:1', 7).app).toBe('fal-ai/flux/schnell')
  })
})

describe('poseInput', () => {
  it('builds the fal-ai/nano-banana-2/edit payload', () => {
    expect(poseInput('redraw the character in the pose', 'data:image/png;base64,CHAR', 'data:image/png;base64,POSE')).toEqual({
      prompt: 'redraw the character in the pose',
      image_urls: ['data:image/png;base64,CHAR', 'data:image/png;base64,POSE'],
      num_images: 1,
      resolution: '1K',
      output_format: 'png',
    })
  })
})

describe('fluxFillDevInput', () => {
  it('builds the fal-ai/flux-lora/inpainting payload with strength 1', () => {
    expect(fluxFillDevInput('a red apple', 'data:image/png;base64,IMG', 'data:image/png;base64,MASK', 3, 30, 28)).toEqual({
      prompt: 'a red apple',
      image_url: 'data:image/png;base64,IMG',
      mask_url: 'data:image/png;base64,MASK',
      num_inference_steps: 28,
      guidance_scale: 3.75,
      strength: 1,
      seed: 3,
      num_images: 1,
      output_format: 'png',
    })
  })

  it('maps the 30-scale Replicate guidance down to fal CFG: 30 -> 3.75', () => {
    expect(fluxFillDevInput('', 'i', 'm', 0, 30, 28).guidance_scale).toBe(3.75)
  })
  it('never sends fal an empty prompt — the Remove button and outpaint-fit send one', () => {
    expect(fluxFillDevInput('', 'i', 'm', 0, 30, 28).prompt).toBe(FAL_FILL_REMOVE_PROMPT)
    expect(fluxFillDevInput('   ', 'i', 'm', 0, 30, 28).prompt).toBe(FAL_FILL_REMOVE_PROMPT)
    expect(fluxFillDevInput('a red apple', 'i', 'm', 0, 30, 28).prompt).toBe('a red apple')
  })

  it('clamps a high guidance to fal\'s max of 10: 80 -> 10', () => {
    expect(fluxFillDevInput('', 'i', 'm', 0, 80, 28).guidance_scale).toBe(10)
  })

  it('clamps a low guidance to fal\'s min of 1', () => {
    expect(fluxFillDevInput('', 'i', 'm', 0, 4, 28).guidance_scale).toBe(1)
  })
})

describe('nanoGenInput', () => {
  it('text-to-image (no images): fal-ai/nano-banana-pro', () => {
    expect(nanoGenInput('a red apple', [])).toEqual({
      app: 'fal-ai/nano-banana-pro',
      input: { prompt: 'a red apple', num_images: 1, output_format: 'png' },
    })
  })

  it('with images: fal-ai/nano-banana-pro/edit and image_urls', () => {
    expect(nanoGenInput('put it in the scene', ['data:image/png;base64,A'])).toEqual({
      app: 'fal-ai/nano-banana-pro/edit',
      input: { prompt: 'put it in the scene', num_images: 1, output_format: 'png', image_urls: ['data:image/png;base64,A'] },
    })
  })

  it('passes aspect_ratio through when given', () => {
    expect(nanoGenInput('a red apple', [], '16:9')).toEqual({
      app: 'fal-ai/nano-banana-pro',
      input: { prompt: 'a red apple', num_images: 1, output_format: 'png', aspect_ratio: '16:9' },
    })
  })
})
