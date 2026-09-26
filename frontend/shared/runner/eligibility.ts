/**
 * Which workflows the Sailor runner takes. Everything else goes to ComfyUI
 * whole — a workflow is never split between the two.
 */
import { isLink, linksOf, type ApiPrompt } from './graph'
import { NO_FAMILIES, type RunnerFamily } from './families'
import { pyFloatOf, pyIntOf, pyTruthy } from './pyText'
import { SYNC_3_ENGINE, isSync3LipSync, lipSyncEngine } from './lipSync'
import { TOPAZ_VIDEO_FPS, TOPAZ_VIDEO_TARGETS } from './topazVideo'

export const RUNNER_NODE_TYPES: ReadonlySet<string> = new Set([
  'GenerateImageNode', 'GenerateVideoNode', 'ComfyGateNode', 'Image', 'Video',
])

/** One model's switch: its family, and any inputs that model alone needs linked. */
export interface RunnerModelRule {
  family: RunnerFamily
  mustLink?: readonly string[]
}

/**
 * How a family switches a node class on. Pure data. A row gives either the
 * family for the whole class, or (for a class with a `model` widget) the
 * family per model; a model not listed is not taken. `mustLink` inputs must
 * be wired; `mustNotLink` inputs must not be (e.g. Restyle `style_in`).
 */
export interface RunnerNodeRule {
  family?: RunnerFamily
  models?: Readonly<Record<string, RunnerFamily | RunnerModelRule>>
  mustLink?: readonly string[]
  mustNotLink?: readonly string[]
  /**
   * A class the runner computes itself, with no provider and no charge:
   * 'render' makes a picture (it counts as work, like a provider node);
   * 'source' only hands a file on. Absent = a provider class.
   */
  local?: 'render' | 'source'
  /**
   * The widgets ComfyUI validates before anything runs (execution.py
   * validate_inputs): the value converts to its type, sits within min/max,
   * or is one of the options; a required one is present. A widget that is
   * wired, or fails any of that, leaves the node to ComfyUI, which refuses
   * the whole prompt with its own message before running (and charging) a thing.
   */
  widgets?: Readonly<Record<string, RunnerWidgetSpec>>
  /**
   * Inputs (not widgets) ComfyUI's schema marks required: missing, the node
   * fails validation (required_input_missing) and ComfyUI drops its output.
   */
  required?: readonly string[]
  /**
   * A family that moves the whole class onto a newer model (model line-up
   * Ruling 10; Rotate camera on Qwen Image Edit 2511, Task F10). While it is
   * on, the runner takes the class even with `family` off, and the ComfyUI
   * path refuses it (./blockedModels.ts): the engine only knows the old
   * model, whose result looks different. `label` is the new model's own name,
   * for that refusal. Off, the class is exactly as `family` makes it.
   */
  upgrade?: ClassUpgrade
  /** Output slots no node in the prompt may read (e.g. the Compositor's video). */
  outputsNotLinked?: readonly number[]
  /**
   * Output slots only these (class, input) pairs may read (the Compositor's
   * protect_mask: Blend scene's keep_subject, Task F11b).
   */
  outputReaders?: Readonly<Record<number, readonly (readonly [string, string])[]>>
  /** Every node reading this one must be one of these classes. */
  feedsOnly?: readonly string[]
  /** At least one node of the prompt must read this one (a source with no reader is left to ComfyUI). */
  needsReader?: true
  /**
   * Toggles that must be off (not wired, and falsy as Python reads them): the
   * runner doesn't do what they switch on (the Audio card's `export`, which
   * saves a copy to the output folder).
   */
  offWidgets?: readonly string[]
  /** A wired input must come from one of these (class, output slot) pairs. */
  linkSources?: Readonly<Record<string, readonly (readonly [string, number])[]>>
  /**
   * JSON text inputs that must not carry a non-empty list under a key
   * (the Compositor's baked motion: `motion_params.rendered`). Text that
   * does not parse is taken only when it does not mention the key.
   */
  noJsonList?: Readonly<Record<string, string>>
  /**
   * Inputs that, when wired, must carry a picture: output 0 of a class in
   * IMAGE_OUTPUT_CLASSES, followed back through Gates. A video (a Video card,
   * a video generator) wired in is left to ComfyUI.
   */
  imageInputs?: readonly string[]
  /**
   * The Frame's server-health caps: copies summed over its wired layers'
   * cloners; an explicit width × height (lower in hosted); and the work,
   * copies × explicit canvas pixels. (A canvas sized from layer 1 is checked
   * by the render itself, once the picture's size is known.)
   */
  frameLimits?: FrameLimits
}

/** A node class's newer model and the family that switches it on (RunnerNodeRule.upgrade). */
export interface ClassUpgrade {
  family: RunnerFamily
  label: string
  /**
   * The node's settings the newer model can't honour: hidden from the node
   * (and its inspector) while the family is on, and not sent (Product shot on
   * Bria Product Shot, Task F12). Their saved values are kept.
   */
  hiddenWidgets?: readonly string[]
}

export interface FrameLimits {
  maxCopies: number
  maxArtboardPixels: number
  hostedMaxArtboardPixels: number
  maxWork: number
}

/** What the runner's host changes about eligibility. */
export interface RunnerEligibilityOptions {
  /** Hosted: the Frame's artboard is capped lower. */
  hosted?: boolean
  /**
   * The prompt is what is left after ComfyUI's pruning dropped some outputs
   * (shared/runner/validate.ts). What is left may be only cards (a blank
   * project: an Image card beside an empty Frame): it runs, with nothing to
   * call or charge, as ComfyUI runs it.
   */
  afterPruning?: boolean
}

