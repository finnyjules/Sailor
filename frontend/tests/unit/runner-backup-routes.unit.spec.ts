/**
 * Task S3 (model line-up): the first and backup services of today's models
 * (server/runner/generators/twins.ts).
 *
 *  1. The table is what planNode does: every runner model and edit tool goes
 *     to the first service the table names, with the backup it names (or none).
 *  2. For every pair, both requests fit their own service's saved schema over
 *     every value the node's controls can set, and carry the same settings.
 *  3. The price reads the first service's rate, and covers the backup at cost:
 *     max(first with the markup, backup at cost). Badge = charge.
 *  4. The models with no twin, or a twin that can't carry every setting, have
 *     no backup (Flux 2 Pro and Max: none for a webp picture; S3b).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { planNode, type NodePlan, type PipelineCall, type PipelineIO } from '~~/server/runner/executors'
import { RUNNER_IMAGE_MODELS, RUNNER_REPLICATE_IMAGE_MODELS, RUNNER_SVG_IMAGE_MODELS } from '~~/server/runner/generators/image'
import { RUNNER_REPLICATE_VIDEO_MODELS, RUNNER_VIDEO_MODELS } from '~~/server/runner/generators/video'
import {
  NANO_BANANA_2_REPLICATE, RECRAFT_V4_SIZES, RUNNER_ROUTES, flux2DevOnFal, flux2LabelSize, flux2MaxOnFal, flux2ProOnFal, nanoBananaOnFal,
} from '~~/server/runner/generators/twins'
import { RESTYLE_MODELS } from '~~/server/runner/generators/restyle'
import { REFERENCE_MODEL_IDS } from '~~/server/runner/generators/refEdits'
import { rifeVideoInput } from '~~/server/runner/generators/localModels'
import type { OutputFile } from '~~/server/runner/types'
import { encodeMask } from '~~/server/runner/pictures/mask'
import type { RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES } from '#shared/runner/eligibility'
import { IMAGE_MODELS_BY_ID } from '~~/app/data/image-models'
import { VIDEO_MODELS_BY_ID } from '~~/app/data/video-models'
import { creditsForUsd, usdChargedAtCost } from '#shared/pricing/markup'
import { priceNode } from '#shared/pricing/nodePrice'
import { VIDEO_BACKUP_RATES, videoBackupRate, videoBackupUsd, videoRate, videoUsd } from '#shared/pricing/videoRates'
import { IMAGE_BACKUP_RATES, imageBackupRate, imageRate, imageUsd } from '#shared/pricing/imageRates'
import { editCalls, type NodeInputs } from '#shared/pricing/editSettings'
import { editMaxUsd, editRate, editUsd } from '#shared/pricing/editRates'
import { effectiveVideoSettings } from '#shared/pricing/videoSettings'
import { effectiveImageSettings } from '#shared/pricing/imageSettings'
import { priceGraph } from '~~/server/utils/priceBook'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { DEEPSEEK_R1_IS_DOWN } from '#shared/runner/llm'
import { MULTI_LORA_IS_DOWN } from '#shared/runner/lora'

// LC1 fix round 1: the providers that fail whatever is sent are refused before the hold; this spec
// checks the requests themselves, so it turns those refusals off (runner-live-check-fixes checks them).
beforeAll(() => { DEEPSEEK_R1_IS_DOWN.on = false; MULTI_LORA_IS_DOWN.on = false })
afterAll(() => { DEEPSEEK_R1_IS_DOWN.on = true; MULTI_LORA_IS_DOWN.on = true })

type Provider = 'fal' | 'replicate'
type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>

const LINK = ['9', 0]

/** The pictures and text each edit class needs to make its call. */
const EDIT_BASE: Record<string, Record<string, unknown>> = {
  EditImageNode: { input_image: LINK, prompt: 'make it blue' },
  DevelopImageNode: { input_image: LINK },
  RelightNode: { image: LINK },
  BlendSceneNode: { image: LINK },
  RemoveObjectNode: { image: LINK, target: 'the cup' },
  TextEditNode: { image: LINK, find: 'SALE', replace: 'NEW' },
  RecolorObjectNode: { image: LINK, target: 'the cup', color: 'red' },
  SwapBackgroundNode: { product: LINK, scene_prompt: 'a beach' },
  SwapProductNode: { scene_reference: LINK, product: LINK },
  PersonSwap: { scene: LINK, person: LINK },
  GenerateFromReferencesNode: { image_1: LINK, prompt: 'a poster' },
  RotateCameraNode: { image: LINK },
  ProductShotNode: { image: LINK },
  FixFacesNode: { image: LINK },
  FaceSwap: { source_face: LINK, target_frames: LINK, gender: 'Female', keep_hair_from: 'The picture' },
  PersonSwapVideo: { image: LINK, video_url: '/view?filename=clip.mp4&type=input', resolution: '720p' },
  RestyleFromImageNode: { content_image: LINK, style_image: LINK },
  // The LLM text nodes (R3.3): their widgets as the canvas writes them.
  ChatLLMNode: { model: 'Gemini 3 Flash', prompt: 'hi', system_prompt: '', temperature: 1, max_tokens: 1024 },
  ImprovePromptNode: { model: 'GPT-5 nano', idea: 'a cat', target: 'image' },
  SummarizeTextNode: { text: 'a long text', length: 'Short', model: 'Gemini 3 Flash' },
  TranslateTextNode: { text: 'hello', target_language: 'French', custom_language: '' },
  RewriteToneNode: { text: 'we sell shoes', tone: 'Punchy', model: 'Claude 4.5 Haiku' },
  BrainstormIdeasNode: { topic: 'coffee', count: 3, angle: 'Variations' },
  ReasonStepByStepNode: { question: '17 * 23?', include_reasoning: false, model: 'DeepSeek R1' },
  // Describe, read and find (R3.4): their widgets as the canvas writes them.
  DescribeImageNode: { model: 'Moondream 2', image: LINK, prompt: 'Describe this image in detail.' },
  DescribeImageRemoteNode: { image: LINK, prompt: 'Describe this image in detail.' },
  DescribeVideoNode: { model: 'Gemini 2.5 Flash', video_url: 'https://example.test/clip.mp4', prompt: 'Describe this video in detail.' },
  ExtractTextNode: { model: 'ByteDance Dolphin', image: LINK },
  FindObjectsNode: { model: 'YOLO-World', image: LINK, query: 'person, car, dog', confidence: 0.25 },
  // Upscale, enhance, restore and remove background (R3.5): the picture; the rest at the node's defaults.
  UpscaleImageNode: { image: LINK },
  EnhanceDetailNode: { image: LINK },
  RestorePhotoNode: { model: 'Flux Kontext · Restore', image: LINK, safety_tolerance: 2, output_format: 'png' },
  RestorePhotoRemoteNode: { image: LINK, safety_tolerance: '2', output_format: 'png' },
  RemoveBackgroundNode: { model: '851-labs/bg-remover', image: LINK },
  RemoveBackgroundRemoteNode: { image: LINK },
  // Layers from one call, and outpaint (R3.6): the picture; the rest at the node's defaults.
  LayerizeGraphicNode: { image: LINK, prompt: '', seed: 0 },
  SeedreamLayerizeNode: { image: LINK, prompt: '', image_size: 'auto' },
  OutpaintImageNode: { image: LINK, prompt: '', direction: 'Zoom out 1.5x', aspect_ratio: '16:9', seed: 0 },
  // Separate background and foreground (R3.7): its first call is the cut-out.
  SplitPhotoLayersNode: { image: LINK, background_fill: 'LaMa (fast)', mask_grow: 12 },
  // Background remove (R7.1): one picture; its first call is its cut-out.
  BackgroundRemove: { frames: LINK, output: 'transparent', edge_softness: 0 },
  // Upscale (2×) (R7.2): one picture; its call is Real-ESRGAN at scale 2.
  UpscaleImage: { frames: LINK, tile_size: 512 },
  // Object removal (R7.3): one picture and its mask; its call is LaMa's fill.
  ObjectRemove: { frames: LINK, mask: LINK, mask_grow: 4 },
  // Mask by text and Mask extractor (R7.4): one picture; their call is SAM 3's.
  MaskByText: { image: LINK, prompt: 'the dog', threshold: 0, feather: 0, invert: false },
  MaskExtractor: { image: LINK, points: '[{"x":0.5,"y":0.5,"label":1}]', feather: 0, invert: false },
  // Subject mask (R7.5): one picture; best's first call is the background remover (fix round 2).
  SubjectMask: { frames: LINK, point_x: 0.5, point_y: 0.5, output_mode: 'best', mask_grow: 0 },
  // Slow motion (AI) (R7.6): one clip; its call is RIFE video's.
  FrameInterpolateAI: { frames: LINK, multiplier: 2 },
  // Whisper transcribe (R7.7): the sound; its call is Wizper's.
  WhisperTranscribe: { audio: LINK, model_size: 'base', language: 'auto', fps: 30 },
  // Vocal separator (R7.8): the sound; its call is demucs' (a pipeline of one call).
  VocalSeparator: { audio: LINK, model: 'htdemucs', shifts: 1 },
  // Music and speech (R3.8): the text; the rest at the node's defaults.
  GenerateMusicNode: { model: 'MusicGen', prompt: 'lo-fi piano' },
  MusicGenRemoteNode: { prompt: 'lo-fi piano' },
  GenerateSpeechNode: { model: 'MiniMax Speech-02 HD', text: 'Hello.' },
  MiniMaxSpeechRemoteNode: { text: 'Hello.' },
  // Sound in (R3.10): the sound; the rest at the node's defaults (Sync lips with a web address).
  TranscribeAudioNode: { model: 'Whisper', audio: LINK, language: 'auto', translate: false },
  WhisperRemoteNode: { audio: LINK, language: 'auto', translate: false },
  IdentifySpeakersNode: { model: 'Whisper Diarization', audio: LINK, num_speakers: 0, language: 'auto' },
  CloneSingingVoiceNode: { model: 'Realistic Voice Cloning (RVC)', audio: LINK, rvc_model: 'Guitar', custom_rvc_model_url: '', pitch_change: 'no-change', pitch_shift_semitones: 0, pitch_detection_algorithm: 'rmvpe', output_format: 'wav' },
  LipsyncNode: { model: 'sync.so 2-pro', video_url: 'https://example.test/face.mp4', audio: LINK, sync_mode: 'cut_off' },
  LipsyncRemoteNode: { video_url: 'https://example.test/face.mp4', audio: LINK, sync_mode: 'cut_off' },
  // 3D models (R3.9): the picture; the rest at the node's defaults (Multi-View on TRELLIS, its default engine).
  Generate3DNode: { model: 'Hunyuan3D 2', image: LINK },
  Hunyuan3DRemoteNode: { image: LINK },
  Hunyuan3DMultiViewNode: { front_image: LINK, engine: 'TRELLIS (textured)' },
  // Text effect, sketch to image and face references (R3.12): Text effect generating (no picture), the others' picture.
  TextEffectNode: { text: 'HELLO', effect: 'liquid-chrome', aspect_ratio: '1:1', seed: 0, freedom: 0 },
  SketchToImageNode: { model: 'Nano Banana', image: LINK, prompt: 'a castle' },
  ConsistentFaceNode: { model: 'Ideogram Character', reference_image: LINK, prompt: 'in a park', aspect_ratio: '1:1', seed: 0 },
  // Flux Dev + LoRA and Flux Dev + LoRAs (R3.13): a public HuggingFace LoRA link each (no sidecar read).
  // Lens · 3D Reframe and Pose Mannequin (R3.15): the picture; Pose re-posed from a pose picture.
  LensReframe: { image: LINK, source_lens: 'Normal 50mm Planar', target_lens: 'Portrait 85mm GM', reframe_strength: 1, custom_focal: 50 },
  PoseMannequin: { character: LINK, pose_image: LINK, pose_source: 'image', prompt: '' },
  // Turntable (R3.16): the front picture alone (its front-only spin).
  TurntableNode: { image: LINK, direction: 'left', instructions: '' },
  FluxLoRARemoteNode: { prompt: 'a portrait', lora_name: '[None]', lora_url: 'https://huggingface.co/alice/lora', lora_scale: 1, aspect_ratio: '1:1', megapixels: '1', num_inference_steps: 28, guidance: 3.5, seed: 0, prompt_strength: 0.8 },
  FluxMultiLoRARemoteNode: {
    prompt: 'a portrait', lora_a: '[None]', lora_a_url: 'https://huggingface.co/alice/one', scale_a: 0.9, lora_b: '[None]', lora_b_url: 'https://civitai.com/api/download/models/1', scale_b: 0.8,
    aspect_ratio: '1:1', num_inference_steps: 28, guidance: 3.5, seed: 0, prompt_strength: 0.8, lora_c: '[None]', lora_c_url: '', scale_c: 0.7, lora_d: '[None]', lora_d_url: '', scale_d: 0.6,
  },
  // Restyle an Image · Style LoRA (R3.14): a public HuggingFace LoRA link (no sidecar read); its first call is the caption.
  RestyleWithLoRANode: {
    content_image: LINK, lora_name: '[None]', style_strength: 0.5, resolution: '1K', seed: 0, lora_url: 'https://huggingface.co/alice/lora', lora_scale: 1,
    flux_prompt_strength: 0, flux_steps: 28, flux_guidance: 3.5, describe_prompt: 'Who is in it?', extra_style_direction: '', output_format: 'png',
  },
  // sync-3 lip-sync (Task F22): the studio's face video and sound.
  LipSyncNode: {
    engine: 'sync-3',
    sync_mode: 'cut_off',
    model_options: JSON.stringify({ engine: 'sync-3', face_video: '/view?filename=face.mp4&type=input', audio: '/view?filename=voice.wav&type=input' }),
  },
  // Topaz video upscale (Task F23): a video uploaded to Sailor.
  EnhanceVideoNode: { model: 'Topaz Video Upscale', video_url: '/view?filename=clip.mp4&type=input', target_resolution: '1080p', fps: 'original' },
}

