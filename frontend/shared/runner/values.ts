/**
 * What each runner class's output slots carry (R0, step 3 spec), read by the
 * browser (routing, the needs-the-engine names) and the server (the runner).
 * A class not listed carries files on every slot, as before step 3.
 * Keep this file free of imports but ./graph and ./svgImage (constants only).
 */
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from './graph'
import { SVG_IMAGE_MODEL_IDS } from './svgImage'

/**
 * R5.2: 'frames' (an IMAGE batch from a video, one kept lossless file) and
 * 'video' (a video a node assembled, encoded only when saved or shown). Only
 * an input whose rule lists them in `valueInputs` reads them; wired anywhere
 * else they leave the workflow to the engine (valueWiresAllowed).
 */
export type ValueKind = 'files' | 'mask' | 'text' | 'number' | 'boolean' | 'json' | 'glb' | 'frames' | 'video'
  /** R11.4: an SVG a Recraft SVG model made, saved as the user's file and handed on by its address (./svgImage.ts). */
  | 'svg'

/** Every kind a wire can carry that is not files (a Gate hands each on; one stopped on frames or a video shows nothing to pick). */
export const VALUE_KINDS_ALL: readonly ValueKind[] = ['mask', 'text', 'number', 'boolean', 'json', 'glb', 'frames', 'video', 'svg']

/** Output slots that carry something other than files, by class. Rows are added by the cards (R0.4, R1). */
export const OUTPUT_KINDS: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = {
  PrimitiveString: { 0: 'text' },
  PrimitiveStringMultiline: { 0: 'text' },
  PrimitiveInt: { 0: 'number' },
  PrimitiveFloat: { 0: 'number' },
  PrimitiveBoolean: { 0: 'boolean' },
  Text: { 0: 'text' },
  Moodboard: { 0: 'text' },
  Model3D: { 0: 'text' },
  // R1.3: the bake-replay cards' masks, and LoadImage's MASK (a value only
  // when the LoadImage runs as a card; fed to a Frame the old way it is still
  // the file, which the Frame reads as before).
  TextOnPath: { 1: 'mask' },
  TextMask: { 1: 'mask' },
  LoadImage: { 1: 'mask' },
  // R1.4: the picture utilities' values.
  GetImageSize: { 0: 'number', 1: 'number', 2: 'number' },
  ImageToMask: { 0: 'mask' },
  // R3.3: the LLM text nodes' STRING (a value only while `llm-text` is on:
  // eligibility.ts outputKindsFor drops these rows with it off).
  ChatLLMNode: { 0: 'text' },
  ImprovePromptNode: { 0: 'text' },
  SummarizeTextNode: { 0: 'text' },
  TranslateTextNode: { 0: 'text' },
  RewriteToneNode: { 0: 'text' },
  BrainstormIdeasNode: { 0: 'text' },
  ReasonStepByStepNode: { 0: 'text' },
  // R3.4: describe, read and find (a value only while `describe` is on);
  // Find objects hands on Python's JSON text.
  DescribeImageNode: { 0: 'text' },
  DescribeImageRemoteNode: { 0: 'text' },
  DescribeVideoNode: { 0: 'text' },
  ExtractTextNode: { 0: 'text' },
  FindObjectsNode: { 0: 'json' },
  // R3.6: the two layerizers hand on their layers' JSON text on slot 1 (a
  // value only while `layers` is on); slot 0 is their picture.
  LayerizeGraphicNode: { 1: 'json' },
  SeedreamLayerizeNode: { 1: 'json' },
  // R3.9: the 3D nodes hand on their 3D file as Sailor's own address (a value
  // only while `gen-3d` is on; spec ruling 1).
  Generate3DNode: { 0: 'glb' },
  Hunyuan3DRemoteNode: { 0: 'glb' },
  Hunyuan3DMultiViewNode: { 0: 'glb' },
  // R3.10: Transcribe audio (and its twin) hands on its transcript, Identify
  // speakers Python's JSON text (values only while `sound-in` is on).
  TranscribeAudioNode: { 0: 'text' },
  WhisperRemoteNode: { 0: 'text' },
  IdentifySpeakersNode: { 0: 'json' },
  // R7.7: Whisper transcribe's caption track, SRT and text (values only while `whisper-captions` is
  // on: eligibility.ts outputKindsFor drops this row with it off).
  WhisperTranscribe: { 0: 'text', 1: 'text', 2: 'text' },
  // R5.4: Get video components' frame batch and rate (its sound, slot 1, is a
  // file), and Create video's made video (values only while `media-video` is
  // on: eligibility.ts outputKindsFor drops these rows with it off).
  GetVideoComponents: { 0: 'frames', 2: 'number' },
  CreateVideo: { 0: 'video' },
  // R5.5: Load video frames' batch and its rate (fps / stride), also only while `media-video` is on.
  LoadVideoFrames: { 0: 'frames', 1: 'number' },
  // R11.4: Generate an image carries files on every slot, but an SVG on slot 0
  // when its model is a Recraft SVG one (KIND_BY_MODEL), only while
  // `recraft-svg` is on (eligibility.ts outputKindsFor drops this row with it off).
  GenerateImageNode: {},
}

