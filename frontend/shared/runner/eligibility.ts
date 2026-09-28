/**
 * Which workflows the Sailor runner takes. Everything else goes to ComfyUI
 * whole — a workflow is never split between the two.
 */
import { isLink, linksOf, type ApiPrompt } from './graph'
import { NO_FAMILIES, familyOn, type RunnerFamily } from './families'
import { pyFloatOf, pyIntOf, pyTruthy } from './pyText'
import { SYNC_3_ENGINE, isSync3LipSync, lipSyncEngine } from './lipSync'
import { TOPAZ_VIDEO_FPS, TOPAZ_VIDEO_TARGETS } from './topazVideo'
import { PERSON_SWAP_RESOLUTIONS } from './personSwapVideo'
import { SHOT_OVERRIDE_WIDGETS, SHOT_PRESET_IDS } from './shotPresets'
import { outputKind, BASE_VALUE_INPUTS, OUTPUT_KINDS, type ValueKind } from './values'
import { moodboardReadingIsPlain } from '../taste/moodboardStyle'
import { IMAGE_LAYERS, TEXT_LAYERS, smartLayoutPixels } from './smartLayout'
import {
  EFFECT_FAMILY_OF, EFFECT_OUTPUT_KINDS, EFFECT_PICTURE_OUTPUTS,
  asciiGlyphsArePortable, effectFamilyOn, effectOutputSizeFits, effectPreviewName, effectRows, effectSwitchedClasses, effectTextIsPortable, painterInputsArePortable,
} from './effects'
import { SHADER_ASPECTS, shaderBakeTaken } from './shaderBakeKey'
import {
  ENHANCE_ENGINES, REMOVE_BACKGROUND_MODELS, REPAIR_CLASSES, REPAIR_OUTPUT_FORMATS, RESTORE_PHOTO_MODELS,
  TOPAZ_ENHANCE_MODELS, TOPAZ_SUBJECT_DETECTION, TOPAZ_UPSCALE_FACTORS, UPSCALE_ENGINES,
} from './repair'
import {
  LAYERIZE_MODELS, LAYERS_CLASSES, LAYERS_JSON_CLASSES, OUTPAINT_ASPECT_RATIOS, OUTPAINT_DIRECTIONS, OUTPAINT_MODELS, SEEDREAM_IMAGE_SIZES,
  PHOTO_FILLS, SPLIT_CLASS, SPLIT_MASK_GROW,
} from './layers'
import {
  AUDIO_GEN_CLASSES, MINIMAX_EMOTIONS, MINIMAX_LANGUAGES, MUSIC_MAX_SECONDS, MUSIC_MIN_SECONDS, MUSIC_MODEL_VERSIONS, MUSIC_MODELS, SPEECH_MODELS,
} from './audioGen'
import {
  GENERATE_3D_MODELS, GEN_3D_CLASSES, GEN_3D_GUIDANCE, GEN_3D_OCTREE, GEN_3D_SEED_MAX, GEN_3D_STEPS, MULTI_VIEW_ENGINES, RODIN_POLY_MAX, RODIN_QUALITIES,
} from './gen3d'
import {
  BRAINSTORM_ANGLES, CHAT_LLM_MODELS, IMPROVE_PROMPT_MODELS, IMPROVE_PROMPT_TARGETS, REASON_MODELS, REWRITE_MODELS, REWRITE_TONES,
  SUMMARIZE_LENGTHS, SUMMARIZE_MODELS, TRANSLATE_LANGUAGES,
} from './llm'

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
   * Inputs that take a value wire (R0), and of which kinds. Such an input is
   * exempt from `mustNotLink` when the wire carries one of these kinds: the
   * engine hands the node the value as if it were typed. A wire of any other
   * kind into it (files, or an unknown source) is refused.
   */
  valueInputs?: Readonly<Record<string, readonly ValueKind[]>>
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
  /**
   * The class hands on a list (ComfyUI's is_output_list: the next node runs
   * once per item): only these classes may read it. Anything else is left to
   * the engine (R1.6: ComfyUI would run a paid node once per item).
   */
  listReaders?: readonly string[]
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
   * Inputs that, when wired, must carry a picture: a picture slot of a class
   * in PICTURE_OUTPUTS, or output 0 of one in IMAGE_OUTPUT_CLASSES, followed
   * back through Gates. A video (a Video card,
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
  /** Checks of the node's own inputs the runner needs to pass before it takes the node (INPUT_CHECKS). */
  inputCheck?: InputCheckName | readonly InputCheckName[]
  /**
   * A second family that also switches the class on, lifting some of the
   * row's limits while it is on (R1.3: with `cards` on, LoadImage may feed
   * anything, not only Frames). With it off, the row is exactly as before.
   */
  open?: { family: RunnerFamily; lifts: readonly ('feedsOnly')[] }
}

/** What an input check may read beside the node's inputs: its class, its id in the prompt, the host, and (R2.10) the prompt. */
export interface InputCheckContext { classType: string; nodeId?: string; hosted?: boolean; prompt?: ApiPrompt }

/**
 * Checks of a node's own inputs, named by RunnerNodeRule.inputCheck. A node
 * that fails one is left to the engine.
 */
export const INPUT_CHECKS: Readonly<Record<string, (inputs: Record<string, unknown>, ctx: InputCheckContext) => boolean>> = {
  // The Moodboard's reading is the plain text the moodboard window writes (spec ruling 3).
  'moodboard-reading': (inputs: Record<string, unknown>): boolean => moodboardReadingIsPlain(inputs.reading_json),
  // A bake card's `params` (Text on path, Text mask) reads the same in JSON.parse
  // as in Python's json.loads: text only Python reads (NaN, Infinity) is left to the engine.
  'bake-params': (inputs: Record<string, unknown>): boolean => bakeParamsReadable(inputs.params),
  // Empty image within the runner's caps (R1.4): 8192 × 8192, a batch of 64,
  // and at most CARD_MAX_PIXELS in all (width × height × batch: what a
  // utility reading it would work through). Checked after the widgets, so
  // each value already converts as int() does.
  'empty-image-caps': (inputs: Record<string, unknown>): boolean => {
    const w = pyIntValue(inputs.width) ?? Infinity
    const h = pyIntValue(inputs.height) ?? Infinity
    const batch = pyIntValue(inputs.batch_size) ?? Infinity
    return w <= EMPTY_IMAGE_MAX_SIDE && h <= EMPTY_IMAGE_MAX_SIDE && batch <= EMPTY_IMAGE_MAX_BATCH && w * h * batch <= CARD_MAX_PIXELS
  },
  // Smart Layout (R1.6): its outputs' pixels within CARD_MAX_PIXELS, and a
  // layout the runner reads as Python does (./smartLayout.ts smartLayoutPixels).
  'smart-layout': (inputs: Record<string, unknown>): boolean => {
    const px = smartLayoutPixels(inputs)
    return px !== null && px <= CARD_MAX_PIXELS
  },
  // An effect (R2 rule 4): its live preview is written as save_live_preview
  // names it, `live_preview_<node id>.png`; a node id the runner can't write
  // under that name leaves the node to the engine. Without an id (a caller
  // checking the row alone), nothing to check.
  'effect-preview-name': (_inputs, ctx) => ctx.nodeId === undefined || effectPreviewName(ctx.nodeId) !== null,
  // An effect's output size known from its widgets alone within the caps (R2 rule 7).
  'effect-output-size': (inputs, ctx) => effectOutputSizeFits(ctx.classType, inputs, !!ctx.hosted),
  // An effect's colour text (R2.4: hex colours, gradient stops, a duotone
  // pair) the runner reads exactly as Python does (./gradientStops.ts).
  'effect-text': (inputs, ctx) => effectTextIsPortable(ctx.classType, inputs),
  // Ascii's characters (R2.6): every character of the ramp it draws is in the
  // runner's glyph atlas (./asciiGlyphSet.generated.ts); any other is left to the engine.
  'ascii-glyphs': inputs => asciiGlyphsArePortable(inputs),
  // Painter (R2.8): its painter file's name and its colour read as Python reads
  // them (./effects.ts painterInputsArePortable); anything else is left to the engine.
  'painter': inputs => painterInputsArePortable(inputs),
  // The Shader effect (R2.10): a bake of the browser's the runner can replay
  // (./shaderBakeKey.ts shaderBakeTaken). Without the prompt, nothing to check it against.
  'shader-bake': (_inputs, ctx) => !!ctx.prompt && ctx.nodeId !== undefined && shaderBakeTaken(ctx.prompt, ctx.nodeId),
}

