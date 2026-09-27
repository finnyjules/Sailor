// tests/unit/sketch-trim-tangent.unit.spec.ts
// Pen stage 4 final fixes: Trim, Cut, Dissolve, delete and drop-to-join carry
// the tangency rules (tangentLineArc, tangentArcs) and arc Equal along with
// the pieces they name — or drop and count them — and never leave one on
// geometry that no longer exists as that piece.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId, SketchConstraint } from '~/lib/sketch/model'
import { getPoint } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint, deleteEntity } from '~/lib/sketch/edit'
import { spanAt, curveGeom, pointAt } from '~/lib/sketch/crossings'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { removeSpan, removeSegment, cutAt, dissolveAt, mergePoints } from '~/lib/sketch/trim'

const emptyDoc = (): SketchDoc => ({ entities: [], constraints: [] })
const rule = (d: SketchDoc, id: EntityId) => d.constraints.find(c => c.id === id)
const ofKind = (d: SketchDoc, kind: SketchConstraint['kind']) => d.constraints.filter(c => c.kind === kind)
const maxResidual = (d: SketchDoc) => Math.max(0, ...constraintResiduals(d).map(Math.abs))

// a line path Z(-10,0) → A(0,0) → B(10,0) → D(10,10), and an arc (2,3)→(8,3)
// around C(5,3) (radius 3) that touches A–B at (5,0); the rule on A–B
function lineAndArc() {
  const d = emptyDoc()
  const Z = addPoint(d, -10, 0), A = addPoint(d, 0, 0), B = addPoint(d, 10, 0), D = addPoint(d, 10, 10)
  const P = addPath(d, [Z, A, B, D], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }])
  const C = addPoint(d, 5, 3), S = addPoint(d, 2, 3), E = addPoint(d, 8, 3)
  const Q = addPath(d, [S, E], [{ kind: 'arc', center: C, sweep: 0 }])
  const t = addConstraint(d, 'tangentLineArc', [A, B, C, S])
  return { d, Z, A, B, D, P, C, S, E, Q, t }
}

describe('delete a segment carrying a tangent rule', () => {
  it('open path: the rule on the removed line is dropped and counted, though both ends stay', () => {
    const { d, P, t } = lineAndArc()
    const res = removeSegment(d, P, 1)
    expect(res.ok).toBe(true)
    expect(rule(d, t)).toBeUndefined()
    expect(res.droppedRules).toBe(1)
  })
  it('closed path: the same', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0), B = addPoint(d, 10, 0), D = addPoint(d, 10, 10), F = addPoint(d, 0, 10)
    const P = addPath(d, [A, B, D, F], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    const C = addPoint(d, 5, -3), S = addPoint(d, 2, -3)
    addPath(d, [S, addPoint(d, 8, -3)], [{ kind: 'arc', center: C, sweep: 1 }])
    const t = addConstraint(d, 'tangentLineArc', [A, B, C, S])
    const res = removeSegment(d, P, 0)
    expect(rule(d, t)).toBeUndefined()
    expect(res.droppedRules).toBe(1)
  })
  it('a whole line entity deleted while its ends live on: its tangent rule goes too', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0), B = addPoint(d, 10, 0)
    const L = addLine(d, A, B)
    addLine(d, A, addPoint(d, 0, -5)); addLine(d, B, addPoint(d, 10, -5))
    const C = addPoint(d, 5, 3), S = addPoint(d, 2, 3)
    addPath(d, [S, addPoint(d, 8, 3)], [{ kind: 'arc', center: C, sweep: 0 }])
    const t = addConstraint(d, 'tangentLineArc', [A, B, C, S])
    deleteEntity(d, L)
    expect(rule(d, t)).toBeUndefined()
  })
})

