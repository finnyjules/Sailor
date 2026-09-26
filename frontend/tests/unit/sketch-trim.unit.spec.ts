import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId, PathEntity, LineEntity, ConstraintKind } from '~/lib/sketch/model'
import { getEntity, getPoint } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { spanAt } from '~/lib/sketch/crossings'
import { solve } from '~/lib/sketch/solve'
import {
  pinToCurve, removeSpan, removeSegment, cutAt, canDissolve, dissolveAt, mergePoints,
} from '~/lib/sketch/trim'

const emptyDoc = (): SketchDoc => ({ entities: [], constraints: [] })

const pathOf = (d: SketchDoc, id: EntityId) => getEntity(d, id) as PathEntity
const lineOf = (d: SketchDoc, id: EntityId) => getEntity(d, id) as LineEntity
const paths = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path') as PathEntity[]
const lines = (d: SketchDoc) => d.entities.filter(e => e.kind === 'line') as LineEntity[]
const pos = (d: SketchDoc, id: EntityId) => { const p = getPoint(d, id)!; return { x: p.x, y: p.y } }
const hasRule = (d: SketchDoc, kind: ConstraintKind, refs: EntityId[]) =>
  d.constraints.some(c => c.kind === kind && c.refs.length === refs.length && c.refs.every((r, i) => r === refs[i]))
const ruleCount = (d: SketchDoc, kind: ConstraintKind) => d.constraints.filter(c => c.kind === kind).length

function expectAt(d: SketchDoc, id: EntityId, x: number, y: number, digits = 6) {
  const p = pos(d, id)
  expect(p.x).toBeCloseTo(x, digits)
  expect(p.y).toBeCloseTo(y, digits)
}

// every point keeps its position through a solve (the edit didn't change the drawing)
function expectSolveKeepsGeometry(d: SketchDoc) {
  const before = new Map(d.entities.filter(e => e.kind === 'point').map(e => [e.id, pos(d, e.id)]))
  solve(d)
  for (const [id, p] of before) {
    const q = pos(d, id)
    expect(Math.abs(q.x - p.x)).toBeLessThan(1e-6)
    expect(Math.abs(q.y - p.y)).toBeLessThan(1e-6)
  }
}

// vertical line entity at x from y=-5..5
function vCutter(d: SketchDoc, x: number): EntityId {
  return addLine(d, addPoint(d, x, -5), addPoint(d, x, 5))
}

describe('removeSpan — line entities', () => {
  it('whole line → deleted with its orphan ends; rules on it counted', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    const L = addLine(d, a, b)
    addConstraint(d, 'horizontal', [L])
    const res = removeSpan(d, spanAt(d, { kind: 'line', id: L }, 0.5)!)
    expect(res).toEqual({ ok: true, droppedRules: 1 })
    expect(getEntity(d, L)).toBeUndefined()
    expect(getPoint(d, a)).toBeUndefined()
    expect(getPoint(d, b)).toBeUndefined()
  })

  it('touching one end → that end moves to the crossing, pinned to the cutter; old end removed, its rules counted', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    const L = addLine(d, a, b)
    const V = vCutter(d, 4)
    const loose = addPoint(d, -3, 0)
    addConstraint(d, 'distance', [a, loose], 3)
    const res = removeSpan(d, spanAt(d, { kind: 'line', id: L }, 0.2)!)
    expect(res).toEqual({ ok: true, droppedRules: 1 })
    const line = lineOf(d, L)
    expect(line.p2).toBe(b)
    expect(line.p1).not.toBe(a)
    expectAt(d, line.p1, 4, 0)
    expect(hasRule(d, 'pointOnLine', [line.p1, V])).toBe(true)
    expect(getPoint(d, a)).toBeUndefined()
  })

  it('keeps the old end when something else references it', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    const L = addLine(d, a, b)
    addLine(d, a, addPoint(d, 0, 10))
    vCutter(d, 4)
    removeSpan(d, spanAt(d, { kind: 'line', id: L }, 0.2)!)
    expect(getPoint(d, a)).toBeDefined()
  })

  it('interior piece → two lines p1→X0 and X1→p2, both new ends pinned', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    const L = addLine(d, a, b)
    const V1 = vCutter(d, 3), V2 = vCutter(d, 7)
    const res = removeSpan(d, spanAt(d, { kind: 'line', id: L }, 0.5)!)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    const first = lineOf(d, L)
    expect(first.p1).toBe(a)
    expectAt(d, first.p2, 3, 0)
    expect(hasRule(d, 'pointOnLine', [first.p2, V1])).toBe(true)
    const second = lines(d).find(l => l.p2 === b)!
    expect(second.id).not.toBe(L)
    expectAt(d, second.p1, 7, 0)
    expect(hasRule(d, 'pointOnLine', [second.p1, V2])).toBe(true)
    expectSolveKeepsGeometry(d)
  })
})

