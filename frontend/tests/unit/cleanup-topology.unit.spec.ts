// tests/unit/cleanup-topology.unit.spec.ts
// Clean up, stage 1 (pen stage 5): what a detector sees of the drawing
// (pieces, scope, copies) and the three topology detectors — ends that
// nearly meet, a point nearly on a curve, a joint that is nearly smooth.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { buildContext, heldForScope, copyPoints, type ContextEnv } from '~/lib/sketch/cleanup/context'
import { detectJoins, detectOnCurve, detectTangents } from '~/lib/sketch/cleanup/detect-topology'
import { STRENGTH_FACTOR } from '~/lib/sketch/cleanup/types'

const U = 1 / 34   // the dev page's zoom: 34 px per drawing unit
const blank = (): SketchDoc => ({ entities: [], constraints: [] })
const env = (o: Partial<ContextEnv> = {}): ContextEnv => ({ held: new Set(), copies: new Set(), s: 1, unitsPerPx: U, ...o })
function line(d: SketchDoc, x0: number, y0: number, x1: number, y1: number) {
  const a = addPoint(d, x0, y0), b = addPoint(d, x1, y1)
  return { a, b, id: addPath(d, [a, b], [{ kind: 'line' }]) }
}

describe('buildContext', () => {
  it('lists lines, arcs and circles — not guides, not Bézier segments', () => {
    const d = blank()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 4, 0))
    addLine(d, addPoint(d, 0, 2), addPoint(d, 4, 2), { construction: true })
    const c = addCircle(d, addPoint(d, 10, 10), 2)
    const a = addPoint(d, 0, 5), b = addPoint(d, 4, 5), m = addPoint(d, 8, 5)
    const path = addPath(d, [a, b, m], [{ kind: 'arc', center: addPoint(d, 2, 5), sweep: 1 }, { kind: 'cubic', h1: null, h2: null }])
    const ctx = buildContext(d, env())
    expect(ctx.pieces.map(p => p.key).sort()).toEqual([`${path}:0`, c, l].sort())
    expect(ctx.pieces.find(p => p.key === l)!.kind).toBe('line')
    expect(ctx.pieces.find(p => p.key === `${path}:0`)!.kind).toBe('arc')
    expect(ctx.pieces.find(p => p.key === `${path}:0`)!.len).toBeCloseTo(2 * Math.PI, 9)
  })
  it('a selection holds everything outside it, and points it shares with the rest', () => {
    const d = blank()
    const p = line(d, 0, 0, 4, 0)
    const q = addPath(d, [p.b, addPoint(d, 8, 0)], [{ kind: 'line' }])
    const held = heldForScope(d, { entities: [p.id], segments: [] })
    expect(held.has(p.a)).toBe(false)
    expect(held.has(p.b)).toBe(true)
    const ctx = buildContext(d, env({ held }))
    expect(ctx.pieces.find(x => x.key === `${p.id}:0`)!.inScope).toBe(true)
    expect(ctx.pieces.find(x => x.key === `${q}:0`)!.inScope).toBe(false)
  })
  it('no usable selection holds nothing', () => {
    const d = blank()
    const p = line(d, 0, 0, 4, 0)
    expect(heldForScope(d, { entities: [p.a], segments: [] }).size).toBe(0)
    expect(heldForScope(d, null).size).toBe(0)
  })
  it('copies are the copy points of Repeat and Mirror rules', () => {
    const d = blank()
    const a = addPoint(d, 0, 0), b = addPoint(d, 1, 0), c = addPoint(d, 0, 0, { fixed: true })
    addConstraint(d, 'rotatedFrom', [b, a, c], 90)
    expect([...copyPoints(d)]).toEqual([b])
  })
})

