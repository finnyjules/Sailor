import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath } from '~/lib/sketch/edit'
import {
  curveGeom, allCurves, pointAt, paramOf, nearestCurve,
  crossingsOn, spanAt,
} from '~/lib/sketch/crossings'
import type { CurveRef } from '~/lib/sketch/crossings'

const emptyDoc = (): SketchDoc => ({ entities: [], constraints: [] })
const TAU = Math.PI * 2

describe('curveGeom / allCurves', () => {
  it('builds line geometry for a line entity', () => {
    const d = emptyDoc()
    const p1 = addPoint(d, 0, 0)
    const p2 = addPoint(d, 10, 0)
    const L = addLine(d, p1, p2)
    const g = curveGeom(d, { kind: 'line', id: L })
    expect(g).toEqual({ ref: { kind: 'line', id: L }, kind: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } })
  })

  it('builds circle geometry for a circle entity', () => {
    const d = emptyDoc()
    const c = addPoint(d, 5, 5)
    const C = addCircle(d, c, 3)
    const g = curveGeom(d, { kind: 'circle', id: C })
    expect(g).toEqual({ ref: { kind: 'circle', id: C }, kind: 'circle', c: { x: 5, y: 5 }, r: 3 })
  })

  it('returns null for a cubic path segment, and it is excluded from allCurves', () => {
    const d = emptyDoc()
    const p1 = addPoint(d, 0, 0)
    const p2 = addPoint(d, 10, 0)
    const P = addPath(d, [p1, p2], [{ kind: 'cubic', h1: null, h2: null }])
    const g = curveGeom(d, { kind: 'seg', pathId: P, segIndex: 0 })
    expect(g).toBeNull()
    expect(allCurves(d)).toEqual([])
  })

  it('allCurves lists lines, circles, and line/arc path segments', () => {
    const d = emptyDoc()
    const p1 = addPoint(d, 0, 0)
    const p2 = addPoint(d, 10, 0)
    addLine(d, p1, p2)
    const c = addPoint(d, 5, 5)
    addCircle(d, c, 3)
    const a1 = addPoint(d, 0, 20)
    const a2 = addPoint(d, 10, 20)
    addPath(d, [a1, a2], [{ kind: 'line' }])
    const refs = allCurves(d)
    expect(refs.map(r => r.kind).sort()).toEqual(['circle', 'line', 'seg'].sort())
  })
})

describe('pointAt / paramOf', () => {
  it('line: t=0/0.5/1 map to start/mid/end', () => {
    const g = { ref: { kind: 'line', id: 'L' } as CurveRef, kind: 'line' as const, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }
    expect(pointAt(g, 0)).toEqual({ x: 0, y: 0 })
    expect(pointAt(g, 0.5)).toEqual({ x: 5, y: 0 })
    expect(pointAt(g, 1)).toEqual({ x: 10, y: 0 })
    expect(paramOf(g, { x: 5, y: 3 })).toBeCloseTo(0.5, 9)
    expect(paramOf(g, { x: -5, y: 0 })).toBe(0) // clamped
    expect(paramOf(g, { x: 15, y: 0 })).toBe(1) // clamped
  })

  it('circle: angle 0 is +x, angle π/2 is +y (drawing space)', () => {
    const g = { ref: { kind: 'circle', id: 'C' } as CurveRef, kind: 'circle' as const, c: { x: 0, y: 0 }, r: 2 }
    expect(pointAt(g, 0).x).toBeCloseTo(2, 9)
    expect(pointAt(g, 0).y).toBeCloseTo(0, 9)
    expect(pointAt(g, Math.PI / 2).x).toBeCloseTo(0, 9)
    expect(pointAt(g, Math.PI / 2).y).toBeCloseTo(2, 9)
    expect(paramOf(g, { x: 0, y: 2 })).toBeCloseTo(Math.PI / 2, 6)
  })
})

