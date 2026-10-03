// LC9 (a ruled difference for the family-off pins): Smart Layout read by an Image card is the runner's
// with `cards` on (its list goes into the card, eligibility.ts LIST_PASSERS); before, the runner left it
// to the engine (NEEDS_LOCAL_ENGINE), so the needs-engine list named it.
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { isLink } from '#shared/runner/graph'

/** Whether Smart Layout `id` is read by an Image card. */
function readByImageCard(p: ApiPrompt, id: string): boolean {
  return Object.values(p).some(n => n.class_type === 'Image' && isLink(n.inputs?.images) && (n.inputs.images as [string, number])[0] === id)
}

/** A graph holding a Smart Layout read by an Image card, with `cards` on. */
export function hasLc9SmartLayoutCard(p: ApiPrompt, families: ReadonlySet<RunnerFamily>): boolean {
  return families.has('cards') && Object.entries(p).some(([id, n]) => n.class_type === 'SmartLayout' && readByImageCard(p, id))
}

/** A needs-engine list that differs only by Smart Layouts read by an Image card, no longer named (`cards` on). */
export function onlyLc9SmartLayoutsMoved(p: ApiPrompt, families: ReadonlySet<RunnerFamily>, now: readonly string[], before: readonly string[]): boolean {
  if (!families.has('cards')) return false
  const gone = before.filter(x => !now.includes(x))
  const added = now.filter(x => !before.includes(x))
  return !added.length && gone.length > 0 && gone.every(id => p[id]?.class_type === 'SmartLayout' && readByImageCard(p, id))
}
