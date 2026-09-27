// tests/unit/pen-weld.unit.spec.ts
// Joining by dragging in the Select tool: a single point dropped onto another
// point merges into it, dropped onto a curve it is pinned there with the
// curve's rule; ⌘/Ctrl moves without joining; the whole drag is one undo
// step. Plus the rules row: Coincident merges two points, and one point with
// one Option-clicked segment offers "On curve" (+ "Midpoint" on a line).
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addPath } from '~/lib/sketch/edit'
import { curveGeom, pointAt } from '~/lib/sketch/crossings'
import { usePen } from '~/composables/pen/usePen'
import { mergePoints } from '~/lib/sketch/trim'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }   // snap radius 0.6 units
function mk(build: (d: SketchDoc) => void, openOnly = false) {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  build(doc.value)
  const pen = usePen({ doc, view: ref(DEV), options: openOnly ? { openOnly } : undefined })
  return { doc, pen }
}
const P = (d: SketchDoc, id: EntityId) => d.entities.find(e => e.id === id) as any
const paths = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path') as any[]
const distPts = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y)

// drag `id` through a few spots to (x, y), then release
function dragTo(pen: ReturnType<typeof usePen>, d: SketchDoc, id: EntityId, x: number, y: number, noJoin = false) {
  const p = P(d, id)
  const x0 = p.x, y0 = p.y
  for (const t of [0.25, 0.5, 0.75, 1]) pen.dragPoint(id, x0 + (x - x0) * t, y0 + (y - y0) * t, noJoin)
}

describe('Select drag: drop a point onto a point', () => {
  it('an open path end dropped onto its start closes the path into one', () => {
    let a = '', b = '', c = '', e = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); b = addPoint(d, 6, 0); c = addPoint(d, 6, 6); e = addPoint(d, 1, 5)
      addPath(d, [a, b, c, e], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }])
    })
    dragTo(pen, doc.value, e, 0.2, 0.3)
    expect(pen.hoverSnap.value?.kind).toBe('point')
    pen.dropPoint(e)
    expect(paths(doc.value)).toHaveLength(1)
    const path = paths(doc.value)[0]
    expect(path.closed).toBe(true)
    expect(path.anchors).toEqual([a, b, c])
    expect(P(doc.value, e)).toBeUndefined()
    expect(P(doc.value, a)).toMatchObject({ x: 0, y: 0 })   // the target stays put
    expect(pen.hoverSnap.value).toBeNull()
    expect(pen.sparkleCount()).toBeGreaterThan(0)
  })

  it('the whole drag and its join are one undo step', () => {
    let a = '', e = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); const b = addPoint(d, 6, 0); const c = addPoint(d, 6, 6); e = addPoint(d, 1, 5)
      addPath(d, [a, b, c, e], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }])
    })
    dragTo(pen, doc.value, e, 0.1, 0.1)
    pen.dropPoint(e)
    expect(paths(doc.value)[0].closed).toBe(true)
    pen.undo()
    expect(paths(doc.value)[0].closed).toBe(false)
    expect(P(doc.value, e)).toMatchObject({ x: 1, y: 5 })
    expect(pen.canUndo()).toBe(false)
  })

  it('with ⌘/Ctrl held there is no preview and no join', () => {
    let e = ''
    const { doc, pen } = mk(d => {
      const a = addPoint(d, 0, 0); const b = addPoint(d, 6, 0); const c = addPoint(d, 6, 6); e = addPoint(d, 1, 5)
      addPath(d, [a, b, c, e], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }])
    })
    dragTo(pen, doc.value, e, 0.2, 0.3, true)
    expect(pen.hoverSnap.value).toBeNull()
    pen.dropPoint(e, true)
    expect(paths(doc.value)[0].closed).toBe(false)
    expect(P(doc.value, e).x).toBeCloseTo(0.2, 3)
    expect(P(doc.value, e).y).toBeCloseTo(0.3, 3)
  })

  it('⌘/Ctrl pressed only at release still stops the join', () => {
    let e = ''
    const { doc, pen } = mk(d => {
      const a = addPoint(d, 0, 0); const b = addPoint(d, 6, 0); e = addPoint(d, 6, 6)
      const f = addPoint(d, 1, 5)
      addPath(d, [a, b, e], [{ kind: 'line' }, { kind: 'line' }]); void f
    })
    dragTo(pen, doc.value, e, 1.1, 5.1)
    expect(pen.hoverSnap.value?.kind).toBe('point')
    pen.dropPoint(e, true)
    expect(P(doc.value, e)).toBeTruthy()
    expect(doc.value.entities.filter(x => x.kind === 'point')).toHaveLength(4)
  })

  it('a dragged fixed point dropped onto a fixed point joins it (they meet at the target)', () => {
    let e = '', f = ''
    const { doc, pen } = mk(d => {
      f = addPoint(d, 0, 0, { fixed: true }); e = addPoint(d, 3, 2, { fixed: true })
    })
    dragTo(pen, doc.value, e, 0.1, 0.1)
    pen.dropPoint(e)
    expect(P(doc.value, e)).toBeUndefined()
    expect(P(doc.value, f)).toMatchObject({ x: 0, y: 0, fixed: true })
  })

  it('never offers the dragged point, its own curves, or the other end of its own piece', () => {
    let a = '', b = ''
    const { doc, pen } = mk(d => { a = addPoint(d, 0, 0); b = addPoint(d, 0.4, 0); addLine(d, a, b) })
    // near its own line's other end and along its own line: nothing
    pen.dragPoint(b, 0.1, 0.05)
    expect(pen.hoverSnap.value).toBeNull()
    pen.dropPoint(b)
    expect(doc.value.entities.filter(x => x.kind === 'line')).toHaveLength(1)
  })

  it('another point sitting where the dragged point started is still a target', () => {
    let a = '', q = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); const b = addPoint(d, 5, 0); addLine(d, a, b)
      q = addPoint(d, 0, 0)   // a separate point at the same spot
    })
    pen.dragPoint(a, 2, 2)
    pen.dragPoint(a, 0.05, 0.05)
    expect(pen.hoverSnap.value?.kind).toBe('point')
    pen.dropPoint(a)
    expect(P(doc.value, a)).toBeUndefined()
    expect((doc.value.entities.find(x => x.kind === 'line') as any).p1).toBe(q)
  })

  it('a curve through the spot that is not one of its own is still a target', () => {
    let a = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); const b = addPoint(d, 0, 5); addLine(d, a, b)
      const c = addPoint(d, -3, 0), e = addPoint(d, 3, 0); addLine(d, c, e)   // passes through (0,0)
    })
    pen.dragPoint(a, 1, 1)
    pen.dragPoint(a, 1.2, 0.1)
    expect(pen.hoverSnap.value?.kind).toBe('curve')
    pen.dropPoint(a)
    expect(doc.value.constraints.some(c => c.kind === 'pointOnLine' && c.refs[0] === a)).toBe(true)
  })
})