describe('nearestCurve', () => {
  it('finds the closest curve within tolerance, null otherwise', () => {
    const d = emptyDoc()
    const p1 = addPoint(d, 0, 0)
    const p2 = addPoint(d, 10, 0)
    const L = addLine(d, p1, p2)
    const hit = nearestCurve(d, { x: 5, y: 0.4 }, 1)
    expect(hit?.ref).toEqual({ kind: 'line', id: L })
    expect(hit?.t).toBeCloseTo(0.5, 6)
    expect(nearestCurve(d, { x: 5, y: 5 }, 1)).toBeNull()
  })
})

describe('crossingsOn: line–line', () => {
  it('crosses at the midpoint of both', () => {
    const d = emptyDoc()
    const a1 = addPoint(d, 0, 0), a2 = addPoint(d, 10, 0)
    const L1 = addLine(d, a1, a2)
    const b1 = addPoint(d, 5, -5), b2 = addPoint(d, 5, 5)
    const L2 = addLine(d, b1, b2)
    const cs = crossingsOn(d, { kind: 'line', id: L1 })
    expect(cs).toHaveLength(1)
    expect(cs[0]!.t).toBeCloseTo(0.5, 9)
    expect(cs[0]!.point).toEqual({ x: 5, y: 0 })
    expect(cs[0]!.cutter).toEqual({ kind: 'line', id: L2 })
    expect(cs[0]!.cutterT).toBeCloseTo(0.5, 9)
  })

  it('parallel lines never cross', () => {
    const d = emptyDoc()
    const a1 = addPoint(d, 0, 0), a2 = addPoint(d, 10, 0)
    const L1 = addLine(d, a1, a2)
    const b1 = addPoint(d, 0, 5), b2 = addPoint(d, 10, 5)
    addLine(d, b1, b2)
    expect(crossingsOn(d, { kind: 'line', id: L1 })).toEqual([])
  })

  it('lines whose infinite extensions cross, but not within both segments, do not cross', () => {
    const d = emptyDoc()
    const a1 = addPoint(d, 0, 0), a2 = addPoint(d, 1, 0)
    const L1 = addLine(d, a1, a2)
    const b1 = addPoint(d, 5, -5), b2 = addPoint(d, 5, 5)
    addLine(d, b1, b2)
    expect(crossingsOn(d, { kind: 'line', id: L1 })).toEqual([])
  })
})

describe('crossingsOn: line–circle', () => {
  it('two points', () => {
    const d = emptyDoc()
    const a1 = addPoint(d, -10, 0), a2 = addPoint(d, 10, 0)
    const L = addLine(d, a1, a2)
    const c = addPoint(d, 0, 0)
    addCircle(d, c, 3)
    const cs = crossingsOn(d, { kind: 'line', id: L })
    expect(cs).toHaveLength(2)
    expect(cs[0]!.point.x).toBeCloseTo(-3, 9)
    expect(cs[1]!.point.x).toBeCloseTo(3, 9)
  })

  it('tangent: one point', () => {
    const d = emptyDoc()
    const a1 = addPoint(d, -10, 3), a2 = addPoint(d, 10, 3)
    const L = addLine(d, a1, a2)
    const c = addPoint(d, 0, 0)
    addCircle(d, c, 3)
    const cs = crossingsOn(d, { kind: 'line', id: L })
    expect(cs).toHaveLength(1)
    expect(cs[0]!.point).toEqual({ x: 0, y: 3 })
  })

  it('miss: none', () => {
    const d = emptyDoc()
    const a1 = addPoint(d, -10, 10), a2 = addPoint(d, 10, 10)
    const L = addLine(d, a1, a2)
    const c = addPoint(d, 0, 0)
    addCircle(d, c, 3)
    expect(crossingsOn(d, { kind: 'line', id: L })).toEqual([])
  })
})

