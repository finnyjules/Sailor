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
  it('a sparkle without a frame loop is recorded and dispose is safe', () => {
    const { pen } = host()
    pen.sparkle(0, 0)
    expect(pen.sparkleCount()).toBe(1)
    pen.dispose()
  })
})
