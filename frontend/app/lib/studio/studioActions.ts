// Studio inspector actions (spec §1.4, §2.4, §7.3): the same Edit / Develop
// vocabulary as the node toolbar, as light rows under the thing itself. AI rows
// go through the studio's one prompt: a mode chip that waits for words, or a
// kind that runs at once. A surface adds its own non-AI rows (re-rolls) as `local`.
import { SHADER_GEN_ACTION_HINT, type ActionGroup, type ActionLands } from '~/lib/canvas/nodeActions'
import { shaderGenEstimateText } from '~/lib/shadergen/estimate'
import type { StudioPromptApi } from '~/composables/useStudioPrompt'

/** `add`: a mode whose takes land on a new layer (Shader's "New layer from a description…"). */
export type StudioActionRun = { mode: string; add?: boolean } | { kind: 'tweak'; fromMenu: true } | { call: () => void }
/** `priceHint`: the estimate of a paid row (new effects) in dollars, after the landing hint — as
 *  NodeAction's. `priceFor` (when set) follows the hosted switch instead (credits hosted). */
/** `disabled`: shown but off, with `disabledHint` saying why in a plain sentence. */
export interface StudioAction {
  id: string; label: string; group: ActionGroup; ai: boolean; lands: ActionLands
  priceHint?: string | null; priceFor?: (hosted: boolean) => string; run: StudioActionRun
  disabled?: boolean; disabledHint?: string
}

/** The Shader studio's stack is full (LAYER_MAX): no room for a new layer. */
export const LAYERS_FULL = 'The studio holds six layers. Remove one to add another.'
export type StudioActionPlace = 'shader' | 'gradient' | 'shape' | 'texture' | 'vectortype' | 'spacetype' | 'frame'

/** `backgroundIsShader` (Frame): the background is a shader fill, so it can be remixed.
 *  `layersFull` (Shader): the stack has no room, so "New layer…" is off and says why. */
export function studioActions(o: { place: StudioActionPlace; canTakes: boolean; local?: StudioAction[]; backgroundIsShader?: boolean; layersFull?: boolean }): StudioAction[] {
  const takes: ActionLands = o.canTakes ? 'takes' : null
  const edit: StudioAction[] = [{ id: 'tune', label: 'Tune…', group: 'edit', ai: true, lands: takes, run: { mode: 'Tune' } }]
  if (o.place === 'frame') edit.push({ id: 'write-copy', label: 'Write copy…', group: 'edit', ai: true, lands: null, run: { mode: 'Write copy' } })
  const develop: StudioAction[] = []
  if (o.canTakes) develop.push({ id: 'vary', label: 'Vary', group: 'develop', ai: true, lands: 'takes', run: { kind: 'tweak', fromMenu: true } })
  const priceHint = SHADER_GEN_ACTION_HINT, priceFor = shaderGenEstimateText
  if (o.place === 'shader') develop.push({ id: 'new-layer', label: 'New layer from a description…', group: 'develop', ai: true, lands: 'takes', priceHint, priceFor, run: { mode: 'New effect', add: true }, ...(o.layersFull ? { disabled: true, disabledHint: LAYERS_FULL } : {}) })
  // Frame's background is where new effects show in Frame (stage 5, Ruling 10).
  if (o.place === 'frame') {
    develop.push({ id: 'new-background', label: 'New background from a description…', group: 'develop', ai: true, lands: 'takes', priceHint, priceFor, run: { mode: 'New effect' } })
    if (o.backgroundIsShader) develop.push({ id: 'remix-background', label: 'Remix background…', group: 'develop', ai: true, lands: 'takes', priceHint, priceFor, run: { mode: 'Remix' } })
  }
  const local = o.local ?? []
  return [...edit, ...local.filter(a => a.group === 'edit'), ...develop, ...local.filter(a => a.group === 'develop')]
}

/** Shader's Recipe → Remix (spec §7.3). A mode chip; the effect takes run it. */
export const REMIX_ACTION: StudioAction = { id: 'remix', label: 'Remix…', group: 'develop', ai: true, lands: 'takes', priceHint: SHADER_GEN_ACTION_HINT, priceFor: shaderGenEstimateText, run: { mode: 'Remix' } }

export function runStudioAction(a: StudioAction, prompt: Pick<StudioPromptApi, 'setMode' | 'runKind'> | null): void {
  if (a.disabled) return
  const r = a.run
  if ('call' in r) { r.call(); return }
  if ('mode' in r) { prompt?.setMode(r.mode, { add: r.add }); return }
  void prompt?.runKind(r.kind, { fromMenu: true })
}