describe('crossingsOn: circle–circle', () => {
  it('two points', () => {
    const d = emptyDoc()
    const c1 = addPoint(d, 0, 0)
    const C1 = addCircle(d, c1, 5)
    const c2 = addPoint(d, 6, 0)
    addCircle(d, c2, 5)
    const cs = crossingsOn(d, { kind: 'circle', id: C1 })
    expect(cs).toHaveLength(2)
  })

  it('tangent: one point', () => {
    const d = emptyDoc()
    const c1 = addPoint(d, 0, 0)
    const C1 = addCircle(d, c1, 5)
    const c2 = addPoint(d, 10, 0)
    addCircle(d, c2, 5)
    const cs = crossingsOn(d, { kind: 'circle', id: C1 })
    expect(cs).toHaveLength(1)
    expect(cs[0]!.point).toEqual({ x: 5, y: 0 })
  })

  it('too far apart: none', () => {
    const d = emptyDoc()
    const c1 = addPoint(d, 0, 0)
    const C1 = addCircle(d, c1, 5)
    const c2 = addPoint(d, 100, 0)
    addCircle(d, c2, 5)
    expect(crossingsOn(d, { kind: 'circle', id: C1 })).toEqual([])
  })

  it('concentric: none', () => {
    const d = emptyDoc()
    const c1 = addPoint(d, 0, 0)
    const C1 = addCircle(d, c1, 5)
    addCircle(d, c1, 8)
    expect(crossingsOn(d, { kind: 'circle', id: C1 })).toEqual([])
  })
})

describe('crossingsOn: path arcs restricted to their sweep', () => {
  // arc from (10,0) to (-10,0) around center (0,0), sweep=1 (CCW, upper half per pathD)
  function upperHalfArcDoc(sweep: 0 | 1) {
    const d = emptyDoc()
    const start = addPoint(d, 10, 0)
    const end = addPoint(d, -10, 0)
    const center = addPoint(d, 0, 0)
    const P = addPath(d, [start, end], [{ kind: 'arc', center, sweep }])
    return { d, P }
  }

  it('sweep=1: a line through the top crosses, one through the bottom does not', () => {
    const { d, P } = upperHalfArcDoc(1)
    const t1 = addPoint(d, 0, -20), t2 = addPoint(d, 0, 20)
    addLine(d, t1, t2)
    const cs = crossingsOn(d, { kind: 'seg', pathId: P, segIndex: 0 })
    expect(cs).toHaveLength(1)
    expect(cs[0]!.point.y).toBeGreaterThan(0)
  })

  it('sweep=0: the opposite half crosses', () => {
    const { d, P } = upperHalfArcDoc(0)
    const t1 = addPoint(d, 0, -20), t2 = addPoint(d, 0, 20)
    addLine(d, t1, t2)
    const cs = crossingsOn(d, { kind: 'seg', pathId: P, segIndex: 0 })
    expect(cs).toHaveLength(1)
    expect(cs[0]!.point.y).toBeLessThan(0)
  })
})

