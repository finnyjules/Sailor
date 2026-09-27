// tests/unit/frame-pen-fills.unit.spec.ts
// Pen stage 7, the Frame's pen session: Fill is offered; a filled drawing
// counts as closed; fillD is written only when an area is filled (and a
// drawing without fills writes exactly what it did before); a new drawing of
// open lines with a filled area becomes a filled layer; reopening an open
// layer and filling it previews fillD and the pen's fill colour, and Cancel
// puts both back; a text guide never keeps fills.
import { describe, it, expect, vi } from 'vitest'
import { addPoint, addPath, addLine } from '~/lib/sketch/edit'
import { sketchToLocalD, sketchFillToLocalD, withPenOutlines } from '~/lib/compositor/penFrame'
import { useFramePenSession, isClosedDrawing, filledStyle, PEN_STYLE_OPEN, PEN_STYLE_CLOSED, FRAME_PEN_TOOLS, guideWrite } from '~/composables/frame/useFramePenSession'
import { toggleFillAt } from '~/lib/sketch/fills'
import type { SketchDoc } from '~/lib/sketch/model'

const W = 680, H = 400
function liveHost(initial: any[]) {
  let list = initial
  const added: any[] = []
  const host = {
    layers: () => list, size: () => ({ W, H }), recordHistory: vi.fn(),
    commit: vi.fn((next: any[]) => { list = next }),
    addPathLayers: vi.fn((ls: any[]) => { added.push(...ls); list = [...list, ...ls] }), selectLocal: vi.fn(),
  }
  return { host, added, get: (id: string) => list.find(l => l.id === id) }
}
// three open lines crossing in a triangle (drawing units: 100 per canvas width)
function crossingLines(doc: SketchDoc) {
  addLine(doc, addPoint(doc, -12, 0), addPoint(doc, 12, 0))
  addLine(doc, addPoint(doc, -10, -4), addPoint(doc, 2, 14))
  addLine(doc, addPoint(doc, 10, -4), addPoint(doc, -2, 14))
}
describe('Frame: fills', () => {
  it('Fill is a tool of the Frame’s pen; a filled drawing counts as closed', () => {
    expect(FRAME_PEN_TOOLS).toContain('fill')
    const d: SketchDoc = { entities: [], constraints: [] }
    crossingLines(d)
    expect(isClosedDrawing(d)).toBe(false)
    toggleFillAt(d, { x: 0, y: 3 }, 0)
    expect(isClosedDrawing(d)).toBe(true)
    expect(filledStyle({ fill: 'none' })).toEqual({ fill: PEN_STYLE_CLOSED.fill })
    expect(filledStyle({ fill: '#ff0000' })).toEqual({})
  })
  it('withPenOutlines writes fillD only when an area is filled, and exactly {...l, d, sketch} otherwise', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    crossingLines(d)
    const l = { id: 'x', kind: 'path', d: 'old', sketch: d, fill: 'none', fillD: 'stale' }
    const none = withPenOutlines(l, d)
    expect('fillD' in none).toBe(false)
    const plain = { id: 'y', kind: 'path', d: 'old', sketch: d, fill: 'none' }
    expect(JSON.stringify(withPenOutlines(plain, d))).toBe(JSON.stringify({ ...plain, d: sketchToLocalD(d), sketch: d }))
    toggleFillAt(d, { x: 0, y: 3 }, 0)
    const w = withPenOutlines(l, d)
    expect(w.fillD).toBe(sketchFillToLocalD(d))
    expect(w.fillD).toMatch(/^M .* Z$/)
  })
  it('a new drawing of open lines with a filled area becomes a filled layer with fillD', () => {
    const { host, added } = liveHost([])
    const s = useFramePenSession(host)
    s.open({ kind: 'new' })
    const pen = s.session.value!.pen
    crossingLines(s.session.value!.doc.value)
    pen.commitHistory()
    pen.selectTool('fill'); pen.fillClick(0, 3)
    s.commitSession()
    const layer = added[0]
    expect(layer.fill).toBe(PEN_STYLE_CLOSED.fill)
    expect(layer.fillD).toBe(sketchFillToLocalD(layer.sketch))
    expect(layer.d).toBe(sketchToLocalD(layer.sketch))
  })
  it('reopening an open layer: filling previews fillD and the pen’s fill colour; Cancel puts both back', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    crossingLines(d)
    const l = { id: 'L', kind: 'path', x: 0.5, y: 0.5, scale: 1, rotation: 0, d: sketchToLocalD(d), sketch: d, bbox: { w: 0.2, h: 0.2 }, ...PEN_STYLE_OPEN }
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: 'L' })
    const pen = s.session.value!.pen
    pen.selectTool('fill'); pen.fillClick(0, 3)
    expect(get('L').fillD).toBe(sketchFillToLocalD(get('L').sketch))
    expect(get('L').fill).toBe(PEN_STYLE_CLOSED.fill)
    s.cancelSession()
    expect('fillD' in get('L')).toBe(false)
    expect(get('L').fill).toBe('none')
    expect(get('L').d).toBe(l.d)
  })
  it('a guide never keeps fills', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0), c = addPoint(d, 5, 8)
    addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    toggleFillAt(d, { x: 5, y: 2 }, 0)
    const out = guideWrite({ id: 't', kind: 'text', x: 0.5, y: 0.5, path: {} }, d, { x: 0.5, y: 0.5, rotation: 0, skewX: 0, skewY: 0, k: 1, mid: { x: 0, y: 0 } }, W, H)
    expect(out.path.sketch.fills).toBeUndefined()
  })
})

