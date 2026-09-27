// tests/unit/sketch-repeat-modes.unit.spec.ts
// Pen stage 8: Repeat's modes, pure — radial with a sweep, linear (live by
// translatedFrom, Step or Span), along a path (placed once, not tied), fills
// carried, the preview drawing exactly what the copies draw, and speed on a
// symmetric grid and one connected drawing.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addCircle, repeatEntities, translateEntities, copyAlongPath } from '~/lib/sketch/edit'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { solve } from '~/lib/sketch/solve'
import { sketchPathData } from '~/lib/sketch/sketchPath'
import { toggleFillAt, fillState, fillTarget } from '~/lib/sketch/fills'
import { analyzeDerived } from '~/lib/sketch/substitute'
import { radialAngles, linearFactors, selectionCentre, alongPoints, radialPlacements, linearPlacements, copiesPreviewD } from '~/lib/sketch/repeatModes'
import { gear, rectGrid, squarePath } from './__fixtures__/penStage8'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any
const allHold = (d: SketchDoc) => constraintResiduals(d).every(v => Math.abs(v) < 1e-7)
const onlyThese = (d: SketchDoc, ids: EntityId[]): SketchDoc => {
  const keep = new Set(ids)
  return { entities: d.entities.filter(e => keep.has(e.id) || e.kind === 'point'), constraints: [] }
}

describe('placements', () => {
  it('radial angles: the full turn evenly, or 0 to the sweep inclusive; linear factors', () => {
    expect(radialAngles(6)).toEqual([60, 120, 180, 240, 300])
    expect(radialAngles(4, 90)).toEqual([30, 60, 90])
    expect(radialAngles(1)).toEqual([]); expect(radialAngles(65)).toEqual([]); expect(radialAngles(3, 0)).toEqual([])
    expect(linearFactors(4, 'step')).toEqual([1, 2, 3])
    expect(linearFactors(3, 'span')).toEqual([0.5, 1])
  })
  it('the selection’s centre: the box round its points, a circle by its full extent', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 2)
    const c = addCircle(d, addPoint(d, 10, 0), 1)
    expect(selectionCentre(d, [path])).toEqual({ x: 1, y: 1 })
    expect(selectionCentre(d, [path, c])).toEqual({ x: 5.5, y: 0.5 })
  })
})

describe('radial with a sweep', () => {
  it('four copies over 90°: at 30°, 60°, 90° — and the default sweep is today’s', () => {
    const d = doc()
    const ctr = addPoint(d, 0, 0, { fixed: true }), a = addPoint(d, 1, 0), b = addPoint(d, 2, 0)
    const l = addLine(d, a, b)
    const made = repeatEntities(d, [l], ctr, 4, 90)
    expect(made).toHaveLength(3)
    expect(d.constraints.filter(c => c.kind === 'rotatedFrom').map(c => c.value)).toEqual([30, 30, 60, 60, 90, 90])
    const d2 = doc()
    const c2 = addPoint(d2, 0, 0, { fixed: true }), l2 = addLine(d2, addPoint(d2, 1, 0), addPoint(d2, 2, 0))
    repeatEntities(d2, [l2], c2, 6)
    expect(d2.constraints.filter(c => c.kind === 'rotatedFrom').map(c => c.value)).toEqual([60, 60, 120, 120, 180, 180, 240, 240, 300, 300])
  })
})

