// tests/unit/sketch-trim-autojoin.unit.spec.ts
// Trim auto-join: after Trim removes a piece, wherever the trim's own end
// points are now the end of exactly two open paths, the two become one path,
// and a path whose two ends met closes. Nothing moves, rules survive; joins
// happen only at the trim's own ends (never elsewhere), never onto a line
// entity, never between a guide and a drawn piece, never at a three-way meeting.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId, PathEntity } from '~/lib/sketch/model'
import { getEntity, getPoint } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { nearestCurve, spanAt } from '~/lib/sketch/crossings'
import { solve } from '~/lib/sketch/solve'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { cloneDoc } from '~/lib/sketch/clone'
import { removeSpan } from '~/lib/sketch/trim'
import { fillState, toggleFillAt, reconcileFills } from '~/lib/sketch/fills'

const emptyDoc = (): SketchDoc => ({ entities: [], constraints: [] })
const paths = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path') as PathEntity[]
const pos = (d: SketchDoc, id: EntityId) => { const p = getPoint(d, id)!; return { x: p.x, y: p.y } }

// trim the piece nearest (x, y), as a Trim click there would
function trimAt(d: SketchDoc, x: number, y: number) {
  const hit = nearestCurve(d, { x, y }, 0.5)
  expect(hit).toBeTruthy()
  const res = removeSpan(d, spanAt(d, hit!.ref, hit!.t)!)
  expect(res.ok).toBe(true)
  return res
}

// every point keeps its position through a solve (the edit didn't change the drawing)
function expectSolveKeepsGeometry(d: SketchDoc) {
  const before = new Map(d.entities.filter(e => e.kind === 'point').map(e => [e.id, pos(d, e.id)]))
  solve(d)
  for (const [id, p] of before) {
    const q = pos(d, id)
    expect(Math.abs(q.x - p.x)).toBeLessThan(1e-6)
    expect(Math.abs(q.y - p.y)).toBeLessThan(1e-6)
  }
}

const linePath = (d: SketchDoc, pts: number[][], opts: { construction?: boolean } = {}) => {
  const ids = pts.map(([x, y]) => addPoint(d, x!, y!))
  const id = addPath(d, ids, ids.slice(1).map(() => ({ kind: 'line' as const })), false)
  if (opts.construction) (getEntity(d, id) as PathEntity).construction = true
  return id
}
// the open paths ending at the point at (x, y)
const endsAt = (d: SketchDoc, x: number, y: number) => paths(d).filter(p => {
  if (p.closed) return false
  return [p.anchors[0]!, p.anchors[p.anchors.length - 1]!].some(a => {
    const q = pos(d, a)
    return Math.hypot(q.x - x, q.y - y) < 1e-9
  })
})

function lens(d: SketchDoc) {
  const C1 = addPoint(d, 0, 0), C2 = addPoint(d, 12, 0)
  addCircle(d, C1, 10)
  addCircle(d, C2, 10)
  return { C1, C2 }
}

