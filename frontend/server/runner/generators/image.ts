/**
 * The runner's image models — one description each. Request builders began
 * as ports of the fal builders in comfy_api_nodes/image_models.py
 * (tests/unit/runner-image-models.unit.spec.ts compares against fixtures
 * generated from Python). Reference-picture endpoints are Sailor's own:
 * Python only ever sent moodboard pictures to Replicate. The Replicate table
 * (family `replicate-image`) ports the Replicate builders
 * (tests/unit/runner-replicate-image.unit.spec.ts).
 *
 * Since Task S1b the builders follow each provider's published schema, not
 * Python (tests/unit/runner-provider-schemas.unit.spec.ts): no field the
 * schema doesn't define (a seed where there is none), and no value outside
 * it (an option outside its list falls back to the default; a number
 * outside its range is clamped). The Python path is legacy and unchanged.
 */
import { RUNNER_IMAGE_MODEL_IDS, RUNNER_REPLICATE_IMAGE_MODEL_IDS } from '#shared/runner/eligibility'
import { FLUX_2_RESOLUTIONS, FLUX_KLEIN_MEGAPIXELS, flux2DevSize } from '#shared/pricing/imageSettings'
import { arOr, maybeSetSeed, optBool, optEnum, optFloat, optFloatIn, optInt, optIntIn, optStr, outputFormatIn } from './opts'
import type { ImageBuildArgs, ImageModelDesc, ReplicateImageModelDesc } from './types'

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

/** Nano Banana on fal: jpeg, png or webp ("jpg" is jpeg); anything else png. */
function falOutputFormat(adv: Record<string, unknown>, def = 'png'): string {
  return outputFormatIn(adv, ['jpeg', 'png', 'webp'], def)
}

/** fal-ai/flux-pro/v1.1 and fal-ai/flux/schnell: jpeg or png only ("jpg" is jpeg; webp and anything else png). */
export const FAL_FLUX_OUTPUT_FORMATS = ['jpeg', 'png']

function withRefs(inp: Record<string, unknown>, refs: string[] | null): Record<string, unknown> {
  if (refs?.length) inp.image_urls = [...refs]
  return inp
}

function fluxProV11({ prompt, aspectRatio, seed, adv }: ImageBuildArgs) {
  const tol = optIntIn(adv, 'safety_tolerance', 2, 1, 6)
  const inp: Record<string, unknown> = {
    prompt,
    image_size: falImageSize(aspectRatio),
    num_images: 1,
    output_format: outputFormatIn(adv, FAL_FLUX_OUTPUT_FORMATS, 'png'),
    safety_tolerance: String(tol),
  }
  maybeSetSeed(inp, seed)
  return inp
}