/** A widget as ComfyUI's validation reads it. */
export interface RunnerWidgetSpec {
  type: 'FLOAT' | 'INT' | 'BOOLEAN' | 'STRING' | 'COMBO'
  required?: boolean
  min?: number
  max?: number
  options?: readonly string[]
}

/**
 * The image models whose Python primary is Replicate, that have a price and
 * are not SVG (family `replicate-image`, Task B4). Left out: the three *-svg
 * models (decision D4: Python cannot decode SVG either) and reve-create
 * (unpriced). The flux-2-* models are here: Replicate is their Python
 * primary, fal only their fallback (D5).
 */
export const RUNNER_REPLICATE_IMAGE_MODEL_IDS = [
  'flux-1.1-pro-ultra', 'flux-pro', 'flux-dev',
  'flux-2-max', 'flux-2-pro', 'flux-2-flex', 'flux-2-klein-4b', 'flux-2-dev',
  'imagen-4-ultra', 'imagen-4', 'imagen-4-fast', 'imagen-3', 'imagen-3-fast',
  'ideogram-v2', 'ideogram-v2a-turbo',
  'seedream-4.5', 'seedream-3',
  'recraft-v4-pro', 'recraft-v4', 'recraft-v3',
  'stable-diffusion-3.5-large', 'stable-diffusion-3.5-large-turbo', 'stable-diffusion-3.5-medium',
  'gpt-image-2', 'gpt-image-1.5',
  'qwen-image', 'hunyuan-image-3', 'grok-imagine',
  'flux-fast', 'p-image', 'wan-2.2-image-pruna',
  'bria-fibo', 'bria-image-3.2',
  'photon', 'photon-flash',
  'minimax-image-01',
] as const

/**
 * The video models whose Python provider is Replicate (family
 * `replicate-video`, Task B6), every one priced. Left out: fabric-1.0, which
 * needs a sound clip (the runner refuses a linked `audio`).
 */
export const RUNNER_REPLICATE_VIDEO_MODEL_IDS = [
  'sora-2', 'sora-2-pro', 'runway-gen-4.5', 'kling-v3', 'kling-v2.5-turbo-pro',
  'seedance-2.0-fast', 'hailuo-2.3', 'wan-2.7-t2v', 'wan-2.5-i2v-fast',
  'luma-ray-2-720p', 'ltx-video', 'pixverse-v6',
] as const

/** comfy_extras/nodes_compositor.py `_BLEND_MODES`. */
export const COMPOSITOR_BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'soft_light', 'hard_light', 'difference', 'lighten', 'darken', 'add',
] as const
/** `_MAX_LAYERS`. */
export const COMPOSITOR_MAX_LAYERS = 16

/** CompositorNode.define_schema's widgets, as ComfyUI validates them. */
function compositorWidgets(): Record<string, RunnerWidgetSpec> {
  const w: Record<string, RunnerWidgetSpec> = {}
  for (let i = 1; i <= COMPOSITOR_MAX_LAYERS; i++) {
    // `_layer_inputs`: only the IMAGE port is optional; the six widgets are required on every slot.
    w[`layer${i}_x`] = { type: 'FLOAT', required: true, min: -1.5, max: 1.5 }
    w[`layer${i}_y`] = { type: 'FLOAT', required: true, min: -1.5, max: 1.5 }
    w[`layer${i}_rotation`] = { type: 'FLOAT', required: true, min: -180, max: 180 }
    w[`layer${i}_scale`] = { type: 'FLOAT', required: true, min: 0.1, max: 3 }
    w[`layer${i}_opacity`] = { type: 'FLOAT', required: true, min: 0, max: 1 }
    w[`layer${i}_blend`] = { type: 'COMBO', required: true, options: COMPOSITOR_BLEND_MODES }
    w[`layer${i}_z`] = { type: 'FLOAT', min: -1000, max: 1000 }
    w[`layer${i}_protect`] = { type: 'BOOLEAN' }
    w[`layer${i}_cloner`] = { type: 'STRING' }
  }
  w.width = { type: 'INT', min: 0, max: 8192 }
  w.height = { type: 'INT', min: 0, max: 8192 }
  w.motion_params = { type: 'STRING' }
  return w
}

/**
 * The classes whose output 0 is a picture (IMAGE) the runner can hand a
 * Frame: every runner image node, the Image card, another Frame, and the
 * injected LoadImage. Not GenerateVideoNode or the Video card.
 */
export const IMAGE_OUTPUT_CLASSES: ReadonlySet<string> = new Set([
  'GenerateImageNode', 'Image', 'Compositor', 'LoadImage',
  'EditImageNode', 'DevelopImageNode', 'RelightNode', 'BlendSceneNode',
  'RemoveObjectNode', 'TextEditNode', 'RecolorObjectNode', 'SwapBackgroundNode', 'SwapProductNode', 'PersonSwap',
  'GenerateFromReferencesNode', 'RotateCameraNode', 'ProductShotNode', 'RestyleFromImageNode',
])

/** The most Frame copies (every layer's cloner, summed) the runner renders; more goes to ComfyUI. */
export const MAX_FRAME_COPIES = 256
/** The largest explicit Frame artboard the runner renders, in pixels. */
export const MAX_FRAME_ARTBOARD_PIXELS = 8192 * 8192
/** Hosted, a shared server: the largest Frame artboard is 4096². */
export const HOSTED_MAX_FRAME_ARTBOARD_PIXELS = 4096 * 4096
/** The most pixel work one Frame may ask for: copies × canvas pixels ≤ 256 copies of 4 MP (4 × 2²⁰ pixels). */
export const MAX_FRAME_WORK = 256 * 4 * 1024 * 1024

/** A MASK input the runner can supply: a LoadImage's MASK output (1 − alpha of its file). */
const LOAD_IMAGE_MASK = [['LoadImage', 1]] as const

