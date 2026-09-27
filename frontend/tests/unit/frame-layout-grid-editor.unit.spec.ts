// @vitest-environment happy-dom
// frontend/tests/unit/frame-layout-grid-editor.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'
import { createRectLayer, createTextLayer } from '~/composables/useCompositorLayers'
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

// Final-review fixes: the box EDGE snaps (not the pointer), valign text snaps its DRAWN box,
// and the move-snap threshold is in screen px.
function zoomedEditor(properties: Record<string, any>, screenScale = 1) {
  const node = reactive({ id: 'f', data: { properties } }) as any
  const sw = 540 * screenScale, sh = 675 * screenScale
  const rect = { left: 0, top: 0, width: sw, height: sh, right: sw, bottom: sh, x: 0, y: 0 } as DOMRect
  const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 540, h: 675 }), designDims: () => ({ w: 1080, h: 1350 }), getRect: () => rect })
  ed.ensureLayoutGrid()
  ed.setLayoutGrid({ ...patchLayoutGrid(ed.layoutGrid.value, { rows: 'off' }), show: true }, false)
  return { node, ed }
}

describe('resize snapping moves the box edge onto the line', () => {
  it('pressing 3 px off the handle centre still lands the edge exactly on the line', () => {
    const layer = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 })
    const { ed } = zoomedEditor({ sailor_localLayers: [layer] })
    ed.selectLocal(layer.id)
    const target = ed.layoutGridResolved.value.cols[8]!.a / 1080
    const edge0 = 0.6 * 540, sy = 0.5 * 675
    ed.startResize('r', pe('pointerdown', edge0 + 3, sy))           // 3 px right of the handle centre
    const px = target * 540 + 2 + 3                                  // the EDGE would be 2 px off the line
    window.dispatchEvent(pe('pointermove', px, sy))
    expect(ed.snapGuides.value.vx).toBeCloseTo(target, 9)
    window.dispatchEvent(pe('pointerup', px, sy))
    const l = ed.localLayers.value[0] as any
    expect(l.x + l.w / 2).toBeCloseTo(target, 9)
  })
  it('dragging is true for the whole gesture (the modal ignores the grid toggle meanwhile)', () => {
    const layer = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 })
    const { ed } = zoomedEditor({ sailor_localLayers: [layer] })
    ed.selectLocal(layer.id)
    expect(ed.dragging.value).toBe(false)
    ed.startResize('r', pe('pointerdown', 0.6 * 540, 0.5 * 675))
    expect(ed.dragging.value).toBe(true)
    window.dispatchEvent(pe('pointerup', 0.6 * 540, 0.5 * 675))
    expect(ed.dragging.value).toBe(false)
  })
  it('a side handle never snaps or shows a guide on the axis it does not move', () => {
    const layer = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 })
    const { ed } = zoomedEditor({ sailor_localLayers: [layer] })
    ed.selectLocal(layer.id)
    const ys = ed.gridSnapLines.value.ys
    expect(ys).toContain(0.5)
    const sx = 0.6 * 540
    ed.startResize('r', pe('pointerdown', sx, 0.5 * 675 + 20))
    window.dispatchEvent(pe('pointermove', sx + 30, 0.5 * 675 + 1))  // pointer 1 px off the middle line
    expect(ed.snapGuides.value.hy).toBeNull()
    window.dispatchEvent(pe('pointerup', sx + 30, 0.5 * 675 + 1))
  })
  it('a corner handle snaps both of its edges', () => {
    const layer = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 })
    const { ed } = zoomedEditor({ sailor_localLayers: [layer] })
    ed.selectLocal(layer.id)
    const tx = ed.layoutGridResolved.value.cols[8]!.a / 1080
    const bottom0 = (0.5 * 675 + 0.1 * 540)                          // box h = 0.2·W = 108 px
    ed.startResize('br', pe('pointerdown', 0.6 * 540 - 2, bottom0 + 2))
    // the right edge 3 px off tx; the bottom edge 3 px off the bottom margin line
    const ty = ed.layoutGridResolved.value.bottom / 1350
    const mx = tx * 540 + 3 - 2, my = ty * 675 - 3 + 2
    window.dispatchEvent(pe('pointermove', mx, my))
    window.dispatchEvent(pe('pointerup', mx, my))
    const l = ed.localLayers.value[0] as any
    expect(l.x + l.w / 2).toBeCloseTo(tx, 9)
    expect(l.y * 675 + (l.h * 540) / 2).toBeCloseTo(ty * 675, 6)
  })
})

describe('valign top text snaps its DRAWN box', () => {
  const H = 675
  const topText = (y: number) => createTextLayer({ x: 0.5, y, boxW: 0.3, boxH: 0.1, valign: 'top' } as any)
  it('move-snap lands the drawn bottom edge on the line', () => {
    // box 54 px tall, stored y = the drawn top. Drawn bottom starts 40 px above H/2.
    const layer = topText((H / 2 - 40 - 54) / H)
    const { ed } = zoomedEditor({ sailor_localLayers: [layer] })
    ed.onCanvasPointerDown(pe('pointerdown', 270, 200), layer.id)
    window.dispatchEvent(pe('pointermove', 270, 238))                // drawn bottom now 2 px above H/2
    window.dispatchEvent(pe('pointerup', 270, 238))
    const l = ed.localLayers.value[0] as any
    expect(l.y * H + 54).toBeCloseTo(H / 2, 6)
  })
  it('re-snap lands the drawn bottom edge on the nearest line', () => {
    const layer = topText((H / 2 - 3 - 54) / H)                        // drawn bottom 3 px above H/2
    const { ed } = zoomedEditor({ sailor_localLayers: [layer] })
    ed.selectLocal(layer.id)
    ed.resnapSelected()
    const l = ed.localLayers.value[0] as any
    expect(l.y * H + 54).toBeCloseTo(H / 2, 6)
  })
})

describe('move-snap threshold is in screen px', () => {
  it('zoomed out to half, a box 4 screen px off a line snaps', () => {
    const probe = zoomedEditor({}, 0.5).ed
    const xs = probe.gridSnapLines.value.xs, S = 270                 // on-screen artboard width
    const c7 = probe.layoutGridResolved.value.cols[7]!
    const target = (c7.a + c7.w) / 1080                               // a column's RIGHT edge, approached from inside the column
    // A width whose left edge and centre stay ≥ 5 screen px from every line (and the canvas
    // centre/edges), so only the right edge — 4 screen px off `target` — can snap.
    const far = (v: number) => [...xs, 0, 0.5, 1].every(t => Math.abs(v - t) * S >= 5)
    let w = 0.1
    while (w < 0.4 && !(far(target - 4 / S - w) && far(target - 4 / S - w / 2))) w += 0.002
    expect(w).toBeLessThan(0.4)
    const layer = createRectLayer({ x: 0.2, y: 0.5, w, h: 0.05 })
    const { ed } = zoomedEditor({ sailor_localLayers: [layer] }, 0.5)
    const dxNorm = (target - 4 / S - w / 2) - 0.2                     // centre so the right edge is 4 px off
    const sx = 0.2 * S, sy = 0.5 * 337.5
    ed.onCanvasPointerDown(pe('pointerdown', sx, sy), layer.id)
    window.dispatchEvent(pe('pointermove', sx + dxNorm * S, sy))
    window.dispatchEvent(pe('pointerup', sx + dxNorm * S, sy))
    const l = ed.localLayers.value[0] as any
    expect(l.x + l.w / 2).toBeCloseTo(target, 9)
  })
})
