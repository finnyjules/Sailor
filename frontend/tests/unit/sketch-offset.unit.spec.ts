// tests/unit/sketch-offset.unit.spec.ts
// Pen stage 8: Offset, pure — the source (whole paths, runs of picked pieces,
// lines, circles; Bézier refused), lines to parallels and arcs to arcs on the
// same centre meeting sharp, open ends held opposite the source's ends, the
// copy kept live by its rules, too far refused, the pointer's signed
// distance, and speed on one connected drawing.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, PathEntity, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addCircle, addConstraint } from '~/lib/sketch/edit'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { solve } from '~/lib/sketch/solve'
import { toggleFillAt, fillState } from '~/lib/sketch/fills'
import { roundCorners } from '~/lib/sketch/corners'
import { offsetSource, offsetGeom, offsetGeomD, applyOffset, offsetDistanceAt } from '~/lib/sketch/offset'
import { gear, squarePath, rectGrid } from './__fixtures__/penStage8'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any
const allHold = (d: SketchDoc) => constraintResiduals(d).every(v => Math.abs(v) < 1e-7)
/** after a solve: every rule inside the solver's own tolerance (1e-6) */
const solved = (d: SketchDoc) => constraintResiduals(d).every(v => Math.abs(v) < 1e-6)
const chainsOf = (d: SketchDoc, sel: string[], segs: { pathId: string; segIndex: number }[] = []) => {
  const s = offsetSource(d, sel, segs)
  if (!s.ok) throw new Error(s.why)
  return s.chains
}
const copyPath = (d: SketchDoc, created: EntityId[]) => d.entities.find(e => e.kind === 'path' && created.includes(e.id)) as PathEntity

/** Every piece of `copy` sits parallel to the same piece of `src` at signed
 *  distance `dist` (left of travel +): straight pieces by both ends' signed
 *  distance from the source line, arcs on the source's own centre point with
 *  radius less `dist` on their left. */
function expectParallel(d: SketchDoc, src: PathEntity, copy: PathEntity, dist: number) {
  const n = src.anchors.length, count = src.closed ? n : n - 1
  expect(copy.segments).toHaveLength(src.segments.length)
  for (let i = 0; i < count; i++) {
    const A = P(d, src.anchors[i]!), B = P(d, src.anchors[(i + 1) % n]!)
    const a = P(d, copy.anchors[i]!), b = P(d, copy.anchors[(i + 1) % n]!)
    const s = src.segments[i]!, c = copy.segments[i]!
    if (s.kind === 'line') {
      expect(c.kind).toBe('line')
      const L = Math.hypot(B.x - A.x, B.y - A.y)
      const sd = (q: any) => ((B.x - A.x) * (q.y - A.y) - (B.y - A.y) * (q.x - A.x)) / L
      expect(sd(a)).toBeCloseTo(dist, 6); expect(sd(b)).toBeCloseTo(dist, 6)
    } else if (s.kind === 'arc' && c.kind === 'arc') {
      expect(c.center).toBe(s.center); expect(c.sweep).toBe(s.sweep)
      const C = P(d, s.center), R = Math.hypot(A.x - C.x, A.y - C.y), k = s.sweep === 1 ? 1 : -1
      expect(Math.hypot(a.x - C.x, a.y - C.y)).toBeCloseTo(R - k * dist, 6)
      expect(Math.hypot(b.x - C.x, b.y - C.y)).toBeCloseTo(R - k * dist, 6)
    } else throw new Error('piece kinds differ')
  }
}

