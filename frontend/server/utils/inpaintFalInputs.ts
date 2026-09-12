/**
 * Pure fal payload builders for the inpaint/* routes (Task A of the fal
 * default-provider migration — docs/superpowers/plans/2026-09-11-fal-default-provider.md).
 * No h3 imports: these only shape request bodies so
 * tests/unit/inpaint-fal-inputs.unit.spec.ts can pin the exact objects sent
 * to each fal app without spinning up a Nitro event.
 */
import { falImageSize } from './falImageSize'
import { falFillPrompt } from './falFill'

export interface FalCall {
  app: string
  input: Record<string, unknown>
}

/** fal-ai/birefnet/v2 — background removal. Output: `out.image.url`. */
export function removeBgInput(image: string): Record<string, unknown> {
  return {
    image_url: image,
    model: 'General Use (Light)',
    operating_resolution: '2048x2048',
    output_format: 'png',
    refine_foreground: true,
  }
}

/** fal-ai/flux-kontext/dev — mask-free instruction editing. Output: `out.images[0].url`. */
export function kontextInput(prompt: string, image: string, seed: number): Record<string, unknown> {
  return {
    prompt,
    image_url: image,
    seed,
    num_images: 1,
    output_format: 'png',
    resolution_mode: 'match_input',
  }
}

export type Text2ImgTier = 'flux-schnell' | 'flux-dev' | 'seedream-4.5' | 'flux-2-pro'

/**
 * Text-to-image tier table. flux-2-pro deliberately omits `num_images` — it
 * doesn't accept the field (422s if sent). seedream-4.5 wants its long side
 * at 3200 (fal requires ≥1920 both sides or ≥2560×1440 total) and, per fal's
 * schema, takes no `output_format`.
 */
export function text2imgInput(tier: string, prompt: string, aspect: string, seed: number): FalCall {
  switch (tier as Text2ImgTier) {
    case 'flux-dev':
      return {
        app: 'fal-ai/flux/dev',
        input: {
          prompt,
          image_size: falImageSize(aspect),
          num_inference_steps: 28,
          guidance_scale: 3,
          seed,
          num_images: 1,
          output_format: 'png',
        },
      }
    case 'seedream-4.5':
      return {
        app: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
        input: {
          prompt,
          image_size: falImageSize(aspect, 3200),
          seed,
          num_images: 1,
        },
      }
    case 'flux-2-pro':
      return {
        app: 'fal-ai/flux-2-pro',
        input: {
          prompt,
          image_size: falImageSize(aspect),
          seed,
          output_format: 'png',
        },
      }
    case 'flux-schnell':
    default:
      return {
        app: 'fal-ai/flux/schnell',
        input: {
          prompt,
          image_size: falImageSize(aspect),
          num_inference_steps: 4,
          seed,
          num_images: 1,
          output_format: 'png',
        },
      }
  }
}

/** fal-ai/nano-banana-2/edit — character + mannequin-pose composite. Output: `out.images[i].url`. */
export function poseInput(prompt: string, character: string, pose: string): Record<string, unknown> {
  return {
    prompt,
    image_urls: [character, pose],
    num_images: 1,
    resolution: '1K',
    output_format: 'png',
  }
}

/**
 * fal-ai/flux-lora/inpainting — FLUX Fill dev tier. Output: `out.images[0].url`.
 *
 * `guidance` arrives on the Replicate-era 30-scale distilled-guidance knob
 * (flux-fill-dev's default was 30); fal's `guidance_scale` is an ordinary CFG
 * value (fal default 3.5, sane range ~1-10). Map linearly (÷8) and clamp to
 * fal's range: 30 → 3.75, 80 → 10 (clamped from 10 exactly).
 */
export function fluxFillDevInput(
  prompt: string,
  image: string,
  mask: string,
  seed: number,
  guidance: number,
  steps: number,
): Record<string, unknown> {
  const guidance_scale = Math.max(1, Math.min(10, guidance / 8))
  return {
    // fal 400s on an empty prompt ("Prompt is required") where Replicate's fill-dev
    // tolerated it, and the Remove button / outpaint-fit send '' at this tier — the pro
    // tier already routes through falFillPrompt for exactly this reason.
    prompt: falFillPrompt(prompt),
    image_url: image,
    mask_url: mask,
    num_inference_steps: steps,
    guidance_scale,
    strength: 1,
    seed,
    num_images: 1,
    output_format: 'png',
  }
}

/**
 * fal-ai/nano-banana-pro (+ /edit) — Nano Banana Pro generate/edit. Mirrors
 * the pre-existing fal-failover input construction now that fal is the only
 * path. Output: `out.images[0].url`.
 */
export function nanoGenInput(prompt: string, images: string[], aspectRatio?: string, variant?: string): FalCall {
  // 'nano2' → Nano Banana 2 (Gemini 3.1 Flash, faster/cheaper); default → Nano Banana Pro.
  const family = variant === 'nano2' ? 'nano-banana-2' : 'nano-banana-pro'
  const app = images.length ? `fal-ai/${family}/edit` : `fal-ai/${family}`
  const input: Record<string, unknown> = { prompt, num_images: 1, output_format: 'png' }
  if (images.length) input.image_urls = images
  if (aspectRatio) input.aspect_ratio = aspectRatio
  return { app, input }
}
