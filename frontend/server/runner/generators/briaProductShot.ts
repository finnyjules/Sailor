/**
 * Product shot on Bria Product Shot (model line-up, Task F12): family
 * `bria-product-shot`, fal, no backup. While the family is on,
 * ProductShotNode runs this and only in the runner (Ruling 10: saved nodes
 * move to the new model, user approved retiring the SDXL-era tools); off,
 * the node runs on ComfyUI as before (its SDXL call, refEdits.ts
 * productShotInput, which the runner no longer takes: model line-up H2).
 *
 * One endpoint, written from its saved schema
 * (tests/unit/fixtures/provider-schemas/fal/fal-ai__bria__product-shot.json,
 * read 2026-09-24; `x-fal-metadata.endpointId` is this id):
 *   image_url                  the product picture (Bria cuts it out itself)
 *   scene_description          the node's scene, stripped; empty is the
 *                              node's default scene, as on the SDXL path
 *                              (nodes_replicate.py _PRODUCT_SHOT_DEFAULT_PROMPT)
 *   placement_type             manual_placement, the schema's default: the
 *                              product is placed in a picture of `shot_size`
 *   manual_placement_selection bottom_center, the schema's default: the
 *                              product stands on the scene's floor or surface
 *   shot_size                  the node's aspect, as the sizes the SDXL path
 *                              made (_PRODUCT_SHOT_ASPECTS: Square 1024 × 1024,
 *                              Portrait 832 × 1216, Landscape 1216 × 832),
 *                              each about the 1 MP the schema asks for. An
 *                              unknown aspect is Square, as there
 *   num_results                1 (one placement × one result = one picture,
 *                              what the price charges)
 * Not sent: `fast` and `optimize_description` (the schema's defaults, true),
 * `ref_image_url` (the node has no scene picture: "either ref_image_url or
 * scene_description … but not both"), `padding_values`, `original_quality`
 * (manual padding and the original placement only) and `sync_mode`.
 *
 * Settings Bria can't honour, hidden from the node while the family is on
 * (eligibility.ts ProductShotNode `upgrade.hiddenWidgets`) and not sent:
 *   product_size        how much of the frame the product fills. Bria sizes
 *                       the product itself; its only size control is
 *                       padding in pixels around the cut-out, which needs the
 *                       cut-out's size, unknown before the call
 *   keep_product_exact  Bria always keeps the product's own pixels ("while
 *                       maintaining high integrity of the product"): there
 *                       is no switch, so a saved "off" also keeps it
 *   seed                the schema takes none
 *
 * No backup service: Replicate has no Bria Product Shot (model GET
 * bria/product-shot: not found; search "bria product shot", 2026-09-24).
 * bria/generate-background is another model (a background swap, with no
 * placement or shot size), so it can't carry these settings (S3: a backup
 * only for the same model).
 */
import { BRIA_PRODUCT_SHOT_APP } from '#shared/pricing/editSettings'
import { pyStrip } from './opts'
import { PRODUCT_SHOT_DEFAULT_PROMPT } from './refEdits'
import type { ServiceCall } from './twins'

export { BRIA_PRODUCT_SHOT_APP }

/** The node's aspect → Bria's `shot_size` [width, height]: the sizes the SDXL path made. */
export const BRIA_SHOT_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  Square: [1024, 1024],
  Portrait: [832, 1216],
  Landscape: [1216, 832],
}

/** The fal request for one product shot. `aspect` as the node holds it (an unknown one is Square). */
export function briaProductShot(o: { image: string; scenePrompt: string; aspect: unknown }): ServiceCall {
  const size = typeof o.aspect === 'string' && Object.prototype.hasOwnProperty.call(BRIA_SHOT_SIZES, o.aspect)
    ? BRIA_SHOT_SIZES[o.aspect]!
    : BRIA_SHOT_SIZES.Square!
  return {
    provider: 'fal',
    endpoint: BRIA_PRODUCT_SHOT_APP,
    payload: {
      image_url: o.image,
      scene_description: pyStrip(o.scenePrompt) || PRODUCT_SHOT_DEFAULT_PROMPT,
      placement_type: 'manual_placement',
      manual_placement_selection: 'bottom_center',
      shot_size: [size[0], size[1]],
      num_results: 1,
    },
  }
}