function fluxSchnell({ prompt, aspectRatio, seed, adv }: ImageBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    image_size: falImageSize(aspectRatio),
    num_inference_steps: optIntIn(adv, 'num_inference_steps', 4, 1, 12),
    num_images: optIntIn(adv, 'num_outputs', 1, 1, 4),
    output_format: outputFormatIn(adv, FAL_FLUX_OUTPUT_FORMATS, 'png'),
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
    inp.max_images = optIntIn(adv, 'max_images', 1, 1, 6)
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
  // fal-ai/nano-banana-pro, fal's documented text-to-image app ($0.15 an image);
  // google/nano-banana-pro, the same model under Google's name, publishes no price.
  'nano-banana-pro': D('nano-banana-pro', 'Nano Banana Pro', 'fal-ai/nano-banana-pro', 'fal-ai/nano-banana-pro/edit', nanoBananaPro),
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

// ── Replicate (family `replicate-image`) ──────────────────────────────────
// Ports of the Replicate build_input of every image_models.py model whose
// primary is Replicate (the default), priced, and not an SVG model (decision
// D4). The flux-2-* models go to Replicate, their Python primary, not their
// fal twin (D5). None is 'multi-image', so moodboard pictures are ignored, as
// Python's _accepts_refs ignores them.

const FLUX_PRO_AR = new Set(['1:1', '16:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16'])
const FLUX_DEV_AR = new Set(['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16', '9:21'])
const FLUX_2_AR = new Set(['1:1', '16:9', '3:2', '2:3', '4:5', '5:4', '9:16', '3:4', '4:3'])
const FLUX_KLEIN_AR = new Set(['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '21:9', '9:21'])
const FLUX_ULTRA_AR = new Set(['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '9:21'])
const IDEOGRAM_V2_AR = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '16:10', '10:16', '3:1', '1:3'])
const GOOGLE_AR = new Set(['1:1', '16:9', '9:16', '4:3', '3:4'])
const SEEDREAM_AR = new Set(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'])
const RECRAFT_AR = new Set(['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '4:5', '5:4', '1:2', '2:1'])
const SD35_AR = new Set(['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '9:16', '9:21'])
const PHOTON_AR = new Set(['1:1', '3:4', '4:3', '9:16', '16:9', '9:21', '21:9'])
const BRIA_AR = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'])
const MINIMAX_AR = new Set(['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'])
const QWEN_AR = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'])
const OPENAI_AR = new Set(['1:1', '3:2', '2:3'])
const HUNYUAN_AR = new Set(['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16', '9:21'])
const GROK_AR = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2'])
const WAN22_AR = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'])
const PIMAGE_AR = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'])

/**
 * Every ratio set above, by its name in image_models.py. A guard test
 * (runner-image-options.unit.spec.ts) parses the Python file and checks each
 * one is the same, so a ratio added in Python can't be missed here.
 */
export const IMAGE_RATIO_SETS: Readonly<Record<string, ReadonlySet<string>>> = {
  _NANO_BANANA_AR: NANO_BANANA_AR, _NANO_BANANA_PRO_AR: NANO_BANANA_PRO_AR,
  _FLUX_PRO_AR: FLUX_PRO_AR, _FLUX_DEV_AR: FLUX_DEV_AR, _FLUX_2_AR: FLUX_2_AR, _FLUX_KLEIN_AR: FLUX_KLEIN_AR,
  _FLUX_ULTRA_AR: FLUX_ULTRA_AR, _IDEOGRAM_V2_AR: IDEOGRAM_V2_AR, _GOOGLE_AR: GOOGLE_AR, _SEEDREAM_AR: SEEDREAM_AR,
  _RECRAFT_AR: RECRAFT_AR, _SD35_AR: SD35_AR, _PHOTON_AR: PHOTON_AR, _BRIA_AR: BRIA_AR, _MINIMAX_AR: MINIMAX_AR,
  _QWEN_AR: QWEN_AR, _OPENAI_AR: OPENAI_AR, _HUNYUAN_AR: HUNYUAN_AR, _GROK_AR: GROK_AR, _WAN22_AR: WAN22_AR,
  _PIMAGE_AR: PIMAGE_AR,
}

type Builder = (a: ImageBuildArgs) => Record<string, unknown>

/** Every Python builder ends with _maybe_set_seed; the runner's only where the model's schema has a seed. */
const seeded = (build: (a: ImageBuildArgs) => Record<string, unknown>): Builder => (a) => {
  const inp = build(a)
  maybeSetSeed(inp, a.seed)
  return inp
}
/** The schema has no seed (Python sends one anyway). */
const unseeded = (build: (a: ImageBuildArgs) => Record<string, unknown>): Builder => build

/** Replicate's BFL / Stability / Qwen / Hunyuan output formats. */
const WEBP_JPG_PNG = ['webp', 'jpg', 'png']
const JPG_PNG = ['jpg', 'png']

/** `negp = _opt_str(adv, "negative_prompt", ""); if negp: inp["negative_prompt"] = negp` */
function withNegative(inp: Record<string, unknown>, adv: Record<string, unknown>): Record<string, unknown> {
  const negp = optStr(adv, 'negative_prompt', '')
  if (negp) inp.negative_prompt = negp
  return inp
}

const rFluxUltra = seeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(FLUX_ULTRA_AR, aspectRatio, '1:1'),
  raw: optBool(adv, 'raw', false),
  safety_tolerance: optIntIn(adv, 'safety_tolerance', 2, 1, 6),
  output_format: outputFormatIn(adv, JPG_PNG, 'jpg'),
}))

const rFluxPro = seeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(FLUX_PRO_AR, aspectRatio, '1:1'),
  guidance: optFloatIn(adv, 'guidance', 3.0, 2, 5),
  safety_tolerance: optIntIn(adv, 'safety_tolerance', 2, 1, 6),
  prompt_upsampling: optBool(adv, 'prompt_upsampling', false),
  output_format: outputFormatIn(adv, WEBP_JPG_PNG, 'png'),
}))

const rFluxDev = seeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(FLUX_DEV_AR, aspectRatio, '1:1'),
  num_inference_steps: optIntIn(adv, 'num_inference_steps', 28, 1, 50),
  guidance: optFloatIn(adv, 'guidance', 3.5, 0, 10),
  megapixels: optEnum(adv, 'megapixels', ['1', '0.25'], '1'),
  go_fast: optBool(adv, 'go_fast', true),
  num_outputs: optIntIn(adv, 'num_outputs', 1, 1, 4),
  output_format: outputFormatIn(adv, WEBP_JPG_PNG, 'png'),
  output_quality: 95,
}))

