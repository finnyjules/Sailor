/**
 * The runner's image models — one description each. Request builders are
 * ports of the fal builders in comfy_api_nodes/image_models.py and must
 * produce identical payloads (tests/unit/runner-image-models.unit.spec.ts
 * compares against fixtures generated from Python). Reference-picture
 * endpoints are Sailor's own: Python only ever sent moodboard pictures to
 * Replicate.
 */
import { RUNNER_IMAGE_MODEL_IDS } from '#shared/runner/eligibility'
import { arOr, maybeSetSeed, optBool, optInt, optStr } from './opts'
import type { ImageBuildArgs, ImageModelDesc } from './types'

const NANO_BANANA_AR = new Set(['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'])
const NANO_BANANA_PRO_AR = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])

const FAL_IMAGE_SIZE_BY_AR: Record<string, string> = {
  '1:1': 'square_hd',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '3:2': 'landscape_4_3',
  '5:4': 'landscape_4_3',
  '16:10': 'landscape_16_9',
  '21:9': 'landscape_16_9',
  '2:1': 'landscape_16_9',
  '2:3': 'portrait_4_3',
  '4:5': 'portrait_4_3',
  '10:16': 'portrait_16_9',
  '9:21': 'portrait_16_9',
  '1:2': 'portrait_16_9',
}

export function falImageSize(ar: string): string {
  return FAL_IMAGE_SIZE_BY_AR[ar] ?? 'square_hd'
}

function falOutputFormat(adv: Record<string, unknown>, def = 'png'): string {
  const v = optStr(adv, 'output_format', def)
  return v === 'jpg' ? 'jpeg' : v
}

function withRefs(inp: Record<string, unknown>, refs: string[] | null): Record<string, unknown> {
  if (refs?.length) inp.image_urls = [...refs]
  return inp
}

function fluxProV11({ prompt, aspectRatio, seed, adv }: ImageBuildArgs) {
  const tol = Math.min(6, Math.max(1, optInt(adv, 'safety_tolerance', 2)))
  const inp: Record<string, unknown> = {
    prompt,
    image_size: falImageSize(aspectRatio),
    num_images: 1,
    output_format: optStr(adv, 'output_format', 'png'),
    safety_tolerance: String(tol),
  }
  maybeSetSeed(inp, seed)
  return inp
}

function fluxSchnell({ prompt, aspectRatio, seed, adv }: ImageBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    image_size: falImageSize(aspectRatio),
    num_inference_steps: optInt(adv, 'num_inference_steps', 4),
    num_images: Math.max(1, Math.min(4, optInt(adv, 'num_outputs', 1))),
    output_format: optStr(adv, 'output_format', 'png'),
  }
  maybeSetSeed(inp, seed)
  return inp
}

const FAL_IDEOGRAM_STYLE: Record<string, string> = { Auto: 'AUTO', General: 'GENERAL', Realistic: 'REALISTIC', Design: 'DESIGN' }

function ideogramV3(renderingSpeed: 'QUALITY' | 'BALANCED' | 'TURBO') {
  return ({ prompt, aspectRatio, seed, adv }: ImageBuildArgs) => {
    const inp: Record<string, unknown> = {
      prompt,
      image_size: falImageSize(aspectRatio),
      rendering_speed: renderingSpeed,
      num_images: 1,
      expand_prompt: optStr(adv, 'magic_prompt', 'Auto').toLowerCase() !== 'off',
    }
    const style = optStr(adv, 'style_type', 'None')
    if (style in FAL_IDEOGRAM_STYLE) inp.style = FAL_IDEOGRAM_STYLE[style]
    maybeSetSeed(inp, seed)
    return inp
  }
}

function nanoBanana2({ prompt, aspectRatio, seed, adv, refs }: ImageBuildArgs) {
  let res = optStr(adv, 'resolution', '1K')
  if (!['0.5K', '1K', '2K', '4K'].includes(res)) res = '1K'
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(NANO_BANANA_AR, aspectRatio, '1:1'),
    resolution: res,
    num_images: 1,
    output_format: falOutputFormat(adv),
  }
  // The edit endpoint (pictures) has no web-search switch.
  if (!refs?.length) inp.enable_web_search = optBool(adv, 'google_search', false)
  maybeSetSeed(inp, seed)
  return withRefs(inp, refs)
}