describe('Trim follows a tangent line', () => {
  it('trimming the piece of A–B that ends at the joint B moves the rule onto the kept piece', () => {
    const { d, A, B, P, t } = lineAndArc()
    const cutter = addLine(d, addPoint(d, 7, -5), addPoint(d, 7, 5))
    void cutter
    const res = removeSpan(d, spanAt(d, { kind: 'seg', pathId: P, segIndex: 1 }, 0.9)!)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    const k = rule(d, t)!
    expect(k.refs[0]).toBe(A)
    expect(k.refs[1]).not.toBe(B)
    expect(getPoint(d, k.refs[1]!)!.x).toBeCloseTo(7, 9)
    expect(maxResidual(d)).toBeLessThan(1e-9)
  })
  it('an interior trim keeps the rule on the half nearest the touch point only', () => {
    const { d, A, B, P, t } = lineAndArc()
    addLine(d, addPoint(d, 7, -5), addPoint(d, 7, 5))
    addLine(d, addPoint(d, 8, -5), addPoint(d, 8, 5))
    const res = removeSpan(d, spanAt(d, { kind: 'seg', pathId: P, segIndex: 1 }, 0.75)!)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    expect(ofKind(d, 'tangentLineArc')).toHaveLength(1)
    const k = rule(d, t)!
    expect(k.refs[0]).toBe(A)
    expect(getPoint(d, k.refs[1]!)!.x).toBeCloseTo(7, 9)
    void B
  })
})

describe('Cut on a tangent line', () => {
  it('keeps the rule on the half the arc touches (touch at x=5)', () => {
    const { d, A, B, P, t } = lineAndArc()
    const x = cutAt(d, { kind: 'seg', pathId: P, segIndex: 1 }, 0.7)!
    expect(ofKind(d, 'tangentLineArc')).toHaveLength(1)
    expect(rule(d, t)!.refs.slice(0, 2)).toEqual([A, x])
    const d2 = lineAndArc()
    const x2 = cutAt(d2.d, { kind: 'seg', pathId: d2.P, segIndex: 1 }, 0.3)!
    expect(ofKind(d2.d, 'tangentLineArc')).toHaveLength(1)
    expect(rule(d2.d, d2.t)!.refs.slice(0, 2)).toEqual([x2, d2.B])
    void B
  })
  it('a line entity: the same', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0), B = addPoint(d, 10, 0)
    const L = addLine(d, A, B)
    const C = addPoint(d, 5, 3), S = addPoint(d, 2, 3)
    addPath(d, [S, addPoint(d, 8, 3)], [{ kind: 'arc', center: C, sweep: 0 }])
    const t = addConstraint(d, 'tangentLineArc', [A, B, C, S])
    const x = cutAt(d, { kind: 'line', id: L }, 0.7)!
    expect(ofKind(d, 'tangentLineArc')).toHaveLength(1)
    expect(rule(d, t)!.refs.slice(0, 2)).toEqual([A, x])
  })
})

describe('Dissolve keeps a tangent line', () => {
  it('A–q–B straight into A–B: the rule follows, nothing counted', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0), q = addPoint(d, 4, 0), B = addPoint(d, 10, 0)
    const P = addPath(d, [A, q, B], [{ kind: 'line' }, { kind: 'line' }])
    const C = addPoint(d, 2, 3), S = addPoint(d, -1, 3)
    addPath(d, [S, addPoint(d, 5, 3)], [{ kind: 'arc', center: C, sweep: 0 }])
    const t = addConstraint(d, 'tangentLineArc', [A, q, C, S])
    const res = dissolveAt(d, P, 1, 0.01, 1)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    expect(rule(d, t)!.refs).toEqual([A, B, C, S])
  })
})

describe('Dissolve keeps a tangent arc', () => {
  it('two arcs on coincident centres merge: a rule on the second arc re-aims at the merged arc', () => {
    const d = emptyDoc()
    const a = addPoint(d, 10, 0), q = addPoint(d, 0, 10), b = addPoint(d, -10, 0)
    const C = addPoint(d, 0, 0), C2 = addPoint(d, 0, 0)
    const P = addPath(d, [a, q, b], [{ kind: 'arc', center: C, sweep: 1 }, { kind: 'arc', center: C2, sweep: 1 }])
    const la = addPoint(d, -20, 10), lb = addPoint(d, 20, 10)
    addLine(d, la, lb)
    const t = addConstraint(d, 'tangentLineArc', [la, lb, C2, q])
    const res = dissolveAt(d, P, 1, 0.5, 0.5)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    expect(rule(d, t)!.refs).toEqual([la, lb, C, a])
    expect(maxResidual(d)).toBeLessThan(1e-9)
  })
})