/** The name of an input check (INPUT_CHECKS). */
export type InputCheckName = 'moodboard-reading' | 'bake-params' | 'empty-image-caps' | 'smart-layout' | 'effect-preview-name' | 'effect-output-size' | 'effect-text' | 'ascii-glyphs' | 'painter' | 'shader-bake'

/** nodes.py MAX_RESOLUTION: the most ComfyUI allows for a width or height widget. */
export const COMFY_MAX_RESOLUTION = 16384
/** The largest Empty image side and batch the runner makes (R1.4); more goes to the engine. */
export const EMPTY_IMAGE_MAX_SIDE = 8192
export const EMPTY_IMAGE_MAX_BATCH = 64
/**
 * The most pixels one picture card works through in a turn (R1.4 fix round 1),
 * all its pictures together: four 8192 × 8192 pictures. More is left to the
 * engine when known up front (Empty image), else refused at the card's turn.
 */
export const CARD_MAX_PIXELS = 4 * 8192 * 8192

/** Whether JSON.parse reads `params` as json.loads does (both read it, or both fail on it). */
function bakeParamsReadable(v: unknown): boolean {
  if (typeof v !== 'string' || !v) return true
  try { JSON.parse(v) }
  catch { return !/NaN|Infinity/.test(v) }
  return true
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
   * The prompt is what is left after ComfyUI's pruning dropped some outputs,
   * or nodes no output reads (shared/runner/validate.ts, R3.8 fix round 1).
   * What is left may be only cards (a blank project: an Image card beside an
   * empty Frame, or beside an edit nothing reads): it runs, with nothing to
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
  'GenerateFromReferencesNode', 'RotateCameraNode', 'ProductShotNode', 'RestyleFromImageNode', 'FixFacesNode', 'FaceSwap',
  // (A paid family's picture classes, R3.5's image-repair, are not here: they are pictures only
  // while their family is on, PAID_PICTURE_FAMILY, which carriesImage reads first.)
])

/**
 * The picture classes a paid family adds (R3): each one's output 0 carries a
 * picture only while its family is on. With it off, a wire from it is no
 * picture to the runner, exactly as before R3 (rule 15).
 */
export const PAID_PICTURE_FAMILY: Readonly<Record<string, RunnerFamily>> = {
  ...Object.fromEntries(REPAIR_CLASSES.map(c => [c, 'image-repair' as const])),
  // R3.6: the layerizers' picture (slot 0; slot 1 is their JSON) and the outpainted picture.
  ...Object.fromEntries(LAYERS_CLASSES.map(c => [c, 'layers' as const])),
  // R3.7: Separate background and foreground's subject and background (slots 0 and 1, PAID_PICTURE_SLOTS).
  [SPLIT_CLASS]: 'layers',
}

/**
 * A paid family's picture class whose pictures are other slots than output 0
 * alone (R3.7: Separate background and foreground, subject and background),
 * pictures only while its family is on (PAID_PICTURE_FAMILY). Kept apart
 * from PICTURE_OUTPUTS, which answers with `cards` alone (rule 15: with the
 * family off, nothing changes).
 */
export const PAID_PICTURE_SLOTS: Readonly<Record<string, readonly number[]>> = {
  [SPLIT_CLASS]: [0, 1],
}

/**
 * Classes whose picture outputs are other slots than output 0 alone, or that
 * are pictures only on some slots (R1.3): 3D Studio's three passes, the Text
 * cards' image (their slot 1 is a mask); and the pictures only `cards` makes
 * (Empty image, R1.4; Smart Layout's renders, R1.6); and each ported
 * effect's picture slots (R2, EFFECT_PICTURE_OUTPUTS, only while its family
 * and `cards` are on). A class listed here is read from this table (and only
 * with `cards` on); any other from IMAGE_OUTPUT_CLASSES (slot 0).
 */
