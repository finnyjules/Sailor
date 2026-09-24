/**
 * Which workflows the Sailor runner takes. Everything else goes to ComfyUI
 * whole — a workflow is never split between the two.
 */
import { isLink, type ApiPrompt } from './graph'

export const RUNNER_NODE_TYPES: ReadonlySet<string> = new Set([
  'GenerateImageNode', 'GenerateVideoNode', 'ComfyGateNode', 'Image', 'Video',
])

export const GENERATOR_TYPES: ReadonlySet<string> = new Set(['GenerateImageNode', 'GenerateVideoNode'])

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

/**
 * Whether the runner can take this one node of the prompt: a runner node type,
 * on a runner model, asking for one picture, with no sound wired into a
 * video, and reading only from nodes in the same prompt. A workflow goes to
 * the runner only when every node passes AND it has a generator
 * (isRunnerEligible). `nodesNeedingEngine` (app/lib/runner/needsEngine.ts)
 * names the nodes that fail this, so there is one rule, not two.
 */
export function runnerTakesNode(prompt: ApiPrompt, id: string): boolean {
  const n = prompt[id]
  if (!n || !RUNNER_NODE_TYPES.has(n.class_type)) return false
  const inputs = n.inputs ?? {}
  if (n.class_type === 'GenerateImageNode') {
    if (!IMAGE_IDS.has(String(inputs.model))) return false
    if (asksForSeveralImages(inputs)) return false
  }
  else if (n.class_type === 'GenerateVideoNode') {
    if (!VIDEO_IDS.has(resolveVideoModelId(inputs.model))) return false
    if (isLink(inputs.audio)) return false
  }
  for (const v of Object.values(inputs)) {
    if (isLink(v) && !(v[0] in prompt)) return false
  }
  return true
}

export function isRunnerEligible(prompt: ApiPrompt | null | undefined): boolean {
  if (!prompt) return false
  const ids = Object.keys(prompt)
  if (!ids.length) return false
  let generators = 0
  for (const id of ids) {
    if (!runnerTakesNode(prompt, id)) return false
    if (GENERATOR_TYPES.has(prompt[id]!.class_type)) generators++
  }
  return generators > 0
}
