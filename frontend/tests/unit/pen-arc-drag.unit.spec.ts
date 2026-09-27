// tests/unit/pen-arc-drag.unit.spec.ts
// Pen stage 4, dragging arcs in Select: pulling the bow changes the radius
// while the ends stay put (unless a rule needs them to move), the transient
// point is gone afterwards, crossing the chord flips the arc, the drag is one
// undo step; ⌘-drag moves the centre.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addConstraint } from '~/lib/sketch/edit'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
const P = (d: SketchDoc, id: EntityId) => d.entities.find(e => e.id === id) as any
// an arc (4,6) → (10,6) centred (7,9), dipping to (7, 4.757)
function mkArc(extra?: (d: SketchDoc, ids: { A: string; B: string; C: string }) => void) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const A = addPoint(doc.value, 4, 6), B = addPoint(doc.value, 10, 6), C = addPoint(doc.value, 7, 9)
  const path = addPath(doc.value, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
  extra?.(doc.value, { A, B, C })
  const pen = usePen({ doc, view: ref(DEV) })
  return { doc, pen, A, B, C, path }
}
const key = (k: string) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {}, stopPropagation() {} }) as unknown as KeyboardEvent
const BOTTOM = { x: 7, y: 9 - Math.hypot(3, 3) }

describe('dragging an arc’s bow', () => {
  it('changes the radius, keeps the ends, leaves no extra point, and is one undo step', () => {
    const { doc, pen, A, B, C, path } = mkArc()
    const ents = doc.value.entities.length, cons = doc.value.constraints.length
    expect(pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)).toBe(true)
    const t = pen.arcDragTransient()!
    expect(P(doc.value, t)).toMatchObject({ construction: true })
    pen.arcDragMove(7, 4.2); pen.arcDragMove(7, 3.5)
    expect(P(doc.value, t).x).toBeCloseTo(7, 9); expect(P(doc.value, t).y).toBeCloseTo(3.5, 9)
    pen.arcDragEnd()
    expect(pen.arcDragTransient()).toBeNull()
    expect(doc.value.entities.length).toBe(ents)
    expect(doc.value.constraints.length).toBe(cons)
    expect(P(doc.value, A)).toMatchObject({ x: 4, y: 6 })
    expect(P(doc.value, B)).toMatchObject({ x: 10, y: 6 })
    expect(P(doc.value, C).x).toBeCloseTo(7, 4)
    expect(P(doc.value, C).y).toBeCloseTo(6.55, 4)   // through (4,6), (10,6), (7,3.5)
    pen.undo()
    expect(P(doc.value, C)).toMatchObject({ x: 7, y: 9 })
  })
  it('a tangent line that isn’t joined follows; the rule holds', () => {
    const { doc, pen, path } = mkArc((d, { A, C }) => {
      const la = addPoint(d, 0, 9 - Math.hypot(3, 3)), lb = addPoint(d, 14, 9 - Math.hypot(3, 3))
      addLine(d, la, lb)
      addConstraint(d, 'tangentLineArc', [la, lb, C, A])
    })
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)
    pen.arcDragMove(7, 4.2); pen.arcDragEnd()
    expect(Math.max(...constraintResiduals(doc.value).map(Math.abs))).toBeLessThan(1e-5)
  })
  it('a joined tangent line makes the shared end slide; the joint stays smooth', () => {
    let P0 = ''
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    P0 = addPoint(doc.value, 1, 9)
    const A = addPoint(doc.value, 4, 6), B = addPoint(doc.value, 10, 6), C = addPoint(doc.value, 7, 9)
    const path = addPath(doc.value, [P0, A, B], [{ kind: 'line' }, { kind: 'arc', center: C, sweep: 1 }])
    addConstraint(doc.value, 'perpendicular', [P0, A, A, C])
    const pen = usePen({ doc, view: ref(DEV) })
    pen.arcDragStart(path, 1, BOTTOM.x, BOTTOM.y)
    pen.arcDragMove(7, 4.5); pen.arcDragMove(7, 4.2); pen.arcDragEnd()
    expect(Math.max(...constraintResiduals(doc.value).map(Math.abs))).toBeLessThan(1e-5)
    expect(doc.value.entities.filter(e => e.kind === 'point')).toHaveLength(4)
  })
  it('pulling across the chord flips the arc so it still runs under the pointer', () => {
    const { doc, pen, C, path } = mkArc()
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)
    pen.arcDragMove(7, 7)
    pen.arcDragEnd()
    const p = P(doc.value, path)
    expect(p.segments[0].sweep).toBe(0)
    expect(P(doc.value, C).y).toBeCloseTo(2, 4)   // through (4,6), (10,6), (7,7)
  })
  it('a press that never moves changes nothing and adds no history', () => {
    const { doc, pen, path } = mkArc()
    const before = JSON.stringify(doc.value)
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)
    pen.arcDragEnd()
    expect(JSON.stringify(doc.value)).toBe(before)
    expect(pen.canUndo()).toBe(false)
  })
  it('undo during a drag settles it, then steps back over it', () => {
    const { doc, pen, C, path } = mkArc()
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)
    pen.arcDragMove(7, 3.5)
    pen.undo()
    expect(pen.arcDragTransient()).toBeNull()
    expect(P(doc.value, C)).toMatchObject({ x: 7, y: 9 })
  })
  it('refuses a line segment', () => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const path = addPath(doc.value, [addPoint(doc.value, 0, 0), addPoint(doc.value, 5, 0)], [{ kind: 'line' }])
    const pen = usePen({ doc, view: ref(DEV) })
    expect(pen.arcDragStart(path, 0, 2, 0)).toBe(false)
  })
})