/**
 * The node classes (or extra models of a runner class) the families add,
 * keyed by class_type. For GenerateImageNode / GenerateVideoNode a row only
 * ADDS models; the models the runner takes without any family stay as they
 * are.
 */
export const RUNNER_NODE_RULES: Readonly<Record<string, RunnerNodeRule>> = {
  // ── fal-edit (Task B2): fal only, at most two linked pictures ──
  // Text widgets the runner reads as plain text must not be wired: a linked
  // one would be read as blank.
  // GPT Image 2.5 (model line-up F2) and Seedream 5 Pro (F9): runner-only, each its own family.
  EditImageNode: {
    models: {
      'Nano Banana 2': 'fal-edit', 'Flux Kontext Pro': 'fal-edit', 'Flux 2 Pro': 'fal-edit', 'GPT Image 2.5': 'gpt-image-2.5',
      'Seedream 5 Pro': 'seedream-5-pro-edit',
    },
    mustLink: ['input_image'],
    mustNotLink: ['prompt'],
  },
  DevelopImageNode: { family: 'fal-edit', mustLink: ['input_image'] },
  // With no `image` Python makes a blank no-op; the runner leaves that to Python.
  RelightNode: { family: 'fal-edit', mustLink: ['image'], mustNotLink: ['light', 'instructions'] },
  // The Nano Banana mode is Replicate (nano-actions, Task B5). Nano Banana 2
  // (model line-up F11) is runner-only, its own family: the nano actions'
  // call. A linked keep_subject (Task F11b) is taken for every model when it
  // is a Frame's protect_mask: the runner makes that mask and lays the answer
  // under it after the call (server/runner/compositor/keep.ts). Any other
  // mask source stays with ComfyUI. keep_feather is read then, so it must
  // not be wired, and must pass ComfyUI's own validation.
  BlendSceneNode: {
    models: { 'Flux Kontext Pro': 'fal-edit', 'Flux 2 Pro': 'fal-edit', 'Nano Banana': 'nano-actions', 'Nano Banana 2': 'nano-banana-2-blend' },
    mustLink: ['image'],
    mustNotLink: ['prompt', 'keep_feather'],
    linkSources: { keep_subject: [['Compositor', 1]] },
    // For EVERY Blend, with or without keep_subject: a wired keep_feather, or
    // one outside 0..30, sends the node to ComfyUI (and the ComfyUI-parity
    // pruning drops an out-of-range one), as ComfyUI's own validation refuses
    // it. Before F11b a Blend with a wired keep_feather but no keep_subject
    // ran in the runner.
    widgets: { keep_feather: { type: 'FLOAT', min: 0, max: 30 } },
  },
  // ── nano-actions (Task B5): google/nano-banana-2 on Replicate ──
  // The main picture must be linked: without it Python makes a blank, which
  // stays with Python. Text and toggles the runner reads must not be wired.
  RemoveObjectNode: { family: 'nano-actions', mustLink: ['image'], mustNotLink: ['target', 'instructions'] },
  TextEditNode: { family: 'nano-actions', mustLink: ['image'], mustNotLink: ['find', 'replace', 'instructions'] },
  RecolorObjectNode: { family: 'nano-actions', mustLink: ['image'], mustNotLink: ['target', 'color', 'instructions'] },
  SwapBackgroundNode: {
    family: 'nano-actions',
    mustLink: ['product'],
    mustNotLink: ['scene_prompt', 'instructions', 'relight_to_scene', 'ground_with_shadow', 'keep_scale_and_placement'],
  },
  SwapProductNode: { family: 'nano-actions', mustLink: ['scene_reference'], mustNotLink: ['instructions'] },
  PersonSwap: { family: 'nano-actions', mustLink: ['scene'], mustNotLink: ['keep_original_outfit', 'instructions'] },
  // ── ref-edits (Task B7): references and camera ──
  // Seedream on Replicate, Nano Banana 2 on fal (its Python primary), Qwen
  // Image Edit Plus on Replicate. The first picture must be linked: Python
  // has no blank for these. Settings the runner reads must not be wired.
  GenerateFromReferencesNode: {
    models: { 'seedream-5-pro': 'ref-edits', 'seedream-5-lite': 'ref-edits', 'nano-banana-2': 'ref-edits' },
    mustLink: ['image_1'],
    mustNotLink: ['prompt', 'aspect_ratio', 'size'],
  },
  // Rotate camera on Qwen Image Edit 2511 with the multiple-angles LoRA (fal,
  // family qwen-2511-angles, Task F10): the same inputs; while that family is
  // on, the node runs only in the runner, whether or not ref-edits is on.
  RotateCameraNode: {
    family: 'ref-edits',
    upgrade: { family: 'qwen-2511-angles', label: 'Qwen Image Edit 2511' },
    mustLink: ['image'],
    mustNotLink: ['camera'],
  },
  // Product shot on Bria Product Shot (fal, family bria-product-shot, Task
  // F12). Its SDXL engine (catacolabs/sdxl-ad-inpaint) is retired from the
  // runner (model line-up H2: only an estimated price), so no family takes
  // the old call: with this family off, saved nodes run on ComfyUI as before.
  // While it is on, every Product shot node runs Bria, in the runner only
  // (Ruling 10). Bria has no product size, no "keep the product exact"
  // switch (it always keeps the product) and no seed: those are hidden while
  // it is on (server/runner/generators/briaProductShot.ts).
  ProductShotNode: {
    upgrade: {
      family: 'bria-product-shot',
      label: 'Bria Product Shot',
      hiddenWidgets: ['product_size', 'keep_product_exact', 'seed'],
    },
    mustLink: ['image'],
    mustNotLink: ['scene_prompt', 'aspect'],
  },
  // ── restyle (Task B8): Nano Banana 2 / Pro on fal, Nano Banana on
  // Replicate. The taste wire (style_in) comes from a Moodboard node, which
  // the runner does not run, so a wired one goes to Python. Settings the
  // runner reads must not be wired. "Style Transfer · IP-Adapter" is retired
  // (model line-up H2): fofr/style-transfer has only an estimated price, so
  // the runner no longer takes it; saved nodes run on ComfyUI as before.
  RestyleFromImageNode: {
    models: {
      'Nano Banana 2': 'restyle', 'Nano Banana Pro': 'restyle', 'Nano Banana': 'restyle',
    },
    mustLink: ['content_image'],
    mustNotLink: ['style_in', 'prompt', 'style_refs', 'structure_strength', 'resolution', 'output_format'],
  },
  // ── replicate-image (Task B4): the Replicate-primary image models ──
  // Only ADDS these models; the fal ones stay as they are. The Idea socket
  // (prompt_in) and the taste wire (style_in) come from nodes the runner does
  // not run, so a wired one goes to Python.
  // ── gpt-image-2.5 (model line-up F2): GPT Image 2.5 on fal, runner-only ──
  // ── qwen-image-3 (model line-up F6): Qwen Image 3 on Replicate, runner-only ──
  // ── grok-imagine-2 (model line-up F7): Grok Imagine 2 on Replicate, runner-only ──
  // ── ideogram-4 (model line-up F8): Ideogram 4 on fal, runner-only ──
  // ── muse-image (model line-up F13): Muse Image (Meta) on fal, runner-only ──
  // ── nano-banana-2-lite (model line-up F14): Nano Banana 2 Lite on Replicate, runner-only ──
  // ── reve-2.1 (model line-up F15): Reve 2.1 on fal, runner-only ──
  // ── recraft-v4.1 (model line-up F16): Recraft V4.1 on fal, Replicate the backup, runner-only ──
  // ── krea-2 (model line-up F17): Krea 2 Large and Medium on fal, Replicate the backup. NOT
  //    runner-only: with the family off they run on ComfyUI through their Python builders as before ──
  GenerateImageNode: {
    models: {
      ...Object.fromEntries(RUNNER_REPLICATE_IMAGE_MODEL_IDS.map(id => [id, 'replicate-image' as const])),
      'gpt-image-2.5': 'gpt-image-2.5',
      'qwen-image-3': 'qwen-image-3',
      'grok-imagine-2': 'grok-imagine-2',
      'ideogram-4': 'ideogram-4',
      'muse-image': 'muse-image',
      'nano-banana-2-lite': 'nano-banana-2-lite',
      'reve-2.1': 'reve-2.1',
      'recraft-v4.1': 'recraft-v4.1',
      'krea-2-large': 'krea-2',
      'krea-2-medium': 'krea-2',
    },
    mustNotLink: ['prompt', 'model_options', 'style_block', 'style_refs', 'prompt_in', 'style_in'],
  },
  // ── replicate-video (Task B6): the Replicate-provider video models ──
  // Only ADDS these models; the fal ones stay as they are. A legacy label is
  // looked up by its current id ('Kling 2.1' → kling-v2.5-turbo-pro).
  // wan-2.5-i2v-fast is image-to-video only: Python raises without a first frame.
  // ── wan-3 (model line-up F1): Wan 3.0 on fal, runner-only ──
  // Wan 3.0 Prime is image-to-video only: its first frame must be linked.
  // ── h3-max-turbo (model line-up F3): Hailuo H3 Max Turbo on fal, runner-only ──
  // H3 Max's modes: a prompt alone, or a linked first frame.
  // ── gemini-omni-flash (model line-up F4): Gemini Omni Flash on fal, runner-only ──
  // A prompt alone, or a linked first frame (no last frame or references).
  // ── veo-3.1-lite (model line-up F5): Veo 3.1 Lite on fal, runner-only ──
  // Veo 3.1's modes: a prompt alone, or a linked first frame.
  // ── happyhorse-1.1 (model line-up F18): HappyHorse 1.1 on fal, runner-only ──
  // A prompt alone, or a linked first frame. It makes its own sound: a linked
  // sound is never taken (runnerTakesNode refuses a linked `audio`).
  // ── grok-imagine-video-1.5 (model line-up F19): Grok Imagine Video 1.5 on fal, runner-only ──
  // HappyHorse 1.1's modes: a prompt alone, or a linked first frame; no sound in.
  // ── ltx-2.5-fast (model line-up F20): LTX-2.5 Fast on Replicate, runner-only ──
  // The same modes: a prompt alone, or a linked first frame; no sound in.
  // ── luma-ray-3.2 (model line-up F21): Luma Ray 3.2 on Replicate, fal the backup, runner-only ──
  // The same modes: a prompt alone, or a linked first frame; no sound in.
  GenerateVideoNode: {
    models: {
      ...Object.fromEntries(RUNNER_REPLICATE_VIDEO_MODEL_IDS.map(id => [id, id === 'wan-2.5-i2v-fast'
        ? { family: 'replicate-video' as const, mustLink: ['image'] }
        : 'replicate-video' as const])),
      'wan-3.0': 'wan-3',
      'wan-3.0-prime': { family: 'wan-3', mustLink: ['image'] },
      'hailuo-h3-max-turbo': 'h3-max-turbo',
      'gemini-omni-flash': 'gemini-omni-flash',
      'veo-3.1-lite': 'veo-3.1-lite',
      'happyhorse-1.1': 'happyhorse-1.1',
      'grok-imagine-video-1.5': 'grok-imagine-video-1.5',
      'ltx-2.5-fast': 'ltx-2.5-fast',
      'luma-ray-3.2': 'luma-ray-3.2',
    },
    mustNotLink: ['prompt', 'model_options'],
  },
  // ── frame: the Frame render, computed by the runner (server/runner/compositor/) ──
  // The static composite, and its protect_mask when Blend scene's
  // keep_subject reads it (Task F11b). Left to ComfyUI: baked motion (a frame
  // batch and a real video), anything else reading the protect_mask, anything
  // reading the video output,
  // a mask from anything but a LoadImage, and layer 1 unwired. layer1 is a
  // REQUIRED input (`_layer_inputs(1, optional=False)`), and ComfyUI's
  // validate_inputs reports any missing required input, wire or widget, as
  // required_input_missing. validate_prompt then drops that output: with no
  // other valid output the prompt is refused ("Prompt outputs failed
  // validation"); with one (an Image card) the prompt succeeds WITHOUT
  // running the Frame or anything reading it (history c7690393, 2026-09-24:
  // two layer1-less Frames, status success, outputs only the Image card).
  // The runner leaves those prompts to ComfyUI rather than render a Frame
  // ComfyUI never renders.
  Compositor: {
    family: 'frame',
    local: 'render',
    mustLink: ['layer1'],
    required: ['layer1'],
    widgets: compositorWidgets(),
    outputsNotLinked: [2],
    outputReaders: { 1: [['BlendSceneNode', 'keep_subject']] },
    linkSources: Object.fromEntries([
      ...Array.from({ length: COMPOSITOR_MAX_LAYERS }, (_, i) => [`layer${i + 1}_mask`, LOAD_IMAGE_MASK] as const),
      ['overlay_mask', LOAD_IMAGE_MASK] as const,
    ]),
    noJsonList: { motion_params: 'rendered' },
    imageInputs: [...Array.from({ length: COMPOSITOR_MAX_LAYERS }, (_, i) => `layer${i + 1}`), 'overlay'],
    frameLimits: {
      maxCopies: MAX_FRAME_COPIES,
      maxArtboardPixels: MAX_FRAME_ARTBOARD_PIXELS,
      hostedMaxArtboardPixels: HOSTED_MAX_FRAME_ARTBOARD_PIXELS,
      maxWork: MAX_FRAME_WORK,
    },
  },
  // The LoadImage the Frame editor injects at submit for baked text/shape
  // layers and masks (VueNodeCanvas injectCompositorOverlays). Taken only
  // when it feeds Frames: anywhere else its RGB-only picture would differ
  // from the file the runner hands a provider.
  LoadImage: {
    family: 'frame',
    local: 'source',
    mustNotLink: ['image', 'upload'],
    feedsOnly: ['Compositor'],
  },
  // ── sync-3 (model line-up F22): Lip-sync a character on sync-3 (sync.so) on fal, runner-only ──
  // Only the sync-3 engine (`model_options.engine` over the widget, as
  // LipSyncNode.execute reads it; ./lipSync.ts): Fabric and Kling stay on
  // ComfyUI. The face video is the studio's `model_options.face_video`; the
  // sound is its `model_options.audio`, or a linked Audio card (the one linked
  // sound the runner takes). The engine, sync mode and options are read before
  // the run, so they must not be wired; a linked picture is a face sync-3 isn't
  // sent here (its video endpoint takes a video).
  LipSyncNode: {
    models: { [SYNC_3_ENGINE]: 'sync-3' },
    mustNotLink: ['model_options', 'engine', 'sync_mode', 'image'],
    linkSources: { audio: [['Audio', 0]] },
  },
  // The Audio card a sync-3 lip-sync reads its sound from: its own file,
  // handed on (no call, no charge). Taken only when it feeds lip-sync nodes
  // and plays its file (nothing wired into `source`).
  // F22 fix round 1: only a card something reads (a lone card, even beside
  // other runner work, stays with ComfyUI), and with `export` off (the runner
  // saves no copy to the output folder).
  Audio: {
    family: 'sync-3',
    local: 'source',
    mustNotLink: ['audio', 'source'],
    feedsOnly: ['LipSyncNode'],
    needsReader: true,
    offWidgets: ['export'],
  },
  // ── topaz-video (model line-up F23): Enhance a video on fal's Topaz video upscale ──
  // The node already runs Topaz on ComfyUI (Replicate's topazlabs/video-upscale,
  // flat priced), so this family moves the whole class (Ruling 10), as F10 and
  // F12 do: while it is on, the node runs only in the runner, which reads the
  // video, measures it and prices it (./topazVideo.ts); off, ComfyUI as before.
  // The video is `video_url`, a `/view?…&type=input` link to a file uploaded to
  // Sailor (a web link is refused plainly before the hold: it can't be
  // measured). Every widget is read before the run, so none may be wired, and
  // each must pass ComfyUI's own validation.
  EnhanceVideoNode: {
    upgrade: { family: 'topaz-video', label: 'Topaz Video Upscale' },
    mustNotLink: ['model', 'video_url', 'target_resolution', 'fps'],
    widgets: {
      model: { type: 'COMBO', required: true, options: ['Topaz Video Upscale'] },
      video_url: { type: 'STRING', required: true },
      target_resolution: { type: 'COMBO', required: true, options: Object.keys(TOPAZ_VIDEO_TARGETS) },
      fps: { type: 'COMBO', required: true, options: TOPAZ_VIDEO_FPS },
    },
  },
}

