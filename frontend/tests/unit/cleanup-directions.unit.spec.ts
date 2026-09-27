// tests/unit/cleanup-directions.unit.spec.ts
// Clean up, stage 2 (pen stage 5): nearly level / upright lines, groups of
// nearly parallel lines, and nearly square corners or groups.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addPath } from '~/lib/sketch/edit'
import { buildContext, type ContextEnv } from '~/lib/sketch/cleanup/context'
import { detectHV, detectParallelPerp } from '~/lib/sketch/cleanup/detect-directions'
import { STRENGTH_FACTOR } from '~/lib/sketch/cleanup/types'

const U = 1 / 34
const blank = (): SketchDoc => ({ entities: [], constraints: [] })
const env = (o: Partial<ContextEnv> = {}): ContextEnv => ({ held: new Set(), copies: new Set(), s: 1, unitsPerPx: U, ...o })
const rad = (deg: number) => deg * Math.PI / 180
function lineAt(d: SketchDoc, x: number, y: number, deg: number, len: number) {
  const a = addPoint(d, x, y), b = addPoint(d, x + len * Math.cos(rad(deg)), y + len * Math.sin(rad(deg)))
  return { a, b, id: addLine(d, a, b) }
}

describe('detectHV', () => {
  it('3° off level → Horizontal, 3° off upright → Vertical', () => {
    const d = blank()
    const h = lineAt(d, 0, 0, 3, 8), v = lineAt(d, 20, 0, 87, 8)
    const c = detectHV(buildContext(d, env()))
    expect(c.map(x => [x.kind, x.label])).toEqual([['horizontal', 'Horizontal'], ['vertical', 'Vertical']])
    expect(c[0]!.rules).toEqual([{ kind: 'horizontal', refs: [h.a, h.b] }])
    expect(c[1]!.rules).toEqual([{ kind: 'vertical', refs: [v.a, v.b] }])
    expect(c[0]!.id).toBe(`horizontal:${[h.a, h.b].sort().join('~')}`)
  })
  it('6° off level only at Strong', () => {
    const d = blank()
    lineAt(d, 0, 0, 6, 8)
    expect(detectHV(buildContext(d, env()))).toHaveLength(0)
    expect(detectHV(buildContext(d, env({ s: STRENGTH_FACTOR.strong })))).toHaveLength(1)
  })
  it('copies and held lines take no part', () => {
    const d = blank()
    const h = lineAt(d, 0, 0, 3, 8)
    expect(detectHV(buildContext(d, env({ copies: new Set([h.a, h.b]) })))).toHaveLength(0)
    expect(detectHV(buildContext(d, env({ held: new Set([h.a, h.b]) })))).toHaveLength(0)
  })
})

describe('detectParallelPerp', () => {
  it('two lines at 30° and 32° → Parallel, tied to the longer one', () => {
    const d = blank()
    const L = lineAt(d, 0, 0, 30, 6), S = lineAt(d, 0, 5, 32, 3)
    const c = detectParallelPerp(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'parallel', label: 'Parallel' })
    expect(c[0]!.rules).toEqual([{ kind: 'parallel', refs: [L.a, L.b, S.a, S.b] }])
  })
  it('three → Parallel ×3', () => {
    const d = blank()
    lineAt(d, 0, 0, 30, 6); lineAt(d, 0, 4, 31, 5); lineAt(d, 0, 8, 33, 4)
    const c = detectParallelPerp(buildContext(d, env()))
    expect(c.map(x => x.label)).toEqual(['Parallel ×3'])
    expect(c[0]!.rules).toHaveLength(2)
  })
  it('an ambiguous group is skipped', () => {
    const d = blank()
    lineAt(d, 0, 0, 30, 5); lineAt(d, 0, 4, 33, 5); lineAt(d, 0, 8, 36.5, 5)
    expect(detectParallelPerp(buildContext(d, env()))).toHaveLength(0)
  })
  it('a nearly square corner → Square, written the pen’s Right-angle way', () => {
    const d = blank()
    const P0 = addPoint(d, 0, 0)
    const J = addPoint(d, 4 * Math.cos(rad(20)), 4 * Math.sin(rad(20)))
    const P2 = addPoint(d, 4 * Math.cos(rad(20)) + 3 * Math.cos(rad(108)), 4 * Math.sin(rad(20)) + 3 * Math.sin(rad(108)))
    addPath(d, [P0, J, P2], [{ kind: 'line' }, { kind: 'line' }])
    const c = detectParallelPerp(buildContext(d, env()))
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'perpendicular', label: 'Square', anchor: [J] })
    expect(c[0]!.rules).toEqual([{ kind: 'perpendicular', refs: [P0, J, J, P2] }])
  })
  it('two unrelated single lines at 88° are not squared', () => {
    const d = blank()
    lineAt(d, 0, 0, 10, 4); lineAt(d, 10, 10, 98, 4)
    expect(detectParallelPerp(buildContext(d, env()))).toHaveLength(0)
  })
})
