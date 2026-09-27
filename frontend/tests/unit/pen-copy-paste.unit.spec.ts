// tests/unit/pen-copy-paste.unit.spec.ts
// Pen stage 6: Copy / Paste inside the pen (16 px down-right per paste, the
// copy selected, one undo step, the clipboard shared by every pen), paste
// centred on a point, open-only refusals, Option-picked segments, Select all,
// Copy as SVG, and Dissolve on one selected point.
import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'
import { clearPenClipboard, penClipboard } from '~/composables/pen/penClipboard'
import { REASON } from '~/composables/pen/penReasons'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk(build: (d: SketchDoc) => void = () => {}, options?: any) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  return { doc, pen: usePen({ doc, view: ref(DEV), options }) }
}
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any
const lines = (d: SketchDoc) => d.entities.filter(e => e.kind === 'line') as any[]
beforeEach(() => clearPenClipboard())

describe('Copy and Paste', () => {
  it('copies a line with its rule; each paste lands 16 px further down-right, selected, one step', () => {
    let l = ''
    const { doc, pen } = mk(d => { const a = addPoint(d, 2, 2), b = addPoint(d, 8, 2); l = addLine(d, a, b); addConstraint(d, 'horizontal', [a, b]) })
    pen.pick(l)
    expect(pen.copySelection()).toBe(true)
    expect(pen.status.value).toBe('Copied 1 line')
    expect(pen.canUndo()).toBe(false)
    expect(pen.paste()).toBe(true)
    const nl = lines(doc.value)[1]
    expect(pen.selection.value).toEqual([nl.id])
    expect(P(doc.value, nl.p1).x).toBeCloseTo(2 + 16 / 34, 9)
    expect(P(doc.value, nl.p1).y).toBeCloseTo(2 - 16 / 34, 9)
    expect(doc.value.constraints.filter(k => k.kind === 'horizontal')).toHaveLength(2)
    expect(pen.status.value).toBe('Pasted 1 line')
    pen.paste()
    expect(P(doc.value, lines(doc.value)[2].p1).x).toBeCloseTo(2 + 32 / 34, 9)
    pen.undo(); pen.undo()
    expect(lines(doc.value)).toHaveLength(1)
  })
  it('the menu’s Paste centres the copy on the point', () => {
    let l = ''
    const { doc, pen } = mk(d => { l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 2)) })
    pen.pick(l); pen.copySelection()
    pen.paste({ x: 10, y: 10 })
    const nl = lines(doc.value)[1]
    expect(P(doc.value, nl.p1)).toMatchObject({ x: 8, y: 9 })
    expect(P(doc.value, nl.p2)).toMatchObject({ x: 12, y: 11 })
  })
  it('says why nothing can be pasted, and an open-only pen refuses closed pieces', () => {
    let c = ''
    const { pen } = mk(d => { c = addCircle(d, addPoint(d, 0, 0), 1) })
    expect(pen.pasteState()).toEqual({ ok: false, reason: REASON.emptyClip })
    pen.pick(c); pen.copySelection()
    expect(pen.pasteState().ok).toBe(true)
    const guide = mk(() => {}, { openOnly: true, tools: ['select', 'path', 'curve'] }).pen
    expect(guide.pasteState()).toEqual({ ok: false, reason: REASON.openOnly })
    expect(guide.paste()).toBe(false)
  })
  it('one clipboard for every pen on the page', () => {
    let l = ''
    const a = mk(d => { l = addLine(d, addPoint(d, 0, 0), addPoint(d, 1, 0)) })
    a.pen.pick(l); a.pen.copySelection()
    const b = mk()
    expect(b.pen.paste()).toBe(true)
    expect(lines(b.doc.value)).toHaveLength(1)
    expect(penClipboard.value).not.toBeNull()
  })
  it('into another pen drawing in other units: the same size on screen, the same way up, in the middle of its view', () => {
    // the pen page: 34 px per unit, y up; a line (0,0)→(4,2) with its length held and a quarter arc
    let l = '', arcP = ''
    const a = mk(d => {
      const p = addPoint(d, 0, 0), q = addPoint(d, 4, 2)
      l = addLine(d, p, q); addConstraint(d, 'distance', [p, q], Math.hypot(4, 2))
      const s = addPoint(d, 6, 0), e = addPoint(d, 8, 2), c = addPoint(d, 8, 0)
      arcP = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
    })
    a.pen.pick(l); a.pen.pick(arcP, true); a.pen.copySelection()
    // a host drawing 10 px per unit, y down, 800 × 600 px on screen
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const V = { a: 10, b: 0, c: 0, d: 10, e: 0, f: 0 }
    const b = usePen({ doc, view: ref(V) })
    b.setViewSize(800, 600)
    expect(b.paste()).toBe(true)
    const d = doc.value
    const nl = lines(d)[0]
    const p1 = P(d, nl.p1), p2 = P(d, nl.p2)
    const k = 34 / 10
    // the same on-screen length: 4.47 units × 34 px = 15.2 units × 10 px
    expect(Math.hypot(p2.x - p1.x, p2.y - p1.y)).toBeCloseTo(Math.hypot(4, 2) * k, 6)
    expect(d.constraints.find(c => c.kind === 'distance')!.value).toBeCloseTo(Math.hypot(4, 2) * k, 6)
    // the same way up: p2 was up-right of p1 on screen, and still is (y down here)
    expect(p2.x).toBeGreaterThan(p1.x)
    expect(p2.y).toBeLessThan(p1.y)
    // the arc still bulges the same way on screen: its sweep turned over with y
    const arc = d.entities.find(e => e.kind === 'path') as any
    expect(arc.segments[0].sweep).toBe(0)
    // centred on the view's middle (40, 30), then one 16 px step down-right
    const xs = d.entities.filter(e => e.kind === 'point').map((e: any) => e.x)
    const ys = d.entities.filter(e => e.kind === 'point').map((e: any) => e.y)
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(40 + 1.6, 6)
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(30 + 1.6, 6)
    // pasting back into the pen it came from still steps 16 px from where it was
    a.pen.paste()
    const back = lines(a.doc.value).at(-1)
    expect(P(a.doc.value, back.p1).x).toBeCloseTo(2 * 16 / 34, 9)
  })
  it('copies Option-picked segments as pieces of their own', () => {
    let P1 = ''
    const { doc, pen } = mk(d => {
      const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), c = addPoint(d, 4, 3)
      P1 = addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
    })
    pen.pickSegment(P1, 1)
    pen.copySelection(); pen.paste()
    const paths = doc.value.entities.filter(e => e.kind === 'path') as any[]
    expect(paths).toHaveLength(2)
    expect(paths[1].anchors).toHaveLength(2)
  })
})

