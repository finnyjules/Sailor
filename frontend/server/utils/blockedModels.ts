/**
 * The server side of the model line-up's run check (shared/runner/blockedModels.ts):
 * a prompt about to be forwarded to ComfyUI that uses a discontinued or
 * runner-only model is refused with ComfyUI's own 400 shape, before pricing,
 * any hold, or the engine. Used by the hosted meter (`meterGraphSubmit`) and
 * the local `/prompt` proxy (server/middleware/comfyui-proxy.ts).
 */
import { blockedPromptBody } from '../../shared/runner/needsEngine'
import { runnerFamilies } from '../runner/config'

/** The 400 body for `prompt`, or null when every model in it can run on ComfyUI. */
export function blockedPromptRefusal(prompt: unknown): ReturnType<typeof blockedPromptBody> {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return null
  return blockedPromptBody(prompt as Parameters<typeof blockedPromptBody>[0], { families: runnerFamilies() })
}