/** A sound-in node's WAV (R3.10): one sample (not silence: Whisper transcribe, R7.7, makes no call for silence). */
const SOUND_WAV = { wav: Uint8Array.of(...new Uint8Array(44), 1, 0), seconds: 1 / 8000, frames: 1, rate: 8000, channels: 1 }

/** Object removal's mask (R7.3), kept as the runner keeps masks. */
const MASK_FILE: OutputFile = { filename: 'mask.png', subfolder: '', type: 'temp' }

/** What the engine measured of a media node's files before planning (Topaz sets its factor from the video's size, F23). */
const MEASURED = { video: 3, videoWidth: 1280, videoHeight: 720, videoFps: 24, frames: 3 }

async function plan(classType: string, inputs: Record<string, unknown>, families?: ReadonlySet<RunnerFamily>): Promise<ProviderPlan> {
  const p = await planNode({
    prompt: { n: { class_type: classType, inputs } },
    nodeId: 'n',
    gateOpen: false,
    filesFrom: () => [{ filename: 'a.png', subfolder: '', type: 'output' }],
    toUrl: async (f: OutputFile) => `https://pics.test/${f.filename}`,
    ...(families ? { families } : {}),
    measured: MEASURED,
    // A sound-in node's WAV (R3.10): any, handed off by its name.
    soundWav: async () => SOUND_WAV,
    bytesToUrl: async (f: OutputFile) => `https://pics.test/${f.filename}`,
  })
  if (p.kind !== 'provider') throw new Error(`${classType} made no call`)
  return p
}

