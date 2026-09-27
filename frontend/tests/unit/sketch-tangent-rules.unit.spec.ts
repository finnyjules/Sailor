// tests/unit/sketch-tangent-rules.unit.spec.ts
// The two tangency rules added in pen stage 4: tangentLineArc (a line and an
// arc or circle that don't share a point) and tangentArcs (two arcs/circles,
// outside or inside each other). Residuals, the analytic Jacobian checked
// against central differences, a solve that makes a drawing tangent, loading,
// and the badge.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId, SketchConstraint } from '~/lib/sketch/model'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { buildJacobian } from '~/lib/sketch/jacobian'
import { solve } from '~/lib/sketch/solve'
import { mergeSketchDoc } from '~/lib/sketch/merge'
import { constraintMarks } from '~/lib/sketch/annotate'
import { tangentTouchPoint } from '~/lib/sketch/tangency'

type Slot = { kind: 'px' | 'py' | 'r'; id: EntityId }
function allSlots(doc: SketchDoc): Slot[] {
  const slots: Slot[] = []
  for (const e of doc.entities) {
    if (e.kind === 'point') slots.push({ kind: 'px', id: e.id }, { kind: 'py', id: e.id })
    else if (e.kind === 'circle') slots.push({ kind: 'r', id: e.id })
  }
  return slots
}
function readSlot(doc: SketchDoc, s: Slot): number {
  const e = doc.entities.find(x => x.id === s.id)! as any
  return s.kind === 'px' ? e.x : s.kind === 'py' ? e.y : e.r
}
function writeSlot(doc: SketchDoc, s: Slot, v: number): void {
  const e = doc.entities.find(x => x.id === s.id)! as any
  if (s.kind === 'px') e.x = v
  else if (s.kind === 'py') e.y = v
  else e.r = v
}
function numericalJacobian(doc: SketchDoc, slots: Slot[]): number[][] {
  const h = 1e-6
  const m = constraintResiduals(doc).length
  const J: number[][] = Array.from({ length: m }, () => new Array(slots.length).fill(0))
  slots.forEach((s, j) => {
    const orig = readSlot(doc, s)
    writeSlot(doc, s, orig + h); const plus = constraintResiduals(doc)
    writeSlot(doc, s, orig - h); const minus = constraintResiduals(doc)
    writeSlot(doc, s, orig)
    for (let i = 0; i < m; i++) J[i]![j] = (plus[i]! - minus[i]!) / (2 * h)
  })
  return J
}
function expectJacobianMatches(doc: SketchDoc): void {
  const slots = allSlots(doc)
  const a = buildJacobian(doc, slots)
  const n = numericalJacobian(doc, slots)
  expect(a.length).toBe(constraintResiduals(doc).length)
  expect(a.length).toBe(n.length)
  for (let i = 0; i < a.length; i++) for (let j = 0; j < slots.length; j++) {
    if (Math.abs(a[i]![j]! - n[i]![j]!) > 1e-4) throw new Error(`row ${i} col ${j} (${slots[j]!.kind}:${slots[j]!.id}): analytic=${a[i]![j]} numeric=${n[i]![j]}`)
  }
}
const pt = (id: string, x: number, y: number) => ({ id, kind: 'point' as const, x, y })
const circ = (id: string, center: string, r: number) => ({ id, kind: 'circle' as const, center, r })
const rule = (kind: any, refs: string[], value?: number): SketchConstraint => ({ id: 'k', kind, refs, ...(value != null ? { value } : {}) })

describe('tangentLineArc residual', () => {
  it('is zero when the arc touches the line, and the gap otherwise', () => {
    const touching: SketchDoc = { entities: [pt('A', 0, 0), pt('B', 10, 0), pt('C', 5, 3), pt('S', 8, 3)], constraints: [rule('tangentLineArc', ['A', 'B', 'C', 'S'])] }
    expect(constraintResiduals(touching)[0]).toBeCloseTo(0, 12)
    const apart: SketchDoc = { entities: [pt('A', 0, 0), pt('B', 10, 0), pt('C', 5, 4), pt('S', 8, 4)], constraints: [rule('tangentLineArc', ['A', 'B', 'C', 'S'])] }
    expect(constraintResiduals(apart)[0]).toBeCloseTo(1, 12)
    // below the line counts the same (absolute distance)
    const below: SketchDoc = { entities: [pt('A', 0, 0), pt('B', 10, 0), pt('C', 5, -3), pt('S', 5, 0)], constraints: [rule('tangentLineArc', ['A', 'B', 'C', 'S'])] }
    expect(constraintResiduals(below)[0]).toBeCloseTo(0, 12)
  })
  it('accepts a circle id in place of the centre and arc point', () => {
    const doc: SketchDoc = { entities: [pt('A', 0, 0), pt('B', 10, 0), pt('cc', 5, 3), circ('K', 'cc', 3)], constraints: [rule('tangentLineArc', ['A', 'B', 'K'])] }
    expect(constraintResiduals(doc)).toHaveLength(1)
    expect(constraintResiduals(doc)[0]).toBeCloseTo(0, 12)
  })
  it('scores nothing for refs of the wrong shape', () => {
    const doc: SketchDoc = { entities: [pt('A', 0, 0), pt('B', 10, 0), pt('C', 5, 3)], constraints: [rule('tangentLineArc', ['A', 'B', 'C'])] }
    expect(constraintResiduals(doc)).toHaveLength(0)
    expect(buildJacobian(doc, allSlots(doc))).toHaveLength(0)
  })
})

