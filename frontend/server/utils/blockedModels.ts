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
import { classUpgradeOn } from '../../shared/runner/eligibility'
import { requestProblems, type RequestProblem } from '../runner/requestRules'
import { retiredNodesResponse, type IsOutputClass } from '../../shared/runner/retired'
import { outputClassesOf } from '../../shared/runner/validate'
import { storedNodeCatalog } from '../native/objectInfo'

/** The stored node catalogue's output-node test (server/native/objectInfo.ts); every class counts as one without a catalogue. */
function storedOutputClass(): IsOutputClass {
  return outputClassesOf(storedNodeCatalog()) ?? (() => true)
}

/**
 * The 400 body for a prompt in which a retired partner node runs (an output
 * reads it: shared/runner/retired.ts, Task R4.1 fix round 1), or null. One
 * no output reads is pruned by ComfyUI and isn't refused. `isOutputClass`:
 * the catalogue's output test (the stored node catalogue by default).
 */
export function retiredPromptRefusal(prompt: unknown, isOutputClass?: IsOutputClass): RefusalBody | null {
  return retiredNodesResponse(prompt, isOutputClass ?? storedOutputClass())
}

/**
 * The 400 body for `prompt`, or null when no retired partner node in it runs
 * (retiredPromptRefusal), every model in it can run on ComfyUI and every
 * request is one its provider takes (requestRefusal).
 */
export function blockedPromptRefusal(prompt: unknown, opts: { isOutputClass?: IsOutputClass } = {}): ReturnType<typeof blockedPromptBody> {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return null
  return retiredPromptRefusal(prompt, opts.isOutputClass) ?? blockedPromptBody(prompt as Parameters<typeof blockedPromptBody>[0], { families: runnerFamilies() })
    ?? requestRefusal(prompt)
}

/** ComfyUI's 400 shape for problems found on nodes, the first one's words as the error. */
export function nodeProblemsBody(problems: readonly RequestProblem[]): RefusalBody | null {
  if (!problems.length) return null
  const node_errors: Record<string, unknown> = {}
  for (const p of problems) {
    const entry = (node_errors[p.nodeId] ??= { errors: [], dependent_outputs: [], class_type: p.classType }) as { errors: unknown[] }
    entry.errors.push({ type: 'value_not_valid', message: p.message, details: '', extra_info: { input_name: p.input } })
  }
  return {
    error: { type: 'value_not_valid', message: problems[0]!.message, details: '', extra_info: {} },
    node_errors,
  } as RefusalBody
}

/**
 * A request no provider takes, refused before ComfyUI sends it (S1b fix round
 * 1, server/runner/requestRules.ts): a Nano Banana prompt under 3 characters
 * or an empty Hailuo H3 prompt, as the node sends it after its style text;
 * Seedance 2.0 references over the model's counts.
 */
export function requestRefusal(prompt: unknown): RefusalBody | null {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return null
  return nodeProblemsBody(requestProblems(prompt as ApiPrompt))
}

/**
 * Hosted only: the two edit calls whose price is only an estimate
 * (shared/pricing/editRates.ts) are refused on the metered ComfyUI path,
 * before pricing and any hold (model line-up H2, fix round 1). Local mode
 * runs them as before.
 *   Product shot           catacolabs/sdxl-ad-inpaint, while Bria Product
 *                          Shot's switch (bria-product-shot, Task F12) is
 *                          off. On, the node runs Bria, priced, in the runner
 *                          only: the ComfyUI path refuses it as runner-only
 *                          (blockedPromptRefusal, which runs first), so this
 *                          one leaves it alone.
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
    if (ct === 'ProductShotNode' && !classUpgradeOn(ct, runnerFamilies())) {
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