describe('an arc drag interrupted or stuck', () => {
  it('a key verb mid-drag settles the drag first; undo never brings the transient point back', () => {
    const { doc, pen, C, path } = mkArc()
    const ents = doc.value.entities.length, cons = doc.value.constraints.length
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)
    pen.arcDragMove(7, 3.5)
    pen.selection.value = [C]
    pen.onKeydown(key('ArrowRight'))
    expect(pen.arcDragTransient()).toBeNull()
    pen.arcDragEnd()
    for (let i = 0; i < 3; i++) {
      pen.undo()
      expect(doc.value.entities.filter(e => (e as any).construction)).toHaveLength(0)
      expect(doc.value.entities.length).toBe(ents)
      expect(doc.value.constraints.length).toBe(cons)
    }
    expect(P(doc.value, C)).toMatchObject({ x: 7, y: 9 })
  })
  it('a bare modifier key leaves the drag live', () => {
    const { pen, path } = mkArc()
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)
    pen.arcDragMove(7, 4.2)
    pen.onKeydown(key('Shift'))
    expect(pen.arcDragTransient()).not.toBeNull()
    pen.arcDragEnd()
  })
  it('a move no solve can meet leaves the arc as it was — no flip, centre back', () => {
    // ends fixed, radius typed: only centres (7,9) and (7,3) fit, and neither
    // puts the arc through (7,7)
    const { doc, pen, C, path } = mkArc((d, { A, B, C }) => {
      ;(d.entities.find(e => e.id === A) as any).fixed = true
      ;(d.entities.find(e => e.id === B) as any).fixed = true
      addConstraint(d, 'distance', [C, A], Math.hypot(3, 3))
    })
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)
    pen.arcDragMove(7, 7)
    expect(P(doc.value, path).segments[0].sweep).toBe(1)
    expect(P(doc.value, C).x).toBeCloseTo(7, 9); expect(P(doc.value, C).y).toBeCloseTo(9, 9)
    pen.arcDragEnd()
    expect(P(doc.value, path).segments[0].sweep).toBe(1)
  })
  it('a flip reports a live change', () => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const A = addPoint(doc.value, 4, 6), B = addPoint(doc.value, 10, 6), C = addPoint(doc.value, 7, 9)
    const path = addPath(doc.value, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    const sweeps: number[] = []
    const pen = usePen({ doc, view: ref(DEV), onLiveChange: () => sweeps.push((P(doc.value, path).segments[0]).sweep) })
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y)
    pen.arcDragMove(7, 7)
    expect(sweeps.at(-1)).toBe(0)
    pen.arcDragEnd()
  })
})

describe('⌘-dragging an arc', () => {
  it('moves its centre by the pointer’s movement, one undo step, no extra point', () => {
    const { doc, pen, C, path } = mkArc()
    const ents = doc.value.entities.length
    pen.arcDragStart(path, 0, BOTTOM.x, BOTTOM.y, true)
    expect(pen.arcDragTransient()).toBeNull()
    pen.arcDragMove(BOTTOM.x + 0.5, BOTTOM.y + 0.5); pen.arcDragMove(BOTTOM.x + 1, BOTTOM.y + 1)
    pen.arcDragEnd()
    expect(P(doc.value, C).x).toBeCloseTo(8, 9); expect(P(doc.value, C).y).toBeCloseTo(10, 9)
    expect(doc.value.entities.length).toBe(ents)
    pen.undo()
    expect(P(doc.value, C)).toMatchObject({ x: 7, y: 9 })
  })
})
