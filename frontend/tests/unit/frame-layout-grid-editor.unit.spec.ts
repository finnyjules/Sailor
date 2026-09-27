// @vitest-environment happy-dom
// frontend/tests/unit/frame-layout-grid-editor.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'
import { createRectLayer } from '~/composables/useCompositorLayers'
import { patchLayoutGrid } from '~/lib/frame/layoutGrid'

function editor(properties: Record<string, any> = {}) {
  const node = reactive({ id: 'f', data: { properties } }) as any
  const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 1080, h: 1350 }), getRect: () => null })
  return { node, ed }
}

describe('layout grid in the editor', () => {
  it('ensureLayoutGrid writes the grid once, shown for an empty Frame', () => {
    const { node, ed } = editor()
    ed.ensureLayoutGrid()
    expect(node.data.properties.sailor_layoutGrid.show).toBe(true)
  })
  it('an old Frame with layers gets a hidden grid', () => {
    const { node, ed } = editor({ sailor_localLayers: [createRectLayer({})] })
    ed.ensureLayoutGrid()
    expect(node.data.properties.sailor_layoutGrid.show).toBe(false)
  })
  it('a grid change is one undo step', () => {
    const { node, ed } = editor()
    ed.ensureLayoutGrid()
    ed.setLayoutGrid(patchLayoutGrid(ed.layoutGrid.value, { columns: 6 }))
    expect(node.data.properties.sailor_layoutGrid.cols.count).toBe(6)
    ed.undo()
    expect(node.data.properties.sailor_layoutGrid.cols.count).toBe(12)
    ed.redo()
    expect(node.data.properties.sailor_layoutGrid.cols.count).toBe(6)
  })
  it('snap lines come from the resolved grid and vanish when the grid is hidden', () => {
    const { ed } = editor()
    ed.ensureLayoutGrid()
    const r = ed.layoutGridResolved.value
    expect(ed.gridSnapLines.value.xs).toContain(r.cols[0]!.a / 1080)
    ed.setLayoutGrid(patchLayoutGrid(ed.layoutGrid.value, { show: false }))
    expect(ed.gridSnapLines.value.xs).toEqual([])
  })
})

// A 540×675 on-screen artboard for a 1080×1350 design: 1 screen px = 2 design px.
function pointerEditor(properties: Record<string, any> = {}) {
  const node = reactive({ id: 'f', data: { properties } }) as any
  const rect = { left: 0, top: 0, width: 540, height: 675, right: 540, bottom: 675, x: 0, y: 0 } as DOMRect
  const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 540, h: 675 }), designDims: () => ({ w: 1080, h: 1350 }), getRect: () => rect })
  return { node, ed }
}
const pe = (type: string, x: number, y: number, o: Record<string, any> = {}) =>
  Object.assign(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, ...o }), { pointerId: 1 }) as unknown as PointerEvent

describe('the 4 px move threshold', () => {
  it('a click selects and records nothing; a drag records once it moves', () => {
    const layer = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 })
    const { ed } = pointerEditor({ sailor_localLayers: [layer] })
    ed.ensureLayoutGrid()
    const rev0 = ed.historyRev()
    ed.onCanvasPointerDown(pe('pointerdown', 270, 337), layer.id)
    window.dispatchEvent(pe('pointermove', 272, 338))           // 2.2 px: still a click
    expect(ed.historyRev()).toBe(rev0)
    expect(ed.dragMoving.value).toBe(false)
    expect(ed.localLayers.value[0]!.x).toBe(0.5)
    window.dispatchEvent(pe('pointermove', 290, 337))           // past the slop
    expect(ed.dragMoving.value).toBe(true)
    window.dispatchEvent(pe('pointermove', 300, 337))
    expect(ed.historyRev()).toBe(rev0 + 1)                       // one step for the whole drag
    window.dispatchEvent(pe('pointerup', 300, 337))
    expect(ed.dragMoving.value).toBe(false)
    expect(ed.canUndo.value).toBe(true)
  })
})

describe('grid lines at the design size', () => {
  it('snap lines are fractions of the design size, not the display size', () => {
    const { ed } = pointerEditor()
    ed.ensureLayoutGrid()
    const r = ed.layoutGridResolved.value
    expect(r.W).toBe(1080)
    expect(ed.gridSnapLines.value.xs).toContain(r.cols[0]!.a / 1080)
  })
})

describe('resize snapping', () => {
  it('an edge dragged near a column edge lands on it; ⌥ turns it off', () => {
    const layer = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 })
    const { ed } = pointerEditor({ sailor_localLayers: [layer] })
    ed.ensureLayoutGrid()                                            // a Frame with layers: hidden…
    ed.setLayoutGrid({ ...ed.layoutGrid.value, show: true }, false)  // …a hidden grid never pulls
    ed.selectLocal(layer.id)
    const target = ed.layoutGridResolved.value.cols[8]!.a / 1080     // a column edge right of the box
    const sx = 0.6 * 540, sy = 0.5 * 675                              // the right edge, on screen
    const nearX = target * 540 + 2                                    // 2 screen px off the line
    ed.startResize('r', pe('pointerdown', sx, sy))
    window.dispatchEvent(pe('pointermove', nearX, sy))
    window.dispatchEvent(pe('pointerup', nearX, sy))
    const l = ed.localLayers.value[0] as any
    expect(l.x + l.w / 2).toBeCloseTo(target, 6)

    ed.startResize('r', pe('pointerdown', target * 540, sy))
    window.dispatchEvent(pe('pointermove', nearX, sy, { altKey: true }))
    window.dispatchEvent(pe('pointerup', nearX, sy))
    const l2 = ed.localLayers.value[0] as any
    expect(l2.x + l2.w / 2).toBeCloseTo(nearX / 540, 6)
  })
})