describe('linear', () => {
  it('Step: copies one step apart, tied by translatedFrom; dragging the guide’s end moves them', () => {
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 1)
    const from = addPoint(d, 0.5, 0.5, { construction: true, fixed: true }), to = addPoint(d, 2.5, 0.5, { construction: true })
    addLine(d, from, to, { construction: true })
    const made = translateEntities(d, [path], from, to, 3, 'step')
    expect(made).toHaveLength(2)
    const tf = d.constraints.filter(c => c.kind === 'translatedFrom')
    expect(tf.map(c => c.value)).toEqual([1, 1, 1, 1, 2, 2, 2, 2])
    expect(allHold(d)).toBe(true)
    const copyOfFirst = (k: number) => P(d, tf.filter(c => c.refs[1] === pts[0])[k]!.refs[0]!)
    expect([copyOfFirst(1).x, copyOfFirst(1).y]).toEqual([4, 0])
    expect(solve(d, { drag: { point: to, x: 0.5, y: 3.5 } }).converged).toBe(true)
    expect(copyOfFirst(1).x).toBeCloseTo(0, 6); expect(copyOfFirst(1).y).toBeCloseTo(6, 6)
  })
  it('Span: the copies share out the span', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 1)
    const from = addPoint(d, 0, 0, { construction: true }), to = addPoint(d, 4, 0, { construction: true })
    translateEntities(d, [path], from, to, 3, 'span')
    expect([...new Set(d.constraints.filter(c => c.kind === 'translatedFrom').map(c => c.value))]).toEqual([0.5, 1])
  })
  it('refuses a bad count or a selection that uses the guide', () => {
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 1)
    const to = addPoint(d, 3, 0)
    expect(translateEntities(d, [path], pts[0]!, to, 3, 'step')).toEqual([])
    const from = addPoint(d, 0, 0)
    expect(translateEntities(d, [path], from, to, 1, 'step')).toEqual([])
    expect(translateEntities(d, [path], from, to, 65, 'step')).toEqual([])
  })
  it('a filled square’s copies are filled too', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 1)
    toggleFillAt(d, { x: 0.5, y: 0.5 }, 0)
    const from = addPoint(d, 0, 0, { construction: true }), to = addPoint(d, 2, 0, { construction: true })
    translateEntities(d, [path], from, to, 3, 'step')
    expect(fillState(d).filled).toHaveLength(3)
  })
})

describe('along a path', () => {
  it('an open line: the copies land at the middle and the end; nothing ties them', () => {
    const d = doc()
    const { path } = squarePath(d, -0.5, -0.5, 1)          // centred on (0, 0)
    const rail = addPath(d, [addPoint(d, 0, -5), addPoint(d, 10, -5)], [{ kind: 'line' }])
    expect(alongPoints(d, rail, 3)).toEqual([{ x: 5, y: -5 }, { x: 10, y: -5 }])
    const before = d.constraints.length
    const made = copyAlongPath(d, [path], rail, 3)
    expect(made).toHaveLength(2)
    expect(d.constraints.length).toBe(before)                // no rule ties a copy to the original
    const centres = made.map(ids => selectionCentre(d, ids.filter(id => P(d, id).kind === 'path')))
    expect(centres).toEqual([{ x: 5, y: -5 }, { x: 10, y: -5 }])
  })
  it('a circle: spread round it from angle 0; a Bézier path or a path being repeated is refused', () => {
    const d = doc()
    const { path } = squarePath(d, -0.5, -0.5, 1)
    const ring = addCircle(d, addPoint(d, 20, 0), 5)
    const pts = alongPoints(d, ring, 4)!.map(p => [Number(p.x.toFixed(9)), Number(p.y.toFixed(9))])
    expect(pts).toEqual([[20, 5], [15, 0], [20, -5]])
    const h = addPoint(d, 3, 9)
    const bz = addPath(d, [addPoint(d, 0, 8), addPoint(d, 6, 8)], [{ kind: 'cubic', h1: h, h2: null }])
    expect(copyAlongPath(d, [path], bz, 3)).toEqual([])
    expect(copyAlongPath(d, [path], path, 3)).toEqual([])
  })
})

describe('the preview draws exactly what the copies draw', () => {
  it('radial and linear', () => {
    const d = doc()
    const { path } = squarePath(d, 1, 0, 1)
    const ctr = addPoint(d, 0, 0, { fixed: true })
    const pv = copiesPreviewD(d, [path], radialPlacements({ x: 0, y: 0 }, 5, 360))
    const real = structuredClone(d)
    const made = repeatEntities(real, [path], ctr, 5)
    expect(pv).toBe(sketchPathData(onlyThese(real, made.flat())))
    const lv = copiesPreviewD(d, [path], linearPlacements({ x: 3, y: 1 }, 4, 'step'))
    const real2 = structuredClone(d)
    const f = addPoint(real2, 0, 0), t = addPoint(real2, 3, 1)
    const made2 = translateEntities(real2, [path], f, t, 4, 'step')
    expect(lv).toBe(sketchPathData(onlyThese(real2, made2.flat())))
  })
})

