// tests/unit/pen-tangent-verbs.unit.spec.ts
// Pen stage 4, "Tangent after the fact": two selected pieces (path segments,
// lines, circles — joined or not) offer Tangent, which writes the joint form
// when they meet and the new forms when they don't; two arc segments also
// offer Equal. One history step each.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath } from '~/lib/sketch/edit'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk(build: (d: SketchDoc) => void) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  const pen = usePen({ doc, view: ref(DEV) })
  return { doc, pen }
}
const P = (d: SketchDoc, id: EntityId) => d.entities.find(e => e.id === id) as any
const tangentOf = (pen: ReturnType<typeof usePen>) => pen.availableConstraints().find(o => o.tip === 'tangent')
const maxResidual = (d: SketchDoc) => Math.max(0, ...constraintResiduals(d).map(Math.abs))

describe('Tangent on two segments that don’t meet', () => {
  it('a line segment and an arc segment → tangentLineArc, solved, one undo step', () => {
    let la = '', lb = '', A = '', C = '', line = '', arc = ''
    const { doc, pen } = mk(d => {
      la = addPoint(d, 3, 4); lb = addPoint(d, 11, 4)
      line = addPath(d, [la, lb], [{ kind: 'line' }])
      A = addPoint(d, 4, 6); const B = addPoint(d, 10, 6); C = addPoint(d, 7, 9)
      arc = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    })
    const before = doc.value.constraints.length
    pen.pickSegment(line, 0); pen.pickSegment(arc, 0, true)
    const opt = tangentOf(pen)!
    expect(opt).toMatchObject({ label: 'Tangent', tip: 'tangent', tangent: true })
    pen.applyWithValue(opt)
    const k = doc.value.constraints.find(c => c.kind === 'tangentLineArc')!
    expect(k.refs).toEqual([la, lb, C, A])
    expect(maxResidual(doc.value)).toBeLessThan(1e-5)
    expect(pen.selectedSegments.value).toEqual([])
    expect(pen.sparkleCount()).toBeGreaterThan(0)
    pen.undo()
    expect(doc.value.constraints.length).toBe(before)
  })
  it('applying it twice leaves one rule', () => {
    let line = '', arc = ''
    const { doc, pen } = mk(d => {
      line = addPath(d, [addPoint(d, 3, 4), addPoint(d, 11, 4)], [{ kind: 'line' }])
      arc = addPath(d, [addPoint(d, 4, 6), addPoint(d, 10, 6)], [{ kind: 'arc', center: addPoint(d, 7, 9), sweep: 1 }])
    })
    for (let i = 0; i < 2; i++) { pen.pickSegment(line, 0); pen.pickSegment(arc, 0, true); pen.applyWithValue(tangentOf(pen)!) }
    expect(doc.value.constraints.filter(c => c.kind === 'tangentLineArc')).toHaveLength(1)
  })
  it('applying it twice leaves exactly one history step — nothing to undo past it', () => {
    const before = { constraints: 0 }
    let line = '', arc = ''
    const { doc, pen } = mk(d => {
      line = addPath(d, [addPoint(d, 3, 4), addPoint(d, 11, 4)], [{ kind: 'line' }])
      arc = addPath(d, [addPoint(d, 4, 6), addPoint(d, 10, 6)], [{ kind: 'arc', center: addPoint(d, 7, 9), sweep: 1 }])
    })
    before.constraints = doc.value.constraints.length
    for (let i = 0; i < 2; i++) { pen.pickSegment(line, 0); pen.pickSegment(arc, 0, true); pen.applyWithValue(tangentOf(pen)!) }
    expect(pen.canUndo()).toBe(true)
    pen.undo()
    // one undo removes the rule entirely — the duplicate application pushed no step of its own
    expect(doc.value.constraints.length).toBe(before.constraints)
    expect(pen.canUndo()).toBe(false)
  })
  it('two arc segments → Tangent (side from the geometry) and Equal', () => {
    let a1 = '', a2 = '', C1 = '', S1 = '', C2 = '', S2 = ''
    const { doc, pen } = mk(d => {
      S1 = addPoint(d, 4, 6); C1 = addPoint(d, 7, 9)
      a1 = addPath(d, [S1, addPoint(d, 10, 6)], [{ kind: 'arc', center: C1, sweep: 1 }])
      S2 = addPoint(d, 14, 9); C2 = addPoint(d, 15, 9)
      a2 = addPath(d, [S2, addPoint(d, 16, 9)], [{ kind: 'arc', center: C2, sweep: 1 }])
    })
    pen.pickSegment(a1, 0); pen.pickSegment(a2, 0, true)
    const opts = pen.availableConstraints()
    expect(opts.map(o => o.tip ?? o.kind)).toEqual(['tangent', 'equalArcs'])
    pen.applyWithValue(opts[0]!)
    expect(doc.value.constraints.find(c => c.kind === 'tangentArcs')).toMatchObject({ refs: [C1, S1, C2, S2], value: 1 })
    expect(maxResidual(doc.value)).toBeLessThan(1e-5)
    pen.pickSegment(a1, 0); pen.pickSegment(a2, 0, true)
    pen.applyWithValue(pen.availableConstraints().find(o => o.tip === 'equalArcs')!)
    expect(doc.value.constraints.some(c => c.kind === 'equalDist' && c.refs.join() === [C1, S1, C2, S2].join())).toBe(true)
    const r1 = Math.hypot(P(doc.value, S1).x - P(doc.value, C1).x, P(doc.value, S1).y - P(doc.value, C1).y)
    const r2 = Math.hypot(P(doc.value, S2).x - P(doc.value, C2).x, P(doc.value, S2).y - P(doc.value, C2).y)
    expect(r1).toBeCloseTo(r2, 4)
  })
  it('two line segments get no Tangent', () => {
    let path = ''
    const { pen } = mk(d => { path = addPath(d, [addPoint(d, 0, 0), addPoint(d, 5, 0), addPoint(d, 5, 5)], [{ kind: 'line' }, { kind: 'line' }]) })
    pen.pickSegment(path, 0); pen.pickSegment(path, 1, true)
    expect(tangentOf(pen)).toBeUndefined()
  })
})

