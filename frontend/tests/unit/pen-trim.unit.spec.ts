// tests/unit/pen-trim.unit.spec.ts
// The pen's Trim, Cut and Dissolve tools and segment Delete, driven through
// usePen the way PenOverlay drives them (node environment, no DOM).
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen, type PenTool } from '~/composables/pen/usePen'

const DEV: ViewMatrix = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
const mk = (tools?: PenTool[]) => {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const pen = usePen({ doc, view: ref(DEV), options: tools ? { tools } : undefined })
  return { doc, pen }
}
const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
  preventDefault() {}, stopPropagation() {}, ...mods,
}) as unknown as KeyboardEvent
const lines = (d: SketchDoc) => d.entities.filter(e => e.kind === 'line') as any[]
const paths = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path') as any[]
const pt = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any
const line = (pen: ReturnType<typeof usePen>, x0: number, y0: number, x1: number, y1: number) => {
  pen.selectTool('line'); pen.place(x0, y0); pen.place(x1, y1)
}
const path = (pen: ReturnType<typeof usePen>, pts: [number, number][]) => {
  pen.selectTool('path')
  for (const [x, y] of pts) { pen.pathDown(x, y); pen.pathUp(x, y) }
  pen.finishPath(false)
}

describe('pen trim tool', () => {
  it('hovering sets trimHover on the piece under the pointer', () => {
    const { doc, pen } = mk()
    line(pen, 0, 0, 10, 0)
    line(pen, 5, -5, 5, 5)
    const [h, v] = lines(doc.value)
    pen.selectTool('trim')
    pen.trimMove(2, 0.1)
    const s = pen.trimHover.value!
    expect(s).toBeTruthy()
    expect(s.ref).toEqual({ kind: 'line', id: h.id })
    expect(s.start.cutter).toBe(null)
    expect(s.end.cutter).toEqual({ kind: 'line', id: v.id })
    expect(s.end.point.x).toBeCloseTo(5)
    // far from everything: no hover
    pen.trimMove(20, 20)
    expect(pen.trimHover.value).toBe(null)
    expect(doc.value.entities.length).toBe(6)   // hovering never edits
  })

  it('a press swept across two pieces removes both, and one undo restores both', () => {
    const { doc, pen } = mk()
    line(pen, 0, 0, 10, 0)
    line(pen, 3, -4, 3, 4)
    line(pen, 7, -4, 7, 4)
    const before = JSON.stringify(doc.value)
    const h = lines(doc.value)[0]
    pen.selectTool('trim')
    pen.trimMove(1.5, 0.05)
    pen.trimDown(1.5, 0.05)          // removes [0, 3]
    pen.trimMove(5, 0.05)            // removes [3, 7] while pressed
    pen.trimUp(5, 0.05)
    const hl = lines(doc.value).find(l => l.id === h.id)!
    const xs = [pt(doc.value, hl.p1).x, pt(doc.value, hl.p2).x].sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(7)
    expect(xs[1]).toBeCloseTo(10)
    expect(pen.trimGhosts.value.length).toBe(2)
    pen.undo()
    expect(JSON.stringify(doc.value)).toBe(before)
    expect(pen.trimGhosts.value.length).toBe(0)
  })

  it('sweeping along a line past a crossing leaves the cutting circle alone', () => {
    const { doc, pen } = mk()
    pen.selectTool('circle'); pen.place(5, 0.001); pen.place(7, 0.001)   // crosses the line at x ≈ 3 and 7
    line(pen, 0, 0, 10, 0)
    pen.selectTool('trim')
    pen.trimDown(1, 0)
    for (const x of [2, 2.8, 2.95, 3, 3.05, 3.2, 4, 5]) pen.trimMove(x, 0)
    pen.trimUp(5, 0)
    expect(doc.value.entities.some(e => e.kind === 'circle')).toBe(true)
    const [l] = lines(doc.value)
    expect(Math.min(pt(doc.value, l.p1).x, pt(doc.value, l.p2).x)).toBeCloseTo(7, 2)
    // but a sweep that moves on across the circle, clear of that crossing, takes its piece
    pen.trimDown(5, 1.5)
    pen.trimMove(5, 1.95); pen.trimMove(5, 2)
    pen.trimUp(5, 2)
    expect(doc.value.entities.some(e => e.kind === 'circle')).toBe(false)
  })

  it('reports rules dropped with the piece', () => {
    const { doc, pen } = mk()
    line(pen, 0, 0, 10, 0)
    line(pen, 5, -5, 5, 5)
    const [h] = lines(doc.value)
    pen.pick(h.id); pen.apply('horizontal')
    pen.selectTool('trim')
    pen.trimDown(2, 0); pen.trimUp(2, 0)       // the left piece — the line survives, rule stays
    pen.trimDown(7, 0); pen.trimUp(7, 0)       // the rest — the line goes, and its rule with it
    expect(lines(doc.value).some(l => l.id === h.id)).toBe(false)
    expect(pen.status.value).toBe('Removed 1 rule with that piece')
  })

  it('Escape in Trim clears the ghosts first, then falls back', () => {
    const { pen } = mk()
    line(pen, 0, 0, 10, 0)
    line(pen, 5, -5, 5, 5)
    pen.selectTool('trim')
    pen.trimDown(2, 0); pen.trimUp(2, 0)
    expect(pen.trimGhosts.value.length).toBe(1)
    expect(pen.onKeydown(key('Escape'))).toBe(true)
    expect(pen.trimGhosts.value.length).toBe(0)
    expect(pen.onKeydown(key('Escape'))).toBe(false)   // nothing left: the host's cancel
  })

  it('ghosts clear on tool change', () => {
    const { pen } = mk()
    line(pen, 0, 0, 10, 0)
    line(pen, 5, -5, 5, 5)
    pen.selectTool('trim')
    pen.trimDown(2, 0); pen.trimUp(2, 0)
    pen.selectTool('select')
    expect(pen.trimGhosts.value.length).toBe(0)
    expect(pen.trimHover.value).toBe(null)
  })
})

