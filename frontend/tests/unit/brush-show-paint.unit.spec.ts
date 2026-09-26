import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  brushPaintVisible, createBrushLayer, createRectLayer, drawLocalLayer, drawLayerSilhouette, paintLayerStack,
  type LocalLayer,
} from '~/composables/useCompositorLayers'

// Recording canvas + document.createElement stub, modeled on brush-layer-render.unit.spec.ts.
const ops: { ctx: string; op: string }[] = []
function recordingCtx(name: string) {
  let composite = 'source-over'
  const g = { addColorStop() {} }
  return {
    canvas: { width: 200, height: 200 },
    get globalCompositeOperation() { return composite }, set globalCompositeOperation(v: string) { composite = v },
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '', filter: 'none',
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), setTransform() {}, save() {}, restore() {},
    translate() {}, rotate() {}, scale() {}, clip() {}, rect() {}, closePath() {}, clearRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, roundRect() {}, ellipse() {}, bezierCurveTo() {}, quadraticCurveTo() {},
    fill() { ops.push({ ctx: name, op: 'fill' }) },
    stroke() { ops.push({ ctx: name, op: 'stroke' }) },
    fillRect() { ops.push({ ctx: name, op: 'fillRect' }) },
    createRadialGradient() { return g }, createLinearGradient() { return g }, createPattern() { return g },
    drawImage() { ops.push({ ctx: name, op: 'drawImage' }) },
  } as unknown as CanvasRenderingContext2D
}
let seq = 0
beforeEach(() => {
  ops.length = 0; seq = 0
  vi.stubGlobal('document', { createElement: () => { const n = `off-${++seq}`; const c: any = { width: 0, height: 0 }; c.getContext = () => recordingCtx(n); return c } })
})
afterEach(() => vi.unstubAllGlobals())

const stroke = { points: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }], radius: 0.05, hardness: 1, opacity: 1, erase: false }
const brush = (extra: Record<string, unknown> = {}) =>
  ({ ...createBrushLayer({ strokes: [stroke], fill: '#ff0000' }), ...extra }) as LocalLayer

describe('brushPaintVisible', () => {
  it('is false only for a brush layer with showPaint: false', () => {
    expect(brushPaintVisible(brush({ showPaint: false }))).toBe(false)
    expect(brushPaintVisible(brush({ showPaint: true }))).toBe(true)
    expect(brushPaintVisible(brush())).toBe(true)
  })
  it('is always true for a non-brush layer', () => {
    const rect = { ...createRectLayer(), showPaint: false } as unknown as LocalLayer
    expect(brushPaintVisible(rect)).toBe(true)
  })
})

describe('hidden brush paint', () => {
  it('drawLocalLayer draws nothing for a hidden brush layer', () => {
    drawLocalLayer(recordingCtx('main'), brush({ showPaint: false }), 200, 200)
    expect(ops.filter(o => o.ctx === 'main')).toEqual([])
  })
  it('a visible (absent or true) brush still draws', () => {
    drawLocalLayer(recordingCtx('main'), brush(), 200, 200)
    expect(ops.some(o => o.ctx === 'main' && o.op === 'drawImage')).toBe(true)
    ops.length = 0
    drawLocalLayer(recordingCtx('main'), brush({ showPaint: true }), 200, 200)
    expect(ops.some(o => o.ctx === 'main' && o.op === 'drawImage')).toBe(true)
  })
  it('a layer stack with a hidden brush and no effects paints nothing', () => {
    const l = brush({ showPaint: false })
    paintLayerStack(recordingCtx('main'), 200, 200, [{ type: 'local', key: `l:${l.id}`, layer: l }], [l])
    expect(ops.filter(o => o.ctx === 'main')).toEqual([])
  })
  it('a hidden brush with a backdrop effect: the effect is shaped by the paint, the paint never lands', () => {
    const l = brush({ showPaint: false, effects: [{ type: 'background_blur', radius: 4, visible: true }] })
    paintLayerStack(recordingCtx('main'), 200, 200, [{ type: 'local', key: `l:${l.id}`, layer: l }], [l])
    // off-1 is withBackdrop's silhouette: it received the brush paint.
    expect(ops.some(o => o.ctx === 'off-1' && o.op === 'drawImage')).toBe(true)
    // The main canvas gets exactly one stamp — the clipped effect — and no own-content draw.
    expect(ops.filter(o => o.ctx === 'main')).toEqual([{ ctx: 'main', op: 'drawImage' }])
  })
  it('the silhouette (mask source) still carries the real paint alpha', () => {
    const l = brush({ showPaint: false })
    drawLayerSilhouette(recordingCtx('main'), { type: 'local', key: `l:${l.id}`, layer: l }, 200, 200)
    expect(ops.some(o => o.ctx === 'main' && o.op === 'drawImage')).toBe(true)
  })
  it('a hidden brush used as a layer mask still clips by its paint', () => {
    const rect = createRectLayer() as LocalLayer
    const mask = brush({ showPaint: false })
    drawLocalLayer(recordingCtx('main'), rect, 200, 200, mask)
    // The mask offscreen (off-2) received the brush paint.
    expect(ops.some(o => o.ctx === 'off-2' && o.op === 'drawImage')).toBe(true)
  })
})