describe('Tangent where the pieces already meet', () => {
  it('a line then an arc in one path → the joint rule, and the corner turns smooth', () => {
    let P0 = '', A = '', C = '', path = ''
    const { doc, pen } = mk(d => {
      P0 = addPoint(d, 1, 6); A = addPoint(d, 4, 6); C = addPoint(d, 7, 9)
      path = addPath(d, [P0, A, addPoint(d, 10, 6)], [{ kind: 'line' }, { kind: 'arc', center: C, sweep: 1 }])
    })
    pen.pickSegment(path, 1); pen.pickSegment(path, 0, true)
    pen.applyWithValue(tangentOf(pen)!)
    expect(doc.value.constraints.find(c => c.kind === 'perpendicular')!.refs).toEqual([P0, A, A, C])
    const p0 = P(doc.value, P0), a = P(doc.value, A), c = P(doc.value, C)
    expect((a.x - p0.x) * (c.x - a.x) + (a.y - p0.y) * (c.y - a.y)).toBeCloseTo(0, 4)
  })
})

describe('Tangent with a whole line or circle', () => {
  it('a line entity kept with an Option-clicked arc → tangentLineArc on the line’s ends', () => {
    let l = '', a = '', b = '', C = '', A = '', arc = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 2); b = addPoint(d, 14, 2); l = addLine(d, a, b)
      A = addPoint(d, 4, 6); C = addPoint(d, 7, 9)
      arc = addPath(d, [A, addPoint(d, 10, 6)], [{ kind: 'arc', center: C, sweep: 1 }])
    })
    pen.pick(l)
    pen.pickSegment(arc, 0)
    expect(pen.selection.value).toEqual([l])
    expect(pen.selectedSegments.value).toEqual([{ pathId: arc, segIndex: 0 }])
    pen.applyWithValue(tangentOf(pen)!)
    expect(doc.value.constraints.find(c => c.kind === 'tangentLineArc')!.refs).toEqual([a, b, C, A])
    expect(maxResidual(doc.value)).toBeLessThan(1e-5)
  })
  it('a circle with a line segment → tangentLineArc [A, B, circle]', () => {
    let k = '', la = '', lb = '', line = ''
    const { doc, pen } = mk(d => {
      k = addCircle(d, addPoint(d, 7, 9), 2)
      la = addPoint(d, 0, 4); lb = addPoint(d, 14, 4)
      line = addPath(d, [la, lb], [{ kind: 'line' }])
    })
    pen.pickSegment(line, 0)
    pen.pick(k, true)
    pen.applyWithValue(tangentOf(pen)!)
    expect(doc.value.constraints.find(c => c.kind === 'tangentLineArc')!.refs).toEqual([la, lb, k])
    expect(maxResidual(doc.value)).toBeLessThan(1e-5)
  })
  it('a point with an arc segment still offers On curve only', () => {
    let p = '', arc = ''
    const { pen } = mk(d => {
      p = addPoint(d, 20, 20)
      arc = addPath(d, [addPoint(d, 4, 6), addPoint(d, 10, 6)], [{ kind: 'arc', center: addPoint(d, 7, 9), sweep: 1 }])
    })
    pen.pick(p); pen.pickSegment(arc, 0)
    expect(pen.availableConstraints().map(o => o.tip ?? o.kind)).toEqual(['onCurve'])
  })
})

