/**
 * The provider call an image edit node makes — the endpoint its request
 * builder picks and the settings that endpoint bills by (resolution tier,
 * picture size) — read from the node's widgets exactly as that builder reads
 * them. editRates.ts turns the call into dollars.
 *
 * The builders: server/runner/executors.ts (planNode) with
 * server/runner/generators/{edit,actions,refEdits,restyle}.ts for the runner
 * families, and comfy_api_nodes/nodes_replicate.py (UpscaleImageNode) plus
 * replicate_refs.py build_enhance_input (EnhanceDetailNode), which only the
 * ComfyUI path runs. tests/unit/edit-pricing.unit.spec.ts runs every runner
 * builder over every setting and checks it sends what this module says.
 *
 * Fallback chains: the ComfyUI path's Nano Banana edits
 * (_run_nano_banana_edit, nodes_replicate.py) try the fal endpoint first, then
 * fal Nano Banana Pro, then the model on Replicate, at the same resolution.
 * The runner sends only the first. Both paths are charged the same price, so
 * the call carries its chain as `fallbacks` and the price is the most
 * expensive entry (controller ruling, P4 fix round 1). A test reads the chain
 * from the Python, so a new step there fails it.
 *
 * Picture size: Upscale, Enhance detail and FLUX.2 edit are billed by the size
 * of the picture sent in. Where the caller has measured it (`inputPixels`:
 * the hosted /prompt gate reads a loaded file's header or an upstream
 * generator's settings, the runner measures the file before it submits), the
 * price reads that size; otherwise the picture is priced at
 * LARGEST_INPUT_PIXELS. A measured size above that is priced at it too, so a
 * price never exceeds the ceiling a badge shows.
 *
 * A widget that is LINKED (the API prompt carries a `[nodeId, slot]`
 * reference, known only at run time) is priced at its most expensive value,
 * a linked or missing model at the dearest model the node offers.
 *
 * Pure: no server imports. Relative imports only.
 */
import { pyFloatOf } from '../runner/pyText'
import type { EditCall } from './editRates'
import { effectiveImageSettings } from './imageSettings'

export type NodeInputs = Record<string, unknown>

/**
 * THE input-size cap, in pixels: the largest picture Sailor makes (Nano
 * Banana 2 at 4K, 4096 × 4096 ≈ 16.8 MP). An input the price can't measure is
 * priced as this large, and a measured one is priced at no more than this
 * (controller ruling, P4 fix round 1). Under the rounding ruling
 * (ceil(pixels / 1e6)) it is 17 MP; 2048² would count as 5.
 */
export const LARGEST_INPUT_PIXELS = 4096 * 4096

/**
 * FLUX.2 [pro] never returns more than 2048 × 2048 (the BFL cap P3's image
 * card uses); its edit endpoint sizes the output to the input ("auto").
 */
const FLUX_2_MAX_OUTPUT_PIXELS = 2048 * 2048

/** The input size to price: the measured one, never above the cap; unmeasured, the cap. */
export function pricedInputPixels(measured: number | null | undefined): number {
  return typeof measured === 'number' && measured > 0 ? Math.min(measured, LARGEST_INPUT_PIXELS) : LARGEST_INPUT_PIXELS
}

/** The edit classes priced by their settings (the upscalers are in nodePrice's model-priced list). */
export const SETTING_PRICED_NODE_CLASSES: readonly string[] = [
  'EditImageNode', 'DevelopImageNode', 'RelightNode', 'BlendSceneNode',
  'RemoveObjectNode', 'TextEditNode', 'RecolorObjectNode', 'SwapBackgroundNode', 'SwapProductNode', 'PersonSwap', 'LensReframe',
  'GenerateFromReferencesNode', 'RotateCameraNode', 'ProductShotNode',
  'RestyleFromImageNode',
]

const isLinked = (v: unknown) => Array.isArray(v)
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** A tier-priced call at `tier`; `null` tier = "the dearest" (a linked widget). */
const call = (endpoint: string, tier: string | null = null, pixels: { input?: number, output?: number } = {}, fallbacks?: EditCall[]): EditCall =>
  ({ endpoint, tier, inputPixels: pixels.input ?? null, outputPixels: pixels.output ?? null, ...(fallbacks ? { fallbacks } : {}) })

