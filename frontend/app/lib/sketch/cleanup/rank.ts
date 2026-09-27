// app/lib/sketch/cleanup/rank.ts
// "Does this rule add anything?" A rule adds something when its Jacobian rows
// raise the rank of the rows the drawing already has (over the scalars that
// may move). An implied rule — or one that contradicts the others — does not.
import type { SketchDoc, SketchConstraint, EntityId } from '../model'
import { buildJacobian, type SlotRef } from '../jacobian'

/** An orthonormal basis of rows, grown one row at a time (modified
 *  Gram-Schmidt, done twice for stability). Rows are scaled to unit length
 *  before the test, so `tol` is relative. */
export class RowBasis {
  private readonly basis: Float64Array[] = []
  constructor(private readonly n: number, private readonly tol = 1e-7) {}
  get rank(): number { return this.basis.length }
  /** Adds the row when it is independent of the basis; true when it did. */
  add(row: ArrayLike<number>): boolean {
    let s = 0
    for (let i = 0; i < this.n; i++) s += (row[i] ?? 0) ** 2
    const n0 = Math.sqrt(s)
    if (n0 < 1e-12) return false
    const v = new Float64Array(this.n)
    for (let i = 0; i < this.n; i++) v[i] = (row[i] ?? 0) / n0
    for (let pass = 0; pass < 2; pass++) {
      for (const b of this.basis) {
        let d = 0
        for (let i = 0; i < this.n; i++) d += v[i]! * b[i]!
        if (d !== 0) for (let i = 0; i < this.n; i++) v[i] = v[i]! - d * b[i]!
      }
    }
    let r = 0
    for (let i = 0; i < this.n; i++) r += v[i]! * v[i]!
    r = Math.sqrt(r)
    if (r < this.tol) return false
    for (let i = 0; i < this.n; i++) v[i] = v[i]! / r
    this.basis.push(v)
    return true
  }
}

export function rankOf(rows: readonly ArrayLike<number>[], n: number): number {
  const b = new RowBasis(n)
  for (const r of rows) b.add(r)
  return b.rank
}

/** The solver's free scalars, with `held` points and circles held as well. */
export function freeSlots(doc: SketchDoc, held: ReadonlySet<EntityId>): SlotRef[] {
  const out: SlotRef[] = []
  for (const e of doc.entities) {
    if (e.kind === 'point') {
      if (!e.fixed && !held.has(e.id)) out.push({ kind: 'px', id: e.id }, { kind: 'py', id: e.id })
    } else if (e.kind === 'circle' && !held.has(e.id)) {
      out.push({ kind: 'r', id: e.id })
    }
  }
  return out
}

/** The Jacobian rows of `constraints` over `slots` (the analytic rows the solver uses). */
export function rowsFor(doc: SketchDoc, slots: SlotRef[], constraints: SketchConstraint[]): number[][] {
  return buildJacobian({ entities: doc.entities, constraints }, slots)
}
