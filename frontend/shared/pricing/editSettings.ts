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
 * The runner sends one call, and its backup service when the first never
 * starts the job (server/runner/generators/twins.ts, Task S3). Both paths are
 * charged the same price, so the call is the runner's first call and carries
 * every other call either path may make as `fallbacks`; the price is the
 * first call with the markup, or the dearest fallback at cost (controller
 * ruling, P4 fix round 1). A test reads the chain from the Python, so a new
 * step there fails it.
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
import type { EditCall, EditStep } from './editRates'
import { effectiveImageSettings } from './imageSettings'

export type NodeInputs = Record<string, unknown>

/**
 * THE input-size cap, in pixels: the largest picture Sailor makes — the
 * largest entry in NB_SIZES below, Nano Banana at 4K in 8:1 / 1:8, 12288 ×
 * 1536 = 18,874,368 (P5 fix round 1; it was 4096², which a wide 4K picture
 * exceeds). An input the price can't measure is priced as this large, and a
 * measured one is priced at no more than this (controller ruling, P4 fix
 * round 1). Under the rounding ruling (ceil(pixels / 1e6)) it is 19 MP. A
 * literal, not derived, because NB_SIZES is declared further down; a test
 * pins it to the table's largest entry.
 */
export const LARGEST_INPUT_PIXELS = 12288 * 1536

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
  'RestyleFromImageNode', 'RestyleWithLoRANode',
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

/**
 * FLUX.2 edit keeps the input's size (up to its 2048² output cap): billed on
 * both. The runner's backup, Replicate's FLUX.2 [pro] with the picture, makes
 * the same size (its largest, "4 MP", is 2048²).
 */
const REP_FLUX_2_PRO = 'black-forest-labs/flux-2-pro'
const flux2Edit = (_i: NodeInputs, px: number) => {
  const pixels = { input: px, output: Math.min(px, FLUX_2_MAX_OUTPUT_PIXELS) }
  return call(FAL_FLUX_2_EDIT, null, pixels, [call(REP_FLUX_2_PRO, null, pixels)])
}

/**
 * A Nano Banana 2 edit the runner sends to Replicate first (cheaper), with
 * fal's edit as its backup (twins.ts): Relight, Restyle on Nano Banana 2. The
 * ComfyUI path's chain (fal NB2, fal NB Pro, then Replicate) is covered too.
 */
const nanoBanana2ReplicateFirst = (tier: string | null): EditCall =>
  call(REP_NB2, tier, {}, [call(FAL_NB2_EDIT, tier), call(FAL_NB_PRO_EDIT, tier)])

/** The Nano Banana actions: google/nano-banana-2 on Replicate at 1K, fal's edit the runner's backup. */
const nanoAction = (): EditCall => call(REP_NB2, '1K', {}, [call(FAL_NB2_EDIT, '1K')])

/** EditImageNode / DevelopImageNode's Nano Banana 2 tier: `asText(resolution) || '1K'`. */
const nb2Tier = (inputs: NodeInputs) => (isLinked(inputs.resolution) ? null : textOr(inputs.resolution, '1K'))

/** Per model, the call it makes (given the priced input size); the node's model widget picks one. */
type ModelCalls = Record<string, (inputs: NodeInputs, inputPixels: number) => EditCall>

/**
 * GPT Image 2.5 (runner-only, Task F2): Flare's edit on fal at quality
 * medium (the node has no quality control), Replicate's the backup at the same
 * quality (server/runner/generators/gptImage25.ts).
 */
const FAL_GPT_25_EDIT = 'openai/gpt-image-2.5/flare/edit'
const REP_GPT_25_FLARE = 'openai/gpt-image-2.5-flare'
const GPT_25_EDIT_QUALITY = 'medium'
const gptImage25Edit = () => call(FAL_GPT_25_EDIT, GPT_25_EDIT_QUALITY, {}, [call(REP_GPT_25_FLARE, GPT_25_EDIT_QUALITY)])

