/**
 * Which workflows the Sailor runner takes. Everything else goes to ComfyUI
 * whole — a workflow is never split between the two.
 */
import { isLink, type ApiPrompt } from './graph'
import { NO_FAMILIES, type RunnerFamily } from './families'

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
 * be wired; `mustNotLink` inputs must not be (e.g. BlendScene `keep_subject`,
 * Restyle `style_in`).
 */
export interface RunnerNodeRule {
  family?: RunnerFamily
  models?: Readonly<Record<string, RunnerFamily | RunnerModelRule>>
  mustLink?: readonly string[]
  mustNotLink?: readonly string[]
}

/**
 * The node classes (or extra models of a runner class) the families add,
 * keyed by class_type. For GenerateImageNode / GenerateVideoNode a row only
 * ADDS models; the models the runner takes without any family stay as they
 * are.
 */
export const RUNNER_NODE_RULES: Readonly<Record<string, RunnerNodeRule>> = {
  // ── fal-edit (Task B2): fal only, at most two linked pictures ──
  EditImageNode: {
    models: { 'Nano Banana 2': 'fal-edit', 'Flux Kontext Pro': 'fal-edit', 'Flux 2 Pro': 'fal-edit' },
    mustLink: ['input_image'],
  },
  DevelopImageNode: { family: 'fal-edit', mustLink: ['input_image'] },
  // With no `image` Python makes a blank no-op; the runner leaves that to Python.
  RelightNode: { family: 'fal-edit', mustLink: ['image'] },
  // The Nano Banana mode is Replicate (Task B5). A linked keep_subject needs a
  // local mask composite after the call, which the runner does not do.
  BlendSceneNode: {
    models: { 'Flux Kontext Pro': 'fal-edit', 'Flux 2 Pro': 'fal-edit' },
    mustLink: ['image'],
    mustNotLink: ['keep_subject'],
  },
}

/**
 * The classes that make a provider call (and so are charged): the two
 * generators, plus every class a family row adds. A workflow needs at least
 * one of them to go to the runner.
 */
export const PROVIDER_TYPES: ReadonlySet<string> = new Set([
  'GenerateImageNode', 'GenerateVideoNode', ...Object.keys(RUNNER_NODE_RULES),
])

/** The image models that default to fal AND have a price. krea-2-large,
 *  krea-2-medium and seedream-5-pro are left out until they are priced. */
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
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v.trim(), 10)
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

/** The model widget as a rule looks it up (a legacy video label → its current id). */
function modelKey(classType: string, model: unknown): string {
  return classType === 'GenerateVideoNode' ? resolveVideoModelId(model) : (typeof model === 'string' ? model : '')
}

/** Whether a rule row lets this node through with these families switched on. */
export function nodeRuleAllows(
  classType: string,
  rule: RunnerNodeRule,
  inputs: Record<string, unknown>,
  families: ReadonlySet<RunnerFamily>,
): boolean {
  const need: string[] = [...(rule.mustLink ?? [])]
  let family: RunnerFamily | undefined = rule.family
  if (rule.models) {
    const key = modelKey(classType, inputs.model)
    const m = Object.prototype.hasOwnProperty.call(rule.models, key) ? rule.models[key] : undefined
    if (!m) return false
    if (typeof m === 'string') family = m
    else {
      family = m.family
      need.push(...(m.mustLink ?? []))
    }
  }
  if (!family || !families.has(family)) return false
  if (need.some(name => !isLink(inputs[name]))) return false
  if ((rule.mustNotLink ?? []).some(name => isLink(inputs[name]))) return false
  return true
}

/**
 * Whether the runner can take this one node of the prompt: a runner node type,
 * on a runner model, asking for one picture, with no sound wired into a
 * video, and reading only from nodes in the same prompt — or a class (or
 * model) a switched-on family's row lets through. A workflow goes to the
 * runner only when every node passes AND it has a provider node
 * (isRunnerEligible). `nodesNeedingEngine` (app/lib/runner/needsEngine.ts)
 * names the nodes that fail this, so there is one rule, not two. With no
 * families (the default) this is exactly the rule before families existed.
 */
export function runnerTakesNode(prompt: ApiPrompt, id: string, families: ReadonlySet<RunnerFamily> = NO_FAMILIES): boolean {
  const n = prompt[id]
  if (!n) return false
  const inputs = n.inputs ?? {}
  const rule = families.size ? RUNNER_NODE_RULES[n.class_type] : undefined
  const byRule = !!rule && nodeRuleAllows(n.class_type, rule, inputs, families)
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

export function isRunnerEligible(prompt: ApiPrompt | null | undefined, families: ReadonlySet<RunnerFamily> = NO_FAMILIES): boolean {
  if (!prompt) return false
  const ids = Object.keys(prompt)
  if (!ids.length) return false
  let providers = 0
  for (const id of ids) {
    if (!runnerTakesNode(prompt, id, families)) return false
    if (PROVIDER_TYPES.has(prompt[id]!.class_type)) providers++
  }
  return providers > 0
}
