import type { LocalLayer } from '~/composables/useCompositorLayers'
import { ancestorsOf, type LayerGroup } from '~/lib/compositor/layerGroups'

// Pins and layouts: a layout is a new arrangement, so every layer it moves (and every group
// around such a layer) loses its explicit viewing-size pins. Shared by the kit's apply
// (`kit/plan.ts`) and its tests; lives on its own so nothing here imports the planner.

const PLACEMENT_KEYS = ['x', 'y', 'w', 'h', 'boxW', 'boxH', 'fontSize', 'rotation', 'scale'] as const
function placementChanged(p: Record<string, unknown>, cur: Record<string, unknown>): boolean {
  return PLACEMENT_KEYS.some(k => p[k] !== cur[k])
}
/** A pattern is a new arrangement: any layer it moved loses its explicit pins (spec, "Editing at a
 *  viewing size"). Unmoved and new layers come back by reference. */
export function clearPinsOfMoved(before: LocalLayer[], after: LocalLayer[]): LocalLayer[] {
  const prev = new Map(before.map(l => [l.id, l as unknown as Record<string, unknown>]))
  return after.map((l) => {
    const p = prev.get(l.id)
    if (!p || !(l as { pins?: unknown }).pins) return l
    if (!placementChanged(p, l as unknown as Record<string, unknown>)) return l
    const { pins: _drop, ...rest } = l as LocalLayer & { pins?: unknown }
    return rest as LocalLayer
  })
}
/** The group side of `clearPinsOfMoved`: every group that encloses a layer the pattern moved (its
 *  own group and each one above it, up to the outermost, where the resolver reads group pins) loses
 *  its pins. An inner group's pins would come back into force if it were ever ungrouped out.
 *  Null when nothing changes. */
export function clearGroupPinsOfMoved(before: LocalLayer[], after: LocalLayer[], groups: LayerGroup[]): LayerGroup[] | null {
  if (!groups.some(g => g.pins)) return null
  const prev = new Map(before.map(l => [l.id, l as unknown as Record<string, unknown>]))
  const hit = new Set<string>()
  for (const l of after) {
    const p = prev.get(l.id)
    if (!p || !l.groupId || !placementChanged(p, l as unknown as Record<string, unknown>)) continue
    hit.add(l.groupId)
    for (const a of ancestorsOf(l.groupId, groups)) hit.add(a)
  }
  let changed = false
  const out = groups.map((g) => {
    if (!g.pins || !hit.has(g.id)) return g
    changed = true
    const { pins: _drop, ...rest } = g
    return rest as LayerGroup
  })
  return changed ? out : null
}