/** `asText(v) || def`: text that isn't empty, else the default (executors.ts). */
const textOr = (v: unknown, def: string) => (typeof v === 'string' && v ? v : def)

/** refEdits.ts clampSize: one of the allowed sizes, else the fallback. */
const clampSize = (v: unknown, allowed: readonly string[], fallback: string) =>
  (typeof v === 'string' && allowed.includes(v) ? v : fallback)

// Endpoints (the runner's constants; the parity test pins each one).
const FAL_NB2_EDIT = 'fal-ai/nano-banana-2/edit'
const FAL_NB_PRO_EDIT = 'fal-ai/nano-banana-pro/edit'
const FAL_FLUX_2_EDIT = 'fal-ai/flux-2-pro/edit'
const FAL_KONTEXT = 'fal-ai/flux-pro/kontext'
const REP_NB2 = 'google/nano-banana-2'
const REP_NB_PRO = 'google/nano-banana-pro'
const REP_NB = 'google/nano-banana'

/**
 * _run_nano_banana_edit's chain for a Nano Banana edit at `tier`: the fal
 * endpoint of the Replicate slug, then fal Nano Banana Pro (unless that was
 * the first), then the slug on Replicate — all at the same resolution.
 */
const nanoBananaEdit = (replicateSlug: typeof REP_NB2 | typeof REP_NB_PRO, tier: string | null): EditCall => {
  const first = replicateSlug === REP_NB2 ? FAL_NB2_EDIT : FAL_NB_PRO_EDIT
  const chain = first === FAL_NB_PRO_EDIT ? [] : [call(FAL_NB_PRO_EDIT, tier)]
  return call(first, tier, {}, [...chain, call(replicateSlug, tier)])
}

/** FLUX.2 edit keeps the input's size (up to its 2048² output cap): billed on both. */
const flux2Edit = (_i: NodeInputs, px: number) =>
  call(FAL_FLUX_2_EDIT, null, { input: px, output: Math.min(px, FLUX_2_MAX_OUTPUT_PIXELS) })

/** EditImageNode / DevelopImageNode's Nano Banana 2 tier: `asText(resolution) || '1K'`. */
const nb2Tier = (inputs: NodeInputs) => (isLinked(inputs.resolution) ? null : textOr(inputs.resolution, '1K'))

/** Per model, the call it makes (given the priced input size); the node's model widget picks one. */
type ModelCalls = Record<string, (inputs: NodeInputs, inputPixels: number) => EditCall>

const EDIT_IMAGE_MODELS: ModelCalls = {
  'Nano Banana 2': i => nanoBananaEdit(REP_NB2, nb2Tier(i)),
  'Flux Kontext Pro': () => call(FAL_KONTEXT),
  'Flux 2 Pro': flux2Edit,
}

const BLEND_SCENE_MODELS: ModelCalls = {
  'Flux 2 Pro': flux2Edit,
  'Flux Kontext Pro': () => call(FAL_KONTEXT),
  'Nano Banana': () => call(REP_NB),
}

/** GenerateFromReferencesNode's `size`: missing is '2K'; each model clamps it (image_edit_models.py). */
const refSize = (inputs: NodeInputs, allowed: readonly string[]) =>
  (isLinked(inputs.size) ? null : clampSize(inputs.size === undefined ? '2K' : inputs.size, allowed, '2K'))

const REFERENCE_MODELS: ModelCalls = {
  'seedream-5-pro': i => call('bytedance/seedream-5-pro', refSize(i, ['1K', '2K'])),
  'seedream-5-lite': () => call('bytedance/seedream-5-lite'),
  // Nano Banana 2 reads the size as its resolution, then goes to its fal twin
  // (_run_image_edit_prediction → _run_nano_banana_edit).
  'nano-banana-2': i => nanoBananaEdit(REP_NB2, refSize(i, ['1K', '2K', '4K'])),
}

/**
 * RestyleFromImageNode's resolution: missing is '1K'; the fal read-back
 * (refEdits.ts imageEditCall) sends text as it is and anything else as '1K'.
 */
const restyleTier = (inputs: NodeInputs) => {
  if (isLinked(inputs.resolution)) return null
  const r = inputs.resolution === undefined ? '1K' : inputs.resolution
  return typeof r === 'string' ? r : '1K'
}

