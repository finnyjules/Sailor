// tests/unit/sketch-solve-sparse.unit.spec.ts
// Large connected drawings solve sparsely (sparse.ts) and stop once they
// stall: a drag on a 160-piece tangent ring or a 144-piece grid is a few ms
// (was ~37 s and ~30 ms dense), the answer matches the dense solve, a small
// drawing still takes the dense path bit for bit, and a drag's time budget
// ends a solve early.
import { describe, it, expect } from 'vitest'
import { performance } from 'node:perf_hooks'
import type { SketchDoc, PointEntity } from '~/lib/sketch/model'
import { addPoint, addPath, addLine, addCircle, addConstraint } from '~/lib/sketch/edit'
import { solve, SPARSE_MIN_PARAMS } from '~/lib/sketch/solve'
import { solveLinear } from '~/lib/sketch/linalg'
import { normalGraph, rcmOrder, solveNormalSparse } from '~/lib/sketch/sparse'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { cloneDoc } from '~/lib/sketch/clone'

// N rounded corners: one closed path of N arcs and N lines, each line tangent
// to both arcs it joins (the pen's joint rules), every arc true (equalDist)
function tangentRing(N: number, R: number, rho: number): { d: SketchDoc; drag: string } {
  const d: SketchDoc = { entities: [], constraints: [] }
  const th = (k: number) => (k / N) * Math.PI * 2
  const nrm = (k: number) => { const a = (th(k) + th(k + 1)) / 2; return { x: Math.cos(a), y: Math.sin(a) } }
  const C: string[] = [], S: string[] = [], E: string[] = []
  for (let k = 0; k < N; k++) {
    const cx = (R - rho) * Math.cos(th(k)), cy = (R - rho) * Math.sin(th(k))
    const a = nrm((k - 1 + N) % N), b = nrm(k)
    C.push(addPoint(d, cx, cy))
    S.push(addPoint(d, cx + rho * a.x, cy + rho * a.y))
    E.push(addPoint(d, cx + rho * b.x, cy + rho * b.y))
  }
  const anchors: string[] = [], segs: any[] = []
  for (let k = 0; k < N; k++) { anchors.push(S[k]!, E[k]!); segs.push({ kind: 'arc', center: C[k], sweep: 1 }, { kind: 'line' }) }
  addPath(d, anchors, segs, true)
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N
    addConstraint(d, 'tangentLineArc', [E[k]!, S[k1]!, C[k]!, E[k]!])
    addConstraint(d, 'tangentLineArc', [E[k]!, S[k1]!, C[k1]!, S[k1]!])
  }
  return { d, drag: S[0]! }
}
// n×n points joined by lines, each held horizontal or vertical
function grid(n: number): { d: SketchDoc; drag: string } {
  const d: SketchDoc = { entities: [], constraints: [] }
  const P = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => addPoint(d, j * 2, i * 2)))
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (j + 1 < n) { addLine(d, P[i]![j]!, P[i]![j + 1]!); addConstraint(d, 'horizontal', [P[i]![j]!, P[i]![j + 1]!]) }
    if (i + 1 < n) { addLine(d, P[i]![j]!, P[i + 1]![j]!); addConstraint(d, 'vertical', [P[i]![j]!, P[i + 1]![j]!]) }
  }
  return { d, drag: P[n >> 1]![n >> 1]! }
}
// the fills suites' ring: a circle, 64 petals of two arcs, 32 spokes (161 pieces)
function petalRing(): { d: SketchDoc; drag: string } {
  const d: SketchDoc = { entities: [], constraints: [] }
  const O = addPoint(d, 0, 0); addCircle(d, O, 10)
  let drag = ''
  for (let k = 0; k < 64; k++) {
    const a0 = (k / 64) * Math.PI * 2, a1 = ((k + 2) / 64) * Math.PI * 2, am = (a0 + a1) / 2
    const s = addPoint(d, 10 * Math.cos(a0), 10 * Math.sin(a0)), e = addPoint(d, 10 * Math.cos(a1), 10 * Math.sin(a1))
    addPath(d, [s, e], [
      { kind: 'arc', center: addPoint(d, 9 * Math.cos(am), 9 * Math.sin(am)), sweep: 1 },
      { kind: 'arc', center: addPoint(d, 14 * Math.cos(am), 14 * Math.sin(am)), sweep: 1 },
    ], true)
    if (k % 2 === 0) addLine(d, O, s)
    if (k === 0) drag = s
  }
  return { d, drag }
}

const pieces = (d: SketchDoc) => d.entities.filter(e => e.kind !== 'point').reduce((n, e) => n + (e.kind === 'path' ? e.segments.length : 1), 0)
const pt = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as PointEntity
const hardNorm = (d: SketchDoc) => Math.hypot(...constraintResiduals(d))
const coords = (d: SketchDoc) => d.entities.flatMap(e => (e.kind === 'point' ? [e.x, e.y] : e.kind === 'circle' ? [e.r] : []))

// eight drags round the point, a hair each (the pen solves every pointermove
// from the last frame); the best mean of three rounds — a loaded machine
// stalls single runs
function timeDrags(d: SketchDoc, drag: string): { ms: number; iterations: number } {
  const p = pt(d, drag), x0 = p.x, y0 = p.y
  solve(d, { maxIter: 120, drag: { point: drag, x: x0, y: y0 } })   // JIT warm-up
  let best = Infinity, iterations = 0
  for (let round = 0; round < 3; round++) {
    const t = performance.now()
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const r = solve(d, { maxIter: 120, drag: { point: drag, x: x0 + 0.1 * Math.cos(a), y: y0 + 0.1 * Math.sin(a) } })
      expect(r.converged).toBe(true)
      iterations = Math.max(iterations, r.iterations)
    }
    best = Math.min(best, (performance.now() - t) / 8)
  }
  return { ms: best, iterations }
}