function nanoBananaPro({ prompt, aspectRatio, seed, adv, refs }: ImageBuildArgs) {
  let res = optStr(adv, 'resolution', '2K')
  if (!['1K', '2K', '4K'].includes(res)) res = '2K'
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(NANO_BANANA_PRO_AR, aspectRatio, '1:1'),
    resolution: res,
    num_images: 1,
    output_format: falOutputFormat(adv),
  }
  maybeSetSeed(inp, seed)
  return withRefs(inp, refs)
}

function seedream5Lite({ prompt, aspectRatio, adv, refs }: ImageBuildArgs) {
  // No seed parameter on this endpoint (text or edit).
  const inp: Record<string, unknown> = {
    prompt,
    image_size: falImageSize(aspectRatio),
    num_images: 1,
    max_images: 1,
  }
  if (optStr(adv, 'sequential_image_generation', 'disabled') === 'auto') {
    inp.max_images = Math.max(1, Math.min(6, optInt(adv, 'max_images', 1)))
  }
  return withRefs(inp, refs)
}

function seedreamV4({ prompt, aspectRatio, seed, refs }: ImageBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    image_size: falImageSize(aspectRatio),
    num_images: 1,
    max_images: 1,
  }
  maybeSetSeed(inp, seed)
  return withRefs(inp, refs)
}

const D = (id: string, label: string, app: string, refsApp: string | null, build: ImageModelDesc['build']): ImageModelDesc =>
  ({ id, label, app, refsApp, build })

export const RUNNER_IMAGE_MODELS: Record<string, ImageModelDesc> = {
  'flux-1.1-pro': D('flux-1.1-pro', 'Flux 1.1 Pro', 'fal-ai/flux-pro/v1.1', null, fluxProV11),
  'flux-schnell': D('flux-schnell', 'Flux Schnell', 'fal-ai/flux/schnell', null, fluxSchnell),
  'nano-banana-pro': D('nano-banana-pro', 'Nano Banana Pro', 'google/nano-banana-pro', 'fal-ai/nano-banana-pro/edit', nanoBananaPro),
  'nano-banana-2': D('nano-banana-2', 'Nano Banana 2', 'fal-ai/nano-banana-2', 'fal-ai/nano-banana-2/edit', nanoBanana2),
  'ideogram-v3-quality': D('ideogram-v3-quality', 'Ideogram V3 Quality', 'fal-ai/ideogram/v3', null, ideogramV3('QUALITY')),
  'ideogram-v3-balanced': D('ideogram-v3-balanced', 'Ideogram V3 Balanced', 'fal-ai/ideogram/v3', null, ideogramV3('BALANCED')),
  'ideogram-v3-turbo': D('ideogram-v3-turbo', 'Ideogram V3 Turbo', 'fal-ai/ideogram/v3', null, ideogramV3('TURBO')),
  'seedream-5-lite': D('seedream-5-lite', 'Seedream 5 Lite', 'fal-ai/bytedance/seedream/v5/lite/text-to-image', 'fal-ai/bytedance/seedream/v5/lite/edit', seedream5Lite),
  'seedream-4': D('seedream-4', 'Seedream 4', 'fal-ai/bytedance/seedream/v4/text-to-image', 'fal-ai/bytedance/seedream/v4/edit', seedreamV4),
}

// Fail at import if the shared list and this table ever disagree.
for (const id of RUNNER_IMAGE_MODEL_IDS) {
  if (!RUNNER_IMAGE_MODELS[id]) throw new Error(`runner image model ${id} has no description`)
}

export function imageAppFor(desc: ImageModelDesc, refs: string[] | null): string {
  return refs?.length && desc.refsApp ? desc.refsApp : desc.app
}

export const STYLE_REFS_INSTRUCTION
  = 'Use the attached reference images strictly as STYLE references — match '
  + 'their palette, light, grain and mood; do not copy their subjects or '
  + 'composition.'

/** GenerateImageNode.execute's prompt order: style_in · style_block · prompt_in · prompt, then the style-only instruction when pictures ride along. */
export function composeImagePrompt(i: { prompt: string, promptIn?: string, styleBlock?: string, styleIn?: string, hasRefs: boolean }): string {
  let prompt = i.prompt
  const promptIn = (i.promptIn ?? '').trim()
  if (promptIn) prompt = prompt.trim() ? `${promptIn} ${prompt}` : promptIn
  const styleBlock = (i.styleBlock ?? '').trim()
  if (styleBlock) prompt = `${styleBlock} ${prompt}`
  const styleIn = (i.styleIn ?? '').trim()
  if (styleIn) prompt = `${styleIn} ${prompt}`.trim()
  if (i.hasRefs) prompt = `${prompt} ${STYLE_REFS_INSTRUCTION}`.trim()
  return prompt
}