/**
 * A plan's first request: a provider plan's own, or a pipeline's first call
 * (R3.6: the layerizers), caught as it is sent.
 */
async function firstCall(classType: string, inputs: Record<string, unknown>, families?: ReadonlySet<RunnerFamily>): Promise<Pick<ProviderPlan, 'provider' | 'endpoint' | 'payload' | 'backup'>> {
  const p = await planNode({
    prompt: { n: { class_type: classType, inputs } }, nodeId: 'n', gateOpen: false,
    filesFrom: () => [{ filename: 'a.png', subfolder: '', type: 'output' }],
    // Object removal (R7.3) reads its mask as a mask value: one 2 × 2 white mask.
    valueFrom: link => (classType === 'ObjectRemove' && link === inputs.mask ? { kind: 'mask', files: [MASK_FILE] }
      // Slow motion (AI) (R7.6) reads a frame batch: three frames of 64 × 36 (RIFE takes 16 pixels a side and up).
      : classType === 'FrameInterpolateAI' ? { kind: 'frames', file: { filename: 'b.mkv', subfolder: '', type: 'kept' }, count: 3, w: 64, h: 36 } : undefined),
    toUrl: async (f: OutputFile) => `https://pics.test/${f.filename}`,
    ...(families ? { families } : {}),
    measured: MEASURED,
    // A sound-in node's WAV (R3.10): any, handed off by its name.
    soundWav: async () => SOUND_WAV,
    bytesToUrl: async (f: OutputFile) => `https://pics.test/${f.filename}`,
  })
  if (p.kind === 'provider') return p
  if (p.kind !== 'pipeline') throw new Error(`${classType} made no call`)
  let first: PipelineCall | null = null
  const sent = new Error('first call sent')
  // (R3.7: Separate background and foreground reads its picture before its first call: a plain RGB PNG here.)
  const picture = new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer())
  await p.run({
    signal: new AbortController().signal, call: async (c: PipelineCall) => { first = c; throw sent },
    // Slow motion (AI) (R7.6) encodes its clip with the video tools: here, its request as a resumed node recorded it.
    recorded: (key: string) => (classType === 'FrameInterpolateAI' && key === 'rife' ? rifeVideoInput('https://pics.test/clip.mp4', inputs.multiplier as number) : null),
    read: async (f: OutputFile) => (f.filename === MASK_FILE.filename ? await encodeMask({ w: 2, h: 2, data: new Float32Array(4).fill(1) }) : picture), handOff: async (_b: Uint8Array, name: string) => `https://pics.test/${name}`,
  } as unknown as PipelineIO).catch((e) => { if (e !== sent) throw e })
  if (!first) throw new Error(`${classType} made no call`)
  const c = first as PipelineCall
  return { provider: c.provider, endpoint: c.endpoint, payload: c.payload, ...(c.backup ? { backup: c.backup } : {}) }
}

/** The node a route key names, with everything it needs to make its call. */
function nodeFor(key: string): [string, Record<string, unknown>] {
  if (key.startsWith('image:')) {
    const id = key.slice(6)
    // Flux 2 Pro and Max have a backup for a jpg or png picture only (webp, their default, has none);
    // Ideogram 4 for a 2K picture only (1K, its default, has none).
    const adv = id === 'flux-2-pro' || id === 'flux-2-max' ? { model_options: JSON.stringify({ output_format: 'png' }) }
      : id === 'ideogram-4' ? { model_options: JSON.stringify({ resolution: '2K' }) }
        : {}
    return ['GenerateImageNode', { model: id, prompt: 'a red fox', aspect_ratio: '1:1', seed: 7, ...adv }]
  }
  if (key.startsWith('video:')) {
    const id = key.slice(6)
    // A first frame for the image-to-video-only models (Wan 3.0 Prime among them), and for Grok Imagine Video 1.5 (F19)
    // and Luma Ray 3.2 (F21), whose backups are image-to-video only.
    const i2v = ['wan-2.5-i2v-fast', 'wan-3.0-prime', 'grok-imagine-video-1.5', 'luma-ray-3.2'].includes(id)
    // Fabric (R11.2): a face and a sound, both linked.
    if (id === 'fabric-1.0') return ['GenerateVideoNode', { model: id, prompt: 'a fox runs', aspect_ratio: '16:9', image: LINK, audio: ['snd', 0] }]
    return ['GenerateVideoNode', { model: id, prompt: 'a fox runs', aspect_ratio: '16:9', ...(i2v ? { image: LINK } : {}) }]
  }
  const [ct, model] = key.split(':') as [string, string | undefined]
  // Lip-sync a character's Fabric and Kling engines (R11.3): the studio's options for that engine.
  if (ct === 'LipSyncNode' && (model === 'fabric' || model === 'kling')) {
    const opts = model === 'fabric'
      ? { engine: 'fabric', resolution: '720p', audio: '/view?filename=voice.wav&type=input', face_image: '/view?filename=face.png&type=input' }
      : { engine: 'sync', resolution: '720p', audio: '/view?filename=voice.wav&type=input', face_video: '/view?filename=face.mp4&type=input' }
    return [ct, { engine: opts.engine, resolution: '720p', sync_mode: 'cut_off', model_options: JSON.stringify(opts) }]
  }
  return [ct, { ...EDIT_BASE[ct], ...(model ? { model } : {}) }]
}

/** `<NodeClass>+<family>`: the class while the family that moves it onto a newer model is on (Rotate camera, F10). */
function routeOf(key: string): { ct: string, inputs: Record<string, unknown>, families?: ReadonlySet<RunnerFamily> } {
  const plus = key.indexOf('+')
  if (plus < 0) {
    const [ct, inputs] = nodeFor(key)
    return { ct, inputs }
  }
  const ct = key.slice(0, plus)
  return { ct, inputs: { ...EDIT_BASE[ct] }, families: new Set([key.slice(plus + 1) as RunnerFamily]) }
}

const fits = (provider: Provider, endpoint: string, payload: unknown) =>
  checkPayload(loadProviderSchema(provider, endpoint), payload)

/** A plan's first request and its backup each fit their own saved schema. */
function expectBothFit(p: ProviderPlan, label: string) {
  expect(fits(p.provider as Provider, p.endpoint, p.payload), `${label} first ${p.endpoint}`).toEqual([])
  expect(p.backup, `${label} has a backup`).toBeTruthy()
  expect(fits(p.backup!.provider as Provider, p.backup!.endpoint, p.backup!.payload), `${label} backup ${p.backup!.endpoint}`).toEqual([])
}

// ── 1. The table is what planNode does ─────────────────────────────────────

