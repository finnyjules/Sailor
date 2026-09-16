import { describe, expect, it } from 'vitest'
import { RESTYLE_MODELS } from '~/data/scene3d-restyle-models'
import {
  restyleInput, restyleGuidanceScale,
  FLUX_DEPTH_CONTROLNET_PATH, FLUX_IP_ADAPTER_PATH, FLUX_IP_ADAPTER_ENCODER, FLUX_IP_ADAPTER_WEIGHT,
  RESTYLE_DEPTH_CONDITIONING_SCALE, RESTYLE_IP_ADAPTER_SCALE,
} from '../../server/utils/restyleFalInputs'

const DEPTH_MODEL = RESTYLE_MODELS.find((m) => m.control === 'depth')!
const IMAGE_MODEL = RESTYLE_MODELS.find((m) => m.control === 'image')!
const STYLE_MODEL = RESTYLE_MODELS.find((m) => m.control === 'depth+style')!

const BEAUTY = 'data:image/png;base64,BEAUTY'
const DEPTH = 'data:image/png;base64,DEPTH'

describe('restyleInput (pure fal payload builder)', () => {
  it('depth control → control_lora_image_url = depth crop, mapped strength + guidance_scale', () => {
    const call = restyleInput(DEPTH_MODEL, 'a bronze statue', BEAUTY, DEPTH, 0.6, 42)
    expect(call).toEqual({
      app: 'fal-ai/flux-control-lora-depth',
      input: {
        prompt: 'a bronze statue',
        // The exact field the model requires — verified against a live 422 (a wrong
        // control_image_url is silently ignored and the request fails validation).
        control_lora_image_url: DEPTH,
        image_size: 'square_hd',
        strength: 0.6,
        guidance_scale: 7.4, // 3.5 + 0.6 * 6.5
        num_images: 1,
        output_format: 'png',
        seed: 42,
      },
    })
    // The depth model must NOT send a beauty image_url (it takes the control image only).
    expect(call.input).not.toHaveProperty('image_url')
  })

  it('image control → image_url = beauty crop, strength passed straight through (no guidance)', () => {
    const call = restyleInput(IMAGE_MODEL, 'a bronze statue', BEAUTY, DEPTH, 0.6, 42)
    expect(call).toEqual({
      app: 'fal-ai/flux/dev/image-to-image',
      input: {
        prompt: 'a bronze statue',
        image_url: BEAUTY,
        strength: 0.6,
        image_size: 'square_hd',
        num_images: 1,
        output_format: 'png',
        seed: 42,
      },
    })
    // The img2img model takes no control image and no guidance_scale.
    expect(call.input).not.toHaveProperty('control_lora_image_url')
    expect(call.input).not.toHaveProperty('guidance_scale')
  })

  it('pins the exact fal enum strings (fal-enum-mismatch-silent-fallover guard)', () => {
    for (const m of RESTYLE_MODELS) {
      const call = restyleInput(m, 'x', BEAUTY, DEPTH, 0.5, 1)
      expect(call.input.image_size).toBe('square_hd')
      expect(call.input.output_format).toBe('png')
      expect(call.input.num_images).toBe(1)
    }
  })

  it('the app slug is exactly the model id (dispatch allowlist tie)', () => {
    for (const m of RESTYLE_MODELS) {
      expect(restyleInput(m, 'x', BEAUTY, DEPTH, 0.5, 1).app).toBe(m.id)
    }
  })

  it('clamps strength to 0..1 in both modes', () => {
    expect(restyleInput(DEPTH_MODEL, 'x', BEAUTY, DEPTH, 5, 1).input.strength).toBe(1)
    expect(restyleInput(DEPTH_MODEL, 'x', BEAUTY, DEPTH, -3, 1).input.strength).toBe(0)
    expect(restyleInput(IMAGE_MODEL, 'x', BEAUTY, DEPTH, 5, 1).input.strength).toBe(1)
    expect(restyleInput(IMAGE_MODEL, 'x', BEAUTY, DEPTH, -3, 1).input.strength).toBe(0)
  })

  it('restyleGuidanceScale maps 0..1 → 3.5..10 (2-dp), clamped', () => {
    expect(restyleGuidanceScale(0)).toBe(3.5)
    expect(restyleGuidanceScale(1)).toBe(10)
    expect(restyleGuidanceScale(0.6)).toBe(7.4)
    expect(restyleGuidanceScale(2)).toBe(10)
    expect(restyleGuidanceScale(-1)).toBe(3.5)
  })
})

