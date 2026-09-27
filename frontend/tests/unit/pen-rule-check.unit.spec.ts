// tests/unit/pen-rule-check.unit.spec.ts
// Pen stage 6: the rule a selection makes (what apply writes, pinned case by
// case) and whether it can be added — "Already true" (there, or implied by
// the others), "Conflicts with another rule" (would move things it can't, or
// collapse a piece), else fine. Two points now offer Horizontal / Vertical.
// Controller ruling C1: the menus' check (quickRuleCheck) never solves; the
// full check (checkRule) solves only a window round the rule — both timed on
// a 150-piece connected drawing.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { checkRule, quickRuleCheck } from '~/lib/sketch/ruleCheck'
import { ruleSpecFor, availableConstraints, type SegRef } from '~/composables/pen/penRules'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
const empty = (): SketchDoc => ({ entities: [], constraints: [] })
function mk(build: (d: SketchDoc) => void) {
  const doc = ref<SketchDoc>(empty())
  build(doc.value)
  return { doc, pen: usePen({ doc, view: ref(DEV) }) }
}

describe('checkRule', () => {
  it('a rule already there is already true', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 0))
    addConstraint(d, 'horizontal', [l])
    expect(checkRule(d, { kind: 'horizontal', refs: [l] })).toBe('already')
    expect(quickRuleCheck(d, { kind: 'horizontal', refs: [l] })).toBe('already')
  })
  it('a rule the others imply is already true', () => {
    const d = empty()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), c = addPoint(d, 0, 2), e = addPoint(d, 4, 2)
    addConstraint(d, 'horizontal', [a, b]); addConstraint(d, 'horizontal', [c, e])
    expect(checkRule(d, { kind: 'parallel', refs: [a, b, c, e] })).toBe('already')
    expect(quickRuleCheck(d, { kind: 'parallel', refs: [a, b, c, e] })).toBe('already')
  })
  it('a rule that fights another conflicts', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 0))
    addConstraint(d, 'horizontal', [l])
    expect(checkRule(d, { kind: 'vertical', refs: [l] })).toBe('conflict')
  })
  it('a rule that can hold is fine', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 0.3))
    expect(checkRule(d, { kind: 'horizontal', refs: [l] })).toBe('ok')
    expect(quickRuleCheck(d, { kind: 'horizontal', refs: [l] })).toBe('ok')
  })
  it('a rule true by chance but not implied is fine (it would still lock something)', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 0))
    expect(quickRuleCheck(d, { kind: 'horizontal', refs: [l] })).toBe('ok')
    expect(checkRule(d, { kind: 'horizontal', refs: [l] })).toBe('ok')
  })
  it('a pinned line can’t be made upright: conflicts, and the drawing is untouched', () => {
    const d = empty()
    const a = addPoint(d, 0, 0, { fixed: true }), b = addPoint(d, 4, 1, { fixed: true })
    const l = addLine(d, a, b)
    const before = JSON.stringify(d)
    expect(checkRule(d, { kind: 'vertical', refs: [l] })).toBe('conflict')
    expect(JSON.stringify(d)).toBe(before)
  })
  it('joining two points: fine, but not two fixed points in different places', () => {
    const d = empty()
    const a = addPoint(d, 0, 0), b = addPoint(d, 1, 1)
    expect(checkRule(d, { merge: [a, b] })).toBe('ok')
    expect(quickRuleCheck(d, { merge: [a, b] })).toBe('ok')
    expect(checkRule(d, { merge: [a, a] })).toBe('already')
    const f = empty()
    const x = addPoint(f, 0, 0, { fixed: true }), y = addPoint(f, 1, 1, { fixed: true })
    expect(checkRule(f, { merge: [x, y] })).toBe('conflict')
    expect(quickRuleCheck(f, { merge: [x, y] })).toBe('conflict')
  })
  it('joining the two ends of one line is fine (the line goes, it is not a collapse)', () => {
    const d = empty()
    const a = addPoint(d, 0, 0), b = addPoint(d, 1, 0), c = addPoint(d, 3, 2)
    addLine(d, a, b); addLine(d, b, c)
    expect(checkRule(d, { merge: [a, b] })).toBe('ok')
  })
})

