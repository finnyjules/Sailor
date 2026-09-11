/**
 * Versioned price book + graph pricer. Prices a ComfyUI API-format graph in
 * integer credits (1 credit = $0.01). A flat base_render applies once for any
 * graph with a terminal output node; every provider node adds its own cost on
 * top. Phase 3 moves this table to the Postgres `price_book`.
 *
 * FAIL CLOSED (spike-v4): a provider node class this table cannot price throws
 * UnpricedGraphError and REFUSES the whole graph. It must never fall through
 * to base_render — a real Flux 2 Pro run once went out at 1 credit because
 * GenerateImageNode was missing from the table.
 */
import { IMAGE_MODELS } from '~~/app/data/image-models'
import { ENGINE_USD } from '~~/app/data/engine-prices'
import { VIDEO_MODEL_USD, LEGACY_VIDEO_MODEL_IDS } from '~~/app/data/video-prices'
export { VIDEO_MODEL_USD }
export const PRICE_BOOK_VERSION = 'spike-v4'

const BASE_RENDER_CREDITS = 1

/**
 * Category prices for LoRA-family inference (pricing call 2026-08-13).
 * Personal fine-tune slugs (e.g. finnyjules/*) can never be enumerated in a
 * static slug table, so LoRA renders are priced by CATEGORY: the dispatching
 * route/node knows it is a LoRA call even when the slug is user-specific.
 * Stage 4's direct-route metering must use these for any LoRA-remote
 * inference whose slug misses MODEL_COSTS.
 */
// NOTE: no commas in trailing comments on `export const` lines — mlly's regex
// export scanner splits declarations on commas, so ", 2× markup" registered a
// phantom auto-import named `2` and broke the entire Nitro dev build.
/**
 * Owner orgs whose slugs are PERSONAL fine-tunes priced at the LoRA category.
 * Explicit allowlist — review escalation 2026-08-14: inferring "not a known
 * public org ⇒ LoRA" silently underpriced typo'd public slugs at 8cr. Any
 * owner in neither MODEL_COSTS nor this list now REFUSES (fail closed).
 * Hosted per-user fine-tune orgs join this list when that feature lands.
 */
export const LORA_SLUG_OWNERS = ['finnyjules']

export const LORA_RENDER_CREDITS = 8      // ~$0.04 observed median — 2× markup
export const RESTYLE_LORA_CREDITS = 18    // ~$0.09 observed median — 2× markup

// Terminal output nodes that mean "the GPU produced a deliverable" → base
// render. Exported (Stage 6 Task 7) so the hosted forward path injects a
// per-user filename_prefix on exactly this family — one source of truth for
// "what writes a deliverable" shared by the pricer and the output-subfolder
// injection.
//
// Stage 6 Task 7b completed the set: Task 7 covered only 5 classes, so every
// OTHER save node (Image / Video / Audio / SaveWEBM / SaveGLB / SaveSVGNode /
// the animated + model-merge savers + …) wrote to the SHARED output root and
// skipped per-user subfoldering. Every member here rewrites its output path
// through a `filename_prefix` input, which injectOutputSubfolder prepends the
// caller's `u_<hash>/` segment onto.
//
// Stage 6 Task 7c generalized the injection past this one field: save nodes
// that write via a DIFFERENT field (SaveLoRA's `prefix`, the dataset savers'
// `folder_name`) are now subfoldered too via GRAPH_OUTPUT_WRITERS
// (engineFileSurface.ts), a per-class field map that COVERS this set 1:1 plus
// those non-filename_prefix writers — but stays a separate map deliberately,
// so this set's meaning ("what writes a deliverable" for pricing) does not
// widen just because the write-side injection grew. A fixed/uuid name
// (Preview3D) has no client-controllable field at all — a `null` entry in
// GRAPH_OUTPUT_WRITERS, still on the write-exempt list in
// engine-file-surface.unit.spec.ts. The coverage guards there fail on drift
// so a new save node cannot bypass either set unnoticed.
export const OUTPUT_CLASS_TYPES = new Set([
  // — Task 7 originals —
  'SaveImage', 'PreviewImage', 'SaveVideo', 'VHS_VideoCombine', 'SaveAudio',
  // — nodes.py —
  'SaveLatent',
  // — nodes_image.py / nodes_images.py —
  'Image', 'SaveSVGNode', 'SaveAnimatedWEBP', 'SaveAnimatedPNG',
  // — nodes_video.py / nodes_video_effects.py —
  'SaveWEBM', 'Video', 'SaveVideoFrames',
  // — nodes_audio.py —
  'SaveAudioMP3', 'SaveAudioOpus', 'Audio',
  // — nodes_hunyuan3d.py —
  'SaveGLB',
  // — nodes_lora_extract.py —
  'LoraSave',
  // — nodes_model_merging.py —
  'CheckpointSave', 'CLIPSave', 'VAESave', 'ModelSave',
])

