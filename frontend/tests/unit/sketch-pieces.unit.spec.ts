// tests/unit/sketch-pieces.unit.spec.ts
// Pen stage 6: the drawing as the right-click menu and the Properties panel
// talk about it — piece names in drawing order, which pieces a rule ties and
// what it is called, the rules that belong to a selection, and the heading.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint, setAnchorSmooth } from '~/lib/sketch/edit'
import {
  pieceNames, pieceKey, rulePieces, ruleName, ruleLabel, isArcInvariant,
  rulesForSelection, selectionLabel, topLevelIds,
} from '~/lib/sketch/pieces'

// a line running into a tangent arc, a loose circle and a lone point
function scene() {
  const d: SketchDoc = { entities: [], constraints: [] }
  const p1 = addPoint(d, 2, 2), p2 = addPoint(d, 6, 2), p5 = addPoint(d, 8, 4), c = addPoint(d, 6, 4)
  const line = addLine(d, p1, p2)
  const arc = addPath(d, [p2, p5], [{ kind: 'arc', center: c, sweep: 1 }])   // adds the arc's own equalDist
  const tan = addConstraint(d, 'perpendicular', [p1, p2, p2, c])             // the joint tangent form
  const cc = addPoint(d, 12, 4)
  const circle = addCircle(d, cc, 1.5)
  const lone = addPoint(d, 14, 8)
  return { d, p1, p2, p5, c, line, arc, tan, cc, circle, lone }
}
const find = (d: SketchDoc, id: string) => d.constraints.find(k => k.id === id)!

describe('piece names', () => {
  it('numbers each kind in drawing order', () => {
    const s = scene()
    const n = pieceNames(s.d)
    expect(n.get(`point:${s.p1}`)).toBe('Point 1')
    expect(n.get(`point:${s.c}`)).toBe('Point 4')
    expect(n.get(`line:${s.line}`)).toBe('Line 1')
    expect(n.get(`seg:${s.arc}:0`)).toBe('Arc 1')
    expect(n.get(`circle:${s.circle}`)).toBe('Circle 1')
    expect(n.get(`point:${s.lone}`)).toBe('Point 6')
  })
  it('straight path pieces share the line count', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    addLine(d, addPoint(d, 0, 0), addPoint(d, 1, 0))
    const q = addPoint(d, 2, 0), r = addPoint(d, 3, 0), t = addPoint(d, 3, 1)
    const P = addPath(d, [q, r, t], [{ kind: 'line' }, { kind: 'line' }])
    expect(pieceNames(d).get(`seg:${P}:1`)).toBe('Line 3')
  })
})

describe('what a rule ties, and its name', () => {
  it('the joint tangent: the line and the arc', () => {
    const s = scene()
    const c = find(s.d, s.tan)
    expect(rulePieces(s.d, c).map(pieceKey)).toEqual([`line:${s.line}`, `seg:${s.arc}:0`])
    expect(ruleName(s.d, c)).toBe('Tangent')
    expect(ruleLabel(s.d, c, pieceNames(s.d))).toBe('Tangent — Line 1 · Arc 1')
  })
  it('an arc radius pin reads as that arc’s radius', () => {
    const s = scene()
    const id = addConstraint(s.d, 'distance', [s.c, s.p2], 2)
    expect(ruleLabel(s.d, find(s.d, id), pieceNames(s.d))).toBe('Radius 2 — Arc 1')
  })
  it('two points held level, a point on an arc, a circle’s size, a whole line held level', () => {
    const s = scene()
    const names = pieceNames(s.d)
    const lab = (id: string) => ruleLabel(s.d, find(s.d, id), names)
    expect(lab(addConstraint(s.d, 'horizontal', [s.p1, s.lone]))).toBe('Horizontal — Point 1 · Point 6')
    expect(lab(addConstraint(s.d, 'equalDist', [s.c, s.lone, s.c, s.p2]))).toBe('On curve — Point 6 · Arc 1')
    expect(lab(addConstraint(s.d, 'radius', [s.circle], 1.5))).toBe('Radius 1.5 — Circle 1')
    expect(lab(addConstraint(s.d, 'horizontal', [s.line]))).toBe('Horizontal — Line 1')
  })
  it('a square corner between two straight pieces is a right angle', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), c = addPoint(d, 4, 3)
    addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
    const k = addConstraint(d, 'perpendicular', [a, b, b, c])
    expect(ruleLabel(d, find(d, k), pieceNames(d))).toBe('Right angle — Line 1 · Line 2')
  })
  it('two arcs joined smoothly: collinear centres read as Tangent', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), j = addPoint(d, 2, 0), b = addPoint(d, 4, 0)
    const c1 = addPoint(d, 1, 0), c2 = addPoint(d, 3, 0)
    const P = addPath(d, [a, j, b], [{ kind: 'arc', center: c1, sweep: 1 }, { kind: 'arc', center: c2, sweep: 0 }])
    const k = addConstraint(d, 'collinear', [c1, j, c2])
    expect(ruleLabel(d, find(d, k), pieceNames(d))).toBe('Tangent — Arc 1 · Arc 2')
    expect(rulePieces(d, find(d, k)).map(pieceKey)).toEqual([`seg:${P}:0`, `seg:${P}:1`])
  })
})

