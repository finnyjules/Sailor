/**
 * Action catalog — the Actions panel's organizing metadata.
 *
 * Maps each use-case node to its user-facing title, model subline, and
 * INTENT (create / edit / enhance / analyze). The panel fetches the live
 * node list from /object_info; this file decides how it reads.
 * Keep in sync when new action nodes ship — an unmapped node still shows,
 * but falls into the "More models" section with its raw label.
 */

export type ActionDomain = 'image' | 'audio' | 'video' | '3d' | 'text'
export type ActionIntent = 'create' | 'edit' | 'enhance' | 'analyze'
export type ActionSource = 'image' | 'video' | 'audio' | 'text'

export interface ActionEntry {
  useCase: string
  model: string
  intent: ActionIntent
  /** Upstream artifact this action consumes (absent = prompt-only). Drives
   *  the start-modal's pre-wired source artifact. Additive metadata — set
   *  where known; only surfaces that render an entry require it. */
  source?: ActionSource
}

export const ACTION_CATALOG: Record<string, ActionEntry> = {
  // -- Image · create --------------------------------------------------------
  GenerateImageNode:     { useCase: 'Generate an image',              model: 'Many models · pick in gallery',            intent: 'create' },
  FluxLoRARemoteNode:    { useCase: 'Generate an image with a style', model: 'Flux Dev + LoRA',                         intent: 'create' },
  ConsistentFaceNode:    { useCase: 'Generate face references',       model: 'Ideogram Character',                       intent: 'create' },
  SketchToImageNode:     { useCase: 'Sketch to image',                model: 'Nano Banana',                              intent: 'create' },
  GenerateFromReferencesNode: { useCase: 'Generate from references',  model: 'Seedream 5 Pro/Lite · Nano Banana 2',       intent: 'create', source: 'image' },
  FluxMultiLoRARemoteNode: { useCase: 'Mix styles together',          model: 'Flux Dev + LoRAs',                        intent: 'create' },
  TextEffectNode:        { useCase: 'Render a text effect',           model: 'Typographic art gallery',                  intent: 'create' },
  // -- Image · edit -----------------------------------------------------------
  EditImageNode:         { useCase: 'Edit an image',                  model: 'Nano Banana 2 / Flux Kontext / Flux 2 Pro', intent: 'edit', source: 'image' },
  RestyleFromImageNode:  { useCase: 'Restyle from an image',          model: 'Nano Banana / IP-Adapter',                 intent: 'edit' },
  RestyleWithLoRANode:   { useCase: 'Restyle with your style',        model: 'Moondream + Flux LoRA + Nano Banana 2',    intent: 'edit' },
  PersonSwap:            { useCase: 'Swap a person',                  model: 'Nano Banana 2',                            intent: 'edit' },
  PoseMannequin:         { useCase: 'Re-pose a character',            model: 'Nano Banana 2',                            intent: 'edit' },
  Scene3DStudio:         { useCase: 'Stage a 3D scene for control renders', model: 'Local (Three.js)',                    intent: 'create' },
  RelightNode:           { useCase: 'Relight a photo',                model: 'Nano Banana 2',                            intent: 'edit' },
  ProductShotNode:       { useCase: 'Make a product shot',            model: 'SDXL Ad-Inpaint',                          intent: 'edit' },
  RemoveBackgroundNode:  { useCase: 'Remove background',              model: '851-labs/bg-remover',                      intent: 'edit' },
  LayerizeGraphicNode:   { useCase: 'Separate text from image',       model: 'Ideogram Layerize',                        intent: 'edit' },
  SeedreamLayerizeNode:  { useCase: 'Layerize an image',              model: 'Seedream 5 Pro Layerize',                  intent: 'edit' },
  SplitPhotoLayersNode:  { useCase: 'Separate background and foreground', model: 'BG Remover + LaMa / Bria Eraser',       intent: 'edit' },
  OutpaintImageNode:     { useCase: 'Expand / outpaint an image',     model: 'Flux Fill / Bria Expand',                  intent: 'edit' },
  BlendSceneNode:        { useCase: 'Blend a composite into a scene', model: 'Flux Kontext Pro / Flux 2 Pro / Nano Banana', intent: 'edit' },
  SwapProductNode:       { useCase: 'Swap a product into a scene', model: 'Nano Banana 2',                            intent: 'edit' },
  SwapBackgroundNode:    { useCase: 'Swap the background behind a product', model: 'Nano Banana 2', intent: 'edit' },
  RotateCameraNode:      { useCase: 'Rotate the camera',              model: 'Qwen-Image-Edit-Plus',                     intent: 'edit' },
  RemoveObjectNode:      { useCase: 'Remove an object',               model: 'Nano Banana 2',                            intent: 'edit', source: 'image' },
  TextEditNode:          { useCase: 'Edit text in an image',          model: 'Nano Banana 2',                            intent: 'edit', source: 'image' },
  RecolorObjectNode:     { useCase: 'Recolor an object',              model: 'Nano Banana 2',                            intent: 'edit', source: 'image' },
  // -- Image · enhance --------------------------------------------------------
  UpscaleImageNode:      { useCase: 'Upscale an image',               model: 'Clarity',                                  intent: 'enhance' },
  RestorePhotoNode:      { useCase: 'Restore an old photo',           model: 'Flux Kontext · Restore',                   intent: 'enhance' },
  FixFacesNode:          { useCase: 'Fix faces in a photo',           model: 'CodeFormer',                               intent: 'enhance' },
  EnhanceDetailNode:     { useCase: 'Enhance detail in an image',     model: 'Clarity / Topaz / Magic Refiner',          intent: 'enhance' },
  // -- Image · analyze --------------------------------------------------------
  DescribeImageNode:     { useCase: 'Describe an image',              model: 'Moondream 2',                              intent: 'analyze' },
  ExtractTextNode:       { useCase: 'Extract text from image',        model: 'ByteDance Dolphin (OCR)',                  intent: 'analyze' },
  FindObjectsNode:       { useCase: 'Find objects in an image',       model: 'YOLO-World',                               intent: 'analyze' },
  // -- Video -------------------------------------------------------------------
  GenerateVideoNode:     { useCase: 'Generate a video',               model: 'Seedance / Veo 3 / Kling',                 intent: 'create' },
  TurntableNode:         { useCase: 'Spin a product 360°',            model: 'Luma Ray 2 / Seedance 2.0',                intent: 'create' },
  FilmShotNode:          { useCase: 'Film a shot',                    model: 'Kling v2.5 Turbo Pro + shot presets',      intent: 'create' },
  LipsyncNode:           { useCase: 'Sync lips to audio',             model: 'sync.so 2-pro',                            intent: 'edit', source: 'video' },
  LipSyncNode:           { useCase: 'Lip-sync a character',           model: 'VEED Fabric 1.0 / sync.so 2-pro',          intent: 'edit' },
  EnhanceVideoNode:      { useCase: 'Enhance a video',                model: 'Topaz',                                    intent: 'enhance' },
  DescribeVideoNode:     { useCase: 'Describe a video',               model: 'Gemini 2.5 Flash',                         intent: 'analyze' },
  // -- Audio -------------------------------------------------------------------
  GenerateMusicNode:     { useCase: 'Generate music',                 model: 'MusicGen',                                 intent: 'create' },
  GenerateSpeechNode:    { useCase: 'Generate speech',                model: 'MiniMax Speech-02 HD',                     intent: 'create' },
  CloneSingingVoiceNode: { useCase: 'Clone a singing voice',          model: 'RVC',                                      intent: 'edit' },
  TranscribeAudioNode:   { useCase: 'Transcribe audio',               model: 'Whisper',                                  intent: 'analyze' },
  IdentifySpeakersNode:  { useCase: 'Identify speakers in audio',     model: 'Whisper Diarization',                      intent: 'analyze' },
  // -- 3D ----------------------------------------------------------------------
  Generate3DNode:        { useCase: 'Generate a 3D model',            model: 'Hunyuan3D 2',                              intent: 'create' },
  Hunyuan3DMultiViewNode: { useCase: 'Reconstruct 3D from multi-view', model: 'TRELLIS / Rodin / Hunyuan3D-2mv',         intent: 'create' },
  // -- Text / LLM ---------------------------------------------------------------
  ChatLLMNode:           { useCase: 'Chat with an LLM',               model: 'GPT-5 / Claude / Gemini',                  intent: 'create' },
  BrainstormIdeasNode:   { useCase: 'Brainstorm ideas',               model: 'GPT-5 mini',                               intent: 'create' },
  ImprovePromptNode:     { useCase: 'Improve a prompt',               model: 'GPT-5 nano',                               intent: 'edit' },
  TranslateTextNode:     { useCase: 'Translate text',                 model: 'Gemini 3 Flash',                           intent: 'edit' },
  RewriteToneNode:       { useCase: 'Rewrite in a tone',              model: 'Claude 4.5 Haiku',                         intent: 'edit' },
  SummarizeTextNode:     { useCase: 'Summarize text',                 model: 'Gemini 3 Flash',                           intent: 'analyze' },
  ReasonStepByStepNode:  { useCase: 'Think step by step',             model: 'DeepSeek R1',                              intent: 'analyze' },
}