/**
 * Refusal for any provider node class the price book cannot price. The live
 * caller — meterGraphRun.ts's meterGraphSubmit — catches this and throws a
 * 500 MeterRefusalError so the graph never reaches the GPU. Never soften
 * this into a default price.
 */
export class UnpricedGraphError extends Error {
  classType: string
  detail?: string
  constructor(classType: string, detail?: string) {
    super(`unpriced graph node refused: ${classType}${detail ? ` (${detail})` : ''}`)
    this.name = 'UnpricedGraphError'
    this.classType = classType
    this.detail = detail
  }
}

/**
 * Server copy of the markup policy — a deliberate mirror of
 * app/lib/pricing.ts `creditsForUsd`. server/ must not import app/lib for
 * money math; price-graph.unit.spec.ts asserts the two agree across a USD
 * sweep. Policy: 2x on provider cost <= $0.10 and 1.5x above with a floor of
 * 1 credit.
 */
export function creditsForUsdServer(usd: number): number {
  if (!(usd > 0)) return 0
  const markup = usd <= 0.10 ? 2 : 1.5
  return Math.max(1, Math.ceil(usd * 100 * markup))
}

/**
 * Flat per-class credits — every provider class that always costs the same.
 *
 * Evidence: each class's own `price_badge` USD in comfy_api_nodes/
 * nodes_replicate.py (or comfy_extras/*.py), run through the markup policy.
 * That badge is the same figure the run-confirm gate quotes the user, so the
 * charge matches the quote. Classes with no badge are derived from a sibling
 * catalog entry and called out in the trailing comment.
 *
 * Per-unit actions (video seconds / speech characters / audio minutes) are
 * priced at the badge's quoted unit — duration-aware pricing is a Phase-3
 * rider, same as MODEL_COSTS.
 *
 * Coverage guard in price-graph.unit.spec.ts forces this table plus
 * MODEL_PRICED_NODE_CLASSES plus PROVIDER_NODE_EXEMPT to cover every
 * IO.ComfyNode class in the provider modules.
 */