describe('the rules of a selection', () => {
  it('an arc lists its tangent and hides its own equal-ends rule', () => {
    const s = scene()
    const inv = s.d.constraints.find(k => k.kind === 'equalDist')!
    expect(isArcInvariant(s.d, inv)).toBe(true)
    expect(rulesForSelection(s.d, [], [{ pathId: s.arc, segIndex: 0 }]).map(c => c.id)).toEqual([s.tan])
  })
  it('a whole path counts its pieces and its points', () => {
    const s = scene()
    const k = addConstraint(s.d, 'horizontal', [s.p5, s.lone])
    expect(rulesForSelection(s.d, [s.arc], []).map(c => c.id).sort()).toEqual([s.tan, k].sort())
  })
  it('hides Repeat / Mirror copy rules, like the badges (C2)', () => {
    const s = scene()
    const q = addPoint(s.d, 3, 5)
    addConstraint(s.d, 'rotatedFrom', [q, s.p1, s.c], 90)
    addConstraint(s.d, 'mirroredFrom', [q, s.p1, s.line])
    expect(rulesForSelection(s.d, [s.p1], [])).toEqual([])
    expect(rulesForSelection(s.d, [s.line], []).map(c => c.id)).toEqual([s.tan])
  })
  it('Bézier handles are not pieces of their own: unnumbered, and read as their curve (C2)', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), c = addPoint(d, 8, 0)
    const path = addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
    expect(setAnchorSmooth(d, path, 1)).toBe(true)
    const lone = addPoint(d, 9, 9)
    const n = pieceNames(d)
    expect(n.get(`point:${lone}`)).toBe('Point 4')      // a, b, c, lone — the handles are skipped
    const smooth = d.constraints.find(k => k.kind === 'collinear')!
    expect(ruleLabel(d, smooth, n)).toBe('Smooth — Curve 1 · Point 2 · Curve 2')
    expect(rulesForSelection(d, [], [{ pathId: path, segIndex: 0 }]).map(k => k.id)).toEqual([smooth.id])
  })
  it('a piece with no rules lists none', () => {
    const s = scene()
    expect(rulesForSelection(s.d, [s.circle], [])).toEqual([])
  })
})

describe('the heading', () => {
  it('names one kind with a count, otherwise counts', () => {
    const s = scene()
    expect(selectionLabel(s.d, [], [])).toBe('Nothing selected')
    expect(selectionLabel(s.d, [s.p1, s.lone], [])).toBe('2 points')
    expect(selectionLabel(s.d, [], [{ pathId: s.arc, segIndex: 0 }])).toBe('1 arc')
    expect(selectionLabel(s.d, [s.arc], [])).toBe('1 arc')
    expect(selectionLabel(s.d, [s.line, s.circle, s.lone], [])).toBe('3 selected')
  })
  it('top-level pieces: every piece plus points no piece uses', () => {
    const s = scene()
    expect(topLevelIds(s.d).sort()).toEqual([s.line, s.arc, s.circle, s.lone].sort())
  })
})
