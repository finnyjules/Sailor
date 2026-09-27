import type { SketchDoc, EntityId, PointEntity, CircleEntity } from './model'
import { constraintResiduals } from './residuals'
import { solveLinear } from './linalg'
import { buildJacobian, buildJacobianSubstituted, buildJacobianSparse } from './jacobian'
import { normalGraph, rcmOrder, solveNormalSparse } from './sparse'
import { analyzeDerived, forwardSubstitute, buildEntityMap } from './substitute'

export interface DragTarget { point: EntityId; x: number; y: number }
export interface SolveOptions {
  maxIter?: number; tol?: number; drag?: DragTarget
  /** Asked before every step after the first: true ends the solve there, as
   *  if the iterations had run out (a drag's per-frame time budget). */
  outOfTime?: () => boolean
  /** Free params from which a step is solved sparsely (SPARSE_MIN_PARAMS). */
  sparseFrom?: number
}
export interface SolveResult { converged: boolean; iterations: number; residualNorm: number; timedOut?: boolean }

type Slot =
  | { kind: 'px'; id: EntityId; e: PointEntity }
  | { kind: 'py'; id: EntityId; e: PointEntity }
  | { kind: 'r'; id: EntityId; e: CircleEntity }

const W_REG = 1e-4

/** From this many free params (20 free points) on, each step is solved
 *  sparsely (see sparse.ts) and the solve stops once it stalls; below it the
 *  dense path runs exactly as it always has, so a small drawing's solve is
 *  unchanged to the last bit. */
export const SPARSE_MIN_PARAMS = 40
// a step "gains nothing" below this share of the residual; this many in a row
// ends a large drawing's solve
const STALL_REL = 1e-8
const STALL_STEPS = 3

// Which scalars are free to move. Fixed points, the dragged point, and DERIVED
// (copy) points are held. Captures the entity OBJECT reference per slot so
// later reads/writes skip the O(E) find. `derivedIds` is empty for non-repeat
// docs, making this identical to the pre-substitution slot set.
function buildSlots(doc: SketchDoc, held: Set<EntityId>, derivedIds: Set<EntityId>): Slot[] {
  const slots: Slot[] = []
  for (const e of doc.entities) {
    if (e.kind === 'point') {
      if (e.fixed || held.has(e.id) || derivedIds.has(e.id)) continue
      slots.push({ kind: 'px', id: e.id, e }, { kind: 'py', id: e.id, e })
    } else if (e.kind === 'circle') {
      slots.push({ kind: 'r', id: e.id, e })
    }
  }
  return slots
}

function readSlots(slots: Slot[]): number[] {
  return slots.map(s => (s.kind === 'px' ? s.e.x : s.kind === 'py' ? s.e.y : s.e.r))
}

function writeSlots(slots: Slot[], q: number[]): void {
  slots.forEach((s, i) => {
    if (s.kind === 'px') s.e.x = q[i]!
    else if (s.kind === 'py') s.e.y = q[i]!
    else s.e.r = q[i]!
  })
}

// Snapshot / restore all mutable scalars (for revert-on-failure).
function snapshot(doc: SketchDoc): Map<EntityId, number[]> {
  const m = new Map<EntityId, number[]>()
  for (const e of doc.entities) {
    if (e.kind === 'point') m.set(e.id, [e.x, e.y])
    else if (e.kind === 'circle') m.set(e.id, [e.r])
  }
  return m
}
function restore(doc: SketchDoc, snap: Map<EntityId, number[]>): void {
  for (const e of doc.entities) {
    const v = snap.get(e.id); if (!v) continue
    if (e.kind === 'point') { e.x = v[0]!; e.y = v[1]! }
    else if (e.kind === 'circle') { e.r = v[0]! }
  }
}

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0))