/** A Flux 2 megapixel label the schema lists ("0.5 MP" … "4 MP"); anything else "1 MP". */
const flux2Resolution = (adv: Record<string, unknown>) => optEnum(adv, 'resolution', FLUX_2_RESOLUTIONS, '1 MP')

/** _b_flux_2_max and _b_flux_2_pro (identical). */
const rFlux2Basic = seeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(FLUX_2_AR, aspectRatio, '1:1'),
  resolution: flux2Resolution(adv),
  safety_tolerance: optIntIn(adv, 'safety_tolerance', 2, 1, 5),
  output_format: outputFormatIn(adv, WEBP_JPG_PNG, 'webp'),
  output_quality: 90,
}))

/** _b_flux_2_flex (30 steps, guidance 4.5). */
const rFlux2Flex = seeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(FLUX_2_AR, aspectRatio, '1:1'),
  resolution: flux2Resolution(adv),
  steps: optIntIn(adv, 'steps', 30, 1, 50),
  guidance: optFloatIn(adv, 'guidance', 4.5, 1.5, 10),
  safety_tolerance: optIntIn(adv, 'safety_tolerance', 2, 1, 5),
  prompt_upsampling: optBool(adv, 'prompt_upsampling', true),
  output_format: outputFormatIn(adv, WEBP_JPG_PNG, 'webp'),
  output_quality: 90,
}))

/**
 * black-forest-labs/flux-2-dev has no resolution, steps, guidance,
 * safety_tolerance or prompt_upsampling (Python's _b_flux_2_dev sends all
 * five, so its picture is always the 1:1-ish default). It is sized by
 * `width` × `height` with aspect_ratio "custom": the node's resolution label
 * and ratio, capped at 1440 a side (imageSettings.ts flux2DevSize, which the
 * price reads too).
 */
const rFlux2Dev = seeded(({ prompt, aspectRatio, adv }) => {
  const { width, height } = flux2DevSize(flux2Resolution(adv), arOr(FLUX_2_AR, aspectRatio, '1:1'))
  return {
    prompt,
    aspect_ratio: 'custom',
    width,
    height,
    output_format: outputFormatIn(adv, WEBP_JPG_PNG, 'webp'),
    output_quality: 90,
  }
})

const rFluxKlein = seeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(FLUX_KLEIN_AR, aspectRatio, '1:1'),
  output_megapixels: optEnum(adv, 'output_megapixels', FLUX_KLEIN_MEGAPIXELS, '1'),
  go_fast: optBool(adv, 'go_fast', false),
  output_format: outputFormatIn(adv, WEBP_JPG_PNG, 'jpg'),
  output_quality: 90,
}))

const IMAGEN_SAFETY = ['block_low_and_above', 'block_medium_and_above', 'block_only_high']
const rImagen = unseeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(GOOGLE_AR, aspectRatio, '1:1'),
  output_format: outputFormatIn(adv, JPG_PNG, 'jpg'),
  safety_filter_level: optEnum(adv, 'safety_filter_level', IMAGEN_SAFETY, 'block_only_high'),
}))

/** ideogram-ai's seed is at most 2^31 − 1: a larger one wraps into 1 … 2^31 − 1 (still repeatable). */
const IDEOGRAM_SEED_MAX = 2147483647
const IDEOGRAM_STYLES = ['None', 'Auto', 'General', 'Realistic', 'Design', 'Render 3D', 'Anime']
const rIdeogramV2: Builder = ({ prompt, aspectRatio, seed, adv }) => {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(IDEOGRAM_V2_AR, aspectRatio, '1:1'),
    style_type: optEnum(adv, 'style_type', IDEOGRAM_STYLES, 'Auto'),
    magic_prompt_option: optEnum(adv, 'magic_prompt', ['Auto', 'On', 'Off'], 'Auto'),
  }
  maybeSetSeed(inp, seed > IDEOGRAM_SEED_MAX ? ((seed - 1) % IDEOGRAM_SEED_MAX) + 1 : seed)
  return inp
}