describe('removeSegment / removeSpan — path segments', () => {
  function threeSegs(d: SketchDoc) {
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 20, 5), a3 = addPoint(d, 30, 5)
    const P = addPath(d, [a0, a1, a2, a3], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }])
    return { a0, a1, a2, a3, P }
  }

  it('interior segment of an open path → two paths (first keeps the id)', () => {
    const d = emptyDoc()
    const { a0, a1, a2, a3, P } = threeSegs(d)
    expect(removeSegment(d, P, 1)).toEqual({ ok: true, droppedRules: 0 })
    expect(paths(d)).toHaveLength(2)
    expect(pathOf(d, P).anchors).toEqual([a0, a1])
    const other = paths(d).find(p => p.id !== P)!
    expect(other.anchors).toEqual([a2, a3])
    expect(other.closed).toBe(false)
  })

  it('interior piece of a path line segment → split at both crossings, then the middle removed', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 30, 0), a3 = addPoint(d, 40, 0)
    const P = addPath(d, [a0, a1, a2, a3], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }])
    const V1 = vCutter(d, 15), V2 = vCutter(d, 25)
    const res = removeSpan(d, spanAt(d, { kind: 'seg', pathId: P, segIndex: 1 }, 0.5)!)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    const first = pathOf(d, P)
    expect(first.anchors.slice(0, 2)).toEqual([a0, a1])
    expect(first.anchors).toHaveLength(3)
    const x0 = first.anchors[2]!
    expectAt(d, x0, 15, 0)
    expect(hasRule(d, 'pointOnLine', [x0, V1])).toBe(true)
    const second = paths(d).find(p => p.id !== P)!
    expect(second.anchors.slice(1)).toEqual([a2, a3])
    const x1 = second.anchors[0]!
    expectAt(d, x1, 25, 0)
    expect(hasRule(d, 'pointOnLine', [x1, V2])).toBe(true)
    expectSolveKeepsGeometry(d)
  })

  it('end segment → shorter path, the loose end removed', () => {
    const d = emptyDoc()
    const { a0, a1, a2, a3, P } = threeSegs(d)
    removeSegment(d, P, 2)
    expect(paths(d)).toHaveLength(1)
    expect(pathOf(d, P).anchors).toEqual([a0, a1, a2])
    expect(pathOf(d, P).segments).toHaveLength(2)
    expect(getPoint(d, a3)).toBeUndefined()
  })

  it('first segment → the rest keeps the id', () => {
    const d = emptyDoc()
    const { a0, a1, a2, a3, P } = threeSegs(d)
    removeSegment(d, P, 0)
    expect(paths(d)).toHaveLength(1)
    expect(pathOf(d, P).anchors).toEqual([a1, a2, a3])
    expect(getPoint(d, a0)).toBeUndefined()
  })

  it('only segment → path deleted', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    const P = addPath(d, [a, b], [{ kind: 'line' }])
    expect(removeSegment(d, P, 0).ok).toBe(true)
    expect(getEntity(d, P)).toBeUndefined()
    expect(d.entities).toHaveLength(0)
  })

  it('closed path → one open path starting after the gap; arc invariant intact', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 10, 10), a3 = addPoint(d, 0, 10)
    const C = addPoint(d, 5, 10)
    const P = addPath(d, [a0, a1, a2, a3], [{ kind: 'line' }, { kind: 'line' }, { kind: 'arc', center: C, sweep: 1 }, { kind: 'line' }], true)
    expect(removeSegment(d, P, 0)).toEqual({ ok: true, droppedRules: 0 })
    const p = pathOf(d, P)
    expect(p.closed).toBe(false)
    expect(p.anchors).toEqual([a1, a2, a3, a0])
    expect(p.segments.map(s => s.kind)).toEqual(['line', 'arc', 'line'])
    expect(hasRule(d, 'equalDist', [C, a2, C, a3])).toBe(true)
    expect(ruleCount(d, 'equalDist')).toBe(1)
  })

  it('removing an arc segment drops its invariant (not counted) and its orphan centre', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 0, 10)
    const C = addPoint(d, 0, 0)
    const P = addPath(d, [a0, a1, a2], [{ kind: 'line' }, { kind: 'arc', center: C, sweep: 1 }])
    const res = removeSegment(d, P, 1)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    expect(ruleCount(d, 'equalDist')).toBe(0)
    expect(pathOf(d, P).anchors).toEqual([a0, a1])
    expect(getPoint(d, C)).toBeUndefined()
    expect(getPoint(d, a2)).toBeUndefined()
  })

  it('arc segment trimmed between two crossings → two arcs on the same centre and sweep, each with its invariant', () => {
    const d = emptyDoc()
    const A = addPoint(d, 10, 0), B = addPoint(d, 0, 10), C = addPoint(d, 0, 0)
    const P = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    const o1 = addPoint(d, 0, 0), o2 = addPoint(d, 0, 0)
    const deg = Math.PI / 180
    const R1 = addLine(d, o1, addPoint(d, 20 * Math.cos(30 * deg), 20 * Math.sin(30 * deg)))
    const R2 = addLine(d, o2, addPoint(d, 20 * Math.cos(60 * deg), 20 * Math.sin(60 * deg)))
    const res = removeSpan(d, spanAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.5)!)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    const first = pathOf(d, P)
    expect(first.anchors[0]).toBe(A)
    const x0 = first.anchors[1]!
    expectAt(d, x0, 10 * Math.cos(30 * deg), 10 * Math.sin(30 * deg))
    expect(first.segments).toEqual([{ kind: 'arc', center: C, sweep: 1 }])
    const second = paths(d).find(p => p.id !== P)!
    const x1 = second.anchors[0]!
    expect(second.anchors[1]).toBe(B)
    expectAt(d, x1, 10 * Math.cos(60 * deg), 10 * Math.sin(60 * deg))
    expect(second.segments).toEqual([{ kind: 'arc', center: C, sweep: 1 }])
    expect(hasRule(d, 'equalDist', [C, A, C, x0])).toBe(true)
    expect(hasRule(d, 'equalDist', [C, x1, C, B])).toBe(true)
    expect(hasRule(d, 'equalDist', [C, A, C, B])).toBe(false)
    expect(hasRule(d, 'pointOnLine', [x0, R1])).toBe(true)
    expect(hasRule(d, 'pointOnLine', [x1, R2])).toBe(true)
    expectSolveKeepsGeometry(d)
  })
})