/**
 * Classes that exist in RUNNER_NODE_RULES for one family only: with it off,
 * the runner knows nothing of them (validate.ts leaves a workflow with them
 * whole, as before they had a row). F22 fix round 1.
 */
export const SWITCHED_CLASSES: Readonly<Record<string, RunnerFamily>> = {
  LipSyncNode: 'sync-3',
  Audio: 'sync-3',
  EnhanceVideoNode: 'topaz-video',
}

/**
 * The classes that make a provider call (and so are charged): the two
 * generators, plus every class a family row adds that is not computed by
 * the runner itself. A workflow needs at least one of them, or one local
 * render (LOCAL_RENDER_TYPES), to go to the runner.
 */
export const PROVIDER_TYPES: ReadonlySet<string> = new Set([
  'GenerateImageNode', 'GenerateVideoNode',
  ...Object.entries(RUNNER_NODE_RULES).filter(([, r]) => !r.local).map(([k]) => k),
])

/** Classes the runner renders itself (free, no provider): the Frame. They count as work. */
export const LOCAL_RENDER_TYPES: ReadonlySet<string> = new Set(
  Object.entries(RUNNER_NODE_RULES).filter(([, r]) => r.local === 'render').map(([k]) => k),
)

/**
 * The newer model a node class runs while its upgrade family is on
 * (RunnerNodeRule.upgrade), or null: the class has none, or it is off.
 */
