// tests/unit/shape-pen-fills.unit.spec.ts
// Pen stage 7, Shape Studio: a Drawn shape with a filled area is that area,
// fitted by the whole drawing; a filled open drawing stays painted as a fill.
import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { addPoint, addLine } from '~/lib/sketch/edit'
import { mergeLayer, type GeoStudioDoc } from '~/lib/geoshape/studio'
import { drawnPath, sketchOutlineBounds } from '~/lib/geoshape/shapes'
import { useShapePenSession, hasClosedOutline, SHAPE_PEN_TOOLS } from '~/composables/geoshape/useShapePenSession'
import { toggleFillAt, fillPathData } from '~/lib/sketch/fills'
import type { SketchDoc } from '~/lib/sketch/model'

function crossing(d: SketchDoc) {
  addLine(d, addPoint(d, -12, 0), addPoint(d, 12, 0))
  addLine(d, addPoint(d, -10, -4), addPoint(d, 2, 14))
  addLine(d, addPoint(d, 10, -4), addPoint(d, -2, 14))
}
describe('Shape Studio: fills', () => {
  it('a Drawn shape with a filled area is that area, fitted by the whole drawing', () => {
    expect(SHAPE_PEN_TOOLS).toContain('fill')
    const d: SketchDoc = { entities: [], constraints: [] }
    crossing(d)
    const before = drawnPath(d, 100)
    expect(hasClosedOutline(d)).toBe(false)
    toggleFillAt(d, { x: 0, y: 3 }, 0)
    expect(hasClosedOutline(d)).toBe(true)
    const after = drawnPath(d, 100)
    expect(after).not.toBe(before)
    expect((after.match(/L/g) ?? []).length).toBe(3)      // the triangle, no spurs
    expect(after.trim().endsWith('Z')).toBe(true)
    // fitted by the whole drawing's box: the drawing is 24 wide → k = 100/24; the triangle's
    // apex (0, 4-ish) stays where the outline put it
    const ob = sketchOutlineBounds(d)!
    expect(ob.maxX - ob.minX).toBeCloseTo(24, 9)
  })
  it('commit keeps a filled open drawing painted as a fill', () => {
    const doc = reactive({ layers: [mergeLayer({})] }) as unknown as GeoStudioDoc
    const s = useShapePenSession({ doc: () => doc, layerIndex: () => 0, frameFor: () => ({ cx: 0, cy: 0, scale: 1, cssW: 600, cssH: 600 }) })
    s.open()
    const pen = s.session.value!.pen
    crossing(s.session.value!.doc.value)
    pen.commitHistory()
    pen.selectTool('fill'); pen.fillClick(0, 3)
    s.commitSession()
    const m = doc.layers[0]!.mark
    expect(m.sketch!.fills).toHaveLength(1)
    expect(m.paintTarget).toBe('fill')
    expect(fillPathData(m.sketch!)).not.toBe('')
  })
})
