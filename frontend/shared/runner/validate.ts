/**
 * ComfyUI's whole-prompt rule (execution.py `validate_prompt`), for the part
 * of validation the runner ports: an output node whose own subgraph fails
 * validation is dropped ("Output will be ignored"), every other output is
 * kept, and only what the kept outputs need runs. With no output left the
 * prompt is refused ("Prompt outputs failed validation"); with no output
 * node at all, too ("Prompt has no outputs": R3.8 fix round 1, runner-wide).
 *
 * So a blank project's empty Frame (no layer 1) no longer blocks the rest of
 * the canvas: ComfyUI drops it and runs the rest (history c7690393: only the
 * Image card ran), and so does the runner.
 *
 * The browser (shouldUseRunner, nodesNeedingEngine) and the server (startRun)
 * share this file, so they agree on what runs.
 *
 * Kept deliberately narrow:
 *   - only what an output node reads runs (R3.8 fix round 1, runner-wide:
 *     ComfyUI never executes a node no output needs, so a generator nothing
 *     reads is neither run nor charged); a prompt whose outputs all validate
 *     and read everything is left exactly as it is;
 *   - it prunes only a prompt whose every class the runner knows: with any
 *     other class present, which outputs ComfyUI has is not knowable here,
 *     so the prompt is left whole (and goes to ComfyUI, as before);
 *   - "validation" is what the runner ports: required inputs and widget
 *     values (nodeValidationErrors). A wire to a node outside the prompt is
 *     left to the eligibility rule, as before.
 */
import {
  RUNNER_NODE_RULES, RUNNER_NODE_TYPES, SWITCHED_CLASSES, isRunnerEligible, nodeValidationErrors,
  type ComfyValidationError, type RunnerEligibilityOptions,
} from './eligibility'
import { NO_FAMILIES, familyOn, type RunnerFamily } from './families'
import { EFFECT_OUTPUT_NODES } from './effects'
import { MEDIA_EFFECT_OUTPUT_NODES } from './mediaEffects'
import { linksOf, type ApiPrompt } from './graph'

/**
 * The runner-known classes that are ComfyUI output nodes (OUTPUT_NODE /
 * is_output_node), read from the real node classes (2026-09-24). The runner
 * classes not listed are not output nodes: GenerateImageNode,
 * GenerateVideoNode, ComfyGateNode, EditImageNode, DevelopImageNode,
 * GenerateFromReferencesNode, LoadImage, LipSyncNode. The Audio card
 * (nodes_audio.py `Audio`, is_output_node=True) joined with sync-3 (F22);
 * the Text and 3D model cards with `cards` (R1.1; the Moodboard is not one);
 * Save image and Preview image with `cards` (R1.5); Smart Layout with
 * `cards` (R1.6); every ported effect that is one (R2: all but Painter, as
 * define_schema's is_output_node says, ./effects.ts EFFECT_OUTPUT_NODES);
 * the Shader effect with `shader-bake` (R2.10).
 */