describe('removeSpan — circles', () => {
  it('two crossings → one-arc open path; pointOnCircle remapped to equalDist; tangent rule dropped and counted', () => {
    const d = emptyDoc()
    const C = addPoint(d, 0, 0)
    const circ = addCircle(d, C, 5)
    const V = addLine(d, addPoint(d, 0, -10), addPoint(d, 0, 10))
    const T = addLine(d, addPoint(d, -5, 20), addPoint(d, -5, 30))   // tangent to the circle, far off
    addConstraint(d, 'tangentLineCircle', [T, circ])
    const q = addPoint(d, -3, 4)
    addConstraint(d, 'pointOnCircle', [q, circ])
    const res = removeSpan(d, spanAt(d, { kind: 'circle', id: circ }, 0)!)   // right half
    expect(res).toEqual({ ok: true, droppedRules: 1 })
    expect(getEntity(d, circ)).toBeUndefined()
    const ps = paths(d)
    expect(ps).toHaveLength(1)
    const p = ps[0]!
    expect(p.closed).toBe(false)
    expect(p.segments).toEqual([{ kind: 'arc', center: C, sweep: 1 }])
    const [x1, x0] = p.anchors as [EntityId, EntityId]
    expectAt(d, x1, 0, 5)      // arc starts at the upper crossing
    expectAt(d, x0, 0, -5)     // runs CCW (through the left) to the lower one
    expect(hasRule(d, 'pointOnLine', [x1, V])).toBe(true)
    expect(hasRule(d, 'pointOnLine', [x0, V])).toBe(true)
    expect(hasRule(d, 'equalDist', [C, x1, C, x0])).toBe(true)
    expect(hasRule(d, 'equalDist', [C, q, C, x1])).toBe(true)
    expect(ruleCount(d, 'pointOnCircle')).toBe(0)
    expect(ruleCount(d, 'tangentLineCircle')).toBe(0)
    expectSolveKeepsGeometry(d)
  })

  it('concentric with another circle is kept by sharing that circle’s centre', () => {
    const d = emptyDoc()
    const C = addPoint(d, 0, 0), C2 = addPoint(d, 0, 0)
    const circ = addCircle(d, C, 5)
    const other = addCircle(d, C2, 20)
    addConstraint(d, 'concentric', [circ, other])
    addLine(d, addPoint(d, 0, -10), addPoint(d, 0, 10))
    const res = removeSpan(d, spanAt(d, { kind: 'circle', id: circ }, 0)!)
    expect(res.droppedRules).toBe(0)
    const p = paths(d)[0]!
    expect((p.segments[0] as { center: EntityId }).center).toBe(C2)
    expect(getEntity(d, other)).toBeDefined()
  })

  it('no crossings → circle deleted', () => {
    const d = emptyDoc()
    const circ = addCircle(d, addPoint(d, 0, 0), 5)
    expect(removeSpan(d, spanAt(d, { kind: 'circle', id: circ }, 1)!).ok).toBe(true)
    expect(getEntity(d, circ)).toBeUndefined()
    expect(paths(d)).toHaveLength(0)
  })

  it('one crossing → circle deleted', () => {
    const d = emptyDoc()
    const circ = addCircle(d, addPoint(d, 0, 0), 5)
    addLine(d, addPoint(d, 1, 0), addPoint(d, 10, 0))
    expect(removeSpan(d, spanAt(d, { kind: 'circle', id: circ }, 2)!).ok).toBe(true)
    expect(getEntity(d, circ)).toBeUndefined()
    expect(paths(d)).toHaveLength(0)
  })
})

describe('pinToCurve', () => {
  it('line entity → pointOnLine', () => {
    const d = emptyDoc()
    const L = addLine(d, addPoint(d, 0, 0), addPoint(d, 10, 0))
    const p = addPoint(d, 4, 0)
    expect(pinToCurve(d, p, { kind: 'line', id: L }, { x: 4, y: 0 })).toBe(p)
    expect(hasRule(d, 'pointOnLine', [p, L])).toBe(true)
  })

  it('circle entity → pointOnCircle', () => {
    const d = emptyDoc()
    const c = addCircle(d, addPoint(d, 0, 0), 5)
    const p = addPoint(d, 5, 0)
    expect(pinToCurve(d, p, { kind: 'circle', id: c }, { x: 5, y: 0 })).toBe(p)
    expect(hasRule(d, 'pointOnCircle', [p, c])).toBe(true)
  })

  it('path line segment → collinear [A, B, p]', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0), B = addPoint(d, 10, 0)
    const P = addPath(d, [A, B], [{ kind: 'line' }])
    const p = addPoint(d, 4, 0)
    expect(pinToCurve(d, p, { kind: 'seg', pathId: P, segIndex: 0 }, { x: 4, y: 0 })).toBe(p)
    expect(hasRule(d, 'collinear', [A, B, p])).toBe(true)
  })

  it('path arc segment → equalDist [C, p, C, A]', () => {
    const d = emptyDoc()
    const A = addPoint(d, 10, 0), B = addPoint(d, 0, 10), C = addPoint(d, 0, 0)
    const P = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    const p = addPoint(d, 10 * Math.SQRT1_2, 10 * Math.SQRT1_2)
    expect(pinToCurve(d, p, { kind: 'seg', pathId: P, segIndex: 0 }, pos(d, p))).toBe(p)
    expect(hasRule(d, 'equalDist', [C, p, C, A])).toBe(true)
  })

  it('reuses a cutter anchor when the crossing lands on it (no rule)', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0), B = addPoint(d, 10, 0)
    const P = addPath(d, [A, B], [{ kind: 'line' }])
    const p = addPoint(d, 10, 0)
    const before = d.constraints.length
    expect(pinToCurve(d, p, { kind: 'seg', pathId: P, segIndex: 0 }, { x: 10, y: 0 })).toBe(B)
    expect(d.constraints.length).toBe(before)
  })

  it('trim reuses the cutter’s anchor as the new end', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    const L = addLine(d, a, b)
    // a path whose end anchor sits exactly on the line at x=4
    const top = addPoint(d, 4, 0)
    addPath(d, [addPoint(d, 4, 8), top], [{ kind: 'line' }])
    const n = d.constraints.length
    removeSpan(d, spanAt(d, { kind: 'line', id: L }, 0.1)!)
    expect(lineOf(d, L).p1).toBe(top)
    expect(d.constraints.length).toBe(n)
  })
})

