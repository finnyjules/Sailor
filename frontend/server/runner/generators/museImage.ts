/**
 * Muse Image (Meta; model line-up, Task F13): runner-only, family
 * `muse-image`, on fal, text-to-image.
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/fal/meta__muse-image__text-to-image.json,
 * read 2026-09-24): `meta/muse-image/text-to-image`, fal's "Meta Muse Image
 * Text to Image", "$0.01 per images" whatever the ratio (its llms.txt).
 * The line-up page's `muse-image` is not the id: fal's `fal-ai/muse-image`
 * answers an OpenAPI GET, but is unlisted, its page bills "$0 per compute
 * seconds" with enterprise status "pending", and the public model list
 * (api.fal.ai/v1/models?q=muse) names only the `meta/muse-image/…` pair.
 *
 * It sends, from "Generate an image":
 *   prompt         the composed prompt (style text as the other image models)
 *   aspect_ratio   one of the schema's common presets (MUSE_IMAGE_RATIOS; any
 *                  other ratio is 1:1). Muse makes every ratio at its own
 *                  ~2.5 megapixels, one price
 *   num_images     1
 *   output_format  "png" (the schema's default is webp)
 * Not sent: `sync_mode` (the schema's default applies). The schema has no
 * seed, no picture input and no web search (so nothing that costs extra),
 * so the node's seed and moodboard pictures are not sent.
 *
 * No backup service: Replicate has no Muse model (its search and
 * replicate.com/meta/muse-image, read 2026-09-24).
 */
import { arOr } from './opts'
import type { ServiceCall } from './twins'

export const MUSE_IMAGE_ID = 'muse-image'
export const MUSE_IMAGE_FAL_APP = 'meta/muse-image/text-to-image'
export const MUSE_IMAGE_FORMAT = 'png'

/** The schema's "common presets" for `aspect_ratio`, in the catalogue's order. */
export const MUSE_IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '9:21'] as const
const RATIOS: ReadonlySet<string> = new Set(MUSE_IMAGE_RATIOS)

export const MUSE_IMAGE_NEEDS_PROMPT = 'Muse Image needs a prompt. Describe the picture you want.'

export function isMuseImageModel(model: unknown): boolean {
  return model === MUSE_IMAGE_ID
}

export interface MuseImageArgs {
  prompt: string
  aspectRatio: string
}

/** "Generate an image" on Muse Image: the fal request. */
export function museImageGenerate({ prompt, aspectRatio }: MuseImageArgs): ServiceCall {
  return {
    provider: 'fal',
    endpoint: MUSE_IMAGE_FAL_APP,
    payload: {
      prompt,
      aspect_ratio: arOr(RATIOS, aspectRatio, '1:1'),
      num_images: 1,
      output_format: MUSE_IMAGE_FORMAT,
    },
  }
}
