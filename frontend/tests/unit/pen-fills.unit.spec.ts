// tests/unit/pen-fills.unit.spec.ts
// Pen stage 7, the shared pen's Fill tool: hover shows the area (and whether
// it is filled), a click fills or empties it as one undo step, the first fill
// fixes the gap at 6 px of this zoom, every settled step carries fills (a line
// drawn across fills both halves), G picks the tool and a text-guide pen has
// none, Flip keeps a filled shape filled, the hover and the settle stay cheap
// on one connected drawing, and a drawing with no fills does no face work.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addPath, addLine, addCircle } from '~/lib/sketch/edit'
import { usePen, FILL_MISS } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function penWithSquare(options?: any) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const ids = [[1, 1], [5, 1], [5, 5], [1, 5]].map(([x, y]) => addPoint(doc.value, x!, y!))
  addPath(doc.value, ids, ids.map(() => ({ kind: 'line' as const })), true)
  let changes = 0
  const pen = usePen({ doc, view: ref(DEV), options, onChange: () => { changes++ } })
  return { doc, pen, ids, changes: () => changes }
}
// one connected drawing of 161 pieces: a circle, 64 petals of two arcs, 32 spokes
function ring(): SketchDoc {
  const d: SketchDoc = { entities: [], constraints: [] }
  const O = addPoint(d, 0, 0); addCircle(d, O, 10)
  for (let k = 0; k < 64; k++) {
    const a0 = (k / 64) * Math.PI * 2, a1 = ((k + 2) / 64) * Math.PI * 2, am = (a0 + a1) / 2
    const s = addPoint(d, 10 * Math.cos(a0), 10 * Math.sin(a0)), e = addPoint(d, 10 * Math.cos(a1), 10 * Math.sin(a1))
    addPath(d, [s, e], [
      { kind: 'arc', center: addPoint(d, 9 * Math.cos(am), 9 * Math.sin(am)), sweep: 1 },
      { kind: 'arc', center: addPoint(d, 14 * Math.cos(am), 14 * Math.sin(am)), sweep: 1 },
    ], true)
    if (k % 2 === 0) addLine(d, O, s)
  }
  return d
}
describe('the pen’s Fill tool', () => {
  it('hover shows the area, click fills it as one step, click again empties it; undo / redo', () => {
    const { doc, pen, changes } = penWithSquare()
    expect(pen.options.tools).toContain('fill')
    pen.selectTool('fill')
    pen.fillMove(2, 2)
    expect(pen.fillHover.value?.filled).toBe(false)
    expect(pen.fillHover.value?.d).toMatch(/^M .* Z$/)
    const c0 = changes()
    pen.fillClick(2, 2)
    expect(changes()).toBe(c0 + 1)
    expect(doc.value.fills?.length).toBe(1)
    expect(doc.value.fillGap).toBeCloseTo(6 / 34, 9)
    expect(pen.status.value).toBe('Filled')
    expect(pen.fillView().filled).toBe(1)
    expect(pen.fillHover.value?.filled).toBe(true)
    pen.fillClick(2, 2)
    expect(doc.value.fills).toBeUndefined()
    expect(doc.value.fillGap).toBeUndefined()
    expect(pen.status.value).toBe('Emptied')
    pen.undo(); expect(pen.fillView().filled).toBe(1)
    expect(pen.fillHover.value).toBeNull()   // undo clears the hover
    pen.redo(); expect(pen.fillView().filled).toBe(0)
    const c1 = changes()
    pen.fillClick(9, 9); expect(pen.status.value).toBe(FILL_MISS)
    expect(changes()).toBe(c1)
    pen.fillMove(9, 9); expect(pen.fillHover.value).toBeNull()
  })
  it('the hover replaces its value only when the area or its state changes', () => {
    const { pen } = penWithSquare()
    pen.selectTool('fill')
    pen.fillMove(2, 2)
    const first = pen.fillHover.value
    pen.fillMove(3, 4)
    expect(pen.fillHover.value).toBe(first)
  })
  it('Fill does nothing outside its tool, and a Clean up preview blocks it', () => {
    const { doc, pen } = penWithSquare()
    pen.fillClick(2, 2); pen.fillMove(2, 2)
    expect(doc.value.fills).toBeUndefined()
    expect(pen.fillHover.value).toBeNull()
    pen.selectTool('fill')
    pen.toggleCleanup()
    expect(pen.cleanup.value).not.toBeNull()
    pen.fillMove(2, 2); pen.fillClick(2, 2)
    expect(doc.value.fills).toBeUndefined()
    expect(pen.fillHover.value).toBeNull()
  })
  it('a line drawn across a filled area fills both halves when it settles; undo takes both back', () => {
    const { doc, pen } = penWithSquare()
    pen.selectTool('fill'); pen.fillClick(2, 2)
    pen.selectTool('line')
    pen.place(3, 0); pen.place(3, 6)
    expect(pen.fillView().filled).toBe(2)
    expect(doc.value.fills!.length).toBe(2)
    pen.undo()
    expect(pen.fillView().filled).toBe(1)
  })
  it('G picks the Fill tool; a text-guide pen offers no Fill', () => {
    const { pen } = penWithSquare()
    const ev = { key: 'g', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} } as any
    expect(pen.onKeydown(ev)).toBe(true)
    expect(pen.tool.value).toBe('fill')
    const g = penWithSquare({ openOnly: true })
    expect(g.pen.options.tools).not.toContain('fill')
    expect(g.pen.onKeydown(ev)).toBe(false)
    g.pen.selectTool('fill')
    expect(g.pen.tool.value).not.toBe('fill')
  })
  it('Flip keeps a filled shape filled', () => {
    const { doc, pen } = penWithSquare()
    pen.selectTool('fill'); pen.fillClick(2, 2)
    pen.selectTool('select')
    const path = doc.value.entities.find(e => e.kind === 'path')!
    pen.pick(path.id, false)
    pen.flip('h')
    expect(pen.fillView().filled).toBe(1)
    expect(doc.value.fills!.length).toBe(1)
  })
  it('Flip keeps a filled circle filled', () => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const c = addPoint(doc.value, 3, 3); const cid = addCircle(doc.value, c, 2)
    const pen = usePen({ doc, view: ref(DEV) })
    pen.selectTool('fill'); pen.fillClick(3.5, 3)
    const t0 = doc.value.fills![0]!.seed.t
    pen.selectTool('select'); pen.pick(cid, false); pen.flip('h')
    // a circle seed turns with the flip: angle θ → π − θ
    expect(doc.value.fills![0]!.seed.t).toBeCloseTo((((0.5 - t0) % 1) + 1) % 1, 12)
    expect(pen.fillView().filled).toBe(1)
  })
  it('the Fill hover stays cheap on one connected drawing of 161 pieces', () => {
    const doc = ref<SketchDoc>(ring())
    const pen = usePen({ doc, view: ref({ a: 20, b: 0, c: 0, d: -20, e: 300, f: 300 }) })
    pen.selectTool('fill')
    pen.fillClick(3, 1)
    expect(pen.fillView().filled).toBe(1)
    pen.fillMove(3, 1.1)   // warm
    const t = performance.now()
    for (let i = 0; i < 50; i++) pen.fillMove(3 + Math.cos(i) * 5, 1 + Math.sin(i) * 5)
    expect((performance.now() - t) / 50).toBeLessThan(2)
  })
  it('the settle stays within 20 ms on one connected drawing of 161 pieces', () => {
    const view = ref({ a: 20, b: 0, c: 0, d: -20, e: 300, f: 300 })
    const doc = ref<SketchDoc>(ring())
    const pen = usePen({ doc, view })
    pen.selectTool('fill'); pen.fillClick(3, 1); pen.fillClick(-3, -1)
    expect(pen.fillView().filled).toBe(2)
    const plain = ref<SketchDoc>(ring())
    const penPlain = usePen({ doc: plain, view })
    // one step each: a point on the ring moves a hair, then the step settles
    const step = (d: SketchDoc, p: ReturnType<typeof usePen>, dx: number) => {
      const pt = d.entities.find(e => e.kind === 'point' && Math.abs(Math.abs((e as any).x) - 10) < 0.1 && Math.abs((e as any).y) < 1e-9) as any
      pt.x += dx
      const t = performance.now(); p.commitHistory(); return performance.now() - t
    }
    step(doc.value, pen, 0.001); step(plain.value, penPlain, 0.001)   // warm
    // the settle's share: a step with fills less the same step without; the
    // median of seven, so one garbage collection on a loaded machine can't decide it
    const extra: number[] = []
    for (let i = 0; i < 7; i++) {
      const dx = i % 2 ? 0.001 : -0.001
      extra.push(step(doc.value, pen, dx) - step(plain.value, penPlain, dx))
    }
    extra.sort((x, y) => x - y)
    expect(doc.value.fills!.length).toBe(2)
    expect(pen.fillView().filled).toBe(2)
    expect(extra[3]!).toBeLessThan(20)
  })
  it('a drawing with no fills does no face work at commit', () => {
    const { doc, pen } = penWithSquare()
    pen.selectTool('line'); pen.place(7, 0); pen.place(7, 6)
    expect(doc.value.fills).toBeUndefined()
    expect(pen.fillView()).toEqual({ d: '', gaps: [], filled: 0, asleep: 0 })
  })
  it('a text-guide pen pastes a copy without its fills', () => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const q = [[1, 1], [5, 1], [5, 5], [1, 5]].map(([x, y]) => addPoint(doc.value, x!, y!))
    for (let i = 0; i < 4; i++) addLine(doc.value, q[i]!, q[(i + 1) % 4]!)
    const src = usePen({ doc, view: ref(DEV) })
    src.selectTool('fill'); src.fillClick(2, 2)
    expect(doc.value.fills?.length).toBe(1)
    src.selectTool('select'); src.selectAll(); expect(src.copySelection()).toBe(true)
    const g = penWithSquare({ openOnly: true })
    g.doc.value.entities = []   // an empty guide
    expect(g.pen.paste()).toBe(true)
    expect(g.doc.value.entities.some(e => e.kind === 'line')).toBe(true)
    expect(g.doc.value.fills).toBeUndefined()
    expect(g.doc.value.fillGap).toBeUndefined()
    // the same copy into a pen that can fill keeps its fill
    const f = penWithSquare()
    f.pen.paste()
    expect(f.doc.value.fills?.length).toBe(1)
  })
})
