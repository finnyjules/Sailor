import { describe, it, expect, vi } from 'vitest'
import { addPoint, addPath, addCircle } from '~/lib/sketch/edit'
import { applyView } from '~/lib/sketch/view'
import { sketchToLocalD, localOutlineBounds, newDrawingView } from '~/lib/compositor/penFrame'
import { useFramePenSession, isClosedDrawing, PEN_STYLE_OPEN } from '~/composables/frame/useFramePenSession'

const W = 680, H = 400

function makeHost() {
  const added: any[] = []
  const host = {
    layers: () => [] as any[],
    size: () => ({ W, H }),
    recordHistory: vi.fn(),
    commit: vi.fn(),
    addPathLayers: vi.fn((ls: any[]) => { added.push(...ls) }),
    selectLocal: vi.fn(),
  }
  return { host, added }
}

describe('useFramePenSession — new drawings', () => {
  it('open starts a path-tool pen over an empty drawing at the centred view; key re-keys per open', () => {
    const { host } = makeHost()
    const s = useFramePenSession(host)
    expect(s.session.value).toBeNull()
    s.open({ kind: 'new' })
    const a = s.session.value!
    expect(a.target).toEqual({ kind: 'new' })
    expect(a.doc.value.entities).toEqual([])
    expect(a.pen.tool.value).toBe('path')
    expect(a.pen.options.tools).toEqual(['select', 'path', 'curve', 'line', 'circle', 'point'])
    expect(a.view.value).toEqual(newDrawingView(W, H))
    s.cancelSession()
    s.open({ kind: 'new' })
    expect(s.session.value!.key).toBeGreaterThan(a.key)
  })

  it('cancel closes and writes nothing', () => {
    const { host } = makeHost()
    const s = useFramePenSession(host)
    s.open({ kind: 'new' })
    const doc = s.session.value!.doc.value
    const p = addPoint(doc, 0, 0), q = addPoint(doc, 10, 0)
    addPath(doc, [p, q], [{ kind: 'line' }])
    s.cancelSession()
    expect(s.session.value).toBeNull()
    expect(host.addPathLayers).not.toHaveBeenCalled()
    expect(host.commit).not.toHaveBeenCalled()
  })

  it('commit with no outline just closes', () => {
    const { host } = makeHost()
    const s = useFramePenSession(host)
    s.open({ kind: 'new' })
    addPoint(s.session.value!.doc.value, 3, 4)   // a lone point has no outline
    s.commitSession()
    expect(s.session.value).toBeNull()
    expect(host.addPathLayers).not.toHaveBeenCalled()
  })

  it('commit turns a closed drawing into one filled path layer that remembers its drawing, planted where it was drawn', () => {
    const { host, added } = makeHost()
    const s = useFramePenSession(host)
    s.open({ kind: 'new' })
    const sess = s.session.value!
    const doc = sess.doc.value
    // a triangle off-centre, in drawing units
    const a = addPoint(doc, 5, -10), b = addPoint(doc, 25, -12), c = addPoint(doc, 12, 8)
    addPath(doc, [a, b, c], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    // where it sits on screen while drawing
    const screen = [{ x: 5, y: -10 }, { x: 25, y: -12 }, { x: 12, y: 8 }].map(p => applyView(sess.view.value, p))
    const want = {
      x: (Math.min(...screen.map(p => p.x)) + Math.max(...screen.map(p => p.x))) / 2,
      y: (Math.min(...screen.map(p => p.y)) + Math.max(...screen.map(p => p.y))) / 2,
    }
    s.commitSession()
    expect(s.session.value).toBeNull()
    expect(host.addPathLayers).toHaveBeenCalledTimes(1)
    expect(added).toHaveLength(1)
    const l = added[0]
    expect(l.kind).toBe('path')
    expect(l.sketch).toBeTruthy()
    expect(l.d).toBe(sketchToLocalD(l.sketch))
    expect(l.fill).toBe('#3b82f6'); expect(l.stroke).toBe(''); expect(l.strokeWidth).toBe(0)
    expect(l.scale).toBe(1)
    const bb = localOutlineBounds(l.d)!
    expect((bb.minX + bb.maxX) / 2).toBeCloseTo(0, 9)
    expect((bb.minY + bb.maxY) / 2).toBeCloseTo(0, 9)
    expect(l.bbox.w).toBeCloseTo(0.2, 9); expect(l.bbox.h).toBeCloseTo(0.2, 9)
    expect(l.x * W).toBeCloseTo(want.x, 6)
    expect(l.y * H).toBeCloseTo(want.y, 6)
    expect(host.selectLocal).toHaveBeenCalledWith(l.id)
    // the stored drawing is not the pen's (a later pen edit cannot reach it)
    expect(l.sketch).not.toBe(doc)
  })

  it('an open drawing is stroked, not filled', () => {
    const { host, added } = makeHost()
    const s = useFramePenSession(host)
    s.open({ kind: 'new' })
    const doc = s.session.value!.doc.value
    const p = addPoint(doc, 0, 0), q = addPoint(doc, 30, 10)
    addPath(doc, [p, q], [{ kind: 'line' }])
    s.commitSession()
    expect(added[0].fill).toBe(PEN_STYLE_OPEN.fill)
    expect(added[0].stroke).toBe('#3b82f6')
    expect(added[0].strokeWidth).toBe(0.004)
  })

  it('a circle counts as closed; construction geometry does not', () => {
    const d1 = { entities: [], constraints: [] } as any
    addCircle(d1, addPoint(d1, 0, 0), 5)
    expect(isClosedDrawing(d1)).toBe(true)
    const d2 = { entities: [], constraints: [] } as any
    addCircle(d2, addPoint(d2, 0, 0), 5, { construction: true })
    const p = addPoint(d2, 0, 0), q = addPoint(d2, 5, 5)
    addPath(d2, [p, q], [{ kind: 'line' }])
    expect(isClosedDrawing(d2)).toBe(false)
  })

  it('layer and guide targets are not handled yet (Tasks 8–9)', () => {
    const { host } = makeHost()
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: 'x' })
    expect(s.session.value).toBeNull()
  })
})
