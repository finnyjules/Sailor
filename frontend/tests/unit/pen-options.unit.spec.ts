import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
const mk = (options?: any) => {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  return { doc, pen: usePen({ doc, view: ref(DEV), options }) }
}
const paths = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path') as any[]

describe('pen options', () => {
  it('tools limits which tools can be selected', () => {
    const { pen } = mk({ tools: ['select', 'path', 'curve'] })
    pen.selectTool('circle')
    expect(pen.tool.value).not.toBe('circle')
    pen.selectTool('curve')
    expect(pen.tool.value).toBe('curve')
  })
  it('openOnly: clicking the first point does not close the path', () => {
    const { doc, pen } = mk({ openOnly: true })
    pen.selectTool('path')
    for (const [x, y] of [[0, 0], [4, 0], [4, 4]]) { pen.pathDown(x, y); pen.pathUp(x, y) }
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.finishPath(true)
    expect(paths(doc.value)[0]?.closed).toBe(false)
  })
  it('openOnly excludes the circle tool', () => {
    const { pen } = mk({ openOnly: true })
    pen.selectTool('circle')
    expect(pen.tool.value).not.toBe('circle')
  })
})

describe('small fixes', () => {
  it('(a) abandoning a path keeps a pre-existing point it started on', () => {
    const { doc, pen } = mk()
    pen.selectTool('point'); pen.place(2, 2)
    const n = doc.value.entities.length
    pen.selectTool('path'); pen.pathDown(2, 2); pen.pathUp(2, 2)
    pen.cancelPath()
    expect(doc.value.entities.length).toBe(n)
  })
  it('(c) switching tools mid-line removes its own start point', () => {
    const { doc, pen } = mk()
    pen.selectTool('line'); pen.place(1, 1)
    pen.selectTool('circle')
    expect(doc.value.entities.filter(e => e.kind === 'point')).toHaveLength(0)
  })
  it('(b) endGesture clears a live curve drag', () => {
    const { pen } = mk()
    pen.selectTool('curve'); pen.curveDown(0, 0); pen.curveMove(1, 1)
    pen.endGesture()
    expect(pen.getCurveDrag()).toBeNull()
  })
})
