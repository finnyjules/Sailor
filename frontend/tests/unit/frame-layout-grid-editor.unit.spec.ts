// @vitest-environment happy-dom
// frontend/tests/unit/frame-layout-grid-editor.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { reactive, watch } from 'vue'
import { useLocalLayerEditor, canSpanColumns, canSpanRows, spanReasons } from '~/composables/useLocalLayerEditor'
import { createRectLayer, createTextLayer, textVAlignCenterOffset } from '~/composables/useCompositorLayers'
import { patchLayoutGrid } from '~/lib/frame/layoutGrid'
import { textMetrics, bumpTextMetricsGeneration } from '~/lib/frame/textMetrics'

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

// Stage 2: text snaps by what is drawn — capitals, last baseline, else the baseline grid — and a
// box with nothing in reach rounds its top to the baseline grid.
function rowsEditor(properties: Record<string, any>) {
  const node = reactive({ id: 'f', data: { properties } }) as any
  const rect = { left: 0, top: 0, width: 540, height: 675, right: 540, bottom: 675, x: 0, y: 0 } as DOMRect
  const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 540, h: 675 }), designDims: () => ({ w: 1080, h: 1350 }), getRect: () => rect })
  ed.ensureLayoutGrid()
  ed.setLayoutGrid({ ...patchLayoutGrid(ed.layoutGrid.value, { rows: 'square' }), show: true }, false)
  return { node, ed }
}
const HD = 1350, WD = 1080
/** Capitals / baselines (design px) of a text layer stored at y — the editor's own reading. */
const marksAt = (l: any, y: number) => {
  const m = textMetrics(l, WD)!
  const top = y * HD + textVAlignCenterOffset(l, m.boxH) - m.boxH / 2
  return { capTop: top + m.capTop, baselines: m.baselines.map(b => top + b) }
}
/** The stored y that puts the capitals at `cap` (design px). */
const yForCap = (l: any, cap: number) => { const m = textMetrics(l, WD)!; return (cap - textVAlignCenterOffset(l, m.boxH) + m.boxH / 2 - m.capTop) / HD }
const onUnit = (v: number, unit: number) => Math.abs(v / unit - Math.round(v / unit)) < 1e-6
const drag = (ed: any, id: string, dyScreen: number, o: Record<string, any> = {}) => {
  ed.onCanvasPointerDown(pe('pointerdown', 270, 300), id)
  window.dispatchEvent(pe('pointermove', 270, 300 + Math.sign(dyScreen) * 5, o))   // past the slop
  window.dispatchEvent(pe('pointermove', 270, 300 + dyScreen, o))
  window.dispatchEvent(pe('pointerup', 270, 300 + dyScreen, o))
}

