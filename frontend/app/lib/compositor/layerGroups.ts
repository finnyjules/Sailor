/**
 * Nested layer groups for the Compositor / Frame.
 *
 * DESIGN — additive on top of the existing flat grouping, so saved frames keep
 * working with no migration:
 *   - A layer's IMMEDIATE group is still `layer.groupId` (unchanged, one id).
 *   - Nesting is described by a separate registry of `LayerGroup { id, name?,
 *     parentId? }`, persisted on the node as `sailor_localGroups`. A group's
 *     place in the tree comes from `parentId`; a group with no `parentId` (or no
 *     registry entry at all) is a root.
 *   - So when a group gets nested, only the PARENT link changes — member layers
 *     never have their `groupId` rewritten. Old frames (layers with `groupId`
 *     but no registry) simply read as a flat set of root groups.
 *
 * Group names live in the registry going forward; `layer.groupName` (mirrored on
 * members by the old code) is read as a fallback so pre-registry frames still
 * show their names.
 *
 * Rendering never consults any of this — the paint stack is a flat ordered array
 * — so groups are purely an editor/organization concern.
 */

export interface LayerGroup {
  id: string
  name?: string
  parentId?: string
  opacity?: number   // 0..1 group multiplier (cascades to descendants)
  hidden?: boolean   // group hidden ⇒ all descendants hidden
  locked?: boolean   // group locked ⇒ all descendants not selectable on canvas
  /** Expressive arrangement: members are scattered (baked x/y/rotation) within
   *  `expressiveBox`. Present ⇒ the group's Expressive panel is "On". */
  expressive?: import('~~/shared/text-layout/boxes').ExpressiveBoxParams
  /** Snapshotted container box (top-left fractions: x/W, y/H, w/W, h/H) the
   *  scatter happens within — frozen on enable so rerolls don't drift. */
  expressiveBox?: { x: number; y: number; w: number; h: number }
  /** Responsive Frames: the group's pins (a free group adapts as one rigid unit).
   *  Absent ⇒ automatic. See lib/frame/responsive. */
  pins?: import('~/lib/frame/responsive/types').Pins
}

/** The minimal layer shape these helpers need (a LocalLayer satisfies it). */
export interface GroupableLayer {
  id: string
  groupId?: string
  groupName?: string
}

/** Registry lookup by id. */
function byId(groups: LayerGroup[]): Map<string, LayerGroup> {
  return new Map(groups.map(g => [g.id, g]))
}

/** Every group id in play — union of registry ids and ids referenced by layers.
 *  (Layers can reference a group that has no registry entry: an implicit/legacy
 *  flat group.) */
export function allGroupIds(layers: GroupableLayer[], groups: LayerGroup[]): string[] {
  const s = new Set<string>()
  for (const g of groups) s.add(g.id)
  for (const l of layers) if (l.groupId) s.add(l.groupId)
  return [...s]
}

/** Immediate parent group id, or undefined for a root. Registry-only. */
export function parentOf(id: string, groups: LayerGroup[]): string | undefined {
  return byId(groups).get(id)?.parentId
}

/** Ancestor group ids from nearest parent → root. Cycle-guarded. */
export function ancestorsOf(id: string, groups: LayerGroup[]): string[] {
  const map = byId(groups)
  const out: string[] = []
  const seen = new Set<string>([id])
  let p = map.get(id)?.parentId
  while (p && !seen.has(p)) {
    out.push(p)
    seen.add(p)
    p = map.get(p)?.parentId
  }
  return out
}

export interface GroupCascade { opacity: number; hidden: boolean; locked: boolean }

/** Resolve the effective group contribution for a layer's immediate group:
 *  opacity multiplied, hidden/locked OR-ed, across the group + all ancestors. */
export function resolveGroupCascade(groupId: string | undefined, groups: LayerGroup[]): GroupCascade {
  const out: GroupCascade = { opacity: 1, hidden: false, locked: false }
  if (!groupId) return out
  const map = byId(groups)
  for (const id of [groupId, ...ancestorsOf(groupId, groups)]) {
    const g = map.get(id)
    if (!g) continue
    if (typeof g.opacity === 'number') out.opacity *= g.opacity
    if (g.hidden) out.hidden = true
    if (g.locked) out.locked = true
  }
  return out
}

/** Update a group's registry entry (or append one), preserving other fields. Pure. */
export function upsertGroup(groups: LayerGroup[], groupId: string, patch: Partial<LayerGroup>): LayerGroup[] {
  let found = false
  const out = groups.map(g => (g.id === groupId ? (found = true, { ...g, ...patch }) : g))
  if (!found) out.push({ id: groupId, ...patch })
  return out
}

/** Outermost ancestor of `id` (or `id` itself when it has no parent). */
export function topGroupOf(id: string, groups: LayerGroup[]): string {
  const anc = ancestorsOf(id, groups)
  return anc[anc.length - 1] ?? id
}

/** Nesting depth (0 for a root group). */
export function groupDepth(id: string, groups: LayerGroup[]): number {
  return ancestorsOf(id, groups).length
}

/** Direct child group ids of `id` (registry order). */
export function childGroupIds(id: string, groups: LayerGroup[]): string[] {
  return groups.filter(g => g.parentId === id).map(g => g.id)
}

/** All group ids nested anywhere under `id` (excludes `id`). Cycle-guarded. */
export function descendantGroupIds(id: string, groups: LayerGroup[]): string[] {
  const out: string[] = []
  const stack = [id]
  const seen = new Set<string>([id])
  while (stack.length) {
    const cur = stack.pop()!
    for (const c of childGroupIds(cur, groups)) {
      if (seen.has(c)) continue
      seen.add(c)
      out.push(c)
      stack.push(c)
    }
  }
  return out
}