describe('cutAt', () => {
  it('path line segment → two lines sharing a new anchor; drawing unchanged', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0), B = addPoint(d, 10, 0)
    const P = addPath(d, [A, B], [{ kind: 'line' }])
    const x = cutAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.3)!
    expect(x).toBeTruthy()
    expectAt(d, x, 3, 0)
    expect(pathOf(d, P).anchors).toEqual([A, x, B])
    expect(pathOf(d, P).segments).toEqual([{ kind: 'line' }, { kind: 'line' }])
    expectSolveKeepsGeometry(d)
  })

  it('path arc segment → two arcs with the shared centre, sweep, and both invariants', () => {
    const d = emptyDoc()
    const A = addPoint(d, 10, 0), B = addPoint(d, 0, 10), C = addPoint(d, 0, 0)
    const P = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    const x = cutAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.5)!
    expectAt(d, x, 10 * Math.SQRT1_2, 10 * Math.SQRT1_2)
    expect(pathOf(d, P).anchors).toEqual([A, x, B])
    expect(pathOf(d, P).segments).toEqual([{ kind: 'arc', center: C, sweep: 1 }, { kind: 'arc', center: C, sweep: 1 }])
    expect(hasRule(d, 'equalDist', [C, A, C, x])).toBe(true)
    expect(hasRule(d, 'equalDist', [C, x, C, B])).toBe(true)
    expect(hasRule(d, 'equalDist', [C, A, C, B])).toBe(false)
    expectSolveKeepsGeometry(d)
  })

  it('closed path wrap segment splits correctly', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 10, 10)
    const P = addPath(d, [a0, a1, a2], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    const x = cutAt(d, { kind: 'seg', pathId: P, segIndex: 2 }, 0.5)!
    expectAt(d, x, 5, 5)
    expect(pathOf(d, P).anchors).toEqual([a0, a1, a2, x])
    expect(pathOf(d, P).segments).toHaveLength(4)
  })

  it('line entity → two line entities sharing the new point; drawing unchanged', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    const L = addLine(d, a, b)
    const x = cutAt(d, { kind: 'line', id: L }, 0.5)!
    expectAt(d, x, 5, 0)
    expect(lineOf(d, L).p1).toBe(a)
    expect(lineOf(d, L).p2).toBe(x)
    expect(lines(d).some(l => l.p1 === x && l.p2 === b)).toBe(true)
    expectSolveKeepsGeometry(d)
  })

  it('refuses circles and Bézier segments', () => {
    const d = emptyDoc()
    const c = addCircle(d, addPoint(d, 0, 0), 5)
    expect(cutAt(d, { kind: 'circle', id: c }, 1)).toBeNull()
    const P = addPath(d, [addPoint(d, 0, 0), addPoint(d, 10, 0)], [{ kind: 'cubic', h1: null, h2: null }])
    expect(cutAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.5)).toBeNull()
  })
})

describe('canDissolve / dissolveAt', () => {
  it('merges two collinear lines and removes the anchor', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 20, 0)
    const P = addPath(d, [a0, a1, a2], [{ kind: 'line' }, { kind: 'line' }])
    expect(canDissolve(d, P, 1, 0.5, 0.5)).toBe(true)
    expect(dissolveAt(d, P, 1, 0.5, 0.5).ok).toBe(true)
    expect(pathOf(d, P).anchors).toEqual([a0, a2])
    expect(pathOf(d, P).segments).toEqual([{ kind: 'line' }])
    expect(getPoint(d, a1)).toBeUndefined()
  })

  it('merges two arcs on the same centre into one arc with one invariant', () => {
    const d = emptyDoc()
    const A = addPoint(d, 10, 0), M = addPoint(d, 0, 10), B = addPoint(d, -10, 0), C = addPoint(d, 0, 0)
    const P = addPath(d, [A, M, B], [{ kind: 'arc', center: C, sweep: 1 }, { kind: 'arc', center: C, sweep: 1 }])
    expect(canDissolve(d, P, 1, 0.5, 0.5)).toBe(true)
    expect(dissolveAt(d, P, 1, 0.5, 0.5).ok).toBe(true)
    expect(pathOf(d, P).anchors).toEqual([A, B])
    expect(pathOf(d, P).segments).toEqual([{ kind: 'arc', center: C, sweep: 1 }])
    expect(ruleCount(d, 'equalDist')).toBe(1)
    expect(hasRule(d, 'equalDist', [C, A, C, B])).toBe(true)
    expect(getPoint(d, M)).toBeUndefined()
    expectSolveKeepsGeometry(d)
  })

  it('dissolves anchor 0 of a closed path', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 5, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 10, 10), a3 = addPoint(d, 0, 10), a4 = addPoint(d, 0, 0)
    const P = addPath(d, [a0, a1, a2, a3, a4], Array.from({ length: 5 }, () => ({ kind: 'line' as const })), true)
    expect(dissolveAt(d, P, 0, 0.5, 0.5).ok).toBe(true)
    expect(pathOf(d, P).anchors).toEqual([a1, a2, a3, a4])
    expect(pathOf(d, P).segments).toHaveLength(4)
    expect(pathOf(d, P).closed).toBe(true)
  })

  it('refuses a corner and an open end', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 10, 10)
    const P = addPath(d, [a0, a1, a2], [{ kind: 'line' }, { kind: 'line' }])
    expect(canDissolve(d, P, 1, 0.5, 0.5)).toBe(false)
    expect(dissolveAt(d, P, 1, 0.5, 0.5)).toEqual({ ok: false, droppedRules: 0 })
    expect(pathOf(d, P).anchors).toEqual([a0, a1, a2])
    expect(canDissolve(d, P, 0, 0.5, 0.5)).toBe(false)
  })

  it('refuses a line folding back on itself', () => {
    const d = emptyDoc()
    const P = addPath(d, [addPoint(d, 0, 0), addPoint(d, 10, 0), addPoint(d, 5, 0)], [{ kind: 'line' }, { kind: 'line' }])
    expect(canDissolve(d, P, 1, 0.5, 0.5)).toBe(false)
  })

  it('keeps the anchor when something else uses it', () => {
    const d = emptyDoc()
    const a1 = addPoint(d, 10, 0)
    const P = addPath(d, [addPoint(d, 0, 0), a1, addPoint(d, 20, 0)], [{ kind: 'line' }, { kind: 'line' }])
    addLine(d, a1, addPoint(d, 10, 10))
    expect(dissolveAt(d, P, 1, 0.5, 0.5).ok).toBe(true)
    expect(getPoint(d, a1)).toBeDefined()
  })
})