// final review fixes: an equivalent rule already there is not written twice;
// two arcs joined on one centre get no Tangent
describe('Tangent never duplicates an equivalent rule', () => {
  it('an arc then a line whose joint rule the Pen captured as [C, J, J, N] → no second rule', () => {
    let path = '', C = '', J = '', N = ''
    const { doc, pen } = mk(d => {
      const S = addPoint(d, 4, 6); J = addPoint(d, 10, 6); C = addPoint(d, 7, 9); N = addPoint(d, 13, 3)
      path = addPath(d, [S, J, N], [{ kind: 'arc', center: C, sweep: 1 }, { kind: 'line' }])
      d.constraints.push({ id: 'cap', kind: 'perpendicular', refs: [C, J, J, N] })
    })
    pen.pickSegment(path, 1); pen.pickSegment(path, 0, true)
    pen.applyWithValue(tangentOf(pen)!)
    expect(doc.value.constraints.filter(c => c.kind === 'perpendicular')).toHaveLength(1)
    expect(pen.canUndo()).toBe(false)
  })
  it('two joined arcs picked in either order → one collinear', () => {
    let path = ''
    const { doc, pen } = mk(d => {
      const S = addPoint(d, 4, 6), J = addPoint(d, 10, 6), E = addPoint(d, 16, 6)
      path = addPath(d, [S, J, E], [{ kind: 'arc', center: addPoint(d, 7, 9), sweep: 1 }, { kind: 'arc', center: addPoint(d, 13, 3), sweep: 0 }])
    })
    pen.pickSegment(path, 0); pen.pickSegment(path, 1, true); pen.applyWithValue(tangentOf(pen)!)
    pen.pickSegment(path, 1); pen.pickSegment(path, 0, true); pen.applyWithValue(tangentOf(pen)!)
    expect(doc.value.constraints.filter(c => c.kind === 'collinear')).toHaveLength(1)
  })
  it('two arcs joined on the same centre → no Tangent offered', () => {
    let path = ''
    const { doc, pen } = mk(d => {
      const C = addPoint(d, 0, 0)
      path = addPath(d, [addPoint(d, 5, 0), addPoint(d, 0, 5), addPoint(d, -5, 0)], [{ kind: 'arc', center: C, sweep: 1 }, { kind: 'arc', center: C, sweep: 1 }])
    })
    pen.pickSegment(path, 0); pen.pickSegment(path, 1, true)
    expect(tangentOf(pen)).toBeUndefined()
    expect(doc.value.constraints.some(c => c.kind === 'collinear')).toBe(false)
  })
})