describe('text snaps by its capitals and baselines', () => {
  it('capitals dropped 2 screen px short of a row top land on it', () => {
    const base = createTextLayer({ text: 'Grid', fontSize: 0.04, boxW: 0.4, valign: 'top', x: 0.5 } as any)
    const probe = rowsEditor({}).ed.layoutGridResolved.value
    const target = probe.rows[3]!.a
    const layer = { ...base, y: yForCap(base, target - 40) }
    const cap2base = marksAt(layer, layer.y).baselines[0]! - marksAt(layer, layer.y).capTop
    const bottoms = [...probe.rows.map(r => r.a + r.w), probe.bottom]
    expect(bottoms.every(b => Math.abs(target + cap2base - b) > 16)).toBe(true)   // the baseline can't compete
    const { ed } = rowsEditor({ sailor_localLayers: [layer] })
    drag(ed, layer.id, 18)                                           // 36 design px: capitals 4 px short
    const l = ed.localLayers.value[0] as any
    expect(marksAt(l, l.y).capTop).toBeCloseTo(target, 6)
    expect(ed.snapGuides.value.hy).toBeNull()                        // guides clear on pointer up
  })
  it('the last baseline dropped near a row bottom lands on it', () => {
    const base = createTextLayer({ text: 'One\nTwo', fontSize: 0.04, boxW: 0.4, valign: 'top', x: 0.5 } as any)
    const g = rowsEditor({}).ed.layoutGridResolved.value
    const m0 = marksAt({ ...base, y: 0 }, 0)
    const span = m0.baselines[m0.baselines.length - 1]! - m0.capTop
    const tops = [...g.rows.map(r => r.a), g.top]
    // > 8, not the reach: a two-line span sits ~10 px above its own row top; after the drop the capitals
    // are ~14 px off it (out of reach) while the baseline is 4 px off, so the baseline wins.
    const k = g.rows.findIndex((r, i) => i > 1 && tops.every(t => Math.abs(r.a + r.w - span - t) > 8))
    expect(k).toBeGreaterThan(1)
    const bottom = g.rows[k]!.a + g.rows[k]!.w
    const layer = { ...base, y: yForCap(base, bottom - span - 40) }
    const { ed } = rowsEditor({ sailor_localLayers: [layer] })
    drag(ed, layer.id, 18)
    const l = ed.localLayers.value[0] as any
    const m = marksAt(l, l.y)
    expect(m.baselines[m.baselines.length - 1]!).toBeCloseTo(bottom, 6)
  })
  it('away from rows and margins, the first baseline lands on the baseline grid', () => {
    const base = createTextLayer({ text: 'Mid', fontSize: 0.04, boxW: 0.4, valign: 'top', x: 0.5 } as any)
    const layer = { ...base, y: 0.45 + 3 / HD }
    const { ed } = zoomedEditor({ sailor_localLayers: [layer] })   // rows off: only the margins compete
    drag(ed, layer.id, 7)
    const l = ed.localLayers.value[0] as any
    expect(onUnit(marksAt(l, l.y).baselines[0]!, ed.layoutGridResolved.value.unit)).toBe(true)
  })
  it('re-snap puts the capitals on the nearest row top', () => {
    const base = createTextLayer({ text: 'Grid', fontSize: 0.04, boxW: 0.4, valign: 'top', x: 0.5 } as any)
    const g = rowsEditor({}).ed.layoutGridResolved.value
    const target = g.rows[2]!.a
    const layer = { ...base, y: yForCap(base, target + 8) }
    const m = marksAt(layer, layer.y)
    const bottoms = [...g.rows.map(r => r.a + r.w), g.bottom]
    expect(bottoms.every(b => Math.abs(m.baselines[0]! - b) > 8)).toBe(true)
    const { ed } = rowsEditor({ sailor_localLayers: [layer] })
    ed.selectLocal(layer.id)
    ed.resnapSelected()
    const l = ed.localLayers.value[0] as any
    expect(marksAt(l, l.y).capTop).toBeCloseTo(target, 6)
  })
  it('resizing a text box never snaps its height (it follows the text)', () => {
    const layer = createTextLayer({ text: 'Box', fontSize: 0.04, boxW: 0.4, boxH: 0.1, valign: 'top', x: 0.5, y: 0.3 } as any)
    const { ed } = zoomedEditor({ sailor_localLayers: [layer] })   // rows off: H/2 is a line
    ed.selectLocal(layer.id)
    const bottom0 = 0.3 * 675 + 0.1 * 540                            // drawn bottom, screen px
    ed.startResize('b', pe('pointerdown', 270, bottom0))
    window.dispatchEvent(pe('pointermove', 270, 675 / 2 - 1))        // 1 px off the middle line
    expect(ed.snapGuides.value.hy).toBeNull()
    window.dispatchEvent(pe('pointerup', 270, 675 / 2 - 1))
    const l = ed.localLayers.value[0] as any
    expect(l.y * 675 + l.boxH * 540).toBeCloseTo(675 / 2 - 1, 6)
  })
})

describe('a box with nothing in reach rounds its top to the baseline grid', () => {
  const at = (o: number) => createRectLayer({ x: 0.5, y: (378 + o + 27) / HD, w: 0.2, h: 0.05 })   // top = 378 + o design px
  // An offset whose dropped top (378 + o + 14) is OFF the baseline grid, so rounding is visible.
  const offGrid = (unit: number) => [1, 2, 3, 5, 7, 9].find(o => !onUnit(378 + o + 14, unit))!
  it('rounds the top when the grid is shown', () => {
    const unit = zoomedEditor({}).ed.layoutGridResolved.value.unit
    const layer = at(offGrid(unit))
    const { ed } = zoomedEditor({ sailor_localLayers: [layer] })
    drag(ed, layer.id, 7)                                            // 14 design px
    const l = ed.localLayers.value[0] as any
    expect(onUnit(l.y * HD - (l.h * WD) / 2, unit)).toBe(true)
  })
  it('places freely with ⌥, and when the grid is hidden', () => {
    const unit = zoomedEditor({}).ed.layoutGridResolved.value.unit
    const o = offGrid(unit)
    const a = zoomedEditor({ sailor_localLayers: [at(o)] }).ed
    drag(a, a.localLayers.value[0]!.id, 7, { altKey: true })
    const la = a.localLayers.value[0] as any
    expect(la.y * HD - (la.h * WD) / 2).toBeCloseTo(378 + o + 14, 6)
    const b = zoomedEditor({ sailor_localLayers: [at(o)] }).ed
    b.setLayoutGrid({ ...b.layoutGrid.value, show: false }, false)
    drag(b, b.localLayers.value[0]!.id, 7)
    const lb = b.localLayers.value[0] as any
    expect(lb.y * HD - (lb.h * WD) / 2).toBeCloseTo(378 + o + 14, 6)
  })
})