const rSeedream45 = unseeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(SEEDREAM_AR, aspectRatio, '1:1'),
  size: optEnum(adv, 'size', ['2K', '4K'], '2K'),
}))

const rSeedream3 = seeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(SEEDREAM_AR, aspectRatio, '1:1'),
  guidance_scale: optFloatIn(adv, 'guidance_scale', 2.5, 1, 10),
}))

const rRecraftV4 = unseeded(({ prompt, aspectRatio }) => ({
  prompt,
  aspect_ratio: arOr(RECRAFT_AR, aspectRatio, '1:1'),
}))

const RECRAFT_V3_STYLES = [
  'any', 'realistic_image', 'digital_illustration', 'digital_illustration/pixel_art', 'digital_illustration/hand_drawn',
  'digital_illustration/grain', 'digital_illustration/infantile_sketch', 'digital_illustration/2d_art_poster',
  'digital_illustration/handmade_3d', 'digital_illustration/hand_drawn_outline', 'digital_illustration/engraving_color',
  'digital_illustration/2d_art_poster_2', 'realistic_image/b_and_w', 'realistic_image/hard_flash', 'realistic_image/hdr',
  'realistic_image/natural_light', 'realistic_image/studio_portrait', 'realistic_image/enterprise', 'realistic_image/motion_blur',
]
const rRecraftV3 = unseeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(RECRAFT_AR, aspectRatio, '1:1'),
  style: optEnum(adv, 'style', RECRAFT_V3_STYLES, 'any'),
}))

const rSd35 = (cfgDefault: number) => seeded(({ prompt, aspectRatio, adv }) => withNegative({
  prompt,
  aspect_ratio: arOr(SD35_AR, aspectRatio, '1:1'),
  cfg: optFloatIn(adv, 'cfg', cfgDefault, 1, 10),
  output_format: outputFormatIn(adv, WEBP_JPG_PNG, 'webp'),
}, adv))

/** openai/gpt-image-*: quality, background and format as the schema lists them ("jpg" is jpeg). */
const GPT_QUALITIES = ['low', 'medium', 'high', 'auto']
const GPT_BACKGROUNDS = ['auto', 'transparent', 'opaque']
const GPT_FORMATS = ['png', 'jpeg', 'webp']
const rGptImage2 = unseeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(OPENAI_AR, aspectRatio, '1:1'),
  quality: optEnum(adv, 'quality', GPT_QUALITIES, 'auto'),
  background: optEnum(adv, 'background', GPT_BACKGROUNDS, 'auto'),
  output_format: outputFormatIn(adv, GPT_FORMATS, 'webp'),
  number_of_images: 1,
}))

const rGptImage15 = unseeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(OPENAI_AR, aspectRatio, '1:1'),
  quality: optEnum(adv, 'quality', GPT_QUALITIES, 'auto'),
  background: optEnum(adv, 'background', GPT_BACKGROUNDS, 'auto'),
  input_fidelity: optEnum(adv, 'input_fidelity', ['low', 'high'], 'low'),
  output_format: outputFormatIn(adv, GPT_FORMATS, 'webp'),
  number_of_images: 1,
}))

const rQwenImage = seeded(({ prompt, aspectRatio, adv }) => withNegative({
  prompt,
  aspect_ratio: arOr(QWEN_AR, aspectRatio, '1:1'),
  guidance: optFloatIn(adv, 'guidance', 3.0, 0, 10),
  num_inference_steps: optIntIn(adv, 'num_inference_steps', 30, 1, 50),
  enhance_prompt: optBool(adv, 'enhance_prompt', false),
  output_format: outputFormatIn(adv, WEBP_JPG_PNG, 'webp'),
  go_fast: true,
}, adv))

const rHunyuan3 = seeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(HUNYUAN_AR, aspectRatio, '1:1'),
  go_fast: optBool(adv, 'go_fast', true),
  output_format: outputFormatIn(adv, WEBP_JPG_PNG, 'webp'),
  output_quality: 95,
}))

const rGrokImagine = unseeded(({ prompt, aspectRatio }) => ({
  prompt,
  aspect_ratio: arOr(GROK_AR, aspectRatio, '1:1'),
}))

/**
 * prunaai/flux-fast's speed modes carry their emoji and a note
 * ("Extra Juiced 🔥 (more speed)"); the node's menu and Python use the short
 * names. A short name is sent as its full value; anything else the default.
 */
