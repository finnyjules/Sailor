// @vitest-environment happy-dom
//
// tests/unit/pen-bow-tangent.unit.spec.ts
// Pen stage 4, snapping while drawing: a bowing arc's circle snaps to touch a
// nearby line, circle or arc (and releasing writes the rule); the joint's own
// tangency wins; a typed radius skips it; a line leaving an arc's end along
// its direction snaps onto the tangent and writes the joint rule.
import { describe, it, expect } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import PenOverlay from '~/components/pen/PenOverlay.vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath } from '~/lib/sketch/edit'
import { usePen, snapArcTangent } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }   // SNAP_PX = 0.6 units here
function mk(build: (d: SketchDoc) => void) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  const pen = usePen({ doc, view: ref(DEV) })
  pen.selectTool('path')
  return { doc, pen }
}
const P = (d: SketchDoc, id: EntityId) => d.entities.find(e => e.id === id) as any
const lastPath = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path').pop() as any

// the Pen: click (6,5), then press (12,5) and bow through `pointer`
function bowFrom6to12(pen: ReturnType<typeof usePen>, pointer: { x: number; y: number }, release = true) {
  pen.pathDown(6, 5); pen.pathUp(6, 5)
  pen.pathDown(12, 5)
  pen.pathMove((12 + pointer.x) / 2, (5 + pointer.y) / 2)
  pen.pathMove(pointer.x, pointer.y)
  if (release) { pen.pathUp(pointer.x, pointer.y); pen.finishPath(false) }
}

describe('a bowing arc snaps tangent', () => {
  it('to a line: the preview locks the radius, and releasing writes tangentLineArc [A, B, C, S]', () => {
    let l1 = '', l2 = ''
    const { doc, pen } = mk(d => { l1 = addPoint(d, 2, 2); l2 = addPoint(d, 16, 2); addLine(d, l1, l2) })
    bowFrom6to12(pen, { x: 9, y: 2.1 }, false)
    const pv = pen.bowPreview({ x: 9, y: 2.1 })!
    expect(pv.touch).not.toBeNull()
    expect(pv.center.x).toBeCloseTo(9, 9); expect(pv.center.y).toBeCloseTo(5, 9)
    expect(pv.r).toBeCloseTo(3, 9)
    expect(pv.touch!.touch.y).toBeCloseTo(2, 9)
    expect(pen.sparkleCount()).toBeGreaterThan(0)   // engaging sparkles
    pen.pathUp(9, 2.1); pen.finishPath(false)
    const path = lastPath(doc.value)
    const C = path.segments[0].center
    const k = doc.value.constraints.find(c => c.kind === 'tangentLineArc')!
    expect(k.refs).toEqual([l1, l2, C, path.anchors[0]])
    expect(P(doc.value, C).y).toBeCloseTo(5, 4)
  })
  it('to a circle, from outside', () => {
    let k = ''
    const { doc, pen } = mk(d => { k = addCircle(d, addPoint(d, 9, -2), 2) })
    bowFrom6to12(pen, { x: 9, y: -0.148 })   // the free arc's centre ≈ (9, 3.3)
    const path = lastPath(doc.value)
    expect(doc.value.constraints.find(c => c.kind === 'tangentArcs')).toMatchObject({ refs: [path.segments[0].center, path.anchors[0], k], value: 1 })
  })
  it('to an arc segment, on its drawn part', () => {
    let c2 = '', a2 = ''
    const { doc, pen } = mk(d => {
      a2 = addPoint(d, 7, -2); c2 = addPoint(d, 9, -2)
      addPath(d, [a2, addPoint(d, 11, -2)], [{ kind: 'arc', center: c2, sweep: 0 }])
    })
    bowFrom6to12(pen, { x: 9, y: -0.148 })
    const path = lastPath(doc.value)
    expect(doc.value.constraints.find(c => c.kind === 'tangentArcs')).toMatchObject({ refs: [path.segments[0].center, path.anchors[0], c2, a2], value: 1 })
  })
  it('the joint’s own tangency wins over a nearby line', () => {
    const { doc, pen } = mk(d => { addLine(d, addPoint(d, 2, 8.2), addPoint(d, 16, 8.2)) })
    // a vertical line (6,0)→(6,5), then an arc to (12,5) that leaves it smoothly (centre (9,5), top at y=8)
    pen.pathDown(6, 0); pen.pathUp(6, 0)
    pen.pathDown(6, 5); pen.pathUp(6, 5)
    pen.pathDown(12, 5); pen.pathMove(10, 7); pen.pathMove(9, 8.05)
    const pv = pen.bowPreview({ x: 9, y: 8.05 })!
    expect(pv.snappedTangent).toBe(true)
    expect(pv.touch).toBeNull()
    pen.pathUp(9, 8.05); pen.finishPath(false)
    expect(doc.value.constraints.some(c => c.kind === 'tangentLineArc')).toBe(false)
  })
  it('a typed radius skips the snap', () => {
    const { doc, pen } = mk(d => { addLine(d, addPoint(d, 2, 2), addPoint(d, 16, 2)) })
    bowFrom6to12(pen, { x: 9, y: 2.1 }, false)
    pen.dimBuffer.value = '4'
    pen.commitDimension()
    pen.finishPath(false)
    expect(doc.value.constraints.some(c => c.kind === 'tangentLineArc')).toBe(false)
  })
  it('no snap when nothing is near', () => {
    const { doc, pen } = mk(d => { addLine(d, addPoint(d, 2, -6), addPoint(d, 16, -6)) })
    bowFrom6to12(pen, { x: 9, y: 2.1 }, false)
    expect(pen.bowPreview({ x: 9, y: 2.1 })!.touch).toBeNull()
    expect(pen.sparkleCount()).toBe(0)
    pen.pathUp(9, 2.1); pen.finishPath(false)
    expect(doc.value.constraints.some(c => c.kind === 'tangentLineArc')).toBe(false)
  })
})