export const GRAPH_NODE_CREDITS: Record<string, number> = {
  // — spike-v3 hand-set rows: kept verbatim —
  EditImageNode: 23,       // nano-banana-pro edit era: $0.15 observed — was 12 (≈0% margin) and half the direct-route price for the same action
  LipSyncNode: 150,        // observed $1.00/run — was 30 (a 70¢ LOSS per run); 150 ≈ 1.5× on a 6–10s clip
  LoraTrainingNode: 600,
  RestyleWithLoRANode: RESTYLE_LORA_CREDITS,
  FluxLoRARemoteNode: LORA_RENDER_CREDITS,
  FluxMultiLoRARemoteNode: LORA_RENDER_CREDITS,
  // (GenerateVideoNode 60 and FilmShotNode 160 moved to MODEL_PRICED — their
  // model widget spans $0.04 to $3.20 per clip, which no flat price can cover.
  // FilmShot repriced 160 → 75 (default model) on badge+catalog evidence —
  // re-verify against a live invoice at the pre-launch estimate-row sweep.)

  // — image generation / editing —
  FluxProRemoteNode: 8,            // badge $0.04
  FluxKontextRemoteNode: 8,        // badge $0.04
  IdeogramV3TurboNode: 6,          // badge $0.03
  DevelopImageNode: 10,            // badge $0.05
  GenerateFromReferencesNode: 12,  // badge $0.06
  BlendSceneNode: 8,               // badge $0.04
  RestyleFromImageNode: 10,        // badge $0.05
  ProductShotNode: 8,              // badge $0.04
  RotateCameraNode: 8,             // badge $0.04
  TextEffectNode: 8,               // badge $0.04
  SketchToImageNode: 8,            // badge $0.04
  OutpaintImageNode: 10,           // badge $0.05
  ConsistentFaceNode: 16,          // badge $0.08
  LayerizeGraphicNode: 16,         // badge $0.08
  SplitPhotoLayersNode: 2,         // badge $0.01
  SeedreamLayerizeNode: 51,        // badge $0.34
  RestorePhotoRemoteNode: 8,       // badge $0.04
  RestorePhotoNode: 8,             // badge $0.04
  CodeformerRemoteNode: 1,         // badge $0.005
  FixFacesNode: 1,                 // badge $0.005
  RemoveBackgroundRemoteNode: 1,   // badge $0.001
  RemoveBackgroundNode: 1,         // badge $0.001
  // Clarity is RANGE-priced (own description: ~$0.05–0.20/image by
  // scale_factor) and the same slug is priced at range-top 30cr via the
  // UpscaleImageNode "Clarity" engine row — a badge-bottom price here would
  // underprice the exact same call at its expensive setting. Review ruling
  // (2026-08-17): keep the CONSERVATIVE range-top figure. badge $0.10 vs
  // range-top $0.20 (nodes_replicate.py:1423) — badge divergence flagged for
  // the pre-launch invoice sweep.
  ClarityUpscaleRemoteNode: 30,

  // — video —
  Veo3RemoteNode: 900,             // badge $6.00
  KlingVideoRemoteNode: 53,        // badge $0.35 (nodes_replicate.py:1344) — point-priced so the badge stands as-is
  // Seedance2 is RANGE-priced (video_models.py catalog tops out at
  // $0.60/clip) and the same slug is priced at range-top 90cr via the
  // GenerateVideoNode seedance-2.0 row — a badge-bottom price here would
  // underprice the exact same call at its expensive setting. Review ruling
  // (2026-08-17): keep the CONSERVATIVE range-top figure. badge $0.50 vs
  // range-top $0.60 (nodes_replicate.py:1596) — badge divergence flagged for
  // the pre-launch invoice sweep.
  Seedance2RemoteNode: 90,
  EnhanceVideoNode: 150,           // badge $1.00
  LipsyncRemoteNode: 150,          // badge $1.00 / 30s
  LipsyncNode: 150,                // badge $1.00 / 30s

  // — audio / speech —
  WhisperRemoteNode: 1,            // badge $0.001 / min
  TranscribeAudioNode: 1,          // badge $0.005 / min
  MusicGenRemoteNode: 4,           // badge $0.02
  GenerateMusicNode: 4,            // badge $0.02
  MiniMaxSpeechRemoteNode: 45,     // badge $0.30 / 1K chars
  GenerateSpeechNode: 45,          // badge $0.30 / 1K chars
  CloneSingingVoiceNode: 4,        // badge $0.02 / min
  IdentifySpeakersNode: 10,        // badge $0.05 / min

  // — 3D —
  Hunyuan3DRemoteNode: 45,         // badge $0.30
  Hunyuan3DMultiViewNode: 45,      // badge $0.30
  Generate3DNode: 45,              // badge $0.30

  // — vision / text utility —
  DescribeImageRemoteNode: 1,      // badge $0.001
  DescribeImageNode: 1,            // badge $0.001
  DescribeVideoNode: 2,            // badge $0.01
  ExtractTextNode: 1,              // badge $0.005
  FindObjectsNode: 1,              // badge $0.005
  ChatLLMNode: 1,                  // badge $0.005
  ImprovePromptNode: 1,            // badge $0.001
  SummarizeTextNode: 1,            // badge $0.001
  TranslateTextNode: 1,            // badge $0.001
  RewriteToneNode: 1,              // badge $0.002
  BrainstormIdeasNode: 1,          // badge $0.003
  ReasonStepByStepNode: 2,         // badge $0.01

  // — comfy_extras wrappers that dispatch through nodes_replicate —
  RemoveObjectNode: 10,            // badge $0.05
  TextEditNode: 10,                // badge $0.05
  RecolorObjectNode: 10,           // badge $0.05
  PersonSwapNode: 10,              // badge $0.05
  PoseMannequinNode: 10,           // badge $0.05
  SwapBackgroundNode: 10,          // badge $0.05
  SwapProductNode: 10,             // badge $0.05
  RelightNode: 10,                 // badge $0.05
  LensReframeNode: 10,             // no badge — same nano-banana-2 edit call as its $0.05 siblings
  TurntableNode: 75,               // badge $0.50
}