// Per-model classes still registered server-side for saved-workflow
// back-compat, but hidden from the panel — use-case nodes are the front door.
export const DEPRECATED_NODES = new Set<string>([
  'FluxProRemoteNode',
  'IdeogramV3TurboRemoteNode',
  'FluxKontextRemoteNode',
  'ClarityUpscaleRemoteNode',
  'RemoveBackgroundRemoteNode',
  'RestorePhotoRemoteNode',
  'CodeformerRemoteNode',
  'DescribeImageRemoteNode',
  'Seedance2RemoteNode',
  'Veo3RemoteNode',
  'KlingVideoRemoteNode',
  'LipsyncRemoteNode',
  'WhisperRemoteNode',
  'MusicGenRemoteNode',
  'MiniMaxSpeechRemoteNode',
  'Hunyuan3DRemoteNode',
])

// Hero tier — the 1–4 highest-frequency actions per domain tab, pinned above
// the intent sections and excluded from them. Order here = display order.
export const HERO_BY_DOMAIN: Record<ActionDomain, string[]> = {
  image: ['GenerateImageNode', 'FluxLoRARemoteNode', 'EditImageNode', 'UpscaleImageNode'],
  video: ['GenerateVideoNode', 'LipsyncNode', 'EnhanceVideoNode'],
  audio: ['GenerateSpeechNode', 'GenerateMusicNode', 'TranscribeAudioNode'],
  '3d':  ['Generate3DNode'],
  text:  ['ChatLLMNode', 'ImprovePromptNode'],
}

