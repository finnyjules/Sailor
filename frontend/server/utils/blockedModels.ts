/**
 * The server side of the model line-up's run check (shared/runner/blockedModels.ts):
 * a prompt about to be forwarded to ComfyUI that uses a discontinued or
 * runner-only model is refused with ComfyUI's own 400 shape, before pricing,
 * any hold, or the engine. Used by the hosted meter (`meterGraphSubmit`) and
 * the local `/prompt` proxy (server/middleware/comfyui-proxy.ts).
 */
import { blockedPromptBody } from '../../shared/runner/needsEngine'
import { runnerFamilies } from '../runner/config'
import { promptNodeTitle } from '../../shared/runner/blockedModels'
import type { ApiPrompt } from '../../shared/runner/graph'
import { menuDefault, modelMenu } from '../../shared/runner/modelMenus'

/** The 400 body for `prompt`, or null when every model in it can run on ComfyUI. */
export function blockedPromptRefusal(prompt: unknown): ReturnType<typeof blockedPromptBody> {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return null
  return blockedPromptBody(prompt as Parameters<typeof blockedPromptBody>[0], { families: runnerFamilies() })
}

/**
 * Hosted only, until Bria product-shot (Task F12) lands: the two edit calls
 * whose price is only an estimate (shared/pricing/editRates.ts) are refused
 * on the metered ComfyUI path, before pricing and any hold (model line-up H2,
 * fix round 1). Local mode runs them as before.
 *   Product shot           catacolabs/sdxl-ad-inpaint
 *   Restyle, IP-Adapter    fofr/style-transfer
 */
export const PRODUCT_SHOT_UPGRADING = 'Product shot is being upgraded — try Swap background for now.'
export const STYLE_TRANSFER_RETIRED = 'Restyle’s Style Transfer engine has been retired.'

/** Restyle's default, by its menu label (the first preference that runs, H2). */
function restyleDefaultLabel(): string {
  const menu = modelMenu('RestyleFromImageNode')!
  const def = menuDefault(menu, runnerFamilies())
  return menu.entries.find(e => e.value === def)?.label ?? String(def)
}

type RefusalBody = NonNullable<ReturnType<typeof blockedPromptBody>>

/** The hosted 400 body (ComfyUI's shape) for a prompt using a retired, estimate-priced engine, or null. */
export function retiredEngineRefusal(prompt: unknown): RefusalBody | null {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return null
  const node_errors: Record<string, unknown> = {}
  let first: { message: string, details: string } | null = null
  for (const [id, raw] of Object.entries(prompt as Record<string, unknown>)) {
    const node = raw as { class_type?: unknown, inputs?: Record<string, unknown> } | null
    const ct = node?.class_type
    let text: { message: string, details: string, input: string, value: unknown } | null = null
    if (ct === 'ProductShotNode') {
      text = { message: PRODUCT_SHOT_UPGRADING, details: '', input: 'image', value: null }
    }
    else if (ct === 'RestyleFromImageNode' && node?.inputs?.model === 'Style Transfer · IP-Adapter') {
      text = { message: STYLE_TRANSFER_RETIRED, details: `Pick another model in “${promptNodeTitle(prompt as ApiPrompt, id)}”, such as ${restyleDefaultLabel()}.`, input: 'model', value: node.inputs.model }
    }
    if (!text) continue
    first ??= text
    node_errors[id] = {
      errors: [{ type: 'value_not_in_list', message: text.message, details: text.details, extra_info: { input_name: text.input, input_value: text.value } }],
      dependent_outputs: [],
      class_type: ct,
    }
  }
  if (!first) return null
  return {
    error: { type: 'value_not_in_list', message: `${first.message} ${first.details}`.trim(), details: first.details, extra_info: {} },
    node_errors,
  }
}