export function classUpgradeOn(classType: string, families: ReadonlySet<RunnerFamily>): ClassUpgrade | null {
  const rule = Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, classType) ? RUNNER_NODE_RULES[classType] : undefined
  return rule?.upgrade && families.has(rule.upgrade.family) ? rule.upgrade : null
}

/**
 * Whether a node's setting is hidden because its class runs a newer model
 * that can't honour it (ClassUpgrade.hiddenWidgets), with these families on.
 */
export function upgradeHidesWidget(classType: string, widgetName: string, families: ReadonlySet<RunnerFamily>): boolean {
  return classUpgradeOn(classType, families)?.hiddenWidgets?.includes(widgetName) ?? false
}

/** The image models that default to fal AND have a price, taken with no
 *  family. seedream-5-pro is left out until it is priced. krea-2-large and
 *  krea-2-medium are taken only under their own family, krea-2 (F17). */
export const RUNNER_IMAGE_MODEL_IDS = [
  'flux-1.1-pro', 'flux-schnell', 'nano-banana-pro', 'nano-banana-2',
  'ideogram-v3-quality', 'ideogram-v3-balanced', 'ideogram-v3-turbo',
  'seedream-5-lite', 'seedream-4',
] as const

export const RUNNER_VIDEO_MODEL_IDS = [
  'veo-3.1', 'veo-3.1-fast', 'flux-3', 'seedance-2.0', 'hailuo-h3', 'hailuo-h3-max',
] as const

