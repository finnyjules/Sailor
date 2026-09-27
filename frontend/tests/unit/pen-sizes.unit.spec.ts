// tests/unit/pen-sizes.unit.spec.ts
// Pen stage 6, the Properties panel's sizes: what is measured for a point, a
// line, an arc and a circle; a typed size moves the drawing as one step,
// rules permitting (refused otherwise, nothing changed); the radius lock is
// the arc's pin / the circle's radius rule; angles read as on screen.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'
import { sizeTargetFor, measureSizes, screenAngleDeg, checkSizeEdit, SIZE_REFUSED } from '~/lib/sketch/sizes'
import { cloneDoc } from '~/lib/sketch/clone'
import { pxToUnits } from '~/lib/sketch/tolerance'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }   // y up on screen
function mk(build: (d: SketchDoc) => void) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  return { doc, pen: usePen({ doc, view: ref(DEV) }) }
}
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any
const dist = (d: SketchDoc, a: string, b: string) => Math.hypot(P(d, a).x - P(d, b).x, P(d, a).y - P(d, b).y)

describe('what is measured', () => {
  it('a point, a line, a quarter arc (as a segment or a one-piece path), a circle', () => {
    let a = '', b = '', l = '', s = '', e = '', c = '', arc = '', circle = ''
    const { doc } = mk(d => {
      a = addPoint(d, 1, 1); b = addPoint(d, 4, 5); l = addLine(d, a, b)
      s = addPoint(d, 10, 0); e = addPoint(d, 12, 2); c = addPoint(d, 12, 0)
      arc = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 0 }])
      circle = addCircle(d, addPoint(d, 20, 0), 1.5)
    })
    const m = (sel: string[], segs: any[] = []) => measureSizes(doc.value, sizeTargetFor(doc.value, sel, segs)!, DEV)
    expect(m([a])).toMatchObject({ x: 1, y: 1, fixed: false })
    expect(m([l]).length).toBeCloseTo(5, 9)
    expect(m([l]).angle).toBeCloseTo(Math.atan2(4, 3) * 180 / Math.PI, 9)
    const q = m([], [{ pathId: arc, segIndex: 0 }])   // (10,0) → (12,2) clockwise round (12,0): a quarter
    expect(q.radius).toBeCloseTo(2, 9); expect(q.sweep).toBeCloseTo(90, 6); expect(q.length).toBeCloseTo(Math.PI, 6)
    expect(q.locked).toBe(false)
    expect(m([arc]).radius).toBeCloseTo(2, 9)
    expect(m([circle])).toMatchObject({ radius: 1.5, locked: false })
    expect(sizeTargetFor(doc.value, [a, b], [])).toBeNull()
  })
  it('reads angles as on screen, whichever way the view is mirrored', () => {
    const flipped = { a: 10, b: 0, c: 0, d: 10, e: 0, f: 0 }   // y down on screen
    expect(screenAngleDeg(DEV, { x: 0, y: 1 })).toBeCloseTo(90, 9)
    expect(screenAngleDeg(flipped, { x: 0, y: 1 })).toBeCloseTo(-90, 9)
  })
})