export const RUNNER_OUTPUT_CLASSES: ReadonlySet<string> = new Set([
  'Image', 'Video', 'Compositor', 'Audio', 'Text', 'Model3D', 'SaveImage', 'PreviewImage', 'SmartLayout',
  'RelightNode', 'BlendSceneNode', 'RemoveObjectNode', 'TextEditNode', 'RecolorObjectNode',
  'SwapBackgroundNode', 'SwapProductNode', 'PersonSwap', 'RotateCameraNode', 'ProductShotNode', 'RestyleFromImageNode', 'FixFacesNode', 'FaceSwap',
  'PersonSwapVideo',
  ...EFFECT_OUTPUT_NODES,
  'ShaderEffect',
  // R3.3: the LLM text nodes are ComfyUI output nodes (is_output_node=True).
  'ChatLLMNode', 'ImprovePromptNode', 'SummarizeTextNode', 'TranslateTextNode',
  'RewriteToneNode', 'BrainstormIdeasNode', 'ReasonStepByStepNode',
  // R3.4: describe, read and find are output nodes too (the twin as well).
  'DescribeImageNode', 'DescribeImageRemoteNode', 'DescribeVideoNode', 'ExtractTextNode', 'FindObjectsNode',
  // R3.5: Remove background and Restore an old photo are output nodes (their
  // hidden twins, Upscale and Enhance detail are not: define_schema says so).
  'RemoveBackgroundNode', 'RestorePhotoNode',
  // R3.6: the two layerizers are output nodes (Expand / outpaint is not).
  'LayerizeGraphicNode', 'SeedreamLayerizeNode',
  // R3.7: Separate background and foreground is one too (is_output_node=True).
  'SplitPhotoLayersNode',
  // R3.9: the three 3D nodes are output nodes (is_output_node=True; the twin too).
  'Generate3DNode', 'Hunyuan3DRemoteNode', 'Hunyuan3DMultiViewNode',
  // R3.14: Restyle an Image · Style LoRA is one too (is_output_node=True; Flux Dev + LoRA(s), R3.13, are not).
  'RestyleWithLoRANode',
  // R3.15: Lens · 3D Reframe and Pose Mannequin are output nodes (is_output_node=True).
  'LensReframe', 'PoseMannequin',
  // R3.16: Turntable is one too (is_output_node=True).
  'TurntableNode',
  // R3.10: Transcribe audio (and its twin Whisper) and Identify speakers are output nodes
  // (is_output_node=True; Clone a singing voice and Sync lips to audio, and its twin, are not).
  'TranscribeAudioNode', 'WhisperRemoteNode', 'IdentifySpeakersNode',
  // R5.3: Save audio (FLAC and MP3) and Preview audio are output nodes (is_output_node=True;
  // Load audio and Record audio are not). The Audio card is listed above.
  'SaveAudio', 'SaveAudioMP3', 'PreviewAudio',
  // R6.9: Save audio (Opus), switched with `sound-effects`.
  'SaveAudioOpus',
  // R5.4: Save video is an output node (is_output_node=True; Load video, Get video
  // components and Create video are not). The Video card is listed above.
  'SaveVideo',
  // Step 4, C4: Preview video is one too (is_output_node=True).
  'PreviewVideo',
  // R5.5: Save video frames is an output node (is_output_node=True); Load video frames is not.
  'SaveVideoFrames',
  // R6: every ported video effect that is one (all but Slow motion, Silence cut and Text clip, as
  // define_schema's is_output_node says; ./mediaEffects.ts MEDIA_EFFECT_OUTPUT_NODES).
  ...MEDIA_EFFECT_OUTPUT_NODES,
  // R7.1: Background remove is an output node (is_output_node=True).
  'BackgroundRemove',
  // R7.2: Upscale (2×) is an output node (is_output_node=True).
  'UpscaleImage',
  // R7.3: Object removal is an output node (is_output_node=True).
  'ObjectRemove',
  // R7.4: Mask by text and Mask extractor are output nodes (is_output_node=True).
  'MaskByText', 'MaskExtractor',
  // R7.9: Lens · Depth of field is an output node (is_output_node=True).
  'LensBlur',
])

/** ComfyUI's node_errors entry for a node that failed validation. */
export interface ComfyNodeError {
  errors: ComfyValidationError[]
  dependent_outputs: string[]
  class_type: string
}

export interface PrunedPrompt {
  /** What runs: the kept outputs and what they need (the prompt itself when nothing was dropped). */
  prompt: ApiPrompt
  /** Output nodes dropped because they (or something they read) fail validation. */
  dropped: string[]
  /** ComfyUI's node_errors: the nodes with errors of their own, and the outputs they took down. */
  nodeErrors: Record<string, ComfyNodeError>
  /** Every output failed: ComfyUI refuses the prompt ("Prompt outputs failed validation"), or there is none (`noOutputs`). */
  failed: boolean
  /** No output node at all: ComfyUI refuses the prompt ("Prompt has no outputs"). */
  noOutputs?: true
  /** Nodes no kept output reads (R3.8 fix round 1): left out, as ComfyUI never runs them. */
  unread: string[]
}

/** Whether pruning left anything out (a failed output, or a node no output reads): the rest runs even with no call to make. */
export function prunedAny(r: PrunedPrompt): boolean {
  return r.dropped.length > 0 || r.unread.length > 0
}

/**
 * Classes known under more families as well as their SWITCHED_CLASSES one:
 * the Audio card showing a music or speech node's sound (R3.8, audio-gen),
 * the Audio card in full (R5.3, media-sound), and Lip-sync a character's
 * Fabric and Kling engines (R11.3, sound-in).
 */
const ALSO_SWITCHED: Readonly<Record<string, readonly RunnerFamily[]>> = {
  Audio: ['audio-gen', 'media-sound', 'sound-in'],
  // R11.3: Lip-sync a character's Fabric and Kling engines, while `sound-in` is on.
  LipSyncNode: ['sound-in'],
}

