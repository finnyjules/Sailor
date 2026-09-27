// tests/unit/cleanup-shape.unit.spec.ts
// Clean up, stages 3–5 (pen stage 5): nearly concentric centres, mirror
// pairs, nearly equal lengths and radii, nearly even spacing, and sizes a
// hair off a whole number.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { buildContext, type ContextEnv } from '~/lib/sketch/cleanup/context'
import { detectConcentric, detectMirrorPairs, detectEqualLengths, detectEqualRadii, detectEvenSpacing, detectRound } from '~/lib/sketch/cleanup/detect-shape'

const U = 1 / 34
const blank = (): SketchDoc => ({ entities: [], constraints: [] })
const env = (o: Partial<ContextEnv> = {}): ContextEnv => ({ held: new Set(), copies: new Set(), s: 1, unitsPerPx: U, ...o })
const rad = (deg: number) => deg * Math.PI / 180
function lineAt(d: SketchDoc, x: number, y: number, deg: number, len: number) {
  const a = addPoint(d, x, y), b = addPoint(d, x + len * Math.cos(rad(deg)), y + len * Math.sin(rad(deg)))
  return { a, b, id: addLine(d, a, b) }
}
function semicircle(d: SketchDoc, x0: number, x1: number) {   // from (x0, 0) to (x1, 0), bulging down
  const A = addPoint(d, x0, 0), B = addPoint(d, x1, 0), C = addPoint(d, (x0 + x1) / 2, 0)
  return { A, B, C, id: addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }]) }
}
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any

describe('detectConcentric', () => {
  it('two centres 3.4 px apart → one shared centre, weighted towards the bigger circle', () => {
    const d = blank()
    const c1 = addPoint(d, 5, 5), c2 = addPoint(d, 5.1, 5)
    addCircle(d, c1, 2); addCircle(d, c2, 3)
    const c = detectConcentric(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'concentric', label: 'Same centre', id: `concentric:${[c1, c2].sort().join(',')}` })
    expect(c[0]!.merges!.at.x).toBeCloseTo(5.06, 9)
  })
})

describe('detectEqualLengths', () => {
  it('5 and 5.1 → Same length ×2, tied to the longer', () => {
    const d = blank()
    const s = lineAt(d, 0, 0, 20, 5), l = lineAt(d, 10, 0, 70, 5.1)
    const c = detectEqualLengths(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'equalLength', label: 'Same length ×2' })
    expect(c[0]!.rules).toEqual([{ kind: 'equalDist', refs: [l.a, l.b, s.a, s.b] }])
  })
  it('a typed length is the one the others take', () => {
    const d = blank()
    const s = lineAt(d, 0, 0, 20, 5), l = lineAt(d, 10, 0, 70, 5.1)
    addConstraint(d, 'distance', [s.a, s.b], 5)
    expect(detectEqualLengths(buildContext(d, env()))[0]!.rules).toEqual([{ kind: 'equalDist', refs: [s.a, s.b, l.a, l.b] }])
  })
  it('two different typed lengths → nothing', () => {
    const d = blank()
    const s = lineAt(d, 0, 0, 20, 5), l = lineAt(d, 10, 0, 70, 5.1)
    addConstraint(d, 'distance', [s.a, s.b], 5); addConstraint(d, 'distance', [l.a, l.b], 5.1)
    expect(detectEqualLengths(buildContext(d, env()))).toHaveLength(0)
  })
})

describe('detectEqualRadii', () => {
  it('arcs go with arcs and circles with circles', () => {
    const d = blank()
    const a1 = semicircle(d, 0, 6), a2 = semicircle(d, 10, 16.1)
    const k1 = addCircle(d, addPoint(d, 30, 0), 3.02), k2 = addCircle(d, addPoint(d, 40, 0), 3.04)
    const c = detectEqualRadii(buildContext(d, env()))
    expect(c.map(x => x.label)).toEqual(['Same radius ×2', 'Same radius ×2'])
    expect(c[0]!.rules).toEqual([{ kind: 'equalDist', refs: [a2.C, a2.A, a1.C, a1.A] }])
    expect(c[1]!.rules).toEqual([{ kind: 'equalRadius', refs: [k2, k1] }])
  })
})