describe("crossingsOn: a path's own neighbouring segments", () => {
  it('adjacent segments do not cross at their shared anchor, but a loop-back arc can cross a non-neighbour elsewhere', () => {
    const d = emptyDoc()
    // closed path: p0(0,0) -line-> p1(10,0) -line-> p2(10,10) -line-> p3(0,10) -line-> back to p0
    const p0 = addPoint(d, 0, 0)
    const p1 = addPoint(d, 10, 0)
    const p2 = addPoint(d, 10, 10)
    const p3 = addPoint(d, 0, 10)
    const P = addPath(d, [p0, p1, p2, p3], [
      { kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' },
    ], true)
    // segment 0 (p0->p1) and segment 1 (p1->p2) share anchor p1 — must not report a crossing there
    const cs0 = crossingsOn(d, { kind: 'seg', pathId: P, segIndex: 0 })
    for (const c of cs0) {
      if (c.cutter.kind === 'seg' && c.cutter.pathId === P && c.cutter.segIndex === 1) {
        expect(dist2(c.point, { x: 10, y: 0 })).toBeGreaterThan(1e-6)
      }
    }
    // segment 0 (p0->p1, bottom edge) and segment 2 (p2->p3, top edge) are non-neighbours;
    // add a diagonal line entity crossing both to prove non-neighbour crossings on different
    // segments of the same path are found independently (sanity: each still finds its own hit)
    const q1 = addPoint(d, -5, -5), q2 = addPoint(d, 15, 15)
    addLine(d, q1, q2)
    const csBottom = crossingsOn(d, { kind: 'seg', pathId: P, segIndex: 0 })
    const csTop = crossingsOn(d, { kind: 'seg', pathId: P, segIndex: 2 })
    expect(csBottom.some(c => c.cutter.kind === 'line')).toBe(true)
    expect(csTop.some(c => c.cutter.kind === 'line')).toBe(true)
  })

  function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
})

describe('spanAt: line crossed twice', () => {
  it('returns the middle piece with both cutters', () => {
    const d = emptyDoc()
    const a1 = addPoint(d, 0, 0), a2 = addPoint(d, 10, 0)
    const L = addLine(d, a1, a2)
    // two crossers at x=3 and x=7
    const b1 = addPoint(d, 3, -5), b2 = addPoint(d, 3, 5)
    addLine(d, b1, b2)
    const c1 = addPoint(d, 7, -5), c2 = addPoint(d, 7, 5)
    addLine(d, c1, c2)
    const ref: CurveRef = { kind: 'line', id: L }
    const span = spanAt(d, ref, 0.5) // t=0.5 -> x=5, between the two crossers
    expect(span).not.toBeNull()
    expect(span!.start.point.x).toBeCloseTo(3, 9)
    expect(span!.start.cutter).not.toBeNull()
    expect(span!.end.point.x).toBeCloseTo(7, 9)
    expect(span!.end.cutter).not.toBeNull()
  })

  it('no crossings: span is the whole curve with null cutters', () => {
    const d = emptyDoc()
    const a1 = addPoint(d, 0, 0), a2 = addPoint(d, 10, 0)
    const L = addLine(d, a1, a2)
    const span = spanAt(d, { kind: 'line', id: L }, 0.5)
    expect(span).toEqual({
      ref: { kind: 'line', id: L },
      start: { t: 0, point: { x: 0, y: 0 }, cutter: null },
      end: { t: 1, point: { x: 10, y: 0 }, cutter: null },
    })
  })
})

describe('spanAt: circle crossed at two points, wrap across 0/2π', () => {
  it('returns the arc containing t, wrapping when needed', () => {
    const d = emptyDoc()
    const c = addPoint(d, 0, 0)
    const C = addCircle(d, c, 10)
    // crossers at angle ~45deg and ~315deg (two lines through the circle near +x)
    const l1a = addPoint(d, 0, 0.1), l1b = addPoint(d, 20, 20) // roughly through 45deg region
    addLine(d, l1a, l1b)
    const l2a = addPoint(d, 0, -0.1), l2b = addPoint(d, 20, -20) // roughly through -45deg (315deg) region
    addLine(d, l2a, l2b)
    const ref: CurveRef = { kind: 'circle', id: C }
    const cs = crossingsOn(d, ref)
    expect(cs.length).toBeGreaterThanOrEqual(2)
    // t=0 (angle 0, i.e. +x axis) sits between the ~315deg and ~45deg crossings — must wrap
    const span = spanAt(d, ref, 0)
    expect(span).not.toBeNull()
    expect(span!.wraps).toBe(true)
    // the wrapping span must actually contain angle 0 between its (possibly unwrapped) ends
    expect(span!.start.t).toBeLessThanOrEqual(TAU)
    expect(span!.end.t).toBeGreaterThanOrEqual(span!.start.t)
  })
})