describe('detectJoins', () => {
  it('ends 3.4 px apart become one join, placed between them', () => {
    const d = blank()
    const p = line(d, 0, 0, 4, 0), q = line(d, 4.1, 0, 8, 1)
    const c = detectJoins(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'join', label: 'Joined', id: `join:${[p.b, q.a].sort().join(',')}` })
    expect([...c[0]!.merges!.points].sort()).toEqual([p.b, q.a].sort())
    expect(c[0]!.merges!.at.x).toBeCloseTo(4.05, 9)
  })
  it('a 6.8 px gap joins only at Strong', () => {
    const d = blank()
    line(d, 0, 0, 4, 0); line(d, 4.2, 0, 8, 1)
    expect(detectJoins(buildContext(d, env()))).toHaveLength(0)
    expect(detectJoins(buildContext(d, env({ s: STRENGTH_FACTOR.strong })))).toHaveLength(1)
  })
  it('never joins a gap bigger than a quarter of the shorter piece', () => {
    const d = blank()
    line(d, 0, 0, 4, 0); line(d, 4.1, 0, 4.4, 0)
    expect(detectJoins(buildContext(d, env()))).toHaveLength(0)
  })
  it('leaves two already-shared points alone', () => {
    const d = blank()
    const a = addPoint(d, 0, 0), b = addPoint(d, 2, 0), c = addPoint(d, 4, 0)
    addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
    const e = addPoint(d, 2.05, 0.05), f = addPoint(d, 2, 3), g = addPoint(d, 2.1, 3.5)
    addPath(d, [f, e, g], [{ kind: 'line' }, { kind: 'line' }])
    expect(detectJoins(buildContext(d, env()))).toHaveLength(0)
  })
  it('skips a gap between two copies', () => {
    const d = blank()
    const p = line(d, 0, 0, 4, 0), q = line(d, 4.1, 0, 8, 1)
    expect(detectJoins(buildContext(d, env({ copies: new Set([p.b, q.a]) })))).toHaveLength(0)
  })
})

describe('detectOnCurve', () => {
  it('pins a loose end onto a circle, a path line and a path arc with the pen’s own rules', () => {
    const d = blank()
    const circle = addCircle(d, addPoint(d, 0, 0), 3)
    const e1 = line(d, 3.1, 0, 6, 0)
    const seg = line(d, 10, 0, 10, 8)
    const e2 = line(d, 10.1, 4, 14, 4)
    const A = addPoint(d, 20, 0), B = addPoint(d, 26, 0), C = addPoint(d, 23, 0)
    addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])   // the lower half, lowest at (23, -3)
    const e3 = line(d, 23, -3.1, 23, -7)
    const c = detectOnCurve(buildContext(d, env()))
    const rule = (p: string) => c.find(x => x.anchor[0] === p)?.rules?.[0]
    expect(rule(e1.a)).toEqual({ kind: 'pointOnCircle', refs: [e1.a, circle] })
    expect(rule(e2.a)).toEqual({ kind: 'collinear', refs: [seg.a, seg.b, e2.a] })
    expect(rule(e3.a)).toEqual({ kind: 'equalDist', refs: [C, e3.a, C, A] })
    expect(c.every(x => x.label === 'On curve' && x.kind === 'onCurve')).toBe(true)
  })
  it('near a piece’s end it is a join, not a pin', () => {
    const d = blank()
    line(d, 0, 0, 4, 0)
    const q = line(d, 4.05, 0.1, 6, 3)
    expect(detectOnCurve(buildContext(d, env())).find(x => x.anchor[0] === q.a)).toBeUndefined()
  })
})

describe('detectTangents', () => {
  const r = 3
  function build(kinkDeg: number, sweep: 0 | 1 = 1) {
    const d = blank()
    const k = kinkDeg * Math.PI / 180
    const A = addPoint(d, 0, 0), J = addPoint(d, 4, 0)
    const C = addPoint(d, 4 + r * Math.sin(k), r * Math.cos(k))
    const E = addPoint(d, 4 + r * Math.sin(k) + r, r * Math.cos(k))
    addPath(d, [A, J, E], [{ kind: 'line' }, { kind: 'arc', center: C, sweep }])
    return { d, A, J, C }
  }
  it('a 5° kink between a line and an arc → the joint rule', () => {
    const { d, A, J, C } = build(5)
    const c = detectTangents(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ id: `tangent:${J}`, kind: 'tangent', label: 'Tangent', anchor: [J] })
    expect(c[0]!.rules).toEqual([{ kind: 'perpendicular', refs: [A, J, J, C] }])
  })
  it('a 12° kink is left alone at Normal and smoothed at Strong', () => {
    const { d } = build(12)
    expect(detectTangents(buildContext(d, env()))).toHaveLength(0)
    expect(detectTangents(buildContext(d, env({ s: STRENGTH_FACTOR.strong })))).toHaveLength(1)
  })
  it('a cusp (the arc turning straight back) is not a smooth joint', () => {
    const { d } = build(0, 0)
    expect(detectTangents(buildContext(d, env({ s: STRENGTH_FACTOR.strong })))).toHaveLength(0)
  })
})