// two unit squares sharing an edge, both filled (drawing units)
function twoSquares(doc: SketchDoc) {
  const p = [[0, 0], [10, 0], [20, 0], [20, 10], [10, 10], [0, 10]].map(([x, y]) => addPoint(doc, x!, y!))
  addPath(doc, p, p.map(() => ({ kind: 'line' as const })), true)
  addLine(doc, p[1]!, p[4]!)
  toggleFillAt(doc, { x: 5, y: 5 }, 0)
  toggleFillAt(doc, { x: 15, y: 5 }, 0)
}
describe('Frame: touching filled areas are written as one ring', () => {
  it('fillD is the union’s boundary (the shared edge left out), so ring-by-ring effects open no seam', async () => {
    const { fillPathData } = await import('~/lib/sketch/fills')
    const d: SketchDoc = { entities: [], constraints: [] }
    twoSquares(d)
    expect((fillPathData(d).match(/M /g) ?? []).length).toBe(2)   // the pen's own tint: face by face
    const fd = sketchFillToLocalD(d)
    expect((fd.match(/M /g) ?? []).length).toBe(1)
    // the ring visits the outer corners only: the shared edge (0.1,0)–(0.1,0.1) is not drawn
    expect(fd).not.toMatch(/L 0\.1 0\.1 L 0\.1 0 /)
    expect(fd).not.toMatch(/L 0\.1 0 L 0\.1 0\.1 /)
    for (const c of ['0 0', '0.2 0', '0.2 0.1', '0 0.1']) expect(fd).toContain(c)
  })
  it('a single filled area writes the same outline as the pen’s own', async () => {
    const { fillPathData } = await import('~/lib/sketch/fills')
    const d: SketchDoc = { entities: [], constraints: [] }
    crossingLines(d)
    toggleFillAt(d, { x: 0, y: 3 }, 0)
    expect(sketchFillToLocalD(d)).toBe(fillPathData(d, 0.01))
  })
  it('a filled area inside a filled ring: the hole is closed by the inner fill (one outline, no hole)', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const sq = (x: number, y: number, s: number) => {
      const p = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([a, b]) => addPoint(d, a!, b!))
      addPath(d, p, p.map(() => ({ kind: 'line' as const })), true)
    }
    sq(0, 0, 30); sq(10, 10, 10)
    toggleFillAt(d, { x: 2, y: 2 }, 0)
    expect((sketchFillToLocalD(d).match(/M /g) ?? []).length).toBe(2)   // ring + hole
    toggleFillAt(d, { x: 15, y: 15 }, 0)
    expect((sketchFillToLocalD(d).match(/M /g) ?? []).length).toBe(1)   // hole filled: one outline
  })
})

