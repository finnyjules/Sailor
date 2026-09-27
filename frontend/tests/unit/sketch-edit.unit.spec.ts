import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { freshId } from '~/lib/sketch/ids'
import { addPoint, addLine, addCircle, addConstraint, removeConstraint, deleteEntity } from '~/lib/sketch/edit'

const emptyDoc = (): SketchDoc => ({ entities: [], constraints: [] })

describe('freshId', () => {
  it('never collides with existing ids and is deterministic', () => {
    const d = emptyDoc()
    const a = freshId(d); d.entities.push({ id: a, kind: 'point', x: 0, y: 0 })
    const b = freshId(d)
    expect(b).not.toBe(a)
    // deterministic: same doc state → same next id
    const d2 = emptyDoc(); d2.entities.push({ id: a, kind: 'point', x: 0, y: 0 })
    expect(freshId(d2)).toBe(b)
  })
})

describe('authoring ops', () => {
  it('adds points, a line, a circle, and a constraint', () => {
    const d = emptyDoc()
    const p1 = addPoint(d, 0, 0)
    const p2 = addPoint(d, 10, 0)
    const L = addLine(d, p1, p2)
    const pc = addPoint(d, 5, 5)
    const C = addCircle(d, pc, 3)
    const k = addConstraint(d, 'tangentLineCircle', [L, C])
    expect(d.entities.map(e => e.kind)).toEqual(['point', 'point', 'line', 'point', 'circle'])
    expect(d.constraints).toHaveLength(1)
    expect(d.constraints[0]).toMatchObject({ id: k, kind: 'tangentLineCircle', refs: [L, C] })
  })

  it('removeConstraint drops just that constraint', () => {
    const d = emptyDoc()
    const p1 = addPoint(d, 0, 0), p2 = addPoint(d, 1, 1)
    const k = addConstraint(d, 'coincident', [p1, p2])
    removeConstraint(d, k)
    expect(d.constraints).toHaveLength(0)
    expect(d.entities).toHaveLength(2) // entities untouched
  })

  it('deleteEntity on a point cascades to dependent line + constraints', () => {
    const d = emptyDoc()
    const p1 = addPoint(d, 0, 0), p2 = addPoint(d, 10, 0)
    const L = addLine(d, p1, p2)
    addConstraint(d, 'horizontal', [L])
    deleteEntity(d, p1)
    // p1 gone, the line that referenced it gone, the constraint on that line gone
    expect(d.entities.find(e => e.id === p1)).toBeUndefined()
    expect(d.entities.find(e => e.id === L)).toBeUndefined()
    expect(d.entities.find(e => e.id === p2)).toBeDefined() // unrelated point stays
    expect(d.constraints).toHaveLength(0)
  })

  it('deleteEntity on a circle removes its constraints but keeps its center point', () => {
    const d = emptyDoc()
    const pc = addPoint(d, 5, 5)
    const C = addCircle(d, pc, 3)
    addConstraint(d, 'radius', [C], 3)
    deleteEntity(d, C)
    expect(d.entities.find(e => e.id === C)).toBeUndefined()
    expect(d.entities.find(e => e.id === pc)).toBeDefined() // center point not auto-removed
    expect(d.constraints).toHaveLength(0)
  })
})

describe('deleting a guide line', () => {
  it('takes its own guide ends with it, and the rule that only ties them (a Clean up axis)', () => {
    const d = emptyDoc()
    const p = addPoint(d, 5, -1, { construction: true }), q = addPoint(d, 5, 9, { construction: true })
    const axis = addLine(d, p, q, { construction: true })
    addConstraint(d, 'vertical', [p, q])
    const a = addPoint(d, 1, 1), b = addPoint(d, 9, 1)
    addConstraint(d, 'mirroredFrom', [b, a, axis])
    deleteEntity(d, axis)
    expect(d.entities.map(e => e.id).sort()).toEqual([a, b].sort())
    expect(d.constraints).toEqual([])
  })
  it('keeps an end another piece or rule still uses, and every end of a plain line', () => {
    const d = emptyDoc()
    const p = addPoint(d, 0, 0, { construction: true }), q = addPoint(d, 0, 5, { construction: true }), r = addPoint(d, 4, 5, { construction: true })
    const g = addLine(d, p, q, { construction: true })
    addLine(d, q, r, { construction: true })                    // q is shared with another guide
    const x = addPoint(d, 3, 0)
    addConstraint(d, 'horizontal', [p, x])                      // p is tied to a drawn point
    deleteEntity(d, g)
    expect(d.entities.map(e => e.id)).toEqual(expect.arrayContaining([p, q, r, x]))
    expect(d.constraints.map(c => c.kind)).toEqual(['horizontal'])
    const e = emptyDoc()
    const s = addPoint(e, 0, 0), t = addPoint(e, 1, 0)
    const l = addLine(e, s, t)
    deleteEntity(e, l)
    expect(e.entities.map(k => k.id).sort()).toEqual([s, t].sort())
  })
})
