import type { LocalLayer } from '~/composables/useCompositorLayers'

/** True when a layer was placed by a layout (rule, band, circle, …) rather than by the
 *  user. Any user edit clears `owner` (see `useLocalLayerEditor`), so an owned layer the
 *  user has touched reads as their own from then on. */
export const isOwned = (l: { owner?: { by: string } }) => l.owner?.by === 'layout'

/**
 * Merge a layout's owned pieces into the layer list: layers still owned by a layout
 * whose key is not in `wanted` are removed; a wanted key that already exists is updated
 * IN PLACE (same id, so undo, masks and motion references survive); a new key is
 * appended. User layers — and any layer whose owner was cleared by an edit — are
 * untouched and always kept.
 */
export function mergeOwned(layers: LocalLayer[], wanted: LocalLayer[]): LocalLayer[] {
  const wantedByKey = new Map<string, LocalLayer>()
  for (const w of wanted) {
    const key = (w as { owner?: { key: string } }).owner?.key
    if (key !== undefined) wantedByKey.set(key, w)
  }
  const seen = new Set<string>()
  const merged = layers.reduce<LocalLayer[]>((out, l) => {
    const key = isOwned(l) ? (l as { owner?: { key: string } }).owner?.key : undefined
    if (key === undefined) {
      // Not owned (or owner was cleared by an edit) — always kept, untouched.
      out.push(l)
      return out
    }
    const wantedLayer = wantedByKey.get(key)
    if (!wantedLayer) return out // owned, no longer wanted → drop
    seen.add(key)
    out.push({ ...wantedLayer, id: l.id } as LocalLayer) // update in place, keep id
    return out
  }, [])
  // A new piece's id (`layout-<key>`) can already be taken — by a piece the user edited (its
  // owner is cleared, its id stays), or by any other layer. Ids must stay unique: take the next
  // free `<id>-2`, `<id>-3`, … (the planner points the piece's op at whatever id it ends up with).
  const taken = new Set(merged.map(l => l.id))
  for (const w of wanted) {
    const key = (w as { owner?: { key: string } }).owner?.key
    if (key === undefined || seen.has(key)) continue
    let id = w.id
    for (let n = 2; taken.has(id); n++) id = `${w.id}-${n}`
    taken.add(id)
    merged.push(id === w.id ? w : ({ ...w, id } as LocalLayer))
  }
  return merged
}