const RESTYLE_MODELS: ModelCalls = {
  'Nano Banana 2': i => nanoBananaEdit(REP_NB2, restyleTier(i)),
  'Nano Banana Pro': i => nanoBananaEdit(REP_NB_PRO, restyleTier(i)),
  // google/nano-banana takes no resolution; Replicate, one price.
  'Nano Banana': () => call(REP_NB),
  'Style Transfer · IP-Adapter': () => call('fofr/style-transfer'),
}

/** The classes whose model widget picks the call. */
const BY_MODEL: Record<string, ModelCalls> = {
  EditImageNode: EDIT_IMAGE_MODELS,
  BlendSceneNode: BLEND_SCENE_MODELS,
  GenerateFromReferencesNode: REFERENCE_MODELS,
  RestyleFromImageNode: RESTYLE_MODELS,
}

/** The classes that always make the same kind of call. */
const FIXED: Record<string, (inputs: NodeInputs) => EditCall> = {
  // Nano Banana 2 with the fixed polish instruction, at the node's resolution.
  DevelopImageNode: i => nanoBananaEdit(REP_NB2, nb2Tier(i)),
  // Nano Banana 2 on fal, always 1K (comfy_extras/nodes_relight.py, the same chain).
  RelightNode: () => nanoBananaEdit(REP_NB2, '1K'),
  // The Nano Banana actions: google/nano-banana-2 on Replicate, always 1K
  // (_run_prediction directly: no fal chain).
  RemoveObjectNode: () => call(REP_NB2, '1K'),
  TextEditNode: () => call(REP_NB2, '1K'),
  RecolorObjectNode: () => call(REP_NB2, '1K'),
  SwapBackgroundNode: () => call(REP_NB2, '1K'),
  SwapProductNode: () => call(REP_NB2, '1K'),
  PersonSwap: () => call(REP_NB2, '1K'),
  // comfy_extras/nodes_lens_reframe.py: the same Replicate call, 1K (ComfyUI path only).
  LensReframe: () => call(REP_NB2, '1K'),
  RotateCameraNode: () => call('qwen/qwen-image-edit-plus'),
  ProductShotNode: () => call('catacolabs/sdxl-ad-inpaint'),
}

// ── Upscale and Enhance detail (ComfyUI path, nodes_replicate.py) ─────────

/** _UPSCALE_SLUGS: engine label → Replicate slug. */
export const UPSCALE_ENGINE_SLUGS: Readonly<Record<string, string>> = {
  'Clarity': 'philz1337x/clarity-upscaler',
  'Crystal': 'philz1337x/crystal-upscaler',
  'Real-ESRGAN': 'nightmareai/real-esrgan',
  'Recraft Crisp': 'recraft-ai/recraft-crisp-upscale',
  'Topaz': 'topazlabs/image-upscale',
}

/** build_enhance_input: engine label → Replicate slug (all three run in place). */
export const ENHANCE_ENGINE_SLUGS: Readonly<Record<string, string>> = {
  'Creative': 'philz1337x/clarity-upscaler',
  'Faithful': 'topazlabs/image-upscale',
  'Diffusion Refine': 'fermatresearch/magic-image-refiner',
}

/** The node's scale_factor widget: 1–10, default 2. Linked or unreadable: 10. */
export const MAX_SCALE_FACTOR = 10
function scaleFactor(v: unknown): number {
  if (v === undefined) return 2
  const n = typeof v === 'number' ? v : typeof v === 'string' ? pyFloatOf(v) : null
  if (n == null || !Number.isFinite(n)) return MAX_SCALE_FACTOR
  return Math.max(1, Math.min(MAX_SCALE_FACTOR, n))
}

/** Topaz's topaz_upscale_factor: "None" / "2x" / "4x" / "6x", default "2x". Linked or anything else: 6. */
const TOPAZ_FACTORS: Record<string, number> = { 'None': 1, '2x': 2, '4x': 4, '6x': 6 }
function topazFactor(v: unknown): number {
  if (v === undefined) return 2
  return typeof v === 'string' && hasOwn(TOPAZ_FACTORS, v) ? TOPAZ_FACTORS[v]! : 6
}