describe('detectEvenSpacing', () => {
  it('three stacked parallel lines with gaps 2 and 2.1 → a guide point at the middle and the middle line through it', () => {
    const d = blank()
    const l0 = addLine(d, addPoint(d, 0, 0), addPoint(d, 6, 0))
    const l1 = addLine(d, addPoint(d, 0, 2), addPoint(d, 6, 2))
    const l2 = addLine(d, addPoint(d, 0, 4.1), addPoint(d, 6, 4.1))
    const c = detectEvenSpacing(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'evenSpacing', label: 'Evenly spaced' })
    const w = cloneDoc(d)
    const rules = c[0]!.prepare!(w, new Map())
    const m = w.entities[w.entities.length - 1] as any
    expect(m).toMatchObject({ kind: 'point', construction: true, x: 0, y: 2.05 })
    const [L0, L1, L2] = [l0, l1, l2].map(id => P(d, id))
    expect(rules).toEqual([{ kind: 'midpoint', refs: [m.id, L0.p1, L2.p1] }, { kind: 'collinear', refs: [L1.p1, L1.p2, m.id] }])
  })
  it('points pinned on a line, with its ends → equal gaps', () => {
    const d = blank()
    const a = addPoint(d, 0, 0), b = addPoint(d, 6, 0), line = addLine(d, a, b)
    const p1 = addPoint(d, 2.02, 0), p2 = addPoint(d, 4.05, 0)
    addConstraint(d, 'pointOnLine', [p1, line]); addConstraint(d, 'pointOnLine', [p2, line])
    const c = detectEvenSpacing(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]!.rules).toEqual([{ kind: 'equalDist', refs: [a, p1, p1, p2] }, { kind: 'equalDist', refs: [p1, p2, p2, b] }])
  })
  it('uneven gaps are left alone', () => {
    const d = blank()
    addLine(d, addPoint(d, 0, 0), addPoint(d, 6, 0)); addLine(d, addPoint(d, 0, 2), addPoint(d, 6, 2)); addLine(d, addPoint(d, 0, 4.4), addPoint(d, 6, 4.4))
    expect(detectEvenSpacing(buildContext(d, env()))).toHaveLength(0)
  })
})

describe('detectMirrorPairs', () => {
  it('two lines mirrored across an upright 3.4 px off → a new axis between them and mirror rules', () => {
    const d = blank()
    const L = { a: addPoint(d, 1, 1), b: addPoint(d, 3, 4) }; addLine(d, L.a, L.b)
    const R = { a: addPoint(d, 9.1, 1), b: addPoint(d, 7, 4) }; addLine(d, R.a, R.b)
    const c = detectMirrorPairs(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'mirror', label: 'Mirror pair' })
    expect(c[0]!.id.startsWith('mirror:v:')).toBe(true)
    const w = cloneDoc(d), guides = new Map<string, string>()
    const rules = c[0]!.prepare!(w, guides)
    const axis = w.entities.find(e => e.id === guides.get('axis:v')) as any
    expect(axis).toMatchObject({ kind: 'line', construction: true })
    expect(P(w, axis.p1).x).toBeCloseTo(5.025, 9)
    expect(P(w, axis.p2).x).toBeCloseTo(5.025, 9)
    expect(rules).toEqual([
      { kind: 'vertical', refs: [axis.p1, axis.p2] },
      { kind: 'mirroredFrom', refs: [R.a, L.a, axis.id] },
      { kind: 'mirroredFrom', refs: [R.b, L.b, axis.id] },
    ])
    // a second fix on the same axis reuses it
    expect(c[0]!.prepare!(w, guides)).toHaveLength(2)
  })
  it('pieces too far off mirroring are left alone', () => {
    const d = blank()
    addLine(d, addPoint(d, 1, 1), addPoint(d, 3, 4)); addLine(d, addPoint(d, 9.6, 1), addPoint(d, 7, 4))
    expect(detectMirrorPairs(buildContext(d, env()))).toHaveLength(0)
  })
})

describe('detectRound', () => {
  it('4.95 long → Rounded to 5; an arc of radius 3.04 → Rounded to 3', () => {
    const d = blank()
    const l = lineAt(d, 0, 0, 20, 4.95)
    const arc = semicircle(d, 10, 16.08)
    const c = detectRound(buildContext(d, env()))
    expect(c.map(x => x.label)).toEqual(['Rounded to 5', 'Rounded to 3'])
    expect(c[0]!.nudge).toEqual({ refs: [l.a, l.b], value: 5 })
    expect(c[1]!.nudge).toEqual({ refs: [arc.C, arc.A], value: 3 })
  })
  it('never a typed size, and not when a unit is under 4 px on screen', () => {
    const d = blank()
    const l = lineAt(d, 0, 0, 20, 4.95)
    expect(detectRound(buildContext(d, env({ unitsPerPx: 1 })))).toHaveLength(0)
    addConstraint(d, 'distance', [l.a, l.b], 4.95)
    expect(detectRound(buildContext(d, env()))).toHaveLength(0)
  })
})