describe('the source', () => {
  it('a whole closed path, a line, a circle; runs of picked pieces; guides left out; Bézier refused', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 4)
    const l = addLine(d, addPoint(d, 10, 0), addPoint(d, 14, 0))
    const c = addCircle(d, addPoint(d, 20, 0), 2)
    const chains = chainsOf(d, [path, l, c])
    expect(chains.map(k => k.kind)).toEqual(['chain', 'chain', 'circle'])
    expect(chains[0]).toMatchObject({ closed: true })
    expect((chains[0] as any).pieces).toHaveLength(4)
    const runs = chainsOf(d, [], [{ pathId: path, segIndex: 0 }, { pathId: path, segIndex: 1 }, { pathId: path, segIndex: 3 }])
    // 3 → 0 → 1 follow on round the closed path: one run of three
    expect(runs).toHaveLength(1)
    expect((runs[0] as any).pieces).toHaveLength(3)
    expect((runs[0] as any).closed).toBe(false)
    const g = addLine(d, addPoint(d, 0, 9), addPoint(d, 4, 9), { construction: true })
    expect(offsetSource(d, [g], [])).toEqual({ ok: false, why: 'nothing' })
    const h = addPoint(d, 30, 3)
    const bz = addPath(d, [addPoint(d, 30, 0), addPoint(d, 34, 0)], [{ kind: 'cubic', h1: h, h2: null }])
    expect(offsetSource(d, [bz], [])).toEqual({ ok: false, why: 'curve' })
    // a Bézier anywhere in the source refuses the whole offset
    expect(offsetSource(d, [path, bz], [])).toEqual({ ok: false, why: 'curve' })
  })
  it('picked pieces in separate runs offset on their own; every picked piece of a closed path is the closed path', () => {
    const d = doc()
    const pts = [0, 1, 2, 3, 4, 5].map(i => addPoint(d, i, i % 2))
    const open = addPath(d, pts, pts.slice(1).map(() => ({ kind: 'line' as const })))
    const runs = chainsOf(d, [], [0, 1, 3].map(segIndex => ({ pathId: open, segIndex })))
    expect(runs.map(r => (r as any).pieces.length)).toEqual([2, 1])
    const { path } = squarePath(d, 10, 0, 4)
    const all = chainsOf(d, [], [0, 1, 2, 3].map(segIndex => ({ pathId: path, segIndex })))
    expect(all).toHaveLength(1); expect(all[0]).toMatchObject({ closed: true })
    // a path both selected whole and picked by pieces is offset once
    expect(chainsOf(d, [path, path], [{ pathId: path, segIndex: 0 }])).toHaveLength(1)
  })
})