describe('Select drag: drop a point onto a curve', () => {
  it('an end dropped onto a path arc is pinned with equalDist and slides with the arc', () => {
    let A = '', C = '', Q0 = '', arcPath = ''
    const { doc, pen } = mk(d => {
      A = addPoint(d, 0, 0); const B = addPoint(d, 10, 0); C = addPoint(d, 5, 0)
      arcPath = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
      Q0 = addPoint(d, 5, 9); const Q1 = addPoint(d, 20, 9)
      addPath(d, [Q0, Q1], [{ kind: 'line' }])
    })
    const g = curveGeom(doc.value, { kind: 'seg', pathId: arcPath, segIndex: 0 })!
    const mid = pointAt(g, 0.5)
    const c0 = P(doc.value, C)
    dragTo(pen, doc.value, Q0, c0.x + (mid.x - c0.x) * 1.04, c0.y + (mid.y - c0.y) * 1.04)
    expect(pen.hoverSnap.value?.kind).toBe('curve')
    pen.dropPoint(Q0)
    const rule = doc.value.constraints.find(c => c.kind === 'equalDist' && c.refs[1] === Q0)
    expect(rule?.refs).toEqual([C, Q0, C, A])
    expect(distPts(P(doc.value, Q0), P(doc.value, C))).toBeCloseTo(5, 4)
    // slide: move the centre; the pinned end stays on the arc
    pen.dragPoint(C, 5, 1, true)
    pen.dropPoint(C, true)
    expect(distPts(P(doc.value, Q0), P(doc.value, C))).toBeCloseTo(distPts(P(doc.value, A), P(doc.value, C)), 3)
  })

  it('an end dropped onto a path line segment gets collinear [A,B,p]', () => {
    let A = '', B = '', q = ''
    const { doc, pen } = mk(d => {
      A = addPoint(d, 0, 0); B = addPoint(d, 10, 0); addPath(d, [A, B], [{ kind: 'line' }])
      q = addPoint(d, 3, 5); const r = addPoint(d, 3, 9); addLine(d, q, r)
    })
    dragTo(pen, doc.value, q, 3, 0.2)
    pen.dropPoint(q)
    expect(doc.value.constraints.find(c => c.kind === 'collinear')?.refs).toEqual([A, B, q])
    expect(P(doc.value, q).y).toBeCloseTo(0, 5)
  })
})