describe('typed sizes', () => {
  it('a point moves to the typed spot as one step; a fixed one refuses', () => {
    let a = '', f = ''
    const { doc, pen } = mk(d => { a = addPoint(d, 1, 1); f = addPoint(d, 3, 3, { fixed: true }) })
    expect(pen.setPointXY(a, 2.5, -1)).toBe(true)
    expect(P(doc.value, a)).toMatchObject({ x: 2.5, y: -1 })
    expect(pen.setPointXY(f, 0, 0)).toBe(false)
    expect(P(doc.value, f)).toMatchObject({ x: 3, y: 3 })
    pen.undo()
    expect(P(doc.value, a)).toMatchObject({ x: 1, y: 1 })
  })
  it('a line’s length keeps its first end; its angle turns it on screen', () => {
    let a = '', b = ''
    const { doc, pen } = mk(d => { a = addPoint(d, 0, 0); b = addPoint(d, 3, 4); addLine(d, a, b) })
    pen.setLineLength(a, b, 10)
    expect(P(doc.value, a)).toMatchObject({ x: 0, y: 0 })
    expect(dist(doc.value, a, b)).toBeCloseTo(10, 6)
    pen.setLineAngle(a, b, 90)
    expect(P(doc.value, b).x).toBeCloseTo(0, 6)
    expect(P(doc.value, b).y).toBeCloseTo(10, 6)
  })
  it('a size the rules can’t keep is refused and nothing moves', () => {
    let a = '', b = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0, { fixed: true }); b = addPoint(d, 4, 0); addLine(d, a, b)
      addConstraint(d, 'distance', [a, b], 4)
    })
    expect(pen.setLineLength(a, b, 7)).toBe(false)
    expect(pen.status.value).toBe(SIZE_REFUSED)
    expect(P(doc.value, b)).toMatchObject({ x: 4, y: 0 })
    expect(pen.canUndo()).toBe(false)
  })
  it('a size the rules meet only by moving the other end is refused too (the typed size would be lost)', () => {
    let a = '', b = '', l = ''
    const { doc, pen } = mk(d => { a = addPoint(d, 0, 0); b = addPoint(d, 4, 0); l = addLine(d, a, b); addConstraint(d, 'horizontal', [l]) })
    expect(pen.setLineAngle(a, b, 45)).toBe(false)
    expect(pen.status.value).toBe(SIZE_REFUSED)
    expect(P(doc.value, a)).toMatchObject({ x: 0, y: 0 })
    expect(P(doc.value, b)).toMatchObject({ x: 4, y: 0 })
    expect(pen.setLineLength(a, b, 6)).toBe(true)   // along itself: level still
    expect(P(doc.value, b).x).toBeCloseTo(6, 6)
  })
  it('a line whose second end is fixed moves its first end instead', () => {
    let a = '', b = ''
    const { doc, pen } = mk(d => { a = addPoint(d, 0, 0); b = addPoint(d, 4, 0, { fixed: true }); addLine(d, a, b) })
    expect(pen.setLineLength(a, b, 10)).toBe(true)
    expect(P(doc.value, b)).toMatchObject({ x: 4, y: 0 })
    expect(P(doc.value, a).x).toBeCloseTo(-6, 6)
  })
  it('an arc: a one-off radius leaves no rule; the lock pins it and a typed radius moves the pin', () => {
    let arc = '', s = '', c = ''
    const { doc, pen } = mk(d => {
      s = addPoint(d, 10, 0); const e = addPoint(d, 12, 2); c = addPoint(d, 12, 0)
      arc = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 0 }])
    })
    const rules = doc.value.constraints.length
    expect(pen.setArcRadiusValue(arc, 0, 3)).toBe(true)
    expect(dist(doc.value, c, s)).toBeCloseTo(3, 5)
    expect(doc.value.constraints.length).toBe(rules)
    pen.toggleArcRadiusLock(arc, 0)
    const pin = doc.value.constraints.find(k => k.kind === 'distance')!
    expect(pin.value).toBeCloseTo(3, 5)
    pen.setArcRadiusValue(arc, 0, 4)
    expect(doc.value.constraints.find(k => k.id === pin.id)!.value).toBe(4)
    expect(dist(doc.value, c, s)).toBeCloseTo(4, 5)
    pen.toggleArcRadiusLock(arc, 0)
    expect(doc.value.constraints.some(k => k.kind === 'distance')).toBe(false)
  })
  it('an arc’s sweep and length move its end round the centre', () => {
    let arc = '', e = '', c = ''
    const { doc, pen } = mk(d => {
      const s = addPoint(d, 10, 0); e = addPoint(d, 12, -2); c = addPoint(d, 12, 0)
      arc = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])   // 90°, counter-clockwise (π → 3π/2)
    })
    pen.setArcSweep(arc, 0, 180)
    expect(P(doc.value, e).x).toBeCloseTo(14, 5); expect(P(doc.value, e).y).toBeCloseTo(0, 5)
    pen.setArcLength(arc, 0, Math.PI)       // r = 2 → 90°
    expect(P(doc.value, e).x).toBeCloseTo(12, 5); expect(P(doc.value, e).y).toBeCloseTo(-2, 5)
  })
  it('a circle: one-off radius, then the lock', () => {
    let c = ''
    const { doc, pen } = mk(d => { c = addCircle(d, addPoint(d, 0, 0), 1) })
    pen.setCircleRadius(c, 2)
    expect(P(doc.value, c).r).toBeCloseTo(2, 6)
    expect(doc.value.constraints).toHaveLength(0)
    pen.toggleCircleRadiusLock(c)
    expect(doc.value.constraints[0]).toMatchObject({ kind: 'radius', refs: [c], value: 2 })
    pen.setCircleRadius(c, 3)
    expect(doc.value.constraints[0]!.value).toBe(3)
  })
  it('the hover highlight is view state only', () => {
    let l = ''
    const { pen } = mk(d => { l = addLine(d, addPoint(d, 0, 0), addPoint(d, 1, 0)) })
    pen.setHighlight([{ kind: 'line', id: l }])
    expect(pen.highlight.value).toEqual([{ kind: 'line', id: l }])
    expect(pen.canUndo()).toBe(false)
  })
})

