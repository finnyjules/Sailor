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
import { creditsForUsd } from '../../shared/pricing/markup'
import { MODEL_PRICED_NODE_CLASSES, REMOTE_VIDEO_NODE_CLASSES, SETTING_PRICED_NODE_CLASSES, SHARED_PRICED_CLASS_SET, priceNode } from '../../shared/pricing/nodePrice'
import { VIDEO_RATES } from '../../shared/pricing/videoRates'
import type { InputSeconds } from '../../shared/pricing/clipSettings'
export { VIDEO_RATES, MODEL_PRICED_NODE_CLASSES, SETTING_PRICED_NODE_CLASSES, REMOTE_VIDEO_NODE_CLASSES }
// lineup-p2 (model line-up Task P2): video priced per second of the clip
// actually sent (shared/pricing/videoRates.ts), replacing one flat figure per model.
// lineup-p3 (Task P3, one bump for P2's fix round and P3): images priced by
// size, quality and picture count (shared/pricing/imageRates.ts); Krea 2
// priced; the markup no longer charges a credit for float noise.
// lineup-p4 (Task P4): the image edit tools priced by the call their settings
// make (shared/pricing/editRates.ts): resolution, size and model; Upscale and
// Enhance detail at the largest accepted input × the scale chosen.
// lineup-p4b (P4 fix round 1): a Nano Banana edit is priced at the dearest
// step of the ComfyUI path's fallback chain; Upscale, Enhance detail and
// FLUX.2 edit read the measured input size where the gate or runner sees it,
// else the 4096² cap.
// lineup-p4c (P4 fix round 2): RestyleWithLoRANode priced by its calls and
// resolution (every Nano Banana re-roll included); an upstream Nano Banana
// picture measured at its ratio's real size.
// lineup-p5 (Task P5): Frame Animate held and charged per second of the
// request it sends (a per-request price now wins over a flat MODEL_COSTS row);
// the older Veo 3 / Kling 2.1 / Seedance 2.0 nodes priced per second of what
// they send; lip-sync at the longest clip it can make (shared/pricing/clipRates.ts).
// lineup-p5b (P5 fix round 1): lip-sync billed by the measured clip (the
// gate reads the sound file; Kling lip-sync its source video), the 60 s cap
// only when it can't; sync.so "silence" mode refused; the input-picture cap
// raised to 12288 × 1536, the widest Nano Banana 4K picture.
// lineup-s1b (Task S1b): the runner's builders follow the providers' schemas,
// and the prices read what they now send: PixVerse v6 its quality and sound,
// Wan 2.5/2.7 their duration and 720p/1080p, LTX-Video its steps, Flux 2 Dev
// its width × height (≤ 1440²), H3 Max 1080p, Sora its 4/8/12 s; an option
// outside a schema is priced as the default it is sent as.
// lineup-s1b-fix1 (S1b fix round 1): while the ComfyUI path is live, never
// below what its request costs — PixVerse at least 540p, Wan 2.7 at least 5 s,
// Flux 2 Dev at least 2 MP; LTX-Video back to its flat 50-step ceiling;
// Seedance 2.0 takes (and prices) 14 s.
// lineup-s3 (Task S3): first and backup services. Kling 3.0 and PixVerse v6
// priced at fal (their new first service), Relight and Restyle on Nano Banana
// 2 at Replicate; a model with a backup is priced at the first service with
// the markup, or the backup at cost, whichever is higher (so Kling 3.0 and
// PixVerse v6 charge Replicate's cost, their ComfyUI path's service).
// lineup-f1 (Task F1): Wan 3.0 and Wan 3.0 Prime, fal per second by
// resolution (runner-only, family wan-3). No other price moves.
// lineup-f2 (Task F2): GPT Image 2.5 in Generate an image (by quality, fal's
// dearest canonical size) and Edit an image (medium, fal's largest size),
// Replicate the backup at cost (runner-only, family gpt-image-2.5). No other
// price moves.
// lineup-f3 (Task F3): Hailuo H3 Max Turbo, fal per second by resolution at
// the list price after the launch promotion (runner-only, family
// h3-max-turbo). No other price moves.
// lineup-f4 (Task F4): Gemini Omni Flash, fal's own per-second figure at 720p
// (it bills tokens), $0.13/s (runner-only, family gemini-omni-flash). No other
// price moves.
// lineup-f5 (Task F5): Veo 3.1 Lite, fal per second by resolution and sound
// ($0.05/s at 720p with sound; runner-only, family veo-3.1-lite). No other
// price moves.
// lineup-f6 (Task F6): Qwen Image 3, Replicate's flat $0.03 an image
// (runner-only, family qwen-image-3, no backup). No other price moves.
// lineup-f7 (Task F7): Grok Imagine 2, Replicate's flat $0.04 an image
// (runner-only, family grok-imagine-2, no backup). No other price moves.
// lineup-f8 (Task F8): Ideogram 4, fal per megapixel by speed ($0.0075 /
// $0.015 / $0.025), Replicate's $0.03 / $0.06 / $0.10 the backup for a 2K
// picture (runner-only, family ideogram-4). Ideogram V3 and the old Grok
// Imagine are hidden, their prices unchanged. No other price moves.
// lineup-f9 (Task F9): Seedream 5 Pro in Edit an image, Replicate's $0.045 /
// $0.09 an image at 1K / 2K, the card References already uses (runner-only,
// family seedream-5-pro-edit, no backup). No other price moves.
export const PRICE_BOOK_VERSION = 'lineup-f9'

