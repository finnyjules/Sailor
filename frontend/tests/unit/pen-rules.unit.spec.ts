// tests/unit/pen-rules.unit.spec.ts
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle } from '~/lib/sketch/edit'
import { availableConstraints } from '~/composables/pen/penRules'

const empty = (): SketchDoc => ({ entities: [], constraints: [] })
const kinds = (xs: { kind: string }[]) => xs.map(x => x.kind)

describe('availableConstraints', () => {
  it('two circles → concentric, tangent, equal', () => {
    const d = empty()
    const c1 = addCircle(d, addPoint(d, 0, 0), 1)
    const c2 = addCircle(d, addPoint(d, 3, 0), 1)
    expect(kinds(availableConstraints(d, [c1, c2], []))).toEqual(['concentric', 'tangentCircleCircle', 'equalRadius'])
  })
  it('one line → horizontal, vertical', () => {
    const d = empty()
    const l = addLine(d, addPoint(d, 0, 0), addPoint(d, 2, 1))
    expect(kinds(availableConstraints(d, [l], []))).toEqual(['horizontal', 'vertical'])
  })
  it('nothing selected → nothing offered', () => {
    expect(availableConstraints(empty(), [], [])).toEqual([])
  })
})
