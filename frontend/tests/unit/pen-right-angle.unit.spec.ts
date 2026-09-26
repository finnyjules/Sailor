// tests/unit/pen-right-angle.unit.spec.ts
// The path tool's right-angle snap (drawing cues): near-square placements land
// exactly perpendicular to the last line segment and capture the rule.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { usePen, snapPerpendicular, PERP_SNAP_RAD } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const pen = usePen({ doc, view: ref(DEV) })
  pen.selectTool('path')
  return { doc, pen }
}
const perps = (d: SketchDoc) => d.constraints.filter(c => c.kind === 'perpendicular')
const lastAnchor = (d: SketchDoc, pen: ReturnType<typeof mk>['pen']) => {
  const pp = pen.pendingPath.value!
  return d.entities.find(e => e.id === pp.anchors[pp.anchors.length - 1]) as any
}

describe('snapPerpendicular', () => {
  it('projects a near-square pointer onto the perpendicular through prev', () => {
    const r = snapPerpendicular({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4.1, y: 3 }, PERP_SNAP_RAD)
    expect(r.snapped).toBe(true)
    expect(r.pt.x).toBeCloseTo(4, 12)
    expect(r.pt.y).toBeCloseTo(3, 12)
  })
  it('keeps the side the pointer is on', () => {
    const r = snapPerpendicular({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 3.9, y: -2 }, PERP_SNAP_RAD)
    expect(r.snapped).toBe(true)
    expect(r.pt.x).toBeCloseTo(4, 12)
    expect(r.pt.y).toBeCloseTo(-2, 12)
  })
  it('works for a diagonal segment', () => {
    const r = snapPerpendicular({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.02, y: 2 }, PERP_SNAP_RAD)
    expect(r.snapped).toBe(true)
    const dot = (1 - 0) * (r.pt.x - 1) + (1 - 0) * (r.pt.y - 1)
    expect(Math.abs(dot)).toBeLessThan(1e-12)
  })
  it('leaves a pointer more than the tolerance off square alone', () => {
    const pt = { x: 5, y: 3 }   // ~18° off
    const r = snapPerpendicular({ x: 0, y: 0 }, { x: 4, y: 0 }, pt, PERP_SNAP_RAD)
    expect(r.snapped).toBe(false)
    expect(r.pt).toBe(pt)
  })
  it('is inclusive just inside 4° and exclusive just outside', () => {
    const at = (deg: number) => {
      const a = Math.PI / 2 - (deg * Math.PI) / 180
      return snapPerpendicular({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1 + Math.cos(a), y: Math.sin(a) }, PERP_SNAP_RAD).snapped
    }
    expect(at(3.9)).toBe(true)
    expect(at(4.1)).toBe(false)
  })
  it('degenerate inputs do not snap', () => {
    expect(snapPerpendicular({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 3 }, PERP_SNAP_RAD).snapped).toBe(false)
    expect(snapPerpendicular({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, PERP_SNAP_RAD).snapped).toBe(false)
  })
})

describe('path tool right-angle snap', () => {
  it('pathDown near square places exactly perpendicular and adds one perpendicular rule', () => {
    const { doc, pen } = mk()
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0); pen.pathUp(4, 0)
    const before = pen.canUndo()
    pen.pathDown(4.1, 3); pen.pathUp(4.1, 3)
    const p = lastAnchor(doc.value, pen)
    expect(p.x).toBeCloseTo(4, 9)
    expect(p.y).toBeCloseTo(3, 9)
    const pc = perps(doc.value)
    expect(pc).toHaveLength(1)
    const pp = pen.pendingPath.value!
    expect(pc[0]!.refs).toEqual([pp.anchors[0], pp.anchors[1], pp.anchors[1], pp.anchors[2]])
    expect(pen.sparkleCount()).toBeGreaterThan(0)
    expect(before).toBe(true)
    // placement and rule are one history step
    pen.undo()
    expect(perps(doc.value)).toHaveLength(0)
    expect(pen.pendingPath.value).toBeNull()
  })
  it('does not snap or add the rule with Shift held', () => {
    const { doc, pen } = mk()
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0); pen.pathUp(4, 0)
    pen.pathDown(4.1, 3, true); pen.pathUp(4.1, 3)
    expect(perps(doc.value)).toHaveLength(0)
  })
  it('does not snap far from 90°', () => {
    const { doc, pen } = mk()
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0); pen.pathUp(4, 0)
    pen.pathDown(5, 3); pen.pathUp(5, 3)
    const p = lastAnchor(doc.value, pen)
    expect(p.x).toBeCloseTo(5, 9)
    expect(perps(doc.value)).toHaveLength(0)
  })
  it('does not snap when the previous segment is an arc', () => {
    const { doc, pen } = mk()
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0); pen.pathMove(2, 1); pen.pathUp(2, 1)   // bowed into an arc
    expect(pen.pendingPath.value!.segments[0]!.kind).toBe('arc')
    pen.pathDown(4.1, 3); pen.pathUp(4.1, 3)
    const p = lastAnchor(doc.value, pen)
    expect(p.x).toBeCloseTo(4.1, 9)
    expect(perps(doc.value)).toHaveLength(0)
  })
  it('drops the rule again if the new segment is bowed into an arc', () => {
    const { doc, pen } = mk()
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0); pen.pathUp(4, 0)
    pen.pathDown(4.1, 3); pen.pathMove(5, 1.5); pen.pathUp(5, 1.5)
    expect(pen.pendingPath.value!.segments[1]!.kind).toBe('arc')
    expect(perps(doc.value)).toHaveLength(0)
  })
  it('a plain click (place → pathClick) snaps and captures the rule too', () => {
    const { doc, pen } = mk()
    pen.place(0, 0)
    pen.place(4, 0)
    pen.place(4.1, 3)
    const p = lastAnchor(doc.value, pen)
    expect(p.x).toBeCloseTo(4, 9)
    expect(perps(doc.value)).toHaveLength(1)
  })
  it('a snap onto existing geometry wins over the right angle — no rule', () => {
    const { doc, pen } = mk()
    pen.selectTool('point')
    pen.place(4.3, 3)        // an existing point near the square spot
    pen.selectTool('path')
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0); pen.pathUp(4, 0)
    pen.pathDown(4.1, 3); pen.pathUp(4.1, 3)
    const p = lastAnchor(doc.value, pen)
    expect(p.x).toBeCloseTo(4.3, 9)
    expect(perps(doc.value)).toHaveLength(0)
  })
  it('placementPreview reports the snapped spot while hovering', () => {
    const { pen } = mk()
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0); pen.pathUp(4, 0)
    pen.pathMove(4.1, 3)
    const pv = pen.placementPreview.value!
    expect(pv.perpendicular).toBe(true)
    expect(pv.x).toBeCloseTo(4, 9)
    pen.pathMove(5, 3)
    expect(pen.placementPreview.value!.perpendicular).toBe(false)
  })
  it('hoverSnap reads the snap target without touching the doc', () => {
    const { doc, pen } = mk()
    pen.selectTool('point')
    pen.place(2, 2)
    pen.selectTool('line')
    const n = doc.value.entities.length
    pen.cursor.value = { x: 2.2, y: 2.1, shift: false }
    expect(pen.hoverSnap.value).toEqual({ x: 2, y: 2 })
    pen.cursor.value = { x: 6, y: 6, shift: false }
    expect(pen.hoverSnap.value).toBeNull()
    expect(doc.value.entities.length).toBe(n)
  })
})