export const PICTURE_OUTPUTS: Readonly<Record<string, readonly number[]>> = {
  Scene3DStudio: [0, 1, 2],
  TextOnPath: [0],
  TextMask: [0],
  EmptyImage: [0],
  SmartLayout: [0],
  ...EFFECT_PICTURE_OUTPUTS,
}

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
    // R1.2: the prompt takes a text wire (a card's value arrives as if typed).
    valueInputs: { prompt: ['text'] },
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
  // ── fix-faces: Fix faces on fal's Topaz (replaces CodeFormer) ──
  FixFacesNode: {
    upgrade: { family: 'fix-faces', label: 'Fix faces' },
    mustLink: ['image'],
    imageInputs: ['image'],
    mustNotLink: ['strength', 'creativity', 'upscale'],
  },
  // ── face-swap: Face swap on Easel (replaces InsightFace inswapper) ──
  // The Face Swap mini app needs both `cards` and `face-swap` on (its pictures come in through LoadImage nodes, taken only with `cards`).
  FaceSwap: {
    upgrade: { family: 'face-swap', label: 'Face swap' },
    mustLink: ['source_face', 'target_frames'],
    imageInputs: ['source_face', 'target_frames'],
    mustNotLink: ['gender', 'keep_hair_from'],
  },
  // ── person-swap-video: Person swap (video) on fal's Pixverse Swap (the video half of FaceSwap) ──
  PersonSwapVideo: {
    upgrade: { family: 'person-swap-video', label: 'Person swap (video)' },
    mustLink: ['image'],
    imageInputs: ['image'],
    mustNotLink: ['video_url', 'resolution'],
    widgets: {
      video_url: { type: 'STRING', required: true },
      resolution: { type: 'COMBO', required: true, options: PERSON_SWAP_RESOLUTIONS },
    },
  },
  // ── llm-text (step 3, R3.3): the seven LLM text nodes on Replicate ──
  // Each text input takes a text wire (R0: the value arrives as typed); every
  // other setting is a widget as ComfyUI validates it (define_schema's
  // options and bounds). A wired widget leaves the node to the engine.
  ChatLLMNode: {
    family: 'llm-text',
    valueInputs: { prompt: ['text', 'json'], system_prompt: ['text', 'json'] },
    required: ['prompt', 'system_prompt'],
    widgets: {
      model: { type: 'COMBO', required: true, options: CHAT_LLM_MODELS },
      temperature: { type: 'FLOAT', required: true, min: 0, max: 2 },
      max_tokens: { type: 'INT', required: true, min: 1, max: 8192 },
    },
  },
  ImprovePromptNode: {
    family: 'llm-text',
    valueInputs: { idea: ['text', 'json'] },
    required: ['idea'],
    widgets: {
      model: { type: 'COMBO', required: true, options: IMPROVE_PROMPT_MODELS },
      target: { type: 'COMBO', required: true, options: IMPROVE_PROMPT_TARGETS },
    },
  },
  SummarizeTextNode: {
    family: 'llm-text',
    valueInputs: { text: ['text', 'json'] },
    required: ['text'],
    widgets: {
      length: { type: 'COMBO', required: true, options: Object.keys(SUMMARIZE_LENGTHS) },
      model: { type: 'COMBO', required: true, options: SUMMARIZE_MODELS },
    },
  },
  TranslateTextNode: {
    family: 'llm-text',
    valueInputs: { text: ['text', 'json'], custom_language: ['text', 'json'] },
    required: ['text', 'custom_language'],
    widgets: { target_language: { type: 'COMBO', required: true, options: TRANSLATE_LANGUAGES } },
  },
  RewriteToneNode: {
    family: 'llm-text',
    valueInputs: { text: ['text', 'json'] },
    required: ['text'],
    widgets: {
      tone: { type: 'COMBO', required: true, options: REWRITE_TONES },
      model: { type: 'COMBO', required: true, options: REWRITE_MODELS },
    },
  },
  BrainstormIdeasNode: {
    family: 'llm-text',
    valueInputs: { topic: ['text', 'json'] },
    required: ['topic'],
    widgets: {
      count: { type: 'INT', required: true, min: 2, max: 12 },
      angle: { type: 'COMBO', required: true, options: Object.keys(BRAINSTORM_ANGLES) },
    },
  },
  ReasonStepByStepNode: {
    family: 'llm-text',
    valueInputs: { question: ['text', 'json'] },
    required: ['question'],
    widgets: {
      include_reasoning: { type: 'BOOLEAN', required: true },
      model: { type: 'COMBO', required: true, options: REASON_MODELS },
    },
  },
  // ── describe (step 3, R3.4): Describe an image (+ its hidden twin), Describe
  // a video, Extract text, Find objects, on Replicate. The picture is a linked
  // picture (the handed-off file); the prompt and the query take a text wire
  // (R0: the value arrives as typed); every other setting is a widget as
  // ComfyUI validates it. A wired widget leaves the node to the engine.
  DescribeImageNode: {
    family: 'describe',
    mustLink: ['image'],
    imageInputs: ['image'],
    valueInputs: { prompt: ['text'] },
    required: ['prompt'],
    widgets: { model: { type: 'COMBO', required: true, options: ['Moondream 2'] } },
  },
  DescribeImageRemoteNode: {
    family: 'describe',
    mustLink: ['image'],
    imageInputs: ['image'],
    valueInputs: { prompt: ['text'] },
    required: ['prompt'],
  },
  DescribeVideoNode: {
    family: 'describe',
    valueInputs: { prompt: ['text'] },
    required: ['prompt'],
    widgets: {
      model: { type: 'COMBO', required: true, options: ['Gemini 2.5 Flash'] },
      video_url: { type: 'STRING', required: true },
    },
  },
  ExtractTextNode: {
    family: 'describe',
    mustLink: ['image'],
    imageInputs: ['image'],
    widgets: { model: { type: 'COMBO', required: true, options: ['ByteDance Dolphin'] } },
  },
  FindObjectsNode: {
    family: 'describe',
    mustLink: ['image'],
    imageInputs: ['image'],
    valueInputs: { query: ['text'] },
    required: ['query'],
    widgets: {
      model: { type: 'COMBO', required: true, options: ['YOLO-World'] },
      confidence: { type: 'FLOAT', required: true, min: 0, max: 1 },
    },
  },
  // ── restyle (Task B8): Nano Banana 2 / Pro on fal, Nano Banana on
  // Replicate. The prompt and the taste wire (style_in, a Moodboard card's
  // style block) take a text wire (R1.2): the card's value arrives as if
  // typed. Every other setting the runner reads must not be wired. "Style
  // Transfer · IP-Adapter" is retired (model line-up H2): fofr/style-transfer
  // has only an estimated price, so the runner no longer takes it; saved
  // nodes run on ComfyUI as before.
  RestyleFromImageNode: {
    models: {
      'Nano Banana 2': 'restyle', 'Nano Banana Pro': 'restyle', 'Nano Banana': 'restyle',
    },
    mustLink: ['content_image'],
    mustNotLink: ['style_in', 'prompt', 'style_refs', 'structure_strength', 'resolution', 'output_format'],
    valueInputs: { prompt: ['text'], style_in: ['text'] },
  },
  // ── replicate-image (Task B4): the Replicate-primary image models ──
  // Only ADDS these models; the fal ones stay as they are. The prompt, the
  // Idea socket (prompt_in), the style block and the taste wire (style_in)
  // take a text wire (R0.4, R1.2). model_options and style_refs stay unwired:
  // they decide how many pictures are made and which files are read before
  // the hold.
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
    // R0.4, R1.2: the words take a text wire (a card's value arrives as if typed).
    valueInputs: { prompt: ['text'], prompt_in: ['text'], style_block: ['text'], style_in: ['text'] },
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
    // R1.2: the prompt takes a text wire; model_options stays unwired (R11).
    valueInputs: { prompt: ['text'] },
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
    // LoadImage's MASK is a mask with `cards` on (R1.3), its file with `cards`
    // off (outputKindsFor): the mask inputs take either (linkSources still insist on a LoadImage).
    valueInputs: Object.fromEntries([
      ...Array.from({ length: COMPOSITOR_MAX_LAYERS }, (_, i) => [`layer${i + 1}_mask`, ['files', 'mask'] as const] as const),
      ['overlay_mask', ['files', 'mask'] as const] as const,
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
  // layers and masks (VueNodeCanvas injectCompositorOverlays). With `frame`
  // alone, taken only when it feeds Frames. With `cards` on (R1.3) it may feed
  // anything: it runs as a card whose picture is Python's RGB picture, not
  // the file (server/runner/cards/loadImage.ts).
  LoadImage: {
    family: 'frame',
    open: { family: 'cards', lifts: ['feedsOnly'] },
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
  // ── cards (step 3, R0.4): the Primitive cards (comfy_extras/nodes_primitive.py) ──
  // Each hands on its `value`, converted as ComfyUI's validate_inputs converts
  // a widget (int(), float(), str(), bool()). A value ComfyUI would refuse
  // (out of range, unconvertible, wired) leaves the node to the engine.
  PrimitiveString: { family: 'cards', local: 'source', widgets: { value: { type: 'STRING', required: true } } },
  PrimitiveStringMultiline: { family: 'cards', local: 'source', widgets: { value: { type: 'STRING', required: true } } },
  // -sys.maxsize..sys.maxsize, narrowed to what a JS number holds exactly.
  PrimitiveInt: { family: 'cards', local: 'source', widgets: { value: { type: 'INT', required: true, min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER } } },
  PrimitiveFloat: { family: 'cards', local: 'source', widgets: { value: { type: 'FLOAT', required: true, min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER } } },
  PrimitiveBoolean: { family: 'cards', local: 'source', widgets: { value: { type: 'BOOLEAN', required: true } } },
  // ── cards (step 3, R1.1): Text, Moodboard, 3D model ──
  // Text: typed text wins; blank typed text hands on what `source` brings.
  Text: { family: 'cards', local: 'source', valueInputs: { source: ['text', 'json', 'glb'] }, widgets: { text: { type: 'STRING', required: true } } },
  // Moodboard: the reading's style block. Taken only when the reading is the
  // plain text the moodboard window writes (spec ruling 3).
  Moodboard: {
    family: 'cards', local: 'source',
    widgets: { reading_json: { type: 'STRING', required: true }, moodboard_id: { type: 'STRING' } },
    inputCheck: 'moodboard-reading',
  },
  // 3D model: hands on the address wired in (Sailor's own copy, spec ruling 1).
  Model3D: { family: 'cards', local: 'source', valueInputs: { glb_url: ['glb', 'text'] } },
  // ── cards (step 3, R1.3): the bake-replay cards (server/runner/cards/bakeReplay.ts) ──
  // Each hands on the file its studio baked into the node's settings.
  Scene3DStudio: {
    family: 'cards', local: 'source',
    valueInputs: { glb_url: ['text', 'glb'] },
    widgets: { scene_state: { type: 'STRING' }, beauty_image: { type: 'STRING' }, depth_image: { type: 'STRING' }, normal_image: { type: 'STRING' } },
  },
  TextOnPath: { family: 'cards', local: 'source', widgets: { params: { type: 'STRING', required: true } }, inputCheck: 'bake-params' },
  // With a source wired (R1.4): the source clipped by the mask.
  TextMask: { family: 'cards', local: 'source', imageInputs: ['source'], widgets: { params: { type: 'STRING', required: true } }, inputCheck: 'bake-params' },
  // ── cards (step 3, R1.4): the picture utilities (server/runner/cards/utilities.ts) ──
  // Empty image: the widgets as ComfyUI validates them (nodes.py EmptyImage);
  // sizes over the runner's caps (ComfyUI allows them) leave it to the engine.
  EmptyImage: {
    family: 'cards', local: 'source',
    widgets: {
      width: { type: 'INT', required: true, min: 1, max: COMFY_MAX_RESOLUTION },
      height: { type: 'INT', required: true, min: 1, max: COMFY_MAX_RESOLUTION },
      batch_size: { type: 'INT', required: true, min: 1, max: 4096 },
      color: { type: 'INT', required: true, min: 0, max: 0xFFFFFF },
    },
    inputCheck: 'empty-image-caps',
  },
  GetImageSize: { family: 'cards', local: 'source', mustLink: ['image'], imageInputs: ['image'] },
  ImageToMask: {
    family: 'cards', local: 'source', mustLink: ['image'], imageInputs: ['image'],
    widgets: { channel: { type: 'COMBO', required: true, options: ['red', 'green', 'blue', 'alpha'] } },
  },
  // ── cards (step 3, R1.5): Save image and Preview image (server/runner/cards/saveImage.ts) ──
  // They write files, so they count as work (spec ruling 5): a workflow of
  // only cards and a Save image runs in the runner. The widgets as nodes.py
  // SaveImage declares them; Preview image has none but its pictures, and
  // nothing may read the pictures it hands on.
  SaveImage: {
    family: 'cards', local: 'render', mustLink: ['images'], required: ['images'], imageInputs: ['images'],
    widgets: {
      filename_prefix: { type: 'STRING', required: true },
      format: { type: 'COMBO', required: true, options: ['png', 'webp', 'jpeg'] },
      quality: { type: 'INT', required: true, min: 1, max: 100 },
      lossless_webp: { type: 'BOOLEAN', required: true },
      png_compression: { type: 'INT', required: true, min: 0, max: 9 },
      scale: { type: 'FLOAT', required: true, min: 0.1, max: 4.0 },
      max_dimension: { type: 'INT', required: true, min: 0, max: 16384 },
      embed_metadata: { type: 'BOOLEAN', required: true },
    },
  },
  PreviewImage: { family: 'cards', local: 'render', mustLink: ['images'], required: ['images'], imageInputs: ['images'], outputsNotLinked: [0] },
  // ── cards (step 3, R1.6): Smart Layout (server/runner/cards/smartLayout.ts) ──
  // It renders, so it counts as work. Its pictures are a list (one per
  // output), which only Save image and Preview image may read; its layout
  // must be one the runner reads as Python does, within the pixel cap.
  SmartLayout: {
    family: 'cards', local: 'render',
    valueInputs: { brand: ['text'], ...Object.fromEntries(TEXT_LAYERS.map(k => [k, ['text'] as const])) },
    imageInputs: IMAGE_LAYERS,
    widgets: { layout: { type: 'STRING', required: true }, aspects: { type: 'STRING', required: true }, brand_kit: { type: 'STRING' } },
    listReaders: ['SaveImage', 'PreviewImage'],
    inputCheck: 'smart-layout',
  },
  // ── shader-bake (step 3, R2.10): the Shader effect, replayed from the browser's bake ──
  // (server/runner/cards/shaderEffect.ts). The widgets as the node's schema;
  // `effect` is checked against the catalog by 'shader-bake' (an effect the
  // runner doesn't know is left to the engine, which validates it).
  ShaderEffect: {
    family: 'shader-bake', local: 'render', imageInputs: ['image'],
    widgets: {
      effect: { type: 'STRING', required: true },
      params: { type: 'STRING', required: true },
      time: { type: 'FLOAT', required: true, min: 0, max: 3600 },
      duration: { type: 'FLOAT', required: true, min: 0, max: 60 },
      fps: { type: 'INT', required: true, min: 1, max: 60 },
      seed: { type: 'INT', required: true, min: 0, max: 2 ** 31 - 1 },
      resolution: { type: 'INT', required: true, min: 256, max: 2048 },
      aspect: { type: 'COMBO', required: true, options: SHADER_ASPECTS },
    },
    inputCheck: 'shader-bake',
  },
  // ── image-repair (step 3, R3.5): Upscale, Enhance detail, Restore an old
  // photo and Remove background (+ the twins of the last two), on Replicate.
  // The picture is a linked picture (the handed-off file); Upscale's and
  // Enhance's prompts take a text wire (R0: the value arrives as typed); every
  // other setting is a widget as ComfyUI validates it (define_schema's
  // options and bounds). The two engine pickers keep their `model` per
  // engine. A wired widget leaves the node to the engine.
  UpscaleImageNode: {
    models: Object.fromEntries(UPSCALE_ENGINES.map(m => [m, 'image-repair' as const])),
    mustLink: ['image'],
    imageInputs: ['image'],
    valueInputs: { prompt: ['text'], negative_prompt: ['text'] },
    required: ['prompt', 'negative_prompt'],
    widgets: {
      model: { type: 'COMBO', required: true, options: UPSCALE_ENGINES },
      scale_factor: { type: 'FLOAT', required: true, min: 1, max: 10 },
      creativity: { type: 'FLOAT', required: true, min: 0, max: 1 },
      resemblance: { type: 'FLOAT', required: true, min: 0, max: 3 },
      num_inference_steps: { type: 'INT', required: true, min: 10, max: 50 },
      seed: { type: 'INT', required: true, min: 0, max: 0xFFFFFFFF },
      face_enhance: { type: 'BOOLEAN', required: true },
      topaz_enhance_model: { type: 'COMBO', required: true, options: TOPAZ_ENHANCE_MODELS },
      topaz_upscale_factor: { type: 'COMBO', required: true, options: TOPAZ_UPSCALE_FACTORS },
      topaz_subject_detection: { type: 'COMBO', required: true, options: TOPAZ_SUBJECT_DETECTION },
      topaz_output_format: { type: 'COMBO', required: true, options: REPAIR_OUTPUT_FORMATS },
      topaz_face_creativity: { type: 'FLOAT', required: true, min: 0, max: 1 },
      topaz_face_strength: { type: 'FLOAT', required: true, min: 0, max: 1 },
      crystal_creativity: { type: 'FLOAT', required: true, min: 0, max: 10 },
      crystal_output_format: { type: 'COMBO', required: true, options: REPAIR_OUTPUT_FORMATS },
    },
  },
  EnhanceDetailNode: {
    models: Object.fromEntries(ENHANCE_ENGINES.map(m => [m, 'image-repair' as const])),
    mustLink: ['image'],
    imageInputs: ['image'],
    valueInputs: { prompt: ['text'], negative_prompt: ['text'] },
    required: ['prompt', 'negative_prompt'],
    widgets: {
      model: { type: 'COMBO', required: true, options: ENHANCE_ENGINES },
      detail_strength: { type: 'FLOAT', required: true, min: 0, max: 1 },
      resemblance: { type: 'FLOAT', required: true, min: 0, max: 3 },
      num_inference_steps: { type: 'INT', required: true, min: 10, max: 50 },
      seed: { type: 'INT', required: true, min: 0, max: 0xFFFFFFFF },
      topaz_enhance_model: { type: 'COMBO', required: true, options: TOPAZ_ENHANCE_MODELS },
      topaz_subject_detection: { type: 'COMBO', required: true, options: TOPAZ_SUBJECT_DETECTION },
      topaz_output_format: { type: 'COMBO', required: true, options: REPAIR_OUTPUT_FORMATS },
      refine_steps: { type: 'INT', required: true, min: 10, max: 50 },
    },
  },
  RestorePhotoNode: {
    family: 'image-repair',
    mustLink: ['image'],
    imageInputs: ['image'],
    widgets: {
      model: { type: 'COMBO', required: true, options: RESTORE_PHOTO_MODELS },
      safety_tolerance: { type: 'INT', required: true, min: 1, max: 6 },
      output_format: { type: 'COMBO', required: true, options: REPAIR_OUTPUT_FORMATS },
    },
  },
  RestorePhotoRemoteNode: {
    family: 'image-repair',
    mustLink: ['image'],
    imageInputs: ['image'],
    widgets: {
      safety_tolerance: { type: 'STRING', required: true },
      output_format: { type: 'COMBO', required: true, options: REPAIR_OUTPUT_FORMATS },
    },
  },
  RemoveBackgroundNode: {
    family: 'image-repair',
    mustLink: ['image'],
    imageInputs: ['image'],
    widgets: { model: { type: 'COMBO', required: true, options: REMOVE_BACKGROUND_MODELS } },
  },
  RemoveBackgroundRemoteNode: {
    family: 'image-repair',
    mustLink: ['image'],
    imageInputs: ['image'],
  },
  // ── layers (step 3, R3.6): Separate text from image and Layerize an image
  // (their picture and their layers' JSON) and Expand / outpaint, on
  // Replicate and fal. The picture is a linked picture (the handed-off file);
  // the prompts take a text wire (R0: the value arrives as typed); every
  // other setting is a widget as ComfyUI validates it (define_schema's
  // options and bounds). Outpaint keeps its `model` per engine. A wired
  // widget leaves the node to the engine.
  LayerizeGraphicNode: {
    models: Object.fromEntries(LAYERIZE_MODELS.map(m => [m, 'layers' as const])),
    mustLink: ['image'],
    imageInputs: ['image'],
    valueInputs: { prompt: ['text'] },
    required: ['prompt'],
    widgets: {
      model: { type: 'COMBO', required: true, options: LAYERIZE_MODELS },
      seed: { type: 'INT', required: true, min: 0, max: 0x7FFFFFFF },
    },
  },
  SeedreamLayerizeNode: {
    family: 'layers',
    mustLink: ['image'],
    imageInputs: ['image'],
    valueInputs: { prompt: ['text'] },
    required: ['prompt'],
    widgets: { image_size: { type: 'COMBO', options: SEEDREAM_IMAGE_SIZES } },
  },
  OutpaintImageNode: {
    models: Object.fromEntries(OUTPAINT_MODELS.map(m => [m, 'layers' as const])),
    mustLink: ['image'],
    imageInputs: ['image'],
    valueInputs: { prompt: ['text'] },
    required: ['prompt'],
    widgets: {
      model: { type: 'COMBO', required: true, options: OUTPAINT_MODELS },
      direction: { type: 'COMBO', required: true, options: OUTPAINT_DIRECTIONS },
      aspect_ratio: { type: 'COMBO', required: true, options: OUTPAINT_ASPECT_RATIOS },
      seed: { type: 'INT', required: true, min: 0, max: 0xFFFFFFFF },
    },
  },
  // R3.7: Separate background and foreground, two Replicate calls (the cut-out, the fill). Its
  // picture is a linked picture; its engine and mask growth are widgets as ComfyUI validates them.
  [SPLIT_CLASS]: {
    family: 'layers',
    mustLink: ['image'],
    imageInputs: ['image'],
    widgets: {
      background_fill: { type: 'COMBO', required: true, options: PHOTO_FILLS },
      mask_grow: { type: 'INT', required: true, min: SPLIT_MASK_GROW.min, max: SPLIT_MASK_GROW.max },
    },
  },
  // ── audio-gen (step 3, R3.8): Generate music and Generate speech (and their
  // hidden twins) on Replicate. The prompt and the text take a text wire (R0:
  // the value arrives as typed); every other setting is a widget as ComfyUI
  // validates it (define_schema's options and bounds; a voice may be a cloned
  // one, so it is any text: hosted refuses anything but the 17 presets before
  // the hold, ruling (j)). Their sound goes to an Audio card only (ruling (t),
  // AUDIO_CARD_AUDIO_GEN_RULE); any other reader, or none (they are not output
  // nodes: ComfyUI never runs one nothing reads), leaves them to the engine.
  ...Object.fromEntries((['GenerateMusicNode', 'MusicGenRemoteNode'] as const).map(c => [c, {
    family: 'audio-gen',
    valueInputs: { prompt: ['text'] },
    required: ['prompt'],
    feedsOnly: ['Audio'],
    needsReader: true,
    widgets: {
      ...(c === 'GenerateMusicNode' ? { model: { type: 'COMBO', required: true, options: MUSIC_MODELS } } : {}),
      duration: { type: 'INT', required: true, min: MUSIC_MIN_SECONDS, max: MUSIC_MAX_SECONDS },
      model_version: { type: 'COMBO', required: true, options: MUSIC_MODEL_VERSIONS },
      temperature: { type: 'FLOAT', required: true, min: 0, max: 2 },
      top_p: { type: 'FLOAT', required: true, min: 0, max: 1 },
      seed: { type: 'INT', required: true, min: 0, max: 0xFFFFFFFF },
    },
  } satisfies RunnerNodeRule])),
  ...Object.fromEntries((['GenerateSpeechNode', 'MiniMaxSpeechRemoteNode'] as const).map(c => [c, {
    family: 'audio-gen',
    valueInputs: { text: ['text'] },
    required: ['text'],
    feedsOnly: ['Audio'],
    needsReader: true,
    widgets: {
      ...(c === 'GenerateSpeechNode' ? { model: { type: 'COMBO', required: true, options: SPEECH_MODELS } } : {}),
      voice_id: { type: 'STRING', required: true },
      emotion: { type: 'COMBO', required: true, options: MINIMAX_EMOTIONS },
      speed: { type: 'FLOAT', required: true, min: 0.5, max: 2 },
      volume: { type: 'FLOAT', required: true, min: 0.1, max: 10 },
      pitch: { type: 'INT', required: true, min: -12, max: 12 },
      language_boost: { type: 'COMBO', required: true, options: MINIMAX_LANGUAGES },
    },
  } satisfies RunnerNodeRule])),
  // ── gen-3d (step 3, R3.9): Generate a 3D model (and its hidden twin) and
  // Multi-View → 3D on Replicate. The pictures are linked pictures (the
  // handed-off files; Multi-View's front view is required, the other three
  // optional); Multi-View's prompt takes a text wire (R0: the value arrives
  // as typed); every other setting is a widget as ComfyUI validates it. Their
  // 3D file is handed on as a `glb` value (OUTPUT_KINDS), which only the
  // readers that take one read (the 3D model card, 3D Studio, a Text card).
  ...Object.fromEntries((['Generate3DNode', 'Hunyuan3DRemoteNode'] as const).map(c => [c, {
    family: 'gen-3d',
    mustLink: ['image'],
    imageInputs: ['image'],
    widgets: {
      ...(c === 'Generate3DNode' ? { model: { type: 'COMBO', required: true, options: GENERATE_3D_MODELS } } : {}),
      steps: { type: 'INT', required: true, min: GEN_3D_STEPS.min, max: GEN_3D_STEPS.max },
      guidance_scale: { type: 'FLOAT', required: true, min: GEN_3D_GUIDANCE.min, max: GEN_3D_GUIDANCE.max },
      octree_resolution: { type: 'INT', required: true, min: GEN_3D_OCTREE.min, max: GEN_3D_OCTREE.max },
      remove_background: { type: 'BOOLEAN', required: true },
      texture: { type: 'BOOLEAN', required: true },
      seed: { type: 'INT', required: true, min: 0, max: GEN_3D_SEED_MAX },
    },
  } satisfies RunnerNodeRule])),
  Hunyuan3DMultiViewNode: {
    family: 'gen-3d',
    mustLink: ['front_image'],
    imageInputs: ['front_image', 'back_image', 'left_image', 'right_image'],
    valueInputs: { prompt: ['text'] },
    widgets: {
      engine: { type: 'COMBO', required: true, options: MULTI_VIEW_ENGINES },
      steps: { type: 'INT', required: true, min: GEN_3D_STEPS.min, max: GEN_3D_STEPS.max },
      guidance_scale: { type: 'FLOAT', required: true, min: GEN_3D_GUIDANCE.min, max: GEN_3D_GUIDANCE.max },
      octree_resolution: { type: 'INT', required: true, min: GEN_3D_OCTREE.min, max: GEN_3D_OCTREE.max },
      remove_background: { type: 'BOOLEAN', required: true },
      seed: { type: 'INT', required: true, min: 0, max: GEN_3D_SEED_MAX },
      rodin_quality: { type: 'COMBO', options: RODIN_QUALITIES },
      rodin_tapose: { type: 'BOOLEAN' },
      rodin_poly_count: { type: 'INT', min: 0, max: RODIN_POLY_MAX },
    },
  },
  // ── effects-* (step 3, R2): the still-picture effects (./effects.ts, server/runner/effects/) ──
  // Rows built from the real node schemas (./effectSchemas.generated.ts), one
  // per ported class; each needs its family and `cards`.
  ...effectRows(),
}

/** The Primitive cards (comfy_extras/nodes_primitive.py): each hands on its value (family `cards`). */
export const PRIMITIVE_CLASSES = ['PrimitiveString', 'PrimitiveStringMultiline', 'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveBoolean'] as const

/**
 * Classes that exist in RUNNER_NODE_RULES for one family only: with it off,
 * the runner knows nothing of them (validate.ts leaves a workflow with them
 * whole, as before they had a row). F22 fix round 1.
 */
export const SWITCHED_CLASSES: Readonly<Record<string, RunnerFamily>> = {
  LipSyncNode: 'sync-3',
  Audio: 'sync-3',
  EnhanceVideoNode: 'topaz-video',
  // Moved whole onto one family each, like EnhanceVideoNode (no other model runs them).
  FixFacesNode: 'fix-faces',
  FaceSwap: 'face-swap',
  PersonSwapVideo: 'person-swap-video',
  ...Object.fromEntries(PRIMITIVE_CLASSES.map(c => [c, 'cards' as const])),
  Text: 'cards',
  Moodboard: 'cards',
  Model3D: 'cards',
  Scene3DStudio: 'cards',
  TextOnPath: 'cards',
  TextMask: 'cards',
  EmptyImage: 'cards',
  GetImageSize: 'cards',
  ImageToMask: 'cards',
  SaveImage: 'cards',
  PreviewImage: 'cards',
  SmartLayout: 'cards',
  // R2: each ported effect, by its family.
  ...effectSwitchedClasses(),
  ShaderEffect: 'shader-bake',
  // R3.3: the LLM text nodes.
  ChatLLMNode: 'llm-text',
  ImprovePromptNode: 'llm-text',
  SummarizeTextNode: 'llm-text',
  TranslateTextNode: 'llm-text',
  RewriteToneNode: 'llm-text',
  BrainstormIdeasNode: 'llm-text',
  ReasonStepByStepNode: 'llm-text',
  // R3.4: describe, read and find.
  DescribeImageNode: 'describe',
  DescribeImageRemoteNode: 'describe',
  DescribeVideoNode: 'describe',
  ExtractTextNode: 'describe',
  FindObjectsNode: 'describe',
  // R3.5: upscale, enhance, restore and remove background.
  ...Object.fromEntries(REPAIR_CLASSES.map(c => [c, 'image-repair' as const])),
  // R3.6: layers from one call, and outpaint.
  ...Object.fromEntries(LAYERS_CLASSES.map(c => [c, 'layers' as const])),
  // R3.7: Separate background and foreground.
  [SPLIT_CLASS]: 'layers',
  // R3.8: music and speech.
  ...Object.fromEntries(AUDIO_GEN_CLASSES.map(c => [c, 'audio-gen' as const])),
  // R3.9: 3D models.
  ...Object.fromEntries(GEN_3D_CLASSES.map(c => [c, 'gen-3d' as const])),
}

/**
 * The Audio card showing a music or speech node's sound (R3.8, ruling (t)):
 * with `audio-gen` on and `source` wired from one of them, the card hands
 * that file on and shows it (the provider's own file, not Python's FLAC copy)
 * instead of its own file (the `sync-3` row, RUNNER_NODE_RULES.Audio). Its
 * `export` must be off (the runner saves no copy); it may feed Lip-sync on
 * sync-3 only (any other reader leaves it to the engine) or nothing (it is an
 * output node). A card wired from anything else keeps its own row.
 */
export const AUDIO_CARD_AUDIO_GEN_RULE: RunnerNodeRule = {
  family: 'audio-gen',
  local: 'source',
  mustNotLink: ['audio'],
  linkSources: { source: AUDIO_GEN_CLASSES.map(c => [c, 0] as const) },
  feedsOnly: ['LipSyncNode'],
  offWidgets: ['export'],
}

/** The row a node is judged by: RUNNER_NODE_RULES', but for an Audio card showing a music or speech node's sound (R3.8). */
export function runnerRuleFor(classType: string, inputs: Record<string, unknown>, families: ReadonlySet<RunnerFamily>): RunnerNodeRule | undefined {
  if (classType === 'Audio' && isLink(inputs.source) && familyOn('audio-gen', families)) return AUDIO_CARD_AUDIO_GEN_RULE
  return Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, classType) ? RUNNER_NODE_RULES[classType] : undefined
}

/**
 * The classes that make a provider call (and so are charged): the two
 * generators, plus every class a family row adds that is not computed by
 * the runner itself. A workflow needs at least one of them, or one local
 * render (LOCAL_RENDER_TYPES), to go to the runner.
 */
export const PROVIDER_TYPES: ReadonlySet<string> = new Set([
  'GenerateImageNode', 'GenerateVideoNode', 'FilmShotNode',
  ...Object.entries(RUNNER_NODE_RULES).filter(([, r]) => !r.local).map(([k]) => k),
])

/**
 * Classes the runner renders itself (free, no provider): the Frame, and with
 * `cards` Save image and Preview image (R1.5). They count as work, and a
 * finished one earns its stage the render credit, as on the Python path.
 */
export const LOCAL_RENDER_TYPES: ReadonlySet<string> = new Set(
  Object.entries(RUNNER_NODE_RULES).filter(([, r]) => r.local === 'render').map(([k]) => k),
)

/**
 * The local renders the ComfyUI path's partial charge counts (server/utils
 * meterGraphRun.ts chargePlanOf): the Frame, as before R1.5. The cards'
 * renders are the runner's; a failed ComfyUI run is charged as it was.
 */
export const FRAME_RENDER_TYPES: ReadonlySet<string> = new Set(
  [...LOCAL_RENDER_TYPES].filter(c => !Object.prototype.hasOwnProperty.call(SWITCHED_CLASSES, c)),
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
  nodeId?: string,
  prompt?: ApiPrompt,
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
  const opened = !!rule.open && families.has(rule.open.family)
  if (!upgraded && !opened && (!family || !familyOn(family, families))) return false
  if (need.some(name => !isLink(inputs[name]))) return false
  if ((rule.mustNotLink ?? []).some(name => isLink(inputs[name]) && !rule.valueInputs?.[name])) return false
  if ((rule.offWidgets ?? []).some(name => isLink(inputs[name]) || pyTruthy(inputs[name]))) return false
  for (const [name, spec] of Object.entries(rule.widgets ?? {})) {
    if (!widgetValid(inputs, name, spec)) return false
  }
  if (rule.inputCheck) {
    const ctx: InputCheckContext = { classType, nodeId, hosted: !!opts.hosted, prompt }
    const names: readonly InputCheckName[] = typeof rule.inputCheck === 'string' ? [rule.inputCheck] : rule.inputCheck
    if (names.some(name => !INPUT_CHECKS[name]!(inputs, ctx))) return false
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

/**
 * Whether a wire carries a picture: a picture slot (PICTURE_OUTPUTS, whose
 * classes exist for the runner only with `cards` on; else output 0 of an
 * image class), followed back through Gates.
 */
function carriesImage(prompt: ApiPrompt, link: [string, number], families: ReadonlySet<RunnerFamily>, depth = 0): boolean {
  const from = prompt[link[0]]
  if (!from || depth > 64) return false
  if (from.class_type === 'ComfyGateNode') {
    const d = from.inputs?.data_in
    return link[1] === 0 && isLink(d) && carriesImage(prompt, d, families, depth + 1)
  }
  // The Shader effect's picture (R2.10), only while its family is on.
  if (from.class_type === 'ShaderEffect') return link[1] === 0 && familyOn('shader-bake', families)
  if (Object.prototype.hasOwnProperty.call(PICTURE_OUTPUTS, from.class_type)) {
    if (Object.prototype.hasOwnProperty.call(EFFECT_FAMILY_OF, from.class_type) && !effectFamilyOn(from.class_type, families)) return false
    return families.has('cards') && PICTURE_OUTPUTS[from.class_type]!.includes(link[1])
  }
  // A paid family's picture (R3.5's image-repair), only while that family is on
  // (read before IMAGE_OUTPUT_CLASSES, which doesn't list them).
  if (Object.prototype.hasOwnProperty.call(PAID_PICTURE_FAMILY, from.class_type)) {
    const slots = Object.prototype.hasOwnProperty.call(PAID_PICTURE_SLOTS, from.class_type) ? PAID_PICTURE_SLOTS[from.class_type]! : [0]
    return slots.includes(link[1]) && familyOn(PAID_PICTURE_FAMILY[from.class_type]!, families)
  }
  return link[1] === 0 && IMAGE_OUTPUT_CLASSES.has(from.class_type)
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
function graphRuleAllows(prompt: ApiPrompt, id: string, rule: RunnerNodeRule, families: ReadonlySet<RunnerFamily>): boolean {
  const notLinked = rule.outputsNotLinked ?? []
  const slotReaders = rule.outputReaders
  const opened = !!rule.open && families.has(rule.open.family)
  const feedsOnly = opened && rule.open!.lifts.includes('feedsOnly') ? undefined : rule.feedsOnly
  const listReaders = rule.listReaders
  if (notLinked.length || slotReaders || feedsOnly || listReaders || rule.needsReader) {
    let readers = 0
    for (const node of Object.values(prompt)) {
      for (const l of linksOf(node)) {
        if (l.from !== id) continue
        readers++
        if (notLinked.includes(l.slot)) return false
        const only = slotReaders && Object.prototype.hasOwnProperty.call(slotReaders, l.slot) ? slotReaders[l.slot] : undefined
        if (only && !only.some(([cls, input]) => cls === node.class_type && input === l.input)) return false
        if (feedsOnly && !feedsOnly.includes(node.class_type)) return false
        if (listReaders && !listReaders.includes(node.class_type)) return false
      }
    }
    if (rule.needsReader && !readers) return false
  }
  const inputs = prompt[id]?.inputs ?? {}
  for (const name of rule.imageInputs ?? []) {
    const v = inputs[name]
    if (isLink(v) && !carriesImage(prompt, v, families)) return false
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
 * The OUTPUT_KINDS rows only `cards` declares (R1.3): the bake cards' masks
 * and LoadImage's MASK; Get image size's numbers and Image to mask's mask (R1.4). With `cards` off those slots carry files, as before
 * R1.3, so what the runner takes (and the needs-the-engine list) is unchanged.
 */
const CARDS_OUTPUT_KIND_CLASSES: readonly string[] = ['TextOnPath', 'TextMask', 'LoadImage', 'GetImageSize', 'ImageToMask']
const OUTPUT_KINDS_CARDS_OFF: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = Object.fromEntries(
  Object.entries(OUTPUT_KINDS).filter(([cls]) => !CARDS_OUTPUT_KIND_CLASSES.includes(cls)),
)

type OutputKinds = Readonly<Record<string, Readonly<Record<number, ValueKind>>>>
const effectKindsCache = new Map<string, OutputKinds>()

/**
 * The OUTPUT_KINDS rows a paid family declares (R3): each applies only while
 * its family is on. With it off, that class's slots carry files, as before R3.
 */
const PAID_OUTPUT_KIND_FAMILY: Readonly<Record<string, RunnerFamily>> = {
  ChatLLMNode: 'llm-text',
  ImprovePromptNode: 'llm-text',
  SummarizeTextNode: 'llm-text',
  TranslateTextNode: 'llm-text',
  RewriteToneNode: 'llm-text',
  BrainstormIdeasNode: 'llm-text',
  ReasonStepByStepNode: 'llm-text',
  DescribeImageNode: 'describe',
  DescribeImageRemoteNode: 'describe',
  DescribeVideoNode: 'describe',
  ExtractTextNode: 'describe',
  FindObjectsNode: 'describe',
  ...Object.fromEntries(LAYERS_JSON_CLASSES.map(c => [c, 'layers' as const])),
  ...Object.fromEntries(GEN_3D_CLASSES.map(c => [c, 'gen-3d' as const])),
}
const withoutPaidRows = (kinds: OutputKinds): OutputKinds =>
  Object.fromEntries(Object.entries(kinds).filter(([cls]) => !Object.prototype.hasOwnProperty.call(PAID_OUTPUT_KIND_FAMILY, cls)))
const OUTPUT_KINDS_BASE = withoutPaidRows(OUTPUT_KINDS)
const OUTPUT_KINDS_CARDS_OFF_BASE = withoutPaidRows(OUTPUT_KINDS_CARDS_OFF)

/**
 * What each class's output slots carry with these families on: each class's
 * declared kinds apply only while the family that declares them is on (the
 * cards' rows with `cards`; an effect's mask outputs with its own family and
 * `cards`, R2; a paid node's with its own family, R3). With none of them on,
 * exactly the table before R1.3.
 */
export function outputKindsFor(families: ReadonlySet<RunnerFamily>): OutputKinds {
  const base = families.has('cards') ? OUTPUT_KINDS_BASE : OUTPUT_KINDS_CARDS_OFF_BASE
  const on = Object.keys(EFFECT_OUTPUT_KINDS).filter(cls => effectFamilyOn(cls, families))
  const paid = Object.keys(PAID_OUTPUT_KIND_FAMILY).filter(cls => familyOn(PAID_OUTPUT_KIND_FAMILY[cls]!, families))
  if (!on.length && !paid.length) return base
  const key = `${on.join(',')}|${paid.join(',')}`
  let kinds = effectKindsCache.get(key)
  if (!kinds) {
    kinds = {
      ...base,
      ...Object.fromEntries(paid.map(cls => [cls, OUTPUT_KINDS[cls]!])),
      ...Object.fromEntries(on.map(cls => [cls, EFFECT_OUTPUT_KINDS[cls]!])),
    }
    effectKindsCache.set(key, kinds)
  }
  return kinds
}

/**
 * The inputs of a class that take a value wire: its rule row's, else the
 * base table's (the Gate). `families`: a class switched by a family that is
 * off takes none (as before it had a row).
 */
export function valueInputsOf(classType: string, families?: ReadonlySet<RunnerFamily>): Readonly<Record<string, readonly ValueKind[]>> {
  // With `families` given, a class that exists for one family only takes no value while it is off (rule 15, R3.8 fix round 1).
  const only = families && Object.prototype.hasOwnProperty.call(SWITCHED_CLASSES, classType) ? SWITCHED_CLASSES[classType] : undefined
  if (only && !familyOn(only, families!)) return {}
  const rule = Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, classType) ? RUNNER_NODE_RULES[classType] : undefined
  return rule?.valueInputs ?? (Object.prototype.hasOwnProperty.call(BASE_VALUE_INPUTS, classType) ? BASE_VALUE_INPUTS[classType]! : {})
}

/**
 * Whether every wire into this node carries what the input takes: a value
 * only into an input listed for that kind; into a listed value input,
 * nothing but a kind it lists (the Gate's lists files too). File wires into
 * unlisted inputs are unchanged.
 */
export function valueWiresAllowed(
  prompt: ApiPrompt, id: string,
  kinds: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = OUTPUT_KINDS,
  families?: ReadonlySet<RunnerFamily>,
): boolean {
  const node = prompt[id]
  if (!node) return false
  const takes = valueInputsOf(node.class_type, families)
  for (const l of linksOf(node)) {
    const kind = outputKind(prompt, [l.from, l.slot], kinds)
    const allowed = Object.prototype.hasOwnProperty.call(takes, l.input) ? takes[l.input] : undefined
    if (kind === 'files') {
      if (allowed && !allowed.includes('files')) return false
      continue
    }
    if (!allowed?.includes(kind)) return false
  }
  return true
}

/**
 * A Film a shot Shot Director drives (dispatch.ts buildFilmShotPatch): its
 * `model_options` are typed (not wired) JSON with `__shot_directed: true`.
 * Any other Film a shot (presets, overrides) stays on ComfyUI unless
 * `film-shot` is on (R3.11, presetShotTaken).
 */
export function isShotDirected(inputs: Record<string, unknown>): boolean {
  const raw = inputs.model_options
  if (typeof raw !== 'string' || isLink(raw)) return false
  let v: unknown
  try { v = JSON.parse(raw) }
  catch { return false }
  return !!v && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, unknown>).__shot_directed === true
}

/**
 * The Film a shot models the runner films (Task 4, characters stage 3), as on
 * Generate a video: Seedance 2.0 and Veo 3.1 (Fast) with no family, Kling 3
 * with the replicate-video family (the same switch as Generate a video's).
 */
const FILM_SHOT_RUNNER_MODELS: Readonly<Record<string, RunnerFamily | null>> = {
  'seedance-2.0': null, 'veo-3.1': null, 'veo-3.1-fast': null, 'kling-v3': 'replicate-video',
}

/**
 * Film a shot's `model` options (comfy_api_nodes/video_models.py MODELS): the
 * video models the runner films for Generate a video with no family, those
 * of `replicate-video`, and VEED Fabric (a lip-sync model Film a shot refuses).
 */
export const FILM_SHOT_MODEL_IDS: readonly string[] = [...RUNNER_VIDEO_MODEL_IDS, ...RUNNER_REPLICATE_VIDEO_MODEL_IDS, 'fabric-1.0']
const FILM_SHOT_MODELS: ReadonlySet<string> = new Set(FILM_SHOT_MODEL_IDS)

/** The Film a shot models with no text-to-video mode (video_models.py `modes`): Python refuses them without a picture. */
export const FILM_SHOT_IMAGE_ONLY_MODELS: readonly string[] = ['wan-2.5-i2v-fast', 'fabric-1.0']

/** The Film a shot model Python refuses outright: a lip-sync model (FilmShotNode.execute). */
export const FILM_SHOT_LIP_SYNC_MODEL = 'fabric-1.0'

/**
 * A `__shot_directed` Python reads as shot-directed (`bool(advanced.pop(...))`:
 * 1, "false", [0] …) that isn't exactly `true`, which isShotDirected asks for.
 * Python sends the words alone; the runner takes neither path, so the shot
 * stays with the engine (R3.11 fix round 1). Shot Director writes `true`.
 */
function shotDirectedOtherwise(inputs: Record<string, unknown>): boolean {
  const raw = inputs.model_options
  // Text Python's json reads and JSON.parse refuses (NaN, Infinity) naming the marker: left to the engine.
  if (typeof raw === 'string' && raw.includes('__shot_directed')) {
    try { JSON.parse(raw) }
    catch { return true }
  }
  const o = modelOptions(raw)
  return Object.prototype.hasOwnProperty.call(o, '__shot_directed') && o.__shot_directed !== true && pyTruthy(o.__shot_directed)
}

/**
 * Whether the runner takes a Film a shot on the preset path (R3.11): `film-shot`
 * on; the words, options, model and sound not wired; the preset and each
 * override one of Python's options (ComfyUI's own validation refuses any
 * other); and a model the runner films for Generate a video under that
 * model's own family. Fabric, and a picture-only model with no picture, are
 * taken too, and refused before the hold (requestRules.ts), as Python refuses
 * them.
 */
function presetShotTaken(inputs: Record<string, unknown>, families: ReadonlySet<RunnerFamily>): boolean {
  if (!familyOn('film-shot', families)) return false
  if (['prompt', 'model_options', 'model', 'audio'].some(k => isLink(inputs[k]))) return false
  if (shotDirectedOtherwise(inputs)) return false
  if (!widgetValid(inputs, 'preset', { type: 'COMBO', required: true, options: SHOT_PRESET_IDS })) return false
  for (const o of SHOT_OVERRIDE_WIDGETS) {
    if (!widgetValid(inputs, o.widget, { type: 'COMBO', options: o.options })) return false
  }
  // Python reads the model as given (no legacy remap): only its own ids.
  const model = typeof inputs.model === 'string' ? inputs.model : ''
  if (!FILM_SHOT_MODELS.has(model)) return false
  if (model === FILM_SHOT_LIP_SYNC_MODEL || VIDEO_IDS.has(model)) return true
  // Generate a video's row for this model: its family (replicate-video). A picture it
  // needs (Wan 2.5 I2V Fast) is not asked for here: Film a shot refuses its absence plainly.
  const m = RUNNER_NODE_RULES.GenerateVideoNode!.models![model]
  const family = typeof m === 'string' ? m : m?.family
  return !!family && familyOn(family, families)
}

/**
 * Whether the runner takes this Film a shot: shot-directed (no sound or words
 * wired in, on one of its models), or on the preset path (presetShotTaken).
 */
function filmShotTaken(inputs: Record<string, unknown>, families: ReadonlySet<RunnerFamily>): boolean {
  if (!isShotDirected(inputs)) return presetShotTaken(inputs, families)
  if (isLink(inputs.audio) || isLink(inputs.prompt)) return false
  const model = resolveVideoModelId(inputs.model)
  if (!Object.prototype.hasOwnProperty.call(FILM_SHOT_RUNNER_MODELS, model)) return false
  const family = FILM_SHOT_RUNNER_MODELS[model]
  return !family || familyOn(family, families)
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
  const rule = families.size ? runnerRuleFor(n.class_type, inputs, families) : undefined
  const byRule = !!rule && nodeRuleAllows(n.class_type, rule, inputs, families, opts, id, prompt) && graphRuleAllows(prompt, id, rule, families)
  if (n.class_type === 'FilmShotNode') {
    if (!filmShotTaken(inputs, families)) return false
  }
  else if (!RUNNER_NODE_TYPES.has(n.class_type) && !byRule) return false
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
  if (!valueWiresAllowed(prompt, id, outputKindsFor(families), families)) return false
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
