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
 * (videoRates.ts × videoSettings.ts). A model with a backup service
 * (server/runner/generators/twins.ts) is priced at the first service with the
 * markup, or the backup at cost, whichever is higher; the same for images and
 * edits (their cards' `videoPriceUsd`, `imagePriceUsd`, `editMaxUsd`). An input that is LINKED rather than set
 * (the API prompt carries a `[nodeId, slot]` reference, whose value is only
 * known at run time) is priced at its most expensive: a linked duration at the
 * model's longest clip, linked `model_options` at the card's dearest rate.
 * The badge marks linked widgets the same way (app/lib/costEstimate.ts), so
 * the badge and the charge agree.
 *
 * The older one-model video nodes (Veo 3, Kling 2.1, Seedance 2.0) and the
 * lip-sync nodes are their endpoint's per-second rate × the seconds they send
 * (clipRates.ts × clipSettings.ts); lip-sync by the measured clip
 * (`opts.inputSeconds`), else the 60 s cap.
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
 * The paid-model classes (step 3, R3: PAID_NODE_CLASSES) are priced by the
 * calls their settings can make (paidSettings.ts paidCalls) on the paid
 * cards (paidRates.ts): each call's price basis turned into credits on its
 * own, summed (paidStepsPrice). A text model's hold is its ceiling; given
 * `opts.answerUsage` it is priced as used, never above that ceiling.
 *
 * Relative imports on purpose: this module is loaded by Nitro, the Vue app
 * and vitest alike.
 */
import { IMAGE_MODELS } from '../../app/data/image-models'
import { LEGACY_VIDEO_MODEL_IDS } from '../../app/data/video-prices'
import { creditsForUsd, usdChargedAtCost } from './markup'
import { callCredits, callsCredits, pipelineCallsOf } from './pipelinePrice'
import { paidCallUsd } from './paidRates'
import { PAID_NODE_CLASSES, paidCalls, type PaidCalls } from './paidSettings'
import { editMaxUsd } from './editRates'
import { SETTING_PRICED_NODE_CLASSES, editCalls } from './editSettings'
import { imagePriceMaxUsd, imagePriceUsd, imageRate } from './imageRates'
import { LARGEST_RATIO, effectiveImageSettings } from './imageSettings'
import { videoPriceMaxUsd, videoPriceUsd, videoRate } from './videoRates'
import { REMOTE_VIDEO_NODE_CLASSES, billedSeconds, personSwapVideoUsd, remoteVideoNodeUsd, topazVideoUsd, type InputSeconds } from './clipSettings'
import { effectiveVideoSettings, maxVideoSeconds } from './videoSettings'
import type { RunnerFamily } from '../runner/families'
import { BG_REMOVE_CLASS, BG_REMOVE_SLUG, OBJECT_REMOVE_CLASS, OBJECT_REMOVE_SLUG, isLocalModelClass, localModelCalls, localModelOn } from '../runner/localModels'

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

/** The paid-model classes (step 3, R3) priced by their calls (paidSettings.ts); filled by each R3 task. */
export { PAID_NODE_CLASSES }
const PAID_CLASS_SET: ReadonlySet<string> = new Set(PAID_NODE_CLASSES)

/**
 * Every class this module prices — model-priced, setting-priced and paid. The
 * charge (priceGraph) and the node badge both price these through priceNode.
 */
export const SHARED_PRICED_CLASS_SET: ReadonlySet<string> = new Set([...MODEL_PRICED_NODE_CLASSES, ...SETTING_PRICED_NODE_CLASSES, ...REMOTE_VIDEO_NODE_CLASSES, ...PAID_NODE_CLASSES])

/**
 * Classes priced here only while a runner family moves them onto another
 * service (Ruling 10), each with that family: "Enhance a video" on fal's
 * Topaz while topaz-video is on (model line-up F23), per second of the video
 * the runner measured (clipSettings.ts topazVideoCalls). With the family off
 * the class keeps its flat price (server/utils/priceBook.ts
 * GRAPH_NODE_CREDITS) and priceNode refuses it as "not a model-priced class",
 * as before.
 *
 * PersonSwapVideo (family person-swap-video) has no flat price and no
 * ComfyUI path at all (like FaceSwap and FixFacesNode): it is priced here
 * only, and unpriced with the family off (there is nothing to run then).
 */
export const FAMILY_PRICED_CLASSES: Readonly<Record<string, RunnerFamily>> = {
  EnhanceVideoNode: 'topaz-video',
  PersonSwapVideo: 'person-swap-video',
  // (R7's local-model nodes are priced here too while their family is on: familyPricedClass reads
  // shared/runner/localModels.ts. They had no flat price: they were free, on this computer.)
}

/** Whether `classType` is priced here with these families on (FAMILY_PRICED_CLASSES). */
export function familyPricedClass(classType: string, families: ReadonlySet<RunnerFamily> | undefined): boolean {
  // R7: a local-model node, with its whole chain on (its family needs `cards`).
  if (isLocalModelClass(classType)) return localModelOn(classType, families)
  const family = hasOwn(FAMILY_PRICED_CLASSES, classType) ? FAMILY_PRICED_CLASSES[classType] : undefined
  return !!family && !!families?.has(family)
}

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

/** VEED Fabric 1.0 (shared/runner/eligibility.ts FABRIC_VIDEO_MODEL_ID; not imported: the price module stays below the runner). */
const FABRIC_VIDEO_MODEL_ID = 'fabric-1.0'

/**
 * Dollars for a video node as configured, or null for an unknown model.
 * Fabric (R11.2, Generate a video on the runner) makes a clip as long as its
 * sound: priced on the sound's measured seconds, or the bound its maker gives
 * before the run (`audioUpTo`), never above Python's 60 s; unmeasured, 60 s.
 */
function videoNodeUsd(model: string, inputs: NodeInputs, measured?: InputSeconds | null): number | null {
  const id = videoModelIdFor(model)
  if (!videoRate(id)) return null
  const durationLinked = isLinkedInput(inputs.duration)
  const s = effectiveVideoSettings(id, inputs.duration, inputs.aspect_ratio, isLinkedInput(inputs.model_options) ? {} : inputs.model_options, inputs.image)
  if (!s) return null
  if (durationLinked) s.seconds = maxVideoSeconds(id)!
  if (id === FABRIC_VIDEO_MODEL_ID && measured) s.seconds = billedSeconds(measured.audio ?? measured.audioUpTo, s.seconds)
  if (isLinkedInput(inputs.model_options)) return videoPriceMaxUsd(id, s.seconds)
  return videoPriceUsd(id, s)
}

/**
 * Dollars for an image node as configured. The id must have a rate card.
 * Linked `model_options`: the card's most expensive request. A linked ratio:
 * the ratio with the largest picture.
 */
function imageNodeUsd(model: string, inputs: NodeInputs): number {
  if (isLinkedInput(inputs.model_options)) return imagePriceMaxUsd(model)!
  const ratio = isLinkedInput(inputs.aspect_ratio) ? LARGEST_RATIO : inputs.aspect_ratio
  return imagePriceUsd(model, effectiveImageSettings(model, ratio, inputs.model_options)!)!
}

/**
 * Dollars for an edit node or engine picker as configured: the dearest of the
 * calls its settings can make (one call unless the model is linked or
 * missing), or the refusal.
 */
function editNodeUsd(classType: string, inputs: NodeInputs, opts: PriceOptions): number | { refused: string } {
  const c = editCalls(classType, inputs, { inputPixels: opts.inputPixels, families: opts.families })
  if ('refused' in c) return c
  let usd = 0
  for (const one of c.calls) {
    const price = editMaxUsd(one)
    if (price == null) return { refused: `${one.endpoint} has no listed price` }
    usd = Math.max(usd, price)
  }
  return usd
}

/**
 * Blend scene's kept subject, cleaned (R8.1 live-check fix): with keep_subject
 * wired and both Background remove (bg-remove) and Object removal
 * (object-remove) on, the runner finds the model's own redrawn copy of the
 * kept subject in the answer (a background-remover call), fills it and the
 * kept region from the relit scene (a LaMa call), and lays the original on
 * top, so one subject is left. Those two calls are priced here, each marked
 * up on its own (callCredits), on top of the blend's own call. The ComfyUI
 * path never passes `families`, so it never prices them (it makes one call).
 */
export function blendKeepCleanOn(inputs: NodeInputs, families: ReadonlySet<RunnerFamily> | undefined): boolean {
  return isLinkedInput(inputs.keep_subject) && localModelOn(BG_REMOVE_CLASS, families) && localModelOn(OBJECT_REMOVE_CLASS, families)
}

/** The three calls of a cleaned kept subject (the blend, the cut-out, the fill), in dollars; null when not cleaned. */
export function blendKeepCleanCalls(inputs: NodeInputs, opts: PriceOptions): { blend: number; cutout: number; fill: number } | { refused: string } | null {
  if (!blendKeepCleanOn(inputs, opts.families)) return null
  const blend = editNodeUsd('BlendSceneNode', inputs, opts)
  if (typeof blend !== 'number') return blend
  const cutout = paidCallUsd({ endpoint: BG_REMOVE_SLUG })
  const fill = paidCallUsd({ endpoint: OBJECT_REMOVE_SLUG })
  if (cutout == null || fill == null) return { refused: 'Keeping the subject clean has no listed price' }
  return { blend, cutout, fill }
}

/** What the caller measured about a node's run-time inputs. */
export interface PriceOptions {
  /** Pixels of the picture a size-priced node is sent (see editSettings.ts sizePricedInput). */
  inputPixels?: number | null
  /**
   * Seconds of a lip-sync node's sound clip (and Kling lip-sync's source
   * video), where the caller measured them (clipSettings.ts InputSeconds);
   * unmeasured, the 60 s cap.
   */
  inputSeconds?: InputSeconds | null
  /**
   * The runner families switched on, where the node may run in the runner.
   * Only a class moved onto a newer model as a whole reads them (Rotate
   * camera on Qwen Image Edit 2511, Task F10; Enhance a video on fal's Topaz,
   * F23, which also reads `inputSeconds`' video size and frame rate); none,
   * it prices as before.
   */
  families?: ReadonlySet<RunnerFamily>
  /**
   * UTF-8 bytes of the user's text a paid text node sends, where the caller
   * measured them (a wired text at the node's turn): tokenCeiling
   * (paidSettings.ts) counts them in place of the texts it can read.
   */
  inputBytes?: number
  /**
   * Whether the price is for hosted Sailor, where each moderated text is at
   * most MODERATION_MAX_INPUT_BYTES (tokenCeiling caps it there); locally a
   * text is counted whole.
   */
  hosted?: boolean
  /**
   * The tokens a paid text node's answer reported, for the charge
   * (ruling (c)); priceNode never prices it above the node's hold.
   */
  answerUsage?: { inputTokens: number; outputTokens: number }
  /**
   * The characters a speech node's text sent (Python's `len`, R3.8), for the
   * charge: a wired text is held at its ceiling and charged what it sent;
   * priceNode never prices it above the hold.
   */
  inputChars?: number
}

/**
 * A paid node's price from its calls: each call's price basis
 * (paidRates.ts paidCallUsd, fallbacks at cost) turned into credits on its
 * own and summed, `times` over (pipelinePrice.ts callCredits, the R3.1
 * ruling), never the markup of the summed dollars. `usd` is the price basis
 * those credits came from (`shownUsd`: the summed basis when it marks up to
 * them, as for one call, else the basis that does), so every reader that
 * marks `usd` up — the hosted run-confirm dialog's row (costEstimate.ts →
 * default.vue formatCostBadge) — shows the credits held (R3.14 fix round 1).
 * `times` must be a whole number ≥ 1 (a planner bug is refused, never priced).
 */
export function paidStepsPrice(p: PaidCalls): NodePrice {
  if ('refused' in p) return p
  let usd = 0
  let credits = 0
  for (const { call, times } of p.steps) {
    if (!Number.isInteger(times) || times < 1) return { refused: `${call.endpoint} is planned to run ${times} times; a call runs a whole number of times, at least once` }
    const basis = paidCallUsd(call)
    if (basis == null) return { refused: `${call.endpoint} has no listed price` }
    usd += basis * times
    credits += callCredits({ usd: basis }) * times
  }
  return { usd: shownUsd(Math.round(usd * 1e8) / 1e8, credits), credits }
}

/**
 * The dollars a node of several calls shows for `credits` (R3.14 fix round 1,
 * `credits = creditsForUsd(usd)` kept): the summed basis where its markup is
 * those credits (one call, or calls that mark up alike), else the basis whose
 * markup is exactly those credits (usdChargedAtCost of their dollars: half up
 * to 20 credits, two thirds above, rounded down to 1e-8, so it never rounds
 * a credit up).
 */
export function shownUsd(summedBasis: number, credits: number): number {
  return creditsForUsd(summedBasis) === credits ? summedBasis : usdChargedAtCost(credits / 100)
}

/**
 * A per-frame node's price (R7, USER ruling 2026-09-30, fix round 1): every
 * frame's provider price added up, and the markup taken ONCE on the sum,
 * rounded up to credits once per node — not a credit (or more) per call. The
 * hold is this over the counted frames; the charge is the same calculation
 * over the frames delivered (engine.ts chargeableCredits, perFrameCredits).
 */
export function localModelPrice(p: PaidCalls): NodePrice {
  if ('refused' in p) return p
  let usd = 0
  for (const { call, times } of p.steps) {
    if (!Number.isInteger(times) || times < 1) return { refused: `${call.endpoint} is planned to run ${times} times; a call runs a whole number of times, at least once` }
    const basis = paidCallUsd(call)
    if (basis == null) return { refused: `${call.endpoint} has no listed price` }
    usd += basis * times
  }
  const sum = Math.round(usd * 1e8) / 1e8
  return { usd: sum, credits: creditsForUsd(sum) }
}

/** The credits for per-frame calls delivered, each at its own price basis: summed, then marked up once (localModelPrice's rule). */
export function perFrameCredits(calls: readonly { usd: number }[]): number {
  const sum = Math.round(calls.reduce((s, c) => s + c.usd, 0) * 1e8) / 1e8
  return creditsForUsd(sum)
}

/**
 * A paid node: the hold is the ceiling its settings can reach; with
 * `answerUsage` (or a speech node's `inputChars`) the calls as used, never
 * above that ceiling (and the ceiling when the used calls can't be priced).
 */
function paidNodePrice(classType: string, inputs: NodeInputs, opts: PriceOptions): NodePrice {
  const { answerUsage, inputChars, ...rest } = opts
  const ceiling = paidStepsPrice(paidCalls(classType, inputs, rest))
  if ('refused' in ceiling || (!answerUsage && inputChars === undefined)) return ceiling
  const used = paidStepsPrice(paidCalls(classType, inputs, opts))
  return 'refused' in used || used.credits > ceiling.credits ? ceiling : used
}

/**
 * A priced node, or the reason it can't be priced (the server refuses it).
 *
 * `usd` is the PRICE BASIS in dollars — always `credits = creditsForUsd(usd)`.
 * For one plain call it is what the first service charges. It is NOT the
 * provider's cost when the node covers a fallback chain at cost or runs
 * several calls (editRates.ts editMaxUsd, paidStepsPrice): there it can sit
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
  // A node that makes several calls (a runner pipeline, R3.1): the sum of each call's credits.
  const planned = pipelineCallsOf(classType, inputs ?? {})
  if (planned) {
    const credits = callsCredits(planned)
    return { usd: shownUsd(planned.reduce((s, c) => s + c.usd, 0), credits), credits }
  }
  // Blend scene with its kept subject cleaned (R8.1 live-check fix): the blend, the cut-out and the fill.
  if (classType === 'BlendSceneNode') {
    const clean = blendKeepCleanCalls(inputs ?? {}, opts)
    if (clean && 'refused' in clean) return clean
    if (clean) {
      const credits = callsCredits([{ usd: clean.blend }, { usd: clean.cutout }, { usd: clean.fill }])
      return { usd: clean.blend + clean.cutout + clean.fill, credits }
    }
  }
  // A paid-model class (step 3, R3): the calls its settings can make.
  if (PAID_CLASS_SET.has(classType)) return paidNodePrice(classType, inputs ?? {}, opts)
  if (SETTING_PRICED_CLASS_SET.has(classType)) {
    const usd = editNodeUsd(classType, inputs ?? {}, opts)
    return typeof usd === 'number' ? { usd, credits: creditsForUsd(usd) } : usd
  }
  if (REMOTE_VIDEO_CLASS_SET.has(classType)) {
    const usd = remoteVideoNodeUsd(classType, inputs ?? {}, opts.inputSeconds ?? {})
    if (usd == null) return { refused: `${classType} has a call with no listed price` }
    return typeof usd === 'number' ? { usd, credits: creditsForUsd(usd) } : usd
  }
  // Enhance a video on fal's Topaz, while topaz-video is on (F23); Person swap (video) on fal's
  // Pixverse Swap, while person-swap-video is on: the measured video, else its ceiling.
  if (familyPricedClass(classType, opts.families)) {
    // R7 (ruling (f)): one call per frame, the frames counted before the hold (else one picture).
    // R7.6: Slow motion (AI), one RIFE call priced by the frames it makes and their size (measured, else a ceiling).
    if (isLocalModelClass(classType)) return localModelPrice(localModelCalls(classType, opts.inputSeconds?.frames, inputs, opts.inputSeconds))
    const usd = classType === 'PersonSwapVideo'
      ? personSwapVideoUsd(inputs ?? {}, opts.inputSeconds ?? {})
      : topazVideoUsd(inputs ?? {}, opts.inputSeconds ?? {})
    return typeof usd === 'number' ? { usd, credits: creditsForUsd(usd) } : usd
  }
  if (!MODEL_PRICED_CLASS_SET.has(classType)) return { refused: 'not a model-priced class' }
  const picked = inputs?.model
  // An engine picker (Upscale, Enhance detail) with its engine wired (known
  // only at run time) is priced at its dearest engine (R3.5 fix round 1).
  if ((classType === 'UpscaleImageNode' || classType === 'EnhanceDetailNode') && isLinkedInput(picked)) {
    const price = editNodeUsd(classType, inputs!, opts)
    return typeof price === 'number' ? { usd: price, credits: creditsForUsd(price) } : price
  }
  const model = typeof picked === 'string' ? picked : ''
  if (!model) return { refused: 'no model selected' }

  let usd: number
  if (classType === 'GenerateImageNode') {
    if (!isCatalogueImage(model)) return { refused: `unknown model id ${model}` }
    if (!imageRate(model)) return { refused: `model ${model} has no listed price` }
    usd = imageNodeUsd(model, inputs!)
  }
  else if (classType === 'GenerateVideoNode' || classType === 'FilmShotNode') {
    const price = videoNodeUsd(model, inputs!, classType === 'GenerateVideoNode' ? opts.inputSeconds : null)
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
