// tests/unit/sketch-stage8-rules.unit.spec.ts
// Pen stage 8: offsetLine / offsetRadius / translatedFrom — residuals, analytic
// Jacobian rows against central differences, degenerate cases, solving (and
// translatedFrom copies substituted like Repeat's), save / load, names.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { buildJacobian } from '~/lib/sketch/jacobian'
import { analyzeDerived } from '~/lib/sketch/substitute'
import { solve } from '~/lib/sketch/solve'
import { mergeSketchDoc } from '~/lib/sketch/merge'
import { addPoint, addPath, addCircle, addConstraint } from '~/lib/sketch/edit'
import { ruleName, ruleLabel, pieceNames, pieceIndex, rulesForSelection, isCopyRule } from '~/lib/sketch/pieces'

type Slot = { kind: 'px' | 'py' | 'r'; id: EntityId }
function allSlots(doc: SketchDoc): Slot[] {
  const s: Slot[] = []
  for (const e of doc.entities) {
    if (e.kind === 'point') s.push({ kind: 'px', id: e.id }, { kind: 'py', id: e.id })
    else if (e.kind === 'circle') s.push({ kind: 'r', id: e.id })
  }
  return s
}
const get = (d: SketchDoc, s: Slot) => { const e = d.entities.find(x => x.id === s.id) as any; return s.kind === 'px' ? e.x : s.kind === 'py' ? e.y : e.r }
const set = (d: SketchDoc, s: Slot, v: number) => { const e = d.entities.find(x => x.id === s.id) as any; if (s.kind === 'px') e.x = v; else if (s.kind === 'py') e.y = v; else e.r = v }
function numeric(doc: SketchDoc, slots: Slot[]): number[][] {
  const h = 1e-6, m = constraintResiduals(doc).length
  const J = Array.from({ length: m }, () => new Array(slots.length).fill(0))
  slots.forEach((s, j) => {
    const o = get(doc, s)
    set(doc, s, o + h); const rp = constraintResiduals(doc)
    set(doc, s, o - h); const rm = constraintResiduals(doc)
    set(doc, s, o)
    for (let i = 0; i < m; i++) J[i]![j] = (rp[i]! - rm[i]!) / (2 * h)
  })
  return J
}
function expectRowsMatch(doc: SketchDoc) {
  const slots = allSlots(doc)
  const a = buildJacobian(doc, slots), n = numeric(doc, slots)
  expect(a.length).toBe(n.length)
  a.forEach((row, i) => row.forEach((v, j) => expect(Math.abs(v - n[i]![j]!), `row ${i} col ${j}`).toBeLessThan(1e-4)))
}
const doc = (): SketchDoc => ({ entities: [], constraints: [] })
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any

describe('offsetLine [A, B, P] value d', () => {
  it('is P’s signed distance from A→B (left positive) minus d', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), p = addPoint(d, 1, 2), q = addPoint(d, 3, -1)
    addConstraint(d, 'offsetLine', [a, b, p], 2)
    addConstraint(d, 'offsetLine', [a, b, q], 2)
    const r = constraintResiduals(d)
    expect(r[0]).toBeCloseTo(0, 12)
    expect(r[1]).toBeCloseTo(-3, 12)
  })
  it('analytic rows match central differences, either side, slanted', () => {
    const d = doc()
    const a = addPoint(d, 0.3, -0.2), b = addPoint(d, 4.1, 1.7), p = addPoint(d, 1, 2.5), q = addPoint(d, 3, -1)
    addConstraint(d, 'offsetLine', [a, b, p], 1.5)
    addConstraint(d, 'offsetLine', [a, b, q], -0.7)
    expectRowsMatch(d)
  })
  it('a zero-length line scores nothing and has no row', () => {
    const d = doc()
    const a = addPoint(d, 1, 1), b = addPoint(d, 1, 1), p = addPoint(d, 3, 3)
    addConstraint(d, 'offsetLine', [a, b, p], 1)
    expect(constraintResiduals(d)).toHaveLength(0)
    expect(buildJacobian(d, allSlots(d))).toHaveLength(0)
  })
  it('without a value it scores nothing', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), p = addPoint(d, 1, 2)
    addConstraint(d, 'offsetLine', [a, b, p])
    expect(constraintResiduals(d)).toHaveLength(0)
    expect(buildJacobian(d, allSlots(d))).toHaveLength(0)
  })
  it('solving holds the copy at the distance when its source line turns', () => {
    const d = doc()
    const a = addPoint(d, 0, 0, { fixed: true }), b = addPoint(d, 4, 0), p = addPoint(d, 2, 1)
    addConstraint(d, 'offsetLine', [a, b, p], 1)
    expect(solve(d, { drag: { point: b, x: 0, y: 4 } }).converged).toBe(true)
    // the line now runs up the y axis: its left is −x
    expect(P(d, p).x).toBeCloseTo(-1, 5)
  })
})

