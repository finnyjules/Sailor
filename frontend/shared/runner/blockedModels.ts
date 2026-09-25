/**
 * The models a run may not use where it is going (model line-up spec,
 * Rulings 2 and 6). One check, used in three places:
 *   - the browser, after the runner declined or was skipped and before any
 *     `/prompt` (layouts/default.vue `runVueWorkflow`);
 *   - the server, wherever `/prompt` goes to ComfyUI: the hosted meter
 *     (`meterGraphSubmit`, before pricing and any hold) and the local proxy;
 *   - the runner (`startRun`), before any hold: only discontinued models.
 *
 * A discontinued model is refused everywhere: Sailor never quietly swaps in
 * another one. A runner-only model has no engine builder, so the ComfyUI
 * path refuses it; the runner takes it only while its family is on.
 *
 * Pure; relative imports only.
 */
import type { ApiPrompt } from './graph'
import { NO_FAMILIES, type RunnerFamily } from './families'
import { modelEntryFor, modelMenus, runnerTakesClass } from './modelMenus'

export interface BlockedModelUse {
  nodeId: string
  classType: string
  /** The value the node holds, as saved (a legacy label stays as it is). */
  value: string
  reason: 'runner-only' | 'discontinued'
}

export interface BlockedModelOptions {
  /** The runner families switched on. */
  families?: ReadonlySet<RunnerFamily>
  /**
   * The run goes to the runner. Then a runner-only model is fine while its
   * family is on (on a class the runner takes); only discontinued ones, and
   * runner-only ones whose switch is off, are refused. False (the default):
   * the run goes to ComfyUI, which can run no runner-only model.
   */
  runnerTakes?: boolean
}

/** Every node in `prompt` whose model can't run where the prompt is going, in prompt order. */
export function blockedModelUses(prompt: ApiPrompt | null | undefined, opts: BlockedModelOptions = {}): BlockedModelUse[] {
  if (!prompt || typeof prompt !== 'object') return []
  const families = opts.families ?? NO_FAMILIES
  const out: BlockedModelUse[] = []
  const menus = modelMenus()
  for (const [nodeId, node] of Object.entries(prompt)) {
    const classType = node?.class_type
    if (typeof classType !== 'string') continue
    for (const menu of menus) {
      if (menu.classType !== classType) continue
      const value = node.inputs?.[menu.input]
      const entry = modelEntryFor(classType, value, menu.input)
      if (!entry || typeof value !== 'string') continue
      if (entry.discontinued) out.push({ nodeId, classType, value, reason: 'discontinued' })
      else if (entry.runnerOnly) {
        const runs = !!opts.runnerTakes && !!entry.family && families.has(entry.family) && runnerTakesClass(classType)
        if (!runs) out.push({ nodeId, classType, value, reason: 'runner-only' })
      }
    }
  }
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** An ISO date as the messages say it: '2026-09-24' → '24 Sep 2026'. Anything else as given. */
export function serviceDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined
  if (!m || !month) return iso
  return `${Number(m[3])} ${month} ${m[1]}`
}

/** The model's own name for a blocked use (its catalogue label; the saved value when it has none). */
export function blockedModelLabel(use: Pick<BlockedModelUse, 'classType' | 'value'>): string {
  return modelEntryFor(use.classType, use.value)?.label ?? use.value
}

/** Why a runner-only model didn't go to the runner, when its switch is off. */
export const SWITCH_OFF_REASON = 'Its switch is off'

/**
 * The refusal for one blocked use, as a toast: a title and a description.
 *   discontinued  "Sora 2 was discontinued by its service on 24 Sep 2026" / "Pick another model in “Title”."
 *   runner-only   "“Title” uses Model, which only runs in Sailor" / the reason
 * `engineReason` is why the runner didn't take the workflow when the model's
 * switch is on (needsEngineDescription); with the switch off it is
 * SWITCH_OFF_REASON.
 */
export function blockedModelRefusal(
  use: BlockedModelUse,
  opts: { title: string, families?: ReadonlySet<RunnerFamily>, engineReason?: string },
): { title: string, description: string } {
  const entry = modelEntryFor(use.classType, use.value)
  const label = entry?.label ?? use.value
  if (use.reason === 'discontinued') {
    return {
      title: `${label} was discontinued by its service on ${serviceDate(entry?.discontinued ?? '')}`,
      description: `Pick another model in “${opts.title}”.`,
    }
  }
  const families = opts.families ?? NO_FAMILIES
  const switchedOn = !!entry?.family && families.has(entry.family) && runnerTakesClass(use.classType)
  return {
    title: `“${opts.title}” uses ${label}, which only runs in Sailor`,
    description: switchedOn && opts.engineReason ? opts.engineReason : SWITCH_OFF_REASON,
  }
}

/** Plain names for the classes whose model Sailor decides, for a server with no node titles. */
const CLASS_TITLES: Readonly<Record<string, string>> = {
  GenerateImageNode: 'Generate an image',
  GenerateVideoNode: 'Generate a video',
  FilmShotNode: 'Film a shot',
  EditImageNode: 'Edit an image',
  BlendSceneNode: 'Blend scene',
  RestyleFromImageNode: 'Restyle from image',
  GenerateFromReferencesNode: 'Generate from references',
  UpscaleImageNode: 'Upscale an image',
}

/**
 * A node's title where only the prompt is known: its `_meta.title`, else its
 * class's plain name, else "Unnamed node" (as app/lib/runner/needsEngine.ts
 * names it), never a class name.
 */
export function promptNodeTitle(prompt: ApiPrompt, nodeId: string): string {
  const node = prompt[nodeId] as { class_type?: string, _meta?: { title?: unknown } } | undefined
  const meta = node?._meta?.title
  if (typeof meta === 'string' && meta.trim()) return meta.trim()
  return (node?.class_type && CLASS_TITLES[node.class_type]) || 'Unnamed node'
}

function sentence(s: string): string {
  return /[.!?…]$/.test(s) ? s : `${s}.`
}

/**
 * ComfyUI's own 400 body for a refused prompt (`{ error, node_errors }`,
 * type `value_not_in_list`), so the existing error display rings the nodes.
 * The message is the plain refusal of the first use.
 */
export function blockedModelsResponse(
  prompt: ApiPrompt,
  uses: readonly BlockedModelUse[],
  opts: { families?: ReadonlySet<RunnerFamily>, titleOf?: (nodeId: string) => string, engineReason?: string } = {},
): { error: { type: string, message: string, details: string, extra_info: Record<string, unknown> }, node_errors: Record<string, unknown> } {
  const titleOf = opts.titleOf ?? ((id: string) => promptNodeTitle(prompt, id))
  const text = (use: BlockedModelUse) => {
    const r = blockedModelRefusal(use, { title: titleOf(use.nodeId), families: opts.families, engineReason: opts.engineReason })
    return { message: sentence(r.title), details: sentence(r.description) }
  }
  const node_errors: Record<string, unknown> = {}
  for (const use of uses) {
    const t = text(use)
    const entry = (node_errors[use.nodeId] ??= { errors: [], dependent_outputs: [], class_type: use.classType }) as { errors: unknown[] }
    entry.errors.push({ type: 'value_not_in_list', message: t.message, details: t.details, extra_info: { input_name: 'model', input_value: use.value } })
  }
  const first = uses[0] ? text(uses[0]) : { message: 'A model in this workflow can’t run here.', details: '' }
  return {
    error: { type: 'value_not_in_list', message: `${first.message} ${first.details}`.trim(), details: first.details, extra_info: {} },
    node_errors,
  }
}
