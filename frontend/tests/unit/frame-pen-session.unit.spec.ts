import { describe, it, expect, vi } from 'vitest'
import { effectScope } from 'vue'
import { addPoint, addPath, addCircle } from '~/lib/sketch/edit'
import { applyView } from '~/lib/sketch/view'
import { sketchToLocalD, localOutlineBounds, newDrawingView, layerView } from '~/lib/compositor/penFrame'
import { useFramePenSession, isClosedDrawing, PEN_STYLE_OPEN, layerPlacementForView, clonerBlocksRecentre } from '~/composables/frame/useFramePenSession'

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

  it('a guide target is not handled yet (Task 9)', () => {
    const { host } = makeHost()
    const s = useFramePenSession(host)
    s.open({ kind: 'guide', textId: 'x' })
    expect(s.session.value).toBeNull()
  })
})

describe('useFramePenSession — reopening a drawn path layer', () => {
  /** A triangle drawn at (5,-10)(25,-12)(12,8), committed through a 'new' session. */
  function drawnLayer(extra: Record<string, unknown> = {}) {
    const { host, added } = makeHost()
    const s = useFramePenSession(host)
    s.open({ kind: 'new' })
    const doc = s.session.value!.doc.value
    const a = addPoint(doc, 5, -10), b = addPoint(doc, 25, -12), c = addPoint(doc, 12, 8)
    addPath(doc, [a, b, c], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    s.commitSession()
    return { ...added[0], ...extra }
  }
  /** A host whose layer list is live: `commit` replaces it. */
  function liveHost(initial: any[]) {
    let list = initial
    const host = {
      layers: () => list,
      size: () => ({ W, H }),
      recordHistory: vi.fn(),
      commit: vi.fn((next: any[]) => { list = next }),
      addPathLayers: vi.fn(),
      selectLocal: vi.fn(),
    }
    return { host, get: (id: string) => list.find(l => l.id === id) }
  }
  const pointsOf = (sk: any) => sk.entities.filter((e: any) => e.kind === 'point')

  it('open records nothing yet, clones the drawing, and views it through the layer\'s placement × layout scale', () => {
    const l = drawnLayer({ rotation: 30, skewX: 10, scale: 1.5, layoutScale: 0.8 })
    const { host } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    const sess = s.session.value!
    expect(host.recordHistory).not.toHaveBeenCalled()
    expect(host.commit).not.toHaveBeenCalled()
    expect(sess.doc.value).toEqual(l.sketch)
    expect(sess.doc.value).not.toBe(l.sketch)
    expect(sess.pen.tool.value).toBe('select')
    expect(layerPlacementForView(l).scale).toBeCloseTo(1.2, 12)
    expect(sess.view.value).toEqual(layerView({ x: l.x, y: l.y, rotation: 30, skewX: 10, skewY: 0, scale: 1.5 * 0.8 }, W, H))
  })

  it('a path without a drawing, a missing layer or a non-path is not opened', () => {
    const plain = { ...drawnLayer(), id: 'plain', sketch: undefined }
    const { host } = liveHost([plain, { id: 't', kind: 'text' }])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: 'plain' }); expect(s.session.value).toBeNull()
    s.open({ kind: 'layer', id: 't' }); expect(s.session.value).toBeNull()
    s.open({ kind: 'layer', id: 'nope' }); expect(s.session.value).toBeNull()
    expect(host.recordHistory).not.toHaveBeenCalled()
  })

  it('an edit previews on the layer itself with no history; x/y/bbox untouched', () => {
    const l = drawnLayer()
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    const pen = s.session.value!.pen
    const p0 = pointsOf(s.session.value!.doc.value)[0]
    p0.x += 7
    pen.finishSession()   // settles the change as a history step → onChange → preview
    const cur = get(l.id)
    expect(host.recordHistory).toHaveBeenCalledTimes(1)
    expect(cur.d).not.toBe(l.d)
    expect(cur.d).toBe(sketchToLocalD(cur.sketch))
    expect(cur.x).toBe(l.x); expect(cur.y).toBe(l.y); expect(cur.bbox).toEqual(l.bbox)
    expect(cur.fill).toBe(l.fill)
  })

  it('commit re-centres with the effective scale and keeps untouched corners planted on screen', () => {
    const l = drawnLayer({ rotation: 35, scale: 1.4, layoutScale: 0.5 })
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    const view0 = s.session.value!.view.value
    const pts = pointsOf(s.session.value!.doc.value)
    const before = pts.slice(1).map((p: any) => applyView(view0, p))
    pts[0].x -= 30; pts[0].y += 20
    const movedWant = applyView(view0, pts[0])
    s.commitSession()
    expect(s.session.value).toBeNull()
    expect(host.recordHistory).toHaveBeenCalledTimes(1)
    const cur = get(l.id)
    expect(cur.d).toBe(sketchToLocalD(cur.sketch))
    const bb = localOutlineBounds(cur.d)!
    expect((bb.minX + bb.maxX) / 2).toBeCloseTo(0, 9)
    expect((bb.minY + bb.maxY) / 2).toBeCloseTo(0, 9)
    expect(cur.bbox).not.toEqual(l.bbox)
    const view1 = layerView(layerPlacementForView(cur), W, H)
    const after = pointsOf(cur.sketch)
    const m = applyView(view1, after[0])
    expect(m.x).toBeCloseTo(movedWant.x, 6); expect(m.y).toBeCloseTo(movedWant.y, 6)
    after.slice(1).forEach((p: any, i: number) => {
      const q = applyView(view1, p)
      expect(q.x).toBeCloseTo(before[i].x, 6); expect(q.y).toBeCloseTo(before[i].y, 6)
    })
  })

  it('cancel writes the original layer back exactly; an emptied drawing commits as a cancel', () => {
    const l = drawnLayer()
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    pointsOf(s.session.value!.doc.value)[1].x += 12
    s.session.value!.pen.finishSession()
    expect(get(l.id).d).not.toBe(l.d)
    s.cancelSession()
    expect(s.session.value).toBeNull()
    expect(get(l.id)).toBe(l)

    s.open({ kind: 'layer', id: l.id })
    const doc = s.session.value!.doc.value
    doc.entities = doc.entities.filter((e: any) => e.kind !== 'path')
    s.commitSession()
    expect(get(l.id)).toBe(l)
  })

  it('open then leave with no edit (cancel, or commit) records nothing and writes nothing', () => {
    const l = drawnLayer()
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    s.cancelSession()
    s.open({ kind: 'layer', id: l.id })
    s.session.value!.pen.finishSession()
    s.commitSession()
    expect(s.session.value).toBeNull()
    expect(host.recordHistory).not.toHaveBeenCalled()
    expect(host.commit).not.toHaveBeenCalled()
    expect(get(l.id)).toBe(l)
  })

  it('history is recorded once, just before the first changing write', () => {
    const l = drawnLayer()
    const { host } = liveHost([l])
    const order: string[] = []
    host.recordHistory.mockImplementation(() => { order.push('record') })
    const commit0 = host.commit.getMockImplementation()!
    host.commit.mockImplementation((next: any[]) => { order.push('commit'); commit0(next) })
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    const pts = pointsOf(s.session.value!.doc.value)
    pts[0].x += 3; s.session.value!.pen.finishSession()
    pts[1].x += 3; s.session.value!.pen.finishSession()
    s.commitSession()
    expect(order).toEqual(['record', 'commit', 'commit', 'commit'])
  })

  it('tearing the host scope down mid-session puts the layer back', () => {
    const l = drawnLayer()
    const { host, get } = liveHost([l])
    const scope = effectScope()
    const s = scope.run(() => useFramePenSession(host))!
    s.open({ kind: 'layer', id: l.id })
    pointsOf(s.session.value!.doc.value)[1].x += 12
    s.session.value!.pen.finishSession()
    expect(get(l.id).d).not.toBe(l.d)
    scope.stop()
    expect(s.session.value).toBeNull()
    expect(get(l.id)).toBe(l)
  })

  it('clonerBlocksRecentre: only an enabled cloner whose copies turn or scale', () => {
    const base = { enabled: true, mode: 'linear', stepRotation: 0, stepScale: 1, faceCenter: false }
    expect(clonerBlocksRecentre({})).toBe(false)
    expect(clonerBlocksRecentre({ cloner: { ...base } })).toBe(false)
    expect(clonerBlocksRecentre({ cloner: { ...base, stepRotation: 15 } })).toBe(true)
    expect(clonerBlocksRecentre({ cloner: { ...base, stepScale: 0.9 } })).toBe(true)
    expect(clonerBlocksRecentre({ cloner: { ...base, faceCenter: true } })).toBe(false)   // linear ignores faceCenter
    expect(clonerBlocksRecentre({ cloner: { ...base, mode: 'radial' } })).toBe(false)
    expect(clonerBlocksRecentre({ cloner: { ...base, mode: 'radial', faceCenter: true } })).toBe(true)
    expect(clonerBlocksRecentre({ cloner: { ...base, enabled: false, stepRotation: 15, stepScale: 2 } })).toBe(false)
  })

  it('a layer whose copies turn is committed without re-centring: x/y unchanged, the outline stored as drawn', () => {
    const l = drawnLayer({ cloner: { enabled: true, mode: 'linear', stepRotation: 20, stepScale: 1, countX: 3, countY: 1 } })
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    const doc = s.session.value!.doc.value
    pointsOf(doc)[0].x -= 30
    const drawn = JSON.parse(JSON.stringify(doc))
    s.commitSession()
    const cur = get(l.id)
    expect(cur.x).toBe(l.x); expect(cur.y).toBe(l.y)
    expect(cur.sketch).toEqual(drawn)
    expect(cur.d).toBe(sketchToLocalD(drawn))
    const b = localOutlineBounds(cur.d)!
    expect(cur.bbox.w).toBeCloseTo(b.maxX - b.minX, 12)
    expect(cur.bbox.h).toBeCloseTo(b.maxY - b.minY, 12)
    expect((b.minX + b.maxX) / 2).not.toBeCloseTo(0, 3)   // really not re-centred
    expect(host.recordHistory).toHaveBeenCalledTimes(1)
  })
})