describe('mergePoints', () => {
  it('rewires a line end, a path anchor and a rule ref; into keeps its position', () => {
    const d = emptyDoc()
    const from = addPoint(d, 1, 1), into = addPoint(d, 0, 0)
    const L = addLine(d, from, addPoint(d, 10, 0))
    const P = addPath(d, [addPoint(d, 0, 20), from], [{ kind: 'line' }])
    const other = addPoint(d, 5, 5)
    addConstraint(d, 'distance', [from, other], 3)
    expect(mergePoints(d, from, into)).toBe(true)
    expect(getPoint(d, from)).toBeUndefined()
    expect(lineOf(d, L).p1).toBe(into)
    expect(pathOf(d, P).anchors[1]).toBe(into)
    expect(hasRule(d, 'distance', [into, other])).toBe(true)
    expectAt(d, into, 0, 0)
  })

  it('drops coincident [a, a] and distance [a, a]', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 0, 0)
    addConstraint(d, 'coincident', [a, b])
    addConstraint(d, 'distance', [a, b], 0)
    mergePoints(d, b, a)
    expect(d.constraints).toHaveLength(0)
  })

  it('deletes a line collapsed to one point', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 3, 0)
    const L = addLine(d, a, b)
    addConstraint(d, 'horizontal', [L])
    mergePoints(d, b, a)
    expect(getEntity(d, L)).toBeUndefined()
    expect(d.constraints).toHaveLength(0)
    expect(getPoint(d, a)).toBeDefined()
  })

  it('closes a path whose two ends merge', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 10, 10), a3 = addPoint(d, 0, 0.5)
    const P = addPath(d, [a0, a1, a2, a3], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }])
    mergePoints(d, a3, a0)
    const p = pathOf(d, P)
    expect(p.closed).toBe(true)
    expect(p.anchors).toEqual([a0, a1, a2])
    expect(p.segments).toHaveLength(3)
  })

  it('removes a path segment whose two anchors became one', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 10.2, 0), a3 = addPoint(d, 20, 5)
    const P = addPath(d, [a0, a1, a2, a3], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }])
    mergePoints(d, a2, a1)
    expect(pathOf(d, P).anchors).toEqual([a0, a1, a3])
    expect(pathOf(d, P).segments).toHaveLength(2)
  })
})

// ── review round 1 ───────────────────────────────────────────────────────────

const zeroLengthLines = (d: SketchDoc) => lines(d).filter(l => l.p1 === l.p2)
const degeneratePaths = (d: SketchDoc) =>
  paths(d).filter(p => p.anchors.some((a, i) => i < (p.closed ? p.anchors.length : p.anchors.length - 1) && a === p.anchors[(i + 1) % p.anchors.length]))

describe('#1 crossings at the trimmed curve’s own end', () => {
  it('triangle side → the whole side goes, no zero-length lines', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0), c = addPoint(d, 5, 8)
    const AB = addLine(d, a, b); addLine(d, b, c); addLine(d, c, a)
    expect(removeSpan(d, spanAt(d, { kind: 'line', id: AB }, 0.5)!).ok).toBe(true)
    expect(getEntity(d, AB)).toBeUndefined()
    expect(lines(d)).toHaveLength(2)
    expect(zeroLengthLines(d)).toHaveLength(0)
    expect(getPoint(d, a)).toBeDefined()
    expect(getPoint(d, b)).toBeDefined()
  })

  it('L-corner → the corner end is treated as the line’s own end', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    const AB = addLine(d, a, b); addLine(d, a, addPoint(d, 0, 10))
    const V = vCutter(d, 5)
    removeSpan(d, spanAt(d, { kind: 'line', id: AB }, 0.25)!)
    const l = lineOf(d, AB)
    expect(l.p2).toBe(b)
    expectAt(d, l.p1, 5, 0)
    expect(hasRule(d, 'pointOnLine', [l.p1, V])).toBe(true)
    expect(zeroLengthLines(d)).toHaveLength(0)
  })

  it('trimming the rest of an already-trimmed line deletes it', () => {
    const d = emptyDoc()
    const L = addLine(d, addPoint(d, 0, 0), addPoint(d, 10, 0))
    const V = vCutter(d, 4)
    removeSpan(d, spanAt(d, { kind: 'line', id: L }, 0.2)!)
    removeSpan(d, spanAt(d, { kind: 'line', id: L }, 0.5)!)
    expect(getEntity(d, L)).toBeUndefined()
    expect(lines(d).map(l => l.id)).toEqual([V])
  })

  it('a line ending on a pinned circle point is removed whole', () => {
    const d = emptyDoc()
    const circ = addCircle(d, addPoint(d, 0, 0), 5)
    const s = addPoint(d, 0, 5)
    const L = addLine(d, s, addPoint(d, 0, 15))
    addConstraint(d, 'pointOnCircle', [s, circ])
    removeSpan(d, spanAt(d, { kind: 'line', id: L }, 0.5)!)
    expect(getEntity(d, L)).toBeUndefined()
    expect(zeroLengthLines(d)).toHaveLength(0)
  })

  it('a path segment whose start anchor is shared with a line is removed whole', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0)
    addLine(d, A, addPoint(d, 0, 10))
    const P = addPath(d, [A, addPoint(d, 10, 0)], [{ kind: 'line' }])
    removeSpan(d, spanAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.5)!)
    expect(getEntity(d, P)).toBeUndefined()
    expect(degeneratePaths(d)).toHaveLength(0)
    expect(getPoint(d, A)).toBeDefined()
  })
})

