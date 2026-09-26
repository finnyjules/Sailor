import { describe, it, expect, vi } from 'vitest'
import { effectScope } from 'vue'
import { addPoint, addPath, addCircle } from '~/lib/sketch/edit'
import { applyView } from '~/lib/sketch/view'
import { sketchToLocalD, localOutlineBounds, newDrawingView, layerView, guideView, SKETCH_UNITS } from '~/lib/compositor/penFrame'
import { guideFromSpec, customGuideMapping, guideSizeToTargetWidthPx } from '~/lib/compositor/textPath'
import { removeSegment } from '~/lib/sketch/trim'
import { useFramePenSession, isClosedDrawing, PEN_STYLE_OPEN, PEN_STYLE_CLOSED, layerPlacementForView, clonerBlocksRecentre } from '~/composables/frame/useFramePenSession'

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
    expect(a.pen.options.tools).toEqual(['select', 'path', 'curve', 'line', 'circle', 'point', 'trim', 'cut', 'dissolve'])
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

  it('a guide target on a missing layer or a non-text is not opened', () => {
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

  it('cancel writes the original drawing back exactly; an emptied drawing commits as a cancel', () => {
    const l = drawnLayer()
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    pointsOf(s.session.value!.doc.value)[1].x += 12
    s.session.value!.pen.finishSession()
    expect(get(l.id).d).not.toBe(l.d)
    s.cancelSession()
    expect(s.session.value).toBeNull()
    expect(get(l.id)).toEqual(l)
    expect(get(l.id).sketch).toBe(l.sketch)

    s.open({ kind: 'layer', id: l.id })
    const doc = s.session.value!.doc.value
    doc.entities = doc.entities.filter((e: any) => e.kind !== 'path')
    s.commitSession()
    expect(get(l.id)).toEqual(l)
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
    expect(get(l.id)).toEqual(l)
  })

  it('cancel puts back only what the pen wrote: a fill/stroke changed mid-session is kept', () => {
    const l = drawnLayer()
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    pointsOf(s.session.value!.doc.value)[1].x += 12
    s.session.value!.pen.finishSession()
    expect(get(l.id).d).not.toBe(l.d)
    // an inspector edit while the pen is open
    host.commit(host.layers().map((x: any) => (x.id === l.id ? { ...x, fill: '#ff0000', stroke: '#00ff00', strokeWidth: 0.01 } : x)))
    s.cancelSession()
    const back = get(l.id)
    expect(back.fill).toBe('#ff0000')
    expect(back.stroke).toBe('#00ff00')
    expect(back.strokeWidth).toBe(0.01)
    expect(back.d).toBe(l.d)
    expect(back.sketch).toBe(l.sketch)
    expect(back.x).toBe(l.x); expect(back.y).toBe(l.y); expect(back.bbox).toEqual(l.bbox)
  })

  // final review: a closed filled drawing trimmed open must not stay a fill with no stroke
  function trimOpen(s: ReturnType<typeof useFramePenSession>) {
    const doc = s.session.value!.doc.value
    const path = doc.entities.find((e: any) => e.kind === 'path')!
    expect(removeSegment(doc, path.id, 0).ok).toBe(true)
    s.session.value!.pen.commitHistory()
    s.commitSession()
  }

  it('a closed layer trimmed open with the pen\'s own fill switches to the pen\'s open stroke', () => {
    const l = drawnLayer()
    expect(l).toMatchObject(PEN_STYLE_CLOSED)
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    trimOpen(s)
    expect(isClosedDrawing(get(l.id).sketch)).toBe(false)
    expect(get(l.id)).toMatchObject(PEN_STYLE_OPEN)
  })

  it('a closed layer with a fill of the user\'s own, trimmed open, keeps that fill and gains a visible stroke', () => {
    const l = drawnLayer({ fill: '#ff0000' })
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    trimOpen(s)
    const cur = get(l.id)
    expect(cur.fill).toBe('#ff0000')
    expect(cur.stroke).toBe(PEN_STYLE_OPEN.stroke)
    expect(cur.strokeWidth).toBe(PEN_STYLE_OPEN.strokeWidth)
  })

  it('a closed layer that already has a stroke keeps its style when trimmed open', () => {
    const l = drawnLayer({ fill: '#ff0000', stroke: '#00ff00', strokeWidth: 0.02 })
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    trimOpen(s)
    expect(get(l.id)).toMatchObject({ fill: '#ff0000', stroke: '#00ff00', strokeWidth: 0.02 })
  })

  it('a closed layer whose copies turn, trimmed open, also switches to the open stroke', () => {
    const l = drawnLayer({ cloner: { enabled: true, stepRotation: 15 } })
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: l.id })
    trimOpen(s)
    expect(get(l.id)).toMatchObject(PEN_STYLE_OPEN)
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

describe('useFramePenSession — a text layer\'s drawn guide', () => {
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
  /** Guide px → artboard px, the text layer's own transform (T·R·Sh, no scale). */
  const textToScreen = (t: any, p: { x: number; y: number }) =>
    applyView(layerView({ x: t.x, y: t.y, rotation: t.rotation, skewX: t.skewX, skewY: t.skewY, scale: SKETCH_UNITS / W }, W, H), p)
  /** An open three-point drawing (drawing units): a line then a curve. */
  function drawArc(doc: any, pts: { x: number; y: number }[]) {
    const ids = pts.map(p => addPoint(doc, p.x, p.y))
    addPath(doc, ids, [{ kind: 'line' }, { kind: 'line' }])
  }
  /** The guide's start point on screen, as the text renders it. */
  const guideStartOnScreen = (t: any) => {
    const g = guideFromSpec(t.path, W, 100)!
    return textToScreen(t, g.at(0))
  }

  it('a fresh guide: open-only pen (Select/Pen/Curve) at true size around the text; the type re-lays live and sits on the drawing', () => {
    const text = { id: 't', kind: 'text', x: 0.4, y: 0.6, rotation: 20, skewX: 0, skewY: 0, path: { follow: 'custom' } }
    const { host, get } = liveHost([text])
    const s = useFramePenSession(host)
    s.open({ kind: 'guide', textId: 't' })
    const sess = s.session.value!
    expect(sess.target).toEqual({ kind: 'guide', textId: 't' })
    expect(sess.pen.options.openOnly).toBe(true)
    expect(sess.pen.options.tools).toEqual(['select', 'path', 'curve', 'trim', 'cut', 'dissolve'])
    expect(sess.pen.tool.value).toBe('path')
    const view0 = sess.view.value
    expect(view0).toEqual(layerView({ x: 0.4, y: 0.6, rotation: 20, skewX: 0, skewY: 0, scale: 1 }, W, H))
    expect(host.recordHistory).not.toHaveBeenCalled()

    const first = { x: -12, y: 5 }
    drawArc(sess.doc.value, [first, { x: 18, y: -9 }, { x: 40, y: 14 }])
    sess.pen.finishSession()   // settles → onChange → preview
    const cur = get('t')
    expect(host.recordHistory).toHaveBeenCalledTimes(1)
    expect(cur.path.follow).toBe('custom')
    expect(cur.path.d).toBe(sketchToLocalD(cur.path.sketch))
    expect(cur.path.sketch).not.toBe(sess.doc.value)
    // refit factor stays 1: the type is drawn at true size
    expect(customGuideMapping(cur.path.d, W, guideSizeToTargetWidthPx(cur.path.size, W))!.k).toBeCloseTo(1, 12)
    // what you see is what you get: the guide starts under the first anchor
    const want = applyView(view0, first)
    const got = guideStartOnScreen(cur)
    expect(Math.abs(got.x - want.x)).toBeLessThan(1e-6)
    expect(Math.abs(got.y - want.y)).toBeLessThan(1e-6)
    expect(s.session.value!.view.value).toEqual(view0)   // the view does not follow the moved text

    s.commitSession()
    expect(s.session.value).toBeNull()
    expect(host.recordHistory).toHaveBeenCalledTimes(1)
    expect(host.selectLocal).toHaveBeenCalledWith('t')
    const fin = get('t')
    const got2 = guideStartOnScreen(fin)
    expect(Math.abs(got2.x - want.x)).toBeLessThan(1e-6)
    expect(Math.abs(got2.y - want.y)).toBeLessThan(1e-6)
  })

  it('the path still being drawn re-lays the type live (before the path is finished)', () => {
    const text = { id: 't', kind: 'text', x: 0.5, y: 0.5, rotation: 0, path: { follow: 'custom', size: 0.5 } }
    const { host, get } = liveHost([text])
    const s = useFramePenSession(host)
    s.open({ kind: 'guide', textId: 't' })
    const pen = s.session.value!.pen
    pen.pathDown(-10, 0); pen.pathUp(-10, 0)
    expect(host.commit).not.toHaveBeenCalled()   // a lone point: nothing to follow yet
    pen.pathDown(15, 4)                           // mid-gesture: the second anchor is down
    expect(s.session.value!.doc.value.entities.some((e: any) => e.kind === 'path')).toBe(false)
    const live = get('t')
    expect(live.path.d).toBeTruthy()
    expect(live.path.sketch.entities.some((e: any) => e.kind === 'path' && !e.closed)).toBe(true)
    pen.pathUp(15, 4)
    s.commitSession()
    const done = get('t')
    expect(done.path.d).toBe(sketchToLocalD(done.path.sketch))
    expect(host.recordHistory).toHaveBeenCalledTimes(1)
  })

  /** A text whose guide was drawn, then resized (size ≠ natural width) and rotated. */
  function resizedGuideText() {
    const { host, get } = liveHost([{ id: 't', kind: 'text', x: 0.55, y: 0.45, rotation: 0, skewX: 0, skewY: 0, path: { follow: 'custom', start: 0.1 } }])
    const s = useFramePenSession(host)
    s.open({ kind: 'guide', textId: 't' })
    drawArc(s.session.value!.doc.value, [{ x: -20, y: 0 }, { x: 5, y: -15 }, { x: 25, y: 8 }])
    s.commitSession()
    const t = get('t')
    return { ...t, rotation: -35, skewX: 8, path: { ...t.path, size: t.path.size * 1.7 } }
  }

  it('an existing guide: the view is the guide\'s own; a drag keeps k, the type stays on the drawing at any size and rotation', () => {
    const text = resizedGuideText()
    const { host, get } = liveHost([text])
    const s = useFramePenSession(host)
    s.open({ kind: 'guide', textId: 't' })
    const sess = s.session.value!
    expect(sess.pen.tool.value).toBe('select')
    expect(sess.doc.value).toEqual(text.path.sketch)
    const view0 = sess.view.value
    expect(view0).toEqual(guideView(text, text.path, W, H))
    const kOpen = customGuideMapping(text.path.d, W, guideSizeToTargetWidthPx(text.path.size, W))!.k
    expect(kOpen).toBeCloseTo(1.7, 9)
    // the dots sit on the guide as it renders
    const pts = sess.doc.value.entities.filter((e: any) => e.kind === 'point') as any[]
    const firstBefore = applyView(view0, pts[0])
    const g0 = guideStartOnScreen(text)
    expect(Math.abs(g0.x - firstBefore.x)).toBeLessThan(1e-6)
    expect(Math.abs(g0.y - firstBefore.y)).toBeLessThan(1e-6)

    // drag the FIRST anchor well away: the bbox (and so the guide's midpoint) changes
    pts[0].x -= 14; pts[0].y += 11
    sess.pen.finishSession()
    const cur = get('t')
    expect(host.recordHistory).toHaveBeenCalledTimes(1)
    expect(cur.path.start).toBe(0.1)   // other dials kept
    expect(customGuideMapping(cur.path.d, W, guideSizeToTargetWidthPx(cur.path.size, W))!.k).toBeCloseTo(kOpen, 9)
    const want = applyView(view0, pts[0])
    const got = guideStartOnScreen(cur)
    expect(Math.abs(got.x - want.x)).toBeLessThan(1e-6)
    expect(Math.abs(got.y - want.y)).toBeLessThan(1e-6)
    expect(cur.x).not.toBe(text.x)
  })

  it('a zero-width drawing (a perfectly vertical line) keeps the guide\'s Path size instead of writing 0', () => {
    const text = resizedGuideText()
    const { host, get } = liveHost([text])
    const s = useFramePenSession(host)
    s.open({ kind: 'guide', textId: 't' })
    const pts = s.session.value!.doc.value.entities.filter((e: any) => e.kind === 'point') as any[]
    for (const p of pts) p.x = 5
    s.session.value!.pen.finishSession()
    expect(get('t').path.d).not.toBe(text.path.d)
    expect(get('t').path.size).toBe(text.path.size)
    s.commitSession()
    expect(get('t').path.size).toBe(text.path.size)
    expect(get('t').path.size).toBeGreaterThan(0)
  })

  it('cancel restores path, x and y exactly; no edit leaves no undo step; commit with no edit writes nothing', () => {
    const text = resizedGuideText()
    const { host, get } = liveHost([text])
    const s = useFramePenSession(host)
    s.open({ kind: 'guide', textId: 't' })
    const pts = s.session.value!.doc.value.entities.filter((e: any) => e.kind === 'point') as any[]
    pts[2].x += 9
    s.session.value!.pen.finishSession()
    expect(get('t').path.d).not.toBe(text.path.d)
    s.cancelSession()
    const back = get('t')
    expect(back.path).toBe(text.path)
    expect(back.x).toBe(text.x); expect(back.y).toBe(text.y)
    expect(JSON.stringify(back)).toBe(JSON.stringify(text))

    const h2 = liveHost([text])
    const s2 = useFramePenSession(h2.host)
    s2.open({ kind: 'guide', textId: 't' }); s2.cancelSession()
    s2.open({ kind: 'guide', textId: 't' }); s2.commitSession()
    expect(h2.host.recordHistory).not.toHaveBeenCalled()
    expect(h2.host.commit).not.toHaveBeenCalled()
    expect(h2.get('t')).toBe(text)
  })

  it('undo back to an empty drawing puts the opening guide and position back without closing', () => {
    const text = { id: 't', kind: 'text', x: 0.4, y: 0.6, rotation: 15, path: { follow: 'custom', size: 0.5 } }
    const { host, get } = liveHost([text])
    const s = useFramePenSession(host)
    s.open({ kind: 'guide', textId: 't' })
    const sess = s.session.value!
    drawArc(sess.doc.value, [{ x: -12, y: 5 }, { x: 18, y: -9 }, { x: 40, y: 14 }])
    sess.pen.finishSession()
    expect(get('t').path.sketch).toBeTruthy()
    expect(get('t').x).not.toBe(text.x)
    sess.pen.undo()   // back to nothing drawn
    expect(sess.doc.value.entities).toEqual([])
    expect(s.session.value).toBe(sess)   // still open
    const back = get('t')
    expect(back.path).toBe(text.path)
    expect(back.x).toBe(text.x); expect(back.y).toBe(text.y)
    expect(host.recordHistory).toHaveBeenCalledTimes(1)
    // drawing again writes again
    sess.pen.redo()
    expect(get('t').path.sketch).toBeTruthy()
  })

  it('a guide with a d but no drawing opens fresh; an emptied drawing commits as a cancel; teardown restores', () => {
    const text = { id: 't', kind: 'text', x: 0.5, y: 0.5, rotation: 0, path: { follow: 'custom', d: 'M -0.1 0 L 0.1 0', size: 0.5 } }
    const { host, get } = liveHost([text])
    const s = useFramePenSession(host)
    s.open({ kind: 'guide', textId: 't' })
    expect(s.session.value!.doc.value.entities).toEqual([])
    expect(s.session.value!.view.value).toEqual(layerView({ x: 0.5, y: 0.5, rotation: 0, skewX: 0, skewY: 0, scale: 1 }, W, H))
    addPoint(s.session.value!.doc.value, 3, 4)   // a lone point: no outline
    s.commitSession()
    expect(get('t')).toBe(text)
    expect(host.commit).not.toHaveBeenCalled()

    const scope = effectScope()
    const h2 = liveHost([text])
    let s2: ReturnType<typeof useFramePenSession>
    scope.run(() => { s2 = useFramePenSession(h2.host) })
    s2!.open({ kind: 'guide', textId: 't' })
    drawArc(s2!.session.value!.doc.value, [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }])
    s2!.session.value!.pen.finishSession()
    expect(h2.get('t').path.sketch).toBeTruthy()
    scope.stop()
    expect(h2.get('t').path).toBe(text.path)
  })
})