describe('geometry and construction', () => {
  it('a square offset outwards by 1: a square 2 bigger, sharp corners, every rule holding', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 4)   // counter-clockwise: its left is inside
    const chains = chainsOf(d, [path])
    const g = offsetGeom(d, chains, -1)
    expect(g.ok).toBe(true)
    const xs = g.chains[0]!.pts.map(p => [Number(p.x.toFixed(9)), Number(p.y.toFixed(9))])
    expect(xs).toEqual([[-1, -1], [5, -1], [5, 5], [-1, 5]])
    const built = applyOffset(d, chains, -1)
    expect(built.ok).toBe(true)
    expect(d.entities.filter(e => e.kind === 'path')).toHaveLength(2)
    expect(d.constraints.filter(c => c.kind === 'offsetLine')).toHaveLength(8)
    expect(built.rules).toHaveLength(8)
    expect(allHold(d)).toBe(true)
    expect(offsetGeomD(g)).toMatch(/^M -1 -1 L 5 -1 L 5 5 L -1 5 Z$/)
  })
  it('live: a source corner dragged, the copy follows at the same distance', () => {
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 4)
    P(d, pts[0]!).fixed = true
    const copy = applyOffset(d, chainsOf(d, [path]), 1).created
    const cp = copyPath(d, copy)
    expect(solve(d, { drag: { point: pts[2]!, x: 6, y: 6 } }).converged).toBe(true)
    expect(allHold(d)).toBe(true)
    // the inner copy's corner opposite the fixed one sits 1 in from both sides
    const q = P(d, cp.anchors[2]!)
    expect(q.x).toBeLessThan(6); expect(q.y).toBeLessThan(6)
    expectParallel(d, P(d, path), cp, 1)
  })
  it('an open L: its ends sit opposite the source’s ends', () => {
    const d = doc()
    const a = addPoint(d, 0, 4), b = addPoint(d, 0, 0), c = addPoint(d, 4, 0)
    const path = addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
    const built = applyOffset(d, chainsOf(d, [path]), 1)
    expect(built.ok).toBe(true)
    const cp = d.entities.find(e => e.kind === 'path' && e.id !== path) as PathEntity
    const [e0, k, e1] = cp.anchors.map(id => P(d, id))
    // travelling down then right, the left is +x then +y
    expect([e0.x, e0.y]).toEqual([1, 4]); expect([k.x, k.y]).toEqual([1, 1]); expect([e1.x, e1.y]).toEqual([4, 1])
    expect(d.constraints.filter(x => x.kind === 'perpendicular')).toHaveLength(2)
    expect(allHold(d)).toBe(true)
  })
  it('an arc offsets on the same centre point, radius minus the distance on its left', () => {
    const d = doc()
    const ctr = addPoint(d, 0, 0), s = addPoint(d, 3, 0), e = addPoint(d, 0, 3)
    const path = addPath(d, [s, e], [{ kind: 'arc', center: ctr, sweep: 1 }])   // counter-clockwise: left is inside
    const built = applyOffset(d, chainsOf(d, [path]), 1)
    expect(built.ok).toBe(true)
    const cp = d.entities.find(x => x.kind === 'path' && x.id !== path) as PathEntity
    expect(cp.segments[0]).toEqual({ kind: 'arc', center: ctr, sweep: 1 })
    expect(Math.hypot(P(d, cp.anchors[0]!).x, P(d, cp.anchors[0]!).y)).toBeCloseTo(2, 9)
    expect(d.constraints.find(x => x.kind === 'offsetRadius')?.value).toBe(-1)
    expect(allHold(d)).toBe(true)
    // every rule it added is reported (the arc's own rule included)
    const added = new Set(built.rules)
    expect(d.constraints.filter(x => added.has(x.id)).map(x => x.kind).sort()).toEqual(['collinear', 'collinear', 'equalDist', 'offsetRadius'])
  })
  it('a circle offsets to a circle on the same centre', () => {
    const d = doc()
    const ctr = addPoint(d, 0, 0), c = addCircle(d, ctr, 2)
    const built = applyOffset(d, chainsOf(d, [c]), 0.5)
    expect(built.ok).toBe(true)
    const nc = d.entities.find(x => x.kind === 'circle' && x.id !== c) as any
    expect(nc.center).toBe(ctr); expect(nc.r).toBe(2.5)
    expect(d.constraints.find(x => x.kind === 'offsetRadius')?.refs).toEqual([c, nc.id])
  })
  it('a rounded square (tangent joins) offsets both ways with every rule holding as placed', () => {
    for (const dist of [0.5, -0.5]) {
      const d = doc()
      const { path, pts } = squarePath(d, 0, 0, 4)
      expect(roundCorners(d, pts, 'round', 1).ok).toBe(true)
      const src = P(d, path) as PathEntity
      expect(src.segments.filter(s => s.kind === 'arc')).toHaveLength(4)
      const g = offsetGeom(d, chainsOf(d, [path]), dist)
      expect(g.ok).toBe(true)
      const built = applyOffset(d, chainsOf(d, [path]), dist)
      expect(built.ok).toBe(true)
      expect(allHold(d)).toBe(true)
      expectParallel(d, src, copyPath(d, built.created), dist)
    }
    // at pixel scale the tangent joins' carriers only touch within rounding —
    // they must read as smooth joins, not "no crossing" (779 of 800 such
    // shapes refused before the smooth-join case)
    for (let k = 0; k < 20; k++) {
      const n = doc()
      const x0 = 300 + k * 7.13, y0 = 200 + k * 3.7, s = 400 + k * 1.37
      const pts = [[x0, y0], [x0 + s, y0 + k * 0.3], [x0 + s, y0 + s], [x0 - k * 0.2, y0 + s]].map(([x, y]) => addPoint(n, x!, y!))
      const sq = addPath(n, pts, pts.map(() => ({ kind: 'line' as const })), true)
      expect(roundCorners(n, pts, 'round', 37.3 + k).ok).toBe(true)
      for (const dist of [5.3, -20.1]) {
        expect(offsetGeom(n, chainsOf(n, [sq]), dist).ok).toBe(true)
      }
      const built = applyOffset(n, chainsOf(n, [sq]), 5.3)
      expect(constraintResiduals(n).every(v => Math.abs(v) < 1e-7 * 400)).toBe(true)   // hold as placed (drawing-size tolerance)
      expectParallel(n, P(n, sq), copyPath(n, built.created), 5.3)
    }
    // inwards past the corner arcs' radius: too far
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 4)
    roundCorners(d, pts, 'round', 1)
    expect(offsetGeom(d, chainsOf(d, [path]), 1).ok).toBe(false)
  })
  it('too far: inside a small square, past an arc’s centre, a circle to nothing — refused', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 4)
    expect(offsetGeom(d, chainsOf(d, [path]), 2.5).ok).toBe(false)
    expect(offsetGeom(d, chainsOf(d, [path]), 2).ok).toBe(false)     // shrunk to a point
    expect(offsetGeom(d, chainsOf(d, [path]), 1.9).ok).toBe(true)
    const ctr = addPoint(d, 10, 0), s = addPoint(d, 13, 0), e = addPoint(d, 10, 3)
    const arc = addPath(d, [s, e], [{ kind: 'arc', center: ctr, sweep: 1 }])
    expect(offsetGeom(d, chainsOf(d, [arc]), 3).ok).toBe(false)
    expect(offsetGeom(d, chainsOf(d, [arc]), -30).ok).toBe(true)    // outwards: any distance
    const c = addCircle(d, addPoint(d, 20, 0), 1)
    expect(offsetGeom(d, chainsOf(d, [c]), -1).ok).toBe(false)
    expect(offsetGeom(d, chainsOf(d, [c]), 0).ok).toBe(false)
    const before = JSON.stringify(d)
    expect(applyOffset(d, chainsOf(d, [path]), 2.5).ok).toBe(false)
    expect(applyOffset(d, chainsOf(d, [path, c]), -1).ok).toBe(false)  // one chain too far refuses all
    expect(applyOffset(d, chainsOf(d, [path]), 0).ok).toBe(false)
    expect(JSON.stringify(d)).toBe(before)
  })
  it('a tight notch: the short piece turns back before the path collapses — refused', () => {
    // a 10-wide bar with a 1-wide, 3-deep slot in its top (counter-clockwise)
    const d = doc()
    const xy = [[0, 0], [10, 0], [10, 4], [5.5, 4], [5.5, 1], [4.5, 1], [4.5, 4], [0, 4]]
    const pts = xy.map(([x, y]) => addPoint(d, x!, y!))
    const path = addPath(d, pts, pts.map(() => ({ kind: 'line' as const })), true)
    expect(offsetGeom(d, chainsOf(d, [path]), 0.4).ok).toBe(true)
    expect(offsetGeom(d, chainsOf(d, [path]), -0.6).ok).toBe(false)  // outwards: the slot's floor turns back
    expect(offsetGeom(d, chainsOf(d, [path]), -0.4).ok).toBe(true)
  })
  it('preview and refusal never change the drawing', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 4)
    const c = addCircle(d, addPoint(d, 20, 0), 1)
    const chains = chainsOf(d, [path, c])
    const before = JSON.stringify(d)
    offsetGeomD(offsetGeom(d, chains, 0.5)); offsetGeomD(offsetGeom(d, chains, 9))
    offsetDistanceAt(d, chains, { x: 1, y: 1 })
    expect(JSON.stringify(d)).toBe(before)
  })
  it('the copy takes no fill: fills are the same after an offset', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 4)
    expect(toggleFillAt(d, { x: 2, y: 2 }, 0)).toBe(true)
    const fills = JSON.stringify(d.fills)
    for (const dist of [-1, 1]) expect(applyOffset(d, chainsOf(d, [path]), dist).ok).toBe(true)
    expect(JSON.stringify(d.fills)).toBe(fills)
    expect(fillState(d).filled).toHaveLength(1)
  })
  it('the pointer’s signed distance: left of travel positive, a circle outside positive', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 4)
    const chains = chainsOf(d, [path])
    expect(offsetDistanceAt(d, chains, { x: 2, y: 1 })).toBeCloseTo(1, 9)     // inside = left of a ccw square
    expect(offsetDistanceAt(d, chains, { x: 2, y: -1.5 })).toBeCloseTo(-1.5, 9)
    const c = addCircle(d, addPoint(d, 20, 0), 2)
    expect(offsetDistanceAt(d, chainsOf(d, [c]), { x: 23, y: 0 })).toBeCloseTo(1, 9)
    expect(offsetDistanceAt(d, chainsOf(d, [c]), { x: 20.5, y: 0 })).toBeCloseTo(-1.5, 9)
    const ctr = addPoint(d, 40, 0), s = addPoint(d, 43, 0), e = addPoint(d, 40, 3)
    const arc = addPath(d, [s, e], [{ kind: 'arc', center: ctr, sweep: 0 }])   // clockwise the long way: left is outside
    expect(offsetDistanceAt(d, chainsOf(d, [arc]), { x: 40, y: -4 })).toBeCloseTo(1, 9)
  })
})

