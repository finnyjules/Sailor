// tests/unit/sketch-tangency.unit.spec.ts
// Pen stage 4 geometry: reading a curve as a tangent piece, choosing the rule
// that makes two pieces tangent (joined → the joint form, apart → the new
// forms, side from the geometry), and the snap that makes an arc being bowed
// through two fixed points touch a nearby line, circle or arc.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath } from '~/lib/sketch/edit'
import { pieceOf, tangentRuleFor, bowTangentSnap, curveKey } from '~/lib/sketch/tangency'

const empty = (): SketchDoc => ({ entities: [], constraints: [] })
const seg = (pathId: EntityId, segIndex = 0) => ({ kind: 'seg' as const, pathId, segIndex })

describe('pieceOf', () => {
  it('reads lines, circles, line and arc segments; refuses a Bézier segment', () => {
    const d = empty()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0)
    const l = addLine(d, a, b)
    const cc = addPoint(d, 9, 9); const k = addCircle(d, cc, 2)
    const p = addPoint(d, 0, 5), q = addPoint(d, 4, 5), c = addPoint(d, 2, 5)
    const arc = addPath(d, [p, q], [{ kind: 'arc', center: c, sweep: 1 }])
    const h1 = addPoint(d, 1, 8), h2 = addPoint(d, 3, 8)
    const cub = addPath(d, [addPoint(d, 0, 7), addPoint(d, 4, 7)], [{ kind: 'cubic', h1, h2 }])
    expect(pieceOf(d, { kind: 'line', id: l })).toEqual({ kind: 'line', a, b, lineId: l })
    expect(pieceOf(d, { kind: 'circle', id: k })).toEqual({ kind: 'circle', id: k, c: cc })
    expect(pieceOf(d, seg(arc))).toEqual({ kind: 'arc', c, s: p, e: q })
    expect(pieceOf(d, seg(cub))).toBeNull()
    expect(curveKey(seg(arc, 0))).toBe(`${arc}:0`)
    expect(curveKey({ kind: 'line', id: l })).toBe(l)
  })
})

describe('tangentRuleFor', () => {
  function drawing() {
    const d = empty()
    // a line segment (3,4)→(11,4), an arc (4,6)→(10,6) centred (7,9) dipping to y≈4.76,
    // a second arc well to the right, a circle, and a line entity
    const la = addPoint(d, 3, 4), lb = addPoint(d, 11, 4)
    const linePath = addPath(d, [la, lb], [{ kind: 'line' }])
    const A = addPoint(d, 4, 6), B = addPoint(d, 10, 6), C = addPoint(d, 7, 9)
    const arcPath = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    const A2 = addPoint(d, 14, 9), B2 = addPoint(d, 16, 9), C2 = addPoint(d, 15, 9)
    const arc2 = addPath(d, [A2, B2], [{ kind: 'arc', center: C2, sweep: 1 }])
    const kc = addPoint(d, 7, 16); const K = addCircle(d, kc, 2)
    const ea = addPoint(d, 0, 20), eb = addPoint(d, 10, 20); const L = addLine(d, ea, eb)
    return { d, la, lb, linePath, A, B, C, arcPath, A2, C2, arc2, K, L, ea, eb }
  }
  it('line segment + arc apart → tangentLineArc [A, B, C, S], in either order', () => {
    const g = drawing()
    const line = pieceOf(g.d, seg(g.linePath))!, arc = pieceOf(g.d, seg(g.arcPath))!
    const want = { kind: 'tangentLineArc', refs: [g.la, g.lb, g.C, g.A] }
    expect(tangentRuleFor(g.d, line, arc)).toEqual(want)
    expect(tangentRuleFor(g.d, arc, line)).toEqual(want)
  })
  it('line segment + circle → tangentLineArc [A, B, circle]; line entity + circle keeps tangentLineCircle', () => {
    const g = drawing()
    expect(tangentRuleFor(g.d, pieceOf(g.d, seg(g.linePath))!, pieceOf(g.d, { kind: 'circle', id: g.K })!))
      .toEqual({ kind: 'tangentLineArc', refs: [g.la, g.lb, g.K] })
    expect(tangentRuleFor(g.d, pieceOf(g.d, { kind: 'circle', id: g.K })!, pieceOf(g.d, { kind: 'line', id: g.L })!))
      .toEqual({ kind: 'tangentLineCircle', refs: [g.L, g.K] })
  })
  it('two arcs apart → tangentArcs with the side nearer to true', () => {
    const g = drawing()
    // r1 ≈ 4.24 centred (7,9); r2 = 1 centred (15,9): d = 8, outside gap 2.76 < inside gap 4.76 → +1
    expect(tangentRuleFor(g.d, pieceOf(g.d, seg(g.arcPath))!, pieceOf(g.d, seg(g.arc2))!))
      .toEqual({ kind: 'tangentArcs', refs: [g.C, g.A, g.C2, g.A2], value: 1 })
  })
  it('a small arc inside a big circle → side −1, circle by id', () => {
    const d = empty()
    const q = addPoint(d, 0, 0); const K = addCircle(d, q, 10)
    const A = addPoint(d, 1, 0), B = addPoint(d, 3, 0), C = addPoint(d, 2, 0)
    const arc = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    expect(tangentRuleFor(d, pieceOf(d, seg(arc))!, pieceOf(d, { kind: 'circle', id: K })!))
      .toEqual({ kind: 'tangentArcs', refs: [C, A, K], value: -1 })
  })
  it('joined line + arc → perpendicular [other end, J, J, C]; joined arcs → collinear [C1, J, C2]', () => {
    const d = empty()
    const P0 = addPoint(d, 1, 6), A = addPoint(d, 4, 6), B = addPoint(d, 10, 6), C = addPoint(d, 7, 9)
    const E = addPoint(d, 14, 6), C3 = addPoint(d, 12, 8)
    const path = addPath(d, [P0, A, B, E], [{ kind: 'line' }, { kind: 'arc', center: C, sweep: 1 }, { kind: 'arc', center: C3, sweep: 1 }])
    const line = pieceOf(d, seg(path, 0))!, arc = pieceOf(d, seg(path, 1))!, arc3 = pieceOf(d, seg(path, 2))!
    expect(tangentRuleFor(d, arc, line)).toEqual({ kind: 'perpendicular', refs: [P0, A, A, C] })
    expect(tangentRuleFor(d, arc, arc3)).toEqual({ kind: 'collinear', refs: [C, B, C3] })
  })
  it('two lines, or two round pieces on one centre, have no tangent rule', () => {
    const g = drawing()
    expect(tangentRuleFor(g.d, pieceOf(g.d, seg(g.linePath))!, pieceOf(g.d, { kind: 'line', id: g.L })!)).toBeNull()
    const d = empty()
    const c = addPoint(d, 0, 0); const K1 = addCircle(d, c, 1); const K2 = addCircle(d, c, 3)
    expect(tangentRuleFor(d, pieceOf(d, { kind: 'circle', id: K1 })!, pieceOf(d, { kind: 'circle', id: K2 })!)).toBeNull()
  })
})

