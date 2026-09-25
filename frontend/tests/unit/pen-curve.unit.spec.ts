// tests/unit/pen-curve.unit.spec.ts
// The Curve (Bézier) tool beside the arc Pen, in one path (shared-pen Task 6).
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { usePen } from '~/composables/pen/usePen'
import { availableConstraints } from '~/composables/pen/penRules'
import { addPoint, addLine, addCircle, addPath } from '~/lib/sketch/edit'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const pen = usePen({ doc, view: ref(DEV) })
  return { doc, pen }
}
const path = (d: SketchDoc) => d.entities.find(e => e.kind === 'path') as any

describe('curve tool', () => {
  it('click-drag places smooth points joined by cubic segments', () => {
    const { doc, pen } = mk()
    pen.selectTool('curve')
    pen.curveDown(0, 0); pen.curveMove(1, 1); pen.curveUp(1, 1)
    pen.curveDown(4, 0); pen.curveMove(5, -1); pen.curveUp(5, -1)
    pen.finishPath(false)
    const p = path(doc.value)
    expect(p.segments).toHaveLength(1)
    expect(p.segments[0].kind).toBe('cubic')
    expect(p.segments[0].h1).toBeTruthy()
    expect(p.segments[0].h2).toBeTruthy()
  })
  it('a plain click after a smooth point does not inherit its out-handle', () => {
    const { doc, pen } = mk()
    pen.selectTool('curve')
    pen.curveDown(0, 0); pen.curveMove(1, 1); pen.curveUp(1, 1)   // smooth
    pen.curveDown(4, 0); pen.curveUp(4, 0)                         // sharp
    pen.curveDown(8, 0); pen.curveUp(8, 0)                         // sharp
    pen.finishPath(false)
    const p = path(doc.value)
    expect(p.segments[1].h1).toBeNull()
  })
  it('switching between arcs and curves keeps one path', () => {
    const { doc, pen } = mk()
    pen.selectTool('path')
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0); pen.pathUp(4, 0)                           // line segment
    pen.selectTool('curve')
    pen.curveDown(8, 0); pen.curveMove(9, 1); pen.curveUp(9, 1)    // cubic segment
    pen.finishPath(false)
    const paths = doc.value.entities.filter(e => e.kind === 'path') as any[]
    expect(paths).toHaveLength(1)
    expect(paths[0].segments.map((s: any) => s.kind)).toEqual(['line', 'cubic'])
  })
  it('deleting a handle turns the point sharp and keeps the path', () => {
    const { doc, pen } = mk()
    pen.selectTool('curve')
    pen.curveDown(0, 0); pen.curveUp(0, 0)
    pen.curveDown(4, 0); pen.curveMove(5, 1); pen.curveUp(5, 1)
    pen.curveDown(8, 0); pen.curveUp(8, 0)
    pen.finishPath(false)
    const p = path(doc.value)
    const h = p.segments[0].h2
    pen.selectTool('select'); pen.pick(h); pen.del()
    const after = path(doc.value)
    expect(after).toBeTruthy()
    expect(after.segments[0].h2).toBeNull()
  })

  // --- beyond the brief: the edges the port has to get right ---
  it('clicking the first point closes with a cubic that honours its in-handle', () => {
    const { doc, pen } = mk()
    pen.selectTool('curve')
    pen.curveDown(0, 0); pen.curveMove(1, 1); pen.curveUp(1, 1)     // smooth first point
    pen.curveDown(4, 0); pen.curveUp(4, 0)
    pen.curveDown(2, 4); pen.curveUp(2, 4)
    pen.curveDown(0, 0)                                              // back on the first point
    const p = path(doc.value)
    expect(p.closed).toBe(true)
    expect(p.segments).toHaveLength(3)
    const closing = p.segments[2]
    expect(closing.kind).toBe('cubic')
    expect(closing.h2).toBeTruthy()                                  // firstHIn wired in
    expect(closing.h1).toBeNull()                                    // last point was sharp
  })
  it('one down→drag→up is one undo step, and handles are never snap targets', () => {
    const { doc, pen } = mk()
    pen.selectTool('curve')
    pen.curveDown(0, 0); pen.curveMove(2, 0); pen.curveUp(2, 0)      // hOut at (2,0)
    const before = doc.value.entities.length
    pen.curveDown(2.1, 0.1); pen.curveUp(2.1, 0.1)                   // right beside the handle
    expect(doc.value.entities.length).toBe(before + 1)               // a new anchor, not the handle
    expect(pen.pendingPath.value!.anchors).toHaveLength(2)
    pen.undo()
    expect(doc.value.entities.length).toBe(before)
  })
  it('an arc segment after a smooth point drops the unused out-handle', () => {
    const { doc, pen } = mk()
    pen.selectTool('curve')
    pen.curveDown(0, 0); pen.curveMove(1, 1); pen.curveUp(1, 1)      // smooth: hOut + hIn
    pen.selectTool('path')
    pen.pathDown(4, 0); pen.pathUp(4, 0)
    pen.finishPath(false)
    // only the two anchors remain: hOut dropped with the line, hIn with the open finish
    expect(doc.value.entities.filter(e => e.kind === 'point')).toHaveLength(2)
    expect(doc.value.constraints.filter(c => c.kind === 'collinear')).toHaveLength(0)
  })
  it('finishing a lone smooth point drops its handles as an undoable step — no ghosts on undo/redo', () => {
    const { doc, pen } = mk()
    pen.selectTool('curve')
    pen.curveDown(0, 0); pen.curveMove(1, 1); pen.curveUp(1, 1)      // anchor + 2 handles
    expect(doc.value.entities).toHaveLength(3)
    pen.finishPath(false)                                            // fewer than 2 points
    expect(doc.value.entities).toHaveLength(1)
    expect(doc.value.constraints).toHaveLength(0)
    pen.undo()                                                       // back to anchor + handles
    expect(doc.value.entities).toHaveLength(3)
    pen.redo()
    expect(doc.value.entities).toHaveLength(1)                       // the drop itself redoes
    expect(pen.canRedo()).toBe(false)
  })
  it('switching to another tool still ends the pending path', () => {
    const { doc, pen } = mk()
    pen.selectTool('curve')
    pen.curveDown(0, 0); pen.curveMove(1, 1); pen.curveUp(1, 1)
    pen.selectTool('line')
    expect(pen.pendingPath.value).toBeNull()
    expect(doc.value.entities).toHaveLength(0)                        // anchor + handles cleaned up
  })
})

describe('rules on curves', () => {
  it('a selected cubic segment hides the exact-geometry rules', () => {
    const doc: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(doc, 0, 0), b = addPoint(doc, 4, 0)
    const line = addLine(doc, a, b)
    const c = addPoint(doc, 2, 3)
    const circle = addCircle(doc, c, 1)
    const p0 = addPoint(doc, 0, 5), p1 = addPoint(doc, 4, 5)
    const curve = addPath(doc, [p0, p1], [{ kind: 'cubic', h1: null, h2: null }], false)
    const kinds = (segs: { pathId: string; segIndex: number }[]) => availableConstraints(doc, [line, circle], segs).map(r => r.kind)
    expect(kinds([])).toContain('tangentLineCircle')
    expect(kinds([{ pathId: curve, segIndex: 0 }])).not.toContain('tangentLineCircle')
  })
})