describe('live: moving the source keeps the copy parallel at the distance, both sides', () => {
  for (const dist of [0.5, -0.5]) {
    it(`a line (${dist})`, () => {
      const d = doc()
      const a = addPoint(d, 0, 0, { fixed: true }), b = addPoint(d, 4, 0)
      const l = addLine(d, a, b)
      const built = applyOffset(d, chainsOf(d, [l]), dist)
      expect(built.ok).toBe(true)
      expect(allHold(d)).toBe(true)
      expect(solve(d, { drag: { point: b, x: 3, y: 3 } }).converged).toBe(true)
      expect(solved(d)).toBe(true)
      const cp = copyPath(d, built.created)
      const src: PathEntity = { id: '~', kind: 'path', anchors: [a, b], segments: [{ kind: 'line' }], closed: false }
      expectParallel(d, src, cp, dist)
      // the ends stay opposite the source's ends
      const e0 = P(d, cp.anchors[0]!), e1 = P(d, cp.anchors[1]!), B = P(d, b)
      expect(Math.hypot(e0.x, e0.y)).toBeCloseTo(Math.abs(dist), 6)
      expect(Math.hypot(e1.x - B.x, e1.y - B.y)).toBeCloseTo(Math.abs(dist), 6)
    })
    it(`an arc, on the same centre point (${dist})`, () => {
      const d = doc()
      const ctr = addPoint(d, 0, 0, { fixed: true }), s = addPoint(d, 3, 0), e = addPoint(d, 0, 3)
      const path = addPath(d, [s, e], [{ kind: 'arc', center: ctr, sweep: 1 }])
      const built = applyOffset(d, chainsOf(d, [path]), dist)
      expect(built.ok).toBe(true)
      expect(solve(d, { drag: { point: s, x: 4, y: 1 } }).converged).toBe(true)
      expect(solved(d)).toBe(true)
      expectParallel(d, P(d, path), copyPath(d, built.created), dist)
    })
    it(`a circle, on the same centre (${dist})`, () => {
      const d = doc()
      const ctr = addPoint(d, 0, 0), c = addCircle(d, ctr, 2)
      const rad = addConstraint(d, 'radius', [c], 2)
      const built = applyOffset(d, chainsOf(d, [c]), dist)
      expect(built.ok).toBe(true)
      d.constraints.find(x => x.id === rad)!.value = 3
      expect(solve(d, { drag: { point: ctr, x: 5, y: 1 } }).converged).toBe(true)
      expect(solved(d)).toBe(true)
      const nc = d.entities.find(x => x.kind === 'circle' && built.created.includes(x.id)) as any
      expect(nc.center).toBe(ctr)
      expect(nc.r).toBeCloseTo(3 + dist, 6)
    })
    it(`an open chain of a line and an arc (${dist})`, () => {
      const d = doc()
      const a = addPoint(d, -4, 0, { fixed: true }), b = addPoint(d, 0, 0), ctr = addPoint(d, 0, 3), e = addPoint(d, 3, 3)
      // straight along +x, then a counter-clockwise quarter turn up, kept tangent
      const path = addPath(d, [a, b, e], [{ kind: 'line' }, { kind: 'arc', center: ctr, sweep: 1 }])
      addConstraint(d, 'perpendicular', [a, b, b, ctr])
      const built = applyOffset(d, chainsOf(d, [path]), dist)
      expect(built.ok).toBe(true)
      expect(allHold(d)).toBe(true)
      expect(solve(d, { drag: { point: e, x: 3.5, y: 2.5 } }).converged).toBe(true)
      expect(solved(d)).toBe(true)
      expectParallel(d, P(d, path), copyPath(d, built.created), dist)
    })
    it(`a closed chain with a sharp corner between a line and an arc (${dist})`, () => {
      const d = doc()
      // a D: a straight back and an arc bulging to the right, counter-clockwise
      const top = addPoint(d, 0, 3), bot = addPoint(d, 0, -3, { fixed: true }), ctr = addPoint(d, 0, 0)
      const path = addPath(d, [bot, top], [{ kind: 'arc', center: ctr, sweep: 1 }, { kind: 'line' }], true)
      const built = applyOffset(d, chainsOf(d, [path]), dist)
      expect(built.ok).toBe(true)
      expect(allHold(d)).toBe(true)
      expect(solve(d, { drag: { point: top, x: 0.5, y: 3.5 } }).converged).toBe(true)
      expect(solved(d)).toBe(true)
      expectParallel(d, P(d, path), copyPath(d, built.created), dist)
    })
  }
})