describe('rules row: Coincident merges, point + segment rules', () => {
  it('Coincident on two points merges the second into the first; references are rewired', () => {
    let a = '', b = '', c = '', e = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); b = addPoint(d, 5, 0); addLine(d, a, b)
      c = addPoint(d, 1, 1); e = addPoint(d, 5, 5); addLine(d, c, e)
    })
    pen.pick(a); pen.pick(c, true)
    expect(pen.availableConstraints().map(r => r.label)).toEqual(['Coincident', 'Distance…', 'Horizontal', 'Vertical'])
    pen.apply('coincident')
    expect(P(doc.value, c)).toBeUndefined()
    expect(P(doc.value, a)).toMatchObject({ x: 0, y: 0 })
    const lines = doc.value.entities.filter(x => x.kind === 'line') as any[]
    expect(lines.map(l => [l.p1, l.p2])).toEqual([[a, b], [a, e]])
    expect(doc.value.constraints.some(k => k.kind === 'coincident')).toBe(false)
    expect(pen.selection.value).toEqual([])
    pen.undo()
    expect(P(doc.value, c)).toBeTruthy()
  })

  it('Coincident on two fixed points in different places changes nothing and says why', () => {
    let a = '', c = ''
    const { doc, pen } = mk(d => { a = addPoint(d, 0, 0, { fixed: true }); c = addPoint(d, 4, 4, { fixed: true }) })
    pen.pick(a); pen.pick(c, true)
    pen.apply('coincident')
    expect(P(doc.value, a)).toBeTruthy()
    expect(P(doc.value, c)).toBeTruthy()
    expect(pen.status.value).toBe('Those two points are both fixed in different places')
    expect(pen.canUndo()).toBe(false)
  })

  it('a point then an Option-clicked arc segment keep each other and offer On curve', () => {
    let A = '', C = '', p = '', arcPath = ''
    const { doc, pen } = mk(d => {
      A = addPoint(d, 0, 0); const B = addPoint(d, 10, 0); C = addPoint(d, 5, 0)
      arcPath = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
      p = addPoint(d, 5, 8)
    })
    pen.pick(p)
    pen.pickSegment(arcPath, 0)
    expect(pen.selection.value).toEqual([p])
    expect(pen.selectedSegments.value).toEqual([{ pathId: arcPath, segIndex: 0 }])
    const opts = pen.availableConstraints()
    expect(opts.map(r => r.label)).toEqual(['On curve'])
    pen.applyWithValue(opts[0]!)
    expect(doc.value.constraints.find(c => c.kind === 'equalDist' && c.refs[1] === p)?.refs).toEqual([C, p, C, A])
    expect(distPts(P(doc.value, p), P(doc.value, C))).toBeCloseTo(distPts(P(doc.value, A), P(doc.value, C)), 3)
    expect(pen.selection.value).toEqual([])
    expect(pen.selectedSegments.value).toEqual([])
  })

  it('an Option-clicked line segment then a point offer On curve and Midpoint', () => {
    let A = '', B = '', p = '', path = ''
    const { doc, pen } = mk(d => {
      A = addPoint(d, 0, 0); B = addPoint(d, 10, 0); const C = addPoint(d, 10, 10)
      path = addPath(d, [A, B, C], [{ kind: 'line' }, { kind: 'line' }])
      p = addPoint(d, 3, 4)
    })
    pen.pickSegment(path, 0)
    pen.pick(p, true)   // a Shift-click keeps the segment
    expect(pen.selectedSegments.value).toHaveLength(1)
    const opts = pen.availableConstraints()
    expect(opts.map(r => r.label)).toEqual(['On curve', 'Midpoint'])
    pen.applyWithValue(opts.find(o => o.label === 'Midpoint')!)
    expect(doc.value.constraints.find(c => c.kind === 'midpoint')?.refs).toEqual([p, A, B])
    const [pa, pb, pp] = [P(doc.value, A), P(doc.value, B), P(doc.value, p)]
    expect(pp.x).toBeCloseTo((pa.x + pb.x) / 2, 3)
    expect(pp.y).toBeCloseTo((pa.y + pb.y) / 2, 3)
  })

  it('On curve on a line segment adds collinear [A,B,p]', () => {
    let A = '', B = '', p = '', path = ''
    const { doc, pen } = mk(d => {
      A = addPoint(d, 0, 0); B = addPoint(d, 10, 0); path = addPath(d, [A, B], [{ kind: 'line' }])
      p = addPoint(d, 3, 4)
    })
    pen.pick(p); pen.pickSegment(path, 0)
    pen.applyWithValue(pen.availableConstraints()[0]!)
    expect(doc.value.constraints.find(c => c.kind === 'collinear')?.refs).toEqual([A, B, p])
  })

  it('other combinations still clear each other', () => {
    let a = '', b = '', path = ''
    const { pen } = mk(d => {
      a = addPoint(d, 0, 0); b = addPoint(d, 1, 1)
      const A = addPoint(d, 0, 5), B = addPoint(d, 10, 5), C = addPoint(d, 10, 9)
      path = addPath(d, [A, B, C], [{ kind: 'line' }, { kind: 'line' }])
    })
    pen.pick(a); pen.pick(b, true)
    pen.pickSegment(path, 0)          // two points + a segment: points go
    expect(pen.selection.value).toEqual([])
    pen.pickSegment(path, 1, true)    // two segments + a point: segments go
    pen.pick(a)
    expect(pen.selectedSegments.value).toEqual([])
    pen.pick(path)                    // a whole path with a segment selected: the segment goes
    pen.pickSegment(path, 0)
    expect(pen.selection.value).toEqual([])
    pen.pick(a)
    pen.pick(b, true)                 // point + segment, then a second point: segment goes
    expect(pen.selectedSegments.value).toEqual([])
    expect(pen.selection.value).toEqual([a, b])
  })
})