describe('the first and backup services are the table\'s', () => {
  it('every runner image and video model, and every edit tool, has a row', () => {
    const keys = new Set(Object.keys(RUNNER_ROUTES))
    for (const id of [...Object.keys(RUNNER_IMAGE_MODELS), ...Object.keys(RUNNER_REPLICATE_IMAGE_MODELS)]) expect(keys.has(`image:${id}`), id).toBe(true)
    for (const id of [...Object.keys(RUNNER_VIDEO_MODELS), ...Object.keys(RUNNER_REPLICATE_VIDEO_MODELS)]) expect(keys.has(`video:${id}`), id).toBe(true)
    for (const m of ['Nano Banana 2', 'Flux 2 Pro', 'Flux Kontext Pro', 'GPT Image 2.5', 'Seedream 5 Pro']) expect(keys.has(`EditImageNode:${m}`), m).toBe(true)
    for (const m of ['Flux 2 Pro', 'Flux Kontext Pro', 'Nano Banana', 'Nano Banana 2']) expect(keys.has(`BlendSceneNode:${m}`), m).toBe(true)
    for (const m of RESTYLE_MODELS) expect(keys.has(`RestyleFromImageNode:${m}`), m).toBe(true)
    for (const m of REFERENCE_MODEL_IDS) expect(keys.has(`GenerateFromReferencesNode:${m}`), m).toBe(true)
    for (const ct of ['DevelopImageNode', 'RelightNode', 'RemoveObjectNode', 'TextEditNode', 'RecolorObjectNode', 'SwapBackgroundNode', 'SwapProductNode', 'PersonSwap', 'RotateCameraNode', 'ProductShotNode']) {
      expect(keys.has(ct), ct).toBe(true)
    }
    // Rotate camera on Qwen Image Edit 2511 (Task F10): the class while its upgrade family is on.
    expect(keys.has('RotateCameraNode+qwen-2511-angles')).toBe(true)
    // Product shot on Bria Product Shot (Task F12), the same way.
    expect(keys.has('ProductShotNode+bria-product-shot')).toBe(true)
    // Lip-sync a character on sync-3 (Task F22), by its engine.
    expect(keys.has('LipSyncNode:sync-3')).toBe(true)
    // Enhance a video on fal's Topaz (Task F23): the class while its upgrade family is on.
    expect(keys.has('EnhanceVideoNode+topaz-video')).toBe(true)
    // And no row for something the runner doesn't run.
    const image = Object.keys(RUNNER_ROUTES).filter(k => k.startsWith('image:')).length
    const video = Object.keys(RUNNER_ROUTES).filter(k => k.startsWith('video:')).length
    // + GPT Image 2.5 (Task F2), Qwen Image 3 (Task F6), Grok Imagine 2 (Task F7), Ideogram 4 (Task F8), Muse Image (Task F13),
    // Nano Banana 2 Lite (Task F14), Reve 2.1 (Task F15) and Recraft V4.1 (Task F16), runner-only models outside the two builder tables,
    // and Krea 2 Large and Medium (Task F17, family krea-2, not runner-only), outside them too.
    expect(keys.has('image:gpt-image-2.5')).toBe(true)
    expect(keys.has('image:qwen-image-3')).toBe(true)
    expect(keys.has('image:grok-imagine-2')).toBe(true)
    expect(keys.has('image:ideogram-4')).toBe(true)
    expect(keys.has('image:muse-image')).toBe(true)
    expect(keys.has('image:nano-banana-2-lite')).toBe(true)
    expect(keys.has('image:reve-2.1')).toBe(true)
    expect(keys.has('image:recraft-v4.1')).toBe(true)
    // + Ideogram 4.5 and FLUX 3 Image (runner-only, families ideogram-4.5 and flux-3-image), outside them too.
    expect(keys.has('image:ideogram-4.5')).toBe(true)
    expect(keys.has('image:flux-3-image')).toBe(true)
    expect(keys.has('image:krea-2-large')).toBe(true)
    expect(keys.has('image:krea-2-medium')).toBe(true)
    // + the three Recraft SVG models (R11.4, family recraft-svg), their own table.
    for (const id of Object.keys(RUNNER_SVG_IMAGE_MODELS)) expect(keys.has(`image:${id}`), id).toBe(true)
    expect(image).toBe(Object.keys(RUNNER_IMAGE_MODELS).length + Object.keys(RUNNER_REPLICATE_IMAGE_MODELS).length + 12 + Object.keys(RUNNER_SVG_IMAGE_MODELS).length)
    // + Wan 3.0 and Wan 3.0 Prime (Task F1), Hailuo H3 Max Turbo (F3), Gemini Omni Flash (F4), Veo 3.1 Lite (F5),
    // HappyHorse 1.1 (Task F18), Grok Imagine Video 1.5 (Task F19), LTX-2.5 Fast (Task F20) and Luma Ray 3.2
    // (Task F21), runner-only video models outside the two builder tables.
    for (const id of ['wan-3.0', 'wan-3.0-prime', 'hailuo-h3-max-turbo', 'gemini-omni-flash', 'veo-3.1-lite']) expect(keys.has(`video:${id}`), id).toBe(true)
    expect(keys.has('video:happyhorse-1.1')).toBe(true)
    expect(keys.has('video:grok-imagine-video-1.5')).toBe(true)
    expect(keys.has('video:ltx-2.5-fast')).toBe(true)
    expect(keys.has('video:luma-ray-3.2')).toBe(true)
    expect(video).toBe(Object.keys(RUNNER_VIDEO_MODELS).length + Object.keys(RUNNER_REPLICATE_VIDEO_MODELS).length + 9)
  })

  // Final review finding 4 (final fix F4): the list comes from the catalogues
  // and the rule rows, not by hand, so a family added later without a row fails here.
  it('every catalogue model behind a family, and every rule row\'s model and upgrade, has a row', () => {
    const keys = new Set(Object.keys(RUNNER_ROUTES))
    const want: string[] = []
    for (const m of Object.values(IMAGE_MODELS_BY_ID)) if (m.family) want.push(`image:${m.id}`)
    for (const m of Object.values(VIDEO_MODELS_BY_ID)) if (m.family) want.push(`video:${m.id}`)
    for (const [ct, rule] of Object.entries(RUNNER_NODE_RULES)) {
      if (rule.local) continue
      const surface = ct === 'GenerateImageNode' ? 'image:' : ct === 'GenerateVideoNode' ? 'video:' : `${ct}:`
      for (const model of Object.keys(rule.models ?? {})) want.push(`${surface}${model}`)
      if (rule.upgrade) want.push(`${ct}+${rule.upgrade.family}`)
      if (!rule.models && rule.family) want.push(ct)
    }
    expect(want.length).toBeGreaterThan(100)
    expect(want.filter(k => !keys.has(k))).toEqual([])
  })

  for (const [key, route] of Object.entries(RUNNER_ROUTES)) {
    it(`${key}: ${route.first} first, ${route.backup ?? 'no'} backup`, async () => {
      const { ct, inputs, families } = routeOf(key)
      const p = await firstCall(ct, inputs, families)
      expect(p.provider).toBe(route.first)
      expect(p.backup?.provider ?? null).toBe(route.backup)
      // A backup is the other service, and a row without one says why.
      if (route.backup) expect(route.backup).not.toBe(route.first)
      else expect(route.why, key).toBeTruthy()
    })
  }

  it('the line-up page\'s calls: Kling 3.0 on fal first; the Nano Banana actions on Replicate with fal behind; Flux 2 on Replicate', () => {
    expect(RUNNER_ROUTES['video:kling-v3']).toEqual({ first: 'fal', backup: 'replicate' })
    for (const ct of ['RemoveObjectNode', 'TextEditNode', 'RecolorObjectNode', 'SwapBackgroundNode', 'SwapProductNode', 'PersonSwap']) {
      expect(RUNNER_ROUTES[ct], ct).toEqual({ first: 'replicate', backup: 'fal' })
    }
    for (const id of ['flux-2-max', 'flux-2-pro', 'flux-2-flex', 'flux-2-klein-4b', 'flux-2-dev']) expect(RUNNER_ROUTES[`image:${id}`]!.first, id).toBe('replicate')
  })
})