describe('smooth joins stay solvable (fix round 1)', () => {
  const maxRes = (d: SketchDoc) => Math.max(...constraintResiduals(d).map(Math.abs))
  const size = (d: SketchDoc) => {
    const ps = d.entities.filter(e => e.kind === 'point') as any[]
    return Math.max(Math.max(...ps.map(p => p.x)) - Math.min(...ps.map(p => p.x)), Math.max(...ps.map(p => p.y)) - Math.min(...ps.map(p => p.y)))
  }
  for (const dist of [0.5, -0.5, -3]) {
    it(`a rounded square offset ${dist}, a source anchor dragged: converges, rules hold, copy parallel`, () => {
      const d = doc()
      const { path, pts } = squarePath(d, 0, 0, 4)
      P(d, pts[0]!).fixed = true
      expect(roundCorners(d, pts, 'round', 1).ok).toBe(true)
      const built = applyOffset(d, chainsOf(d, [path]), dist)
      expect(built.ok).toBe(true)
      expect(maxRes(d)).toBeLessThan(1e-7 * size(d))
      // the four tangent joins are held on the corner arcs' radial lines
      expect(d.constraints.filter(c => built.rules.includes(c.id) && c.kind === 'collinear')).toHaveLength(8)
      const src = P(d, path) as PathEntity
      const q = P(d, src.anchors[3]!)
      const r = solve(d, { drag: { point: q.id, x: q.x + 0.7, y: q.y + 0.4 } })
      expect(r.converged).toBe(true)
      expect(r.iterations).toBeLessThan(20)
      expect(maxRes(d)).toBeLessThan(1e-7 * size(d))
      expectParallel(d, src, copyPath(d, built.created), dist)
    })
  }
  for (const dist of [0.5, -0.5]) {
    it(`arc to arc: an S of two arcs (${dist}) and a circle drawn as two arcs (${dist})`, () => {
      const d = doc()
      const c1 = addPoint(d, 0, 0, { fixed: true }), a = addPoint(d, 3, 0, { fixed: true }), x = addPoint(d, 0, 3)
      const c2 = addPoint(d, 0, 6), b = addPoint(d, -3, 6)
      const s = addPath(d, [a, x, b], [{ kind: 'arc', center: c1, sweep: 1 }, { kind: 'arc', center: c2, sweep: 0 }])
      addConstraint(d, 'collinear', [c1, x, c2])   // kept smooth
      const ctr = addPoint(d, 20, 0, { fixed: true }), p = addPoint(d, 23, 0), q = addPoint(d, 17, 0)
      const ring = addPath(d, [p, q], [{ kind: 'arc', center: ctr, sweep: 1 }, { kind: 'arc', center: ctr, sweep: 1 }], true)
      const b1 = applyOffset(d, chainsOf(d, [s]), dist), b2 = applyOffset(d, chainsOf(d, [ring]), dist)
      expect(b1.ok && b2.ok).toBe(true)
      expect(maxRes(d)).toBeLessThan(1e-7 * size(d))
      // the loop of arcs keeps one radius rule, so the copy can't drift in size
      expect(d.constraints.filter(c => b2.rules.includes(c.id) && c.kind === 'offsetRadius')).toHaveLength(1)
      const r = solve(d, { drag: { point: b, x: -3.3, y: 6.5 } })
      expect(r.converged).toBe(true); expect(r.iterations).toBeLessThan(20)
      const r2 = solve(d, { drag: { point: p, x: 24, y: 1 } })
      expect(r2.converged).toBe(true); expect(r2.iterations).toBeLessThan(20)
      expect(maxRes(d)).toBeLessThan(1e-7 * size(d))
      expectParallel(d, P(d, s), copyPath(d, b1.created), dist)
      expectParallel(d, P(d, ring), copyPath(d, b2.created), dist)
    })
  }
})

