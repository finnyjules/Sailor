import { describe, it, expect } from 'vitest'
import { reactive, effectScope } from 'vue'
import { addPoint, addPath } from '~/lib/sketch/edit'
import { mergeLayer, type GeoStudioDoc } from '~/lib/geoshape/studio'
import { sketchOutlineBounds } from '~/lib/geoshape/shapes'
import { naturalExtent, type PreviewFrame } from '~/lib/geoshape/penShape'
import { useShapePenSession, resizedFrame, SHAPE_PEN_TOOLS } from '~/composables/geoshape/useShapePenSession'
import { applyView } from '~/lib/sketch/view'
import type { SketchDoc } from '~/lib/sketch/model'

const FRAME: PreviewFrame = { cx: 0, cy: 0, scale: 1, cssW: 600, cssH: 600 }

function makeDoc(): GeoStudioDoc {
  return reactive({ layers: [mergeLayer({})] }) as unknown as GeoStudioDoc
}
function makeSession(doc: GeoStudioDoc) {
  return useShapePenSession({ doc: () => doc, layerIndex: () => 0, frameFor: () => FRAME })
}
function triangle(d: SketchDoc, dx = 0, dy = 0, closed = true) {
  const a = addPoint(d, 10 + dx, 0 + dy), b = addPoint(d, 50 + dx, 0 + dy), c = addPoint(d, 30 + dx, 20 + dy)
  addPath(d, [a, b, c], closed ? [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }] : [{ kind: 'line' }, { kind: 'line' }], closed)
}
const centreOf = (sk: SketchDoc) => {
  const b = sketchOutlineBounds(sk)!
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
}

describe('useShapePenSession', () => {
  it('opening on a fresh layer switches it to drawn and opens a path-tool session', () => {
    const doc = makeDoc()
    const before = doc.layers[0]!.mark.shape
    expect(before).not.toBe('drawn')
    const s = makeSession(doc)
    s.open()
    expect(s.session.value).not.toBeNull()
    expect(doc.layers[0]!.mark.shape).toBe('drawn')
    expect(s.session.value!.layerId).toBe(doc.layers[0]!.layerId)
    expect(s.session.value!.pen.tool.value).toBe('path')
    expect(s.session.value!.doc.value.entities).toEqual([])
  })

  it('a settled change writes the sketch (not re-centred) and size = k × extent; the view does not move', () => {
    const doc = makeDoc()
    const s = makeSession(doc)
    s.open()
    const sess = s.session.value!
    const view0 = { ...sess.view.value }
    triangle(sess.doc.value, 100, 100)
    sess.pen.commitHistory()
    const m = doc.layers[0]!.mark
    expect(m.sketch).toBeDefined()
    // written as drawn — the bbox centre is where it was drawn, not the origin
    expect(centreOf(m.sketch!)).toEqual({ x: 130, y: 110 })
    expect(m.size).toBeCloseTo(1 * naturalExtent(m.sketch!), 9)  // k = 1 for an empty start
    // a copy, never the pen's own doc
    expect(m.sketch).not.toBe(sess.doc.value)
    expect(sess.view.value).toEqual(view0)
  })

  it('commit re-centres the outline on (0,0), keeps k, stays drawn', () => {
    const doc = makeDoc()
    const s = makeSession(doc)
    s.open()
    const sess = s.session.value!
    triangle(sess.doc.value, 100, 100)
    sess.pen.commitHistory()
    s.commitSession()
    expect(s.session.value).toBeNull()
    const m = doc.layers[0]!.mark
    expect(m.shape).toBe('drawn')
    const c = centreOf(m.sketch!)
    expect(c.x).toBeCloseTo(0, 9); expect(c.y).toBeCloseTo(0, 9)
    expect(m.size).toBeCloseTo(naturalExtent(m.sketch!), 9)
    expect(m.paintTarget).toBe('fill')   // closed: fills stay fills
  })

  it('editing an existing drawing keeps its refit factor k on commit', () => {
    const doc = makeDoc()
    const m = doc.layers[0]!.mark
    const sk: SketchDoc = { entities: [], constraints: [] }
    triangle(sk, -30, -10)            // extent 40 → with size 200, k = 5
    m.shape = 'drawn'; m.sketch = sk; m.size = 200
    const s = makeSession(doc)
    s.open()
    const sess = s.session.value!
    // widen the drawing: add a point far right, joined into a new closed path
    const d = sess.doc.value
    const a = addPoint(d, 0, 0), b = addPoint(d, 60, 0), c = addPoint(d, 30, 5)
    addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    sess.pen.commitHistory()
    s.commitSession()
    expect(m.size).toBeCloseTo(5 * naturalExtent(m.sketch!), 9)
  })

  it('an open drawing on a filled mark commits as an outline', () => {
    const doc = makeDoc()
    const s = makeSession(doc)
    expect(doc.layers[0]!.mark.paintTarget).toBe('fill')
    s.open()
    triangle(s.session.value!.doc.value, 0, 0, false)
    s.commitSession()
    expect(doc.layers[0]!.mark.shape).toBe('drawn')
    expect(doc.layers[0]!.mark.paintTarget).toBe('outline')
  })

  it('commit with no outline is a cancel', () => {
    const doc = makeDoc()
    const shape = doc.layers[0]!.mark.shape
    const s = makeSession(doc)
    s.open()
    addPoint(s.session.value!.doc.value, 3, 4)
    s.commitSession()
    expect(s.session.value).toBeNull()
    expect(doc.layers[0]!.mark.shape).toBe(shape)
    expect('sketch' in doc.layers[0]!.mark).toBe(false)
  })

  it('cancel restores shape, sketch, size and paintTarget exactly', () => {
    const doc = makeDoc()
    const m = doc.layers[0]!.mark
    const orig = { shape: m.shape, size: m.size, paintTarget: m.paintTarget }
    const s = makeSession(doc)
    s.open()
    triangle(s.session.value!.doc.value, 0, 0, false)
    s.session.value!.pen.commitHistory()
    expect(m.sketch).toBeDefined()
    s.cancelSession()
    expect(s.session.value).toBeNull()
    expect({ shape: m.shape, size: m.size, paintTarget: m.paintTarget }).toEqual(orig)
    expect('sketch' in m).toBe(false)

    // and with an existing drawing: back to the very same drawing
    const sk: SketchDoc = { entities: [], constraints: [] }
    triangle(sk)
    m.shape = 'drawn'; m.sketch = sk; m.size = 150; m.paintTarget = 'both'
    const json = JSON.stringify(sk)
    s.open()
    triangle(s.session.value!.doc.value, 200, 0)
    s.session.value!.pen.commitHistory()
    expect(JSON.stringify(m.sketch)).not.toBe(json)
    s.cancelSession()
    expect(JSON.stringify(m.sketch)).toBe(json)
    expect(m.size).toBe(150)
    expect(m.paintTarget).toBe('both')
    expect(m.shape).toBe('drawn')
  })

  it('cancel keeps a paintTarget the user changed mid-session (M3) — only shape/sketch/size are reverted', () => {
    const doc = makeDoc()
    const m = doc.layers[0]!.mark
    expect(m.paintTarget).toBe('fill')   // starting point: Paint is not locked while the pen is open
    const s = makeSession(doc)
    s.open()
    triangle(s.session.value!.doc.value, 0, 0, false)   // an OPEN outline
    s.session.value!.pen.commitHistory()
    // the user switches "Colour applies to" themselves, mid-session, same as any
    // other Paint-section edit — the pen never locks that row
    m.paintTarget = 'outline'
    s.cancelSession()
    expect(s.session.value).toBeNull()
    // shape/sketch/size go back to what they were before the session opened...
    expect('sketch' in m).toBe(false)
    // ...but the user's own Paint choice survives Cancel
    expect(m.paintTarget).toBe('outline')
  })

  it('tearing the scope down mid-session cancels', () => {
    const doc = makeDoc()
    const m = doc.layers[0]!.mark
    const shape = m.shape
    const scope = effectScope()
    const s = scope.run(() => makeSession(doc))!
    s.open()
    triangle(s.session.value!.doc.value)
    s.session.value!.pen.commitHistory()
    expect(m.shape).toBe('drawn')
    scope.stop()
    expect(s.session.value).toBeNull()
    expect(m.shape).toBe(shape)
    expect('sketch' in m).toBe(false)
  })

  it('opening over an open session restores the first one (cancel, not close)', () => {
    const doc = makeDoc()
    const m = doc.layers[0]!.mark
    const shape = m.shape
    const s = makeSession(doc)
    s.open()
    triangle(s.session.value!.doc.value)
    s.session.value!.pen.commitHistory()
    expect(m.sketch).toBeDefined()
    const firstKey = s.session.value!.key
    s.open()
    // the first session's writes are gone: the second one opened on the restored mark
    expect(s.session.value!.key).toBeGreaterThan(firstKey)
    expect(s.session.value!.doc.value.entities).toEqual([])
    s.cancelSession()
    expect(m.shape).toBe(shape)
    expect('sketch' in m).toBe(false)
  })
  it('Shape Studio’s pen offers Round corner, Chamfer and Offset (pen stage 8)', () => {
    expect(SHAPE_PEN_TOOLS).toEqual(expect.arrayContaining(['round', 'chamfer', 'offset']))
  })
})