/**
 * A class the port knows: a runner type, or a family row's class. A class
 * that exists for one family only (SWITCHED_CLASSES: Lip-sync a character and
 * the Audio card, sync-3, F22 fix round 1) is known only while that family is
 * on, so with it off such a workflow is left whole, exactly as before.
 */
const knows = (classType: string, families: ReadonlySet<RunnerFamily>) => {
  if (RUNNER_NODE_TYPES.has(classType)) return true
  if (!Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, classType)) return false
  const only = Object.prototype.hasOwnProperty.call(SWITCHED_CLASSES, classType) ? SWITCHED_CLASSES[classType] : undefined
  const also = Object.prototype.hasOwnProperty.call(ALSO_SWITCHED, classType) ? ALSO_SWITCHED[classType] : undefined
  return !only || familyOn(only, families) || (!!also && also.some(f => familyOn(f, families)))
}

/** The prompt as ComfyUI's validate_prompt leaves it to run. `families`: the runner families on. */
export function pruneInvalidOutputs(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily> = NO_FAMILIES): PrunedPrompt {
  const whole: PrunedPrompt = { prompt, dropped: [], nodeErrors: {}, failed: false, unread: [] }
  const ids = Object.keys(prompt)
  if (!ids.length || ids.some(id => !knows(prompt[id]!.class_type, families))) return whole
  const outputs = ids.filter(id => RUNNER_OUTPUT_CLASSES.has(prompt[id]!.class_type))
  if (!outputs.length) return { prompt: {}, dropped: [], nodeErrors: {}, failed: true, noOutputs: true, unread: [] }

  // validate_inputs, cached: a node fails on its own errors or any upstream failure.
  const own = new Map<string, ComfyValidationError[]>()
  const valid = new Map<string, boolean>()
  const check = (id: string, seen: Set<string>): boolean => {
    const known = valid.get(id)
    if (known !== undefined) return known
    const node = prompt[id]
    // A wire out of the prompt, or a loop: left to eligibility.
    if (!node || seen.has(id)) return true
    seen.add(id)
    const errs = nodeValidationErrors(node.class_type, node.inputs ?? {})
    own.set(id, errs)
    let ok = !errs.length
    for (const l of linksOf(node)) if (!check(l.from, seen)) ok = false
    valid.set(id, ok)
    return ok
  }
  const good: string[] = []
  const dropped: string[] = []
  const nodeErrors: Record<string, ComfyNodeError> = {}
  for (const o of outputs) {
    if (check(o, new Set())) { good.push(o); continue }
    dropped.push(o)
    // As validate_prompt does it: every node validated so far with errors of
    // its own gets this failed output appended (upstream of it or not).
    for (const [id, errs] of own) {
      if (!errs.length || valid.get(id) !== false) continue
      const e = nodeErrors[id] ??= { errors: errs, dependent_outputs: [], class_type: prompt[id]!.class_type }
      e.dependent_outputs.push(o)
    }
  }
  if (!good.length) return { prompt: {}, dropped, nodeErrors, failed: true, unread: [] }

  const keep = readByOutputs(prompt, good)
  // Every node an output needs: the prompt itself.
  if (!dropped.length && keep.size === ids.length) return whole
  const pruned: ApiPrompt = {}
  const unread: string[] = []
  for (const id of ids) {
    if (keep.has(id)) pruned[id] = prompt[id]!
    // Dropped outputs and what only they need are not "unread": ComfyUI reports them (node_errors).
    else if (!dropped.includes(id) && !isUpstreamOfAny(prompt, dropped, id)) unread.push(id)
  }
  return { prompt: pruned, dropped, nodeErrors, failed: false, unread }
}

/**
 * ComfyUI's execution scope (execution.py: only the good outputs go into the
 * ExecutionList): the outputs and every node they read, directly or not,
 * inside the prompt. The one closure both paths use: the runner's pruning
 * above and the hosted ComfyUI meter's price (executedPart, R3.8 fix round 2).
 */
export function readByOutputs(prompt: ApiPrompt, outputs: Iterable<string>): Set<string> {
  const keep = new Set<string>()
  for (const o of outputs) for (const id of upstreamOf(prompt, o)) keep.add(id)
  return keep
}

/**
 * The part of a prompt ComfyUI executes, for any class (`isOutput`: whether a
 * class is an output node, from the node catalog): the nodes some output
 * node reads. A prompt with no output node is returned as it is (ComfyUI
 * refuses it before running anything), and so is one whose every node is
 * read. The hosted ComfyUI path prices and holds this (R3.8 fix round 2).
 *
 * `dropped` (R7.11 fix): outputs ComfyUI's validate_prompt dropped (its
 * node_errors' dependent_outputs). They are not run, so neither is what only
 * they read: left out, as Python executes only its good outputs. Dropping
 * every output leaves the prompt as it is (ComfyUI refuses that prompt).
 */