describe('speed (a symmetric grid, one connected drawing)', () => {
  it('a Repeat preview of 37 rectangles ×12 and along the 150-piece gear stay inside 16 ms', () => {
    const { doc: grid, paths } = rectGrid(37)
    copiesPreviewD(grid, paths, radialPlacements({ x: 6, y: 5 }, 12))
    let t = performance.now()
    for (let i = 0; i < 5; i++) copiesPreviewD(grid, paths, radialPlacements({ x: 6, y: 5 }, 12, 360 - i))
    expect((performance.now() - t) / 5).toBeLessThan(16)
    t = performance.now()
    for (let i = 0; i < 5; i++) copiesPreviewD(grid, paths, linearPlacements({ x: 0, y: 20 + i }, 12, 'step'))
    expect((performance.now() - t) / 5).toBeLessThan(16)
    const { doc: g, path } = gear(150)
    t = performance.now()
    for (let i = 0; i < 5; i++) alongPoints(g, path, 64)
    expect((performance.now() - t) / 5).toBeLessThan(16)
  })
})


// ── the task's binding extras ───────────────────────────────────────────────

describe('radial: the full turn is byte-identical to before', () => {
  it('sweep 360 and no sweep make the same drawing, points where the old arithmetic put them', () => {
    const build = (sweep?: number) => {
      const d = doc()
      const ctr = addPoint(d, 0.3, -0.7, { fixed: true })
      const { path } = squarePath(d, 1, 0.25, 1.5)
      toggleFillAt(d, { x: 1.75, y: 1 }, 0)
      const made = sweep == null ? repeatEntities(d, [path], ctr, 7) : repeatEntities(d, [path], ctr, 7, sweep)
      return { d, made, ctr }
    }
    const a = build(), b = build(360)
    expect(JSON.stringify(b.d)).toBe(JSON.stringify(a.d))
    // today's arithmetic, written out: angle = k·(360/count), cos/sin of it, c + R·(p − c)
    const ce = P(a.d, a.ctr)
    for (const c of a.d.constraints.filter(c => c.kind === 'rotatedFrom')) {
      const [copy, orig] = c.refs
      const k = Math.round(c.value! / (360 / 7))
      const angle = k * (360 / 7), rad = angle * Math.PI / 180, co = Math.cos(rad), si = Math.sin(rad)
      const o = P(a.d, orig!), q = P(a.d, copy!)
      const dx = o.x - ce.x, dy = o.y - ce.y
      expect(c.value).toBe(angle)
      expect(q.x).toBe(ce.x + co * dx - si * dy)
      expect(q.y).toBe(ce.y + si * dx + co * dy)
    }
    expect(fillState(a.d).filled).toHaveLength(7)
  })
})

describe('linear: live, substituted, refusals leave the drawing alone', () => {
  const setup = () => {
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 1)
    const from = addPoint(d, 0.5, 0.5, { construction: true, fixed: true }), to = addPoint(d, 2.5, 0.5, { construction: true })
    addLine(d, from, to, { construction: true })
    const made = translateEntities(d, [path], from, to, 4, 'step')
    return { d, path, pts, from, to, made }
  }
  it('moving the original, then solving: the copies follow and every rule holds', () => {
    const { d, pts } = setup()
    const tf = d.constraints.filter(c => c.kind === 'translatedFrom' && c.refs[1] === pts[2])
    expect(solve(d, { drag: { point: pts[2]!, x: 1.5, y: 1.25 } }).converged).toBe(true)
    expect(Math.max(...constraintResiduals(d).map(Math.abs))).toBeLessThan(1e-7)
    for (const c of tf) {
      const q = P(d, c.refs[0]!), o = P(d, pts[2]!)
      expect(q.x).toBeCloseTo(o.x + c.value! * 2, 6); expect(q.y).toBeCloseTo(o.y, 6)
    }
    expect(P(d, pts[2]!).x).toBeCloseTo(1.5, 6)
  })
  it('every copy point is derived by the solver’s substitution, not a free variable', () => {
    const { d } = setup()
    const tf = d.constraints.filter(c => c.kind === 'translatedFrom')
    expect(tf).toHaveLength(12)
    const an = analyzeDerived(d, new Set())
    for (const c of tf) {
      const r = an.rules.get(c.refs[0]!)
      expect(r?.kind).toBe('translatedFrom')
      expect(r?.constraintId).toBe(c.id)
      expect(an.excluded.has(c.id)).toBe(true)
    }
  })
  it('a refusal returns [] without touching the drawing', () => {
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 1)
    const from = addPoint(d, 0, 0), to = addPoint(d, 3, 0)
    const before = structuredClone(d)
    expect(translateEntities(d, [path], pts[0]!, to, 3, 'step')).toEqual([])
    expect(translateEntities(d, [path], from, pts[1]!, 3, 'step')).toEqual([])
    expect(translateEntities(d, [path], from, from, 3, 'step')).toEqual([])
    expect(translateEntities(d, [path], from, 'nope', 3, 'step')).toEqual([])
    expect(translateEntities(d, [path], from, to, 0, 'span')).toEqual([])
    expect(d).toEqual(before)
  })
})

