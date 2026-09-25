/**
 * Recraft V4.1 (Recraft; model line-up, Task F16): runner-only, family
 * `recraft-v4.1`, text-to-image. The older Recraft models (V4, V4 Pro, V3
 * and their SVG ones) are left as they are.
 *
 * Two endpoints, one builder each, written from their saved schemas
 * (tests/unit/fixtures/provider-schemas/, read 2026-09-24):
 *
 *   fal (first)    fal-ai/recraft/v4.1/text-to-image ("Recraft V4.1"), "$0.035
 *                  per images" (its llms.txt; the page's billing: unit
 *                  "images", price 0.035, one tier)
 *   Replicate      recraft-ai/recraft-v4.1 (Recraft's own, official), "$0.04
 *   (the backup)   per output image"
 *
 * fal is first: it is the cheaper of the two at every setting.
 *
 * It sends fal, from "Generate an image":
 *   prompt       the composed prompt (style text as the other image models);
 *                1 to 10,000 characters (the schema's minLength and
 *                maxLength, refused before sending: requestRules.ts)
 *   image_size   one of the schema's named sizes, by the ratio
 *                (RECRAFT_V41_SIZES; any other ratio is 1:1, square_hd). Only
 *                a listed name is sent: fal accepts any width × height on
 *                submit and a size Recraft can't make fails at the result.
 * Not sent: `colors`, `background_color` (Replicate has neither, so the backup
 * couldn't carry them) and `enable_safety_checker` (the schema's default
 * applies). The schema has no seed, no format and no picture input, so the
 * node's seed and moodboard pictures are not sent.
 *
 * The backup (`recraftV41OnReplicate`) is built from the fal request: the
 * prompt and the same ratio as Replicate's `aspect_ratio` (its schema: "Size
 * is ignored if an aspect ratio is set"). Every ratio the catalogue offers is
 * in Replicate's enum, so every request has the backup.
 *
 * Not here: the vector model (fal-ai/recraft/v4.1/text-to-vector,
 * recraft-ai/recraft-v4.1-svg). It returns an SVG file, and the pictures a
 * "Generate an image" node makes feed nodes that send them on to services
 * which take PNG, JPEG or WebP only (decision D4 keeps the SVG models off the
 * runner). The Pro model (fal-ai/recraft/v4.1/pro/text-to-image) is out of
 * this task's scope.
 */
import type { ServiceCall } from './twins'

export const RECRAFT_V41_ID = 'recraft-v4.1'
export const RECRAFT_V41_FAL_APP = 'fal-ai/recraft/v4.1/text-to-image'
export const RECRAFT_V41_REPLICATE_SLUG = 'recraft-ai/recraft-v4.1'

/**
 * The ratios the catalogue offers → fal's named `image_size` (its schema's
 * enum). `square` (512 × 512) is left out: square_hd is the 1:1 size.
 */
export const RECRAFT_V41_SIZES = {
  '1:1': 'square_hd',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
} as const
export type RecraftV41Ratio = keyof typeof RECRAFT_V41_SIZES
export const RECRAFT_V41_RATIOS = Object.keys(RECRAFT_V41_SIZES) as RecraftV41Ratio[]
const RATIO_BY_SIZE: Readonly<Record<string, RecraftV41Ratio>> =
  Object.fromEntries(RECRAFT_V41_RATIOS.map(r => [RECRAFT_V41_SIZES[r], r]))

/** fal-ai/recraft/v4.1/text-to-image `prompt.maxLength`. */
export const RECRAFT_V41_PROMPT_MAX = 10000
export const RECRAFT_V41_NEEDS_PROMPT = 'Recraft V4.1 needs a prompt. Describe the picture you want.'
export const RECRAFT_V41_LONG_PROMPT = 'Recraft V4.1 takes a prompt of at most 10,000 characters. Shorten it.'

export function isRecraftV41Model(model: unknown): boolean {
  return model === RECRAFT_V41_ID
}

export interface RecraftV41Args {
  prompt: string
  aspectRatio: string
}

/** "Generate an image" on Recraft V4.1: the fal request. */
export function recraftV41Generate({ prompt, aspectRatio }: RecraftV41Args): ServiceCall {
  const ratio: RecraftV41Ratio = Object.prototype.hasOwnProperty.call(RECRAFT_V41_SIZES, aspectRatio) ? aspectRatio as RecraftV41Ratio : '1:1'
  return {
    provider: 'fal',
    endpoint: RECRAFT_V41_FAL_APP,
    payload: { prompt, image_size: RECRAFT_V41_SIZES[ratio] },
  }
}

/**
 * The same request on Replicate, built from the fal one: the prompt and the
 * size's ratio. Anything Replicate can't carry throws, rather than send the
 * backup something the first request never asked for.
 */
export function recraftV41OnReplicate(fal: ServiceCall): ServiceCall {
  const p = fal.payload
  const bad = (field: string) => new Error(`Recraft V4.1 backup: the fal request's ${field} is not what Replicate can carry`)
  if (fal.provider !== 'fal' || fal.endpoint !== RECRAFT_V41_FAL_APP) throw bad('endpoint')
  if (typeof p.prompt !== 'string') throw bad('prompt')
  const ratio = typeof p.image_size === 'string' && Object.prototype.hasOwnProperty.call(RATIO_BY_SIZE, p.image_size) ? RATIO_BY_SIZE[p.image_size] : undefined
  if (!ratio) throw bad('image_size')
  const extra = Object.keys(p).filter(k => k !== 'prompt' && k !== 'image_size')
  if (extra.length) throw bad(extra.join(', '))
  return { provider: 'replicate', endpoint: RECRAFT_V41_REPLICATE_SLUG, payload: { prompt: p.prompt, aspect_ratio: ratio } }
}
