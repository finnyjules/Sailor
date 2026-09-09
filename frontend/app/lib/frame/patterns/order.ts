import type { LayerOp, FrameElements, Role } from './types'
import { localStackKey } from '~/lib/compositor/frameStack'

const ROLES: Role[] = ['title', 'details', 'caption', 'date']

/** Saved order for keys still present, then present newcomers appended on top —
 *  exactly what the Frame renderer does before painting. */
export function reconcileOrder(saved: string[], present: string[]): string[] {
  const p = new Set(present)
  const kept = saved.filter(k => p.has(k))
  const keptSet = new Set(kept)
  return [...kept, ...present.filter(k => !keptSet.has(k))]
}

/** Re-sort only the keys in `zByKey` by z (ascending = further behind), keeping
 *  ties in their current relative order, and re-using exactly the slots those
 *  keys occupy. Keys not in the map never move. */
export function orderWithZ(order: string[], zByKey: Map<string, number>): string[] {
  const slots: number[] = []
  const touched: string[] = []
  order.forEach((k, i) => { if (zByKey.has(k)) { slots.push(i); touched.push(k) } })
  const rank = new Map(order.map((k, i) => [k, i]))
  const sorted = [...touched].sort((a, b) => (zByKey.get(a)! - zByKey.get(b)!) || (rank.get(a)! - rank.get(b)!))
  const next = [...order]
  slots.forEach((slot, i) => { next[slot] = sorted[i]! })
  return next
}

/** Resolve an op's target to a stack key: a role via the inferred element, an
 *  inserted layer via the op's index, else a literal layer id. */
function keyForOp(op: LayerOp, idx: number, elements: FrameElements, inserted: Map<number, string>): string | undefined {
  const ins = inserted.get(idx)
  if (ins) return localStackKey(ins)
  if ((ROLES as string[]).includes(op.target)) {
    const el = elements[op.target as Role]
    return el ? localStackKey(el.id) : undefined
  }
  if (op.target === 'shape') return undefined       // sentinel with no inserted layer: nothing to order
  return localStackKey(op.target)
}

/** The next persisted draw order for a placement: reconcile, then honour z hints. */
export function nextOrderFor(
  saved: string[], present: string[], ops: LayerOp[], elements: FrameElements,
  insertedIdByOpIndex: Map<number, string>,
): string[] {
  const zByKey = new Map<string, number>()
  ops.forEach((op, i) => { const k = keyForOp(op, i, elements, insertedIdByOpIndex); if (k) zByKey.set(k, op.z ?? 0) })
  return orderWithZ(reconcileOrder(saved, present), zByKey)
}
