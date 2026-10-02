/**
 * Generate an image's three Recraft SVG models in the runner (engine-free
 * step 3, R11.4, ruling (p)). Python asks Replicate for them and then fails
 * to decode the SVG as a picture (decision D4). The runner instead saves the
 * SVG the service made, as the user's file, and hands on its address (an
 * `svg` value, ./values.ts). Only Save image and Preview image read it
 * (eligibility.ts SVG_READER_INPUTS): Save image writes the SVG into its own
 * folder, Preview image shows it. Any other node wired to it needs pixels and
 * is refused before anything is held (eligibility.ts svgReaderProblems), with
 * SVG_NEEDS_PICTURE.
 *
 * Everything sits behind the family `recraft-svg` (needs `cards`). Off, the
 * models go to ComfyUI as before.
 *
 * Constants only, no imports: ./values.ts reads the model list.
 */

/** The runner family that takes the SVG models. */
export const SVG_IMAGE_FAMILY = 'recraft-svg' as const

/** Generate an image's SVG models (comfy_api_nodes/image_models.py, tags "svg"). */
export const SVG_IMAGE_MODEL_IDS = ['recraft-v4-pro-svg', 'recraft-v4-svg', 'recraft-v3-svg'] as const

const SVG_IDS: ReadonlySet<string> = new Set(SVG_IMAGE_MODEL_IDS)

/** Whether a Generate an image `model` value is one of the SVG models. */
export function isSvgImageModel(model: unknown): boolean {
  return typeof model === 'string' && SVG_IDS.has(model)
}

/** What a node that needs pixels says when an SVG is wired into it. */
export const SVG_NEEDS_PICTURE = 'This node needs a picture, not an SVG.'
