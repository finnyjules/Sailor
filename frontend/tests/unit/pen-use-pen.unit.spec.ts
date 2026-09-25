// tests/unit/pen-use-pen.unit.spec.ts
// usePen must construct and run in the node environment (no window, no rAF).
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen } from '~/composables/pen/usePen'
import { applyView } from '~/lib/sketch/view'

const host = () => {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const view = ref<ViewMatrix>({ a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 })
  let changes = 0
  const pen = usePen({ doc, view, onChange: () => { changes++ } })
  return { doc, pen, changes: () => changes }
}

describe('usePen', () => {
  it('draws a line, reports each committed step, and undoes it', () => {
    const { doc, pen, changes } = host()
    pen.selectTool('line')
    pen.place(1, 1)
    pen.place(4, 1)
    expect(doc.value.entities.map(e => e.kind).sort()).toEqual(['line', 'point', 'point'])
    expect(changes()).toBe(2)
    pen.undo()
    expect(doc.value.entities.map(e => e.kind)).toEqual(['point'])
    expect(pen.canRedo()).toBe(true)
  })
  it('reports undo, redo and reset through onChange as well', () => {
    const { pen, changes } = host()
    pen.selectTool('line')
    pen.place(1, 1)
    pen.place(4, 1)
    expect(changes()).toBe(2)
    pen.undo()
    expect(changes()).toBe(3)
    pen.redo()
    expect(changes()).toBe(4)
    pen.undo(); pen.undo()
    expect(changes()).toBe(6)
    pen.undo()                     // nothing left to undo: no report
    expect(changes()).toBe(6)
    pen.redo(); pen.redo()
    expect(changes()).toBe(8)
    pen.redo()                     // nothing left to redo: no report
    expect(changes()).toBe(8)
    pen.reset()
    expect(changes()).toBe(9)
  })
  it('Escape and Enter report whether they did anything, so a host can take them', () => {
    const { pen } = host()
    const key = (k: string) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} }) as unknown as KeyboardEvent
    expect(pen.onKeydown(key('Escape'))).toBe(false)   // nothing pending → the host's cancel
    expect(pen.onKeydown(key('Enter'))).toBe(false)    // nothing to finish → the host's commit
    let aborted = 0
    expect(pen.onKeydown(key('Escape'), { cancelGesture: () => { aborted++; return true } })).toBe(true)
    expect(aborted).toBe(1)
    pen.selectTool('path')
    pen.pathDown(1, 1); pen.pathUp(1, 1)
    pen.pathDown(4, 1); pen.pathUp(4, 1)
    expect(pen.onKeydown(key('Enter'))).toBe(true)     // finishes the path
    expect(pen.pendingPath.value).toBe(null)
  })
  it('a screen marquee selects exactly the points drawn inside it under a 30° rotated view', () => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const t = Math.PI / 6, k = 34
    const view = ref<ViewMatrix>({ a: k * Math.cos(t), b: k * Math.sin(t), c: -k * Math.sin(t), d: k * Math.cos(t), e: 185.5, f: -114.4 })
    const pen = usePen({ doc, view })
    pen.selectTool('point')
    const coords = [[2, 2], [4, 2], [6, 2], [2, 5], [4, 5], [6, 5], [8, 8]]
    for (const [x, y] of coords) pen.place(x!, y!)
    const ptsDoc = doc.value.entities.filter(e => e.kind === 'point') as any[]
    expect(ptsDoc.length).toBe(coords.length)
    // a pixel rectangle around the screen images of (4,2) and (4,5) only
    const s1 = applyView(view.value, { x: 4, y: 2 }), s2 = applyView(view.value, { x: 4, y: 5 })
    const pad = 6
    const x0 = Math.min(s1.x, s2.x) - pad, x1 = Math.max(s1.x, s2.x) + pad
    const y0 = Math.min(s1.y, s2.y) - pad, y1 = Math.max(s1.y, s2.y) + pad
    const expected = ptsDoc.filter(p => {
      const s = applyView(view.value, p)
      return s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1
    }).map(p => p.id).sort()
    const target = ptsDoc.filter(p => p.x === 4).map(p => p.id).sort()
    expect(expected).toEqual(target)   // the rectangle really holds exactly those two
    pen.selectTool('select')
    pen.marqueeSelectScreen(x0, y0, x1, y1)
    expect(pen.selection.value.slice().sort()).toEqual(target)
    // the same corners read as a drawing-axis box would pick a different set
    pen.marqueeSelect(x0, y0, x1, y1)
    expect(pen.selection.value.slice().sort()).not.toEqual(target)
  })
  it('arrow nudge moves in screen space: exact 0.25 steps at the default view, screen-up under rotation', () => {
    const key = (k: string, shift = false) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: shift, preventDefault() {}, stopPropagation() {} }) as unknown as KeyboardEvent
    const { doc, pen } = host()
    pen.selectTool('point'); pen.place(3, 3)
    const p = doc.value.entities[0] as any
    pen.selectTool('select'); pen.pick(p.id)
    pen.onKeydown(key('ArrowRight')); expect([p.x, p.y]).toEqual([3.25, 3])
    pen.onKeydown(key('ArrowUp')); expect([p.x, p.y]).toEqual([3.25, 3.25])
    pen.onKeydown(key('ArrowDown', true)); expect([p.x, p.y]).toEqual([3.25, 0.75])
    pen.onKeydown(key('ArrowLeft', true)); expect([p.x, p.y]).toEqual([0.75, 0.75])

    const doc2 = ref<SketchDoc>({ entities: [], constraints: [] })
    const t = Math.PI / 6
    const view = ref<ViewMatrix>({ a: 34 * Math.cos(t), b: 34 * Math.sin(t), c: -34 * Math.sin(t), d: 34 * Math.cos(t), e: 185.5, f: -114.4 })
    const pen2 = usePen({ doc: doc2, view })
    pen2.selectTool('point'); pen2.place(5, 5)
    const q = doc2.value.entities[0] as any
    pen2.selectTool('select'); pen2.pick(q.id)
    const before = applyView(view.value, q)
    pen2.onKeydown(key('ArrowUp'))
    const after = applyView(view.value, q)
    expect(after.x - before.x).toBeCloseTo(0, 9)
    expect(after.y - before.y).toBeCloseTo(-8.5, 9)
  })
  it('a sparkle without a frame loop is recorded and dispose is safe', () => {
    const { pen } = host()
    pen.sparkle(0, 0)
    expect(pen.sparkleCount()).toBe(1)
    pen.dispose()
  })
})