describe('ruleSpecFor is what apply writes', () => {
  it('two lines: the four ends, in pick order', () => {
    let a = '', b = '', c = '', e = '', l1 = '', l2 = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); b = addPoint(d, 4, 0.2); c = addPoint(d, 0, 2); e = addPoint(d, 4, 2.5)
      l1 = addLine(d, a, b); l2 = addLine(d, c, e)
    })
    for (const kind of ['perpendicular', 'parallel', 'equalDist'] as const) {
      expect(ruleSpecFor(doc.value, [l1, l2], [], { kind, label: '' })).toEqual({ kind, refs: [a, b, c, e] })
    }
    pen.pick(l1); pen.pick(l2, true)
    pen.apply('parallel')
    expect(doc.value.constraints.at(-1)).toMatchObject({ kind: 'parallel', refs: [a, b, c, e] })
  })
  it('a point and a line: on line, midpoint', () => {
    let p = '', a = '', b = '', l = ''
    const { doc } = mk(d => { p = addPoint(d, 1, 1); a = addPoint(d, 0, 0); b = addPoint(d, 4, 0); l = addLine(d, a, b) })
    expect(ruleSpecFor(doc.value, [l, p], [], { kind: 'pointOnLine', label: '' })).toEqual({ kind: 'pointOnLine', refs: [p, l] })
    expect(ruleSpecFor(doc.value, [p, l], [], { kind: 'midpoint', label: '' })).toEqual({ kind: 'midpoint', refs: [p, a, b] })
  })
  it('segments: a straight one levelled; a point on a straight or round one; two arcs made equal', () => {
    let a = '', b = '', c = '', P = '', q = '', s = '', t = '', cen = '', Q = '', s2 = '', t2 = '', cen2 = '', R = ''
    const { doc } = mk(d => {
      a = addPoint(d, 0, 0); b = addPoint(d, 4, 0.3); c = addPoint(d, 4, 3)
      P = addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
      q = addPoint(d, 9, 9)
      s = addPoint(d, 10, 0); t = addPoint(d, 12, 2); cen = addPoint(d, 12, 0)
      Q = addPath(d, [s, t], [{ kind: 'arc', center: cen, sweep: 1 }])
      s2 = addPoint(d, 20, 0); t2 = addPoint(d, 23, 3); cen2 = addPoint(d, 23, 0)
      R = addPath(d, [s2, t2], [{ kind: 'arc', center: cen2, sweep: 1 }])
    })
    expect(ruleSpecFor(doc.value, [], [{ pathId: P, segIndex: 0 }], { kind: 'horizontal', label: '' })).toEqual({ kind: 'horizontal', refs: [a, b] })
    expect(ruleSpecFor(doc.value, [q], [{ pathId: P, segIndex: 1 }], { kind: 'collinear', label: '' })).toEqual({ kind: 'collinear', refs: [b, c, q] })
    expect(ruleSpecFor(doc.value, [q], [{ pathId: Q, segIndex: 0 }], { kind: 'equalDist', label: '' })).toEqual({ kind: 'equalDist', refs: [cen, q, cen, s] })
    expect(ruleSpecFor(doc.value, [], [{ pathId: Q, segIndex: 0 }, { pathId: R, segIndex: 0 }], { kind: 'equalDist', label: '' }))
      .toEqual({ kind: 'equalDist', refs: [cen, s, cen2, s2] })
  })
  it('a circle’s radius carries its value; two points join as a merge; nothing selected makes nothing', () => {
    let c = '', a = '', b = ''
    const { doc } = mk(d => { c = addCircle(d, addPoint(d, 0, 0), 2); a = addPoint(d, 5, 5); b = addPoint(d, 6, 6) })
    expect(ruleSpecFor(doc.value, [c], [], { kind: 'radius', label: '' }, 3)).toEqual({ kind: 'radius', refs: [c], value: 3 })
    expect(ruleSpecFor(doc.value, [a, b], [], { kind: 'coincident', label: '' })).toEqual({ merge: [a, b] })
    expect(ruleSpecFor(doc.value, [], [], { kind: 'horizontal', label: '' })).toBeNull()
  })
})

describe('two points', () => {
  it('offer Horizontal and Vertical after Coincident and Distance; Horizontal lines them up', () => {
    let a = '', b = ''
    const { doc, pen } = mk(d => { a = addPoint(d, 0, 0); b = addPoint(d, 5, 1) })
    pen.pick(a); pen.pick(b, true)
    expect(pen.availableConstraints().map(r => r.label)).toEqual(['Coincident', 'Distance…', 'Horizontal', 'Vertical'])
    pen.apply('horizontal')
    const pa = doc.value.entities.find(e => e.id === a) as any, pb = doc.value.entities.find(e => e.id === b) as any
    expect(pa.y).toBeCloseTo(pb.y, 6)
    expect(doc.value.constraints.at(-1)).toMatchObject({ kind: 'horizontal', refs: [a, b] })
  })
})

// a zigzag of 150 straight pieces in one path, every piece's length pinned
function bigDrawing(): { d: SketchDoc; P: EntityId; pts: EntityId[] } {
  const d = empty()
  const pts: EntityId[] = []
  for (let i = 0; i <= 150; i++) pts.push(addPoint(d, i * 2, (i % 2) * 1.5 + (i % 7) * 0.1))
  const P = addPath(d, pts, pts.slice(1).map(() => ({ kind: 'line' as const })))
  for (let i = 0; i < 150; i++) {
    const A = d.entities.find(e => e.id === pts[i]) as any, B = d.entities.find(e => e.id === pts[i + 1]) as any
    addConstraint(d, 'distance', [pts[i]!, pts[i + 1]!], Math.hypot(A.x - B.x, A.y - B.y))
  }
  for (let i = 0; i < 150; i += 10) addConstraint(d, 'horizontal', [pts[i]!, pts[i + 2]!])
  return { d, P, pts }
}
function best(n: number, f: () => void): number {
  let m = Infinity
  for (let k = 0; k < n; k++) { const t0 = performance.now(); f(); m = Math.min(m, performance.now() - t0) }
  return m
}
function specsFor(d: SketchDoc, sel: EntityId[], segs: SegRef[]) {
  return availableConstraints(d, sel, segs).map(o => {
    // a rule that asks for a value is checked at its current measured value
    let v: number | undefined
    if (o.value && o.kind === 'distance') {
      const [A, B] = sel.map(id => d.entities.find(e => e.id === id) as any)
      v = Math.hypot(A.x - B.x, A.y - B.y)
    }
    return ruleSpecFor(d, sel, segs, o, v)
  }).filter(s => s != null)
}