// ── 4. No twin, no backup ──────────────────────────────────────────────────

describe('the models with no twin (or one whose settings can\'t all be carried) have no backup', () => {
  const NO_TWIN: [string, Record<string, unknown>][] = [
    // + LTX-2.5 Fast (F20 fix round 1, controller ruling: fal's is 2–3 times dearer).
    ...['sora-2', 'sora-2-pro', 'ltx-2.5-fast'].map(id => nodeFor(`video:${id}`)),
    ...['gpt-image-2', 'imagen-3', 'imagen-3-fast', 'seedream-4.5', 'hunyuan-image-3', 'grok-imagine',
      'flux-fast', 'p-image', 'wan-2.2-image-pruna', 'flux-2-flex'].map(id => nodeFor(`image:${id}`)),
    // Flux 2 Pro and Max making webp (their default): fal makes no webp.
    ...['flux-2-pro', 'flux-2-max'].flatMap(model => [{}, { output_format: 'webp' }].map(adv =>
      ['GenerateImageNode', { model, prompt: 'a red fox', aspect_ratio: '16:9', seed: 7, model_options: JSON.stringify(adv) }] as [string, Record<string, unknown>])),
    // Ideogram 4 at 1K (its default): Replicate makes only its 2K sizes.
    ...[{}, { resolution: '1K' }].map(adv =>
      ['GenerateImageNode', { model: 'ideogram-4', prompt: 'a red fox', aspect_ratio: '16:9', seed: 7, model_options: JSON.stringify(adv) }] as [string, Record<string, unknown>]),
    nodeFor('ProductShotNode'),
    nodeFor('RestyleFromImageNode:Style Transfer · IP-Adapter'),
  ]
  for (const [ct, inputs] of NO_TWIN) {
    it(`${ct} ${String(inputs.model ?? '')} ${String(inputs.model_options ?? '')}`, async () => {
      expect((await plan(ct, inputs)).backup).toBeUndefined()
    })
  }
})

// ── 2. Both requests fit their schemas, over every setting ─────────────────

/** Every value a catalogue control can hold: its default, each option, each end of its range. */
function controlValues(fields: { name: string, type: string, default: unknown, options?: string[], min?: number, max?: number, hidden?: boolean }[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{}]
  for (const f of fields) {
    const values = new Set<unknown>([f.default, ...(f.options ?? [])])
    if (f.min !== undefined) values.add(f.min)
    if (f.max !== undefined) values.add(f.max)
    if (f.type === 'boolean') { values.add(true); values.add(false) }
    if (f.type === 'string') values.add('blurry, low quality')
    for (const v of values) out.push({ [f.name]: v })
  }
  return out
}

const SEEDS = [0, 7, 2 ** 32 - 1]