describe('Select all, Copy as SVG, Dissolve a point', () => {
  it('Select all picks every piece and lone point, in Select', () => {
    let l = '', lone = ''
    const { pen } = mk(d => { l = addLine(d, addPoint(d, 0, 0), addPoint(d, 1, 0)); lone = addPoint(d, 5, 5) })
    pen.selectTool('line')
    expect(pen.selectAll()).toBe(true)
    expect(pen.tool.value).toBe('select')
    expect(pen.selection.value.sort()).toEqual([l, lone].sort())
    expect(mk().pen.selectAll()).toBe(false)
  })
  it('Copy as SVG gives the selection’s outline', () => {
    let l = ''
    const { pen } = mk(d => { l = addLine(d, addPoint(d, 2, 2), addPoint(d, 8, 2)); addLine(d, addPoint(d, 0, 5), addPoint(d, 1, 5)) })
    pen.pick(l)
    expect(pen.copySvg()).toBe('M 2 2 L 8 2')
    expect(pen.status.value).toBe('Copied as SVG')
  })
  it('dissolves a selected point between two pieces that line up; says why it can’t otherwise', () => {
    let m = '', a = '', corner = '', P1 = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); m = addPoint(d, 2, 0); const b = addPoint(d, 4, 0)
      P1 = addPath(d, [a, m, b], [{ kind: 'line' }, { kind: 'line' }])
      const x = addPoint(d, 10, 0); corner = addPoint(d, 12, 0); const y = addPoint(d, 12, 2)
      addPath(d, [x, corner, y], [{ kind: 'line' }, { kind: 'line' }])
    })
    expect(pen.dissolveState(a)).toEqual({ ok: false, reason: REASON.notBetween })
    expect(pen.dissolveState(corner)).toEqual({ ok: false, reason: REASON.noMerge })
    expect(pen.dissolveState(m)).toEqual({ ok: true })
    pen.pick(m)
    expect(pen.dissolvePoint(m)).toBe(true)
    expect(P(doc.value, P1).anchors).toHaveLength(2)
    expect(pen.selection.value).toEqual([])
    pen.undo()
    expect(P(doc.value, P1).anchors).toHaveLength(3)
  })
})