/** Layer ids whose IMMEDIATE group is `id`. */
export function directLayerIds(id: string, layers: GroupableLayer[]): string[] {
  return layers.filter(l => l.groupId === id).map(l => l.id)
}

/** All layer ids under `id`, including those in descendant groups. */
export function layersInGroup(id: string, layers: GroupableLayer[], groups: LayerGroup[]): string[] {
  const ids = new Set<string>([id, ...descendantGroupIds(id, groups)])
  return layers.filter(l => l.groupId && ids.has(l.groupId)).map(l => l.id)
}

/** Whether `id` is `ancestor` or nested under it. */
export function isDescendantOrSelf(id: string, ancestor: string, groups: LayerGroup[]): boolean {
  return id === ancestor || ancestorsOf(id, groups).includes(ancestor)
}

/** Display name: registry name, else any member layer's mirrored groupName, else 'Group'. */
export function groupDisplayName(id: string, layers: GroupableLayer[], groups: LayerGroup[]): string {
  const reg = byId(groups).get(id)?.name
  if (reg && reg.trim()) return reg
  const legacy = layers.find(l => l.groupId === id && l.groupName)?.groupName
  return (legacy && legacy.trim()) || 'Group'
}

/**
 * Create a new group `newId` from the current selection.
 *   - Existing groups that are FULLY selected are reparented under `newId`
 *     (their member layers are left untouched).
 *   - Loose selected layers — and selected layers pulled out of a
 *     partially-selected group — become direct members of `newId`.
 * Returns the next layers + registry. Caller guards for a ≥2 selection.
 */
export function createGroupFromSelection(
  layers: GroupableLayer[],
  groups: LayerGroup[],
  selectedIds: Set<string>,
  newId: string,
): { layers: GroupableLayer[]; groups: LayerGroup[] } {
  const nestedTops = new Set<string>()
  const pull = new Set<string>()
  for (const l of layers) {
    if (!selectedIds.has(l.id)) continue
    if (!l.groupId) { pull.add(l.id); continue }
    const top = topGroupOf(l.groupId, groups)
    const members = layersInGroup(top, layers, groups)
    if (members.length && members.every(m => selectedIds.has(m))) nestedTops.add(top)
    else pull.add(l.id) // partial group → pull this layer out into the new group
  }
  if (!nestedTops.size && !pull.size) return { layers, groups }

  let outGroups: LayerGroup[] = [...groups]
  if (!outGroups.some(g => g.id === newId)) outGroups.push({ id: newId })
  outGroups = outGroups.map(g => (nestedTops.has(g.id) ? { ...g, parentId: newId } : g))
  // Implicit (registry-less) groups being nested need an entry to carry parentId.
  for (const t of nestedTops) {
    if (!outGroups.some(g => g.id === t)) outGroups.push({ id: t, parentId: newId })
  }
  const outLayers = layers.map(l => (pull.has(l.id) ? { ...l, groupId: newId } : l))
  return { layers: outLayers, groups: outGroups }
}

/**
 * Dissolve a single group level: its direct member layers and its child groups
 * are promoted to `groupId`'s parent (or become roots). The group's registry
 * entry is removed.
 */
export function dissolveGroup(
  layers: GroupableLayer[],
  groups: LayerGroup[],
  groupId: string,
): { layers: GroupableLayer[]; groups: LayerGroup[] } {
  const parent = parentOf(groupId, groups) // undefined ⇒ promote to root
  const outLayers = layers.map(l => {
    if (l.groupId !== groupId) return l
    if (parent) return { ...l, groupId: parent }
    const { groupId: _g, groupName: _n, ...rest } = l as any
    return rest as GroupableLayer
  })
  const outGroups = groups
    .filter(g => g.id !== groupId)
    .map(g => (g.parentId === groupId ? { ...g, parentId: parent } : g))
  return { layers: outLayers, groups: outGroups }
}

/** Set/clear a group's display name in the registry (creating an entry if needed). */
export function renameGroup(groups: LayerGroup[], groupId: string, name: string): LayerGroup[] {
  const nm = name.trim() || undefined
  let found = false
  const out = groups.map(g => {
    if (g.id !== groupId) return g
    found = true
    return { ...g, name: nm }
  })
  if (!found) out.push({ id: groupId, name: nm })
  return out
}

/**
 * Re-parent `groupId` under `newParentId` (or make it a root when undefined).
 * No-op if it would create a cycle (parenting a group under itself/a descendant).
 * Creates a registry entry for an implicit group if needed.
 */
export function reparentGroup(
  groups: LayerGroup[],
  groupId: string,
  newParentId: string | undefined,
): LayerGroup[] {
  if (newParentId && isDescendantOrSelf(newParentId, groupId, groups)) return groups
  let found = false
  const out = groups.map(g => {
    if (g.id !== groupId) return g
    found = true
    return { ...g, parentId: newParentId }
  })
  if (!found) out.push({ id: groupId, parentId: newParentId })
  return out
}

/**
 * Drop empty groups: a registry entry with no descendant layers AND no surviving
 * child groups. Iterated so a chain of now-empty ancestors is cleaned in one go.
 * Keeps the registry from accumulating dead entries after deletes/ungroups.
 */
export function pruneEmptyGroups(layers: GroupableLayer[], groups: LayerGroup[]): LayerGroup[] {
  let cur = groups
  for (;;) {
    const keep = cur.filter(g =>
      layersInGroup(g.id, layers, cur).length > 0 || childGroupIds(g.id, cur).length > 0)
    if (keep.length === cur.length) return keep
    cur = keep
  }
}