describe('bowTangentSnap — an arc through J=(6,5) and E=(12,5)', () => {
  const J = { x: 6, y: 5 }, E = { x: 12, y: 5 }
  it('snaps onto a line it nearly touches: centre (9,5), radius 3, touching at (9,2)', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 2, 2), addPoint(d, 16, 2))
    // the free arc through the pointer (9, 2.1) is centred at (9, 5.1017)
    const s = bowTangentSnap(d, J, E, { x: 9, y: 5.1017 }, 0.6, [])!
    expect(s.target).toEqual({ kind: 'line', id: l })
    expect(s.center.x).toBeCloseTo(9, 9); expect(s.center.y).toBeCloseTo(5, 9)
    expect(s.r).toBeCloseTo(3, 9)
    expect(s.touch.x).toBeCloseTo(9, 9); expect(s.touch.y).toBeCloseTo(2, 9)
    expect(s.side).toBe(1)
  })
  it('does nothing when the gap is over the tolerance', () => {
    const d = empty()
    addLine(d, addPoint(d, 2, 2), addPoint(d, 16, 2))
    expect(bowTangentSnap(d, J, E, { x: 9, y: 6.5 }, 0.6, [])).toBeNull()
  })
  it('the touch point must be between a line’s ends', () => {
    const d = empty()
    addLine(d, addPoint(d, 12, 2), addPoint(d, 16, 2))   // would touch at (9,2), off this line
    expect(bowTangentSnap(d, J, E, { x: 9, y: 5.1017 }, 0.6, [])).toBeNull()
  })
  it('skips a piece that ends at J or E', () => {
    const d = empty()
    const j = addPoint(d, 6, 5)
    addLine(d, j, addPoint(d, 6, 1))
    addLine(d, addPoint(d, 2, 2), addPoint(d, 16, 2))
    const s = bowTangentSnap(d, J, E, { x: 9, y: 5.1017 }, 0.6, [j])!
    expect(s.target.kind).toBe('line')
    expect(s.touch.y).toBeCloseTo(2, 9)
  })
  it('touches a circle from outside: centre (9,3.4), radius 3.4, at (9,0)', () => {
    const d = empty()
    const k = addCircle(d, addPoint(d, 9, -2), 2)
    const s = bowTangentSnap(d, J, E, { x: 9, y: 3.3 }, 0.6, [])!
    expect(s.target).toEqual({ kind: 'circle', id: k })
    expect(s.center.y).toBeCloseTo(3.4, 9); expect(s.r).toBeCloseTo(3.4, 9)
    expect(s.touch.x).toBeCloseTo(9, 9); expect(s.touch.y).toBeCloseTo(0, 9)
    expect(s.side).toBe(1)
  })
  it('touches a big circle from inside: centre (9,7.25), radius 3.75, at (9,11)', () => {
    const d = empty()
    addCircle(d, addPoint(d, 9, 5), 6)
    const s = bowTangentSnap(d, J, E, { x: 9, y: 7.1 }, 0.6, [])!
    expect(s.side).toBe(-1)
    expect(s.center.y).toBeCloseTo(7.25, 9); expect(s.r).toBeCloseTo(3.75, 9)
    expect(s.touch.y).toBeCloseTo(11, 9)
  })
  it('touches an arc only on its drawn part', () => {
    const top = empty()
    const a = addPoint(top, 7, -2), b = addPoint(top, 11, -2), c = addPoint(top, 9, -2)
    const arc = addPath(top, [a, b], [{ kind: 'arc', center: c, sweep: 0 }])   // the upper half, through (9,0)
    const s = bowTangentSnap(top, J, E, { x: 9, y: 3.3 }, 0.6, [])!
    expect(s.target).toEqual({ kind: 'seg', pathId: arc, segIndex: 0 })
    expect(s.touch.y).toBeCloseTo(0, 9)
    const bottom = empty()
    const a2 = addPoint(bottom, 7, -2), b2 = addPoint(bottom, 11, -2), c2 = addPoint(bottom, 9, -2)
    addPath(bottom, [a2, b2], [{ kind: 'arc', center: c2, sweep: 1 }])         // the lower half
    expect(bowTangentSnap(bottom, J, E, { x: 9, y: 3.3 }, 0.6, [])).toBeNull()
  })
})
