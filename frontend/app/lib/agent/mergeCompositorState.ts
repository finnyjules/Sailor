// The compositor agent works on a SNAPSHOT of the frame taken when the user asked, and replays
// that snapshot (+ the accepted changes) on every accept / reject / revert. Pushing it back
// wholesale would overwrite anything the user edited while the proposal was open. So every push
// is a three-way merge: `base` = the state the agent last pushed (its view of the doc),
// `next` = the state it wants now, `current` = the live doc. Only the agent's DELTA
// (base → next) is applied onto `current`. With no user edits in between, the result is `next`.
import type { CompositorState } from './surfaces/compositor'

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function mergeCompositorState(current: CompositorState, base: CompositorState, next: CompositorState): CompositorState {
  // Fast path — nothing changed under the agent: exactly the old behaviour.
  if (same(current.layers, base.layers)) {
    return { ...next, ...mergeDocFields(current, base, next) }
  }
  const baseById = new Map(base.layers.map((l) => [l.id, l]))
  const nextById = new Map(next.layers.map((l) => [l.id, l]))
  const currentIds = new Set(current.layers.map((l) => l.id))
  // Agent delta: layers it changed or added, and layers it removed.
  const changed = new Set(next.layers.filter((l) => !same(l, baseById.get(l.id))).map((l) => l.id))
  const removed = new Set(base.layers.filter((l) => !nextById.has(l.id)).map((l) => l.id))

  let layers = current.layers
    .filter((l) => !removed.has(l.id))
    .map((l) => (changed.has(l.id) ? nextById.get(l.id)! : l))
  // Layers the agent ADDED (not in base). A changed layer the user deleted stays deleted.
  const added = next.layers.filter((l) => !baseById.has(l.id) && !currentIds.has(l.id))
  layers = [...layers, ...added]

  // An agent re-order (relative order of the layers it kept) applies; layers only the user
  // has (added meanwhile) keep their place on top.
  const kept = (s: CompositorState) => s.layers.map((l) => l.id).filter((id) => baseById.has(id) && nextById.has(id))
  if (!same(kept(base), kept(next))) {
    const rank = new Map(next.layers.map((l, i) => [l.id, i]))
    const known = layers.filter((l) => rank.has(l.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
    layers = [...known, ...layers.filter((l) => !rank.has(l.id))]
  }
  return { ...next, layers, ...mergeDocFields(current, base, next) }
}

/** Whole-doc fields: take the agent's value only when the agent changed it. */
function mergeDocFields(current: CompositorState, base: CompositorState, next: CompositorState) {
  const pick = <K extends keyof CompositorState>(k: K): CompositorState[K] => (same(next[k], base[k]) ? current[k] : next[k])
  return { background: pick('background'), postEffects: pick('postEffects'), grid: pick('grid'), groups: pick('groups'), templates: pick('templates') }
}