describe('tangentArcs residual', () => {
  it('outside (+1): centres apart by the sum of the radii', () => {
    const doc: SketchDoc = { entities: [pt('C1', 0, 0), pt('S1', 2, 0), pt('C2', 5, 0), pt('S2', 5, 3)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], 1)] }
    expect(constraintResiduals(doc)[0]).toBeCloseTo(0, 12)
  })
  it('inside (−1): centres apart by the difference of the radii', () => {
    const doc: SketchDoc = { entities: [pt('C1', 0, 0), pt('S1', 5, 0), pt('C2', 2, 0), pt('S2', 2, 3)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], -1)] }
    expect(constraintResiduals(doc)[0]).toBeCloseTo(0, 12)
  })
  it('circle ids stand in for either pair', () => {
    const doc: SketchDoc = {
      entities: [pt('C1', 0, 0), pt('S1', 2, 0), pt('q', 5, 0), circ('K', 'q', 3), pt('q2', 0, 0), circ('K2', 'q2', 8)],
      constraints: [
        { id: 'k1', kind: 'tangentArcs', refs: ['C1', 'S1', 'K'], value: 1 },
        { id: 'k2', kind: 'tangentArcs', refs: ['K', 'C1', 'S1'], value: 1 },
        { id: 'k3', kind: 'tangentArcs', refs: ['K2', 'K'], value: -1 },
      ],
    }
    const r = constraintResiduals(doc)
    expect(r).toHaveLength(3)
    expect(r[0]).toBeCloseTo(0, 12)
    expect(r[1]).toBeCloseTo(0, 12)
    expect(r[2]).toBeCloseTo(0, 12)   // |(0,0)-(5,0)| = 5 = 8 - 3
  })
  it('scores nothing without a side of exactly 1 or −1', () => {
    for (const v of [undefined, 0, 2]) {
      const doc: SketchDoc = { entities: [pt('C1', 0, 0), pt('S1', 2, 0), pt('C2', 5, 0), pt('S2', 5, 3)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], v)] }
      expect(constraintResiduals(doc)).toHaveLength(0)
    }
  })
})

describe('analytic Jacobian rows match central differences', () => {
  it('tangentLineArc, point pair form', () => {
    expectJacobianMatches({ entities: [pt('A', 0.3, -0.2), pt('B', 10, 2), pt('C', 5, 6), pt('S', 7.5, 4)], constraints: [rule('tangentLineArc', ['A', 'B', 'C', 'S'])] })
  })
  it('tangentLineArc, centre below the line (negative signed distance)', () => {
    expectJacobianMatches({ entities: [pt('A', 0, 0), pt('B', 10, 1), pt('C', 4, -5), pt('S', 6, -2)], constraints: [rule('tangentLineArc', ['A', 'B', 'C', 'S'])] })
  })
  it('tangentLineArc, circle form', () => {
    expectJacobianMatches({ entities: [pt('A', 0, 0), pt('B', 9, 3), pt('cc', 4, 7), circ('K', 'cc', 2.5)], constraints: [rule('tangentLineArc', ['A', 'B', 'K'])] })
  })
  it('tangentArcs outside, both pairs', () => {
    expectJacobianMatches({ entities: [pt('C1', 0, 0), pt('S1', 2, 1), pt('C2', 6, 2), pt('S2', 6, 5)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], 1)] })
  })
  it('tangentArcs inside, first larger', () => {
    expectJacobianMatches({ entities: [pt('C1', 0, 0), pt('S1', 6, 1), pt('C2', 1, 2), pt('S2', 1, 4)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], -1)] })
  })
  it('tangentArcs inside, second larger', () => {
    expectJacobianMatches({ entities: [pt('C1', 1, 2), pt('S1', 1, 4), pt('C2', 0, 0), pt('S2', 6, 1)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], -1)] })
  })
  it('tangentArcs with circle ids on either side and both sides', () => {
    expectJacobianMatches({
      entities: [pt('C1', 0, 0), pt('S1', 2, 1), pt('q', 6, 2), circ('K', 'q', 2.2), pt('q2', -1, 1), circ('K2', 'q2', 9)],
      constraints: [
        { id: 'k1', kind: 'tangentArcs', refs: ['C1', 'S1', 'K'], value: 1 },
        { id: 'k2', kind: 'tangentArcs', refs: ['K', 'C1', 'S1'], value: -1 },
        { id: 'k3', kind: 'tangentArcs', refs: ['K2', 'K'], value: -1 },
      ],
    })
  })
})

