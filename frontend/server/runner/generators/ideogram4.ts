/**
 * Ideogram 4 (model line-up, Task F8): runner-only, family `ideogram-4`,
 * text-to-image. One catalogue model; the speed (Turbo, Balanced, Quality)
 * and the size (1K, 2K) are its settings.
 *
 * Four endpoints, one builder each, written from their saved schemas
 * (tests/unit/fixtures/provider-schemas/, read 2026-09-24):
 *
 *   fal (first)    ideogram/v4 ("Ideogram V4.0 Text to Image"; the speed is
 *                  its `rendering_speed`)
 *   Replicate      ideogram-ai/ideogram-v4-turbo / -balanced / -quality
 *   (the backup)   (Ideogram's own "Ideogram 4.0", one model per speed)
 *
 * fal is first: it bills by the megapixel ($0.0075 / $0.015 / $0.025 by
 * speed), so a 1K picture costs a quarter of Replicate's flat $0.03 / $0.06 /
 * $0.10, and it takes a seed. Replicate makes only its listed ~4 MP sizes,
 * so it is the backup for a 2K picture only (the same pixels on both); a 1K
 * request has no backup.
 *
 * "Generate an image" sends fal, from the node:
 *   prompt           the composed prompt (style text as the other image models)
 *   image_size       width × height from the size and ratio
 *                    (#shared/pricing/imageSettings IDEOGRAM_4_SIZES, which
 *                    the price reads too; any other ratio is 1:1)
 *   rendering_speed  `rendering_speed` TURBO / BALANCED / QUALITY (else BALANCED,
 *                    the schema's default)
 *   expansion_model  "None": the schema says the other two carry a fee, and
 *                    fal publishes no figure for it, so it can't be priced
 *   output_format    "png", as Replicate's pictures come back
 *   num_images       1
 *   seed             the node's seed, when above 0
 * Not sent: `acceleration`, `sync_mode`, `enable_safety_checker` (the
 * schema's defaults apply).
 *
 * The backup (`ideogram4OnReplicate`) is built from the fal request: the
 * speed's model, the prompt, and the same size as `resolution` "WxH". Its
 * schema has no seed, no format and no expansion switch (Replicate says it
 * "Enables Ideogram 4.0 Magic Prompt automatically"), so a backup picture
 * may read the prompt a little more freely and won't repeat by seed.
 */
import {
  IDEOGRAM_4_SIZES, ideogram4Resolution, ideogram4Size, ideogram4Speed, type Ideogram4Speed,
} from '#shared/pricing/imageSettings'
import { maybeSetSeed } from './opts'
import type { ServiceCall } from './twins'

export const IDEOGRAM_4_ID = 'ideogram-4'
export const IDEOGRAM_4_FAL_APP = 'ideogram/v4'
export const IDEOGRAM_4_REPLICATE_SLUGS: Readonly<Record<Ideogram4Speed, string>> = {
  TURBO: 'ideogram-ai/ideogram-v4-turbo',
  BALANCED: 'ideogram-ai/ideogram-v4-balanced',
  QUALITY: 'ideogram-ai/ideogram-v4-quality',
}
/** fal's `expansion_model`: "None" skips the prompt expansion and its unpublished fee. */
export const IDEOGRAM_4_EXPANSION = 'None'
export const IDEOGRAM_4_FORMAT = 'png'

export const IDEOGRAM_4_NEEDS_PROMPT = 'Ideogram 4 needs a prompt. Describe the picture you want.'

export function isIdeogram4Model(model: unknown): boolean {
  return model === IDEOGRAM_4_ID
}

export interface Ideogram4Args {
  prompt: string
  aspectRatio: string
  seed: number
  adv: Record<string, unknown>
}

/** "Generate an image" on Ideogram 4: the fal request. */
export function ideogram4Generate({ prompt, aspectRatio, seed, adv }: Ideogram4Args): ServiceCall {
  const payload: Record<string, unknown> = {
    prompt,
    image_size: ideogram4Size(ideogram4Resolution(adv), aspectRatio),
    rendering_speed: ideogram4Speed(adv),
    expansion_model: IDEOGRAM_4_EXPANSION,
    output_format: IDEOGRAM_4_FORMAT,
    num_images: 1,
  }
  maybeSetSeed(payload, seed)
  return { provider: 'fal', endpoint: IDEOGRAM_4_FAL_APP, payload }
}

/**
 * The same request on Replicate, built from the fal one: the speed's model,
 * the prompt, the size as "WxH". Null for a picture that isn't one of the 2K
 * sizes (Replicate makes no other), so a 1K request has no backup. Anything
 * else Replicate can't carry throws, rather than send the backup something
 * the first request never asked for.
 */
export function ideogram4OnReplicate(fal: ServiceCall): ServiceCall | null {
  const p = fal.payload
  const bad = (field: string) => new Error(`Ideogram 4 backup: the fal request's ${field} is not what Replicate can carry`)
  if (fal.provider !== 'fal' || fal.endpoint !== IDEOGRAM_4_FAL_APP) throw bad('endpoint')
  if (typeof p.prompt !== 'string') throw bad('prompt')
  const speed = p.rendering_speed
  if (typeof speed !== 'string' || !Object.prototype.hasOwnProperty.call(IDEOGRAM_4_REPLICATE_SLUGS, speed)) throw bad('rendering_speed')
  if (p.expansion_model !== IDEOGRAM_4_EXPANSION || p.num_images !== 1) throw bad('expansion_model or num_images')
  const size = p.image_size as { width?: unknown, height?: unknown } | undefined
  const listed = Object.values(IDEOGRAM_4_SIZES['2K']).some(([w, h]) => w === size?.width && h === size?.height)
  if (!listed) return null
  return {
    provider: 'replicate',
    endpoint: IDEOGRAM_4_REPLICATE_SLUGS[speed as Ideogram4Speed],
    payload: { prompt: p.prompt, resolution: `${size!.width}x${size!.height}` },
  }
}
