// tests/unit/pen-use-pen.unit.spec.ts
// usePen must construct and run in the node environment (no window, no rAF).
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen } from '~/composables/pen/usePen'

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
  it('a sparkle without a frame loop is recorded and dispose is safe', () => {
    const { pen } = host()
    pen.sparkle(0, 0)
    expect(pen.sparkleCount()).toBe(1)
    pen.dispose()
  })
})