describe('#2 point-pair rules follow the pieces', () => {
  function square(d: SketchDoc) {
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 10, 10), a3 = addPoint(d, 0, 10)
    const P = addPath(d, [a0, a1, a2, a3], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    return { a0, a1, a2, a3, P }
  }

  it('a rule on exactly the removed segment’s pair is dropped and counted', () => {
    const d = emptyDoc()
    const { a0, a1, P } = square(d)
    addConstraint(d, 'horizontal', [a0, a1])
    expect(removeSegment(d, P, 0)).toEqual({ ok: true, droppedRules: 1 })
    expect(ruleCount(d, 'horizontal')).toBe(0)
  })

  it('a trim that moves one end rewrites the pair onto the surviving half', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0), B = addPoint(d, 10, 0)
    const P = addPath(d, [A, B], [{ kind: 'line' }])
    addConstraint(d, 'horizontal', [A, B])
    vCutter(d, 4)
    const res = removeSpan(d, spanAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.2)!)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    const x = pathOf(d, P).anchors[0]!
    expect(hasRule(d, 'horizontal', [x, B])).toBe(true)
  })

  it('an interior trim copies direction rules to both halves and drops length rules', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0), B = addPoint(d, 10, 0)
    const P = addPath(d, [A, B], [{ kind: 'line' }])
    addConstraint(d, 'horizontal', [A, B])
    addConstraint(d, 'distance', [A, B], 10)
    vCutter(d, 3); vCutter(d, 7)
    const res = removeSpan(d, spanAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.5)!)
    expect(res).toEqual({ ok: true, droppedRules: 1 })
    const x0 = pathOf(d, P).anchors[1]!
    const x1 = paths(d).find(p => p.id !== P)!.anchors[0]!
    expect(hasRule(d, 'horizontal', [A, x0])).toBe(true)
    expect(hasRule(d, 'horizontal', [x1, B])).toBe(true)
    expect(ruleCount(d, 'distance')).toBe(0)
  })

  it('a cut copies the right angle to both halves', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 10), b = addPoint(d, 0, 0), c = addPoint(d, 10, 0)
    const P = addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
    addConstraint(d, 'perpendicular', [a, b, b, c])
    const x = cutAt(d, { kind: 'seg', pathId: P, segIndex: 1 }, 0.5)!
    expect(hasRule(d, 'perpendicular', [a, b, b, x])).toBe(true)
    expect(hasRule(d, 'perpendicular', [a, b, x, c])).toBe(true)
    expectSolveKeepsGeometry(d)
  })
})

describe('#3 line entity halves', () => {
  it('interior trim gives the second line its own horizontal; pointOnLine stays on the first', () => {
    const d = emptyDoc()
    const L = addLine(d, addPoint(d, 0, 0), addPoint(d, 10, 0))
    addConstraint(d, 'horizontal', [L])
    const q = addPoint(d, 20, 0)
    addConstraint(d, 'pointOnLine', [q, L])
    vCutter(d, 3); vCutter(d, 7)
    removeSpan(d, spanAt(d, { kind: 'line', id: L }, 0.5)!)
    const L2 = lines(d).find(l => l.id !== L && getPoint(d, l.p1)!.y === 0 && getPoint(d, l.p2)!.y === 0)!
    expect(hasRule(d, 'horizontal', [L])).toBe(true)
    expect(hasRule(d, 'horizontal', [L2.id])).toBe(true)
    expect(hasRule(d, 'pointOnLine', [q, L])).toBe(true)
    expect(d.constraints.some(c => c.kind === 'pointOnLine' && c.refs[1] === L2.id)).toBe(false)
  })

  it('cut gives the second line its own vertical', () => {
    const d = emptyDoc()
    const L = addLine(d, addPoint(d, 0, 0), addPoint(d, 0, 10))
    addConstraint(d, 'vertical', [L])
    const x = cutAt(d, { kind: 'line', id: L }, 0.5)!
    const L2 = lines(d).find(l => l.p1 === x)!
    expect(hasRule(d, 'vertical', [L2.id])).toBe(true)
  })
})

describe('#4 reused anchors drop their pins to the trimmed curve', () => {
  it('path segment: collinear pin of the reused anchor goes, not counted', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0), B = addPoint(d, 10, 0)
    const P = addPath(d, [A, B], [{ kind: 'line' }])
    const T = addPoint(d, 4, 0)
    addPath(d, [addPoint(d, 4, 8), T], [{ kind: 'line' }])
    addConstraint(d, 'collinear', [A, B, T])
    const res = removeSpan(d, spanAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.2)!)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    expect(pathOf(d, P).anchors[0]).toBe(T)
    expect(ruleCount(d, 'collinear')).toBe(0)
  })

  it('line entity: pointOnLine pin of the reused anchor goes, not counted', () => {
    const d = emptyDoc()
    const L = addLine(d, addPoint(d, 0, 0), addPoint(d, 10, 0))
    const T = addPoint(d, 4, 0)
    addPath(d, [addPoint(d, 4, 8), T], [{ kind: 'line' }])
    addConstraint(d, 'pointOnLine', [T, L])
    const res = removeSpan(d, spanAt(d, { kind: 'line', id: L }, 0.2)!)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    expect(lineOf(d, L).p1).toBe(T)
    expect(ruleCount(d, 'pointOnLine')).toBe(0)
  })

  it('circle: a reused end’s pointOnCircle is dropped, not remapped, not counted', () => {
    const d = emptyDoc()
    const C = addPoint(d, 0, 0)
    const circ = addCircle(d, C, 5)
    const s = addPoint(d, 0, 5)
    addLine(d, s, addPoint(d, 0, 15))
    addConstraint(d, 'pointOnCircle', [s, circ])
    addLine(d, addPoint(d, 0, -10), addPoint(d, 0, 0))
    const res = removeSpan(d, spanAt(d, { kind: 'circle', id: circ }, 0)!)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    const p = paths(d)[0]!
    expect(p.anchors[0]).toBe(s)
    expect(ruleCount(d, 'pointOnCircle')).toBe(0)
    expect(ruleCount(d, 'equalDist')).toBe(1)
  })
})

