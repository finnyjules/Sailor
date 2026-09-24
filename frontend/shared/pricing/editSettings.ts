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
 * The first call only: where the ComfyUI path falls back to another service
 * after a failure (Nano Banana 2 → Nano Banana Pro → Replicate), the price is
 * the first service's, as the runner sends it.
 *
 * A widget that is LINKED (the API prompt carries a `[nodeId, slot]`
 * reference, known only at run time) is priced at its most expensive value,
 * a linked or missing model at the dearest model the node offers.
 *
 * Pure: no server imports. Relative imports only.
 */
import { pyFloatOf } from '../runner/pyText'
import type { EditCall } from './editRates'

export type NodeInputs = Record<string, unknown>

/**
 * The largest input picture the price assumes, in pixels (controller ruling:
 * "price at the largest accepted input (4 MP) × scale"). Upscale, Enhance
 * detail and FLUX.2 edit are billed by picture size, which the price cannot
 * see, so they are priced as if the picture were this large.
 */
export const LARGEST_INPUT_PIXELS = 4_000_000

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
const call = (endpoint: string, tier: string | null = null, pixels: { input?: number, output?: number } = {}): EditCall =>
  ({ endpoint, tier, inputPixels: pixels.input ?? null, outputPixels: pixels.output ?? null })

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
const REP_NB = 'google/nano-banana'

/** FLUX.2 edit keeps the input's size: the largest input in, the same size out. */
const flux2Edit = () => call(FAL_FLUX_2_EDIT, null, { input: LARGEST_INPUT_PIXELS, output: LARGEST_INPUT_PIXELS })

/** EditImageNode / DevelopImageNode's Nano Banana 2 tier: `asText(resolution) || '1K'`. */
const nb2Tier = (inputs: NodeInputs) => (isLinked(inputs.resolution) ? null : textOr(inputs.resolution, '1K'))

/** Per model, the call it makes; the node's model widget picks one. */
type ModelCalls = Record<string, (inputs: NodeInputs) => EditCall>

const EDIT_IMAGE_MODELS: ModelCalls = {
  'Nano Banana 2': i => call(FAL_NB2_EDIT, nb2Tier(i)),
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
  // Nano Banana 2 reads the size as its resolution, then goes to its fal twin.
  'nano-banana-2': i => call(FAL_NB2_EDIT, refSize(i, ['1K', '2K', '4K'])),
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
  'Nano Banana 2': i => call(FAL_NB2_EDIT, restyleTier(i)),
  'Nano Banana Pro': i => call(FAL_NB_PRO_EDIT, restyleTier(i)),
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
  DevelopImageNode: i => call(FAL_NB2_EDIT, nb2Tier(i)),
  // Nano Banana 2 on fal, always 1K.
  RelightNode: () => call(FAL_NB2_EDIT, '1K'),
  // The Nano Banana actions: google/nano-banana-2 on Replicate, always 1K.
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

/** Output pixels when the largest input is enlarged `factor` times on each side. */
const scaledPixels = (factor: number) => LARGEST_INPUT_PIXELS * factor * factor

function upscaleCall(engine: string, inputs: NodeInputs): EditCall | null {
  const slug = hasOwn(UPSCALE_ENGINE_SLUGS, engine) ? UPSCALE_ENGINE_SLUGS[engine]! : null
  if (!slug) return null
  // Clarity and Crystal enlarge by scale_factor; Topaz by its own factor;
  // Real-ESRGAN and Recraft Crisp cost the same at any size.
  const factor = engine === 'Topaz' ? topazFactor(inputs.topaz_upscale_factor) : scaleFactor(inputs.scale_factor)
  return call(slug, null, { output: scaledPixels(factor) })
}

function enhanceCall(engine: string): EditCall | null {
  const slug = hasOwn(ENHANCE_ENGINE_SLUGS, engine) ? ENHANCE_ENGINE_SLUGS[engine]! : null
  // In place: Clarity at scale 1.0, Topaz with upscale_factor "None", the refiner at "original".
  return slug ? call(slug, null, { output: LARGEST_INPUT_PIXELS }) : null
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
export function editCalls(classType: string, inputs: NodeInputs): EditCalls {
  const fixed = hasOwn(FIXED, classType) ? FIXED[classType] : undefined
  if (fixed) return { calls: [fixed(inputs)] }

  if (classType === 'UpscaleImageNode' || classType === 'EnhanceDetailNode') {
    const engine = typeof inputs.model === 'string' ? inputs.model : ''
    if (!engine) return { refused: 'no model selected' }
    const c = classType === 'UpscaleImageNode' ? upscaleCall(engine, inputs) : enhanceCall(engine)
    return c ? { calls: [c] } : { refused: `unknown engine ${engine}` }
  }

  const models = hasOwn(BY_MODEL, classType) ? BY_MODEL[classType]! : undefined
  if (!models) return { refused: 'not a setting-priced class' }
  const model = inputs.model
  if (model === undefined || isLinked(model)) return { calls: Object.values(models).map(m => m(inputs)) }
  const m = typeof model === 'string' && hasOwn(models, model) ? models[model]! : undefined
  if (!m) return { refused: `unknown model ${String(model)}` }
  return { calls: [m(inputs)] }
}