/** GenerateVideoNode._LEGACY_MODEL_REMAP (comfy_api_nodes/nodes_replicate.py). */
export const LEGACY_VIDEO_MODEL_REMAP: Record<string, string> = {
  'Seedance 2.0': 'seedance-2.0',
  'Veo 3': 'veo-3.1',
  'Kling 2.1': 'kling-v2.5-turbo-pro',
}

const IMAGE_IDS: ReadonlySet<string> = new Set(RUNNER_IMAGE_MODEL_IDS)
const VIDEO_IDS: ReadonlySet<string> = new Set(RUNNER_VIDEO_MODEL_IDS)

export function resolveVideoModelId(model: unknown): string {
  const m = typeof model === 'string' ? model : ''
  return LEGACY_VIDEO_MODEL_REMAP[m] ?? m
}

/** `model_options` as GenerateImageNode reads it: a JSON object, anything unreadable is empty. */
function modelOptions(raw: unknown): Record<string, unknown> {
  let v: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return {}
    try { v = JSON.parse(raw) }
    catch { return {} }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

/** An integer option the way the fal builders read it (server/runner/generators/opts.ts optInt). */
function optionInt(opts: Record<string, unknown>, key: string): number {
  const v = opts[key]
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 1
  // Python int(str), one grammar with optInt: int()'s own blanks, underscores between digits.
  if (typeof v === 'string') return pyIntOf(v) ?? 1
  return 1
}

/**
 * The runner makes and charges one picture per image node. A node asking for
 * more (several outputs, or Seedream's picture series) goes to Python whole.
 */
function asksForSeveralImages(inputs: Record<string, unknown>): boolean {
  const opts = modelOptions(inputs.model_options)
  if (optionInt(opts, 'num_outputs') > 1) return true
  return opts.sequential_image_generation != null
    && String(opts.sequential_image_generation) === 'auto'
    && optionInt(opts, 'max_images') > 1
}

/**
 * The value a rule's `models` looks up: the model widget (a legacy video label
 * → its current id), or for Lip-sync a character the engine it runs
 * (./lipSync.ts; options that can't be read give none).
 */
function modelKey(classType: string, inputs: Record<string, unknown>): string {
  if (classType === 'GenerateVideoNode') return resolveVideoModelId(inputs.model)
  if (classType === 'LipSyncNode') {
    const engine = lipSyncEngine(inputs)
    return isSync3LipSync(inputs) && typeof engine === 'string' ? engine : ''
  }
  return typeof inputs.model === 'string' ? inputs.model : ''
}

/** Whether a rule row lets this node through with these families switched on. */
export function nodeRuleAllows(
  classType: string,
  rule: RunnerNodeRule,
  inputs: Record<string, unknown>,
  families: ReadonlySet<RunnerFamily>,
  opts: RunnerEligibilityOptions = {},
): boolean {
  const need: string[] = [...(rule.mustLink ?? [])]
  let family: RunnerFamily | undefined = rule.family
  if (rule.models) {
    const key = modelKey(classType, inputs)
    const m = Object.prototype.hasOwnProperty.call(rule.models, key) ? rule.models[key] : undefined
    if (!m) return false
    if (typeof m === 'string') family = m
    else {
      family = m.family
      need.push(...(m.mustLink ?? []))
    }
  }
  const upgraded = !!rule.upgrade && families.has(rule.upgrade.family)
  if (!upgraded && (!family || !families.has(family))) return false
  if (need.some(name => !isLink(inputs[name]))) return false
  if ((rule.mustNotLink ?? []).some(name => isLink(inputs[name]))) return false
  if ((rule.offWidgets ?? []).some(name => isLink(inputs[name]) || pyTruthy(inputs[name]))) return false
  for (const [name, spec] of Object.entries(rule.widgets ?? {})) {
    if (!widgetValid(inputs, name, spec)) return false
  }
  for (const [name, key] of Object.entries(rule.noJsonList ?? {})) {
    if (hasJsonList(inputs[name], key)) return false
  }
  if (rule.frameLimits && !withinFrameLimits(inputs, rule.frameLimits, !!opts.hosted)) return false
  return true
}

/** Python int(v) for a JSON value, or null where int() raises. */
function pyIntValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') return pyIntOf(v)
  return null
}