// a zigzag of 150 straight pieces in one path, a few lengths pinned, some
// pieces levelled — one connected drawing
function bigDrawing(pinned: number[] = []): { d: SketchDoc; P: EntityId; pts: EntityId[] } {
  const d: SketchDoc = { entities: [], constraints: [] }
  const pts: EntityId[] = []
  for (let i = 0; i <= 150; i++) pts.push(addPoint(d, i * 2, (i % 2) * 1.5))   // every rule holds as drawn
  const P = addPath(d, pts, pts.slice(1).map(() => ({ kind: 'line' as const })))
  for (const i of [...pinned, 10, 30, 110]) addConstraint(d, 'distance', [pts[i]!, pts[i + 1]!], dist(d, pts[i]!, pts[i + 1]!))
  for (let i = 0; i < 150; i += 10) addConstraint(d, 'horizontal', [pts[i]!, pts[i + 2]!])
  return { d, P, pts }
}
// a rigid strip of `n` triangles (every piece's length and every second
// point's distance pinned), free to turn and slide only as a whole
function rigidStrip(n: number): { d: SketchDoc; pts: EntityId[] } {
  const d: SketchDoc = { entities: [], constraints: [] }
  const pts: EntityId[] = []
  for (let i = 0; i <= n; i++) pts.push(addPoint(d, i * 2, (i % 2) * 1.5))
  addPath(d, pts, pts.slice(1).map(() => ({ kind: 'line' as const })))
  for (let i = 0; i < n; i++) addConstraint(d, 'distance', [pts[i]!, pts[i + 1]!], dist(d, pts[i]!, pts[i + 1]!))
  for (let i = 0; i < n - 1; i++) addConstraint(d, 'distance', [pts[i]!, pts[i + 2]!], dist(d, pts[i]!, pts[i + 2]!))
  return { d, pts }
}
function best(n: number, f: () => void): number {
  let m = Infinity
  for (let k = 0; k < n; k++) { const t0 = performance.now(); f(); m = Math.min(m, performance.now() - t0) }
  return m
}
// the check for dragging b of a–b so the piece runs `len` along itself
function lengthCheck(d: SketchDoc, a: EntityId, b: EntityId, len: number) {
  const A = P(d, a), B = P(d, b), n = dist(d, a, b)
  const to = { x: A.x + (B.x - A.x) / n * len, y: A.y + (B.y - A.y) / n * len }
  return checkSizeEdit(d, {
    fresh: () => { const t = cloneDoc(d); const q = P(t, b); q.x = to.x; q.y = to.y; return t },
    seeds: [b], held: new Set([b]), unitsPerPx: pxToUnits(1, DEV), own: [a, b], stay: [a],
  })
}