describe('pen cut and dissolve tools', () => {
  it('cut then dissolve round-trips a path line segment', () => {
    const { doc, pen } = mk()
    path(pen, [[0, 0], [10, 0]])
    const p = paths(doc.value)[0]
    const nEnt = doc.value.entities.length
    pen.selectTool('cut')
    pen.cutClick(4, 0.05)
    expect(paths(doc.value)[0].anchors.length).toBe(3)
    expect(pt(doc.value, paths(doc.value)[0].anchors[1]).x).toBeCloseTo(4)
    pen.selectTool('dissolve')
    pen.dissolveMove(4, 0.05)
    expect(pen.dissolveHover.value?.ok).toBe(true)
    pen.dissolveClick(4, 0.05)
    expect(paths(doc.value)[0].id).toBe(p.id)
    expect(paths(doc.value)[0].anchors.length).toBe(2)
    expect(paths(doc.value)[0].segments.length).toBe(1)
    expect(doc.value.entities.length).toBe(nEnt)
  })

  it('cut refuses a circle with a plain hint', () => {
    const { doc, pen } = mk()
    pen.selectTool('circle'); pen.place(0, 0); pen.place(3, 0)
    const n = doc.value.entities.length
    pen.selectTool('cut')
    pen.cutClick(0, 3)
    expect(doc.value.entities.length).toBe(n)
    expect(pen.status.value).toBe("Cut works on a path's lines and arcs")
  })

  it('dissolve refuses a corner with a plain hint', () => {
    const { doc, pen } = mk()
    path(pen, [[0, 0], [5, 0], [5, 5]])
    pen.selectTool('dissolve')
    pen.dissolveMove(5, 0)
    expect(pen.dissolveHover.value?.ok).toBe(false)
    pen.dissolveClick(5, 0)
    expect(paths(doc.value)[0].anchors.length).toBe(3)
    expect(pen.status.value).toBe("These two sides don't line up, so they can't merge")
  })
})

describe('pen segment delete', () => {
  it('Delete removes an Option-selected segment', () => {
    const { doc, pen } = mk()
    path(pen, [[0, 0], [5, 0], [5, 5], [0, 5]])
    const p = paths(doc.value)[0]
    pen.selectTool('select')
    pen.pickSegment(p.id, 1)
    expect(pen.onKeydown(key('Delete'))).toBe(true)
    const ps = paths(doc.value)
    expect(ps.length).toBe(2)
    expect(ps.reduce((n, q) => n + q.segments.length, 0)).toBe(2)
    expect(pen.selectedSegments.value.length).toBe(0)
  })

  it('del() removes several segments of one closed path', () => {
    const { doc, pen } = mk()
    path(pen, [[0, 0], [5, 0], [5, 5], [0, 5]])
    const p0 = paths(doc.value)[0]
    pen.selectTool('path')
    for (const [x, y] of [[0, 0], [5, 0], [5, 5], [0, 5]] as const) { pen.pathDown(x + 20, y); pen.pathUp(x + 20, y) }
    pen.pathDown(20, 0); pen.pathUp(20, 0)   // close
    const closed = paths(doc.value).find(q => q.closed)!
    const segPts = (q: any, i: number) => [q.anchors[i], q.anchors[(i + 1) % q.anchors.length]].map((id: string) => pt(doc.value, id)).map((a: any) => `${a.x},${a.y}`)
    const keep = segPts(closed, 1)
    pen.selectTool('select')
    pen.pickSegment(closed.id, 0)
    pen.pickSegment(closed.id, 2, true)
    pen.pickSegment(closed.id, 3, true)
    pen.del()
    const left = paths(doc.value).filter(q => q.id !== p0.id)
    expect(left.length).toBe(1)
    expect(left[0].segments.length).toBe(1)
    expect(segPts(left[0], 0)).toEqual(keep)
  })
})

describe('pen tool keys', () => {
  it('T, C and D pick Trim, Cut and Dissolve with no modifier', () => {
    const { pen } = mk()
    expect(pen.onKeydown(key('t'))).toBe(true)
    expect(pen.tool.value).toBe('trim')
    expect(pen.onKeydown(key('c'))).toBe(true)
    expect(pen.tool.value).toBe('cut')
    expect(pen.onKeydown(key('d'))).toBe(true)
    expect(pen.tool.value).toBe('dissolve')
    expect(pen.onKeydown(key('t', { shiftKey: true }))).toBe(false)
    expect(pen.onKeydown(key('t', { altKey: true }))).toBe(false)
    expect(pen.tool.value).toBe('dissolve')
  })
  it('tools the host does not offer ignore their keys', () => {
    const { pen } = mk(['select', 'path'])
    expect(pen.options.tools.includes('trim')).toBe(false)
    for (const k of ['t', 'c', 'd']) expect(pen.onKeydown(key(k))).toBe(false)
    expect(pen.tool.value).toBe('select')
    pen.selectTool('trim')
    expect(pen.tool.value).toBe('select')
  })
})
