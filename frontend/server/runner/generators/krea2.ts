/**
 * Krea 2 Large and Krea 2 Medium (Krea; model line-up, Task F17), family
 * `krea-2`, text-to-image. NOT runner-only: both already run on the ComfyUI
 * path through their Python builders (comfy_api_nodes/image_models.py
 * `_fal_krea2`, fal first, `_b_krea2` on Replicate behind it). With the
 * family off nothing changes there; with it on, a "Generate an image" node
 * the runner can take goes to these builders instead.
 *
 * Four endpoints, one builder per service, written from their saved schemas
 * (tests/unit/fixtures/provider-schemas/, read 2026-09-25):
 *
 *   fal (first)    krea/v2/large/text-to-image, krea/v2/medium/text-to-image
 *                  (no `fal-ai/` prefix; "$0.060" / "$0.030" per image for
 *                  text-to-image, "$0.065" / "$0.035" with style references,
 *                  their llms.txt)
 *   Replicate      krea/krea-2-large, krea/krea-2-medium (Krea's own,
 *   (the backup)   official; billing "$0.06" / "$0.03" per output image for
 *                  text to image, more with style references or a moodboard)
 *
 * The same model on both at the same text-to-image price, so fal is first,
 * as Python's `primary="fal"`, and Replicate is the backup at every setting.
 *
 * It sends fal, from "Generate an image":
 *   prompt        the composed prompt (style text as the other image models);
 *                 1 to 5,000 characters (the schema's minLength and
 *                 maxLength, refused before sending: requestRules.ts)
 *   aspect_ratio  one of the schema's ratios (KREA_2_RATIOS; any other is 1:1)
 *   creativity    `creativity` from the options, one of raw / low / medium /
 *                 high (else medium, the schema's default)
 *   seed          the node's seed, when above 0
 * Not sent: `image_style_references`, `styles` and `moodboards` (the style
 * pictures cost more and the node sends none, as Python; the schema's empty
 * defaults apply). So the node's moodboard pictures are not sent.
 *
 * The backup (`krea2OnReplicate`) is built from the fal request: the same
 * four fields under the same names (Replicate's schema lists the same ratios
 * and creativity values, and takes a seed).
 */
import { arOr, maybeSetSeed, optEnum } from './opts'
import type { ServiceCall } from './twins'

export const KREA_2_FAL_APPS = {
  'krea-2-large': 'krea/v2/large/text-to-image',
  'krea-2-medium': 'krea/v2/medium/text-to-image',
} as const
export const KREA_2_REPLICATE_SLUGS = {
  'krea-2-large': 'krea/krea-2-large',
  'krea-2-medium': 'krea/krea-2-medium',
} as const
export type Krea2Id = keyof typeof KREA_2_FAL_APPS
export const KREA_2_IDS = Object.keys(KREA_2_FAL_APPS) as Krea2Id[]

/** `aspect_ratio` on both services (their schemas' enum, the same list). */
export const KREA_2_RATIOS = ['1:1', '4:3', '3:2', '16:9', '2.35:1', '4:5', '2:3', '9:16'] as const
const RATIOS: ReadonlySet<string> = new Set(KREA_2_RATIOS)
/** `creativity` on both services (their schemas' enum). */
export const KREA_2_CREATIVITY = ['raw', 'low', 'medium', 'high'] as const
export const KREA_2_DEFAULT_CREATIVITY = 'medium'

/** krea/v2/{large,medium}/text-to-image `prompt.maxLength`. */
export const KREA_2_PROMPT_MAX = 5000
export const KREA_2_NEEDS_PROMPT = 'Krea 2 needs a prompt. Describe the picture you want.'
export const KREA_2_LONG_PROMPT = 'Krea 2 takes a prompt of at most 5,000 characters. Shorten it.'

export function isKrea2Model(model: unknown): model is Krea2Id {
  return typeof model === 'string' && Object.prototype.hasOwnProperty.call(KREA_2_FAL_APPS, model)
}

export interface Krea2Args {
  model: Krea2Id
  prompt: string
  aspectRatio: string
  seed: number
  adv: Record<string, unknown>
}

/** "Generate an image" on Krea 2: the fal request. */
export function krea2Generate({ model, prompt, aspectRatio, seed, adv }: Krea2Args): ServiceCall {
  const payload: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(RATIOS, aspectRatio, '1:1'),
    creativity: optEnum(adv, 'creativity', KREA_2_CREATIVITY, KREA_2_DEFAULT_CREATIVITY),
  }
  maybeSetSeed(payload, seed)
  return { provider: 'fal', endpoint: KREA_2_FAL_APPS[model], payload }
}

/**
 * The same request on Replicate, built from the fal one: the same fields
 * under the same names. Anything Replicate can't carry throws, rather than
 * send the backup something the first request never asked for.
 */
export function krea2OnReplicate(fal: ServiceCall): ServiceCall {
  const p = fal.payload
  const bad = (field: string) => new Error(`Krea 2 backup: the fal request's ${field} is not what Replicate can carry`)
  const id = KREA_2_IDS.find(k => KREA_2_FAL_APPS[k] === fal.endpoint)
  if (fal.provider !== 'fal' || !id) throw bad('endpoint')
  if (typeof p.prompt !== 'string') throw bad('prompt')
  if (typeof p.aspect_ratio !== 'string' || !RATIOS.has(p.aspect_ratio)) throw bad('aspect_ratio')
  if (typeof p.creativity !== 'string' || !(KREA_2_CREATIVITY as readonly string[]).includes(p.creativity)) throw bad('creativity')
  if ('seed' in p && !Number.isInteger(p.seed)) throw bad('seed')
  const extra = Object.keys(p).filter(k => !['prompt', 'aspect_ratio', 'creativity', 'seed'].includes(k))
  if (extra.length) throw bad(extra.join(', '))
  return { provider: 'replicate', endpoint: KREA_2_REPLICATE_SLUGS[id], payload: { ...p } }
}