export const BASE_RENDER_CREDITS = 1

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
// (RESTYLE_LORA_CREDITS, 18, is gone: RestyleWithLoRANode is priced by its calls since lineup-p4c.)

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
 * The markup policy, under its historical server name. It is the one function
 * in shared/pricing/markup.ts (2x on provider cost <= $0.10 and 1.5x above
 * with a floor of 1 credit) — not a copy.
 */
export const creditsForUsdServer = creditsForUsd

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
 * MODEL_PRICED_NODE_CLASSES, SETTING_PRICED_NODE_CLASSES and PROVIDER_NODE_EXEMPT to cover every
 * IO.ComfyNode class in the provider modules.
 *
 * Keys are NODE_IDS (the `node_id="…"` in each class's schema), which is what
 * the canvas sends as class_type — not the Python class name. Where the two
 * differ the class name is noted beside the row.
 */
export const GRAPH_NODE_CREDITS: Record<string, number> = {
  // — spike-v3 hand-set rows: kept verbatim —
  // (EditImageNode, 23 flat, is priced by its settings since lineup-p4 — see
  // SETTING_PRICED_NODE_CLASSES below.)
  LoraTrainingNode: 600,
  // (RestyleWithLoRANode, 18 flat, is priced by its calls and resolution since lineup-p4c.)
  FluxLoRARemoteNode: LORA_RENDER_CREDITS,
  FluxMultiLoRARemoteNode: LORA_RENDER_CREDITS,
  // (GenerateVideoNode 60 and FilmShotNode 160 moved to MODEL_PRICED — their
  // model widget spans $0.04 to $3.20 per clip, which no flat price can cover.
  // FilmShot repriced 160 → 75 (default model) on badge+catalog evidence —
  // re-verify against a live invoice at the pre-launch estimate-row sweep.)

  // — image generation / editing —
  // (Edit image, Develop, Generate from references, Blend scene, Restyle,
  // Product shot, Rotate camera, Relight, Lens reframe and the Nano Banana
  // actions are priced by their settings since lineup-p4: see
  // SETTING_PRICED_NODE_CLASSES below.)
  FluxProRemoteNode: 8,            // badge $0.04
  FluxKontextRemoteNode: 8,        // badge $0.04
  IdeogramV3TurboRemoteNode: 6,    // badge $0.03 (Python class IdeogramV3TurboNode; node_id below)
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
  // (Veo3RemoteNode 900, KlingVideoRemoteNode 53 and Seedance2RemoteNode 90
  // flat, and the lip-sync nodes LipSyncNode, LipsyncNode and LipsyncRemoteNode
  // 150 flat, are priced per second since lineup-p5: see
  // REMOTE_VIDEO_NODE_CLASSES, shared/pricing/clipSettings.ts.)
  // EnhanceVideoNode stays flat (P5): topazlabs/video-upscale bills by the
  // source video's length, a URL the gate can't measure, and neither the node
  // nor the service caps it, so there is no "longest clip" to charge. Re-priced
  // with Topaz video in the runner (plan Task F23).
  EnhanceVideoNode: 150,           // badge $1.00

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
  PoseMannequin: 10,               // badge $0.05 (Python class PoseMannequinNode)
  TurntableNode: 75,               // badge $0.50
}

// MODEL_PRICED_NODE_CLASSES — the classes whose price depends on a
// model/engine widget in `inputs` — lives in shared/pricing/nodePrice.ts and
// is re-exported at the top of this file. Each one refuses when the widget
// value is missing or unknown. SETTING_PRICED_NODE_CLASSES — the image edit
// tools, priced by the call their settings make — lives in
// shared/pricing/editSettings.ts and is re-exported too; an edit node refuses
// only a model it does not offer.

/**
 * Classes that are free by design — no provider call in their execute body.
 * The reason string is documentation and the coverage guard requires one.
 * Empty today: every class in the provider modules dispatches to a provider.
 */
export const PROVIDER_NODE_EXEMPT: Record<string, string> = {}

/**
 * Runtime list of provider node classes. Checked in as a literal on purpose —
 * the pricer must never read the Python tree at runtime. A drift guard in
 * price-graph.unit.spec.ts asserts this equals the node_ids grepped from
 * nodes_replicate.py plus the comfy_extras modules that import its dispatch helpers, so adding a
 * Python node without pricing it fails tests rather than production.
 */
export const PROVIDER_NODE_CLASSES: string[] = [
  'FluxLoRARemoteNode', 'FluxMultiLoRARemoteNode', 'FluxProRemoteNode',
  'FluxKontextRemoteNode', 'KlingVideoRemoteNode', 'ClarityUpscaleRemoteNode',
  'IdeogramV3TurboRemoteNode', 'Veo3RemoteNode', 'Seedance2RemoteNode',
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
  'RemoveObjectNode', 'TextEditNode', 'RecolorObjectNode', 'LensReframe',
  'PersonSwap', 'PoseMannequin', 'RelightNode', 'SwapBackgroundNode',
  'SwapProductNode', 'TurntableNode',
]

// Video rates (VIDEO_RATES, per second or per clip) live in
// shared/pricing/videoRates.ts; the legacy model-label remap
// (LEGACY_VIDEO_MODEL_IDS) in app/data/video-prices.ts; the edit and
// upscale rates (EDIT_RATES) in shared/pricing/editRates.ts, which replaced
// app/data/engine-prices.ts. The calculation that reads them — for the
// charge here, the node badge and the run estimate alike — is priceNode in
// shared/pricing/nodePrice.ts. VIDEO_RATES is re-exported at the top of this
// file for server importers.

// Lazily-built lookup. Never derive this at module top level: a top-level
// const reading another module's const breaks on import reorder.
let _providerClasses: Set<string> | null = null
function isProviderClass(ct: string): boolean {
  if (!_providerClasses) _providerClasses = new Set(PROVIDER_NODE_CLASSES)
  // The suffix rule catches provider nodes added after this list was written:
  // `*RemoteNode` is the naming convention for every Replicate-backed node.
  return _providerClasses.has(ct) || ct.endsWith('RemoteNode')
}

/**
 * Credits for a model-priced class, or a refusal. The price is the shared
 * calculation (the same one the node badge and the run estimate read), given
 * the node's WHOLE input map.
 */
function graphNodeModelCredits(ct: string, inputs: unknown, inputPixels: number | undefined, inputSeconds: InputSeconds | undefined): number {
  const map = inputs && typeof inputs === 'object' ? inputs as Record<string, unknown> : {}
  const price = priceNode(ct, map, { inputPixels, inputSeconds })
  if ('refused' in price) throw new UnpricedGraphError(ct, price.refused)
  return price.credits
}

export interface GraphPrice {
  credits: number
  version: string
  breakdown: { action: string; credits: number }[]
}

/**
 * `opts.inputPixels`: node id → the measured size of the picture a
 * size-priced node (Upscale, Enhance detail, FLUX.2 edit) is sent, where the
 * caller could read it (graphInputPixels.ts on the hosted gate, the runner
 * before it submits). A node with no entry is priced at the input cap.
 *
 * `opts.inputSeconds`: node id → the measured length of a lip-sync node's
 * sound clip (and Kling lip-sync's source video) — graphInputSeconds.ts on
 * the hosted gate. A node with no entry is priced at the 60 s cap.
 */
export function priceGraph(prompt: Record<string, { class_type: string; inputs?: unknown }>, opts: { inputPixels?: Record<string, number>, inputSeconds?: Record<string, InputSeconds> } = {}): GraphPrice {
  const breakdown: { action: string; credits: number }[] = []
  let hasOutput = false

  // Sort node ids for order-independent, deterministic breakdown.
  for (const id of Object.keys(prompt).sort()) {
    const ct = prompt[id]?.class_type
    if (!ct) continue
    if (OUTPUT_CLASS_TYPES.has(ct)) hasOutput = true

    if (SHARED_PRICED_CLASS_SET.has(ct)) {
      const inputs = prompt[id]?.inputs
      const px = opts.inputPixels && Object.prototype.hasOwnProperty.call(opts.inputPixels, id) ? opts.inputPixels[id] : undefined
      const secs = opts.inputSeconds && Object.prototype.hasOwnProperty.call(opts.inputSeconds, id) ? opts.inputSeconds[id] : undefined
      const credits = graphNodeModelCredits(ct, inputs, px, secs)
      const model = (inputs as { model?: unknown } | undefined)?.model
      // A class with no model widget (Develop, Relight…) is named alone, as its flat row was.
      breakdown.push({ action: model === undefined ? ct : `${ct}:${String(model)}`, credits })
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
  // — fal defaults (2026-09-11: every inpaint / vector route moved off Replicate) —
  'fal-ai/flux/schnell': { usd: 0.003, credits: 1, confidence: 'verified', note: '$0.003/MP' },
  'fal-ai/flux-2-pro': { usd: 0.03, credits: 6, confidence: 'verified', note: '$0.03/MP' },
  'fal-ai/bytedance/seedream/v4.5/text-to-image': { usd: 0.04, credits: 8, confidence: 'verified', note: 'flat per image' },
  'fal-ai/flux-kontext/dev': { usd: 0.025, credits: 5, confidence: 'estimate', note: 'assumed flux-dev rate' },
  'fal-ai/flux-lora': { usd: 0.035, credits: 7, confidence: 'estimate', note: '$0.035/MP — LoRA inference moved here from per-owner Replicate models' },
  // — scene3d AI restyle (S7) — allowlisted in app/data/scene3d-restyle-models.ts; each id MUST
  //   have a row here or runFal refuses ("unpriced model"). Both estimates — re-verify against a
  //   live invoice at the Task-5 paid acceptance run (reconcile observed cost).
  'fal-ai/flux-control-lora-depth': { usd: 0.035, credits: 7, confidence: 'estimate', note: 'FLUX.1 [dev] Depth Control LoRA — ~$0.035/MP; re-verify against a live invoice (S7 Task 5)' },
  'fal-ai/flux/dev/image-to-image': { usd: 0.025, credits: 5, confidence: 'estimate', note: 'FLUX.1 [dev] img2img fallback — assumed fal flux/dev $0.025/MP rate; re-verify against a live invoice (S7 Task 5)' },
  'fal-ai/flux-general': { usd: 0.05, credits: 10, confidence: 'estimate', note: 'FLUX general (depth ControlNet + IP-adapter, one call) — assumed ~$0.05/MP for the heavier graph; re-verify against a live invoice (restyle-style Task 5)' },
  'fal-ai/flux-lora/inpainting': { usd: 0.04, credits: 8, confidence: 'estimate', note: 'FLUX Fill dev tier' },
  'fal-ai/nano-banana-2/edit': { usd: 0.10, credits: 20, confidence: 'estimate', note: 'pose transfer; verify against fal pricing' },
  // — inpaint / whole-image edit routes, priced 2026-09-20 from fal's own model pages. Unpriced, every
  //   one of these was REFUSED in hosted mode (the meter fails closed), FLUX.2 edit — the default edit
  //   model — included. Per-megapixel rows are priced for a ~1 MP job, like their neighbours above.
  'fal-ai/flux-2-pro/edit': { usd: 0.045, credits: 9, confidence: 'verified', note: '$0.03 first MP + $0.015 per extra MP of input AND output combined — one 1 MP reference + a 1 MP result' },
  'fal-ai/qwen-image-edit/inpaint': { usd: 0.03, credits: 6, confidence: 'verified', note: '$0.03/MP' },
  'fal-ai/flux-general/inpainting': { usd: 0.075, credits: 15, confidence: 'verified', note: '$0.075/MP, rounded up' },
  'fal-ai/bytedance/seedream/v5/lite/edit': { usd: 0.035, credits: 7, confidence: 'verified', note: 'flat per image' },
  'fal-ai/nano-banana-2': { usd: 0.08, credits: 16, confidence: 'verified', note: 'flat per image at 1K; 2K is 1.5x and 4K 2x' },
  // GPT Image 1.5: fal defaults `quality` to "high" and our calls do not set it — $0.133 (1024x1024) to
  // $0.200 (1024x1536) per image, plus input image tokens. Priced at the top of that range. Sending
  // quality "medium" (~$0.05) would cut this by three quarters; that is a product call, not made here.
  'fal-ai/gpt-image-1.5/edit': { usd: 0.20, credits: 30, confidence: 'estimate', note: 'default quality high: $0.133-$0.200/image + input image tokens; priced at the top' },
  'fal-ai/gpt-image-1.5': { usd: 0.20, credits: 30, confidence: 'estimate', note: 'same tiers as /edit, without the input image' },
  'fal-ai/birefnet/v2': { usd: 0.005, credits: 1, confidence: 'estimate', note: 'background removal' },
  'fal-ai/recraft/v3/text-to-image': { usd: 0.08, credits: 16, confidence: 'verified', note: 'vector styles = 2× raster' },
  'fal-ai/recraft/vectorize': { usd: 0.01, credits: 2, confidence: 'estimate' },
  // — segmentation / utility —
  'fal-ai/sam-3/image': { usd: 0.005, credits: 1, confidence: 'verified', note: 'promptable SAM 3 — $0.005/request flat; click-to-select fires one per refine' },
  'meta/sam-2': { usd: 0.022, credits: 4, confidence: 'verified', note: 'RETIRED from inpaint (segment-everything, ignored points); kept for pricing history' },
  '851-labs/background-remover': { usd: 0.0004, credits: 1, confidence: 'verified' },
  // — vector —
  'recraft-ai/recraft-v3-svg': { usd: 0.08, credits: 16, confidence: 'verified', note: 'vector = 2× Recraft raster rate' },
  'recraft-ai/recraft-vectorize': { usd: 0.01, credits: 2, confidence: 'estimate', note: 'hardware-billed, cheap CPU-ish job' },
  // — 3D —
  'fal-ai/hunyuan3d/v2': { usd: 0.48, credits: 72, confidence: 'verified', note: 'textured mesh; white mesh is $0.16' },
  'fal-ai/hyper3d/rodin': { usd: 0.5, credits: 75, confidence: 'estimate', note: 'Rodin (Deemos); medium quality/PBR — HighPack (4K/high-poly) costs more' },
  'fal-ai/trellis-2': { usd: 0.3, credits: 45, confidence: 'verified', note: '$0.25–0.35 by resolution' },
  'tripo3d/tripo/v2.5/image-to-3d': { usd: 0.3, credits: 45, confidence: 'estimate', note: 'partner slug (no fal-ai/ prefix); verified against live model page' },
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
  // — Frame Animate (/api/frame/animate) — the exact fal endpoints the route
  // sends to. Since lineup-p5 these rows are NOT what an Animate call is held
  // or charged: runFal prices every request to these endpoints per second
  // from what it sends (shared/pricing/clipSettings.ts requestPrice, the
  // CLIP_RATES cards), and requestMeter's resolveCredits puts that
  // per-request price ahead of any row here. Each row is a fail-safe ceiling
  // for a caller that doesn't hand the meter its request: the longest clip
  // Animate offers, at the settings it sends (app/data/clip-models.ts).
  'bytedance/seedance-2.0/image-to-video': { usd: 3.6408, credits: 547, confidence: 'verified', note: 'ceiling only: 12 s × $0.3034/s at 720p; Animate is priced per request' },
  'minimax/h3/image-to-video': { usd: 0.6, credits: 90, confidence: 'verified', note: 'ceiling only: 10 s × $0.06/s at 768p; Animate is priced per request' },
  'minimax/h3-max/image-to-video': { usd: 1.2, credits: 180, confidence: 'verified', note: 'ceiling only: 15 s × $0.08/s at 768p (list price after the promotion); Animate is priced per request' },
  'fal-ai/kling-video/v3/pro/image-to-video': { usd: 1.12, credits: 168, confidence: 'verified', note: 'ceiling only: 10 s × $0.112/s, audio off; Animate is priced per request' },
  'blackforestlabs/flux-3/first-last-frame-to-video/draft': { usd: 0.9, credits: 135, confidence: 'verified', note: 'ceiling only: 15 s × $0.06/s draft 720p; Animate is priced per request' },
  // — training (hardware-billed; matches LoraTrainingNode=600 in the graph table) —
  'ostris/flux-dev-lora-trainer': { usd: 2.5, credits: 600, confidence: 'estimate', note: 'H100 ~15–40min; 600cr keeps parity with graph table' },
  'ostris/sdxl-lora-trainer': { usd: 2, credits: 600, confidence: 'estimate' },
}

/** Cost entry for a spend-event model slug, or null if the model is unpriced. */
export function costForModel(model: string): ModelCost | null {
  return MODEL_COSTS[model] ?? null
}
