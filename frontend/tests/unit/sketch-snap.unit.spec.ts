// tests/unit/sketch-snap.unit.spec.ts
// Stage 3 snap targets: path arcs, path line segments and midpoints, each
// clamped to its own extent; priority point > midpoint > curve, then nearest.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { snapPoint, snapRule, snapPreviewKind } from '~/lib/sketch/infer'
import { solve } from '~/lib/sketch/solve'

const emptyDoc = (): SketchDoc => ({ entities: [], constraints: [] })
const pt = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any

// a closed "circle-ish" path of two half arcs: anchors (0,0) and (10,0), centre (5,0)
function arcPath() {
  const d = emptyDoc()
  const A = addPoint(d, 0, 0)
  const B = addPoint(d, 10, 0)
  const C = addPoint(d, 5, 0)
  const P = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }, { kind: 'arc', center: C, sweep: 1 }], true)
  return { d, A, B, C, P }
}

describe('snapPoint — path arc segments', () => {
  it('snaps onto the drawn arc and carries the segment it landed on', () => {
    const { d, P, C, A } = arcPath()
    // sweep 1 from (0,0) to (10,0) about (5,0) runs CCW through the angle PI→2PI, i.e. y<0 in a y-up sense (atan2)
    const s0 = snapPoint(d, 5, -5.3, { tol: 0.6 })
    expect(s0.snap?.kind).toBe('onSegment')
    const snap = s0.snap as any
    expect(snap.pathId).toBe(P)
    expect(snap.seg).toBe('arc')
    expect(s0.x).toBeCloseTo(5, 6)
    expect(s0.y).toBeCloseTo(-5, 6)
    expect(snap.segIndex).toBe(0)
    expect(snapRule(snap, 'NEW')).toEqual({ kind: 'equalDist', refs: [C, 'NEW', C, A] })
  })

  it('only on the drawn extent — the other half of an open arc path does not snap', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0)
    const B = addPoint(d, 10, 0)
    const C = addPoint(d, 5, 0)
    addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    // which half is drawn: the one through (5,-5)
    expect(snapPoint(d, 5, -5.2, { tol: 0.6 }).snap?.kind).toBe('onSegment')
    expect(snapPoint(d, 5, 5.2, { tol: 0.6 }).snap).toBeNull()
  })

  it('writes equalDist [C,p,C,A] and solve keeps the point on the arc when the centre moves', () => {
    const { d } = arcPath()
    const s = snapPoint(d, 5, -5.2, { tol: 0.6 })
    const p = addPoint(d, s.x, s.y)
    const rule = snapRule(s.snap!, p)!
    addConstraint(d, rule.kind, rule.refs)
    expect(rule.kind).toBe('equalDist')
    const [c, , , a] = rule.refs
    // drag the centre to a new spot; every point stays at the arc's radius
    solve(d, { drag: { point: c!, x: 5, y: 1 } })
    const C = pt(d, c!), Pp = pt(d, p), Ap = pt(d, a!)
    expect(Math.hypot(Pp.x - C.x, Pp.y - C.y)).toBeCloseTo(Math.hypot(Ap.x - C.x, Ap.y - C.y), 5)
  })
})