describe('#5–#8 mergePoints', () => {
  it('drops parallel/perpendicular whose two pairs became the same', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0), c = addPoint(d, 10, 0)
    addConstraint(d, 'parallel', [a, b, a, c])
    addConstraint(d, 'perpendicular', [b, a, a, c])
    expect(mergePoints(d, c, b)).toBe(true)
    expect(d.constraints).toHaveLength(0)
  })

  it('drops midpoint when the middle point became an end', () => {
    const d = emptyDoc()
    const P = addPoint(d, 5, 0), A = addPoint(d, 0, 0), B = addPoint(d, 10, 0)
    addConstraint(d, 'midpoint', [P, A, B])
    mergePoints(d, P, A)
    expect(d.constraints).toHaveLength(0)
  })

  it('drops pointOnCircle of the circle’s own centre', () => {
    const d = emptyDoc()
    const C = addPoint(d, 0, 0)
    const circ = addCircle(d, C, 5)
    const p = addPoint(d, 0.1, 0)
    addConstraint(d, 'pointOnCircle', [p, circ])
    mergePoints(d, p, C)
    expect(d.constraints).toHaveLength(0)
  })

  it('removes exact duplicate rules', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 0, 0), c = addPoint(d, 3, 0)
    addConstraint(d, 'distance', [a, c], 3)
    addConstraint(d, 'distance', [b, c], 3)
    mergePoints(d, b, a)
    expect(d.constraints).toHaveLength(1)
  })

  it('only `from` fixed → into moves to from and becomes fixed', () => {
    const d = emptyDoc()
    const from = addPoint(d, 1, 1, { fixed: true }), into = addPoint(d, 0, 0)
    expect(mergePoints(d, from, into)).toBe(true)
    expectAt(d, into, 1, 1)
    expect(getPoint(d, into)!.fixed).toBe(true)
  })

  it('both fixed at different places → refused, nothing changes', () => {
    const d = emptyDoc()
    const from = addPoint(d, 1, 1, { fixed: true }), into = addPoint(d, 0, 0, { fixed: true })
    addLine(d, from, addPoint(d, 5, 5))
    const snap = JSON.stringify(d)
    expect(mergePoints(d, from, into)).toBe(false)
    expect(JSON.stringify(d)).toBe(snap)
  })

  it('merging the ends of a one-arc path never deletes `into`', () => {
    const d = emptyDoc()
    const A = addPoint(d, 10, 0), B = addPoint(d, 0, 10), C = addPoint(d, 0, 0)
    const P = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    expect(mergePoints(d, B, A)).toBe(true)
    expect(getEntity(d, P)).toBeUndefined()
    expect(getPoint(d, A)).toBeDefined()
    expect(getPoint(d, C)).toBeUndefined()
    expect(ruleCount(d, 'equalDist')).toBe(0)
  })

  it('merging the ends of a 2-anchor line path deletes the path, keeps `into`', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    const P = addPath(d, [a, b], [{ kind: 'line' }])
    mergePoints(d, b, a)
    expect(getEntity(d, P)).toBeUndefined()
    expect(getPoint(d, a)).toBeDefined()
  })

  it('a merge collapsing an arc segment removes it, its invariant and its orphan centre', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, -10, 0), a1 = addPoint(d, 0, 0), a2 = addPoint(d, 0.2, 0), a3 = addPoint(d, 10, 5)
    const C = addPoint(d, 0.1, 0)
    const P = addPath(d, [a0, a1, a2, a3], [{ kind: 'line' }, { kind: 'arc', center: C, sweep: 1 }, { kind: 'line' }])
    mergePoints(d, a2, a1)
    expect(pathOf(d, P).anchors).toEqual([a0, a1, a3])
    expect(pathOf(d, P).segments).toEqual([{ kind: 'line' }, { kind: 'line' }])
    expect(ruleCount(d, 'equalDist')).toBe(0)
    expect(getPoint(d, C)).toBeUndefined()
  })
})

describe('#7 dissolve keeps pins', () => {
  it('rewrites line pins and direction rules onto the merged pair; length rules dropped and counted', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 20, 0)
    const P = addPath(d, [a0, a1, a2], [{ kind: 'line' }, { kind: 'line' }])
    const q = addPoint(d, 5, 0)
    addConstraint(d, 'collinear', [a0, a1, q])
    addConstraint(d, 'horizontal', [a1, a2])
    addConstraint(d, 'distance', [a0, a1], 10)
    expect(dissolveAt(d, P, 1, 0.5, 0.5)).toEqual({ ok: true, droppedRules: 1 })
    expect(hasRule(d, 'collinear', [a0, a2, q])).toBe(true)
    expect(hasRule(d, 'horizontal', [a0, a2])).toBe(true)
    expectSolveKeepsGeometry(d)
  })

  it('rewrites arc pins onto the kept centre and anchor', () => {
    const d = emptyDoc()
    const A = addPoint(d, 10, 0), M = addPoint(d, 0, 10), B = addPoint(d, -10, 0), C = addPoint(d, 0, 0), C2 = addPoint(d, 0, 0)
    const P = addPath(d, [A, M, B], [{ kind: 'arc', center: C, sweep: 1 }, { kind: 'arc', center: C2, sweep: 1 }])
    const p = addPoint(d, -10 * Math.SQRT1_2, 10 * Math.SQRT1_2)
    addConstraint(d, 'equalDist', [C2, p, C2, M])
    expect(dissolveAt(d, P, 1, 0.5, 0.5)).toEqual({ ok: true, droppedRules: 0 })
    expect(hasRule(d, 'equalDist', [C, p, C, A])).toBe(true)
    expect(getPoint(d, C2)).toBeUndefined()
    expectSolveKeepsGeometry(d)
  })
})