describe('along a path: fills, refusals leave the drawing alone', () => {
  it('a filled square repeated along a line: each copy’s area filled, nothing outside', () => {
    const d = doc()
    const { path } = squarePath(d, -0.5, -0.5, 1)
    toggleFillAt(d, { x: 0, y: 0 }, 0)
    const rail = addPath(d, [addPoint(d, 0, -5), addPoint(d, 10, -5)], [{ kind: 'line' }])
    copyAlongPath(d, [path], rail, 3)
    // the rail runs through the middle copy, cutting it in two: both halves
    // filled (the whole copied area), so 1 + 2 + 1 filled faces
    expect(fillState(d).filled).toHaveLength(4)
    for (const p of [{ x: 0, y: 0 }, { x: 5, y: -5.25 }, { x: 5, y: -4.75 }, { x: 10, y: -5.25 }, { x: 10, y: -4.75 }]) expect(fillTarget(d, p, 0)?.filled).toBe(true)
    for (const p of [{ x: 2.5, y: -2.5 }, { x: 5, y: -7 }, { x: 20, y: 20 }]) expect(fillTarget(d, p, 0)?.filled ?? false).toBe(false)
  })
  it('a filled square repeated linear: each copy filled, the gaps between not', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 1)
    toggleFillAt(d, { x: 0.5, y: 0.5 }, 0)
    const from = addPoint(d, 0, 0, { construction: true }), to = addPoint(d, 2, 0, { construction: true })
    translateEntities(d, [path], from, to, 3, 'step')
    for (const x of [0.5, 2.5, 4.5]) expect(fillTarget(d, { x, y: 0.5 }, 0)?.filled).toBe(true)
    for (const x of [1.5, 3.5, 6]) expect(fillTarget(d, { x, y: 0.5 }, 0)?.filled ?? false).toBe(false)
  })
  it('copies carry no rule to the original; a refusal returns [] without touching the drawing', () => {
    const d = doc()
    const { path, pts } = squarePath(d, -0.5, -0.5, 1)
    const ring = addCircle(d, addPoint(d, 20, 0), 5)
    const made = copyAlongPath(d, [path], ring, 4)
    expect(made).toHaveLength(3)
    const src = new Set<EntityId>([path, ...pts])
    for (const ids of made) for (const c of d.constraints) {
      if (c.refs.some(r => ids.includes(r))) expect(c.refs.some(r => src.has(r))).toBe(false)
    }
    const h = addPoint(d, 3, 9)
    const bz = addPath(d, [addPoint(d, 0, 8), addPoint(d, 6, 8)], [{ kind: 'cubic', h1: h, h2: null }])
    const before = structuredClone(d)
    expect(copyAlongPath(d, [path], bz, 3)).toEqual([])
    expect(copyAlongPath(d, [path], path, 3)).toEqual([])
    expect(copyAlongPath(d, [path, ring], ring, 3)).toEqual([])
    expect(copyAlongPath(d, [path], ring, 1)).toEqual([])
    expect(copyAlongPath(d, [path], ring, 65)).toEqual([])
    expect(d).toEqual(before)
  })
})