describe('snapPoint — path line segments and line entities', () => {
  it('path line segment → onSegment with collinear [A,B,p]', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0)
    const B = addPoint(d, 10, 0)
    const P = addPath(d, [A, B], [{ kind: 'line' }])
    const s = snapPoint(d, 3, 0.4, { tol: 0.6 })
    expect(s.snap).toMatchObject({ kind: 'onSegment', pathId: P, segIndex: 0, seg: 'line' })
    expect(s.y).toBeCloseTo(0, 9)
    expect(snapRule(s.snap!, 'NEW')).toEqual({ kind: 'collinear', refs: [A, B, 'NEW'] })
  })

  it('path line segment is clamped to its ends', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0)
    const B = addPoint(d, 10, 0)
    addPath(d, [A, B], [{ kind: 'line' }])
    expect(snapPoint(d, 13, 0.1, { tol: 0.6 }).snap).toBeNull()
  })

  it('a line entity projection outside its ends does NOT snap', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0)
    const b = addPoint(d, 10, 0)
    addLine(d, a, b)
    expect(snapPoint(d, 14, 0.2, { tol: 0.6 }).snap).toBeNull()
    expect(snapPoint(d, -3, -0.2, { tol: 0.6 }).snap).toBeNull()
    // …but between its ends it still does
    const s = snapPoint(d, 3, 0.2, { tol: 0.6 })
    expect(s.snap?.kind).toBe('pointOnLine')
  })

  it('cubic segments are ignored', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0)
    const B = addPoint(d, 10, 0)
    addPath(d, [A, B], [{ kind: 'cubic', h1: null, h2: null }])
    expect(snapPoint(d, 3, 0.1, { tol: 0.6 }).snap).toBeNull()
    expect(snapPoint(d, 5, 0.1, { tol: 0.6 }).snap).toBeNull()
  })

  it('an excluded path is not a target', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0)
    const B = addPoint(d, 10, 0)
    const P = addPath(d, [A, B], [{ kind: 'line' }])
    expect(snapPoint(d, 3, 0.1, { tol: 0.6, exclude: [P] }).snap).toBeNull()
  })
})

describe('snapPoint — midpoints and priority', () => {
  it('midpoint beats curve at the middle of a line entity', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0)
    const b = addPoint(d, 10, 0)
    addLine(d, a, b)
    const s = snapPoint(d, 5.2, 0.1, { tol: 0.6 })
    expect(s.snap).toMatchObject({ kind: 'midpoint', a, b })
    expect(s).toMatchObject({ x: 5, y: 0 })
    expect(snapRule(s.snap!, 'NEW')).toEqual({ kind: 'midpoint', refs: ['NEW', a, b] })
  })

  it('midpoint of a path line segment', () => {
    const d = emptyDoc()
    const A = addPoint(d, 0, 0)
    const B = addPoint(d, 0, 10)
    addPath(d, [A, B], [{ kind: 'line' }])
    const s = snapPoint(d, 0.3, 5.3, { tol: 0.6 })
    expect(s.snap).toMatchObject({ kind: 'midpoint', a: A, b: B })
  })

  it('arcs have no midpoint snap', () => {
    const { d } = arcPath()
    expect(snapPoint(d, 5, -5.1, { tol: 0.6 }).snap?.kind).toBe('onSegment')
  })

  it('point beats midpoint', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0)
    const b = addPoint(d, 10, 0)
    addLine(d, a, b)
    const q = addPoint(d, 5.4, 0.3)   // a loose point near the middle
    const s = snapPoint(d, 5.2, 0.1, { tol: 0.6 })
    expect(s.snap).toMatchObject({ kind: 'coincident', targetId: q })
  })

  it('among curves, nearest wins; a circle still snaps', () => {
    const d = emptyDoc()
    const c = addPoint(d, 5, 10)
    const C = addCircle(d, c, 3)
    const s = snapPoint(d, 5, 7.3, { tol: 0.6 })
    expect(s.snap).toMatchObject({ kind: 'pointOnCircle', targetId: C })
    expect(snapRule(s.snap!, 'NEW')).toEqual({ kind: 'pointOnCircle', refs: ['NEW', C] })
  })

  it('snapPreviewKind maps every kind onto point / midpoint / curve', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0)
    const b = addPoint(d, 10, 0)
    addLine(d, a, b)
    expect(snapPreviewKind(snapPoint(d, 0.1, 0.1, { tol: 0.6 }).snap!)).toBe('point')
    expect(snapPreviewKind(snapPoint(d, 5.1, 0.1, { tol: 0.6 }).snap!)).toBe('midpoint')
    expect(snapPreviewKind(snapPoint(d, 2, 0.1, { tol: 0.6 }).snap!)).toBe('curve')
    expect(snapRule(snapPoint(d, 0.1, 0.1, { tol: 0.6 }).snap!, 'NEW')).toBeNull()
  })
})