describe('Trim auto-join', () => {
  it('lens: trimming both outer halves leaves ONE closed path of two arcs; nothing moves', () => {
    const d = emptyDoc()
    lens(d)
    trimAt(d, -10, 0)
    const first = paths(d)[0]!.id
    trimAt(d, 22, 0)
    const ps = paths(d)
    expect(ps).toHaveLength(1)
    expect(ps[0]!.closed).toBe(true)
    expect(ps[0]!.segments.map(s => s.kind)).toEqual(['arc', 'arc'])
    expect(ps[0]!.anchors).toHaveLength(2)
    // the path that was there before the second trim keeps its id
    expect(ps[0]!.id).toBe(first)
    expect(d.entities.some(e => e.kind === 'circle')).toBe(false)
    expectSolveKeepsGeometry(d)
  })

  it('3-petal flower: the outline becomes one closed path of six arcs', () => {
    const d = emptyDoc()
    addCircle(d, addPoint(d, 0, 0), 5)
    const ang = [0, 1, 2].map(k => k * 2 * Math.PI / 3)
    for (const a of ang) addCircle(d, addPoint(d, 7 * Math.cos(a), 7 * Math.sin(a)), 5)
    for (const a of ang) trimAt(d, 5 * Math.cos(a), 5 * Math.sin(a))   // the centre circle inside each petal
    for (const a of ang) trimAt(d, 2 * Math.cos(a), 2 * Math.sin(a))   // each petal's inner arc
    const ps = paths(d)
    expect(ps).toHaveLength(1)
    expect(ps[0]!.closed).toBe(true)
    expect(ps[0]!.segments).toHaveLength(6)
    expect(ps[0]!.segments.every(s => s.kind === 'arc')).toBe(true)
    expectSolveKeepsGeometry(d)
  })

  // A bar H from (-2,0) to (12,0) with legs going up from (0,0) and (10,0) and
  // a separate top path joining the legs' tops. Trimming the bar's overhangs
  // makes each leg's foot a trim end.
  function uShape(d: SketchDoc, leftLeg: 'path' | 'guide' | 'line' = 'path') {
    const H = linePath(d, [[-2, 0], [12, 0]])
    let V1: EntityId
    if (leftLeg === 'line') V1 = addLine(d, addPoint(d, 0, 0), addPoint(d, 0, 10))
    else V1 = linePath(d, [[0, 0], [0, 10]], { construction: leftLeg === 'guide' })
    const V2 = linePath(d, [[10, 0], [10, 10]])
    const T = linePath(d, [[0, 10], [10, 10]])
    return { H, V1, V2, T }
  }

  it('joins only at the trim\'s own ends; a separately drawn path sharing points elsewhere stays', () => {
    const d = emptyDoc()
    const { H, V1, V2, T } = uShape(d)
    trimAt(d, -1, 0)
    trimAt(d, 11, 0)
    const ps = paths(d)
    expect(ps.map(p => p.id).sort()).toEqual([H, T].sort())
    const joined = getEntity(d, H) as PathEntity
    expect(joined.closed).toBe(false)
    expect(joined.anchors.map(a => pos(d, a))).toEqual([{ x: 0, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
    expect(getEntity(d, V1)).toBeUndefined()
    expect(getEntity(d, V2)).toBeUndefined()
    // the top path still meets the joined path at its ends, but those are not trim ends
    expect((getEntity(d, T) as PathEntity).closed).toBe(false)
    expectSolveKeepsGeometry(d)
  })

  it('T-junction: three open paths ending at a trim end → no join there', () => {
    const d = emptyDoc()
    const { H, V1, V2 } = uShape(d)
    // a third path from the left leg's own foot point
    const foot = (getEntity(d, V1) as PathEntity).anchors[0]!
    const V3 = addPath(d, [foot, addPoint(d, -5, -5)], [{ kind: 'line' }], false)
    trimAt(d, -1, 0)
    trimAt(d, 11, 0)
    expect(endsAt(d, 0, 0).map(p => p.id).sort()).toEqual([H, V1, V3].sort())
    expect(getEntity(d, V2)).toBeUndefined()   // the other end did join
    expectSolveKeepsGeometry(d)
  })

  it('a guide and a drawn piece meeting at a trim end → no join', () => {
    const d = emptyDoc()
    const { H, V1, V2 } = uShape(d, 'guide')
    trimAt(d, -1, 0)
    trimAt(d, 11, 0)
    expect(endsAt(d, 0, 0).map(p => p.id).sort()).toEqual([H, V1].sort())
    expect((getEntity(d, V1) as PathEntity).construction).toBe(true)
    expect(getEntity(d, V2)).toBeUndefined()
  })

  it('a line-tool line entity meeting a path at a trim end → no join, the line is untouched', () => {
    const d = emptyDoc()
    const { H, V1, V2 } = uShape(d, 'line')
    const line = { ...(getEntity(d, V1) as object) }
    trimAt(d, -1, 0)
    trimAt(d, 11, 0)
    expect(getEntity(d, V1)).toEqual(line)
    expect(getEntity(d, V2)).toBeUndefined()
    const h = getEntity(d, H) as PathEntity
    expect(pos(d, h.anchors[0]!)).toEqual({ x: 0, y: 0 })
    expect(h.anchors[0]).toBe((line as { p1: EntityId }).p1)
    expectSolveKeepsGeometry(d)
  })

  it('a trim whose ends touch nothing leaves the pieces as before', () => {
    const d = emptyDoc()
    const P = linePath(d, [[0, 0], [10, 0], [10, 10]])
    addLine(d, addPoint(d, 3, -5), addPoint(d, 3, 5))
    addLine(d, addPoint(d, 6, -5), addPoint(d, 6, 5))
    trimAt(d, 4.5, 0)
    const ps = paths(d)
    expect(ps).toHaveLength(2)
    expect(ps[0]!.id).toBe(P)
    expect(ps.map(p => p.anchors.map(a => pos(d, a)))).toEqual([
      [{ x: 0, y: 0 }, { x: 3, y: 0 }],
      [{ x: 6, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    ])
    expect(ps.every(p => !p.closed)).toBe(true)
  })

  it('a filled lens stays filled through the trims that join its outline', () => {
    const d = emptyDoc()
    lens(d)
    expect(toggleFillAt(d, { x: 6, y: 0 }, 0)).toBe(true)
    const id = d.fills![0]!.id
    for (const [x, y] of [[-10, 0], [22, 0]]) {
      const before = cloneDoc(d)
      trimAt(d, x!, y!)
      d.fills = reconcileFills(before, d)
      expect(fillState(d).filled).toHaveLength(1)
    }
    expect(d.fills!.map(f => f.id)).toEqual([id])
    const ps = paths(d)
    expect(ps).toHaveLength(1)
    expect(ps[0]!.closed).toBe(true)
  })

  it('rules on the pieces (a tangent line, an equal radius) still hold after the join', () => {
    const d = emptyDoc()
    const { C1, C2 } = lens(d)
    trimAt(d, -10, 0)
    const arc = paths(d)[0]!
    const S = arc.anchors[0]!
    // a short line tangent to the remaining arc of circle 1 at (10, 0)
    const A = addPoint(d, 10, -1), B = addPoint(d, 10, 1)
    addLine(d, A, B)
    addConstraint(d, 'tangentLineArc', [A, B, C1, S])
    // circle 1's arc and circle 2's arc-to-be have the same radius
    addConstraint(d, 'equalDist', [C1, S, C2, S])
    const n = d.constraints.length
    const res = trimAt(d, 22, 0)
    expect(res.droppedRules).toBe(0)
    const ps = paths(d)
    expect(ps).toHaveLength(1)
    expect(ps[0]!.closed).toBe(true)
    expect(d.constraints.some(c => c.kind === 'tangentLineArc' && c.refs.join() === [A, B, C1, S].join())).toBe(true)
    expect(d.constraints.some(c => c.kind === 'equalDist' && c.refs.join() === [C1, S, C2, S].join())).toBe(true)
    expect(d.constraints.length).toBeGreaterThanOrEqual(n - 1)
    for (const r of constraintResiduals(d)) expect(Math.abs(r)).toBeLessThan(1e-6)
    expectSolveKeepsGeometry(d)
  })
})
