import { falImageSize } from './falImageSize'

export interface LoraGenOpts {
  prompt: string
  aspectRatio?: string
  loraScale?: number
  guidanceScale?: number
  seed?: number
}

/**
 * fal `fal-ai/flux-lora` input for trained-style sample generation. The trained
 * weights ride in `loras[0].path` — a fal-storage URL for the safetensors that
 * loraFalWeights.ts lifts out of the Replicate training tar once per LoRA.
 *
 * Same knobs as the Replicate builder below (22 steps, guidance 3.5, one PNG,
 * seed only when finite); the shape is fal's.
 */
export function buildFalLoraGenInput(
  prompt: string,
  opts: Omit<LoraGenOpts, 'prompt'>,
  weightsUrl: string,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    prompt,
    image_size: falImageSize(opts.aspectRatio),
    num_inference_steps: 22,
    guidance_scale: Number.isFinite(opts.guidanceScale) ? opts.guidanceScale : 3.5,
    num_images: 1,
    output_format: 'png',
    loras: [{ path: weightsUrl, scale: Number.isFinite(opts.loraScale) ? opts.loraScale : 1 }],
  }
  if (Number.isFinite(opts.seed)) input.seed = opts.seed
  return input
}

/** Replicate input for trained-style sample generation (lora-gen endpoint). */
export function buildLoraGenInput(opts: {
  prompt: string
  aspectRatio?: string
  loraScale?: number
  guidanceScale?: number
  seed?: number
}): Record<string, unknown> {
  const input: Record<string, unknown> = {
    prompt: opts.prompt,
    aspect_ratio: opts.aspectRatio || '1:1',
    megapixels: '1',
    num_inference_steps: 22,
    guidance_scale: Number.isFinite(opts.guidanceScale) ? opts.guidanceScale : 3.5,
    num_outputs: 1,
    output_format: 'png',
    lora_scale: Number.isFinite(opts.loraScale) ? opts.loraScale : 1,
  }
  if (Number.isFinite(opts.seed)) input.seed = opts.seed
  return input
}