describe('both requests of every pair fit their own schema over every setting', () => {
  for (const id of ['kling-v3', 'pixverse-v6', 'flux-3']) {
    it(`Generate video, ${id}`, async () => {
      const cat = VIDEO_MODELS_BY_ID[id]!
      let n = 0
      for (const aspect_ratio of cat.aspectRatios) {
        for (const duration of cat.durations) {
          for (const adv of [...controlValues(cat.advanced), ...(cat.resolutions ?? []).map(resolution => ({ resolution }))]) {
            for (const image of [undefined, LINK]) {
              for (const seed of SEEDS) {
                const p = await plan('GenerateVideoNode', {
                  model: id, prompt: 'a fox runs', aspect_ratio, duration, seed, model_options: JSON.stringify(adv), ...(image ? { image } : {}),
                })
                const label = `${id} ${aspect_ratio} ${duration} ${JSON.stringify(adv)} ${image ? 'i2v' : 't2v'} ${seed}`
                expectBothFit(p, label)
                // The same clip on both: length, sound, resolution and first frame.
                const [f, b] = [p.payload, p.backup!.payload]
                expect(Number(f.duration), label).toBe(Number(b.duration))
                expect(f.generate_audio ?? f.generate_audio_switch, label).toBe(b.generate_audio ?? b.generate_audio_switch)
                expect(f.resolution ?? f.quality ?? null, label).toBe(b.resolution ?? b.quality ?? null)
                const frame = (x: Record<string, unknown>) => x.image_url ?? x.start_image_url ?? x.start_image ?? x.image ?? (x.images as string[] | undefined)?.[0] ?? null
                expect(frame(f), label).toBe(frame(b))
                if (!image) expect(f.aspect_ratio, label).toBe(b.aspect_ratio)
                expect(f.seed, label).toBe(b.seed)
                // Left out means '' on Replicate (its default); fal's Kling is always sent one (S3b).
                expect(f.negative_prompt ?? '', label).toBe(b.negative_prompt ?? '')
                if (id === 'kling-v3') expect(typeof f.negative_prompt, label).toBe('string')
                n++
              }
            }
          }
        }
      }
      expect(n).toBeGreaterThan(20)
    })
  }

  it('Generate image, flux-2-dev: the same size, format and seed on fal, inside fal\'s 512–2048 a side', async () => {
    const cat = IMAGE_MODELS_BY_ID['flux-2-dev']!
    let n = 0
    for (const aspect_ratio of cat.aspectRatios) {
      for (const adv of controlValues(cat.advanced)) {
        for (const seed of SEEDS) {
          const p = await plan('GenerateImageNode', { model: 'flux-2-dev', prompt: 'a red fox', aspect_ratio, seed, model_options: JSON.stringify(adv) })
          const label = `${aspect_ratio} ${JSON.stringify(adv)} ${seed}`
          expectBothFit(p, label)
          const size = p.backup!.payload.image_size as { width: number, height: number }
          expect(size, label).toEqual({ width: p.payload.width, height: p.payload.height })
          for (const side of [size.width, size.height]) {
            expect(side, label).toBeGreaterThanOrEqual(512)
            expect(side, label).toBeLessThanOrEqual(2048)
          }
          expect(p.backup!.payload.seed, label).toBe(p.payload.seed)
          expect(String(p.backup!.payload.output_format).replace('jpeg', 'jpg'), label).toBe(p.payload.output_format)
          n++
        }
      }
    }
    expect(n).toBeGreaterThan(50)
    // The builder reads the Replicate request, never the node: nothing else reaches fal.
    expect(Object.keys(flux2DevOnFal({ prompt: 'p', width: 1024, height: 1024, output_format: 'webp', output_quality: 90 }).payload).sort())
      .toEqual(['image_size', 'num_images', 'output_format', 'prompt'])
  })

  for (const id of ['flux-2-pro', 'flux-2-max'] as const) {
    it(`Generate image, ${id}: fal for jpg and png, the same ratio, megapixels, safety tolerance and seed; no backup for webp`, async () => {
      const cat = IMAGE_MODELS_BY_ID[id]!
      let n = 0
      for (const aspect_ratio of cat.aspectRatios) {
        for (const adv of controlValues(cat.advanced)) {
          for (const output_format of ['jpg', 'png', 'webp']) {
            for (const seed of SEEDS) {
              const p = await plan('GenerateImageNode', { model: id, prompt: 'a red fox', aspect_ratio, seed, model_options: JSON.stringify({ ...adv, output_format }) })
              const label = `${aspect_ratio} ${JSON.stringify(adv)} ${output_format} ${seed}`
              expect(fits('replicate', p.endpoint, p.payload), label).toEqual([])
              if (output_format === 'webp') { expect(p.backup, label).toBeUndefined(); continue }
              expectBothFit(p, label)
              const [f, b] = [p.payload, p.backup!.payload]
              expect(p.backup!.endpoint, label).toBe(`fal-ai/${id}`)
              expect(b.prompt, label).toBe(f.prompt)
              expect(b.output_format, label).toBe(output_format === 'jpg' ? 'jpeg' : 'png')
              expect(b.safety_tolerance, label).toBe(String(f.safety_tolerance))
              expect(b.seed, label).toBe(f.seed)
              // The ratio and the label's megapixels, inside both services' limits.
              const size = b.image_size as { width: number, height: number }
              expect(size, label).toEqual(flux2LabelSize(f.resolution, f.aspect_ratio))
              const [rw, rh] = String(f.aspect_ratio).split(':').map(Number) as [number, number]
              expect(Math.abs(size.width / size.height - rw / rh) / (rw / rh), label).toBeLessThan(0.02)
              for (const side of [size.width, size.height]) {
                expect(side % 16, label).toBe(0)
                expect(side, label).toBeGreaterThanOrEqual(256)
                expect(side, label).toBeLessThanOrEqual(2048)
              }
              const labelPixels = Number.parseFloat(String(f.resolution)) * 1024 * 1024
              expect(size.width * size.height, label).toBeLessThanOrEqual(Math.min(labelPixels, 2048 * 2048) * 1.02)
              if (Math.max(size.width, size.height) < 2048) expect(size.width * size.height, label).toBeGreaterThanOrEqual(labelPixels * 0.98)
              // Nothing but these reaches fal.
              expect(Object.keys(b).sort(), label).toEqual(['image_size', 'output_format', 'prompt', 'safety_tolerance', ...(seed > 0 ? ['seed'] : [])].sort())
              n++
            }
          }
        }
      }
      expect(n).toBeGreaterThan(100)
    })
  }

  it('Flux 2: 1 MP at 1:1 is 1024 × 1024; a request the builder can\'t make throws', () => {
    expect(flux2LabelSize('1 MP', '1:1')).toEqual({ width: 1024, height: 1024 })
    expect(flux2LabelSize('4 MP', '1:1')).toEqual({ width: 2048, height: 2048 })
    expect(flux2LabelSize('4 MP', '16:9')).toEqual({ width: 2048, height: 1152 })
    expect(() => flux2LabelSize('3 MP', '1:1')).toThrow()
    expect(() => flux2LabelSize('1 MP', 'wide')).toThrow()
    const base = { prompt: 'p', aspect_ratio: '1:1', resolution: '1 MP', output_format: 'png', output_quality: 90 }
    for (const fn of [flux2ProOnFal, flux2MaxOnFal]) {
      expect(fn({ ...base, safety_tolerance: 2 })).toBeTruthy()
      expect(fn({ ...base, output_format: 'webp', safety_tolerance: 2 })).toBeNull()
      expect(() => fn({ ...base, safety_tolerance: '2' })).toThrow()
      expect(() => fn({ ...base, safety_tolerance: 6 })).toThrow()
    }
  })

  for (const id of ['recraft-v4', 'recraft-v4-pro'] as const) {
    it(`Generate image, ${id}: fal with the size Replicate's schema lists for the ratio`, async () => {
      const cat = IMAGE_MODELS_BY_ID[id]!
      const scale = id === 'recraft-v4-pro' ? 2 : 1
      for (const aspect_ratio of cat.aspectRatios) {
        const p = await plan('GenerateImageNode', { model: id, prompt: 'a red fox', aspect_ratio, seed: 7 })
        expectBothFit(p, aspect_ratio)
        expect(p.backup!.endpoint).toBe(id === 'recraft-v4' ? 'fal-ai/recraft/v4/text-to-image' : 'fal-ai/recraft/v4/pro/text-to-image')
        const [w, h] = RECRAFT_V4_SIZES[String(p.payload.aspect_ratio)]!
        expect(p.backup!.payload, aspect_ratio).toEqual({ prompt: p.payload.prompt, image_size: { width: w * scale, height: h * scale } })
      }
      // fal's prompt has a minLength of 1: an empty prompt drops the backup, not the node.
      const empty = await plan('GenerateImageNode', { model: id, prompt: '', aspect_ratio: '1:1', seed: 7 })
      expect(empty.provider).toBe('replicate')
      expect(empty.backup).toBeUndefined()
    })
  }

  it('Recraft V4: each ratio\'s size is in Replicate\'s saved size list, and the nearest in shape', () => {
    for (const [slug, scale] of [['recraft-ai/recraft-v4', 1], ['recraft-ai/recraft-v4-pro', 2]] as const) {
      // Replicate's schema: `size` is its own component, an enum of "WxH".
      const schema = loadProviderSchema('replicate', slug) as unknown as { components: { schemas: Record<string, { enum?: string[] }> } }
      const listed = schema.components.schemas.size!.enum!
      const sizes = listed.map(x => x.split('x').map(Number) as [number, number])
      for (const [ratio, [w, h]] of Object.entries(RECRAFT_V4_SIZES)) {
        expect(listed, `${slug} ${ratio}`).toContain(`${w * scale}x${h * scale}`)
        const [a, b] = ratio.split(':').map(Number) as [number, number]
        const nearest = sizes.reduce((best, s) => Math.abs(s[0] / s[1] - a / b) < Math.abs(best[0] / best[1] - a / b) ? s : best)
        expect(nearest, `${slug} ${ratio}`).toEqual([w * scale, h * scale])
      }
    }
  })

  it('Kling 3.0 on fal: the negative prompt is always sent, \'\' when the node has none', async () => {
    for (const image of [undefined, LINK]) {
      const none = await plan('GenerateVideoNode', { model: 'kling-v3', prompt: 'a fox runs', aspect_ratio: '16:9', ...(image ? { image } : {}) })
      expect(none.payload.negative_prompt).toBe('')
      expect(none.backup!.payload.negative_prompt).toBeUndefined()
      const set = await plan('GenerateVideoNode', { model: 'kling-v3', prompt: 'a fox runs', aspect_ratio: '16:9', model_options: '{"negative_prompt":"rain"}', ...(image ? { image } : {}) })
      expect(set.payload.negative_prompt).toBe('rain')
      expect(set.backup!.payload.negative_prompt).toBe('rain')
    }
  })

  it('the Nano Banana backup throws on a field of the wrong type instead of sending a default', () => {
    const ok = { prompt: 'p', image_input: ['u'], resolution: '1K', output_format: 'png' }
    expect(nanoBananaOnFal(NANO_BANANA_2_REPLICATE, ok).payload).toEqual({ prompt: 'p', image_urls: ['u'], resolution: '1K', output_format: 'png', num_images: 1 })
    for (const bad of [{ prompt: 1 }, { prompt: undefined }, { image_input: 'u' }, { image_input: [1] }, { resolution: 2 }, { output_format: undefined }]) {
      expect(() => nanoBananaOnFal(NANO_BANANA_2_REPLICATE, { ...ok, ...bad }), JSON.stringify(bad)).toThrow()
    }
  })

  const INSTRUCTIONS = [{}, { instructions: 'keep the shadow' }]
  for (const ct of ['RemoveObjectNode', 'TextEditNode', 'RecolorObjectNode', 'SwapBackgroundNode', 'SwapProductNode', 'PersonSwap']) {
    it(`${ct}: Replicate's Nano Banana 2, then fal's, with the same prompt and pictures in the same order`, async () => {
      const extras = ct === 'SwapBackgroundNode' ? [{}, { background_reference: ['8', 0] }] : [{}]
      for (const w of INSTRUCTIONS) {
        for (const x of extras) {
          const p = await plan(ct, { ...EDIT_BASE[ct], ...w, ...x })
          expectBothFit(p, `${ct} ${JSON.stringify({ ...w, ...x })}`)
          expect(p.endpoint).toBe('google/nano-banana-2')
          expect(p.backup!.endpoint).toBe('fal-ai/nano-banana-2/edit')
          expect(p.backup!.payload).toEqual({
            prompt: p.payload.prompt, image_urls: p.payload.image_input, output_format: 'png', resolution: '1K', num_images: 1,
          })
        }
      }
    })
  }

  it('Relight: Replicate\'s Nano Banana 2 first, fal\'s the backup, the same request', async () => {
    for (const reference of [undefined, ['8', 0]]) {
      for (const keep_background of [true, false]) {
        for (const preset of ['Custom', 'Golden hour']) {
          const p = await plan('RelightNode', { image: LINK, preset, keep_background, light: '{"azimuth":-30,"elevation":20}', ...(reference ? { reference } : {}) })
          expectBothFit(p, `${preset} ${keep_background} ${!!reference}`)
          expect(p.payload).toEqual({ prompt: p.backup!.payload.prompt, image_input: p.backup!.payload.image_urls, resolution: '1K', output_format: 'png' })
        }
      }
    }
  })

  it('Restyle: Nano Banana 2 on Replicate then fal, Nano Banana Pro on fal then Replicate, every resolution and format', async () => {
    for (const model of ['Nano Banana 2', 'Nano Banana Pro']) {
      for (const resolution of ['1K', '2K', '4K']) {
        for (const output_format of ['png', 'jpg']) {
          for (const source of [{ style_image: LINK }, { style_refs: JSON.stringify({ folder: 'moodboard_1', files: ['a.png', 'b.png'] }) }]) {
            const p = await plan('RestyleFromImageNode', { content_image: LINK, ...source, model, resolution, output_format })
            const label = `${model} ${resolution} ${output_format} ${Object.keys(source)[0]}`
            expectBothFit(p, label)
            const rep = p.provider === 'replicate' ? p.payload : p.backup!.payload
            const fal = p.provider === 'fal' ? p.payload : p.backup!.payload
            expect(rep, label).toEqual({ prompt: fal.prompt, image_input: fal.image_urls, resolution, output_format: 'jpg' === output_format ? 'jpg' : 'png' })
            expect(fal.resolution, label).toBe(resolution)
          }
        }
      }
    }
  })

  it('Edit image and Blend scene on Flux 2 Pro: fal, then Replicate\'s FLUX.2 [pro] with the picture at its own size', async () => {
    for (const ct of ['EditImageNode', 'BlendSceneNode']) {
      for (const output_format of ['png', 'jpg', 'jpeg']) {
        for (const seed of SEEDS) {
          const p = await plan(ct, { ...EDIT_BASE[ct], model: 'Flux 2 Pro', output_format, seed })
          const label = `${ct} ${output_format} ${seed}`
          expectBothFit(p, label)
          expect(p.backup!.payload, label).toEqual({
            prompt: p.payload.prompt, input_images: p.payload.image_urls, aspect_ratio: 'match_input_image', resolution: 'match_input_image',
            output_format: output_format === 'png' ? 'png' : 'jpg', ...(seed > 0 ? { seed } : {}),
          })
        }
      }
    }
  })
})

