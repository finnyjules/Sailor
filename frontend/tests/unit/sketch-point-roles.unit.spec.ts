import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint } from '~/lib/sketch/edit'
import { pointRole, pointRolesForDoc } from '~/lib/sketch/pointRoles'

const emptyDoc = (): SketchDoc => ({ entities: [], constraints: [] })

describe('pointRole', () => {
  it('a lone unreferenced point is free', () => {
    const d = emptyDoc()
    const p = addPoint(d, 0, 0)
    expect(pointRole(d, p)).toBe('free')
  })

  it('a line end used by nothing else is a loose end', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    addLine(d, a, b)
    expect(pointRole(d, a)).toBe('end')
    expect(pointRole(d, b)).toBe('end')
  })

  it('two lines sharing an endpoint (merged point) is a joint', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0), c = addPoint(d, 0, 10)
    addLine(d, a, b)
    addLine(d, a, c)
    expect(pointRole(d, a)).toBe('joint')
    expect(pointRole(d, b)).toBe('end')
    expect(pointRole(d, c)).toBe('end')
  })

  it('an open path: terminal anchors are ends, interior anchors are joints', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0), c = addPoint(d, 10, 10)
    addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }], false)
    expect(pointRole(d, a)).toBe('end')
    expect(pointRole(d, b)).toBe('joint')
    expect(pointRole(d, c)).toBe('end')
  })

  it('a closed path: every anchor is a joint', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0), c = addPoint(d, 5, 10)
    addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    expect(pointRole(d, a)).toBe('joint')
    expect(pointRole(d, b)).toBe('joint')
    expect(pointRole(d, c)).toBe('joint')
  })

  it('a circle center used only there is a centre', () => {
    const d = emptyDoc()
    const c = addPoint(d, 0, 0)
    addCircle(d, c, 5)
    expect(pointRole(d, c)).toBe('centre')
  })

  it('an arc segment center is a centre; its structural equalDist invariant does not turn the arc\'s own start/end into joints', () => {
    const d = emptyDoc()
    const start = addPoint(d, 5, 0), end = addPoint(d, 0, 5), center = addPoint(d, 0, 0)
    addPath(d, [start, end], [{ kind: 'arc', center, sweep: 0 }], false)
    expect(pointRole(d, center)).toBe('centre')
    expect(pointRole(d, start)).toBe('end')
    expect(pointRole(d, end)).toBe('end')
  })

  it('a circle center that is also a line endpoint is a joint, not a centre', () => {
    const d = emptyDoc()
    const c = addPoint(d, 0, 0), other = addPoint(d, 10, 0)
    addCircle(d, c, 5)
    addLine(d, c, other)
    expect(pointRole(d, c)).toBe('joint')
  })

  it('pointOnLine pins a lone point onto a line as a T-junction joint', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    const L = addLine(d, a, b)
    const p = addPoint(d, 5, 0)
    addConstraint(d, 'pointOnLine', [p, L])
    expect(pointRole(d, p)).toBe('joint')
  })

  it('pointOnCircle pins a lone point onto a circle as a T-junction joint', () => {
    const d = emptyDoc()
    const c = addPoint(d, 0, 0)
    const C = addCircle(d, c, 5)
    const p = addPoint(d, 5, 0)
    addConstraint(d, 'pointOnCircle', [p, C])
    expect(pointRole(d, p)).toBe('joint')
  })

  it('midpoint pins a lone point as a T-junction joint', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    const p = addPoint(d, 5, 0)
    addConstraint(d, 'midpoint', [p, a, b])
    expect(pointRole(d, p)).toBe('joint')
  })

  it('collinear on-curve pin [A,B,p] marks p a joint, but a smooth-handle collinear [hIn,anchor,hOut] does not', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
    addLine(d, a, b)
    const p = addPoint(d, 5, 0)
    addConstraint(d, 'collinear', [a, b, p])
    expect(pointRole(d, p)).toBe('joint')

    // a smooth path anchor with real cubic handles: the collinear rule over
    // [hIn, anchor, hOut] must not turn the anchor into a joint on its own
    const h1 = addPoint(d, -1, 1), anchor = addPoint(d, 0, 1), h2 = addPoint(d, 1, 1), h3 = addPoint(d, 2, 1)
    addPath(d, [h1, anchor, h3], [
      { kind: 'cubic', h1: null, h2: h1 },
      { kind: 'cubic', h1: h2, h2: null },
    ], false)
    addConstraint(d, 'collinear', [h1, anchor, h2])
    expect(pointRole(d, anchor)).toBe('joint') // interior anchor of the open path — joint via topology, not the collinear rule
  })

  it('equalDist on-curve pin [C,p,C,a] marks p a joint without disturbing the arc\'s own ends', () => {
    const d = emptyDoc()
    const start = addPoint(d, 5, 0), end = addPoint(d, 0, 5), center = addPoint(d, 0, 0)
    addPath(d, [start, end], [{ kind: 'arc', center, sweep: 0 }], false)
    const p = addPoint(d, Math.SQRT1_2 * 5, Math.SQRT1_2 * 5)
    addConstraint(d, 'equalDist', [center, p, center, start])
    expect(pointRole(d, p)).toBe('joint')
    expect(pointRole(d, start)).toBe('end')
    expect(pointRole(d, end)).toBe('end')
  })

  it('construction points still resolve structurally (overlay decides look separately)', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0, { construction: true }), b = addPoint(d, 10, 0, { construction: true })
    addLine(d, a, b)
    expect(pointRole(d, a)).toBe('end')
  })

  it('pointRolesForDoc returns the same roles as pointRole, batched', () => {
    const d = emptyDoc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0), c = addPoint(d, 0, 10)
    addLine(d, a, b)
    addLine(d, a, c)
    const roles = pointRolesForDoc(d)
    expect(roles.get(a)).toBe(pointRole(d, a))
    expect(roles.get(b)).toBe(pointRole(d, b))
    expect(roles.get(c)).toBe(pointRole(d, c))
  })
})