describe('Frame: the layer session and fills', () => {
  it('Cancel after emptying a filled layer puts its fillD back; its own fill colour is never touched', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    crossingLines(d)
    toggleFillAt(d, { x: 0, y: 3 }, 0)
    const fillD = sketchFillToLocalD(d)
    const l = { id: 'L', kind: 'path', x: 0.5, y: 0.5, scale: 1, rotation: 0, d: sketchToLocalD(d), fillD, sketch: d, bbox: { w: 0.2, h: 0.2 }, fill: '#ff0000', stroke: '', strokeWidth: 0 }
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: 'L' })
    const pen = s.session.value!.pen
    pen.selectTool('fill'); pen.fillClick(0, 3)
    expect('fillD' in get('L')).toBe(false)
    expect(get('L').sketch.fills).toBeUndefined()
    expect(get('L').fill).toBe('#ff0000')
    s.cancelSession()
    expect(get('L').fillD).toBe(fillD)
    expect(get('L').sketch.fills).toHaveLength(1)
    expect(get('L').fill).toBe('#ff0000')
  })
  it('committing a reopened layer writes fillD, and a layer whose fills all go loses it', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    crossingLines(d)
    const l = { id: 'L', kind: 'path', x: 0.5, y: 0.5, scale: 1, rotation: 0, d: sketchToLocalD(d), sketch: d, bbox: { w: 0.2, h: 0.2 }, ...PEN_STYLE_OPEN }
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: 'L' })
    s.session.value!.pen.selectTool('fill'); s.session.value!.pen.fillClick(0, 3)
    s.commitSession()
    expect(get('L').fillD).toBe(sketchFillToLocalD(get('L').sketch))
    expect(get('L').d).toBe(sketchToLocalD(get('L').sketch))
    expect(get('L').fill).toBe(PEN_STYLE_CLOSED.fill)
    // reopen, empty it, commit: no fillD, and the drawing reads as opened (stroked).
    // The commit re-centred the drawing: the same area sits shifted by the first point's move.
    const p0 = d.entities.find(e => e.kind === 'point') as { id: string; x: number; y: number }
    const q0 = get('L').sketch.entities.find((e: any) => e.id === p0.id) as { x: number; y: number }
    s.open({ kind: 'layer', id: 'L' })
    const pen = s.session.value!.pen
    pen.selectTool('fill'); pen.fillClick(0 + q0.x - p0.x, 3 + q0.y - p0.y)
    expect(get('L').sketch.fills).toBeUndefined()
    s.commitSession()
    expect('fillD' in get('L')).toBe(false)
    expect(get('L').stroke).toBe(PEN_STYLE_OPEN.stroke)
    expect(get('L').fill).toBe(PEN_STYLE_OPEN.fill)
  })
  it('filling then emptying in one session gives the pen’s fill colour back, and the commit keeps the open style', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    crossingLines(d)
    const l = { id: 'L', kind: 'path', x: 0.5, y: 0.5, scale: 1, rotation: 0, d: sketchToLocalD(d), sketch: d, bbox: { w: 0.2, h: 0.2 }, ...PEN_STYLE_OPEN }
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: 'L' })
    const pen = s.session.value!.pen
    pen.selectTool('fill'); pen.fillClick(0, 3)
    expect(get('L').fill).toBe(PEN_STYLE_CLOSED.fill)
    pen.fillClick(0, 3)
    expect('fillD' in get('L')).toBe(false)
    expect(get('L').fill).toBe('none')
    s.commitSession()
    expect(get('L')).toMatchObject(PEN_STYLE_OPEN)
    expect('fillD' in get('L')).toBe(false)
  })
})

describe('fix round 1: Cancel never overwrites a colour set mid-session', () => {
  it('filled by the pen, recoloured by the user, cancelled: the user’s colour stays', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    crossingLines(d)
    const l = { id: 'L', kind: 'path', x: 0.5, y: 0.5, scale: 1, rotation: 0, d: sketchToLocalD(d), sketch: d, bbox: { w: 0.2, h: 0.2 }, ...PEN_STYLE_OPEN }
    const { host, get } = liveHost([l])
    const s = useFramePenSession(host)
    s.open({ kind: 'layer', id: 'L' })
    const pen = s.session.value!.pen
    pen.selectTool('fill'); pen.fillClick(0, 3)
    expect(get('L').fill).toBe(PEN_STYLE_CLOSED.fill)
    host.commit(host.layers().map((x: any) => (x.id === 'L' ? { ...x, fill: '#00ff00' } : x)))   // the inspector
    s.cancelSession()
    expect('fillD' in get('L')).toBe(false)
    expect(get('L').fill).toBe('#00ff00')
  })
})
