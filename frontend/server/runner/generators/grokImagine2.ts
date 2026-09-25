/**
 * Grok Imagine 2 (model line-up, Task F7): runner-only, family
 * `grok-imagine-2`, on Replicate, text-to-image.
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/replicate/xai__grok-imagine-image-2.json,
 * version 1ef875bf…, read 2026-09-24): `xai/grok-imagine-image-2`, xAI's own
 * "Grok Imagine Image 2.0" on Replicate, "$0.04 per output image" whatever
 * the ratio, size or quality (billingConfig image_output_count; the README
 * says the same, and $0.01 more per input picture when editing, not used here).
 *
 * It sends, from "Generate an image":
 *   prompt        the composed prompt (style text as the other image models)
 *   aspect_ratio  one of the schema's ratios except `auto` (else 1:1)
 *   resolution    `resolution` in the options, 1k or 2k (default 2k, the schema's)
 *   quality       `quality` in the options, low or medium (default medium, the schema's)
 * Not sent: `image` (picture editing; this task is text-to-image only), so
 * moodboard pictures are not sent either. The schema has no seed and no
 * output format.
 *
 * No backup service. fal lists `xai/grok-imagine-image/v2/text-to-image`
 * ("Generate an image using Grok Imagine Image 2.0", the same model by name),
 * but publishes no price for it (its model page's billing reads "$0 per
 * compute seconds", enterprise status "pending", read 2026-09-24) and no
 * OpenAPI document (the queue OpenAPI GET answers 404). A cost that can't be
 * known can't be covered, so it is not a backup until fal publishes one.
 * The older Grok Imagine (`grok-imagine`, xai/grok-imagine-image) is a
 * separate catalogue model and is not changed.
 */
import { arOr, optEnum } from './opts'
import type { ServiceCall } from './twins'

export const GROK_IMAGINE_2_ID = 'grok-imagine-2'
export const GROK_IMAGINE_2_SLUG = 'xai/grok-imagine-image-2'

/** xai/grok-imagine-image-2 `aspect_ratio` (its schema's enum), without `auto`. */
export const GROK_IMAGINE_2_RATIOS = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20',
] as const
const RATIOS: ReadonlySet<string> = new Set(GROK_IMAGINE_2_RATIOS)

/** The schema's `resolution` and `quality` enums, and its defaults. */
export const GROK_IMAGINE_2_RESOLUTIONS = ['1k', '2k'] as const
export const GROK_IMAGINE_2_QUALITIES = ['low', 'medium'] as const
export const GROK_IMAGINE_2_DEFAULT_RESOLUTION = '2k'
export const GROK_IMAGINE_2_DEFAULT_QUALITY = 'medium'

export function isGrokImagine2Model(model: unknown): boolean {
  return model === GROK_IMAGINE_2_ID
}

export interface GrokImagine2Args {
  prompt: string
  aspectRatio: string
  adv: Record<string, unknown>
}

/** "Generate an image" on Grok Imagine 2: the Replicate request. */
export function grokImagine2Generate({ prompt, aspectRatio, adv }: GrokImagine2Args): ServiceCall {
  return {
    provider: 'replicate',
    endpoint: GROK_IMAGINE_2_SLUG,
    payload: {
      prompt,
      aspect_ratio: arOr(RATIOS, aspectRatio, '1:1'),
      resolution: optEnum(adv, 'resolution', GROK_IMAGINE_2_RESOLUTIONS, GROK_IMAGINE_2_DEFAULT_RESOLUTION),
      quality: optEnum(adv, 'quality', GROK_IMAGINE_2_QUALITIES, GROK_IMAGINE_2_DEFAULT_QUALITY),
    },
  }
}