// ── 3. The price: the first service's rate, the backup covered at cost ─────

const charge = (ct: string, inputs: Record<string, unknown>) =>
  priceGraph({ 1: { class_type: ct, inputs }, 2: { class_type: 'SaveImage', inputs: {} } }).credits

describe('the price reads the first service\'s rate and covers the backup at cost', () => {
  it('each card\'s service is the route\'s: the first service\'s card, the backup\'s card', () => {
    for (const [key, route] of Object.entries(RUNNER_ROUTES)) {
      const [surface, id] = key.split(':') as [string, string]
      if (surface === 'video') {
        expect(videoRate(id)?.service, key).toBe(route.first)
        expect(videoBackupRate(id)?.service ?? null, key).toBe(route.backup)
      }
      if (surface === 'image') {
        expect(imageRate(id)?.service, key).toBe(route.first)
        expect(imageBackupRate(id)?.service ?? null, key).toBe(route.backup)
      }
    }
    // No backup card for a model without a backup.
    for (const id of Object.keys(VIDEO_BACKUP_RATES)) expect(RUNNER_ROUTES[`video:${id}`]!.backup, id).toBeTruthy()
    for (const id of Object.keys(IMAGE_BACKUP_RATES)) expect(RUNNER_ROUTES[`image:${id}`]!.backup, id).toBeTruthy()
  })

  it('backup cards carry a source, the date read and are verified', () => {
    for (const card of [...Object.values(VIDEO_BACKUP_RATES), ...Object.values(IMAGE_BACKUP_RATES)]) {
      expect(card.confidence).toBe('verified')
      // Read during the programme: the S3 cards on 24 Sep, Krea 2's Replicate billing (F17) on 25 Sep.
      expect(['2026-09-24', '2026-09-25']).toContain(card.read)
      expect(card.source).toMatch(card.service === 'fal' ? /^https:\/\/fal\.ai\/models\/.+\/llms\.txt$/ : /^https:\/\/replicate\.com\//)
    }
  })

  // [what, inputs, first USD, backup USD, credits]
  const VIDEO: [string, Record<string, unknown>, number, number, number][] = [
    // fal pro $0.168/s with sound; Replicate pro $0.336/s: $5.04 at cost is a $3.36 basis → 504 credits, Replicate's cost.
    ['Kling 3.0, 15 s with sound', { model: 'kling-v3', duration: '15', model_options: '{"generate_audio":true}' }, 2.52, 5.04, 504],
    // 5 s silent: fal $0.56, Replicate $1.12 at cost → $0.7467 basis → 112 credits.
    ['Kling 3.0, 5 s silent', { model: 'kling-v3', duration: '5', model_options: '{"generate_audio":false}' }, 0.56, 1.12, 112],
    // PixVerse default: 720p with sound, 5 s: fal $0.06/s, Replicate $0.12/s → Replicate's $0.60 at cost → 60 credits.
    ['PixVerse v6, default', { model: 'pixverse-v6', duration: '5', model_options: '{}' }, 0.30, 0.60, 60],
    ['PixVerse v6, 8 s 1080p silent', { model: 'pixverse-v6', duration: '8', model_options: '{"resolution":"1080p","generate_audio":false}' }, 0.72, 1.44, 144],
    // Flux 3: the same rate on both, so the first service's marked-up price stands.
    ['Flux 3, 10 s at 720p', { model: 'flux-3', duration: '10', model_options: '{}' }, 1.70, 1.70, 255],
  ]
  for (const [what, inputs, first, backup, credits] of VIDEO) {
    it(`${what}: first $${first}, backup $${backup} → ${credits} credits; badge = charge`, () => {
      const s = effectiveVideoSettings(String(inputs.model), inputs.duration, '16:9', inputs.model_options)!
      expect(videoUsd(String(inputs.model), s)).toBeCloseTo(first, 9)
      expect(videoBackupUsd(String(inputs.model), s)).toBeCloseTo(backup, 9)
      const p = priceNode('GenerateVideoNode', inputs)
      if ('refused' in p) throw new Error(p.refused)
      expect(p.usd).toBeCloseTo(Math.max(first, usdChargedAtCost(backup)), 9)
      expect(p.credits).toBe(credits)
      // Never below either service's cost, in credits (1 credit = $0.01).
      expect(p.credits).toBeGreaterThanOrEqual(Math.round(Math.max(first, backup) * 100))
      for (const ct of ['GenerateVideoNode', 'FilmShotNode']) {
        expect(nodeCreditEstimate(ct, inputs), ct).toBe(charge(ct, inputs))
        expect(charge(ct, inputs), ct).toBe(credits + 1)
      }
    })
  }

  it('a linked model_options is priced at the dearest request on either card', () => {
    const p = priceNode('GenerateVideoNode', { model: 'kling-v3', duration: '15', model_options: ['3', 0] })
    if ('refused' in p) throw new Error(p.refused)
    // Replicate's dearest second is 4k at $0.42: 15 s = $6.30, covered at cost ($4.20 basis).
    expect(p.usd).toBeCloseTo(6.30 / 1.5, 9)
    expect(p.credits).toBe(630)
  })

  it('Flux 2 Dev: Replicate\'s rate first; fal\'s the same per megapixel, so the first service\'s price stands', () => {
    for (const resolution of ['0.5 MP', '1 MP', '2 MP', '4 MP']) {
      const inputs = { model: 'flux-2-dev', aspect_ratio: '16:9', model_options: JSON.stringify({ resolution }) }
      const s = effectiveImageSettings('flux-2-dev', '16:9', inputs.model_options)!
      const p = priceNode('GenerateImageNode', inputs)
      if ('refused' in p) throw new Error(p.refused)
      expect(p.usd, resolution).toBeCloseTo(imageUsd('flux-2-dev', s)!, 9)
      expect(p.credits, resolution).toBe(creditsForUsd(imageUsd('flux-2-dev', s)!))
      expect(nodeCreditEstimate('GenerateImageNode', inputs), resolution).toBe(charge('GenerateImageNode', inputs))
    }
  })

  // [id, settings, credits]: the backup costs what the first service costs, so the marked-up first price stands (S3b: no charge moves).
  const SAME_PRICE: [string, Record<string, unknown>, number][] = [
    // Replicate $0.015 + 2 MP × $0.015 = $0.045 → 9; fal $0.03 + $0.015 the same.
    ['flux-2-pro', { resolution: '1 MP', output_format: 'png' }, 9],
    ['flux-2-pro', { resolution: '4 MP', output_format: 'jpg' }, 18],
    // Replicate $0.04 + 2 MP × $0.03 = $0.10 → 20; fal $0.07 + $0.03 the same.
    ['flux-2-max', { resolution: '1 MP', output_format: 'png' }, 20],
    ['flux-2-max', { resolution: '4 MP', output_format: 'webp' }, 29],
    ['recraft-v4', {}, 8],
    ['recraft-v4-pro', {}, 38],
  ]
  for (const [id, adv, credits] of SAME_PRICE) {
    it(`${id} ${JSON.stringify(adv)}: the first service's price stands (${credits} credits); badge = charge`, () => {
      const inputs = { model: id, aspect_ratio: '16:9', model_options: JSON.stringify(adv) }
      const s = effectiveImageSettings(id, '16:9', inputs.model_options)!
      const p = priceNode('GenerateImageNode', inputs)
      if ('refused' in p) throw new Error(p.refused)
      expect(imageBackupRate(id)!.service).toBe('fal')
      expect(p.usd).toBeCloseTo(imageUsd(id, s)!, 9)
      expect(p.credits).toBe(credits)
      expect(nodeCreditEstimate('GenerateImageNode', inputs)).toBe(charge('GenerateImageNode', inputs))
    })
  }

  // [class, widgets, first endpoint, backup endpoint, credits]
  const EDITS: [string, NodeInputs, string, string, number][] = [
    // Replicate NB2 1K $0.067 (13.4 → 14 credits); fal's $0.08 at cost is 8 credits.
    ['RemoveObjectNode', {}, 'google/nano-banana-2', 'fal-ai/nano-banana-2/edit', 14],
    // Replicate first ($0.067 → 14 credits), but the ComfyUI path's fal Nano Banana Pro step ($0.15) at cost is 15.
    ['RelightNode', {}, 'google/nano-banana-2', 'fal-ai/nano-banana-2/edit', 15],
    // 2K: Replicate $0.101 marked up (15.15 → 16) beats fal's $0.12 and NB Pro's $0.15 at cost.
    ['RestyleFromImageNode', { model: 'Nano Banana 2', resolution: '2K' }, 'google/nano-banana-2', 'fal-ai/nano-banana-2/edit', 16],
    ['RestyleFromImageNode', { model: 'Nano Banana Pro', resolution: '4K' }, 'fal-ai/nano-banana-pro/edit', 'google/nano-banana-pro', 45],
  ]
  for (const [ct, w, first, backup, credits] of EDITS) {
    it(`${ct} ${JSON.stringify(w)}: priced from ${first}, ${backup} covered → ${credits} credits`, async () => {
      const [call] = (editCalls(ct, w) as { calls: ReturnType<typeof editCalls> extends { calls: infer C } ? C : never }).calls
      expect(call!.endpoint).toBe(first)
      expect(call!.fallbacks!.map(f => f.endpoint)).toContain(backup)
      const firstUsd = editUsd(call!)!
      expect(editMaxUsd(call!)).toBe(Math.max(firstUsd, ...call!.fallbacks!.map(f => usdChargedAtCost(editUsd(f)!))))
      const p = priceNode(ct, w)
      if ('refused' in p) throw new Error(p.refused)
      expect(p.credits).toBe(credits)
      expect(nodeCreditEstimate(ct, w)).toBe(charge(ct, w))
      // The runner sends exactly these two.
      const planned = await plan(ct, { ...EDIT_BASE[ct], ...w })
      expect([planned.endpoint, planned.backup!.endpoint]).toEqual([first, backup])
    })
  }

  it('Flux 2 Pro edit: Replicate\'s FLUX.2 [pro] card bills the run, the picture in and the picture out', () => {
    expect(editRate('black-forest-labs/flux-2-pro')).toMatchObject({ unit: 'per_run_megapixels', service: 'replicate', confidence: 'verified' })
    const measured = editCalls('EditImageNode', { model: 'Flux 2 Pro' }, { inputPixels: 1920 * 1080 })
    if ('refused' in measured) throw new Error(measured.refused)
    const [c] = measured.calls
    const rep = c!.fallbacks!.find(f => f.endpoint === 'black-forest-labs/flux-2-pro')!
    // 1920 × 1080 = 2.07 MP → 3 in, 3 out: $0.015 + 3 × $0.015 + 3 × $0.015.
    expect(editUsd(rep)).toBeCloseTo(0.105, 9)
    // fal: 2 + 2 megapixels of 1024² → $0.03 + 3 × $0.015 = $0.075, marked up; Replicate at cost $0.07. fal stands.
    expect(editUsd(c!)).toBeCloseTo(0.075, 9)
    expect(editMaxUsd(c!)).toBeCloseTo(0.075, 9)
  })
})