/**
 * R11.4: a slot whose kind depends on the node's `model`: an SVG model of
 * Generate an image hands on an SVG on slot 0. Applied only where `kinds` has
 * a row for the class (its family on: eligibility.ts outputKindsFor).
 */
export const KIND_BY_MODEL: Readonly<Record<string, { slot: number; models: readonly string[]; kind: ValueKind }>> = {
  GenerateImageNode: { slot: 0, models: SVG_IMAGE_MODEL_IDS, kind: 'svg' },
}

/**
 * R7 ruling (f): a picture node that works on every frame of what comes in
 * (Background remove) hands on, on this slot, what its input brings: a
 * picture for a picture, a frame batch for a clip. Applied only where `kinds`
 * has a row for the class (its family on: eligibility.ts outputKindsFor).
 */
export const KIND_FOLLOWS_INPUT: Readonly<Record<string, { slot: number; input: string }>> = {
  BackgroundRemove: { slot: 0, input: 'frames' },
  // R7.2: Upscale (2×), the same (a picture 2× each side, or a clip's frames 2× each side).
  UpscaleImage: { slot: 0, input: 'frames' },
  // R7.3: Object removal, the same (the picture with the masked part filled, or a clip's frames).
  ObjectRemove: { slot: 0, input: 'frames' },
  // R7.5: Subject mask's cutout (slot 1; slot 0 is its mask), the same.
  SubjectMask: { slot: 1, input: 'frames' },
  // R11.7: Slow motion (AI): a clip's slowed-down batch, or a still picture handed on as it came.
  FrameInterpolateAI: { slot: 0, input: 'frames' },
}

/** What a wire carries: the source's declared kind for that slot (through Gates), files by default. */
export function outputKind(
  prompt: ApiPrompt, link: ApiLink,
  kinds: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = OUTPUT_KINDS,
  depth = 0,
): ValueKind {
  const node = prompt[link[0]]
  if (!node || depth > 64) return 'files'
  if (node.class_type === GATE_CLASS) {
    const d = node.inputs?.data_in
    return isLink(d) ? outputKind(prompt, d, kinds, depth + 1) : 'files'
  }
  const row = Object.prototype.hasOwnProperty.call(kinds, node.class_type) ? kinds[node.class_type] : undefined
  const follows = row && Object.prototype.hasOwnProperty.call(KIND_FOLLOWS_INPUT, node.class_type) ? KIND_FOLLOWS_INPUT[node.class_type]! : undefined
  if (follows && follows.slot === link[1]) {
    const d = node.inputs?.[follows.input]
    return isLink(d) && outputKind(prompt, d, kinds, depth + 1) === 'frames' ? 'frames' : 'files'
  }
  const byModel = row && Object.prototype.hasOwnProperty.call(KIND_BY_MODEL, node.class_type) ? KIND_BY_MODEL[node.class_type]! : undefined
  if (byModel && byModel.slot === link[1]) {
    const model = node.inputs?.model
    if (typeof model === 'string' && byModel.models.includes(model)) return byModel.kind
  }
  return row && Object.prototype.hasOwnProperty.call(row, link[1]) ? row[link[1]]! : 'files'
}

/**
 * Value inputs of the runner's own node types that have no rule row (the
 * Gate): a Gate hands on whatever reaches it, files as before or a value.
 */
export const BASE_VALUE_INPUTS: Readonly<Record<string, Readonly<Record<string, readonly ValueKind[]>>>> = {
  [GATE_CLASS]: { data_in: ['files', ...VALUE_KINDS_ALL] },
}
