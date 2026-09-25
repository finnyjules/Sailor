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
    const key = (k: string) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, preventDefault() {} }) as unknown as KeyboardEvent
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
    const key = (k: string, shift = false) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: shift, preventDefault() {} }) as unknown as KeyboardEvent
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