describe('fix round 1', () => {
  it('a Bézier handle dragged onto its anchor never joins it', () => {
    let a = '', h1 = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); const b = addPoint(d, 10, 0)
      h1 = addPoint(d, 3, 3, { construction: true }); const h2 = addPoint(d, 7, 3, { construction: true })
      addPath(d, [a, b], [{ kind: 'cubic', h1, h2 }])
    })
    dragTo(pen, doc.value, h1, 0.1, 0.1)
    expect(pen.hoverSnap.value).toBeNull()
    pen.dropPoint(h1)
    expect(P(doc.value, h1)).toBeTruthy()
    expect((paths(doc.value)[0].segments[0] as any).h1).toBe(h1)
  })

  it('Coincident refuses to merge a handle', () => {
    let a = '', h1 = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); const b = addPoint(d, 10, 0)
      h1 = addPoint(d, 3, 3, { construction: true }); const h2 = addPoint(d, 7, 3, { construction: true })
      addPath(d, [a, b], [{ kind: 'cubic', h1, h2 }])
    })
    pen.pick(a); pen.pick(h1, true)
    pen.apply('coincident')
    expect(P(doc.value, h1)).toBeTruthy()
    expect(pen.canUndo()).toBe(false)
  })

  it('a text guide (openOnly) end dropped onto its start does not close it', () => {
    let e = ''
    const { doc, pen } = mk(d => {
      const a = addPoint(d, 0, 0); const b = addPoint(d, 6, 0); const c = addPoint(d, 6, 6); e = addPoint(d, 1, 5)
      addPath(d, [a, b, c, e], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }])
    }, true)
    dragTo(pen, doc.value, e, 0.1, 0.1)
    expect(pen.hoverSnap.value?.kind).not.toBe('point')   // its first piece may still take it, never its start
    pen.dropPoint(e)
    expect(paths(doc.value)[0].closed).toBe(false)
    expect(P(doc.value, e)).toBeTruthy()
  })

  it('Coincident on a text guide’s two ends refuses and says why', () => {
    let a = '', e = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); const b = addPoint(d, 6, 0); const c = addPoint(d, 6, 6); e = addPoint(d, 1, 5)
      addPath(d, [a, b, c, e], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }])
    }, true)
    pen.pick(a); pen.pick(e, true)
    pen.apply('coincident')
    expect(paths(doc.value)[0].closed).toBe(false)
    expect(pen.status.value).toBe('A text guide stays open')
  })

  // an open path of one arc, centre (0,3) radius 3, from A = (0,0) the
  // anticlockwise way round through `deg` degrees (300° by default: near-full)
  function oneArc(d: SketchDoc, deg = 300) {
    const t = (-90 + deg) * Math.PI / 180
    const A = addPoint(d, 0, 0); const B = addPoint(d, 3 * Math.cos(t), 3 + 3 * Math.sin(t)); const C = addPoint(d, 0, 3)
    const path = addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])
    return { A, B, C, path }
  }
  function expectCircle(d: SketchDoc, ids: { A: string; B: string; C: string }, keep: string) {
    expect(paths(d)).toHaveLength(0)
    const circles = d.entities.filter(e => e.kind === 'circle') as any[]
    expect(circles).toHaveLength(1)
    expect(circles[0].center).toBe(ids.C)
    expect(P(d, ids.C)).toBeTruthy()
    expect(P(d, keep)).toBeTruthy()
    const pin = d.constraints.find(c => c.kind === 'pointOnCircle')
    expect(pin?.refs).toEqual([keep, circles[0].id])
    expect(d.constraints.some(c => c.kind === 'equalDist')).toBe(false)
    expect(circles[0].r).toBeCloseTo(distPts(P(d, keep), P(d, ids.C)), 4)
  }

  it('mergePoints turns a one-arc open path whose ends meet into a circle', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const ids = oneArc(d)
    expect(mergePoints(d, ids.B, ids.A)).toBe(true)
    expectCircle(d, ids, ids.A)
  })

  it('dropping a one-arc path’s end on its start makes a circle; one undo restores the path', () => {
    let ids = { A: '', B: '', C: '', path: '' }
    const { doc, pen } = mk(d => { ids = oneArc(d) })
    pen.pickSegment(ids.path, 0)
    dragTo(pen, doc.value, ids.B, -0.1, 0.05)
    expect(pen.hoverSnap.value?.kind).toBe('point')
    pen.dropPoint(ids.B)
    expectCircle(doc.value, ids, ids.A)
    expect(pen.selectedSegments.value).toEqual([])
    pen.undo()
    expect(paths(doc.value)).toHaveLength(1)
    expect(doc.value.entities.some(e => e.kind === 'circle')).toBe(false)
  })

  it('Coincident on a one-arc path’s two ends makes a circle', () => {
    let ids = { A: '', B: '', C: '', path: '' }
    const { doc, pen } = mk(d => { ids = oneArc(d) })
    pen.pick(ids.A); pen.pick(ids.B, true)
    pen.apply('coincident')
    expectCircle(doc.value, ids, ids.A)
  })

  it('a one-arc text guide never closes into a circle', () => {
    let ids = { A: '', B: '', C: '', path: '' }
    const { doc, pen } = mk(d => { ids = oneArc(d) }, true)
    dragTo(pen, doc.value, ids.B, -0.1, 0.05)
    expect(pen.hoverSnap.value).toBeNull()
    pen.dropPoint(ids.B)
    expect(paths(doc.value)).toHaveLength(1)
  })

  it('a small (~2°) one-arc path’s end dragged to its start finds no target', () => {
    let ids = { A: '', B: '', C: '', path: '' }
    const { doc, pen } = mk(d => { ids = oneArc(d, 2) })
    expect(Math.abs(curveGeom(doc.value, { kind: 'seg', pathId: ids.path, segIndex: 0 })!.sweepAngle!)).toBeLessThan(0.1)
    dragTo(pen, doc.value, ids.B, 0.02, 0.01)
    expect(pen.hoverSnap.value).toBeNull()
    pen.dropPoint(ids.B)
    expect(paths(doc.value)).toHaveLength(1)
    expect(doc.value.entities.some(e => e.kind === 'circle')).toBe(false)
  })

  it('Coincident on a small one-arc path’s two ends refuses: it would collapse the piece', () => {
    let ids = { A: '', B: '', C: '', path: '' }
    const { doc, pen } = mk(d => { ids = oneArc(d, 2) })
    pen.pick(ids.A); pen.pick(ids.B, true)
    pen.apply('coincident')
    expect(pen.status.value).toBe('That would collapse the piece')
    expect(paths(doc.value)).toHaveLength(1)
    expect(pen.canUndo()).toBe(false)
  })

  it('a one-arc path’s end still never joins its own centre', () => {
    let ids = { A: '', B: '', C: '', path: '' }
    const { doc, pen } = mk(d => { ids = oneArc(d) })
    const c = P(doc.value, ids.C)
    dragTo(pen, doc.value, ids.B, c.x + 0.1, c.y)
    expect(pen.hoverSnap.value).toBeNull()
  })

  it('a point with its own segment is offered neither On curve nor Midpoint', () => {
    let A = '', path = '', C = '', arc = ''
    const { pen } = mk(d => {
      A = addPoint(d, 0, 0); const B = addPoint(d, 10, 0); path = addPath(d, [A, B], [{ kind: 'line' }])
      const E = addPoint(d, 0, 5), F = addPoint(d, 10, 5); C = addPoint(d, 5, 5)
      arc = addPath(d, [E, F], [{ kind: 'arc', center: C, sweep: 1 }])
    })
    pen.pick(A); pen.pickSegment(path, 0)
    expect(pen.availableConstraints()).toEqual([])
    pen.pick(C); pen.pickSegment(arc, 0)
    expect(pen.availableConstraints()).toEqual([])
  })

  it('a curve drop adds no second copy of a rule the point already has', () => {
    let A = '', B = '', q = ''
    const { doc, pen } = mk(d => {
      A = addPoint(d, 0, 0); B = addPoint(d, 10, 0); addPath(d, [A, B], [{ kind: 'line' }])
      q = addPoint(d, 3, 0.1)
      d.constraints.push({ id: 'k1', kind: 'collinear', refs: [A, B, q] } as any)
    })
    dragTo(pen, doc.value, q, 6, 0.2)
    pen.dropPoint(q)
    expect(doc.value.constraints.filter(c => c.kind === 'collinear')).toHaveLength(1)
  })

  it('a plain click on a point replaces a segment selection', () => {
    let p = '', path = ''
    const { pen } = mk(d => {
      const A = addPoint(d, 0, 0), B = addPoint(d, 10, 0); path = addPath(d, [A, B], [{ kind: 'line' }])
      p = addPoint(d, 3, 4)
    })
    pen.pickSegment(path, 0)
    pen.pick(p)
    expect(pen.selectedSegments.value).toEqual([])
    expect(pen.selection.value).toEqual([p])
  })

  it('Coincident refuses joins that would collapse a piece', () => {
    let a = '', b = '', A = '', C = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); b = addPoint(d, 5, 0); addLine(d, a, b)
      A = addPoint(d, 0, 5); const B = addPoint(d, 10, 5); C = addPoint(d, 5, 5)
      const D = addPoint(d, 10, 9)
      addPath(d, [A, B, D], [{ kind: 'arc', center: C, sweep: 1 }, { kind: 'line' }])
    })
    pen.pick(a); pen.pick(b, true)
    pen.apply('coincident')
    expect(pen.status.value).toBe('That would collapse the piece')
    expect(doc.value.entities.some(e => e.kind === 'line')).toBe(true)
    pen.pick(A); pen.pick(C, true)
    pen.apply('coincident')
    expect(pen.status.value).toBe('That would collapse the piece')
    expect(P(doc.value, C)).toBeTruthy()
    expect(pen.canUndo()).toBe(false)
  })

  it('a drop that does not join leaves the point at the pointer, not the snapped spot', () => {
    let e = ''
    const { doc, pen } = mk(d => {
      const a = addPoint(d, 0, 0); const b = addPoint(d, 6, 0); const c = addPoint(d, 6, 6); e = addPoint(d, 1, 5)
      addPath(d, [a, b, c, e], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }])
    })
    dragTo(pen, doc.value, e, 0.3, 0.2)
    expect(P(doc.value, e).x).toBeCloseTo(0, 3)   // sitting on the snapped spot
    pen.dropPoint(e, true)
    expect(P(doc.value, e).x).toBeCloseTo(0.3, 3)
    expect(P(doc.value, e).y).toBeCloseTo(0.2, 3)
  })
})

