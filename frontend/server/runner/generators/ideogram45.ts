/**
 * Ideogram 4.5 (Ideogram; model line-up): runner-only, family
 * `ideogram-4.5`, on fal, text-to-image. Ideogram 4 (`ideogram-4`,
 * ideogram4.ts) is a separate model and is left as it is. fal's
 * `ideogram/v4.5/edit` is out of scope.
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/fal/ideogram__v4.5.json, read
 * 2026-10-02): `ideogram/v4.5`, fal's "Ideogram V4.5 Text to Image" (a
 * partner model; fal's model list, api.fal.ai/v1/models?q=ideogram 4.5,
 * names only this one and /edit). Its price is set by the quality alone:
 * "$0.03 per image with Low, $0.06 with Medium, and $0.22 with High quality.
 * The image size does not change the price." (its llms.txt).
 *
 * It sends, from "Generate an image":
 *   prompt                   the composed prompt (style text as the other
 *                            image models); 1 to 10,000 characters (the
 *                            schema's minLength and maxLength, refused before
 *                            sending: requestRules.ts)
 *   image_size               width × height for the ratio (IDEOGRAM_45_SIZES,
 *                            each one of the schema's listed sizes; any other
 *                            ratio is 1:1). The price doesn't depend on it
 *   quality                  low / medium / high (else low, the $0.03 tier;
 *                            the schema's own default is medium)
 *   enable_prompt_expansion  false: the schema's default is true ("partner
 *                            prompt expansion"), and fal says nothing about
 *                            what it costs, so it isn't sent on (as Ideogram 4)
 *   num_images               1
 *   seed                     the node's seed, when above 0
 * Not sent: `sync_mode` (the schema's default applies). The schema has no
 * output format and no picture input, so the node's moodboard pictures are
 * not sent.
 *
 * No backup service: Replicate has no Ideogram 4.5 (replicate.com/ideogram-ai/
 * ideogram-v4.5 answers "not found", read 2026-10-02).
 */
import { arOr, maybeSetSeed, optEnum } from './opts'
import type { ServiceCall } from './twins'

export const IDEOGRAM_45_ID = 'ideogram-4.5'
export const IDEOGRAM_45_FAL_APP = 'ideogram/v4.5'

/** fal's `quality` enum, cheapest first. */
export const IDEOGRAM_45_QUALITIES = ['low', 'medium', 'high'] as const
export type Ideogram45Quality = typeof IDEOGRAM_45_QUALITIES[number]
/** The $0.03 tier (the schema's own default is medium, $0.06). */
export const IDEOGRAM_45_DEFAULT_QUALITY: Ideogram45Quality = 'low'

/**
 * The picture sent for each ratio: one of the schema's listed sizes (its
 * `image_size` description: "Explicit dimensions must match a supported
 * size"), the 1K one at that ratio (1:1 is fal's square_hd, 1024 × 1024).
 * The price is the same at every size.
 */
export const IDEOGRAM_45_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  '1:1': [1024, 1024],
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '4:3': [1152, 864],
  '3:4': [864, 1152],
  '3:2': [1248, 832],
  '2:3': [832, 1248],
  '16:10': [1280, 800],
  '10:16': [800, 1280],
  '5:4': [1120, 896],
  '4:5': [896, 1120],
  '2:1': [1440, 720],
  '1:2': [720, 1440],
}
/** The ratios Ideogram 4.5 offers, in the catalogue's order. */
export const IDEOGRAM_45_RATIOS: readonly string[] = Object.keys(IDEOGRAM_45_SIZES)
const RATIOS: ReadonlySet<string> = new Set(IDEOGRAM_45_RATIOS)

/** ideogram/v4.5 `prompt.maxLength`. */
export const IDEOGRAM_45_PROMPT_MAX = 10000
export const IDEOGRAM_45_NEEDS_PROMPT = 'Ideogram 4.5 needs a prompt. Describe the picture you want.'
export const IDEOGRAM_45_LONG_PROMPT = 'Ideogram 4.5 takes a prompt of at most 10,000 characters. Shorten it.'

export function isIdeogram45Model(model: unknown): boolean {
  return model === IDEOGRAM_45_ID
}

/** The quality the options pick (`quality`), anything else low (#shared/pricing/imageSettings reads it the same way). */
export function ideogram45Quality(adv: Record<string, unknown>): Ideogram45Quality {
  return optEnum(adv, 'quality', IDEOGRAM_45_QUALITIES, IDEOGRAM_45_DEFAULT_QUALITY) as Ideogram45Quality
}

export interface Ideogram45Args {
  prompt: string
  aspectRatio: string
  seed: number
  adv: Record<string, unknown>
}

/** "Generate an image" on Ideogram 4.5: the fal request. */
export function ideogram45Generate({ prompt, aspectRatio, seed, adv }: Ideogram45Args): ServiceCall {
  const [width, height] = IDEOGRAM_45_SIZES[arOr(RATIOS, aspectRatio, '1:1')]!
  const payload: Record<string, unknown> = {
    prompt,
    image_size: { width, height },
    quality: ideogram45Quality(adv),
    enable_prompt_expansion: false,
    num_images: 1,
  }
  maybeSetSeed(payload, seed)
  return { provider: 'fal', endpoint: IDEOGRAM_45_FAL_APP, payload }
}
