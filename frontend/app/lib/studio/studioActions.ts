// Studio inspector actions (spec §1.4, §2.4, §7.3): the same Edit / Develop
// vocabulary as the node toolbar, as light rows under the thing itself. AI rows
// go through the studio's one prompt: a mode chip that waits for words, or a
// kind that runs at once. A surface adds its own non-AI rows (re-rolls) as `local`.
import type { ActionGroup, ActionLands } from '~/lib/canvas/nodeActions'
import type { StudioPromptApi } from '~/composables/useStudioPrompt'

export type StudioActionRun = { mode: string } | { kind: 'tweak'; fromMenu: true } | { call: () => void }
export interface StudioAction { id: string; label: string; group: ActionGroup; ai: boolean; lands: ActionLands; run: StudioActionRun }
export type StudioActionPlace = 'shader' | 'gradient' | 'shape' | 'texture' | 'vectortype' | 'spacetype' | 'frame'

export function studioActions(o: { place: StudioActionPlace; canTakes: boolean; local?: StudioAction[] }): StudioAction[] {
  const takes: ActionLands = o.canTakes ? 'takes' : null
  const edit: StudioAction[] = [{ id: 'tune', label: 'Tune…', group: 'edit', ai: true, lands: takes, run: { mode: 'Tune' } }]
  if (o.place === 'frame') edit.push({ id: 'write-copy', label: 'Write copy…', group: 'edit', ai: true, lands: null, run: { mode: 'Write copy' } })
  const develop: StudioAction[] = []
  if (o.canTakes) develop.push({ id: 'vary', label: 'Vary', group: 'develop', ai: true, lands: 'takes', run: { kind: 'tweak', fromMenu: true } })
  if (o.place === 'shader') develop.push({ id: 'new-layer', label: 'New layer from a description…', group: 'develop', ai: true, lands: 'takes', run: { mode: 'New effect' } })
  const local = o.local ?? []
  return [...edit, ...local.filter(a => a.group === 'edit'), ...develop, ...local.filter(a => a.group === 'develop')]
}

/** Shader's Recipe → Remix (spec §7.3). A mode chip; stage 5 gives it a worker. */
export const REMIX_ACTION: StudioAction = { id: 'remix', label: 'Remix…', group: 'develop', ai: true, lands: 'takes', run: { mode: 'Remix' } }

export function runStudioAction(a: StudioAction, prompt: Pick<StudioPromptApi, 'setMode' | 'runKind'> | null): void {
  const r = a.run
  if ('call' in r) { r.call(); return }
  if ('mode' in r) { prompt?.setMode(r.mode); return }
  void prompt?.runKind(r.kind, { fromMenu: true })
}