describe('speed on a 150-piece connected drawing (C1)', () => {
  it('the menus’ check over every rule a selection offers takes under 50 ms, with no solve', () => {
    const { d, P, pts } = bigDrawing()
    const selections: [EntityId[], SegRef[]][] = [
      [[], [{ pathId: P, segIndex: 40 }, { pathId: P, segIndex: 90 }]],
      [[pts[20]!, pts[120]!], []],
      [[], [{ pathId: P, segIndex: 75 }]],
    ]
    const before = JSON.stringify(d)
    for (const [sel, segs] of selections) {
      const specs = specsFor(d, sel, segs)
      expect(specs.length).toBeGreaterThan(0)
      const ms = best(3, () => { for (const s of specs) quickRuleCheck(d, s!) })
      expect(ms).toBeLessThan(50)
    }
    expect(JSON.stringify(d)).toBe(before)
  })
  it('the full check of one picked rule takes under 100 ms', () => {
    const { d, P, pts } = bigDrawing()
    const par = ruleSpecFor(d, [], [{ pathId: P, segIndex: 40 }, { pathId: P, segIndex: 90 }], { kind: 'parallel', label: '' })!
    const hor = ruleSpecFor(d, [pts[20]!, pts[120]!], [], { kind: 'horizontal', label: '' })!
    // two pieces of pinned, different lengths made equal: every window fails
    // and the part is too big to solve — the slowest path; not certain, so
    // "unsure" (allowed), never a guessed conflict
    const eq = ruleSpecFor(d, [], [{ pathId: P, segIndex: 40 }, { pathId: P, segIndex: 90 }], { kind: 'equalDist', label: '' })!
    for (const [s, want] of [[par, 'ok'], [hor, 'ok'], [eq, 'unsure']] as const) {
      let r = ''
      const ms = best(3, () => { r = checkRule(d, s) })
      expect(r).toBe(want)
      expect(ms).toBeLessThan(100)
    }
  })
})

// a rigid strip of 150 triangles (every piece's length and every second
// point's distance pinned), free to turn and slide as a whole
function rigidStrip(): { d: SketchDoc; pts: EntityId[] } {
  const d = empty()
  const pts: EntityId[] = []
  for (let i = 0; i <= 150; i++) pts.push(addPoint(d, i * 2, (i % 2) * 1.5))
  addPath(d, pts, pts.slice(1).map(() => ({ kind: 'line' as const })))
  const at = (id: EntityId) => d.entities.find(e => e.id === id) as any
  const len = (a: EntityId, b: EntityId) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y)
  for (let i = 0; i < 150; i++) addConstraint(d, 'distance', [pts[i]!, pts[i + 1]!], len(pts[i]!, pts[i + 1]!))
  for (let i = 0; i < 149; i++) addConstraint(d, 'distance', [pts[i]!, pts[i + 2]!], len(pts[i]!, pts[i + 2]!))
  return { d, pts }
}

describe('never refuse on a guess (controller ruling)', () => {
  it('a rule only the whole big drawing can settle is unsure, not a conflict', () => {
    const { d, pts } = rigidStrip()
    // turning the whole strip levels its two far ends — no window can
    const spec = { kind: 'horizontal' as const, refs: [pts[0]!, pts[149]!] }
    expect(checkRule(d, spec)).toBe('unsure')
    expect(quickRuleCheck(d, spec)).toBe('ok')
  })
  it('a rule true now that the window’s edge would seem to imply, but that still locks the turn, is fine', () => {
    const { d, pts } = rigidStrip()
    const spec = { kind: 'horizontal' as const, refs: [pts[0]!, pts[2]!] }   // level now
    expect(quickRuleCheck(d, spec)).toBe('ok')
    expect(checkRule(d, spec)).toBe('ok')
  })
  it('a pinned length truly implied inside the strip is already true', () => {
    const { d, pts } = rigidStrip()
    const at = (id: EntityId) => d.entities.find(e => e.id === id) as any
    const v = Math.hypot(at(pts[10]!).x - at(pts[13]!).x, at(pts[10]!).y - at(pts[13]!).y)
    const spec = { kind: 'distance' as const, refs: [pts[10]!, pts[13]!], value: v }
    expect(quickRuleCheck(d, spec)).toBe('already')
    expect(checkRule(d, spec)).toBe('already')
  })
})