// an arc W —line→ S —arc(C)→ E, S a joint; a radial cutter crossing the arc at t=0.3
function jointArc() {
  const d = emptyDoc()
  const W = addPoint(d, -5, 3), S = addPoint(d, 2, 3), E = addPoint(d, 8, 3), C = addPoint(d, 5, 3)
  const Q = addPath(d, [W, S, E], [{ kind: 'line' }, { kind: 'arc', center: C, sweep: 0 }])
  const g = curveGeom(d, { kind: 'seg', pathId: Q, segIndex: 1 })!
  const on = pointAt(g, 0.3)
  const far = { x: 5 + (on.x - 5) * 2, y: 3 + (on.y - 3) * 2 }
  addLine(d, addPoint(d, 5, 3), addPoint(d, far.x, far.y))
  return { d, W, S, E, C, Q, on }
}

describe('Trim an arc’s start where S is a joint', () => {
  it('tangentLineArc, tangentArcs and arc Equal re-aim at the arc’s new start', () => {
    const { d, S, C, Q, on } = jointArc()
    const A = addPoint(d, -3, 0), B = addPoint(d, 13, 0)
    addLine(d, A, B)
    const C2 = addPoint(d, 20, 3), S2 = addPoint(d, 17, 3)
    addPath(d, [S2, addPoint(d, 23, 3)], [{ kind: 'arc', center: C2, sweep: 0 }])
    const t1 = addConstraint(d, 'tangentLineArc', [A, B, C, S])
    const t2 = addConstraint(d, 'tangentArcs', [C, S, C2, S2], 1)
    const eq = addConstraint(d, 'equalDist', [C, S, C2, S2])
    const res = removeSpan(d, spanAt(d, { kind: 'seg', pathId: Q, segIndex: 1 }, 0.1)!)
    expect(res).toEqual({ ok: true, droppedRules: 0 })
    const x1 = rule(d, t1)!.refs[3]!
    expect(x1).not.toBe(S)
    const px = getPoint(d, x1)!
    expect(px.x).toBeCloseTo(on.x, 6); expect(px.y).toBeCloseTo(on.y, 6)
    expect(rule(d, t2)!.refs).toEqual([C, x1, C2, S2])
    expect(rule(d, eq)!.refs).toEqual([C, x1, C2, S2])
  })
  it('removing the whole arc while S lives on as a joint drops (and counts) its tangent rule', () => {
    const { d, S, C, Q } = jointArc()
    const A = addPoint(d, -3, 0), B = addPoint(d, 13, 0)
    addLine(d, A, B)
    addLine(d, C, addPoint(d, 5, 10))   // the centre stays referenced
    const t1 = addConstraint(d, 'tangentLineArc', [A, B, C, S])
    const res = removeSegment(d, Q, 1)
    expect(rule(d, t1)).toBeUndefined()
    expect(res.droppedRules).toBe(1)
  })
})

describe('drop-to-join never keeps a degenerate tangent rule', () => {
  it('merging a tangent line’s two ends drops tangentLineArc [A, A, …]', () => {
    const { d, A, B, t } = lineAndArc()
    mergePoints(d, B, A)
    expect(rule(d, t)).toBeUndefined()
  })
  it('merging the centre onto a line end drops it', () => {
    const { d, A, C, t } = lineAndArc()
    mergePoints(d, C, A)
    expect(rule(d, t)).toBeUndefined()
  })
  it('merging two tangent arcs’ centres drops tangentArcs', () => {
    const d = emptyDoc()
    const C1 = addPoint(d, 0, 0), S1 = addPoint(d, 3, 0), C2 = addPoint(d, 5, 0), S2 = addPoint(d, 7, 0)
    addPath(d, [S1, addPoint(d, 0, 3)], [{ kind: 'arc', center: C1, sweep: 1 }])
    addPath(d, [S2, addPoint(d, 5, 2)], [{ kind: 'arc', center: C2, sweep: 1 }])
    const t = addConstraint(d, 'tangentArcs', [C1, S1, C2, S2], 1)
    mergePoints(d, C2, C1)
    expect(rule(d, t)).toBeUndefined()
  })
  it('the circle-id form too, when the circle’s centre merges into the arc’s', () => {
    const d = emptyDoc()
    const C1 = addPoint(d, 0, 0), S1 = addPoint(d, 3, 0), C2 = addPoint(d, 5, 0)
    addPath(d, [S1, addPoint(d, 0, 3)], [{ kind: 'arc', center: C1, sweep: 1 }])
    const K = addCircle(d, C2, 2)
    const t = addConstraint(d, 'tangentArcs', [C1, S1, K], 1)
    mergePoints(d, C2, C1)
    expect(rule(d, t)).toBeUndefined()
  })
})