const REF_A = 'data:image/png;base64,REFA'
const REF_B = 'data:image/png;base64,REFB'

describe('restyleInput — depth+style (fal-ai/flux-general)', () => {
  it('emits controlnets[depth] + one ip_adapter per ref + the prompt with styleText folded in', () => {
    const call = restyleInput(STYLE_MODEL, 'a bronze statue', BEAUTY, DEPTH, 0.6, 42, [REF_A, REF_B], 'In the style of: warm.')
    expect(call).toEqual({
      app: 'fal-ai/flux-general',
      input: {
        prompt: 'a bronze statue. In the style of: warm.',
        controlnets: [{
          path: FLUX_DEPTH_CONTROLNET_PATH,
          control_image_url: DEPTH, // our crop is already a depth map — passed directly, no preprocess
          conditioning_scale: RESTYLE_DEPTH_CONDITIONING_SCALE,
        }],
        ip_adapters: [
          { path: FLUX_IP_ADAPTER_PATH, image_url: REF_A, scale: RESTYLE_IP_ADAPTER_SCALE, image_encoder_path: FLUX_IP_ADAPTER_ENCODER, weight_name: FLUX_IP_ADAPTER_WEIGHT },
          { path: FLUX_IP_ADAPTER_PATH, image_url: REF_B, scale: RESTYLE_IP_ADAPTER_SCALE, image_encoder_path: FLUX_IP_ADAPTER_ENCODER, weight_name: FLUX_IP_ADAPTER_WEIGHT },
        ],
        image_size: 'square_hd',
        num_inference_steps: 28,
        num_images: 1,
        output_format: 'png',
        seed: 42,
      },
    })
  })

  it('caps ip_adapters at MOODBOARD_MAX_REFS (3)', () => {
    const refs = ['a', 'b', 'c', 'd', 'e'].map((x) => `data:image/png;base64,${x}`)
    const call = restyleInput(STYLE_MODEL, 'p', BEAUTY, DEPTH, 0.6, 1, refs, '')
    expect(call.input.ip_adapters).toHaveLength(3)
  })

  it('pins the exact fal enum/repo strings (fal-enum-mismatch-silent-fallover guard)', () => {
    const call = restyleInput(STYLE_MODEL, 'p', BEAUTY, DEPTH, 0.6, 1, [REF_A], '')
    expect(call.input.image_size).toBe('square_hd')
    expect(call.input.output_format).toBe('png')
    expect(call.input.num_inference_steps).toBe(28)
    expect(FLUX_DEPTH_CONTROLNET_PATH).toBe('XLabs-AI/flux-controlnet-depth-v3')
    expect(FLUX_IP_ADAPTER_PATH).toBe('XLabs-AI/flux-ip-adapter')
    expect(FLUX_IP_ADAPTER_ENCODER).toBe('openai/clip-vit-large-patch14')
    expect(FLUX_IP_ADAPTER_WEIGHT).toBe('ip_adapter.safetensors')
  })

  it('styleText folds into the prompt for the depth path too (empty-board text-only nudge)', () => {
    const call = restyleInput(DEPTH_MODEL, 'a bronze statue', BEAUTY, DEPTH, 0.6, 1, [], 'In the style of: warm.')
    expect(call.input.prompt).toBe('a bronze statue. In the style of: warm.')
    expect(call.input).not.toHaveProperty('ip_adapters') // no refs ⇒ still the depth-only payload
  })
})