describe('a line leaving an arc’s end', () => {
  it('snapArcTangent: forward only, within the tolerance', () => {
    const C = { x: 7, y: 9 }, E = { x: 10, y: 6 }   // ccw travel at E points up-right (1,1)/√2
    const on = snapArcTangent(C, E, 1, { x: 12.2, y: 8.05 }, (4 * Math.PI) / 180)
    expect(on.snapped).toBe(true)
    expect(on.pt.x - E.x).toBeCloseTo(on.pt.y - E.y, 9)
    expect(snapArcTangent(C, E, 1, { x: 8, y: 4 }, (4 * Math.PI) / 180).snapped).toBe(false)     // backwards
    expect(snapArcTangent(C, E, 1, { x: 12.5, y: 7 }, (4 * Math.PI) / 180).snapped).toBe(false)  // too far off
    expect(snapArcTangent(C, E, 0, { x: 12.2, y: 8.05 }, (4 * Math.PI) / 180).snapped).toBe(false) // cw arc travels the other way
  })
  it('the Pen snaps the next point onto the tangent and writes perpendicular [C, E, E, new]', () => {
    const { doc, pen } = mk(() => {})
    pen.nextSegment.value = 'arc'
    pen.place(4, 6); pen.place(10, 6)          // arc centred (7,9), travelling ccw into (10,6)
    pen.nextSegment.value = 'line'
    pen.pathMove(12.2, 8.05)
    expect(pen.placementPreview.value?.tangent).toBe(true)
    pen.pathDown(12.2, 8.05); pen.pathUp(12.2, 8.05)
    pen.finishPath(false)
    const path = lastPath(doc.value)
    const [, E, N] = path.anchors
    const C = path.segments[0].center
    expect(doc.value.constraints.find(c => c.kind === 'perpendicular')!.refs).toEqual([C, E, E, N])
    const c = P(doc.value, C), e = P(doc.value, E), n = P(doc.value, N)
    expect((e.x - c.x) * (n.x - e.x) + (e.y - c.y) * (n.y - e.y)).toBeCloseTo(0, 6)
  })
  it('bowing that press into an arc drops the line’s tangent rule', () => {
    const { doc, pen } = mk(() => {})
    pen.nextSegment.value = 'arc'
    pen.place(4, 6); pen.place(10, 6)
    pen.nextSegment.value = 'line'
    pen.pathMove(12.2, 8.05)
    pen.pathDown(12.2, 8.05); pen.pathMove(12.5, 6.5); pen.pathMove(12.8, 6)
    pen.pathUp(12.8, 6); pen.finishPath(false)
    const path = lastPath(doc.value)
    const E = path.anchors[1], C = path.segments[0].center
    expect(doc.value.constraints.some(c => c.kind === 'perpendicular' && c.refs[0] === C && c.refs[1] === E && c.refs[2] === E)).toBe(false)
  })
})

