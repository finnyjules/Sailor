// tests/unit/cleanup-cluster.unit.spec.ts
// Clean up's foundations (pen stage 5): grouping similar values without
// chaining (complete linkage) in 1-D, on the 180° circle of line directions
// and pairwise in the plane; the ambiguity guard; and the incremental row
// rank that tells a rule that adds something from one that is already implied.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addCircle } from '~/lib/sketch/edit'
import { clusterSorted, clusterCircular, clusterPairs, outsideGap, unambiguous, meanPoint } from '~/lib/sketch/cleanup/cluster'
import { RowBasis, rankOf, freeSlots, rowsFor } from '~/lib/sketch/cleanup/rank'
import { STRENGTH_FACTOR, TOL, countLabel } from '~/lib/sketch/cleanup/types'

describe('types', () => {
  it('carries the spec’s strengths and tolerances', () => {
    expect(STRENGTH_FACTOR).toEqual({ gentle: 0.5, normal: 1, strong: 1.75 })
    expect(TOL).toMatchObject({ JOIN_PX: 6, ON_CURVE_PX: 5, KINK_DEG: 8, HV_DEG: 4, PAR_DEG: 4, CONC_PX: 6, CONC_FRAC: 0.04,
      LEN_FRAC: 0.04, LEN_PX: 4, RAD_FRAC: 0.05, RAD_PX: 3, GAP_FRAC: 0.06, MIRROR_PX: 6, ROUND_FRAC: 0.02 })
  })
  it('shows a count only above a pair', () => {
    expect(countLabel('Parallel', 2)).toBe('Parallel')
    expect(countLabel('Parallel', 3)).toBe('Parallel ×3')
  })
})

describe('clusterSorted', () => {
  it('groups without chaining: no group spreads past the tolerance', () => {
    const g = clusterSorted([1, 1.3, 1.6, 1.9], v => v, (lo, hi) => hi - lo <= 0.5)
    expect(g).toHaveLength(2)
    for (const x of g) expect(Math.max(...x) - Math.min(...x)).toBeLessThanOrEqual(0.5)
    expect(g.flat().sort()).toEqual([1, 1.3, 1.6, 1.9])
  })
  it('leaves values that fit nothing on their own', () => {
    expect(clusterSorted([1, 5, 9], v => v, (lo, hi) => hi - lo <= 0.5)).toEqual([[1], [5], [9]])
  })
})

describe('clusterCircular', () => {
  it('joins 179° and 1° across the wrap, and unwraps their values', () => {
    const g = clusterCircular([179, 1, 90, 91.5], a => a, 4)
    const wrap = g.find(x => x.items.includes(179))!
    expect(wrap.items.sort((a, b) => a - b)).toEqual([1, 179])
    expect(wrap.values).toEqual([179, 181])
    expect(g.find(x => x.items.includes(90))!.items.sort((a, b) => a - b)).toEqual([90, 91.5])
  })
})

describe('clusterPairs', () => {
  it('complete linkage: a chain of near pairs is not one group', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }]
    const near = (a: { x: number }, b: { x: number }) => (Math.abs(a.x - b.x) <= 0.6 ? Math.abs(a.x - b.x) : null)
    const g = clusterPairs(pts, near)
    expect(g.map(x => x.map(p => p.x))).toEqual([[0, 0.5], [1]])
  })
  it('a group can be vetoed', () => {
    const near = () => 0.1
    expect(clusterPairs([1, 2, 3], near, grp => grp.length <= 2)).toEqual([[1, 2], [3]])
  })
})

describe('the ambiguity guard', () => {
  it('skips a group whose spread is large next to the gap to the nearest other value', () => {
    expect(outsideGap(10, 10.3, [10.9])).toBeCloseTo(0.6, 12)
    expect(unambiguous(10, 10.3, [10.9])).toBe(false)
    expect(unambiguous(10, 10.3, [11.2])).toBe(true)
  })
  it('measures round the circle for angles', () => {
    expect(outsideGap(178, 180.5, [3], 180)).toBeCloseTo(2.5, 12)
    expect(unambiguous(178, 180.5, [3], 180)).toBe(false)
  })
  it('meanPoint', () => {
    expect(meanPoint([{ x: 0, y: 0 }, { x: 2, y: 4 }])).toEqual({ x: 1, y: 2 })
  })
})

describe('RowBasis', () => {
  it('counts independent rows only', () => {
    const b = new RowBasis(3)
    expect(b.add([1, 0, 0])).toBe(true)
    expect(b.add([0, 2, 0])).toBe(true)
    expect(b.add([3, 3, 0])).toBe(false)
    expect(b.add([1, 1, 1e-12])).toBe(false)
    expect(b.add([0, 0, 0])).toBe(false)
    expect(b.rank).toBe(2)
    expect(rankOf([[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]], 3)).toBe(3)
  })
})

describe('free slots and rows', () => {
  it('leave out fixed and held points and held circles', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), b = addPoint(d, 1, 0), f = addPoint(d, 2, 0, { fixed: true })
    const c = addCircle(d, f, 1), c2 = addCircle(d, f, 2)
    const slots = freeSlots(d, new Set([b, c2]))
    expect(slots).toEqual([{ kind: 'px', id: a }, { kind: 'py', id: a }, { kind: 'r', id: c }])
  })
  it('one row per residual, in slot columns', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), b = addPoint(d, 3, 1)
    const slots = freeSlots(d, new Set())
    expect(rowsFor(d, slots, [{ id: 'x', kind: 'horizontal', refs: [a, b] }])).toEqual([[0, 1, 0, -1]])
  })
})
