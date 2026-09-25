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