// Selection chips — the 2–3 takes-input actions surfaced on a selected media
// node (spec §3: a sampler, never the whole store; "All actions…" opens the
// panel). chipLabel = the short verb form of the useCase for a 1-line strip.
export const CHIPS_BY_DOMAIN: Record<ActionDomain, { nodeType: string; chipLabel: string }[]> = {
  image: [
    { nodeType: 'EditImageNode',        chipLabel: 'Edit' },
    { nodeType: 'UpscaleImageNode',     chipLabel: 'Upscale' },
    { nodeType: 'RemoveBackgroundNode', chipLabel: 'Remove BG' },
  ],
  video: [
    { nodeType: 'LipsyncNode',     chipLabel: 'Sync lips' },
    { nodeType: 'EnhanceVideoNode', chipLabel: 'Enhance' },
    { nodeType: 'DescribeVideoNode', chipLabel: 'Describe' },
  ],
  audio: [
    { nodeType: 'TranscribeAudioNode',  chipLabel: 'Transcribe' },
    { nodeType: 'IdentifySpeakersNode', chipLabel: 'Speakers' },
  ],
  '3d': [],
  text: [],
}

export const INTENT_ORDER: { id: ActionIntent | 'other'; label: string }[] = [
  { id: 'create',  label: 'Create' },
  { id: 'edit',    label: 'Edit' },
  { id: 'enhance', label: 'Enhance' },
  { id: 'analyze', label: 'Analyze' },
  { id: 'other',   label: 'More models' },
]

// Source-type → artifact node that supplies it (used to pre-wire a runnable
// graph when a start-modal pick consumes an upstream asset).
export const ARTIFACT_NODE_FOR_SOURCE: Record<ActionSource, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  text: 'Text',
}

// Start-modal hero tier: flatten HERO_BY_DOMAIN with per-domain caps so the
// modal shows 8 cards (2 rows) spanning all media types. Order = domain order.
const MODAL_HERO_CAPS: [ActionDomain, number][] = [
  ['image', 3], ['video', 2], ['audio', 2], ['3d', 1],
]
export function modalHero(): { nodeType: string; entry: ActionEntry }[] {
  return MODAL_HERO_CAPS.flatMap(([domain, cap]) =>
    HERO_BY_DOMAIN[domain].slice(0, cap)
      .filter(nt => ACTION_CATALOG[nt] != null)
      .map(nt => ({ nodeType: nt, entry: ACTION_CATALOG[nt]! })),
  )
}

export interface ActionSection<T> {
  intent: ActionIntent | 'other'
  label: string
  items: T[]
}

/**
 * Split a flat item list into (hero, intent sections). Pure: no Vue, no I/O.
 * - hero follows heroNodeTypes order; missing types are skipped
 * - hero items never repeat in the sections below
 * - unmapped nodeTypes fall into 'other' ("More models"), always last
 * - empty sections are dropped; items sort by display title
 */
export function groupByIntent<T extends { nodeType: string; label: string }>(
  items: T[],
  heroNodeTypes: string[],
): { hero: T[]; sections: ActionSection<T>[] } {
  const heroSet = new Set(heroNodeTypes)
  const hero = heroNodeTypes
    .map(nt => items.find(it => it.nodeType === nt))
    .filter((it): it is T => it != null)

  const buckets = new Map<ActionIntent | 'other', T[]>()
  for (const it of items) {
    if (heroSet.has(it.nodeType)) continue
    const intent = ACTION_CATALOG[it.nodeType]?.intent ?? 'other'
    const bucket = buckets.get(intent)
    if (bucket) bucket.push(it)
    else buckets.set(intent, [it])
  }

  const title = (it: T) => ACTION_CATALOG[it.nodeType]?.useCase ?? it.label
  return {
    hero,
    sections: INTENT_ORDER
      .map(({ id, label }) => ({
        intent: id,
        label,
        items: (buckets.get(id) ?? []).sort((a, b) => title(a).localeCompare(title(b))),
      }))
      .filter(s => s.items.length > 0),
  }
}
