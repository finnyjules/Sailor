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

export function isRunnerEligible(prompt: ApiPrompt | null | undefined): boolean {
  if (!prompt) return false
  const nodes = Object.values(prompt)
  if (!nodes.length) return false
  let generators = 0
  for (const n of nodes) {
    if (!n || !RUNNER_NODE_TYPES.has(n.class_type)) return false
    const inputs = n.inputs ?? {}
    if (n.class_type === 'GenerateImageNode') {
      generators++
      if (!IMAGE_IDS.has(String(inputs.model))) return false
    }
    else if (n.class_type === 'GenerateVideoNode') {
      generators++
      if (!VIDEO_IDS.has(resolveVideoModelId(inputs.model))) return false
      if (isLink(inputs.audio)) return false
    }
    for (const v of Object.values(inputs)) {
      if (isLink(v) && !(v[0] in prompt)) return false
    }
  }
  return generators > 0
}