export function solve(doc: SketchDoc, opts: SolveOptions = {}): SolveResult {
  const maxIter = opts.maxIter ?? 60
  const tol = opts.tol ?? 1e-6
  const snap = snapshot(doc)

  const held = new Set<EntityId>()
  if (opts.drag) {
    held.add(opts.drag.point)
    const p = doc.entities.find(x => x.id === opts.drag!.point) as any
    if (p && p.kind === 'point') { p.x = opts.drag.x; p.y = opts.drag.y }
  }

  // Copy-point substitution: pull rotate/mirror copies out of the free set.
  // For non-repeat docs `rules` is empty and everything below degenerates to
  // the original solver path (no derived slots, no excluded constraints, the
  // forward-substitution and column-chaining are no-ops).
  const { rules, order, excluded } = analyzeDerived(doc, held)
  const derivedIds = new Set(rules.keys())
  const emap = buildEntityMap(doc)
  // The residual set the solver actually optimizes: all constraints EXCEPT the
  // defining rules of derived points (those are satisfied exactly by forward
  // substitution). Same array reference when nothing is excluded → identical.
  const activeConstraints = excluded.size ? doc.constraints.filter(c => !excluded.has(c.id)) : doc.constraints
  const activeDoc: SketchDoc = { entities: doc.entities, constraints: activeConstraints }

  const slots = buildSlots(doc, held, derivedIds)
  const q0 = readSlots(slots)     // reference for regularization (warm start)
  let q = q0.slice()
  const n = slots.length

  // full residual vector at parameter q: hard constraints + regularization.
  // Writes the free params, forward-substitutes derived points to their exact
  // rule positions, then scores the FILTERED constraint set. Returns the
  // hard-residual length alongside the combined vector so callers can slice out
  // the hard-only part instead of re-evaluating constraintResiduals.
  const residualAt = (qv: number[]): { combined: number[]; hardLen: number } => {
    writeSlots(slots, qv)
    if (order.length) forwardSubstitute(emap, order, rules)
    const hard = constraintResiduals(activeDoc)
    const reg = qv.map((v, i) => W_REG * (v - q0[i]!))
    return { combined: [...hard, ...reg], hardLen: hard.length }
  }

  let lambda = 1e-3
  let iterations = 0
  const sparse = n >= (opts.sparseFrom ?? SPARSE_MIN_PARAMS)
  let timedOut = false
  let fillOrder: number[] | null = null   // the sparse fill order, found once per solve
  let flat = 0                            // steps in a row that gained nothing (large drawings)
  let rNorm = norm(residualAt(q).combined)

  if (n === 0) {
    if (order.length) forwardSubstitute(emap, order, rules)
    const hn = norm(constraintResiduals(activeDoc))
    const converged = hn < 1e-3
    if (!converged) restore(doc, snap)
    return { converged, iterations: 0, residualNorm: hn }
  }

  for (let iter = 0; iter < maxIter; iter++) {
    if (iter > 0 && opts.outOfTime?.()) { timedOut = true; break }
    iterations = iter + 1
    const r0 = residualAt(q)
    const r = r0.combined
    rNorm = norm(r)
    // break on the HARD residual only — the regularization term keeps the
    // combined norm above tol forever once points have moved from q0.
    // The hard residuals are the first r0.hardLen entries of r (computed
    // in the same residualAt call above — no need to re-evaluate).
    const hardNorm = norm(r.slice(0, r0.hardLen))
    if (hardNorm < tol) break

    // analytic Jacobian J (m x n): closed-form partials for the hard
    // constraints (see jacobian.ts) plus the regularization rows
    // (∂reg_j/∂q_j = W_REG, diagonal) — same structure the old
    // finite-difference Jacobian produced, just computed without probing.
    // doc's entities already hold q (residualAt(q) above wrote them via
    // writeSlots before evaluating constraintResiduals), so buildJacobian
    // reads the correct state directly.
    let delta: number[] | null
    if (sparse) {
      // the same step, sparsely: J's rows carry only their nonzero columns,
      // the regularization rows are the diagonal W_REG² term
      const rows = buildJacobianSparse(doc, slots, activeConstraints, rules)
      const g = new Array<number>(n).fill(0)
      rows.forEach(({ cols, vals }, i) => {
        const ri = r[i]!
        for (let k = 0; k < cols.length; k++) g[cols[k]!]! += vals[k]! * ri
      })
      for (let j = 0; j < n; j++) g[j] = -(g[j]! + W_REG * r[r0.hardLen + j]!)
      fillOrder ??= rcmOrder(normalGraph(rows, n))
      delta = solveNormalSparse(rows, n, lambda + W_REG * W_REG, g, fillOrder)
    } else {
      const m = r.length
      // Substituted analytic Jacobian over the free (base) slots. With no derived
      // points this is identical to buildJacobian(doc, slots) over doc.constraints.
      const J: number[][] = derivedIds.size
        ? buildJacobianSubstituted(doc, slots, activeConstraints, rules)
        : buildJacobian(doc, slots) // fresh array each call — safe to extend in place
      for (let j = 0; j < n; j++) {
        const row = new Array(n).fill(0)
        row[j] = W_REG
        J.push(row)
      }

      // Gauss-Newton normal equations with LM damping: (JᵀJ + λI) δ = −Jᵀr
      const JtJ: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
      const Jtr: number[] = new Array(n).fill(0)
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          let s = 0
          for (let i = 0; i < m; i++) s += J[i]![a]! * J[i]![b]!
          JtJ[a]![b] = s + (a === b ? lambda : 0)
        }
        let s = 0
        for (let i = 0; i < m; i++) s += J[i]![a]! * r[i]!
        Jtr[a] = -s
      }

      delta = solveLinear(JtJ, Jtr)
    }
    if (!delta) { lambda *= 10; continue }

    const qNew = q.map((v, i) => v + delta[i]!)
    const rNew = norm(residualAt(qNew).combined)
    // a large drawing stops once it is solved and no step gains anything:
    // the rules can sit a hair above tol for good (the regularization pulls
    // the other way), and the dense path would spend every remaining
    // iteration on sub-nanometre steps
    if (sparse) flat = rNorm - rNew > STALL_REL * rNorm ? 0 : flat + 1
    if (rNew < rNorm) { q = qNew; lambda = Math.max(lambda * 0.5, 1e-9) } // accept, less damping
    else { lambda *= 4 }                                                  // reject, more damping
    writeSlots(slots, q)
    if (flat >= STALL_STEPS && hardNorm < 1e-3) break
  }

  writeSlots(slots, q)
  const final = residualAt(q)
  rNorm = norm(final.combined.slice(0, final.hardLen)) // report HARD residual only
  const converged = rNorm < 1e-3
  if (!converged) restore(doc, snap)
  return { converged, iterations, residualNorm: rNorm, ...(timedOut ? { timedOut } : {}) }
}