export const FLUX_FAST_SPEED_MODES: Readonly<Record<string, string>> = {
  'Lightly Juiced': 'Lightly Juiced 🍊 (more consistent)',
  'Juiced': 'Juiced 🔥 (default)',
  'Extra Juiced': 'Extra Juiced 🔥 (more speed)',
  'Blink of an eye': 'Blink of an eye 👁️',
}
function fluxFastSpeedMode(adv: Record<string, unknown>): string {
  const v = optStr(adv, 'speed_mode', 'Extra Juiced')
  if (Object.values(FLUX_FAST_SPEED_MODES).includes(v)) return v
  return Object.prototype.hasOwnProperty.call(FLUX_FAST_SPEED_MODES, v) ? FLUX_FAST_SPEED_MODES[v]! : FLUX_FAST_SPEED_MODES['Extra Juiced']!
}

const rFluxFast = seeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(FLUX_DEV_AR, aspectRatio, '1:1'),
  // The schema sets no range on guidance or steps: passed as read, as Python does.
  guidance: optFloat(adv, 'guidance', 3.5),
  num_inference_steps: optInt(adv, 'num_inference_steps', 28),
  speed_mode: fluxFastSpeedMode(adv),
  output_format: outputFormatIn(adv, ['png', 'jpg', 'webp'], 'jpg'),
  output_quality: 90,
}))

const rPImage = seeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(PIMAGE_AR, aspectRatio, '1:1'),
  prompt_upsampling: optBool(adv, 'prompt_upsampling', false),
}))

const rWan22Pruna = seeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(WAN22_AR, aspectRatio, '1:1'),
  megapixels: optIntIn(adv, 'megapixels', 2, 1, 2),
  juiced: optBool(adv, 'juiced', false),
  output_format: outputFormatIn(adv, ['png', 'jpg', 'webp'], 'jpg'),
  output_quality: 90,
}))

const rBriaFibo = seeded(({ prompt, aspectRatio, adv }) => withNegative({
  prompt,
  aspect_ratio: arOr(BRIA_AR, aspectRatio, '1:1'),
  guidance_scale: optIntIn(adv, 'guidance_scale', 4, 3, 5),
}, adv))

const rBriaImage32 = seeded(({ prompt, aspectRatio, adv }) => withNegative({
  prompt,
  aspect_ratio: arOr(BRIA_AR, aspectRatio, '1:1'),
  guidance_scale: optFloatIn(adv, 'guidance_scale', 4.0, 3, 5),
  prompt_enhancement: optBool(adv, 'prompt_enhancement', false),
  enhance_image: optBool(adv, 'enhance_image', false),
}, adv))

const rPhoton = seeded(({ prompt, aspectRatio }) => ({
  prompt,
  aspect_ratio: arOr(PHOTON_AR, aspectRatio, '1:1'),
}))

const rMinimaxImage01 = unseeded(({ prompt, aspectRatio, adv }) => ({
  prompt,
  aspect_ratio: arOr(MINIMAX_AR, aspectRatio, '1:1'),
  prompt_optimizer: optBool(adv, 'prompt_optimizer', true),
  number_of_images: 1,
}))

const R = (id: string, label: string, slug: string, build: Builder): ReplicateImageModelDesc => ({ id, label, slug, build })

