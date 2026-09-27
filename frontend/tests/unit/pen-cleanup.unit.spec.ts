// tests/unit/pen-cleanup.unit.spec.ts
// Pen stage 5, Clean up in the shared pen: the preview never touches the
// drawing, Apply is one undo step, switches and strength re-solve from the
// drawing as it was, the pen owns the keys while previewing, a selection
// scopes it, live gestures settle first, anything that ends the session drops
// the preview, and a host can turn it off.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addPath } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk(build: (d: SketchDoc) => void = () => {}, options?: any) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  const view = ref({ ...DEV })
  const pen = usePen({ doc, view, options })
  return { doc, pen, view }
}
const key = (k: string, o: Record<string, unknown> = {}) =>
  ({ key: k, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {}, stopPropagation() {}, ...o }) as unknown as KeyboardEvent
const CLEAN_UP = { code: 'KeyC', altKey: true, shiftKey: true }   // ⌥⇧C types "Ç" on a Mac
const paths = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path') as any[]
const rad = (deg: number) => deg * Math.PI / 180
function lineAt(d: SketchDoc, x: number, y: number, deg: number, len: number) {
  const a = addPoint(d, x, y), b = addPoint(d, x + len * Math.cos(rad(deg)), y + len * Math.sin(rad(deg)))
  return { a, b, id: addLine(d, a, b) }
}
function flower(d: SketchDoc): void {
  const C: [number, number][] = [[6, 2], [12, 2], [12, 8], [6, 8]]
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const ex = x1 + 0.08, ey = y1 + 0.05
    const s = addPoint(d, x0, y0), e = addPoint(d, ex, ey), c = addPoint(d, (x0 + ex) / 2, (y0 + ey) / 2)
    addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
  }
}