describe('solving', () => {
  it('pulls a free arc onto a fixed line', () => {
    const doc: SketchDoc = {
      entities: [{ ...pt('A', 0, 0), fixed: true }, { ...pt('B', 10, 0), fixed: true }, pt('C', 5, 4), pt('S', 8, 4)],
      constraints: [rule('tangentLineArc', ['A', 'B', 'C', 'S'])],
    }
    const res = solve(doc)
    expect(res.converged).toBe(true)
    expect(Math.abs(constraintResiduals(doc)[0]!)).toBeLessThan(1e-5)
  })
  it('pulls two arcs into touching, inside', () => {
    const doc: SketchDoc = {
      entities: [{ ...pt('C1', 0, 0), fixed: true }, { ...pt('S1', 5, 0), fixed: true }, pt('C2', 1, 0), pt('S2', 1, 3)],
      constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], -1)],
    }
    expect(solve(doc).converged).toBe(true)
    expect(Math.abs(constraintResiduals(doc)[0]!)).toBeLessThan(1e-5)
  })
})

describe('loading and badges', () => {
  it('mergeSketchDoc keeps both kinds, and drops tangentArcs without its side', () => {
    const raw = {
      entities: [pt('A', 0, 0), pt('B', 10, 0), pt('C', 5, 3), pt('S', 8, 3), pt('C2', 5, 9), pt('S2', 5, 6)],
      constraints: [
        { id: 'k1', kind: 'tangentLineArc', refs: ['A', 'B', 'C', 'S'] },
        { id: 'k2', kind: 'tangentArcs', refs: ['C', 'S', 'C2', 'S2'], value: 1 },
        { id: 'k3', kind: 'tangentArcs', refs: ['C', 'S', 'C2', 'S2'] },
      ],
    }
    expect(mergeSketchDoc(raw).constraints.map(c => c.id)).toEqual(['k1', 'k2'])
  })
  it('both show a T badge at the touch point, and the side is not shown as a number', () => {
    const doc: SketchDoc = {
      entities: [pt('A', 0, 0), pt('B', 10, 0), pt('C', 5, 3), pt('S', 8, 3), pt('C2', 5, 8), pt('S2', 5, 6)],
      constraints: [
        { id: 'k1', kind: 'tangentLineArc', refs: ['A', 'B', 'C', 'S'] },
        { id: 'k2', kind: 'tangentArcs', refs: ['C', 'S', 'C2', 'S2'], value: 1 },
      ],
    }
    const marks = constraintMarks(doc)
    const m1 = marks.find(m => m.id === 'k1')!, m2 = marks.find(m => m.id === 'k2')!
    expect(m1.glyph).toBe('T'); expect(m2.glyph).toBe('T')
    expect(m2.text).toBeUndefined()
    expect(m1.x).toBeCloseTo(5, 9); expect(m1.y).toBeCloseTo(0, 9)   // foot of C on the line
    expect(m2.x).toBeCloseTo(5, 9); expect(m2.y).toBeCloseTo(6, 9)   // 3 up from C towards C2
  })
  it('the touch point of an inside pair lies on both circles', () => {
    const doc: SketchDoc = { entities: [pt('C1', 1, 0), pt('S1', 1, 2), pt('C2', 0, 0), pt('S2', 3, 0)], constraints: [rule('tangentArcs', ['C1', 'S1', 'C2', 'S2'], -1)] }
    const t = tangentTouchPoint(doc, doc.constraints[0]!)!
    expect(Math.hypot(t.x - 1, t.y)).toBeCloseTo(2, 9)
    expect(Math.hypot(t.x, t.y)).toBeCloseTo(3, 9)
  })
})
