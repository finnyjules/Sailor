// Sparse normal-equation solve for the sketch solver's large drawings.
// Solves (JᵀJ + d·I) x = g where J arrives as sparse rows. JᵀJ + d·I is
// symmetric positive definite (d > 0), so: reorder the params with reverse
// Cuthill–McKee (neighbours in the drawing end up near each other in the
// order), factor in envelope (skyline) form with Cholesky, and
// back-substitute. A drawing's params only couple through the rules that
// share them, so the envelope stays narrow — a ring or a grid of a few
// hundred params factors in about a millisecond, where the dense Gaussian
// elimination it replaces is O(n³).

import type { SparseRow } from './jacobian'

/** Reverse Cuthill–McKee order of an undirected graph: `order[k]` is the
 *  node placed k-th. Each component starts from a least-connected node. */
export function rcmOrder(adj: number[][]): number[] {
  const n = adj.length
  const deg = adj.map(a => a.length)
  const seen = new Uint8Array(n)
  const out: number[] = []
  const byDeg = Array.from({ length: n }, (_, i) => i).sort((a, b) => deg[a]! - deg[b]! || a - b)
  for (const s of byDeg) {
    if (seen[s]) continue
    seen[s] = 1
    const start = out.length
    out.push(s)
    for (let h = start; h < out.length; h++) {
      const next = adj[out[h]!]!.filter(v => !seen[v]).sort((a, b) => deg[a]! - deg[b]! || a - b)
      for (const v of next) { seen[v] = 1; out.push(v) }
    }
  }
  return out.reverse()
}

/** The sparsity graph of JᵀJ: two params are neighbours when a row reads both. */
export function normalGraph(rows: readonly SparseRow[], n: number): number[][] {
  const sets = Array.from({ length: n }, () => new Set<number>())
  for (const { cols } of rows) {
    for (let a = 0; a < cols.length; a++) {
      for (let b = a + 1; b < cols.length; b++) {
        const i = cols[a]!, j = cols[b]!
        if (i !== j) { sets[i]!.add(j); sets[j]!.add(i) }
      }
    }
  }
  return sets.map(s => [...s])
}

/** Solves (JᵀJ + diag·I) x = g for the sparse rows of J. `order` is a fill
 *  order from rcmOrder over normalGraph(rows). Null when a pivot is not
 *  safely positive (the caller damps harder and retries, as for the dense
 *  solve). */
export function solveNormalSparse(rows: readonly SparseRow[], n: number, diag: number, g: readonly number[], order: readonly number[]): number[] | null {
  const pos = new Int32Array(n)
  order.forEach((v, k) => { pos[v] = k })

  // envelope: row k of the permuted matrix stores columns first[k]..k
  const first = new Int32Array(n)
  for (let k = 0; k < n; k++) first[k] = k
  for (const { cols } of rows) {
    let lo = n
    for (const c of cols) lo = Math.min(lo, pos[c]!)
    for (const c of cols) { const k = pos[c]!; if (lo < first[k]!) first[k] = lo }
  }
  const off = new Int32Array(n + 1)
  for (let k = 0; k < n; k++) off[k + 1] = off[k]! + (k - first[k]! + 1)
  const L = new Float64Array(off[n]!)

  // assemble the lower triangle of JᵀJ + diag·I
  for (const { cols, vals } of rows) {
    for (let a = 0; a < cols.length; a++) {
      const ka = pos[cols[a]!]!, oa = off[ka]! - first[ka]!
      for (let b = 0; b < cols.length; b++) {
        const kb = pos[cols[b]!]!
        if (kb <= ka) L[oa + kb] = L[oa + kb]! + vals[a]! * vals[b]!
      }
    }
  }
  for (let k = 0; k < n; k++) { const d = off[k + 1]! - 1; L[d] = L[d]! + diag }

  // envelope Cholesky, row by row: L·Lᵀ = A
  for (let i = 0; i < n; i++) {
    const fi = first[i]!, oi = off[i]! - fi
    for (let j = fi; j <= i; j++) {
      const fj = first[j]!, oj = off[j]! - fj
      let s = L[oi + j]!
      for (let k = Math.max(fi, fj); k < j; k++) s -= L[oi + k]! * L[oj + k]!
      if (j < i) L[oi + j] = s / L[oj + j]!
      else {
        if (!(s > 1e-12)) return null
        L[oi + i] = Math.sqrt(s)
      }
    }
  }

  // L y = P g, then Lᵀ z = y, x = Pᵀ z
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const fi = first[i]!, oi = off[i]! - fi
    let s = g[order[i]!]!
    for (let k = fi; k < i; k++) s -= L[oi + k]! * y[k]!
    y[i] = s / L[oi + i]!
  }
  for (let i = n - 1; i >= 0; i--) {
    const fi = first[i]!, oi = off[i]! - fi
    const yi = y[i]! / L[oi + i]!
    y[i] = yi
    for (let k = fi; k < i; k++) y[k] = y[k]! - L[oi + k]! * yi
  }
  const x = new Array<number>(n)
  for (let k = 0; k < n; k++) x[order[k]!] = y[k]!
  return x
}
