/**
 * GPT Image 2.5 (model line-up, Task F2): runner-only, family `gpt-image-2.5`.
 *
 * OpenAI's model in two versions, Flare (quick) and Sunburst (slower, finer
 * detail). Both services host both versions at one price each, and neither
 * takes a seed. Six endpoints, one builder each, written from their saved
 * schemas (tests/unit/fixtures/provider-schemas/, read 2026-09-24):
 *
 *   fal (first)                                  Replicate (backup)
 *   openai/gpt-image-2.5/flare/text-to-image     openai/gpt-image-2.5-flare
 *   openai/gpt-image-2.5/sunburst/text-to-image  openai/gpt-image-2.5-sunburst
 *   openai/gpt-image-2.5/flare/edit              openai/gpt-image-2.5-flare (with `input_images`)
 *
 * fal is first: the same model at a lower price (its per-size table,
 * shared/pricing/imageRates.ts; $0.013 against Replicate's flat $0.047 for a
 * medium 1024² picture). Replicate is the backup: the same version of the
 * same model, and its schema carries every setting the fal request carries.
 * The backup request is built from the fal request (`onReplicate`).
 *
 * "Generate an image" (gpt-image-2.5) sends, from the node:
 *   version     the endpoint: `variant` flare / sunburst in the options (else flare)
 *   quality     `quality` low / medium / high (else high); the schema's auto,
 *               xhigh and max are not offered
 *   ratio       the picture size, as width × height both services take
 *               (GPT_IMAGE_25_SIZES; any other ratio is 1:1)
 *   background  `background` auto / transparent / opaque (else auto); a
 *               transparent JPEG is refused (requestRules.ts), never sent
 *   format      `output_format` png / jpeg / webp ("jpg" is jpeg; else png),
 *               with `output_compression` 90 for jpeg and webp on BOTH
 *               services (Replicate's own default; fal has none), so the
 *               backup saves the same way
 *
 * "Edit an image" (the "GPT Image 2.5" option) sends the linked picture and
 * the instruction to Flare's edit endpoint at quality medium (the node has
 * no quality control), the size taken from the picture (fal `image_size`
 * "auto", Replicate `aspect_ratio` "auto"), the node's png / jpg format.
 *
 * Not sent: `num_images` above 1, `mask_url`, `sync_mode`, `moderation`,
 * `user_id`, `openai_api_key` (the schemas' defaults apply).
 */
import { optEnum, outputFormatIn } from './opts'
import type { ServiceCall } from './twins'

export const GPT_IMAGE_25_ID = 'gpt-image-2.5'
/** The "Edit an image" option (app/data/edit-model-options.ts). */
export const GPT_IMAGE_25_EDIT_OPTION = 'GPT Image 2.5'

export const GPT_IMAGE_25_VARIANTS = ['flare', 'sunburst'] as const
export type GptImage25Variant = typeof GPT_IMAGE_25_VARIANTS[number]
export const GPT_IMAGE_25_DEFAULT_VARIANT: GptImage25Variant = 'flare'

/** The qualities offered (each schema also lists auto, xhigh and max). */
export const GPT_IMAGE_25_QUALITIES = ['low', 'medium', 'high'] as const
export const GPT_IMAGE_25_DEFAULT_QUALITY = 'high'
/** The quality an edit is sent at: Edit an image has no quality control. */
export const GPT_IMAGE_25_EDIT_QUALITY = 'medium'
export const GPT_IMAGE_25_BACKGROUNDS = ['auto', 'transparent', 'opaque'] as const
export const GPT_IMAGE_25_FORMATS = ['png', 'jpeg', 'webp'] as const
/** Replicate's `output_compression` default, sent to both services for jpeg and webp. */
export const GPT_IMAGE_25_COMPRESSION = 90

/**
 * The picture size per ratio, width × height. Each is one of Replicate's
 * listed sizes ("1536x1152"…) and fits fal's rule (both sides multiples of
 * 16, at most 3840, 655,360 to 8,294,400 pixels, at most 3:1), so both
 * services are asked for the same picture. A test holds each to both schemas.
 */
export const GPT_IMAGE_25_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  '1:1': [1024, 1024],
  '3:2': [1536, 1024],
  '2:3': [1024, 1536],
  '4:3': [1536, 1152],
  '3:4': [1152, 1536],
  '16:9': [2048, 1152],
  '9:16': [1152, 2048],
}

export const gptImage25FalTextToImage = (v: GptImage25Variant) => `openai/gpt-image-2.5/${v}/text-to-image`
export const gptImage25FalEdit = (v: GptImage25Variant) => `openai/gpt-image-2.5/${v}/edit`
export const gptImage25ReplicateSlug = (v: GptImage25Variant) => `openai/gpt-image-2.5-${v}`
/** The one edit endpoint the runner calls (Flare). */
export const GPT_IMAGE_25_EDIT_APP = gptImage25FalEdit('flare')

/** Every endpoint the family calls, by service. */
export const GPT_IMAGE_25_FAL_ENDPOINTS = [
  gptImage25FalTextToImage('flare'), gptImage25FalTextToImage('sunburst'), GPT_IMAGE_25_EDIT_APP,
] as const
export const GPT_IMAGE_25_REPLICATE_SLUGS = [gptImage25ReplicateSlug('flare'), gptImage25ReplicateSlug('sunburst')] as const