describe('final review — welding rejoins trimmed pieces', () => {
  it('a text guide split in two rejoins into one open path when an end is dropped on the other piece’s end', () => {
    let a = '', b = '', x1 = '', x2 = '', e = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); b = addPoint(d, 3, 0); x1 = addPoint(d, 6, 0)
      x2 = addPoint(d, 7, 0); e = addPoint(d, 10, 0)
      addPath(d, [a, b, x1], [{ kind: 'line' }, { kind: 'line' }])
      addPath(d, [x2, e], [{ kind: 'line' }])
    }, true)
    dragTo(pen, doc.value, x2, 6.1, 0.1)
    expect(pen.hoverSnap.value?.kind).toBe('point')
    pen.dropPoint(x2)
    expect(paths(doc.value)).toHaveLength(1)
    expect(paths(doc.value)[0]).toMatchObject({ closed: false, anchors: [a, b, x1, e] })
  })

  it('a text guide’s two ends on different pieces never close it (drag or Coincident)', () => {
    let a = '', x1 = '', x2 = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); const b = addPoint(d, 6, 0); x1 = addPoint(d, 6, 6)
      x2 = addPoint(d, 5, 6.5); const c = addPoint(d, 0, 6)
      addPath(d, [a, b, x1], [{ kind: 'line' }, { kind: 'line' }])
      addPath(d, [x2, c, a], [{ kind: 'line' }, { kind: 'line' }])
    }, true)
    dragTo(pen, doc.value, x2, 6.1, 6.1)
    expect(pen.hoverSnap.value?.kind).not.toBe('point')
    pen.dropPoint(x2)
    expect(paths(doc.value).every(p => !p.closed)).toBe(true)
    expect(P(doc.value, x2)).toBeTruthy()
    pen.pick(x1); pen.pick(x2, true)
    pen.apply('coincident')
    expect(paths(doc.value).every(p => !p.closed)).toBe(true)
    expect(pen.status.value).toBe('A text guide stays open')
  })

  it('outside a guide, a loop of two pieces welded at its last gap closes into one path', () => {
    let a = '', x1 = '', x2 = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); const b = addPoint(d, 6, 0); x1 = addPoint(d, 6, 6)
      x2 = addPoint(d, 5, 6.5); const c = addPoint(d, 0, 6)
      addPath(d, [a, b, x1], [{ kind: 'line' }, { kind: 'line' }])
      addPath(d, [x2, c, a], [{ kind: 'line' }, { kind: 'line' }])
    })
    dragTo(pen, doc.value, x2, 6.1, 6.1)
    pen.dropPoint(x2)
    expect(paths(doc.value)).toHaveLength(1)
    expect(paths(doc.value)[0].closed).toBe(true)
  })
})