export const RUNNER_REPLICATE_IMAGE_MODELS: Record<string, ReplicateImageModelDesc> = {
  'flux-1.1-pro-ultra': R('flux-1.1-pro-ultra', 'Flux 1.1 Pro Ultra', 'black-forest-labs/flux-1.1-pro-ultra', rFluxUltra),
  'flux-pro': R('flux-pro', 'Flux Pro', 'black-forest-labs/flux-pro', rFluxPro),
  'flux-dev': R('flux-dev', 'Flux Dev', 'black-forest-labs/flux-dev', rFluxDev),
  'flux-2-max': R('flux-2-max', 'Flux 2 Max', 'black-forest-labs/flux-2-max', rFlux2Basic),
  'flux-2-pro': R('flux-2-pro', 'Flux 2 Pro', 'black-forest-labs/flux-2-pro', rFlux2Basic),
  'flux-2-flex': R('flux-2-flex', 'Flux 2 Flex', 'black-forest-labs/flux-2-flex', rFlux2Flex),
  'flux-2-klein-4b': R('flux-2-klein-4b', 'Flux 2 Klein 4B', 'black-forest-labs/flux-2-klein-4b', rFluxKlein),
  'flux-2-dev': R('flux-2-dev', 'Flux 2 Dev', 'black-forest-labs/flux-2-dev', rFlux2Dev),
  'imagen-4-ultra': R('imagen-4-ultra', 'Imagen 4 Ultra', 'google/imagen-4-ultra', rImagen),
  'imagen-4': R('imagen-4', 'Imagen 4', 'google/imagen-4', rImagen),
  'imagen-4-fast': R('imagen-4-fast', 'Imagen 4 Fast', 'google/imagen-4-fast', rImagen),
  'imagen-3': R('imagen-3', 'Imagen 3', 'google/imagen-3', rImagen),
  'imagen-3-fast': R('imagen-3-fast', 'Imagen 3 Fast', 'google/imagen-3-fast', rImagen),
  'ideogram-v2': R('ideogram-v2', 'Ideogram V2', 'ideogram-ai/ideogram-v2', rIdeogramV2),
  'ideogram-v2a-turbo': R('ideogram-v2a-turbo', 'Ideogram V2A Turbo', 'ideogram-ai/ideogram-v2a-turbo', rIdeogramV2),
  'seedream-4.5': R('seedream-4.5', 'Seedream 4.5', 'bytedance/seedream-4.5', rSeedream45),
  'seedream-3': R('seedream-3', 'Seedream 3', 'bytedance/seedream-3', rSeedream3),
  'recraft-v4-pro': R('recraft-v4-pro', 'Recraft V4 Pro', 'recraft-ai/recraft-v4-pro', rRecraftV4),
  'recraft-v4': R('recraft-v4', 'Recraft V4', 'recraft-ai/recraft-v4', rRecraftV4),
  'recraft-v3': R('recraft-v3', 'Recraft V3', 'recraft-ai/recraft-v3', rRecraftV3),
  'stable-diffusion-3.5-large': R('stable-diffusion-3.5-large', 'Stable Diffusion 3.5 Large', 'stability-ai/stable-diffusion-3.5-large', rSd35(5.0)),
  'stable-diffusion-3.5-large-turbo': R('stable-diffusion-3.5-large-turbo', 'Stable Diffusion 3.5 Large Turbo', 'stability-ai/stable-diffusion-3.5-large-turbo', rSd35(1.0)),
  'stable-diffusion-3.5-medium': R('stable-diffusion-3.5-medium', 'Stable Diffusion 3.5 Medium', 'stability-ai/stable-diffusion-3.5-medium', rSd35(5.0)),
  'gpt-image-2': R('gpt-image-2', 'GPT Image 2', 'openai/gpt-image-2', rGptImage2),
  'gpt-image-1.5': R('gpt-image-1.5', 'GPT Image 1.5', 'openai/gpt-image-1.5', rGptImage15),
  'qwen-image': R('qwen-image', 'Qwen Image', 'qwen/qwen-image', rQwenImage),
  'hunyuan-image-3': R('hunyuan-image-3', 'Hunyuan Image 3', 'tencent/hunyuan-image-3', rHunyuan3),
  'grok-imagine': R('grok-imagine', 'Grok Imagine', 'xai/grok-imagine-image', rGrokImagine),
  'flux-fast': R('flux-fast', 'Flux Fast (Pruna)', 'prunaai/flux-fast', rFluxFast),
  'p-image': R('p-image', 'P-Image', 'prunaai/p-image', rPImage),
  'wan-2.2-image-pruna': R('wan-2.2-image-pruna', 'Wan 2.2 Image (Pruna)', 'prunaai/wan-2.2-image', rWan22Pruna),
  'bria-fibo': R('bria-fibo', 'Bria Fibo', 'bria/fibo', rBriaFibo),
  'bria-image-3.2': R('bria-image-3.2', 'Bria Image 3.2', 'bria/image-3.2', rBriaImage32),
  'photon': R('photon', 'Photon', 'luma/photon', rPhoton),
  'photon-flash': R('photon-flash', 'Photon Flash', 'luma/photon-flash', rPhoton),
  'minimax-image-01': R('minimax-image-01', 'MiniMax Image 01', 'minimax/image-01', rMinimaxImage01),
}

// Fail at import if the shared list and this table ever disagree.
for (const id of RUNNER_REPLICATE_IMAGE_MODEL_IDS) {
  if (!RUNNER_REPLICATE_IMAGE_MODELS[id]) throw new Error(`runner Replicate image model ${id} has no description`)
}
if (Object.keys(RUNNER_REPLICATE_IMAGE_MODELS).length !== RUNNER_REPLICATE_IMAGE_MODEL_IDS.length) {
  throw new Error('runner Replicate image models: the table and the shared list differ')
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