// a fake keydown that records whether the pen claimed it
function fakeKey(k: string) {
  const ev = {
    key: k, metaKey: false, ctrlKey: false, shiftKey: false,
    defaultPrevented: false, propagationStopped: false,
    preventDefault() { ev.defaultPrevented = true },
    stopPropagation() { ev.propagationStopped = true },
  }
  return ev
}

describe('usePen host contract', () => {
  it('Delete/Backspace claim the key only when they act', () => {
    const { pen } = host()
    for (const k of ['Delete', 'Backspace']) {
      const idle = fakeKey(k)
      expect(pen.onKeydown(idle as unknown as KeyboardEvent)).toBe(false)
      expect(idle.defaultPrevented).toBe(false)     // nothing selected, nothing pending: the host's key
      expect(idle.propagationStopped).toBe(false)
    }
    pen.selectTool('point'); pen.place(1, 1)
    const p = pen.doc.value.entities[0]!
    pen.selectTool('select'); pen.pick(p.id)
    const del = fakeKey('Delete')
    expect(pen.onKeydown(del as unknown as KeyboardEvent)).toBe(true)
    expect(del.defaultPrevented).toBe(true)
    expect(del.propagationStopped).toBe(true)
    expect(pen.doc.value.entities.length).toBe(0)
  })
  it('an Escape the pen consumes is preventDefault-ed; one it ignores is not', () => {
    const { pen } = host()
    const idle = fakeKey('Escape')
    expect(pen.onKeydown(idle as unknown as KeyboardEvent)).toBe(false)
    expect(idle.defaultPrevented).toBe(false)
    pen.selectTool('path'); pen.pathDown(1, 1); pen.pathUp(1, 1)
    const esc = fakeKey('Escape')
    expect(pen.onKeydown(esc as unknown as KeyboardEvent)).toBe(true)   // cancels the path
    expect(esc.defaultPrevented).toBe(true)
    expect(esc.propagationStopped).toBe(true)
  })
  it('finishSession finishes a pending path of 2+ anchors as one step', () => {
    const { doc, pen, changes } = host()
    pen.selectTool('path')
    pen.pathDown(1, 1); pen.pathUp(1, 1)
    pen.pathDown(4, 1); pen.pathUp(4, 1)
    const c0 = changes()
    pen.finishSession()
    expect(pen.pendingPath.value).toBe(null)
    expect(doc.value.entities.filter(e => e.kind === 'path').length).toBe(1)
    expect(changes()).toBe(c0 + 1)
  })
  it('finishSession leaves no orphan point from a lone anchor or a Line/Circle start', () => {
    for (const t of ['path', 'curve', 'line', 'circle'] as const) {
      const { doc, pen } = host()
      pen.selectTool(t)
      if (t === 'path') { pen.pathDown(2, 2); pen.pathUp(2, 2) }
      else if (t === 'curve') { pen.curveDown(2, 2); pen.curveMove(3, 3); pen.curveUp(3, 3) }   // smooth: handles too
      else pen.place(2, 2)
      expect(doc.value.entities.length).toBeGreaterThan(0)
      pen.finishSession()
      expect(doc.value.entities, t).toEqual([])
      expect(pen.pending.value).toBe(null)
      expect(pen.pendingPath.value).toBe(null)
      // settled: undo must not bring the orphan back, and redo lands on empty
      pen.undo(); pen.redo()
      expect(doc.value.entities, t).toEqual([])
    }
  })
  it('finishSession keeps a Line start that snapped onto an existing point', () => {
    const { doc, pen } = host()
    pen.selectTool('point'); pen.place(2, 2)
    pen.selectTool('line'); pen.place(2, 2)          // snaps onto the existing point
    pen.finishSession()
    expect(doc.value.entities.map(e => e.kind)).toEqual(['point'])
  })
  it('finishSession drops an armed Repeat/Mirror and, with nothing to settle, adds no step', () => {
    const { pen, changes } = host()
    pen.selectTool('line'); pen.place(1, 1); pen.place(4, 1)
    const line = pen.doc.value.entities.find(e => e.kind === 'line')!
    pen.selectTool('select'); pen.pick(line.id)
    pen.armRepeat([line.id], 4)
    expect(pen.pendingOp.value).not.toBe(null)
    const c0 = changes()
    pen.finishSession()
    expect(pen.pendingOp.value).toBe(null)
    expect(changes()).toBe(c0)
  })
  it('revert restores the drawing the pen was opened with and resets history', () => {
    const doc = ref<SketchDoc>({ entities: [{ id: 'p0', kind: 'point', x: 5, y: 5 } as any], constraints: [] })
    const opened = JSON.stringify(doc.value)
    const view = ref<ViewMatrix>({ a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 })
    let changes = 0
    const pen = usePen({ doc, view, onChange: () => { changes++ } })
    pen.selectTool('point')
    for (let i = 0; i < 205; i++) pen.place(i * 2, 20)   // more steps than the 200-entry history holds
    ;(doc.value.entities[0] as any).x = 99               // and an in-place mutation
    const c0 = changes
    pen.revert()
    expect(JSON.stringify(doc.value)).toBe(opened)
    expect(pen.canUndo()).toBe(false)
    expect(pen.canRedo()).toBe(false)
    expect(changes).toBe(c0 + 1)
    // the opening snapshot is the pen's own copy: reverting twice still works
    pen.place(1, 1); pen.revert()
    expect(JSON.stringify(doc.value)).toBe(opened)
  })
  it('a drag reports each solve through onLiveChange, and onChange only on release', () => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const view = ref<ViewMatrix>({ a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 })
    let live = 0, settled = 0
    const pen = usePen({ doc, view, onChange: () => { settled++ }, onLiveChange: () => { live++ } })
    pen.selectTool('line'); pen.place(1, 1); pen.place(4, 1)
    const p2 = (doc.value.entities.find(e => e.kind === 'line') as any).p2
    const s0 = settled, l0 = live
    // what PenOverlay does on each pointermove of a select-tool point drag…
    pen.selectTool('select')
    pen.runSolve({ point: p2, x: 5, y: 2 })
    pen.runSolve({ point: p2, x: 6, y: 3 })
    pen.runSolve({ point: p2, x: 7, y: 4 })
    expect(live - l0).toBe(3)
    expect(settled).toBe(s0)
    // …and on release
    pen.commitHistory()
    expect(settled).toBe(s0 + 1)
    expect(live - l0).toBe(3)
  })
  it('a path gesture\'s first point is a live change until it settles', () => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const view = ref<ViewMatrix>({ a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 })
    let live = 0, settled = 0
    const pen = usePen({ doc, view, onChange: () => { settled++ }, onLiveChange: () => { live++ } })
    pen.selectTool('path'); pen.pathDown(1, 1); pen.pathUp(1, 1)
    const s0 = settled
    pen.pathDown(4, 1)
    expect(live).toBe(1)
    expect(settled).toBe(s0)
    pen.pathMove(5, 2); pen.pathUp(5, 2)
    expect(settled).toBe(s0 + 1)
  })
})
