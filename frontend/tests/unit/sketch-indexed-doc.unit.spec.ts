// An indexed view of a drawing (the pen overlay's per-render lookup map)
// answers every read exactly as the drawing itself does, and one segment's
// path data is that segment as the whole path draws it.
import { describe, it, expect } from 'vitest'
import { reactive, effect } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { indexedDoc, getEntity, entityIndexOf } from '~/lib/sketch/model'
import { constraintMarks, arcDimensionMarks } from '~/lib/sketch/annotate'
import { sketchPathData, entityPath, segmentPath } from '~/lib/sketch/sketchPath'

const make = (): SketchDoc => ({
  entities: [
    { id: 'a', kind: 'point', x: 0, y: 0 },
    { id: 'b', kind: 'point', x: 10, y: 0 },
    { id: 'c', kind: 'point', x: 10, y: 5 },
    { id: 'o', kind: 'point', x: 5, y: 0 },
    { id: 'L', kind: 'line', p1: 'a', p2: 'b' },
    { id: 'C', kind: 'circle', center: 'o', r: 2 },
    { id: 'P', kind: 'path', anchors: ['a', 'b', 'c'], segments: [{ kind: 'arc', center: 'o', sweep: 1 }, { kind: 'line' }, { kind: 'line' }], closed: true },
  ],
  constraints: [
    { id: 'h', kind: 'horizontal', refs: ['L'] },
    { id: 'r', kind: 'radius', refs: ['C'], value: 2 },
    { id: 't', kind: 'tangentLineArc', refs: ['b', 'c', 'o', 'a'] },
  ],
})

describe('indexedDoc', () => {
  it('finds every piece the drawing does, and nothing it does not', () => {
    const d = make(), v = indexedDoc(d)
    expect(entityIndexOf(v)).toBeDefined()
    expect(entityIndexOf(d)).toBeUndefined()
    for (const e of d.entities) expect(getEntity(v, e.id)).toBe(e)
    expect(getEntity(v, 'nope')).toBeUndefined()
  })

  it('draws and annotates exactly as the drawing itself', () => {
    const d = make(), v = indexedDoc(d)
    expect(sketchPathData(v)).toBe(sketchPathData(d))
    expect(constraintMarks(v)).toEqual(constraintMarks(d))
    expect(arcDimensionMarks(v)).toEqual(arcDimensionMarks(d))
  })

  it('reads a reactive drawing\'s points live, so a moved point is still tracked', () => {
    const d = reactive(make()) as SketchDoc
    const v = indexedDoc(d)
    let drawn = ''
    effect(() => { drawn = entityPath(v, 'L') })
    const b = d.entities.find(e => e.id === 'b')!
    if (b.kind === 'point') b.x = 20
    expect(drawn).toBe('M 0 0 L 20 0')
  })
})

describe('segmentPath', () => {
  it('is one segment of the path, from its start anchor to its end', () => {
    const d = indexedDoc(make())
    const whole = entityPath(d, 'P')
    const arc = segmentPath(d, 'P', 0)
    expect(arc.startsWith('M 0 0 A 5 5 ')).toBe(true)
    expect(whole).toContain(arc.slice('M 0 0 '.length))
    expect(segmentPath(d, 'P', 1)).toBe('M 10 0 L 10 5')
    expect(segmentPath(d, 'P', 2)).toBe('M 10 5 L 0 0')   // the closing one wraps to the first anchor
    expect(segmentPath(d, 'P', 3)).toBe('')
    expect(segmentPath(d, 'L', 0)).toBe('')
  })
})