/**
 * Classes whose price depends on a model/engine widget in `inputs`. Each one
 * refuses when the widget value is missing or unknown.
 */
export const MODEL_PRICED_NODE_CLASSES = [
  'GenerateImageNode',
  'GenerateVideoNode',
  'FilmShotNode',
  'UpscaleImageNode',
  'EnhanceDetailNode',
]

/**
 * Classes that are free by design — no provider call in their execute body.
 * The reason string is documentation and the coverage guard requires one.
 * Empty today: every class in the provider modules dispatches to a provider.
 */
export const PROVIDER_NODE_EXEMPT: Record<string, string> = {}

/**
 * Runtime list of provider node classes. Checked in as a literal on purpose —
 * the pricer must never read the Python tree at runtime. A drift guard in
 * price-graph.unit.spec.ts asserts this equals the grep of nodes_replicate.py
 * plus the comfy_extras modules that import its dispatch helpers, so adding a
 * Python node without pricing it fails tests rather than production.
 */
export const PROVIDER_NODE_CLASSES: string[] = [
  'FluxLoRARemoteNode', 'FluxMultiLoRARemoteNode', 'FluxProRemoteNode',
  'FluxKontextRemoteNode', 'KlingVideoRemoteNode', 'ClarityUpscaleRemoteNode',
  'IdeogramV3TurboNode', 'Veo3RemoteNode', 'Seedance2RemoteNode',
  'WhisperRemoteNode', 'MusicGenRemoteNode', 'MiniMaxSpeechRemoteNode',
  'Hunyuan3DRemoteNode', 'Hunyuan3DMultiViewNode', 'RemoveBackgroundRemoteNode',
  'RestorePhotoRemoteNode', 'CodeformerRemoteNode', 'DescribeImageRemoteNode',
  'LipsyncRemoteNode', 'GenerateImageNode', 'EditImageNode', 'DevelopImageNode',
  'GenerateFromReferencesNode', 'BlendSceneNode', 'RestyleFromImageNode',
  'RestyleWithLoRANode', 'ProductShotNode', 'RotateCameraNode', 'TextEffectNode',
  'GenerateVideoNode', 'FilmShotNode', 'UpscaleImageNode', 'EnhanceDetailNode',
  'RemoveBackgroundNode', 'RestorePhotoNode', 'FixFacesNode', 'LayerizeGraphicNode',
  'SplitPhotoLayersNode', 'SeedreamLayerizeNode', 'OutpaintImageNode',
  'DescribeImageNode', 'LipsyncNode', 'LipSyncNode', 'TranscribeAudioNode',
  'GenerateMusicNode', 'GenerateSpeechNode', 'Generate3DNode', 'SketchToImageNode',
  'ExtractTextNode', 'FindObjectsNode', 'ConsistentFaceNode', 'EnhanceVideoNode',
  'DescribeVideoNode', 'CloneSingingVoiceNode', 'IdentifySpeakersNode', 'ChatLLMNode',
  'ImprovePromptNode', 'SummarizeTextNode', 'TranslateTextNode', 'RewriteToneNode',
  'BrainstormIdeasNode', 'ReasonStepByStepNode',
  // comfy_extras wrappers
  'RemoveObjectNode', 'TextEditNode', 'RecolorObjectNode', 'LensReframeNode',
  'PersonSwapNode', 'PoseMannequinNode', 'RelightNode', 'SwapBackgroundNode',
  'SwapProductNode', 'TurntableNode',
]

// Per-clip video USD (VIDEO_MODEL_USD) and the legacy model-label remap
// (LEGACY_VIDEO_MODEL_IDS) now live in app/data/video-prices.ts, alongside
// ENGINE_USD in app/data/engine-prices.ts. Both are pure-data modules so the
// hosted node cost badge (app/lib/nodeCreditEstimate.ts) can price a picker
// node from the SAME table the server charges from without importing server/.
// VIDEO_MODEL_USD is re-exported at the top of this file so existing importers
// (and the catalog parity test) keep their import path.
//
// Engine-picker nodes: the `model` widget names an engine — not a catalog id.

// Lazily-built lookups. Never derive these at module top level: a top-level
// const reading another module's const breaks on import reorder.
let _imagePrices: Map<string, number | null> | null = null
function imagePriceFor(id: string): number | null | undefined {
  if (!_imagePrices) _imagePrices = new Map(IMAGE_MODELS.map(m => [m.id, m.pricePerImage]))
  return _imagePrices.get(id)
}

