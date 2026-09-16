import { describe, expect, it } from 'vitest'
import { RESTYLE_MODELS } from '~/data/scene3d-restyle-models'
import { restyleInput, restyleGuidanceScale } from '../../server/utils/restyleFalInputs'

const DEPTH_MODEL = RESTYLE_MODELS.find((m) => m.control === 'depth')!
const IMAGE_MODEL = RESTYLE_MODELS.find((m) => m.control === 'image')!

const BEAUTY = 'data:image/png;base64,BEAUTY'
const DEPTH = 'data:image/png;base64,DEPTH'

describe('restyleInput (pure fal payload builder)', () => {
  it('depth control → control_image_url = depth crop, mapped strength + guidance_scale', () => {
    const call = restyleInput(DEPTH_MODEL, 'a bronze statue', BEAUTY, DEPTH, 0.6, 42)
    expect(call).toEqual({
      app: 'fal-ai/flux-control-lora-depth',
      input: {
        prompt: 'a bronze statue',
        control_image_url: DEPTH,
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
    expect(call.input).not.toHaveProperty('control_image_url')
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
