// What a proposed change does to EXISTING nodes before it's approved (spec
// §3.2): a removal is only marked (dashed red), and an in-place edit keeps an
// undo, so Reject leaves the graph exactly as it was.
export function edgesTouching(edges: { id: unknown; source: unknown; target: unknown }[], nodeIds: string[]): string[] {
  const ids = new Set(nodeIds.map(String))
  return edges.filter(e => ids.has(String(e.source)) || ids.has(String(e.target))).map(e => String(e.id))
}

export class GhostRestores {
  private undo: (() => void)[] = []
  push(fn: () => void): void { this.undo.push(fn) }
  /** Undo every pending edit, newest first (Reject, or before a re-preview). */
  restore(): void {
    const list = this.undo.reverse()
    this.undo = []
    for (const fn of list) {
      try { fn() } catch (e) { console.warn('[proposal] restore failed', e) }
    }
  }
  /** Keep the edits (Approve). */
  clear(): void { this.undo = [] }
  get size(): number { return this.undo.length }
}

type SlotEdge = { target: unknown; targetHandle?: unknown; data?: any }

/** Make room in one input slot for a new wire (one link per input). A real wire
 *  drops the old edge at once. A proposed (ghost) wire only MARKS a real edge
 *  there (`data.removal`, dashed red) so Reject keeps it and Approve drops it;
 *  an earlier ghost into the same slot is simply replaced. Marks in place;
 *  returns the edges that stay. */
export function freeInputSlot<E extends SlotEdge>(edges: E[], targetId: string, handle: string, ghost: boolean): E[] {
  const inSlot = (e: E) => String(e.target) === targetId && e.targetHandle === handle
  if (!ghost) return edges.filter(e => !inSlot(e))
  const kept: E[] = []
  for (const e of edges) {
    if (!inSlot(e)) { kept.push(e); continue }
    if (e.data?.ghost) continue
    if (!e.data?.removal) e.data = { ...(e.data ?? {}), removal: true }
    kept.push(e)
  }
  return kept
}

/** Reject: clear every removal mark (the edges stay). */
export function clearRemovalMarks(edges: { data?: any }[]): void {
  for (const e of edges) if (e.data?.removal) e.data = { ...e.data, removal: false }
}

/** Approve: the edges a proposal marked for removal. */
export function removalEdgeIds(edges: { id: unknown; data?: any }[]): string[] {
  return edges.filter(e => e.data?.removal).map(e => String(e.id))
}

/** Add a class to a node's class string without replacing the others. */
export function addClass(cls: unknown, name: string): string {
  const list = String(cls ?? '').split(' ').filter(Boolean)
  return list.includes(name) ? list.join(' ') : [...list, name].join(' ')
}

/** Remove just that class; undefined when nothing is left. */
export function removeClass(cls: unknown, name: string): string | undefined {
  const rest = String(cls ?? '').split(' ').filter(c => c && c !== name)
  return rest.length ? rest.join(' ') : undefined
}