function upscaleCall(engine: string, inputs: NodeInputs, px: number): EditCall | null {
  const slug = hasOwn(UPSCALE_ENGINE_SLUGS, engine) ? UPSCALE_ENGINE_SLUGS[engine]! : null
  if (!slug) return null
  // Clarity and Crystal enlarge by scale_factor; Topaz by its own factor;
  // Real-ESRGAN and Recraft Crisp cost the same at any size.
  const factor = engine === 'Topaz' ? topazFactor(inputs.topaz_upscale_factor) : scaleFactor(inputs.scale_factor)
  // The input enlarged `factor` times on each side.
  return call(slug, null, { output: px * factor * factor })
}

function enhanceCall(engine: string, px: number): EditCall | null {
  const slug = hasOwn(ENHANCE_ENGINE_SLUGS, engine) ? ENHANCE_ENGINE_SLUGS[engine]! : null
  // In place: Clarity at scale 1.0, Topaz with upscale_factor "None", the refiner at "original".
  return slug ? call(slug, null, { output: px }) : null
}

/** The calls a node could make: one, or one per model when the model is linked or missing. */
export type EditCalls =
  | { calls: EditCall[] }
  | { refused: string }

/**
 * The provider call(s) a node's settings make. For a model widget that is
 * linked or missing, every model the node offers (the price takes the
 * dearest). A model the node doesn't offer is refused: the node fails
 * before it calls anyone.
 */
export function editCalls(classType: string, inputs: NodeInputs, opts: { inputPixels?: number | null } = {}): EditCalls {
  const fixed = hasOwn(FIXED, classType) ? FIXED[classType] : undefined
  if (fixed) return { calls: [fixed(inputs)] }
  const px = pricedInputPixels(opts.inputPixels)

  if (classType === 'UpscaleImageNode' || classType === 'EnhanceDetailNode') {
    const engine = typeof inputs.model === 'string' ? inputs.model : ''
    if (!engine) return { refused: 'no model selected' }
    const c = classType === 'UpscaleImageNode' ? upscaleCall(engine, inputs, px) : enhanceCall(engine, px)
    return c ? { calls: [c] } : { refused: `unknown engine ${engine}` }
  }

  const models = hasOwn(BY_MODEL, classType) ? BY_MODEL[classType]! : undefined
  if (!models) return { refused: 'not a setting-priced class' }
  const model = inputs.model
  if (model === undefined || isLinked(model)) return { calls: Object.values(models).map(m => m(inputs, px)) }
  const m = typeof model === 'string' && hasOwn(models, model) ? models[model]! : undefined
  if (!m) return { refused: `unknown model ${String(model)}` }
  return { calls: [m(inputs, px)] }
}

// ── The picture a size-priced node is sent ────────────────────────────────

/**
 * The input whose picture size the price depends on, or null: Upscale and
 * Enhance detail's `image`, and FLUX.2 edit's picture (Edit image and Blend
 * scene with "Flux 2 Pro", or a linked or missing model, which may be it).
 */
export function sizePricedInput(classType: string, inputs: NodeInputs): string | null {
  if (classType === 'UpscaleImageNode' || classType === 'EnhanceDetailNode') return 'image'
  const flux2 = inputs.model === undefined || isLinked(inputs.model) || inputs.model === 'Flux 2 Pro'
  if (classType === 'EditImageNode') return flux2 ? 'input_image' : null
  if (classType === 'BlendSceneNode') return flux2 ? 'image' : null
  return null
}

/** Nano Banana resolution tiers → the side of the square picture (the largest a tier makes). */
const TIER_SIDE: Record<string, number> = { '0.5K': 512, '1K': 1024, '2K': 2048, '4K': 4096 }

/**
 * The largest picture an upstream node's settings make, in pixels, when the
 * settings say it; null when they don't (the caller prices the cap). Only
 * GenerateImageNode says: a per-megapixel model's billed megapixels
 * (rounded up, so never below the picture) or a resolution tier's square.
 * The hosted gate and the canvas badge both read this, so they agree.
 */
export function sourceOutputPixels(classType: string, inputs: NodeInputs): number | null {
  if (classType !== 'GenerateImageNode') return null
  const { model, aspect_ratio: ratio, model_options: options } = inputs
  if (typeof model !== 'string' || isLinked(ratio) || isLinked(options)) return null
  const s = effectiveImageSettings(model, ratio, options)
  if (!s) return null
  if (s.megapixels != null) return s.megapixels * 1_000_000
  if (s.tier != null && hasOwn(TIER_SIDE, s.tier)) return TIER_SIDE[s.tier]! ** 2
  return null
}