describe('sparse normal equations', () => {
  it('solve (JᵀJ + dI) x = g as the dense elimination does', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
    const n = 30
    const rows = Array.from({ length: 50 }, () => {
      const cols = [...new Set([0, 1, 2, 3].map(() => Math.floor(((rnd() + 1) / 2) * n)))]
      return { cols, vals: cols.map(() => rnd()) }
    })
    const g = Array.from({ length: n }, rnd)
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1e-3 : 0)))
    for (const { cols, vals } of rows) cols.forEach((a, i) => cols.forEach((b, j) => { A[a]![b]! += vals[i]! * vals[j]! }))
    const dense = solveLinear(A, g)!
    const sparse = solveNormalSparse(rows, n, 1e-3, g, rcmOrder(normalGraph(rows, n)))!
    sparse.forEach((v, i) => expect(v).toBeCloseTo(dense[i]!, 8))
  })
  it('reverse Cuthill–McKee visits every param once, across separate parts', () => {
    const adj = [[1], [0, 2], [1], [4], [3], []]
    expect([...rcmOrder(adj)].sort()).toEqual([0, 1, 2, 3, 4, 5])
  })
  it('refuse a matrix that is not positive definite', () => {
    expect(solveNormalSparse([], 3, 0, [1, 2, 3], [0, 1, 2])).toBeNull()
  })
})

describe('solve — large connected drawings', () => {
  it('a drag on a 160-piece tangent ring is a few ms (was ~37 s) and keeps every rule', () => {
    const { d, drag } = tangentRing(80, 20, 1.5)
    expect(pieces(d)).toBe(160)
    const { ms, iterations } = timeDrags(d, drag)
    // eslint-disable-next-line no-console
    console.log(`[solve sparse] 160-piece tangent ring drag: ${ms.toFixed(2)} ms, ≤${iterations} iterations`)
    expect(iterations).toBeLessThan(60)   // stops once stalled, not at maxIter
    expect(ms).toBeLessThan(60)           // measured ~13 ms; ~37 s dense
    expect(hardNorm(d)).toBeLessThan(1e-3)
    const p = pt(d, drag)
    expect(p.x).toBeCloseTo(pt(tangentRing(80, 20, 1.5).d, drag).x + 0.1 * Math.cos((7 / 8) * Math.PI * 2), 9)
  })
  it('a drag on a 144-piece grid is about a millisecond', () => {
    const { d, drag } = grid(9)
    expect(pieces(d)).toBe(144)
    const { ms } = timeDrags(d, drag)
    // eslint-disable-next-line no-console
    console.log(`[solve sparse] 144-piece grid drag: ${ms.toFixed(2)} ms`)
    expect(ms).toBeLessThan(20)            // measured ~1 ms; ~30 ms dense
    expect(hardNorm(d)).toBeLessThan(1e-6)
  })
  it('a drag on the fills suites’ 161-piece petal ring is a few ms', () => {
    const { d, drag } = petalRing()
    expect(pieces(d)).toBe(161)
    const { ms } = timeDrags(d, drag)
    // eslint-disable-next-line no-console
    console.log(`[solve sparse] 161-piece petal ring drag: ${ms.toFixed(2)} ms`)
    expect(ms).toBeLessThan(40)            // measured ~600 ms dense
  })
  it('lands where the dense solve lands (the grid exactly, a stalled ring within a hair)', () => {
    for (const [make, tol] of [[() => grid(9), 1e-9], [() => tangentRing(19, 8, 1), 1e-5]] as const) {
      const a = make(), b = make()
      const p = pt(a.d, a.drag)
      const target = { point: a.drag, x: p.x + 0.3, y: p.y - 0.2 }
      const ra = solve(a.d, { maxIter: 120, drag: target })
      const rb = solve(b.d, { maxIter: 120, drag: target, sparseFrom: Infinity })
      expect(ra.converged && rb.converged).toBe(true)
      const ca = coords(a.d), cb = coords(b.d)
      ca.forEach((v, i) => expect(Math.abs(v - cb[i]!)).toBeLessThan(tol))
    }
  })
  it('a small drawing takes the dense path: the same answer to the last bit', () => {
    const { d, drag } = tangentRing(6, 5, 1)   // 36 params
    const free = d.entities.filter(e => e.kind === 'point').length * 2 - 2
    expect(free).toBeLessThan(SPARSE_MIN_PARAMS)
    const a = cloneDoc(d), b = cloneDoc(d)
    const p = pt(d, drag)
    const target = { point: drag, x: p.x + 0.4, y: p.y + 0.1 }
    expect(solve(a, { maxIter: 120, drag: target })).toEqual(solve(b, { maxIter: 120, drag: target, sparseFrom: Infinity }))
    expect(coords(a)).toEqual(coords(b))
  })
  it('out of time ends the solve; one that has not converged leaves the drawing untouched', () => {
    const { d, drag } = tangentRing(80, 20, 1.5)
    const before = coords(d)
    const p = pt(d, drag)
    let calls = 0
    const r = solve(d, { maxIter: 120, drag: { point: drag, x: p.x + 3, y: p.y }, outOfTime: () => ++calls > 1 })
    expect(r.timedOut).toBe(true)
    expect(r.iterations).toBe(2)
    expect(r.converged).toBe(false)
    expect(coords(d)).toEqual(before)
    // no budget passed: never timed out, and no timedOut field
    expect('timedOut' in solve(d, { maxIter: 120 })).toBe(false)
  })
})