// fix round 1: the screen never promises a rule that isn't written
describe('no tangent promise without the rule', () => {
  it('while a radius is typed, the overlay drops the green ghost and the T chip', async () => {
    const { pen } = mk(d => { addLine(d, addPoint(d, 2, 2), addPoint(d, 16, 2)) })
    const w = mount(PenOverlay, { props: { pen, view: DEV, width: 800, height: 600, active: true } })
    try {
      bowFrom6to12(pen, { x: 9, y: 2.1 }, false)
      await nextTick()
      expect(w.find('[data-bow-ghost]').attributes('data-tangent')).toBeDefined()
      expect(w.find('[data-bow-tangent]').exists()).toBe(true)
      pen.dimBuffer.value = '4'
      await nextTick()
      expect(w.find('[data-bow-ghost]').exists()).toBe(true)
      expect(w.find('[data-bow-ghost]').attributes('data-tangent')).toBeUndefined()
      expect(w.find('[data-bow-tangent]').exists()).toBe(false)
      expect(pen.bowPreview({ x: 9, y: 2.1 }, { snap: false })!.touch).toBeNull()
    } finally { w.unmount() }
  })
  it('after an arc, with the next segment an arc, the point is not moved onto the tangent', () => {
    const { doc, pen } = mk(() => {})
    pen.nextSegment.value = 'arc'
    pen.place(4, 6); pen.place(10, 6)
    pen.pathMove(12.2, 8.05)
    expect(pen.placementPreview.value?.tangent).toBe(false)
    pen.place(12.2, 8.05)
    const pp = pen.pendingPath.value!
    const N = P(doc.value, pp.anchors[2]!)
    expect(N.x).toBeCloseTo(12.2, 9); expect(N.y).toBeCloseTo(8.05, 9)
    expect(doc.value.constraints.some(c => c.kind === 'perpendicular')).toBe(false)
  })
  it('a typed line length along the tangent keeps the tangent rule', () => {
    const { doc, pen } = mk(() => {})
    pen.nextSegment.value = 'arc'
    pen.place(4, 6); pen.place(10, 6)
    pen.nextSegment.value = 'line'
    pen.pathMove(12.2, 8.05)
    expect(pen.placementPreview.value?.tangent).toBe(true)
    pen.dimBuffer.value = '3'
    pen.commitDimension()
    pen.finishPath(false)
    const path = lastPath(doc.value)
    const [, E, N] = path.anchors
    const C = path.segments[0].center
    expect(doc.value.constraints.find(c => c.kind === 'perpendicular')!.refs).toEqual([C, E, E, N])
    const c = P(doc.value, C), e = P(doc.value, E), n = P(doc.value, N)
    expect(Math.hypot(n.x - e.x, n.y - e.y)).toBeCloseTo(3, 6)
    expect((e.x - c.x) * (n.x - e.x) + (e.y - c.y) * (n.y - e.y)).toBeCloseTo(0, 6)
  })
})