describe('offsetRadius [C, S, C, T] value d', () => {
  it('is |CT| − |CS| − d, pairs or circle ids', () => {
    const d = doc()
    const c = addPoint(d, 0, 0), s = addPoint(d, 3, 0), t = addPoint(d, 0, 4)
    addConstraint(d, 'offsetRadius', [c, s, c, t], 1)
    const c1 = addCircle(d, c, 2), c2 = addCircle(d, c, 2.5)
    addConstraint(d, 'offsetRadius', [c1, c2], 0.5)
    addConstraint(d, 'offsetRadius', [c, s, c2], -1)
    const r = constraintResiduals(d)
    expect(r[0]).toBeCloseTo(0, 12)
    expect(r[1]).toBeCloseTo(0, 12)
    expect(r[2]).toBeCloseTo(0.5, 12)
  })
  it('analytic rows match central differences (pairs, circles, mixed)', () => {
    const d = doc()
    const c = addPoint(d, 0.2, -0.3), s = addPoint(d, 3, 0.5), t = addPoint(d, -0.5, 4), c3 = addPoint(d, 5, 5)
    addConstraint(d, 'offsetRadius', [c, s, c, t], 1)
    const k1 = addCircle(d, c3, 2), k2 = addCircle(d, c3, 2.7)
    addConstraint(d, 'offsetRadius', [k1, k2], 0.5)
    addConstraint(d, 'offsetRadius', [c, s, k2], -1)
    expectRowsMatch(d)
  })
  it('a zero radius still scores (|CT| − 0 − d), one row', () => {
    const d = doc()
    const c = addPoint(d, 1, 1), s = addPoint(d, 1, 1), t = addPoint(d, 1, 3)
    addConstraint(d, 'offsetRadius', [c, s, c, t], 2)
    expect(constraintResiduals(d)).toEqual([0])
    expect(buildJacobian(d, allSlots(d))).toHaveLength(1)
  })
  it('solving keeps an offset arc’s radius when the source arc grows', () => {
    const d = doc()
    const c = addPoint(d, 0, 0, { fixed: true }), s = addPoint(d, 3, 0), e = addPoint(d, 0, 3)
    addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
    const t = addPoint(d, 2, 0), u = addPoint(d, 0, 2)
    addPath(d, [t, u], [{ kind: 'arc', center: c, sweep: 1 }])
    addConstraint(d, 'offsetRadius', [c, s, c, t], -1)
    expect(solve(d, { drag: { point: s, x: 5, y: 0 } }).converged).toBe(true)
    expect(Math.hypot(P(d, t).x, P(d, t).y)).toBeCloseTo(4, 5)
    expect(Math.hypot(P(d, u).x, P(d, u).y)).toBeCloseTo(4, 5)
  })
})