export const GPT_IMAGE_25_NEEDS_PROMPT = 'GPT Image 2.5 needs a prompt. Describe the picture you want, or the change to make.'
export const GPT_IMAGE_25_TRANSPARENT_JPEG = 'GPT Image 2.5 can’t make a transparent JPEG. Pick PNG or WebP, or another background.'

export function isGptImage25Model(model: unknown): boolean {
  return model === GPT_IMAGE_25_ID
}

/** The version the options pick: flare or sunburst, anything else flare. */
export function gptImage25Variant(adv: Record<string, unknown>): GptImage25Variant {
  return optEnum(adv, 'variant', GPT_IMAGE_25_VARIANTS, GPT_IMAGE_25_DEFAULT_VARIANT) as GptImage25Variant
}

/** The size a ratio is sent as (any ratio not listed is 1:1). */
export function gptImage25Size(aspectRatio: string): { width: number, height: number } {
  const wh = Object.prototype.hasOwnProperty.call(GPT_IMAGE_25_SIZES, aspectRatio) ? GPT_IMAGE_25_SIZES[aspectRatio]! : GPT_IMAGE_25_SIZES['1:1']!
  return { width: wh[0], height: wh[1] }
}

/** The generate request's format and background as sent. */
export function gptImage25Format(adv: Record<string, unknown>): string {
  return outputFormatIn(adv, GPT_IMAGE_25_FORMATS, 'png')
}
export function gptImage25Background(adv: Record<string, unknown>): string {
  return optEnum(adv, 'background', GPT_IMAGE_25_BACKGROUNDS, 'auto')
}

/** Whether these options ask for a transparent JPEG, which the model can't make. */
export function gptImage25TransparentJpeg(adv: Record<string, unknown>): boolean {
  return gptImage25Background(adv) === 'transparent' && gptImage25Format(adv) === 'jpeg'
}

function withCompression(inp: Record<string, unknown>): Record<string, unknown> {
  if (inp.output_format === 'jpeg' || inp.output_format === 'webp') inp.output_compression = GPT_IMAGE_25_COMPRESSION
  return inp
}

/** "Generate an image" on fal: the version's text-to-image endpoint. */
export function gptImage25Generate(a: { prompt: string, aspectRatio: string, adv: Record<string, unknown> }): ServiceCall {
  const { adv } = a
  const payload = withCompression({
    prompt: a.prompt,
    image_size: gptImage25Size(a.aspectRatio),
    quality: optEnum(adv, 'quality', GPT_IMAGE_25_QUALITIES, GPT_IMAGE_25_DEFAULT_QUALITY),
    background: gptImage25Background(adv),
    output_format: gptImage25Format(adv),
    num_images: 1,
  })
  return { provider: 'fal', endpoint: gptImage25FalTextToImage(gptImage25Variant(adv)), payload }
}

/** "Edit an image" on fal: Flare's edit endpoint with the linked picture. The node's format is png or jpg. */
export function gptImage25Edit(a: { image: string, prompt: string, outputFormat: string }): ServiceCall {
  const payload = withCompression({
    prompt: a.prompt,
    image_urls: [a.image],
    image_size: 'auto',
    quality: GPT_IMAGE_25_EDIT_QUALITY,
    output_format: outputFormatIn({ output_format: a.outputFormat }, GPT_IMAGE_25_FORMATS, 'png'),
    num_images: 1,
  })
  return { provider: 'fal', endpoint: GPT_IMAGE_25_EDIT_APP, payload }
}

/** The fal endpoint's version (flare or sunburst), or null when it isn't one of the family's. */
function variantOf(endpoint: string): GptImage25Variant | null {
  const m = /^openai\/gpt-image-2\.5\/(flare|sunburst)\/(text-to-image|edit)$/.exec(endpoint)
  return m ? m[1] as GptImage25Variant : null
}

/**
 * The same request on Replicate, built from the fal one: the same version,
 * prompt, quality, background, format and compression; the size as
 * Replicate's "WIDTHxHEIGHT" (or "auto" for an edit); the pictures as
 * `input_images`. Anything Replicate can't carry throws, rather than send the
 * backup something the first request never asked for.
 */
export function gptImage25OnReplicate(fal: ServiceCall): ServiceCall {
  const v = variantOf(fal.endpoint)
  const p = fal.payload
  const bad = (field: string) => new Error(`GPT Image 2.5 backup: the fal request's ${field} is not what Replicate can carry`)
  if (!v) throw bad('endpoint')
  if (typeof p.prompt !== 'string') throw bad('prompt')
  let aspectRatio: string
  if (p.image_size === 'auto') aspectRatio = 'auto'
  else {
    const size = p.image_size as { width?: unknown, height?: unknown } | undefined
    const listed = Object.values(GPT_IMAGE_25_SIZES).some(([w, h]) => w === size?.width && h === size?.height)
    if (!listed) throw bad('image_size')
    aspectRatio = `${size!.width}x${size!.height}`
  }
  const inp: Record<string, unknown> = {
    prompt: p.prompt,
    aspect_ratio: aspectRatio,
    quality: p.quality,
    output_format: p.output_format,
    number_of_images: 1,
  }
  if (p.background !== undefined) inp.background = p.background
  if (p.output_compression !== undefined) inp.output_compression = p.output_compression
  if (p.image_urls !== undefined) {
    if (!Array.isArray(p.image_urls) || !p.image_urls.every(u => typeof u === 'string')) throw bad('image_urls')
    inp.input_images = [...p.image_urls]
  }
  return { provider: 'replicate', endpoint: gptImage25ReplicateSlug(v), payload: inp }
}
