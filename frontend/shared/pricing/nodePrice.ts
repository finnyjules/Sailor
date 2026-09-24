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
 * object).
 *
 * Video (GenerateVideoNode, FilmShotNode) is the first service's rate × the
 * seconds the request carries, at the resolution and sound setting it carries
 * (videoRates.ts × videoSettings.ts). An input that is LINKED rather than set
 * (the API prompt carries a `[nodeId, slot]` reference, whose value is only
 * known at run time) is priced at its most expensive: a linked duration at the
 * model's longest clip, linked `model_options` at the card's dearest rate.
 * The badge marks linked widgets the same way (app/lib/costEstimate.ts), so
 * the badge and the charge agree.
 *
 * Images and the engine pickers read IMAGE_MODELS.pricePerImage and
 * ENGINE_USD. Relative imports on purpose: this module is loaded by Nitro,
 * the Vue app and vitest alike.
 */
import { IMAGE_MODELS } from '../../app/data/image-models'
import { LEGACY_VIDEO_MODEL_IDS } from '../../app/data/video-prices'
import { ENGINE_USD } from '../../app/data/engine-prices'
import { creditsForUsd } from './markup'
import { videoMaxUsd, videoRate, videoUsd } from './videoRates'
import { effectiveVideoSettings, maxVideoSeconds } from './videoSettings'

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

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** An API-prompt link reference (`[nodeId, slot]`): the value arrives at run time. */
export function isLinkedInput(v: unknown): boolean {
  return Array.isArray(v)
}

/** The video model a node's `model` value runs: the legacy labels still remap. */
export function videoModelIdFor(model: string): string {
  return hasOwn(LEGACY_VIDEO_MODEL_IDS, model) ? LEGACY_VIDEO_MODEL_IDS[model]! : model
}

/** Dollars for a video node as configured, or null for an unknown model. */
function videoNodeUsd(model: string, inputs: NodeInputs): number | null {
  const id = videoModelIdFor(model)
  if (!videoRate(id)) return null
  const durationLinked = isLinkedInput(inputs.duration)
  const s = effectiveVideoSettings(id, inputs.duration, inputs.aspect_ratio, isLinkedInput(inputs.model_options) ? {} : inputs.model_options)
  if (!s) return null
  if (durationLinked) s.seconds = maxVideoSeconds(id)!
  if (isLinkedInput(inputs.model_options)) return videoMaxUsd(id, s.seconds)
  return videoUsd(id, s)
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
    const price = videoNodeUsd(model, inputs!)
    if (price == null) return { refused: `unknown video model id ${model}` }
    usd = price
  }
  else {
    // Engine pickers (UpscaleImageNode / EnhanceDetailNode): the `model`
    // widget names an engine, not a catalogue id.
    const table = ENGINE_USD[classType]
    const price = table && hasOwn(table, model) ? table[model] : undefined
    if (typeof price !== 'number') return { refused: `unknown engine ${model}` }
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