describe('the check a typed size runs first (stage-5 lesson)', () => {
  it('takes under 100 ms on a 150-piece connected drawing, and never solves it whole', () => {
    const { d, pts } = bigDrawing([75])
    const before = JSON.stringify(d)
    let r = ''
    // a free piece: its window settles
    const free = best(3, () => { r = lengthCheck(d, pts[60]!, pts[61]!, 3) })
    expect(r).toBe('ok')
    expect(free).toBeLessThan(100)
    // a pinned piece: every window fails and the part is too big to solve
    // whole — the slowest path; not certain, so unsure (never a guess)
    const pinned = best(3, () => { r = lengthCheck(d, pts[75]!, pts[76]!, 9) })
    expect(r).toBe('unsure')
    expect(pinned).toBeLessThan(100)
    expect(JSON.stringify(d)).toBe(before)
  })
  it('refuses only when the window holds the whole part', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0, { fixed: true }), b = addPoint(d, 4, 0)
    addLine(d, a, b)
    addConstraint(d, 'distance', [a, b], 4)
    expect(lengthCheck(d, a, b, 7)).toBe('refuse')
    expect(lengthCheck(d, a, b, 4)).toBe('ok')
  })
  it('a typed size on a big drawing is one step through the pen', () => {
    const { d, pts } = bigDrawing()
    const doc = ref<SketchDoc>(d)
    const pen = usePen({ doc, view: ref(DEV) })
    expect(pen.setLineLength(pts[60]!, pts[61]!, 3)).toBe(true)
    expect(dist(doc.value, pts[60]!, pts[61]!)).toBeCloseTo(3, 5)
    pen.undo()
    expect(pen.canUndo()).toBe(false)
  })
})

describe('never refuse on a guess', () => {
  it('an uncertain size the whole drawing can keep goes through the pen’s normal solve', () => {
    const { d, pts } = rigidStrip(40)   // 80 free scalars: too big to solve whole in the check
    const doc = ref<SketchDoc>(d)
    const pen = usePen({ doc, view: ref(DEV) })
    const len = dist(doc.value, pts[0]!, pts[40]!)
    // moving one end of a rigid strip moves the whole strip: no window can
    expect(pen.setPointXY(pts[0]!, -3, 2)).toBe(true)
    expect(P(doc.value, pts[0]!)).toMatchObject({ x: -3, y: 2 })
    expect(dist(doc.value, pts[0]!, pts[40]!)).toBeCloseTo(len, 4)
    pen.undo()
    expect(P(doc.value, pts[0]!)).toMatchObject({ x: 0, y: 0 })
  })
  it('an uncertain size the normal solve can’t keep is rolled back, no step', () => {
    const { d, pts } = rigidStrip(40)
    const doc = ref<SketchDoc>(d)
    const pen = usePen({ doc, view: ref(DEV) })
    const before = JSON.stringify(doc.value)
    expect(pen.setLineLength(pts[20]!, pts[21]!, 9)).toBe(false)
    expect(pen.status.value).toBe(SIZE_REFUSED)
    expect(JSON.stringify(doc.value)).toBe(before)
    expect(pen.canUndo()).toBe(false)
  })
})