describe('resizing the preview while the pen is open', () => {
  const F: PreviewFrame = { cx: 12, cy: -8, scale: 1.5, cssW: 600, cssH: 400 }

  it('resizedFrame keeps the centre, scales with the box, and round-trips', () => {
    const r = resizedFrame(F, 300, 200)
    expect(r).toEqual({ cx: 12, cy: -8, scale: 0.75, cssW: 300, cssH: 200 })
    // rounding makes the ratios differ: the tighter axis governs, so nothing is cropped
    expect(resizedFrame(F, 300, 201).scale).toBeCloseTo(0.75, 12)
    expect(resizedFrame(F, 301, 200).scale).toBeCloseTo(0.75, 12)
    const back = resizedFrame(r, 600, 400)
    expect(back.cx).toBe(12); expect(back.cy).toBe(-8)
    expect(back.scale).toBeCloseTo(1.5, 12)
    // degenerate sizes leave the frame alone
    expect(resizedFrame(F, 0, 200)).toBe(F)
  })

  it('a drawing point stays at the same fraction of the preview after resize()', () => {
    const doc = makeDoc()
    const s = useShapePenSession({ doc: () => doc, layerIndex: () => 0, frameFor: () => F })
    s.open()
    const sess = s.session.value!
    const p = { x: 30, y: -20 }
    const a = applyView(sess.view.value, p)
    s.resize(300, 200)
    expect(sess.frame.value.cssW).toBe(300)
    const b = applyView(sess.view.value, p)
    expect(b.x / 300).toBeCloseTo(a.x / 600, 12)
    expect(b.y / 200).toBeCloseTo(a.y / 400, 12)
    // same size again: the frame object is not replaced
    const f = sess.frame.value
    s.resize(300, 200)
    expect(sess.frame.value).toBe(f)
  })
})