let _providerClasses: Set<string> | null = null
function isProviderClass(ct: string): boolean {
  if (!_providerClasses) _providerClasses = new Set(PROVIDER_NODE_CLASSES)
  // The suffix rule catches provider nodes added after this list was written:
  // `*RemoteNode` is the naming convention for every Replicate-backed node.
  return _providerClasses.has(ct) || ct.endsWith('RemoteNode')
}

/** Credits for a model-priced class, or a refusal. */
function graphNodeModelCredits(ct: string, inputs: unknown): number {
  const picked = (inputs as { model?: unknown } | undefined)?.model
  const model = typeof picked === 'string' ? picked : ''
  if (!model) throw new UnpricedGraphError(ct, 'no model selected')

  if (ct === 'GenerateImageNode') {
    const usd = imagePriceFor(model)
    if (usd === undefined) throw new UnpricedGraphError(ct, `unknown model id ${model}`)
    if (usd == null) throw new UnpricedGraphError(ct, `model ${model} has no listed price`)
    return creditsForUsdServer(usd)
  }

  if (ct === 'GenerateVideoNode' || ct === 'FilmShotNode') {
    const id = LEGACY_VIDEO_MODEL_IDS[model] ?? model
    const row = VIDEO_MODEL_USD[id]
    if (!row) throw new UnpricedGraphError(ct, `unknown video model id ${model}`)
    return creditsForUsdServer(row.usd)
  }

  const engines = ENGINE_USD[ct]
  const usd = engines?.[model]
  if (usd == null) throw new UnpricedGraphError(ct, `unknown engine ${model}`)
  return creditsForUsdServer(usd)
}

export interface GraphPrice {
  credits: number
  version: string
  breakdown: { action: string; credits: number }[]
}

export function priceGraph(prompt: Record<string, { class_type: string; inputs?: unknown }>): GraphPrice {
  const breakdown: { action: string; credits: number }[] = []
  let hasOutput = false

  // Sort node ids for order-independent, deterministic breakdown.
  for (const id of Object.keys(prompt).sort()) {
    const ct = prompt[id]?.class_type
    if (!ct) continue
    if (OUTPUT_CLASS_TYPES.has(ct)) hasOutput = true

    if (MODEL_PRICED_NODE_CLASSES.includes(ct)) {
      const inputs = prompt[id]?.inputs
      const credits = graphNodeModelCredits(ct, inputs)
      const model = (inputs as { model?: unknown } | undefined)?.model
      breakdown.push({ action: `${ct}:${String(model)}`, credits })
      continue
    }

    const flat = GRAPH_NODE_CREDITS[ct]
    if (flat !== undefined) { breakdown.push({ action: ct, credits: flat }); continue }

    // Fail closed: a provider node this table cannot price refuses the graph.
    if (isProviderClass(ct) && !(ct in PROVIDER_NODE_EXEMPT)) throw new UnpricedGraphError(ct)
  }

  const out: { action: string; credits: number }[] = []
  if (hasOutput) out.push({ action: 'base_render', credits: BASE_RENDER_CREDITS })
  out.push(...breakdown)

  return {
    credits: out.reduce((s, b) => s + b.credits, 0),
    version: PRICE_BOOK_VERSION,
    breakdown: out,
  }
}

/**
 * Per-model costs for the direct provider routes (Surface A) — keyed by the
 * exact slug/app id that spendLog records, so `.data/spend-events.jsonl`
 * joins against this table. USD figures were checked against live rate cards
 * on 2026-08-11; `confidence: 'estimate'` entries MUST be re-verified before
 * hosted launch (page didn't render a price, or the cost is hardware-billed).
 *
 * Credits follow the pricing strategy: ~2× markup on cheap actions, ~1.5× on
 * expensive ones, floor of 1 credit. Per-megapixel models are priced at a
 * typical ~1MP output — resolution-aware pricing is a Phase-3 refinement.
 */
export interface ModelCost {
  usd: number
  credits: number
  confidence: 'verified' | 'estimate'
  note?: string
}