describe('the copy crossing itself (fix round 1)', () => {
  it('a dumbbell offset inside past its neck is refused; short of it, allowed', () => {
    const d = doc()
    const xy = [[-4, -2], [0, -2], [0, -0.2], [2, -0.2], [2, -2], [6, -2], [6, 2], [2, 2], [2, 0.2], [0, 0.2], [0, 2], [-4, 2]]
    const pts = xy.map(([x, y]) => addPoint(d, x!, y!))
    const path = addPath(d, pts, pts.map(() => ({ kind: 'line' as const })), true)
    const chains = chainsOf(d, [path])
    expect(offsetGeom(d, chains, 0.1).ok).toBe(true)
    expect(offsetGeom(d, chains, 0.3).ok).toBe(false)
    expect(offsetGeom(d, chains, 0.5).ok).toBe(false)
    expect(offsetGeom(d, chains, -0.5).ok).toBe(true)
    const before = JSON.stringify(d)
    expect(applyOffset(d, chains, 0.3).ok).toBe(false)
    expect(JSON.stringify(d)).toBe(before)
  })
  it('a source that already crosses itself (a figure eight) still offsets a little', () => {
    const d = doc()
    const xy = [[-2, -1], [2, 1], [2, -1], [-2, 1]]
    const pts = xy.map(([x, y]) => addPoint(d, x!, y!))
    const path = addPath(d, pts, pts.map(() => ({ kind: 'line' as const })), true)
    const x8 = [[-1, -1], [1, 1], [4, 1], [4, -1], [1, -1], [-1, 1], [-4, 1], [-4, -1]]   // crosses at its waist
    const qs = x8.map(([x, y]) => addPoint(d, x! + 20, y!))
    const eight = addPath(d, qs, qs.map(() => ({ kind: 'line' as const })), true)
    for (const dist of [0.1, -0.1]) {
      expect(offsetGeom(d, chainsOf(d, [path]), dist).ok).toBe(true)
      expect(offsetGeom(d, chainsOf(d, [eight]), dist).ok).toBe(true)
    }
    // two ends nearly touching (not crossing) that an offset pushes across: refused
    const nq = [[0, 0], [3, 2], [5, 0], [3, -2], [0, 0.0001], [-3, 2], [-5, 0], [-3, -2]].map(([x, y]) => addPoint(d, x! + 40, y!))
    const near = addPath(d, nq, nq.map(() => ({ kind: 'line' as const })), true)
    expect(offsetGeom(d, chainsOf(d, [near]), 0.1).ok).toBe(false)
  })
})