describe('spans in the editor', () => {
  it('layerGridBox is the box in design px; for text it runs from the capitals to the last baseline', () => {
    const rect = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 })
    const text = createTextLayer({ text: 'One\nTwo', fontSize: 0.04, boxW: 0.4, valign: 'top', x: 0.5, y: 0.3 } as any)
    const { ed } = rowsEditor({ sailor_localLayers: [rect, text] })
    const b = ed.layerGridBox(rect)
    expect(b.x).toBeCloseTo(0.5 * WD - 0.1 * WD, 6)
    expect(b.w).toBeCloseTo(0.2 * WD, 6)
    expect(b.y).toBeCloseTo(0.5 * HD - 0.05 * WD, 6)
    expect(b.h).toBeCloseTo(0.1 * WD, 6)
    const m = marksAt(text, 0.3)
    const t = ed.layerGridBox(text)
    expect(t.y).toBeCloseTo(m.capTop, 6)
    expect(t.h).toBeCloseTo(m.baselines[1]! - m.capTop, 6)
  })
  it('typing a column moves the left edge onto it, in one undo step', () => {
    const rect = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 })
    const { ed } = rowsEditor({ sailor_localLayers: [rect] })
    const g = ed.layoutGridResolved.value
    const rev = ed.historyRev()
    ed.setLayerSpan(rect.id, { col: 3 })
    const l = ed.localLayers.value[0] as any
    expect((l.x - l.w / 2) * WD).toBeCloseTo(g.cols[2]!.a, 6)
    expect(l.w).toBeCloseTo(0.2, 9)
    expect(ed.historyRev()).toBe(rev + 1)
    ed.undo()
    expect((ed.localLayers.value[0] as any).x).toBeCloseTo(0.5, 9)
  })
  it('typing a span resizes a box to those columns and rows', () => {
    const rect = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 })
    const { ed } = rowsEditor({ sailor_localLayers: [rect] })
    const g = ed.layoutGridResolved.value
    ed.setLayerSpan(rect.id, { col: 2, cols: 4 })
    ed.setLayerSpan(rect.id, { cols: 4 })
    ed.setLayerSpan(rect.id, { row: 2 })
    ed.setLayerSpan(rect.id, { rows: 3 })
    const l = ed.localLayers.value[0] as any
    expect((l.x - l.w / 2) * WD).toBeCloseTo(g.cols[1]!.a, 6)
    expect(l.w * WD).toBeCloseTo(g.cols[4]!.a + g.cols[4]!.w - g.cols[1]!.a, 6)
    expect(l.y * HD - (l.h * WD) / 2).toBeCloseTo(g.rows[1]!.a, 6)
    expect(l.h * WD).toBeCloseTo(g.rows[3]!.a + g.rows[3]!.w - g.rows[1]!.a, 6)
    expect(ed.layerSpan(l)).toEqual({ col: 2, cols: 4, row: 2, rows: 3 })
  })
  it('text: a row puts its capitals on the row top; a column span gives it a box; a row span changes nothing', () => {
    const text = createTextLayer({ text: 'Grid', fontSize: 0.04, x: 0.5, y: 0.4 } as any)   // boxless, centred
    const { ed } = rowsEditor({ sailor_localLayers: [text] })
    const g = ed.layoutGridResolved.value
    ed.setLayerSpan(text.id, { row: 4 })
    let l = ed.localLayers.value[0] as any
    expect(marksAt(l, l.y).capTop).toBeCloseTo(g.rows[3]!.a, 6)
    ed.setLayerSpan(text.id, { col: 1, cols: 3 })
    ed.setLayerSpan(text.id, { cols: 3 })
    l = ed.localLayers.value[0] as any
    expect(l.boxW * WD).toBeCloseTo(g.cols[2]!.a + g.cols[2]!.w - g.cols[0]!.a, 6)
    const rev = ed.historyRev()
    ed.setLayerSpan(text.id, { rows: 3 })
    expect(ed.historyRev()).toBe(rev)
  })
  it('who can span what', () => {
    expect(canSpanColumns(createRectLayer({}))).toBe(true)
    expect(canSpanRows(createRectLayer({}))).toBe(true)
    expect(canSpanColumns(createTextLayer({}))).toBe(true)
    expect(canSpanRows(createTextLayer({}))).toBe(false)
    expect(canSpanColumns(createTextLayer({ runs: [{ text: 'a', x: 0, y: 0 }] } as any))).toBe(false)
    expect(canSpanColumns({ kind: 'wired', w: 0.3 } as any)).toBe(true)
    expect(canSpanRows({ kind: 'wired', w: 0.3 } as any)).toBe(false)
    expect(canSpanColumns({ kind: 'line', w: 0.3 } as any)).toBe(false)
  })
  it('why a layer can\'t span: a short reason exactly where it can\'t', () => {
    expect(spanReasons(createRectLayer({}))).toEqual({ cols: undefined, rows: undefined })
    expect(spanReasons(createTextLayer({}))).toEqual({ cols: undefined, rows: 'Text height follows its lines' })
    expect(spanReasons({ kind: 'line' })).toEqual({ cols: "This layer's size can't follow columns", rows: "This layer's size can't follow rows" })
    expect(spanReasons({ kind: 'wired' }).rows).toBe('Its height follows its content')
    expect(spanReasons(createTextLayer({ runs: [{ text: 'a', x: 0, y: 0 }] } as any)).cols).toBe('Placed lines keep their own layout')
  })
  it('selectedTextMarks: the selected text\'s capitals and baselines while the grid is shown', () => {
    const rect = createRectLayer({ x: 0.5, y: 0.7, w: 0.2, h: 0.1 })
    const text = createTextLayer({ text: 'One\nTwo', fontSize: 0.04, boxW: 0.4, valign: 'top', x: 0.5, y: 0.3 } as any)
    const { ed } = rowsEditor({ sailor_localLayers: [rect, text] })
    ed.selectLocal(rect.id)
    expect(ed.selectedTextMarks.value).toBeNull()
    ed.selectLocal(text.id)
    const m = marksAt(text, 0.3)
    const s = ed.selectedTextMarks.value!
    expect(s.capTop).toBeCloseTo(m.capTop, 6)
    expect(s.baselines).toHaveLength(2)
    expect(s.x).toBeCloseTo(0.5 * WD - 0.2 * WD, 6)
    expect(s.w).toBeCloseTo(0.4 * WD, 6)
    ed.setLayoutGrid({ ...ed.layoutGrid.value, show: false }, false)
    expect(ed.selectedTextMarks.value).toBeNull()
  })
})