describe('Clean up in the pen', () => {
  it('previews without touching the drawing; Apply is one undo step', () => {
    const { doc, pen } = mk(flower)
    expect(pen.options.cleanup).toBe(true)
    const before = JSON.stringify(doc.value)
    pen.startCleanup()
    expect(pen.cleanup.value!.strength).toBe('normal')
    expect(pen.cleanup.value!.result.fixes.filter(f => f.kind === 'join')).toHaveLength(4)
    expect(JSON.stringify(doc.value)).toBe(before)
    expect(pen.canUndo()).toBe(false)
    pen.applyCleanup()
    expect(pen.cleanup.value).toBeNull()
    expect(paths(doc.value)).toHaveLength(1)
    expect(paths(doc.value)[0].closed).toBe(true)
    expect(pen.sparkleCount()).toBeGreaterThan(0)
    expect(pen.status.value).toMatch(/^Cleaned up · \d+ changes?$/)
    pen.undo()
    expect(JSON.stringify(doc.value)).toBe(before)
    expect(pen.canUndo()).toBe(false)
  })
  it('a switched-off fix is left out; switching it back gives the first answer again', () => {
    const { pen } = mk(flower)
    pen.startCleanup()
    const first = JSON.stringify(pen.cleanup.value!.result)
    const id = pen.cleanup.value!.result.fixes.find(f => f.kind === 'join')!.id
    pen.toggleCleanupFix(id)
    const r = pen.cleanup.value!.result
    expect(r.fixes.find(f => f.id === id)!.on).toBe(false)
    expect(paths(r.doc)[0].closed).toBe(false)
    pen.toggleCleanupFix(id)
    expect(JSON.stringify(pen.cleanup.value!.result)).toBe(first)
  })
  it('a collapsed kind switches all its fixes together', () => {
    const { pen } = mk(flower)
    pen.startCleanup()
    pen.toggleCleanupKind('join')
    expect(pen.cleanup.value!.result.fixes.filter(f => f.kind === 'join').every(f => !f.on)).toBe(true)
    expect(paths(pen.cleanup.value!.result.doc)).toHaveLength(4)
    pen.toggleCleanupKind('join')
    expect(pen.cleanup.value!.result.fixes.filter(f => f.kind === 'join').every(f => f.on)).toBe(true)
  })
  it('⌥⇧C opens it and Escape closes it with no step; the pen owns the keys meanwhile', () => {
    const { doc, pen } = mk(flower)
    const before = JSON.stringify(doc.value)
    expect(pen.onKeydown(key('Ç', CLEAN_UP))).toBe(true)
    expect(pen.cleanup.value).not.toBeNull()
    expect(pen.onKeydown(key('p'))).toBe(true)                      // swallowed: no tool change
    expect(pen.tool.value).toBe('select')
    expect(pen.onKeydown(key('Shift'))).toBe(false)
    expect(pen.onKeydown(key('s', { metaKey: true }))).toBe(false)  // other ⌘ keys stay the host's
    expect(pen.onKeydown(key('Escape'))).toBe(true)
    expect(pen.cleanup.value).toBeNull()
    expect(pen.status.value).toBe('Clean up cancelled')
    expect(JSON.stringify(doc.value)).toBe(before)
    expect(pen.canUndo()).toBe(false)
  })
  it('⌥⇧C again cancels; Enter applies; ⌘Z while previewing only closes the preview', () => {
    const { doc, pen } = mk(flower)
    pen.onKeydown(key('Ç', CLEAN_UP))
    expect(pen.onKeydown(key('Ç', CLEAN_UP))).toBe(true)
    expect(pen.cleanup.value).toBeNull()
    pen.onKeydown(key('Ç', CLEAN_UP))
    expect(pen.onKeydown(key('z', { metaKey: true }))).toBe(true)
    expect(pen.cleanup.value).toBeNull()
    expect(paths(doc.value)).toHaveLength(4)
    pen.onKeydown(key('Ç', CLEAN_UP))
    expect(pen.onKeydown(key('Enter'))).toBe(true)
    expect(paths(doc.value)).toHaveLength(1)
  })
  it('strength re-solves: a 6° line is levelled only at Strong', () => {
    const { pen } = mk(d => { lineAt(d, 2, 2, 6, 8) })
    pen.startCleanup()
    const hv = () => pen.cleanup.value!.result.fixes.filter(f => f.kind === 'horizontal')
    expect(hv()).toHaveLength(0)
    pen.setCleanupStrength('strong')
    expect(pen.cleanup.value!.strength).toBe('strong')
    expect(hv()).toHaveLength(1)
    pen.setCleanupStrength('gentle')
    expect(hv()).toHaveLength(0)
  })
  it('works on the selection only, and leaves the rest where it was', () => {
    let l1 = { a: '', b: '', id: '' }, l2 = { a: '', b: '', id: '' }
    const { doc, pen } = mk(d => { l1 = lineAt(d, 0, 0, 2, 8); l2 = lineAt(d, 0, 5, 2, 8) })
    const at = (id: EntityId) => { const p = doc.value.entities.find(e => e.id === id) as any; return { x: p.x, y: p.y } }
    const keep = [at(l2.a), at(l2.b)]
    pen.pick(l1.id)
    pen.startCleanup()
    expect(pen.cleanup.value!.scope).toEqual({ entities: [l1.id], segments: [] })
    expect(pen.cleanup.value!.result.fixes.filter(f => f.kind === 'horizontal')).toHaveLength(1)
    pen.applyCleanup()
    expect([at(l2.a), at(l2.b)]).toEqual(keep)
    expect(pen.selection.value).toEqual([])
  })
  it('a half-drawn path is finished before Clean up looks', () => {
    const { doc, pen } = mk()
    pen.selectTool('path')
    pen.pathDown(0, 0); pen.pathUp(0, 0)
    pen.pathDown(4, 0.1); pen.pathUp(4, 0.1)
    pen.startCleanup()
    expect(pen.pendingPath.value).toBeNull()
    expect(paths(doc.value)).toHaveLength(1)
    expect(pen.cleanup.value).not.toBeNull()
  })
  it('a tool change, undo and finishSession drop the preview', () => {
    const { pen } = mk(flower)
    pen.startCleanup(); pen.selectTool('line')
    expect(pen.cleanup.value).toBeNull()
    pen.startCleanup(); pen.undo()
    expect(pen.cleanup.value).toBeNull()
    pen.startCleanup(); pen.finishSession()
    expect(pen.cleanup.value).toBeNull()
  })
  it('PenOptions.cleanup false: no Clean up, and ⌥⇧C is not the pen’s', () => {
    const { pen } = mk(flower, { cleanup: false })
    expect(pen.options.cleanup).toBe(false)
    pen.toggleCleanup()
    expect(pen.cleanup.value).toBeNull()
    expect(pen.onKeydown(key('Ç', CLEAN_UP))).toBe(false)
  })
  it('⌘Z or a direct undo / redo while previewing only closes the preview — no step back', () => {
    const { doc, pen } = mk(flower)
    addPoint(doc.value, 100, 100); pen.commitHistory()   // one committed edit to step back over
    expect(pen.canUndo()).toBe(true)
    const edited = JSON.stringify(doc.value)
    pen.startCleanup()
    expect(pen.onKeydown(key('z', { metaKey: true }))).toBe(true)
    expect(pen.cleanup.value).toBeNull()
    expect(pen.canUndo()).toBe(true)
    expect(JSON.stringify(doc.value)).toBe(edited)
    for (const step of ['undo', 'redo'] as const) {
      pen.startCleanup()
      pen[step]()
      expect(pen.cleanup.value).toBeNull()
      expect(pen.status.value).toBe('Clean up cancelled')
      expect(pen.canUndo()).toBe(true)
      expect(JSON.stringify(doc.value)).toBe(edited)
    }
    pen.undo()                                             // with no preview, undo steps back as ever
    expect(pen.canUndo()).toBe(false)
  })
  it('Tab, and Space on a focused control, reach the strength / Apply / Cancel row', () => {
    const { pen } = mk(flower)
    pen.startCleanup()
    let prevented = 0
    const tab = key('Tab', { preventDefault() { prevented++ } })
    expect(pen.onKeydown(tab)).toBe(false)
    expect(pen.onKeydown(key('Tab', { shiftKey: true, preventDefault() { prevented++ } }))).toBe(false)
    const button = { closest: (sel: string) => (sel.includes('button') ? button : null) }
    expect(pen.onKeydown(key(' ', { target: button, preventDefault() { prevented++ } }))).toBe(false)
    expect(prevented).toBe(0)
    expect(pen.onKeydown(key(' '))).toBe(true)             // Space with nothing focused is swallowed
    expect(pen.cleanup.value).not.toBeNull()
    expect(pen.onKeydown(key('Enter', { target: button }))).toBe(true)   // Enter still applies
    expect(pen.cleanup.value).toBeNull()
  })
  it('Enter on a focused Cancel button cancels; Enter on any other focused toolbar button applies', () => {
    const { doc, pen } = mk(flower)
    const before = JSON.stringify(doc.value)
    const cancelBtn = { closest: (sel: string) => (sel === '[data-act="cleanup-cancel"]' ? cancelBtn : null) }
    const applyBtn = { closest: (sel: string) => (sel.includes('button') ? applyBtn : null) }
    pen.startCleanup()
    expect(pen.onKeydown(key('Enter', { target: cancelBtn }))).toBe(true)
    expect(pen.cleanup.value).toBeNull()
    expect(pen.status.value).toBe('Clean up cancelled')
    expect(JSON.stringify(doc.value)).toBe(before)
    pen.startCleanup()
    expect(pen.onKeydown(key('Enter', { target: applyBtn }))).toBe(true)   // a different toolbar button: still applies
    expect(pen.cleanup.value).toBeNull()
    expect(paths(doc.value)).toHaveLength(1)
  })
  it.each(['redo', 'reset', 'revert', 'endGesture', 'dispose'] as const)('%s drops the preview', (end) => {
    const { pen } = mk(flower)
    pen.startCleanup()
    expect(pen.cleanup.value).not.toBeNull()
    pen[end]()
    expect(pen.cleanup.value).toBeNull()
  })
  it('Apply with every fix switched off writes no step', () => {
    const { doc, pen } = mk(flower)
    const before = JSON.stringify(doc.value)
    pen.startCleanup()
    // switching a fix off can let others be found, so repeat until none is on
    for (let round = 0; round < 20; round++) {
      const on = pen.cleanup.value!.result.fixes.find(f => f.on)
      if (!on) break
      pen.toggleCleanupFix(on.id)
    }
    expect(pen.cleanup.value!.result.fixes.every(f => !f.on)).toBe(true)
    pen.applyCleanup()
    expect(pen.cleanup.value).toBeNull()
    expect(pen.canUndo()).toBe(false)
    expect(JSON.stringify(doc.value)).toBe(before)
  })
  it('tolerances stay at the zoom Clean up opened at', () => {
    const { pen, view } = mk(flower)
    pen.startCleanup()
    const ids = pen.cleanup.value!.result.fixes.map(f => f.id).sort()
    expect(ids.filter(id => id.startsWith('join'))).toHaveLength(4)
    view.value = { ...DEV, a: 340, d: -340 }               // zoom in 10×: the gaps would be ~30 px now
    pen.toggleCleanupFix(ids[0]!)                           // a fresh solve, not a memo hit
    expect(pen.cleanup.value!.result.fixes.map(f => f.id).sort()).toEqual(ids)
    expect(pen.cleanup.value!.unitsPerPx).toBeCloseTo(1 / 34)
  })
  it('switching back and forth is memoised for the session; a new session starts afresh', () => {
    const { pen } = mk(flower)
    pen.startCleanup()
    const first = pen.cleanup.value!.result
    const id = first.fixes.find(f => f.kind === 'join')!.id
    pen.toggleCleanupFix(id)
    const offOnce = pen.cleanup.value!.result
    pen.toggleCleanupFix(id)
    expect(pen.cleanup.value!.result).toBe(first)        // same object: no re-solve
    pen.toggleCleanupFix(id)
    expect(pen.cleanup.value!.result).toBe(offOnce)
    pen.setCleanupStrength('strong'); pen.setCleanupStrength('normal')
    expect(pen.cleanup.value!.result).toBe(offOnce)
    pen.cancelCleanup()
    pen.startCleanup()
    expect(pen.cleanup.value!.result).not.toBe(first)    // the cache died with the session
    expect(pen.cleanup.value!.result.fixes.every(f => f.on)).toBe(true)
  })
})
