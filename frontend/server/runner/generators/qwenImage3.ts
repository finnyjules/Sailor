/**
 * Qwen Image 3 (model line-up, Task F6): runner-only, family `qwen-image-3`,
 * on Replicate, text-to-image.
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/replicate/alibaba__qwen-image-3.json,
 * version 8235a8d3…, read 2026-09-24): `alibaba/qwen-image-3`, Alibaba's own
 * model on Replicate, "$0.03 per output image" whatever the ratio.
 *
 * It sends, from "Generate an image":
 *   prompt                   the composed prompt (style text as the other image models)
 *   aspect_ratio             one of the schema's nine ratios (else 1:1)
 *   enable_prompt_expansion  `enable_prompt_expansion` in the options (default true, the schema's)
 *   negative_prompt          only when the options carry one
 *   seed                     the node's seed when above 0, folded into the
 *                            schema's 0 … 2147483647 (still repeatable)
 * Not sent: `image` and `match_input_image` (picture editing; this task is
 * text-to-image only), so moodboard pictures are not sent either.
 *
 * No backup service. fal's `alibaba/qwen-image-3/text-to-image` is a
 * different model: its schema says "Generate images from text using Qwen
 * Image 3 Pro" (x-fal-metadata.about, read 2026-09-24) and its price ($0.04
 * at 1K, $0.075 at 2K) is Alibaba's list price for `qwen-image-3.0-pro`,
 * while Replicate's run logs name `qwen-image-3.0`, whose list price is $0.03
 * at 1K and 2K (https://www.alibabacloud.com/help/en/model-studio/model-pricing,
 * read 2026-09-24). Alibaba lists the two as separate models ("qwen-image-3.0:
 * Balances quality and speed"). S3 allows a backup only for the same model.
 */
import { arOr, optBool, optStr } from './opts'
import type { ServiceCall } from './twins'

export const QWEN_IMAGE_3_ID = 'qwen-image-3'
export const QWEN_IMAGE_3_SLUG = 'alibaba/qwen-image-3'

/** alibaba/qwen-image-3 `aspect_ratio` (its schema's enum). */
export const QWEN_IMAGE_3_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2'] as const
const RATIOS: ReadonlySet<string> = new Set(QWEN_IMAGE_3_RATIOS)

/** The schema's seed range ("Range: 0-2147483647"). */
export const QWEN_IMAGE_3_SEED_MAX = 2147483647

export function isQwenImage3Model(model: unknown): boolean {
  return model === QWEN_IMAGE_3_ID
}

/** A node seed above the schema's range, folded into 1 … 2147483647 (the same seed always gives the same value). */
export function qwenImage3Seed(seed: number): number {
  return seed > QWEN_IMAGE_3_SEED_MAX ? ((seed - 1) % QWEN_IMAGE_3_SEED_MAX) + 1 : seed
}

export interface QwenImage3Args {
  prompt: string
  aspectRatio: string
  seed: number
  adv: Record<string, unknown>
}

/** "Generate an image" on Qwen Image 3: the Replicate request. */
export function qwenImage3Generate({ prompt, aspectRatio, seed, adv }: QwenImage3Args): ServiceCall {
  const payload: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(RATIOS, aspectRatio, '1:1'),
    enable_prompt_expansion: optBool(adv, 'enable_prompt_expansion', true),
  }
  const negative = optStr(adv, 'negative_prompt', '')
  if (negative) payload.negative_prompt = negative
  if (Number.isFinite(seed) && seed > 0) payload.seed = qwenImage3Seed(Math.floor(seed))
  return { provider: 'replicate', endpoint: QWEN_IMAGE_3_SLUG, payload }
}