// Stage 2 final-review fixes.
describe('spans and marks — final-review fixes', () => {
  it('typing a Column never pushes a multi-column box off the grid', () => {
    const rect = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 })
    const { ed } = rowsEditor({ sailor_localLayers: [rect] })
    const g = ed.layoutGridResolved.value, n = g.cols.length
    ed.setLayerSpan(rect.id, { col: 1, cols: 3 })
    ed.setLayerSpan(rect.id, { cols: 3 })
    ed.setLayerSpan(rect.id, { col: n })                          // the last column: the span can't fit there
    const l = ed.localLayers.value[0] as any
    expect((l.x + l.w / 2) * WD).toBeCloseTo(g.cols[n - 1]!.a + g.cols[n - 1]!.w, 6)   // right edge on the grid's
    expect(ed.layerSpan(l)).toEqual(expect.objectContaining({ col: n - 2, cols: 3 }))
  })
  it('typing a Row never pushes a multi-row box off the grid', () => {
    const rect = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 })
    const { ed } = rowsEditor({ sailor_localLayers: [rect] })
    const g = ed.layoutGridResolved.value, n = g.rows.length
    ed.setLayerSpan(rect.id, { row: 1 })
    ed.setLayerSpan(rect.id, { rows: 2 })
    ed.setLayerSpan(rect.id, { row: n })
    const l = ed.localLayers.value[0] as any
    expect(ed.layerSpan(l)).toEqual(expect.objectContaining({ row: n - 1, rows: 2 }))
  })
  it('corner-pinned text snaps as a box: no marks, its box is the drawn box', () => {
    const pin = { tl: { x: 0.1, y: 0 }, tr: { x: 0, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } }
    const text = createTextLayer({ text: 'Pinned', fontSize: 0.04, boxW: 0.4, valign: 'top', x: 0.5, y: 0.3, cornerPin: pin } as any)
    const { ed } = rowsEditor({ sailor_localLayers: [text] })
    ed.selectLocal(text.id)
    expect(ed.selectedTextMarks.value).toBeNull()
    const b = ed.layerGridBox(text)
    const m = marksAt(text, 0.3)
    expect(b.y).not.toBeCloseTo(m.capTop, 3)
  })
  it('rotated text snaps as a box: its top rounds to the baseline grid', () => {
    const base = createTextLayer({ text: 'Tilt', fontSize: 0.04, boxW: 0.4, valign: 'top', x: 0.5, rotation: 3 } as any)
    const unit = zoomedEditor({}).ed.layoutGridResolved.value.unit
    const m = textMetrics(base as any, WD)!
    const boxTop = (y: number) => y * HD + textVAlignCenterOffset(base as any, m.boxH) - m.boxH / 2
    // A start whose dropped box top is off the baseline grid, and whose dropped first baseline is too.
    const o = [1, 2, 3, 5, 7, 9].find(k => {
      const y = 0.3 + (k + 14) / HD
      return !onUnit(boxTop(y), unit) && !onUnit(boxTop(y) + m.baselines[0]!, unit)
    })!
    const layer = { ...base, y: 0.3 + o / HD }                     // clear of the margins and the middle
    const { ed } = zoomedEditor({ sailor_localLayers: [layer] })
    expect(ed.layerGridBox(layer).h).toBeCloseTo(m.boxH, 6)       // the box, not capitals-to-baseline
    drag(ed, layer.id, 7)
    const l = ed.localLayers.value[0] as any
    expect(onUnit(boxTop(l.y), unit)).toBe(true)
  })
  it('a Row lands exactly on the row when the display size is rounded off the design aspect', () => {
    const node = reactive({ id: 'f', data: { properties: { sailor_localLayers: [createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 })] } } }) as any
    const rect = { left: 0, top: 0, width: 540, height: 674, right: 540, bottom: 674, x: 0, y: 0 } as DOMRect
    const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 540, h: 674 }), designDims: () => ({ w: 1080, h: 1350 }), getRect: () => rect })
    ed.ensureLayoutGrid()
    ed.setLayoutGrid({ ...patchLayoutGrid(ed.layoutGrid.value, { rows: 'square' }), show: true }, false)
    const g = ed.layoutGridResolved.value
    const id = ed.localLayers.value[0]!.id
    ed.setLayerSpan(id, { row: 3 })
    const l = ed.localLayers.value[0] as any
    expect(l.y * HD - (l.h * WD) / 2).toBeCloseTo(g.rows[2]!.a, 6)
    expect(ed.layerGridBox(l).h).toBeCloseTo(l.h * WD, 6)
  })
  it('the selected layer is measured once: selectedGridBox / selectedSpan follow it', () => {
    const rect = createRectLayer({ x: 0.5, y: 0.7, w: 0.2, h: 0.1 })
    const text = createTextLayer({ text: 'One\nTwo', fontSize: 0.04, boxW: 0.4, valign: 'top', x: 0.5, y: 0.3 } as any)
    const { ed } = rowsEditor({ sailor_localLayers: [rect, text] })
    expect(ed.selectedGridBox.value).toBeNull()
    ed.selectLocal(text.id)
    expect(ed.selectedGridBox.value).toEqual(ed.layerGridBox(text))
    expect(ed.selectedSpan.value).toEqual(ed.layerSpan(text))
    ed.selectLocal(rect.id)
    expect(ed.selectedGridBox.value).toEqual(ed.layerGridBox(rect))
  })
  it('a web font finishing loading re-measures the selected text', () => {
    const text = createTextLayer({ text: 'Font', fontSize: 0.04, boxW: 0.4, valign: 'top', x: 0.5, y: 0.3 } as any)
    const { ed } = rowsEditor({ sailor_localLayers: [text] })
    ed.selectLocal(text.id)
    let marks = 0, spans = 0
    watch(ed.selectedTextMarks, () => { marks++ }, { flush: 'sync' })
    watch(ed.selectedSpan, () => { spans++ }, { flush: 'sync' })
    void ed.selectedTextMarks.value; void ed.selectedSpan.value
    bumpTextMetricsGeneration()
    void ed.selectedTextMarks.value; void ed.selectedSpan.value
    expect(marks).toBe(1)
    expect(spans).toBe(1)
  })
})
