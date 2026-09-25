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
 * The older one-model video nodes (Veo 3, Kling 2.1, Seedance 2.0) and the
 * lip-sync nodes are their endpoint's per-second rate × the seconds they send
 * (clipRates.ts × clipSettings.ts); lip-sync at the longest clip it can make.
 *
 * Images (GenerateImageNode) are the first service's rate for the size,
 * quality and picture count the request carries (imageRates.ts ×
 * imageSettings.ts). A linked `model_options` is priced at the card's most
 * expensive request, a linked `aspect_ratio` at the largest picture. The catalogue decides which ids exist
 * (IMAGE_MODELS); an id with no rate card is refused as unpriced.
 *
 * Image edits (Edit image, Develop, Relight, Blend scene, the Nano Banana
 * actions, Generate from references, Rotate camera, Product shot, Restyle)
 * and the engine pickers (Upscale, Enhance detail) are the first service's
 * rate for the call the node's settings make (editRates.ts × editSettings.ts):
 * the resolution or size sent, and for the upscalers the largest accepted
 * input × the scale chosen. A linked or missing model on an edit node is
 * priced at the dearest model it offers, and a call with a fallback chain
 * (the ComfyUI path's Nano Banana edits) at the dearest step of it.
 *
 * `opts.inputPixels` is the measured size of the picture a size-priced node
 * (Upscale, Enhance detail, FLUX.2 edit) is sent, where the caller could see
 * it; without it the picture is priced at the cap (editSettings.ts). The
 * badge may show that ceiling while the charge reads the measured size, so
 * the badge is never below the charge.
 *
 * Relative imports on purpose: this module is loaded by Nitro, the Vue app
 * and vitest alike.
 */
import { IMAGE_MODELS } from '../../app/data/image-models'
import { LEGACY_VIDEO_MODEL_IDS } from '../../app/data/video-prices'
import { creditsForUsd } from './markup'
import { editMaxUsd, editStepsUsd } from './editRates'
import { SETTING_PRICED_NODE_CLASSES, editCalls, editSteps } from './editSettings'
import { imageMaxUsd, imageRate, imageUsd } from './imageRates'
import { LARGEST_RATIO, effectiveImageSettings } from './imageSettings'
import { videoMaxUsd, videoRate, videoUsd } from './videoRates'
import { REMOTE_VIDEO_NODE_CLASSES, remoteVideoNodeUsd } from './clipSettings'
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

/** The edit classes priced by their settings (editSettings.ts); they have no flat price. */
export { SETTING_PRICED_NODE_CLASSES }
const SETTING_PRICED_CLASS_SET: ReadonlySet<string> = new Set(SETTING_PRICED_NODE_CLASSES)

/**
 * Every class this module prices — model-priced and setting-priced. The
 * charge (priceGraph) and the node badge both price these through priceNode.
 */
export const SHARED_PRICED_CLASS_SET: ReadonlySet<string> = new Set([...MODEL_PRICED_NODE_CLASSES, ...SETTING_PRICED_NODE_CLASSES, ...REMOTE_VIDEO_NODE_CLASSES])

/** The older one-model video nodes and the lip-sync nodes, priced per second (clipSettings.ts). */
export { REMOTE_VIDEO_NODE_CLASSES }
const REMOTE_VIDEO_CLASS_SET: ReadonlySet<string> = new Set(REMOTE_VIDEO_NODE_CLASSES)

// Lazily-built lookup. Never derive this at module top level from another
// module's const: a top-level read breaks on import reorder.
let _imageIds: Set<string> | null = null
function isCatalogueImage(id: string): boolean {
  if (!_imageIds) _imageIds = new Set(IMAGE_MODELS.map(m => m.id))
  return _imageIds.has(id)
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
  const s = effectiveVideoSettings(id, inputs.duration, inputs.aspect_ratio, isLinkedInput(inputs.model_options) ? {} : inputs.model_options, inputs.image)
  if (!s) return null
  if (durationLinked) s.seconds = maxVideoSeconds(id)!
  if (isLinkedInput(inputs.model_options)) return videoMaxUsd(id, s.seconds)
  return videoUsd(id, s)
}

/**
 * Dollars for an image node as configured. The id must have a rate card.
 * Linked `model_options`: the card's most expensive request. A linked ratio:
 * the ratio with the largest picture.
 */
function imageNodeUsd(model: string, inputs: NodeInputs): number {
  if (isLinkedInput(inputs.model_options)) return imageMaxUsd(model)!
  const ratio = isLinkedInput(inputs.aspect_ratio) ? LARGEST_RATIO : inputs.aspect_ratio
  return imageUsd(model, effectiveImageSettings(model, ratio, inputs.model_options)!)!
}

/**
 * Dollars for an edit node or engine picker as configured: the dearest of the
 * calls its settings can make (one call unless the model is linked or
 * missing), or the refusal.
 */
function editNodeUsd(classType: string, inputs: NodeInputs, opts: PriceOptions): number | { refused: string } {
  // A node that runs several calls (RestyleWithLoRANode): all of them.
  const steps = editSteps(classType, inputs)
  if (steps) return editStepsUsd(steps) ?? { refused: `${classType} has a call with no listed price` }
  const c = editCalls(classType, inputs, { inputPixels: opts.inputPixels })
  if ('refused' in c) return c
  let usd = 0
  for (const one of c.calls) {
    const price = editMaxUsd(one)
    if (price == null) return { refused: `${one.endpoint} has no listed price` }
    usd = Math.max(usd, price)
  }
  return usd
}

/** What the caller measured about a node's run-time inputs. */
export interface PriceOptions {
  /** Pixels of the picture a size-priced node is sent (see editSettings.ts sizePricedInput). */
  inputPixels?: number | null
}

/**
 * A priced node, or the reason it can't be priced (the server refuses it).
 *
 * `usd` is the PRICE BASIS in dollars — always `credits = creditsForUsd(usd)`.
 * For one plain call it is what the first service charges. It is NOT the
 * provider's cost when the node covers a fallback chain at cost or runs
 * several calls (editRates.ts editMaxUsd / editStepsUsd): there it can sit
 * above or below the first service's price. Never show it as "cost". Where
 * it reaches a screen today: the hosted run-confirm dialog's rows
 * (default.vue, `formatCostBadge(item.usd, …)`), which turn it back into
 * credits, the same figure as the charge; nothing shows it as dollars.
 */
export type NodePrice =
  | { usd: number; credits: number }
  | { refused: string }

/**
 * The core calculation. `refused` carries the reason the server puts in its
 * UnpricedGraphError; the badge and estimate treat it as "no price".
 */
export function priceNode(classType: string, inputs: NodeInputs | null | undefined, opts: PriceOptions = {}): NodePrice {
  if (SETTING_PRICED_CLASS_SET.has(classType)) {
    const usd = editNodeUsd(classType, inputs ?? {}, opts)
    return typeof usd === 'number' ? { usd, credits: creditsForUsd(usd) } : usd
  }
  if (REMOTE_VIDEO_CLASS_SET.has(classType)) {
    const usd = remoteVideoNodeUsd(classType, inputs ?? {})
    return usd == null ? { refused: `${classType} has a call with no listed price` } : { usd, credits: creditsForUsd(usd) }
  }
  if (!MODEL_PRICED_CLASS_SET.has(classType)) return { refused: 'not a model-priced class' }
  const picked = inputs?.model
  const model = typeof picked === 'string' ? picked : ''
  if (!model) return { refused: 'no model selected' }

  let usd: number
  if (classType === 'GenerateImageNode') {
    if (!isCatalogueImage(model)) return { refused: `unknown model id ${model}` }
    if (!imageRate(model)) return { refused: `model ${model} has no listed price` }
    usd = imageNodeUsd(model, inputs!)
  }
  else if (classType === 'GenerateVideoNode' || classType === 'FilmShotNode') {
    const price = videoNodeUsd(model, inputs!)
    if (price == null) return { refused: `unknown video model id ${model}` }
    usd = price
  }
  else {
    // Engine pickers (UpscaleImageNode / EnhanceDetailNode): the `model`
    // widget names an engine, priced by the output size it makes from the
    // largest accepted input.
    const price = editNodeUsd(classType, inputs!, opts)
    if (typeof price !== 'number') return price
    usd = price
  }
  return { usd, credits: creditsForUsd(usd) }
}

/**
 * The node's price basis in USD (see NodePrice): the service's charge for a
 * plain call, not a cost figure for chained or multi-call nodes. Or null.
 */
export function providerUsd(classType: string, inputs: NodeInputs | null | undefined, opts: PriceOptions = {}): number | null {
  const p = priceNode(classType, inputs, opts)
  return 'refused' in p ? null : p.usd
}

/** Credits we charge for this node as configured (markup applied), or null. */
export function nodeCredits(classType: string, inputs: NodeInputs | null | undefined, opts: PriceOptions = {}): number | null {
  const p = priceNode(classType, inputs, opts)
  return 'refused' in p ? null : p.credits
}