describe('speed (one connected drawing, a symmetric grid)', () => {
  it('a preview frame of the 150-piece gear stays inside 16 ms', () => {
    const { doc: g, path } = gear(150)
    const chains = chainsOf(g, [path])
    offsetGeom(g, chains, -0.1)
    const t = performance.now()
    for (let i = 0; i < 10; i++) { const og = offsetGeom(g, chains, -0.1 - i * 0.01); offsetGeomD(og); offsetDistanceAt(g, chains, { x: 12, y: 0 }) }
    expect((performance.now() - t) / 10).toBeLessThan(16)
    expect(offsetGeom(g, chains, -0.1).ok).toBe(true)
  })
  it('a preview frame of 37 rectangles stays inside 16 ms', () => {
    const { doc: g, paths } = rectGrid(37)
    const chains = chainsOf(g, paths)
    offsetGeom(g, chains, -0.1)
    const t = performance.now()
    for (let i = 0; i < 10; i++) { const og = offsetGeom(g, chains, -0.1 - i * 0.01); offsetGeomD(og); offsetDistanceAt(g, chains, { x: 3, y: 3 }) }
    expect((performance.now() - t) / 10).toBeLessThan(16)
    expect(offsetGeom(g, chains, -0.1).ok).toBe(true)
    expect(offsetGeom(g, chains, 0.25).ok).toBe(true)
    expect(offsetGeom(g, chains, 0.3).ok).toBe(false)               // 0.6 tall: too far inside
  })
})
