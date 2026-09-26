// tests/unit/pen-snap.unit.spec.ts
// The pen places points onto path arcs, path line segments and midpoints with
// the rule each implies, and hoverSnap says which kind of join it previews.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addPath } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }   // snap radius 0.6 units
function mk(build: (d: SketchDoc) => void) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  const pen = usePen({ doc, view: ref(DEV) })
  return { doc, pen }
}
const lastPoint = (d: SketchDoc) => [...d.entities].reverse().find(e => e.kind === 'point') as any

describe('pen placement onto arcs, segments and midpoints', () => {
  it('a Point placed on a path arc carries equalDist [C,p,C,A]', () => {
    let A = '', C = ''
    const { doc, pen } = mk(d => {
      A = addPoint(d, 0, 0); const B = addPoint(d, 10, 0); C = addPoint(d, 5, 0)
      addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }, { kind: 'arc', center: C, sweep: 1 }], true)
    })
    pen.selectTool('point')
    pen.place(5, -5.3)
    const p = lastPoint(doc.value)
    expect(p.y).toBeCloseTo(-5, 5)
    const rule = doc.value.constraints.find(c => c.kind === 'equalDist' && c.refs[1] === p.id)
    expect(rule?.refs).toEqual([C, p.id, C, A])
  })

  it('a Path anchor on a path line segment carries collinear [A,B,p]', () => {
    let A = '', B = ''
    const { doc, pen } = mk(d => {
      A = addPoint(d, 0, 0); B = addPoint(d, 10, 0)
      addPath(d, [A, B], [{ kind: 'line' }])
    })
    pen.selectTool('path')
    pen.pathDown(3, 0.3); pen.pathUp(3, 0.3)
    const id = pen.pendingPath.value!.anchors[0]!
    const rule = doc.value.constraints.find(c => c.kind === 'collinear')
    expect(rule?.refs).toEqual([A, B, id])
  })

  it('a Line start at the middle of a line carries midpoint [p,A,B]', () => {
    let a = '', b = ''
    const { doc, pen } = mk(d => { a = addPoint(d, 0, 0); b = addPoint(d, 10, 0); addLine(d, a, b) })
    pen.selectTool('line')
    pen.place(5.2, 0.2)
    const p = lastPoint(doc.value)
    expect(p).toMatchObject({ x: 5, y: 0 })
    expect(doc.value.constraints.find(c => c.kind === 'midpoint')?.refs).toEqual([p.id, a, b])
    expect(doc.value.constraints.some(c => c.kind === 'pointOnLine')).toBe(false)
  })

  it('beyond a line\'s end there is no snap and no rule', () => {
    const { doc, pen } = mk(d => { const a = addPoint(d, 0, 0); const b = addPoint(d, 10, 0); addLine(d, a, b) })
    pen.selectTool('point')
    pen.place(14, 0.2)
    expect(lastPoint(doc.value)).toMatchObject({ x: 14, y: 0.2 })
    expect(doc.value.constraints).toHaveLength(0)
  })

  it('hoverSnap reports point / midpoint / curve', () => {
    const { pen } = mk(d => { const a = addPoint(d, 0, 0); const b = addPoint(d, 10, 0); addLine(d, a, b) })
    pen.selectTool('point')
    pen.cursor.value = { x: 0.2, y: 0.1, shift: false }
    expect(pen.hoverSnap.value).toEqual({ x: 0, y: 0, kind: 'point' })
    pen.cursor.value = { x: 5.1, y: 0.2, shift: false }
    expect(pen.hoverSnap.value).toEqual({ x: 5, y: 0, kind: 'midpoint' })
    pen.cursor.value = { x: 2, y: 0.2, shift: false }
    expect(pen.hoverSnap.value).toMatchObject({ x: 2, kind: 'curve' })
    pen.cursor.value = { x: 14, y: 0.2, shift: false }
    expect(pen.hoverSnap.value).toBeNull()
  })
})

describe('hoverSnap only for the placing tools', () => {
  it('Trim, Cut and Dissolve never preview a snap', () => {
    const { pen } = mk(d => { const a = addPoint(d, 0, 0); const b = addPoint(d, 10, 0); addLine(d, a, b) })
    for (const t of ['trim', 'cut', 'dissolve'] as const) {
      pen.selectTool(t)
      pen.cursor.value = { x: 5.1, y: 0.2, shift: false }
      expect(pen.hoverSnap.value).toBeNull()
    }
  })
})