/**
 * How many copies one layer's cloner widget stamps, read as `_expand_clones`
 * reads it; null when Python's int() would raise on a count.
 */
export function clonerCopies(raw: unknown): number | null {
  if (!raw || typeof raw !== 'string') return 1
  let c: unknown
  try { c = JSON.parse(raw) }
  catch { return 1 }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 1
  const o = c as Record<string, unknown>
  if (!pyTruthy(o.enabled)) return 1
  const count = (k: string) => {
    const n = pyIntValue(Object.prototype.hasOwnProperty.call(o, k) ? o[k] : 1)
    return n === null ? null : Math.max(1, n)
  }
  if (o.mode === 'radial') return count('count')
  const nx = count('countX')
  const ny = count('countY')
  if (nx === null || ny === null) return null
  return (pyTruthy(o.mirrorX) ? 2 * nx - 1 : nx) * (pyTruthy(o.mirrorY) ? 2 * ny - 1 : ny)
}

function withinFrameLimits(inputs: Record<string, unknown>, lim: FrameLimits, hosted: boolean): boolean {
  let copies = 0
  for (let i = 1; i <= COMPOSITOR_MAX_LAYERS; i++) {
    if (!isLink(inputs[`layer${i}`])) continue
    const n = clonerCopies(inputs[`layer${i}_cloner`])
    if (n === null) return false
    copies += n
    if (copies > lim.maxCopies) return false
  }
  const w = pyIntValue(inputs.width ?? 0)
  const h = pyIntValue(inputs.height ?? 0)
  if (w !== null && h !== null && w > 0 && h > 0) {
    if (w * h > (hosted ? lim.hostedMaxArtboardPixels : lim.maxArtboardPixels)) return false
    if (copies * w * h > lim.maxWork) return false
  }
  return true
}

/** Whether a wire carries a picture: output 0 of an image class, followed back through Gates. */
function carriesImage(prompt: ApiPrompt, link: [string, number], depth = 0): boolean {
  const from = prompt[link[0]]
  if (!from || link[1] !== 0 || depth > 64) return false
  if (from.class_type === 'ComfyGateNode') {
    const d = from.inputs?.data_in
    return isLink(d) && carriesImage(prompt, d, depth + 1)
  }
  return IMAGE_OUTPUT_CLASSES.has(from.class_type)
}

/** One of ComfyUI's validation errors (execution.py validate_inputs), in its own shape. */
export interface ComfyValidationError {
  type: string
  message: string
  details: string
  extra_info: { input_name: string }
}

/**
 * ComfyUI's validate_inputs for one widget (execution.py): present if
 * required, converts to its type, in range, in the options. Returns the
 * error ComfyUI would report, 'wired' for a wire into the widget (valid to
 * ComfyUI when the types match; the runner leaves it to ComfyUI), or null.
 */
export function widgetError(inputs: Record<string, unknown>, name: string, spec: RunnerWidgetSpec): ComfyValidationError | 'wired' | null {
  const err = (type: string, message: string, details = name): ComfyValidationError => ({ type, message, details, extra_info: { input_name: name } })
  if (!Object.prototype.hasOwnProperty.call(inputs, name)) return spec.required ? err('required_input_missing', 'Required input is missing') : null
  const v = inputs[name]
  if (isLink(v)) return 'wired'
  if (Array.isArray(v)) return err('bad_linked_input', 'Bad linked input, must be a length-2 list of [node_id, slot_index]')
  // An object ({"__value__": …}) is unwrapped by ComfyUI; the runner leaves it to ComfyUI.
  if (v !== null && typeof v === 'object') return 'wired'
  let n: number | null = null
  switch (spec.type) {
    case 'FLOAT':
      n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? pyFloatOf(v) : null
      break
    case 'INT':
      n = typeof v === 'number' ? (Number.isFinite(v) ? Math.trunc(v) : null)
        : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? pyIntOf(v) : null
      break
    case 'COMBO':
      return typeof v === 'string' && (spec.options ?? []).includes(v)
        ? null
        : err('value_not_in_list', 'Value not in list', `${name}: '${String(v)}' not in [${(spec.options ?? []).map(o => `'${o}'`).join(', ')}]`)
    default:
      // BOOLEAN is bool(v) and STRING is str(v): every plain value converts.
      return null
  }
  if (n === null) return err('invalid_input_type', `Failed to convert an input value to a ${spec.type} value`, `${name}, ${String(v)}`)
  // NaN passes both checks, as it does in Python.
  if (spec.min !== undefined && n < spec.min) return err('value_smaller_than_min', `Value ${n} smaller than min of ${spec.min}`)
  if (spec.max !== undefined && n > spec.max) return err('value_bigger_than_max', `Value ${n} bigger than max of ${spec.max}`)
  return null
}