// Single source of truth for the voice-clone slug — trainingProviders.ts and
// voice-clone/start.post.ts both import this instead of hand-typing the
// string a second time (the old duplication drifted from a comment alone).
// This constant and the 'minimax/voice-cloning' row below MUST stay the same
// string; a unit test in training-meter.unit.spec.ts asserts that.
export const VOICE_CLONE_MODEL = 'minimax/voice-cloning'

export const MODEL_COSTS: Record<string, ModelCost> = {
  // — image generation —
  'black-forest-labs/flux-schnell': { usd: 0.003, credits: 1, confidence: 'verified' },
  'black-forest-labs/flux-dev': { usd: 0.025, credits: 5, confidence: 'verified' },
  'fal-ai/flux/dev': { usd: 0.025, credits: 5, confidence: 'verified', note: '$0.025/MP, rounded up' },
  'black-forest-labs/flux-2-pro': { usd: 0.03, credits: 6, confidence: 'verified', note: '$0.03/MP — 4MP render is $0.12' },
  'bytedance/seedream-4.5': { usd: 0.04, credits: 8, confidence: 'verified' },
  'krea/krea-2-large': { usd: 0.06, credits: 12, confidence: 'verified' },
  'krea/krea-2-medium': { usd: 0.035, credits: 7, confidence: 'estimate' },
  'fal-ai/nano-banana-pro': { usd: 0.15, credits: 23, confidence: 'verified', note: '1.5× markup — premium tier' },
  'fal-ai/nano-banana-pro/edit': { usd: 0.15, credits: 23, confidence: 'estimate', note: 'assumed same as generate' },
  'ideogram-ai/ideogram-character': { usd: 0.08, credits: 16, confidence: 'estimate', note: 'identity-preserving shot from a reference photo; 2x markup — re-verify against a live invoice' },
  // — inpaint / edit —
  'black-forest-labs/flux-kontext-dev': { usd: 0.025, credits: 5, confidence: 'estimate', note: 'assumed flux-dev rate' },
  'black-forest-labs/flux-fill-dev': { usd: 0.04, credits: 8, confidence: 'estimate' },
  'fal-ai/flux-pro/v1/fill': { usd: 0.05, credits: 10, confidence: 'verified', note: '$0.05/MP, rounded up' },
  // — segmentation / utility —
  'fal-ai/sam-3/image': { usd: 0.005, credits: 1, confidence: 'verified', note: 'promptable SAM 3 — $0.005/request flat; click-to-select fires one per refine' },
  'meta/sam-2': { usd: 0.022, credits: 4, confidence: 'verified', note: 'RETIRED from inpaint (segment-everything, ignored points); kept for pricing history' },
  '851-labs/background-remover': { usd: 0.0004, credits: 1, confidence: 'verified' },
  // — vector —
  'recraft-ai/recraft-v3-svg': { usd: 0.08, credits: 16, confidence: 'verified', note: 'vector = 2× Recraft raster rate' },
  'recraft-ai/recraft-vectorize': { usd: 0.01, credits: 2, confidence: 'estimate', note: 'hardware-billed, cheap CPU-ish job' },
  // — 3D —
  'fal-ai/hunyuan3d/v2': { usd: 0.48, credits: 72, confidence: 'verified', note: 'textured mesh; white mesh is $0.16' },
  'fal-ai/trellis-2': { usd: 0.3, credits: 45, confidence: 'verified', note: '$0.25–0.35 by resolution' },
  'fal-ai/tripo3d/tripo/v2.5/image-to-3d': { usd: 0.3, credits: 45, confidence: 'estimate', note: 'model page 404s — re-check slug too' },
  'fal-ai/triposr': { usd: 0.02, credits: 4, confidence: 'estimate' },
  // — audio / speech —
  'minimax/speech-02-turbo': { usd: 0.03, credits: 6, confidence: 'verified', note: '$0.06/1k chars — priced per ~500-char clip' },
  'minimax/voice-cloning': { usd: 3, credits: 450, confidence: 'estimate', note: '$3/voice observed on Replicate pricing (2026-08); one-time per clone, not per-generation' },
  // Lip-sync engine identifiers from comfy_api_nodes/nodes_replicate.py's
  // LipSyncNode (_lipsync_build_input) — that Python-side dispatch is priced
  // flat via PREMIUM_ACTION_CREDITS.LipSyncNode today, NOT via these rows; no
  // Stage-4 bypass route in server/api currently calls either slug directly.
  // Rows added ahead of that migration per the per-engine v1 pricing policy
  // below — duration-aware pricing is a hardening rider.
  'veed/fabric-1.0': { usd: 0.75, credits: 113, confidence: 'estimate', note: 'flat v1 price per ~5s clip at 1.5x — duration-aware pricing is a hardening rider' },
  'kwaivgi/kling-lip-sync': { usd: 0.07, credits: 14, confidence: 'estimate', note: 'flat v1 price per ~5s clip at 2x — duration-aware pricing is a hardening rider' },
  // — LLM utility (per-token, pennies) —
  'meta/meta-llama-3-8b-instruct': { usd: 0.001, credits: 1, confidence: 'estimate' },
  'lucataco/qwen2-vl-7b-instruct': { usd: 0.003, credits: 1, confidence: 'estimate' },
  // — slugs behind graph nodes priced off their own price_badge (Stage 5
  // Task 3 review fix). These three carry a badge in the multi-line
  // `price_badge=IO.PriceBadge(` form the original sweep missed (all in
  // comfy_api_nodes/nodes_replicate.py). kling-v2.1 is point-priced so its
  // badge $0.35 stands. seedance-2.0 and clarity-upscaler are RANGE-priced —
  // badge $0.50/$0.10 vs range-top $0.60/$0.20 — and the same slugs are
  // priced at range top via the picker nodes (GenerateVideoNode /
  // UpscaleImageNode). Review ruling (2026-08-17): keep the CONSERVATIVE
  // range-top figure so the expensive setting is never underpriced — badge
  // divergence flagged for the pre-launch invoice sweep.
  'kwaivgi/kling-v2.1': { usd: 0.35, credits: 53, confidence: 'estimate', note: 'per ~5s clip — duration-aware pricing is a hardening rider' },
  'bytedance/seedance-2.0': { usd: 0.6, credits: 90, confidence: 'estimate', note: 'matches the GenerateVideoNode picker row range-top ($0.60); node price_badge quotes $0.50 — duration-aware pricing is a hardening rider' },
  'philz1337x/clarity-upscaler': { usd: 0.2, credits: 30, confidence: 'estimate', note: 'matches the UpscaleImageNode "Clarity" picker row range-top ($0.20); node price_badge quotes $0.10 — duration/scale-factor variance is a hardening rider' },
  // — Frame Animate (/api/frame/animate) — exact slugs runFal/runReplicate
  // dispatch with, priced flat off the 5s row in app/data/video-prices.ts
  // (VIDEO_MODEL_USD). Without these rows, preflightMeter's costForModel
  // miss refuses every call ("unpriced model refused"). A duration-aware
  // hold (credits scaled by the chosen clip length) was investigated via
  // setMeterPriceHint but NOT wired — see the comment above the model
  // dispatch in animate.post.ts: requestMeter's resolveCredits checks
  // costForModel(model) FIRST and only falls back to priceHintCredits when
  // the model is unpriced, so once a flat row exists here any hint set by
  // the route is silently ignored. The hold is flat per model regardless of
  // `seconds` until that precedence changes (a shared chokepoint — out of
  // scope for this fix).
  'bytedance/seedance-2.0/image-to-video': { usd: 0.6, credits: 90, confidence: 'estimate', note: 'Frame Animate — flat per 5 s clip; duration-aware hold via setMeterPriceHint in server/api/frame/animate.post.ts' },
  'minimax/h3/image-to-video': { usd: 0.3, credits: 45, confidence: 'estimate', note: 'Frame Animate — flat per 5 s clip; duration-aware hold via setMeterPriceHint in server/api/frame/animate.post.ts' },
  'luma/ray-2-720p': { usd: 0.4, credits: 60, confidence: 'estimate', note: 'Frame Animate — flat per 5 s clip; duration-aware hold via setMeterPriceHint in server/api/frame/animate.post.ts' },
  // — training (hardware-billed; matches LoraTrainingNode=600 in the graph table) —
  'ostris/flux-dev-lora-trainer': { usd: 2.5, credits: 600, confidence: 'estimate', note: 'H100 ~15–40min; 600cr keeps parity with graph table' },
  'ostris/sdxl-lora-trainer': { usd: 2, credits: 600, confidence: 'estimate' },
}

/** Cost entry for a spend-event model slug, or null if the model is unpriced. */
export function costForModel(model: string): ModelCost | null {
  return MODEL_COSTS[model] ?? null
}