describe('more trim cases', () => {
  it('sweep-0 (clockwise) arc trimmed between two crossings', () => {
    const d = emptyDoc()
    const A = addPoint(d, 10, 0), B = addPoint(d, 0, -10), C = addPoint(d, 0, 0)
    const P = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 0 }])
    const deg = Math.PI / 180
    addLine(d, addPoint(d, 0, 0), addPoint(d, 20 * Math.cos(-30 * deg), 20 * Math.sin(-30 * deg)))
    addLine(d, addPoint(d, 0, 0), addPoint(d, 20 * Math.cos(-60 * deg), 20 * Math.sin(-60 * deg)))
    removeSpan(d, spanAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.5)!)
    const first = pathOf(d, P)
    expect(first.segments).toEqual([{ kind: 'arc', center: C, sweep: 0 }])
    expectAt(d, first.anchors[1]!, 10 * Math.cos(-30 * deg), 10 * Math.sin(-30 * deg))
    const second = paths(d).find(p => p.id !== P)!
    expect(second.segments).toEqual([{ kind: 'arc', center: C, sweep: 0 }])
    expectAt(d, second.anchors[0]!, 10 * Math.cos(-60 * deg), 10 * Math.sin(-60 * deg))
    expect(second.anchors[1]).toBe(B)
    expectSolveKeepsGeometry(d)
  })

  it('span trim on a closed path → one open path running from after the gap to before it', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 10, 10), a3 = addPoint(d, 0, 10)
    const P = addPath(d, [a0, a1, a2, a3], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    vCutter(d, 3); vCutter(d, 7)
    expect(removeSpan(d, spanAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.5)!).ok).toBe(true)
    const p = pathOf(d, P)
    expect(p.closed).toBe(false)
    expect(p.anchors.slice(1, 5)).toEqual([a1, a2, a3, a0])
    expect(p.anchors).toHaveLength(6)
    expectAt(d, p.anchors[0]!, 7, 0)
    expectAt(d, p.anchors[5]!, 3, 0)
    expectSolveKeepsGeometry(d)
  })
})

// ── review round 2 ───────────────────────────────────────────────────────────

describe('round 2', () => {
  it('N1 dissolve leaves other arcs’ invariants on either centre alone', () => {
    const d = emptyDoc()
    const A = addPoint(d, 10, 0), M = addPoint(d, 0, 10), B = addPoint(d, -10, 0)
    const C = addPoint(d, 0, 0), C2 = addPoint(d, 0, 0)
    const P = addPath(d, [A, M, B], [{ kind: 'arc', center: C, sweep: 1 }, { kind: 'arc', center: C2, sweep: 1 }])
    // another arc on C2 (keeps C2 alive) and a third arc on C that starts at M (keeps M alive)
    const D = addPoint(d, 0, -10), E = addPoint(d, 10 * Math.SQRT1_2, -10 * Math.SQRT1_2)
    addPath(d, [D, E], [{ kind: 'arc', center: C2, sweep: 1 }])
    const F = addPoint(d, -10 * Math.SQRT1_2, -10 * Math.SQRT1_2)
    addPath(d, [M, F], [{ kind: 'arc', center: C, sweep: 1 }])
    const p = addPoint(d, -10 * Math.SQRT1_2, 10 * Math.SQRT1_2)
    addConstraint(d, 'equalDist', [C2, p, C2, M])
    expect(dissolveAt(d, P, 1, 0.5, 0.5)).toEqual({ ok: true, droppedRules: 0 })
    expect(hasRule(d, 'equalDist', [C2, D, C2, E])).toBe(true)
    expect(hasRule(d, 'equalDist', [C, M, C, F])).toBe(true)
    expect(hasRule(d, 'equalDist', [C2, p, C2, M])).toBe(true)   // C2 and M both survive: pin still valid
    expect(hasRule(d, 'equalDist', [C, A, C, B])).toBe(true)
    expectSolveKeepsGeometry(d)
  })

  it('N2 a cut keeps length rules', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0), B = addPoint(d, 10, 0), E = addPoint(d, 0, 5), F = addPoint(d, 10, 5)
    const P = addPath(d, [A, B], [{ kind: 'line' }])
    addConstraint(d, 'distance', [A, B], 10)
    addConstraint(d, 'equalDist', [A, B, E, F])
    cutAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.5)
    expect(hasRule(d, 'distance', [A, B])).toBe(true)
    expect(hasRule(d, 'equalDist', [A, B, E, F])).toBe(true)
    expectSolveKeepsGeometry(d)
  })

  it('removing a whole segment drops and counts collinear pins onto it', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 10, 10), a3 = addPoint(d, 0, 10)
    const P = addPath(d, [a0, a1, a2, a3], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    const q = addPoint(d, 5, 0)
    addConstraint(d, 'collinear', [a0, a1, q])
    expect(removeSegment(d, P, 0)).toEqual({ ok: true, droppedRules: 1 })
    expect(ruleCount(d, 'collinear')).toBe(0)
  })

  it('removing the rest of a trimmed line does not count Trim’s own pin on the cut end', () => {
    const d = emptyDoc()
    const L = addLine(d, addPoint(d, 0, 0), addPoint(d, 10, 0))
    vCutter(d, 4)
    removeSpan(d, spanAt(d, { kind: 'line', id: L }, 0.2)!)
    expect(removeSpan(d, spanAt(d, { kind: 'line', id: L }, 0.5)!)).toEqual({ ok: true, droppedRules: 0 })
    expect(ruleCount(d, 'pointOnLine')).toBe(0)
  })

  it('dissolve’s clean-up only looks at rules it rewrote', () => {
    const d = emptyDoc()
    const a0 = addPoint(d, 0, 0), a1 = addPoint(d, 10, 0), a2 = addPoint(d, 20, 0)
    const P = addPath(d, [a0, a1, a2], [{ kind: 'line' }, { kind: 'line' }])
    const z = addPoint(d, 50, 50), w = addPoint(d, 60, 50)
    addConstraint(d, 'distance', [z, w], 10)
    addConstraint(d, 'distance', [z, w], 10)
    addConstraint(d, 'coincident', [z, z])
    dissolveAt(d, P, 1, 0.5, 0.5)
    expect(ruleCount(d, 'distance')).toBe(2)
    expect(ruleCount(d, 'coincident')).toBe(1)
  })
})