export function executedPart(prompt: ApiPrompt, isOutput: (classType: string) => boolean, dropped: Iterable<string> = []): ApiPrompt {
  const ids = Object.keys(prompt)
  const gone = new Set([...dropped].map(String))
  const outputs = ids.filter(id => isOutput(prompt[id]!.class_type) && !gone.has(id))
  if (!outputs.length) return prompt
  const keep = readByOutputs(prompt, outputs)
  if (keep.size === ids.length) return prompt
  return Object.fromEntries(ids.filter(id => keep.has(id)).map(id => [id, prompt[id]!]))
}

/**
 * A node catalogue's (/object_info's) output-node test, for executedPart: a
 * class it doesn't list counts as an output (the safe side: its node and
 * what it reads are kept). Undefined without a catalogue.
 */
export function outputClassesOf(catalog: Readonly<Record<string, { output_node?: unknown } | undefined>> | null | undefined): ((classType: string) => boolean) | undefined {
  if (!catalog) return undefined
  return (ct) => {
    const def = Object.prototype.hasOwnProperty.call(catalog, ct) ? catalog[ct] : undefined
    return !def || def.output_node === true
  }
}

/** Whether `id` is something one of `outputs` reads (directly or not). */
function isUpstreamOfAny(prompt: ApiPrompt, outputs: readonly string[], id: string): boolean {
  return outputs.some(o => upstreamOf(prompt, o).has(id))
}

/** The node and everything it reads from, inside the prompt. */
function upstreamOf(prompt: ApiPrompt, id: string): Set<string> {
  const out = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const n = stack.pop()!
    if (out.has(n) || !(n in prompt)) continue
    out.add(n)
    for (const l of linksOf(prompt[n])) stack.push(l.from)
  }
  return out
}

/** ComfyUI's refusal when every output fails, in plain words. */
export const NO_VALID_OUTPUTS_MESSAGE = 'Nothing in this workflow can run: every result has a missing or invalid setting'

/** ComfyUI's refusal when no node shows or saves a result ("Prompt has no outputs"), in plain words. */
export const NO_OUTPUTS_MESSAGE = 'Nothing here shows or saves a result. Add a card that shows it, or a node that saves it.'

/**
 * Whether the runner takes this workflow, after ComfyUI's pruning. A
 * workflow whose every output fails validation is taken too: the runner
 * refuses it with ComfyUI's message in plain words, as ComfyUI would. So is
 * one with no output node (R3.8 fix rounds 1 and 2: it used to run, and
 * charge, nodes nothing reads, or be sent to the engine, which refuses it
 * with "Prompt has no outputs" or isn't there at all).
 */
export function runnerTakesWorkflow(
  prompt: ApiPrompt | null | undefined,
  families: ReadonlySet<RunnerFamily> = NO_FAMILIES,
  opts: RunnerEligibilityOptions = {},
): boolean {
  if (!prompt) return false
  const r = pruneInvalidOutputs(prompt, families)
  // No output node at all (every class the runner knows): the runner refuses it in
  // plain words (NO_OUTPUTS_MESSAGE), as ComfyUI refuses it ("Prompt has no
  // outputs"); nothing of it would run anywhere (R3.8 fix round 2).
  if (r.failed) return true
  // R11.9a: a node the runner refuses in plain words (./stopGaps.ts) goes to it, to be refused there,
  // never to the engine (`plainRefusals` unless the caller says otherwise).
  return isRunnerEligible(r.prompt, families, { plainRefusals: true, ...opts, afterPruning: prunedAny(r), showsMadeResult: showsMadeResult(r.prompt) })
}

/**
 * LC8 (F1): whether an output node (RUNNER_OUTPUT_CLASSES) reads a node of
 * the prompt that isn't itself one, so the run shows or saves something made
 * in it (an Empty image or a 3D Studio's picture in an Image card). Such a
 * workflow runs with nothing to call or charge, as ComfyUI ran it, while
 * `cards` is on (isRunnerEligible). A card alone, or a card showing another
 * card, makes nothing new.
 */
export function showsMadeResult(prompt: ApiPrompt): boolean {
  return Object.values(prompt).some(n => RUNNER_OUTPUT_CLASSES.has(n.class_type)
    && linksOf(n).some(l => l.from in prompt && !RUNNER_OUTPUT_CLASSES.has(prompt[l.from]!.class_type)))
}