const EDIT_IMAGE_MODELS: ModelCalls = {
  'Nano Banana 2': i => nanoBananaEdit(REP_NB2, nb2Tier(i)),
  'Flux Kontext Pro': () => call(FAL_KONTEXT),
  'Flux 2 Pro': flux2Edit,
  'GPT Image 2.5': gptImage25Edit,
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
  'Nano Banana 2': i => nanoBanana2ReplicateFirst(restyleTier(i)),
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
  // Nano Banana 2, always 1K: Replicate first on the runner, the ComfyUI
  // path's fal chain (comfy_extras/nodes_relight.py) covered.
  RelightNode: () => nanoBanana2ReplicateFirst('1K'),
  // The Nano Banana actions: google/nano-banana-2 on Replicate, always 1K
  // (_run_prediction directly: no fal chain); fal the runner's backup.
  RemoveObjectNode: nanoAction,
  TextEditNode: nanoAction,
  RecolorObjectNode: nanoAction,
  SwapBackgroundNode: nanoAction,
  SwapProductNode: nanoAction,
  PersonSwap: nanoAction,
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

/**
 * Nano Banana's picture sizes, width × height by aspect ratio and resolution
 * tier — Google's table for Gemini 3.1 Flash Image (Nano Banana 2), read
 * 2026-09-24 from https://ai.google.dev/gemini-api/docs/image-generation.
 * Nano Banana Pro's table is the same sizes for the ratios it takes, so this
 * one table (a superset) covers both. A tier is NOT its square: 16:9 at 1K is
 * 1376 × 768, larger than 1024².
 */
const NB_SIZES: Record<string, Record<string, readonly [number, number]>> = {
  '1:1': { '0.5K': [512, 512], '1K': [1024, 1024], '2K': [2048, 2048], '4K': [4096, 4096] },
  '1:4': { '0.5K': [256, 1024], '1K': [512, 2048], '2K': [1024, 4096], '4K': [2048, 8192] },
  '1:8': { '0.5K': [192, 1536], '1K': [384, 3072], '2K': [768, 6144], '4K': [1536, 12288] },
  '2:3': { '0.5K': [424, 632], '1K': [848, 1264], '2K': [1696, 2528], '4K': [3392, 5056] },
  '3:2': { '0.5K': [632, 424], '1K': [1264, 848], '2K': [2528, 1696], '4K': [5056, 3392] },
  '3:4': { '0.5K': [448, 600], '1K': [896, 1200], '2K': [1792, 2400], '4K': [3584, 4800] },
  '4:1': { '0.5K': [1024, 256], '1K': [2048, 512], '2K': [4096, 1024], '4K': [8192, 2048] },
  '4:3': { '0.5K': [600, 448], '1K': [1200, 896], '2K': [2400, 1792], '4K': [4800, 3584] },
  '4:5': { '0.5K': [464, 576], '1K': [928, 1152], '2K': [1856, 2304], '4K': [3712, 4608] },
  '5:4': { '0.5K': [576, 464], '1K': [1152, 928], '2K': [2304, 1856], '4K': [4608, 3712] },
  '8:1': { '0.5K': [1536, 192], '1K': [3072, 384], '2K': [6144, 768], '4K': [12288, 1536] },
  '9:16': { '0.5K': [384, 688], '1K': [768, 1376], '2K': [1536, 2752], '4K': [3072, 5504] },
  '16:9': { '0.5K': [688, 384], '1K': [1376, 768], '2K': [2752, 1536], '4K': [5504, 3072] },
  // The page lists 792 × 168 at 0.5K; 792 × 336 (half of 1K) is taken, the larger.
  '21:9': { '0.5K': [792, 336], '1K': [1584, 672], '2K': [3168, 1344], '4K': [6336, 2688] },
}

/** Pixels of a Nano Banana picture: the ratio's size when the table has it, else the tier's largest across every ratio. */
export function nanoBananaPixels(tier: string, ratio: unknown): number | null {
  const sized = (r: string) => {
    const wh = hasOwn(NB_SIZES, r) && hasOwn(NB_SIZES[r]!, tier) ? NB_SIZES[r]![tier]! : null
    return wh ? wh[0] * wh[1] : null
  }
  if (typeof ratio === 'string') {
    const px = sized(ratio)
    if (px != null) return px
  }
  const all = Object.keys(NB_SIZES).map(sized).filter((n): n is number => n != null)
  return all.length ? Math.max(...all) : null
}

/**
 * The largest picture an upstream node's settings make, in pixels, when the
 * settings say it; null when they don't (the caller prices the cap). Only
 * GenerateImageNode says: a per-megapixel model's billed megapixels
 * (rounded up, so never below the picture), or a Nano Banana tier's size at
 * the node's ratio (the tier's largest across ratios when the ratio isn't in
 * the table). The hosted gate and the canvas badge both read this, so they
 * agree, and it is never below the picture the node makes.
 */
export function sourceOutputPixels(classType: string, inputs: NodeInputs): number | null {
  if (classType !== 'GenerateImageNode') return null
  const { model, aspect_ratio: ratio, model_options: options } = inputs
  if (typeof model !== 'string' || isLinked(ratio) || isLinked(options)) return null
  const s = effectiveImageSettings(model, ratio, options)
  if (!s) return null
  if (s.megapixels != null) return s.megapixels * 1_000_000
  if (s.tier != null) return nanoBananaPixels(s.tier, ratio)
  return null
}

// ── Restyle with a style LoRA (ComfyUI path, nodes_replicate.py) ──────────

/**
 * _RESTYLE_MAX_NB_RETRIES in nodes_replicate.py. RestyleWithLoRANode re-rolls
 * Nano Banana 2 when an illustration target comes back looking like a photo:
 * the re-roll follows a call that SUCCEEDED and was billed (the classifier
 * judged its picture, not a failure). So every re-roll is priced, not one
 * pass (controller ruling, P4 fix round 2). A test reads the constant and
 * the loop from the Python.
 */
export const RESTYLE_LORA_NB_RETRIES = 2

/**
 * The calls RestyleWithLoRANode makes in one run (its execute(), in order):
 * Moondream captions the picture; the LoRA restyles it (flux-dev-lora, or the
 * user's trained model); Moondream classifies that reference; then up to
 * 1 + RESTYLE_LORA_NB_RETRIES Nano Banana 2 passes (_run_nano_banana_edit,
 * with its fallback chain, at the node's resolution), each classified by
 * Moondream. The price is every call, the worst case.
 */
export function editSteps(classType: string, inputs: NodeInputs): EditStep[] | null {
  if (classType !== 'RestyleWithLoRANode') return null
  const passes = 1 + RESTYLE_LORA_NB_RETRIES
  // resolution: a 1K/2K/4K combo, default 1K, sent as given; linked → the dearest.
  const tier = isLinked(inputs.resolution) ? null : (inputs.resolution === undefined ? '1K' : typeof inputs.resolution === 'string' ? inputs.resolution : null)
  return [
    { call: call('lucataco/moondream2'), times: 1 + 1 + passes },
    { call: call('black-forest-labs/flux-dev-lora'), times: 1 },
    { call: nanoBananaEdit(REP_NB2, tier), times: passes },
  ]
}
