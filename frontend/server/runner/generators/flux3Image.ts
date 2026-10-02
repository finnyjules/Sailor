/**
 * FLUX 3 Image (Black Forest Labs; model line-up): runner-only, family
 * `flux-3-image`, on fal, text-to-image. Catalogue id `flux-3-image`, not
 * `flux-3`: that is FLUX 3's video model (app/data/video-models.ts). fal's
 * blackforestlabs/flux-3/edit-image is out of scope.
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/fal/blackforestlabs__flux-3__text-to-image.json,
 * read 2026-10-02): `blackforestlabs/flux-3/text-to-image`, fal's "Flux 3
 * Image", billed by the megapixel. fal runs a launch promotion until
 * 2026-10-08 ($0.024 a megapixel); the price is the full $0.048 a megapixel
 * (#shared/pricing/imageRates).
 *
 * It sends, from "Generate an image":
 *   prompt                   the composed prompt (style text as the other
 *                            image models); the schema requires one but sets
 *                            no minimum, so an empty one is refused before
 *                            sending (a ruling, requestRules.ts)
 *   aspect_ratio             one of the schema's ratios except `auto`
 *                            (FLUX_3_IMAGE_RATIOS; any other ratio is 1:1)
 *   resolution               "1k" or "2k", from the size (#shared/pricing/
 *                            imageSettings flux3ImageResolution, which the
 *                            price reads too; anything else 1K). The schema's
 *                            512sq, 768sq and 4k are not offered
 *   enable_prompt_expansion  false (the schema's default too): fal says
 *                            nothing about what it costs
 *   output_format            "png" (the schema's default is jpeg)
 * Not sent: `safety_tolerance` (the schema's default, 2, applies),
 * `sync_mode`, `version` (the schema's const "latest"). The schema has no
 * seed and no picture input, so the node's seed and moodboard pictures are
 * not sent.
 *
 * It is slow: fal's page and BFL's docs give no figure for 1k or 2k (4k "can
 * take several minutes"); 45 to 75 seconds a picture is expected, inside the
 * runner's 5-minute picture limit (#shared/runner/timeouts).
 *
 * No backup service. Replicate has FLUX 3 Image (black-forest-labs/
 * flux-3-image, billed per picture by resolution), but it is not wired here.
 */
import { flux3ImageResolution } from '#shared/pricing/imageSettings'
import { arOr } from './opts'
import type { ServiceCall } from './twins'

export const FLUX_3_IMAGE_ID = 'flux-3-image'
export const FLUX_3_IMAGE_FAL_APP = 'blackforestlabs/flux-3/text-to-image'
export const FLUX_3_IMAGE_FORMAT = 'png'

/** blackforestlabs/flux-3/text-to-image `aspect_ratio` (its schema's enum) without `auto`, in the catalogue's order. */
export const FLUX_3_IMAGE_RATIOS = [
  '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '7:5', '5:7', '2:1', '1:2', '21:9',
] as const
const RATIOS: ReadonlySet<string> = new Set(FLUX_3_IMAGE_RATIOS)

export const FLUX_3_IMAGE_NEEDS_PROMPT = 'FLUX 3 needs a prompt. Describe the picture you want.'

export function isFlux3ImageModel(model: unknown): boolean {
  return model === FLUX_3_IMAGE_ID
}

export interface Flux3ImageArgs {
  prompt: string
  aspectRatio: string
  adv: Record<string, unknown>
}

/** "Generate an image" on FLUX 3: the fal request. */
export function flux3ImageGenerate({ prompt, aspectRatio, adv }: Flux3ImageArgs): ServiceCall {
  return {
    provider: 'fal',
    endpoint: FLUX_3_IMAGE_FAL_APP,
    payload: {
      prompt,
      aspect_ratio: arOr(RATIOS, aspectRatio, '1:1'),
      resolution: flux3ImageResolution(adv).toLowerCase(),
      enable_prompt_expansion: false,
      output_format: FLUX_3_IMAGE_FORMAT,
    },
  }
}