describe('translatedFrom [copy, orig, from, to] value k', () => {
  it('is copy − (orig + k·(to − from)), two rows', () => {
    const d = doc()
    const o = addPoint(d, 1, 1), f = addPoint(d, 0, 0), t = addPoint(d, 2, 1), c = addPoint(d, 5, 3)
    addConstraint(d, 'translatedFrom', [c, o, f, t], 2)
    expect(constraintResiduals(d).map(v => Math.abs(v) < 1e-12)).toEqual([true, true])
  })
  it('analytic rows match central differences, k = 2.5 and from = to', () => {
    const d = doc()
    const o = addPoint(d, 1, 1.5), f = addPoint(d, -0.2, 0.1), t = addPoint(d, 2, 1), c = addPoint(d, 7, 3)
    addConstraint(d, 'translatedFrom', [c, o, f, t], 2.5)
    addConstraint(d, 'translatedFrom', [c, o, f, f], 1)   // from = to: copy = orig
    expectRowsMatch(d)
    expect(constraintResiduals(d).slice(2)).toEqual([P(d, c).x - P(d, o).x, P(d, c).y - P(d, o).y])
  })
  it('its copies are derived (substituted) like Repeat’s, and follow a drag of the guide’s end', () => {
    const d = doc()
    const f = addPoint(d, 0, 0, { fixed: true }), t = addPoint(d, 2, 0)
    const src = [[0, 0.5], [1, 0.5], [1, 1.5]].map(([x, y]) => addPoint(d, x!, y!))
    const copies: string[] = []
    for (const k of [1, 2, 3]) for (const s of src) {
      const cp = addPoint(d, P(d, s).x + 2 * k, P(d, s).y)
      addConstraint(d, 'translatedFrom', [cp, s, f, t], k)
      copies.push(cp)
    }
    expect(analyzeDerived(d, new Set()).rules.size).toBe(9)
    expect(solve(d, { drag: { point: t, x: 0, y: 3 } }).converged).toBe(true)
    // the third copy of the first source point: (0, 0.5) + 3·(0, 3)
    expect(P(d, copies[6]!).x).toBeCloseTo(0, 6)
    expect(P(d, copies[6]!).y).toBeCloseTo(9.5, 6)
  })
})

describe('save / load and names', () => {
  it('mergeSketchDoc keeps the three kinds with a value and drops one without', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), p = addPoint(d, 1, 2)
    addConstraint(d, 'offsetLine', [a, b, p], 2)
    addConstraint(d, 'offsetRadius', [a, b, a, p], 1)
    addConstraint(d, 'translatedFrom', [p, a, a, b], 1)
    addConstraint(d, 'offsetLine', [a, b, p])
    const m = mergeSketchDoc(JSON.parse(JSON.stringify(d)))
    expect(m.constraints.map(c => c.kind)).toEqual(['offsetLine', 'offsetRadius', 'translatedFrom'])
  })
  it('names in plain words, pieces by their names; linear copies hidden, offsets listed', () => {
    const d = doc()
    const c = addPoint(d, 0, 0), s = addPoint(d, 3, 0), e = addPoint(d, 0, 3), t = addPoint(d, 2, 0), u = addPoint(d, 0, 2)
    const arc1 = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
    addPath(d, [t, u], [{ kind: 'arc', center: c, sweep: 1 }])
    const off = addConstraint(d, 'offsetRadius', [c, s, c, t], -1)
    const lin = addConstraint(d, 'translatedFrom', [u, e, c, s], 0.5)
    const ix = pieceIndex(d), names = pieceNames(d, ix)
    const k = (id: string) => d.constraints.find(x => x.id === id)!
    expect(ruleName(d, k(off), ix)).toBe('Offset 1')
    expect(ruleLabel(d, k(off), names, ix)).toBe('Offset 1 — Arc 1 · Arc 2')
    expect(ruleName(d, k(lin), ix)).toBe('Linear copy')
    expect(isCopyRule(k(lin))).toBe(true)
    const listed = rulesForSelection(d, [arc1], [], ix).map(x => x.id)
    expect(listed).toContain(off)
    expect(listed).not.toContain(lin)
  })
})