describe('fix round 1', () => {
  it('a refused or rolled-back size signals nothing; a kept one settles once', () => {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const d = doc.value
    const a = addPoint(d, 0, 0, { fixed: true }), b = addPoint(d, 4, 0), q = addPoint(d, 9, 9)
    addLine(d, a, b)
    addConstraint(d, 'distance', [a, b], 4)
    let live = 0, settled = 0
    const pen = usePen({ doc, view: ref(DEV), onChange: () => settled++, onLiveChange: () => live++ })
    expect(pen.setLineLength(a, b, 7)).toBe(false)          // refused by the check
    expect([live, settled]).toEqual([0, 0])
    const strip = rigidStrip(40)                                // refused only after the normal solve
    const doc2 = ref<SketchDoc>(strip.d)
    let live2 = 0, settled2 = 0
    const pen2 = usePen({ doc: doc2, view: ref(DEV), onChange: () => settled2++, onLiveChange: () => live2++ })
    expect(pen2.setLineLength(strip.pts[20]!, strip.pts[21]!, 9)).toBe(false)
    expect([live2, settled2]).toEqual([0, 0])
    expect(pen.setPointXY(q, 1, 2)).toBe(true)
    expect([live, settled]).toEqual([0, 1])
  })
  it('keeps the other end and moves what the rules let move (a pinned triangle)', () => {
    let a = '', b = '', c = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); b = addPoint(d, 4, 0); c = addPoint(d, 2, 2)
      addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
      addConstraint(d, 'distance', [a, c], Math.hypot(2, 2))
      addConstraint(d, 'distance', [b, c], Math.hypot(2, 2))
    })
    expect(pen.setLineLength(a, b, 3.5)).toBe(true)
    expect(P(doc.value, a)).toMatchObject({ x: 0, y: 0 })
    expect(dist(doc.value, a, b)).toBeCloseTo(3.5, 5)
    expect(dist(doc.value, a, c)).toBeCloseTo(Math.hypot(2, 2), 5)
    expect(dist(doc.value, b, c)).toBeCloseTo(Math.hypot(2, 2), 5)
  })
  it('says why: a fixed arc end, a line with no direction; measureSizes flags a fixed arc end', () => {
    let arc = '', a = '', b = ''
    const { doc, pen } = mk(d => {
      const s = addPoint(d, 10, 0), e = addPoint(d, 12, 2, { fixed: true }), c = addPoint(d, 12, 0)
      arc = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 0 }])
      a = addPoint(d, 5, 5); b = addPoint(d, 5, 5); addLine(d, a, b)
    })
    expect(measureSizes(doc.value, sizeTargetFor(doc.value, [arc], [])!, DEV).endFixed).toBe(true)
    expect(pen.setArcSweep(arc, 0, 120)).toBe(false)
    expect(pen.status.value).toBe('Fixed points stay where they are')
    expect(pen.setArcLength(arc, 0, 5)).toBe(false)
    expect(pen.status.value).toBe('Fixed points stay where they are')
    expect(pen.setLineAngle(a, b, 30)).toBe(false)
    expect(pen.status.value).toBe('That line has no direction')
  })
  it('the highlight clears when the selection is replaced, the session finishes, or on undo / redo', () => {
    let l = '', p = ''
    const { pen } = mk(d => { p = addPoint(d, 5, 5); l = addLine(d, addPoint(d, 0, 0), addPoint(d, 1, 0)) })
    const lit = () => pen.setHighlight([{ kind: 'line', id: l }])
    lit(); pen.pick(p); expect(pen.highlight.value).toEqual([])
    lit(); pen.clearSel(); expect(pen.highlight.value).toEqual([])
    lit(); pen.finishSession(); expect(pen.highlight.value).toEqual([])
    pen.setPointXY(p, 6, 6)
    lit(); pen.undo(); expect(pen.highlight.value).toEqual([])
    lit(); pen.redo(); expect(pen.highlight.value).toEqual([])
  })
  it('each lock toggle is exactly one undo step', () => {
    let arc = '', circle = ''
    const { pen } = mk(d => {
      const s = addPoint(d, 10, 0), e = addPoint(d, 12, 2), c = addPoint(d, 12, 0)
      arc = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 0 }])
      circle = addCircle(d, addPoint(d, 20, 0), 1.5)
    })
    const oneStep = (f: () => void) => {
      f(); expect(pen.canUndo()).toBe(true)
      pen.undo(); expect(pen.canUndo()).toBe(false)
      pen.redo(); pen.undo(); expect(pen.canUndo()).toBe(false)   // redo re-does just that one
      f()
    }
    oneStep(() => pen.toggleArcRadiusLock(arc, 0))   // lock on
    pen.toggleArcRadiusLock(arc, 0)                  // lock off: one more step over the lock
    pen.undo(); pen.undo(); expect(pen.canUndo()).toBe(false)
    oneStep(() => pen.toggleCircleRadiusLock(circle))
    pen.toggleCircleRadiusLock(circle)
    pen.undo(); pen.undo(); expect(pen.canUndo()).toBe(false)
  })
})
