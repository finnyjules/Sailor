/**
 * One price calculation for a model-priced node — what the service charges us
 * in dollars, and the credits we charge for it.
 *
 * Three places read this and nothing else:
 *   - the charge: `priceGraph` in server/utils/priceBook.ts (both the runner
 *     and the ComfyUI meter go through it);
 *   - the node badge: app/lib/nodeCreditEstimate.ts, used by ComfyNode.vue;
 *   - the run estimate: `estimateUsdForNodes` in app/lib/costEstimate.ts.
 *
 * `inputs` is the node's WHOLE input map — widget name → value, as the API
 * prompt carries it (`model_options` may be the JSON text or the parsed
 * object). Today only `model` moves the price; later tasks price on the
 * resolution, clip length and sound setting read from the same map, so every
 * caller already passes all of it.
 *
 * Figures come from the same catalogues as before (IMAGE_MODELS.pricePerImage,
 * VIDEO_MODEL_USD with its legacy remap, ENGINE_USD). Relative imports on
 * purpose: this module is loaded by Nitro, the Vue app and vitest alike.
 */
import { IMAGE_MODELS } from '../../app/data/image-models'
import { VIDEO_MODEL_USD, LEGACY_VIDEO_MODEL_IDS } from '../../app/data/video-prices'
import { ENGINE_USD } from '../../app/data/engine-prices'
import { creditsForUsd } from './markup'

export type NodeInputs = Record<string, unknown>

/**
 * Classes whose price depends on a model/engine widget. The server refuses
 * one whose model is missing or unknown. The one list: the server's
 * MODEL_PRICED_NODE_CLASSES and the badge's MODEL_PRICED_BADGE_CLASSES both
 * re-export it.
 */
export const MODEL_PRICED_NODE_CLASSES: string[] = [
  'GenerateImageNode',
  'GenerateVideoNode',
  'FilmShotNode',
  'UpscaleImageNode',
  'EnhanceDetailNode',
]

/** Same classes as a set, for "is this one of them?" checks. */
export const MODEL_PRICED_CLASS_SET: ReadonlySet<string> = new Set(MODEL_PRICED_NODE_CLASSES)

// Lazily-built lookup. Never derive this at module top level from another
// module's const: a top-level read breaks on import reorder.
let _imagePrices: Map<string, number | null> | null = null
function imagePriceFor(id: string): number | null | undefined {
  if (!_imagePrices) _imagePrices = new Map(IMAGE_MODELS.map(m => [m.id, m.pricePerImage]))
  return _imagePrices.get(id)
}

/** A priced node, or the reason it can't be priced (the server refuses it). */
export type NodePrice =
  | { usd: number; credits: number }
  | { refused: string }

/**
 * The core calculation. `refused` carries the reason the server puts in its
 * UnpricedGraphError; the badge and estimate treat it as "no price".
 */
export function priceNode(classType: string, inputs: NodeInputs | null | undefined): NodePrice {
  if (!MODEL_PRICED_CLASS_SET.has(classType)) return { refused: 'not a model-priced class' }
  const picked = inputs?.model
  const model = typeof picked === 'string' ? picked : ''
  if (!model) return { refused: 'no model selected' }

  let usd: number
  if (classType === 'GenerateImageNode') {
    const price = imagePriceFor(model)
    if (price === undefined) return { refused: `unknown model id ${model}` }
    if (price == null) return { refused: `model ${model} has no listed price` }
    usd = price
  }
  else if (classType === 'GenerateVideoNode' || classType === 'FilmShotNode') {
    const id = LEGACY_VIDEO_MODEL_IDS[model] ?? model
    const row = VIDEO_MODEL_USD[id]
    if (!row) return { refused: `unknown video model id ${model}` }
    usd = row.usd
  }
  else {
    // Engine pickers (UpscaleImageNode / EnhanceDetailNode): the `model`
    // widget names an engine, not a catalogue id.
    const price = ENGINE_USD[classType]?.[model]
    if (price == null) return { refused: `unknown engine ${model}` }
    usd = price
  }
  return { usd, credits: creditsForUsd(usd) }
}

/** What the service charges us in USD for this node as configured, or null. */
export function providerUsd(classType: string, inputs: NodeInputs | null | undefined): number | null {
  const p = priceNode(classType, inputs)
  return 'refused' in p ? null : p.usd
}

/** Credits we charge for this node as configured (markup applied), or null. */
export function nodeCredits(classType: string, inputs: NodeInputs | null | undefined): number | null {
  const p = priceNode(classType, inputs)
  return 'refused' in p ? null : p.credits
}