/** Whether a widget passes ComfyUI's validation and is not wired (the runner reads its value). */
export function widgetValid(inputs: Record<string, unknown>, name: string, spec: RunnerWidgetSpec): boolean {
  return widgetError(inputs, name, spec) === null
}

/**
 * The errors ComfyUI's validate_inputs gives this node on its own (not its
 * upstream), for the part of validation the runner ports: required inputs
 * present (`required` and required widgets), widget values valid. A class
 * with no rule row has nothing ported and gives none.
 */
export function nodeValidationErrors(classType: string, inputs: Record<string, unknown>): ComfyValidationError[] {
  const rule = RUNNER_NODE_RULES[classType]
  if (!rule) return []
  const out: ComfyValidationError[] = []
  for (const name of rule.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(inputs, name)) {
      out.push({ type: 'required_input_missing', message: 'Required input is missing', details: name, extra_info: { input_name: name } })
    }
  }
  for (const [name, spec] of Object.entries(rule.widgets ?? {})) {
    const e = widgetError(inputs, name, spec)
    if (e && e !== 'wired') out.push(e)
  }
  return out
}

/** Whether a JSON text input carries a non-empty list under `key` (as `json.loads(v or "{}")` reads it). */
function hasJsonList(v: unknown, key: string): boolean {
  if (typeof v !== 'string' || !v) return false
  let parsed: unknown
  try { parsed = JSON.parse(v) }
  // Python's json.loads also reads NaN and Infinity, which JSON.parse refuses: be safe.
  catch { return v.includes(key) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const list = (parsed as Record<string, unknown>)[key]
  return Array.isArray(list) && list.length > 0
}

/** The checks a rule makes across the prompt: who reads this node, and where its wires come from. */
function graphRuleAllows(prompt: ApiPrompt, id: string, rule: RunnerNodeRule): boolean {
  const notLinked = rule.outputsNotLinked ?? []
  const slotReaders = rule.outputReaders
  if (notLinked.length || slotReaders || rule.feedsOnly || rule.needsReader) {
    let readers = 0
    for (const node of Object.values(prompt)) {
      for (const l of linksOf(node)) {
        if (l.from !== id) continue
        readers++
        if (notLinked.includes(l.slot)) return false
        const only = slotReaders && Object.prototype.hasOwnProperty.call(slotReaders, l.slot) ? slotReaders[l.slot] : undefined
        if (only && !only.some(([cls, input]) => cls === node.class_type && input === l.input)) return false
        if (rule.feedsOnly && !rule.feedsOnly.includes(node.class_type)) return false
      }
    }
    if (rule.needsReader && !readers) return false
  }
  const inputs = prompt[id]?.inputs ?? {}
  for (const name of rule.imageInputs ?? []) {
    const v = inputs[name]
    if (isLink(v) && !carriesImage(prompt, v)) return false
  }
  for (const [name, sources] of Object.entries(rule.linkSources ?? {})) {
    const v = inputs[name]
    if (!isLink(v)) continue
    const from = prompt[v[0]]
    if (!from || !sources.some(([cls, slot]) => cls === from.class_type && slot === v[1])) return false
  }
  return true
}

/**
 * Whether the runner can take this one node of the prompt: a runner node type,
 * on a runner model, asking for one picture, with no sound wired into a
 * video, and reading only from nodes in the same prompt — or a class (or
 * model) a switched-on family's row lets through (its widgets valid, and
 * its readers and wire sources as the row allows). A workflow goes to the
 * runner only when every node passes AND it has a provider node or a local
 * render (isRunnerEligible). `nodesNeedingEngine` (app/lib/runner/needsEngine.ts)
 * names the nodes that fail this, so there is one rule, not two. With no
 * families (the default) this is exactly the rule before families existed.
 */
export function runnerTakesNode(prompt: ApiPrompt, id: string, families: ReadonlySet<RunnerFamily> = NO_FAMILIES, opts: RunnerEligibilityOptions = {}): boolean {
  const n = prompt[id]
  if (!n) return false
  const inputs = n.inputs ?? {}
  const rule = families.size ? RUNNER_NODE_RULES[n.class_type] : undefined
  const byRule = !!rule && nodeRuleAllows(n.class_type, rule, inputs, families, opts) && graphRuleAllows(prompt, id, rule)
  if (!RUNNER_NODE_TYPES.has(n.class_type) && !byRule) return false
  if (n.class_type === 'GenerateImageNode') {
    if (!IMAGE_IDS.has(String(inputs.model)) && !byRule) return false
    if (asksForSeveralImages(inputs)) return false
  }
  else if (n.class_type === 'GenerateVideoNode') {
    if (!VIDEO_IDS.has(resolveVideoModelId(inputs.model)) && !byRule) return false
    if (isLink(inputs.audio)) return false
  }
  for (const v of Object.values(inputs)) {
    if (isLink(v) && !(v[0] in prompt)) return false
  }
  return true
}

export function isRunnerEligible(prompt: ApiPrompt | null | undefined, families: ReadonlySet<RunnerFamily> = NO_FAMILIES, opts: RunnerEligibilityOptions = {}): boolean {
  if (!prompt) return false
  const ids = Object.keys(prompt)
  if (!ids.length) return false
  let work = 0
  for (const id of ids) {
    if (!runnerTakesNode(prompt, id, families, opts)) return false
    const ct = prompt[id]!.class_type
    if (PROVIDER_TYPES.has(ct) || LOCAL_RENDER_TYPES.has(ct)) work++
  }
  return work > 0 || !!opts.afterPruning
}
