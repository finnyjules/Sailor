import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defaultSettings } from '~/lib/brushTips/tips'
import type { TipStroke } from '~/lib/brushTips/record'

// renderTipCoverage's compositing, with the GPU raster stubbed: each group raster is a token
// canvas, and every canvas records the drawImage calls made on it (source + composite op).
const engine = vi.hoisted(() => ({ path: 'gpu' as 'gpu' | '2d', calls: [] as { strokes: unknown[]; live: unknown; paint?: unknown }[] }))
vi.mock('~/lib/brushTips/engine', () => ({
  capView: (v: unknown) => v,
  tipRenderPath: () => engine.path,
  rasterGroup: (g: { strokes: unknown[] }, _v: unknown, live: unknown, _tail: unknown, paint?: unknown) => {
    engine.calls.push({ strokes: g.strokes, live, paint })
    return { coverage: { tag: `raster${engine.calls.length}` }, shade: null, gpu: engine.path === 'gpu' }
  },
}))
import { renderTipCoverage } from '~/lib/brushTips/coverage'

interface Op { src: unknown; composite: string }
type FakeCanvas = { width: number; height: number; ops: Op[]; getContext: () => unknown }
function fakeCanvas(): FakeCanvas {
  const c: FakeCanvas = { width: 0, height: 0, ops: [], getContext: () => ctx }
  let composite = 'source-over'
  const ctx = {
    get globalCompositeOperation() { return composite }, set globalCompositeOperation(v: string) { composite = v },
    drawImage(src: unknown) { c.ops.push({ src, composite }) },
  }
  return c
}
beforeEach(() => { engine.calls.length = 0; engine.path = 'gpu'; vi.stubGlobal('document', { createElement: () => fakeCanvas() }) })
afterEach(() => vi.unstubAllGlobals())

const view = { originX: 0, originY: 0, unitPx: 1, w: 50, h: 50 }
const tip = (t: 'spray' | 'round', erase = false, relief = 0): TipStroke => ({ tip: t, v: 1, size: 0.05, settings: { ...defaultSettings(t), relief }, seed: 1, pts: [0.1, 0.1, 0], ...(erase ? { erase: true } : {}) })
const legacy = { points: [{ x: 0.1, y: 0.1 }], radius: 0.01, hardness: 1, opacity: 1, erase: false }

describe('renderTipCoverage', () => {
  it('is a no-op for a legacy-only layer, even with a base', () => {
    expect(renderTipCoverage('k0', [legacy], view, null, 0, { tag: 'base' } as unknown as CanvasImageSource)).toBe(null)
    expect(engine.calls.length).toBe(0)
  })
  it('a tip eraser cuts the legacy base: base first, then paint, then the erase group destination-out', () => {
    const base = { tag: 'base' }
    const r = renderTipCoverage('k1', [legacy, tip('round'), tip('round', true)], view, null, 0, base as unknown as CanvasImageSource)!
    const ops = (r.coverage as unknown as FakeCanvas).ops
    expect(ops.map(o => [(o.src as { tag: string }).tag, o.composite])).toEqual([['base', 'source-over'], ['raster1', 'source-over'], ['raster2', 'destination-out']])
  })
  it('while live, rasters the committed groups once and only the live group per frame', () => {
    const committed = [tip('spray'), tip('round'), tip('round', false, 1)]
    const live = tip('round', false, 1)   // joins the last group (same relief)
    renderTipCoverage('k2', committed, view, live, 0)
    const first = engine.calls.length
    expect(first).toBe(3)                 // prefix: spray, round(relief 0) — then the live group
    renderTipCoverage('k2', committed, view, live, 0)
    renderTipCoverage('k2', committed, view, live, 0)
    expect(engine.calls.length).toBe(first + 2)
    expect(engine.calls.slice(first).every(c => c.strokes.length === 2 && c.live === live)).toBe(true)
  })
  it('a 2D fallback made while the GPU was lost is redrawn once the GPU is back', () => {
    const strokes = [tip('round')]
    engine.path = '2d'
    const a = renderTipCoverage('k3', strokes, view)
    expect(renderTipCoverage('k3', strokes, view)).toBe(a)   // still lost: cached
    engine.path = 'gpu'
    const b = renderTipCoverage('k3', strokes, view)
    expect(b).not.toBe(a)
    expect(renderTipCoverage('k3', strokes, view)).toBe(b)
  })
})
describe('renderTipCoverage with a material', () => {
  it('a material layer with legacy strokes is never served from the cache (its base carries the fill)', () => {
    const strokes = [legacy, tip('round')]
    const paint = { material: 'lava' as const, t: 0 }
    renderTipCoverage('m1', strokes, view, null, 0, { tag: 'base' } as unknown as CanvasImageSource, paint)
    renderTipCoverage('m1', strokes, view, null, 0, { tag: 'base2' } as unknown as CanvasImageSource, paint)
    expect(engine.calls.length).toBe(2)
    // control: the same layer without legacy strokes IS cached
    const tipsOnly = [tip('round')]
    renderTipCoverage('m2', tipsOnly, view, null, 0, null, paint)
    renderTipCoverage('m2', tipsOnly, view, null, 0, null, paint)
    expect(engine.calls.length).toBe(3)
  })
  it('a live render renders at the 1/30 s bucket; an exact (export) one at its exact time', () => {
    renderTipCoverage('m3', [tip('round')], view, null, 0, null, { material: 'foil', t: 1.01 })
    expect((engine.calls.at(-1)!.paint as { t: number }).t).toBeCloseTo(1, 9)
    renderTipCoverage('m4', [tip('round')], view, null, 0, null, { material: 'foil', t: 1.01, exact: true })
    expect((engine.calls.at(-1)!.paint as { t: number }).t).toBe(1.01)
  })
})