describe('final review — a join keeps the selected segment pointing at the same piece', () => {
  function build() {
    let a = '', b = '', c = '', e = '', p1 = ''
    const { doc, pen } = mk(d => {
      a = addPoint(d, 0, 0); b = addPoint(d, 6, 0); c = addPoint(d, 6, 6)
      p1 = addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
      e = addPoint(d, -1, -5)
      addPath(d, [addPoint(d, -6, -5), e], [{ kind: 'line' }])
    })
    return { doc, pen, a, b, c, e, p1 }
  }
  const selectedPair = (pen: ReturnType<typeof usePen>, d: SketchDoc) => {
    const s = pen.selectedSegments.value[0]!
    const p = P(d, s.pathId)
    return [p.anchors[s.segIndex], p.anchors[(s.segIndex + 1) % p.anchors.length]].sort()
  }

  it('dragging another path’s end onto the selected path’s start (which reverses it) keeps b→c selected', () => {
    const { doc, pen, a, b, c, e, p1 } = build()
    pen.pickSegment(p1, 1)
    dragTo(pen, doc.value, e, 0.1, 0.1)
    pen.dropPoint(e)
    expect(paths(doc.value)).toHaveLength(1)
    expect(pen.selectedSegments.value).toHaveLength(1)
    expect(selectedPair(pen, doc.value)).toEqual([b, c].sort())
    pen.del()
    const left = paths(doc.value)
    expect(left.some(p => p.anchors.includes(a) && p.anchors.includes(b))).toBe(true)   // b→a survives
    expect(P(doc.value, c)).toBeUndefined()
  })

  it('a segment dragged onto nothing new keeps its own index (plain drag, no join)', () => {
    const { doc, pen, b, c, e, p1 } = build()
    pen.pickSegment(p1, 1)
    dragTo(pen, doc.value, e, -3, -8)
    pen.dropPoint(e)
    expect(pen.selectedSegments.value).toEqual([{ pathId: p1, segIndex: 1 }])
    expect(selectedPair(pen, doc.value)).toEqual([b, c].sort())
  })
})
