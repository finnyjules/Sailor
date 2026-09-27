/**
 * Layers from one call, and outpaint (step 3, R3.6, family `layers`): what
 * the runner (server/runner/generators/layers.ts), the rule rows
 * (./eligibility.ts) and the price module (shared/pricing/paidSettings.ts)
 * all read about three classes of comfy_api_nodes/nodes_replicate.py:
 *
 *  - LayerizeGraphicNode ("Separate text from image", :4456): Replicate
 *    `ideogram-ai/layerize`, one call; its picture and a JSON link, picked
 *    by extension;
 *  - SeedreamLayerizeNode ("Layerize an image", :4661): fal
 *    `bytedance/seedream/v5/pro/layerize`, one call; each layer downloaded
 *    and saved to the input folder (seedream_layerize.py);
 *  - OutpaintImageNode ("Expand / outpaint an image", :4731): Replicate Flux
 *    Fill Pro or Bria Expand by its engine, one call.
 *
 * Separate background and foreground (R3.7) is in the same family but not
 * here. Pure; relative imports only.
 */

export const LAYERIZE_SLUG = 'ideogram-ai/layerize'
export const SEEDREAM_LAYERIZE_APP = 'bytedance/seedream/v5/pro/layerize'
export const FLUX_FILL_SLUG = 'black-forest-labs/flux-fill-pro'
export const BRIA_EXPAND_SLUG = 'bria/expand-image'

/** The three classes, in the order the task lists them. */
export const LAYERS_CLASSES = ['LayerizeGraphicNode', 'SeedreamLayerizeNode', 'OutpaintImageNode'] as const
export type LayersClass = typeof LAYERS_CLASSES[number]

/** The two that hand on the layers' JSON on their slot 1 (a `json` value while `layers` is on). */
export const LAYERS_JSON_CLASSES = ['LayerizeGraphicNode', 'SeedreamLayerizeNode'] as const

/** Layerize's only engine (its `model` combo). */
export const LAYERIZE_MODELS = ['Ideogram Layerize'] as const

/** Seedream's `image_size` options (`_IMAGE_SIZES`); anything else is sent as `auto`. */
export const SEEDREAM_IMAGE_SIZES = ['auto', 'auto_1K', 'auto_1.5K', 'auto_2K'] as const

/** Outpaint's engines and the slug each calls. */
export const OUTPAINT_SLUGS = { 'Flux Fill': FLUX_FILL_SLUG, 'Bria Expand': BRIA_EXPAND_SLUG } as const
export type OutpaintModel = keyof typeof OUTPAINT_SLUGS
export const OUTPAINT_MODELS = Object.keys(OUTPAINT_SLUGS) as OutpaintModel[]
/** `_OUTPAINT_DIRECTIONS` (Flux Fill) and `_OUTPAINT_ASPECT_RATIOS` (Bria Expand), in the node's order. */
export const OUTPAINT_DIRECTIONS = ['Zoom out 1.5x', 'Zoom out 2x', 'Make square', 'Left outpaint', 'Right outpaint', 'Top outpaint', 'Bottom outpaint'] as const
export const OUTPAINT_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'] as const

/**
 * The most pictures one Seedream call makes: the base and up to 16 layers
 * (fal's schema: "The base image followed by up to 16 separated layers").
 * fal bills each one (`billing_unit: images`), so the hold is this many.
 */
export const SEEDREAM_MAX_IMAGES = 17

/**
 * The area fal's page prices a Seedream layer by: "$0.03375 per generated
 * layer for total pixel area under 1536x1536", $0.0675 over (paidRates.ts).
 */
export const SEEDREAM_SMALL_AREA = 1536 * 1536

/**
 * The output area `auto_1K` is held at: its 1K tier makes pictures of about
 * a megapixel, under SEEDREAM_SMALL_AREA whatever their shape. Every other
 * size (`auto` follows the input) is held at the dearer rate.
 */
export const SEEDREAM_1K_AREA = 1024 * 1024
