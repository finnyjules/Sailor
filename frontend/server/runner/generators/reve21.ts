/**
 * Reve 2.1 (Reve; model line-up, Task F15): runner-only, family `reve-2.1`,
 * on fal, text-to-image. Reve Create (`reve-create`, Replicate, unpriced) is
 * a separate model and is left as it is.
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/fal/reve__2.1__text-to-image.json,
 * read 2026-09-24): `reve/2.1/text-to-image` (no `fal-ai/` prefix; fal's
 * "Reve 2.1", a partner model), "$0.25 per images" (its llms.txt; the page's
 * billing: unit "images", price 0.25, one tier). The schema has no size or
 * resolution setting: Reve 2.1 makes its own large picture (fal's example
 * output is 5376 × 3072), so there is nothing to choose and one price.
 *
 * It sends, from "Generate an image":
 *   prompt         the composed prompt (style text as the other image models);
 *                  1 to 4,000 characters (the schema's minLength and
 *                  maxLength, refused before sending: requestRules.ts)
 *   aspect_ratio   one of the schema's ratios except `auto` (REVE_21_RATIOS;
 *                  any other ratio is 1:1)
 *   num_images     1
 *   output_format  "png" (the schema's default too)
 * Not sent: `sync_mode` (the schema's default applies). The schema has no
 * seed and no picture input, so the node's seed and moodboard pictures are
 * not sent. fal's reve/2.1/edit and /remix (pictures in) are out of scope.
 *
 * No backup service: Replicate has no Reve 2.1 (its model GETs for
 * reve/reve-2.1 and similar answer "not found", and its search names none,
 * read 2026-09-24).
 */
import { arOr } from './opts'
import type { ServiceCall } from './twins'

export const REVE_21_ID = 'reve-2.1'
export const REVE_21_FAL_APP = 'reve/2.1/text-to-image'
export const REVE_21_FORMAT = 'png'

/** reve/2.1/text-to-image `aspect_ratio` (its schema's enum) without `auto`, in the catalogue's order. */
export const REVE_21_RATIOS = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9', '17:9', '2:1', '1:2', '3:1', '1:3', '4:1', '1:4',
] as const
const RATIOS: ReadonlySet<string> = new Set(REVE_21_RATIOS)

/** reve/2.1/text-to-image `prompt.maxLength`. */
export const REVE_21_PROMPT_MAX = 4000
export const REVE_21_NEEDS_PROMPT = 'Reve 2.1 needs a prompt. Describe the picture you want.'
export const REVE_21_LONG_PROMPT = 'Reve 2.1 takes a prompt of at most 4,000 characters. Shorten it.'

export function isReve21Model(model: unknown): boolean {
  return model === REVE_21_ID
}

export interface Reve21Args {
  prompt: string
  aspectRatio: string
}

/** "Generate an image" on Reve 2.1: the fal request. */
export function reve21Generate({ prompt, aspectRatio }: Reve21Args): ServiceCall {
  return {
    provider: 'fal',
    endpoint: REVE_21_FAL_APP,
    payload: {
      prompt,
      aspect_ratio: arOr(RATIOS, aspectRatio, '1:1'),
      num_images: 1,
      output_format: REVE_21_FORMAT,
    },
  }
}
