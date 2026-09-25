/**
 * Nano Banana 2 Lite (Google; model line-up, Task F14): runner-only, family
 * `nano-banana-2-lite`, on Replicate, text-to-image.
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/replicate/google__nano-banana-2-lite.json,
 * version 8bd4298c…, read 2026-09-24): `google/nano-banana-2-lite`, Google's
 * own model on Replicate (Gemini 3.1 Flash-Lite Image), "$0.034 per output
 * image" whatever the ratio (billingConfig image_output_count, one tier). It
 * always makes a 1K picture (about 1 megapixel; its README), so there is no
 * size to choose and one price. Using it for Remove object and Recolor is out
 * of scope (Task F14).
 *
 * It sends, from "Generate an image":
 *   prompt         the composed prompt (style text as the other image models)
 *   aspect_ratio   one of the schema's ratios except `match_input_image`
 *                  (NANO_BANANA_2_LITE_RATIOS; any other ratio is 1:1)
 *   output_format  "png" (the schema's default is jpg)
 * Not sent: `image_input` (picture editing; this task is text-to-image
 * only), so moodboard pictures are not sent either. The schema has no seed,
 * no size and no web search, so the node's seed is not sent.
 *
 * No backup service. fal runs the same model (`google/nano-banana-2-lite`,
 * same ratios, fixed 1K) but bills it by tokens: "Image tokens (per 1M):
 * $0.3125 input, $37.50 output", plus text tokens in and out (its llms.txt,
 * read 2026-09-24). It publishes no price a picture; Google's own page counts
 * a 1K picture as 1,120 tokens (about $0.042 at fal's rate), but the text
 * tokens on top can't be known before the run. A cost that can't be known
 * can't be covered, so fal is not a backup.
 */
import { arOr } from './opts'
import type { ServiceCall } from './twins'

export const NANO_BANANA_2_LITE_ID = 'nano-banana-2-lite'
export const NANO_BANANA_2_LITE_SLUG = 'google/nano-banana-2-lite'
export const NANO_BANANA_2_LITE_FORMAT = 'png'

/** google/nano-banana-2-lite `aspect_ratio` (its schema's enum), without `match_input_image`, in the catalogue's order. */
export const NANO_BANANA_2_LITE_RATIOS = [
  '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9',
] as const
const RATIOS: ReadonlySet<string> = new Set(NANO_BANANA_2_LITE_RATIOS)

export const NANO_BANANA_2_LITE_NEEDS_PROMPT = 'Nano Banana 2 Lite needs a prompt. Describe the picture you want.'

export function isNanoBanana2LiteModel(model: unknown): boolean {
  return model === NANO_BANANA_2_LITE_ID
}

export interface NanoBanana2LiteArgs {
  prompt: string
  aspectRatio: string
}

/** "Generate an image" on Nano Banana 2 Lite: the Replicate request. */
export function nanoBanana2LiteGenerate({ prompt, aspectRatio }: NanoBanana2LiteArgs): ServiceCall {
  return {
    provider: 'replicate',
    endpoint: NANO_BANANA_2_LITE_SLUG,
    payload: {
      prompt,
      aspect_ratio: arOr(RATIOS, aspectRatio, '1:1'),
      output_format: NANO_BANANA_2_LITE_FORMAT,
    },
  }
}
