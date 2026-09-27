/**
 * ComfyUI's whole-prompt rule (execution.py `validate_prompt`), for the part
 * of validation the runner ports: an output node whose own subgraph fails
 * validation is dropped ("Output will be ignored"), every other output is
 * kept, and only what the kept outputs need runs. With no output left the
 * prompt is refused ("Prompt outputs failed validation").
 *
 * So a blank project's empty Frame (no layer 1) no longer blocks the rest of
 * the canvas: ComfyUI drops it and runs the rest (history c7690393: only the
 * Image card ran), and so does the runner.
 *
 * The browser (shouldUseRunner, nodesNeedingEngine) and the server (startRun)
 * share this file, so they agree on what runs.
 *
 * Kept deliberately narrow:
 *   - it prunes only when some output fails; a prompt whose outputs all
 *     validate is left exactly as it is (the runner's existing rule);
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
  /** Every output failed: ComfyUI refuses the prompt ("Prompt outputs failed validation"). */
  failed: boolean
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
  return !only || familyOn(only, families)
}

/** The prompt as ComfyUI's validate_prompt leaves it to run. `families`: the runner families on. */
export function pruneInvalidOutputs(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily> = NO_FAMILIES): PrunedPrompt {
  const whole: PrunedPrompt = { prompt, dropped: [], nodeErrors: {}, failed: false }
  const ids = Object.keys(prompt)
  if (!ids.length || ids.some(id => !knows(prompt[id]!.class_type, families))) return whole
  const outputs = ids.filter(id => RUNNER_OUTPUT_CLASSES.has(prompt[id]!.class_type))
  if (!outputs.length) return whole

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
  if (!dropped.length) return whole
  if (!good.length) return { prompt: {}, dropped, nodeErrors, failed: true }

  const keep = new Set<string>()
  for (const o of good) for (const id of upstreamOf(prompt, o)) keep.add(id)
  const pruned: ApiPrompt = {}
  for (const id of ids) if (keep.has(id)) pruned[id] = prompt[id]!
  return { prompt: pruned, dropped, nodeErrors, failed: false }
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

/**
 * Whether the runner takes this workflow, after ComfyUI's pruning. A
 * workflow whose every output fails validation is taken too: the runner
 * refuses it with ComfyUI's message in plain words, as ComfyUI would.
 */
export function runnerTakesWorkflow(
  prompt: ApiPrompt | null | undefined,
  families: ReadonlySet<RunnerFamily> = NO_FAMILIES,
  opts: RunnerEligibilityOptions = {},
): boolean {
  if (!prompt) return false
  const r = pruneInvalidOutputs(prompt, families)
  if (r.failed) return true
  return isRunnerEligible(r.prompt, families, { ...opts, afterPruning: r.dropped.length > 0 })
}
