import { describe, it, expect, vi, beforeEach } from 'vitest'

// Observe the finish pass without WebGL: `applyFinish` is the one call a foil region makes.
const finish = vi.hoisted(() => ({ ret: true }))
vi.mock('~/lib/compositor/finishPass', async (importOriginal) => {
  const orig = await importOriginal<typeof import('~/lib/compositor/finishPass')>()
  return { ...orig, applyFinish: vi.fn(() => finish.ret) }
})

import { paintLayerStack, type StackItem, type LocalLayer } from '~/composables/useCompositorLayers'
import { applyFinish, METALS } from '~/lib/compositor/finishPass'
import { createEffect } from '~/lib/compositor/effectStack'

const FOIL = { type: 'foil', metal: 'gold', brushed: 0.3, pressed: 0.6, grain: 0.7 } as const

function stubCtx(tag = 'ctx') {
  const ctx: any = {
    _tag: tag,
    _fillStyles: [] as unknown[],
    _strokeStyles: [] as unknown[],
    canvas: { width: 20, height: 20 },
    save: vi.fn(), restore: vi.fn(),
    drawImage: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(),
    setTransform: vi.fn(), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), transform: vi.fn(),
    beginPath: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), clip: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
    roundRect: vi.fn(), fill: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createPattern: vi.fn(() => ({})),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) =>
      ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })),
    putImageData: vi.fn(),
    measureText: vi.fn(() => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })),
    fillText: vi.fn(), strokeText: vi.fn(),
    globalCompositeOperation: 'source-over', globalAlpha: 1,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    imageSmoothingEnabled: true, lineWidth: 1,
  }
  let fs: unknown = '#000', ss: unknown = '#000'
  Object.defineProperty(ctx, 'fillStyle', { get: () => fs, set: (v) => { fs = v; ctx._fillStyles.push(v) } })
  Object.defineProperty(ctx, 'strokeStyle', { get: () => ss, set: (v) => { ss = v; ctx._strokeStyles.push(v) } })
  return ctx
}

function mkStubCanvas() {
  const c: any = { width: 0, height: 0 }
  const ctx = stubCtx('offscreen')
  ctx.canvas = c
  c.getContext = () => ctx
  return c
}

beforeEach(() => {
  finish.ret = true
  vi.mocked(applyFinish).mockClear()
  vi.stubGlobal('document', {
    createElement: (tag: string) => (tag === 'canvas' ? mkStubCanvas() : ({} as any)),
  })
})

const rect = (extra: Record<string, unknown>): LocalLayer => ({
  id: 'r1', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
  w: 0.4, h: 0.4, radius: 0, fill: '#ff0000', stroke: '', strokeWidth: 0, effects: [], ...extra,
} as any)

function paint(layer: LocalLayer) {
  const main = stubCtx('main')
  const items: StackItem[] = [{ type: 'local', key: 'l:' + layer.id, layer }]
  paintLayerStack(main, 20, 20, items, [layer])
  return main
}

describe('foil as a fill', () => {
  it('a rect with a foil fill runs the finish once, with the paint\'s dials (grain included)', () => {
    const main = paint(rect({ fill: FOIL }))
    expect(applyFinish).toHaveBeenCalledTimes(1)
    const [off, kind, dials] = vi.mocked(applyFinish).mock.calls[0]!
    expect(kind).toBe('gold_foil')
    expect(dials).toEqual({ metal: 'gold', brushed: 0.3, pressed: 0.6, grain: 0.7 })
    // The region was drawn white on the scratch, then stamped onto the frame.
    expect((off as any).getContext()._fillStyles).toContain('#ffffff')
    expect(main.drawImage).toHaveBeenCalledWith(off, 0, 0)
    // …and never filled flat on the frame itself.
    expect(main.fill).not.toHaveBeenCalled()
  })

  it('a foil fill with a solid stroke still strokes in the solid colour', () => {
    const main = paint(rect({ fill: FOIL, stroke: '#00ff00', strokeWidth: 0.02 }))
    expect(applyFinish).toHaveBeenCalledTimes(1)
    expect(main._strokeStyles).toContain('#00ff00')
    expect(main.stroke).toHaveBeenCalled()
  })

  it('floods the region with the mid metal when the finish cannot run', () => {
    finish.ret = false
    paint(rect({ fill: { ...FOIL, metal: 'copper' } }))
    const off = vi.mocked(applyFinish).mock.calls[0]![0] as any
    const sctx = off.getContext()
    expect(sctx._fillStyles).toContain(METALS.copper[2])
    expect(sctx.fillRect).toHaveBeenCalled()
  })

  it('a second foil region does not reuse the first one\'s pixels', () => {
    paint(rect({ fill: FOIL }))
    // The scratch (and its stub ctx) is module-level and outlives each paint: forget the
    // first use's calls so only the SECOND use can satisfy the assertion below.
    const sctx = (vi.mocked(applyFinish).mock.calls[0]![0] as any).getContext()
    sctx.clearRect.mockClear()
    sctx._fillStyles.length = 0
    paint(rect({ fill: FOIL }))
    expect(vi.mocked(applyFinish).mock.calls[1]![0]).toBe(vi.mocked(applyFinish).mock.calls[0]![0])
    expect(sctx.clearRect).toHaveBeenCalledWith(0, 0, 20, 20)
    expect(sctx._fillStyles).toContain('#ffffff')
  })

  it('a layer without foil never calls the finish', () => {
    paint(rect({ fill: '#ff0000', stroke: '#00ff00', strokeWidth: 0.02 }))
    expect(applyFinish).not.toHaveBeenCalled()
  })

  it('an ellipse with a foil fill runs the finish', () => {
    paint({ ...rect({ fill: FOIL }), kind: 'ellipse' } as any)
    expect(applyFinish).toHaveBeenCalledTimes(1)
  })

  it('a text layer with a foil colour runs the finish once', () => {
    const main = paint({
      id: 't1', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
      text: 'Foil', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.2,
      color: FOIL, align: 'center', lineHeight: 1.1, boxH: 0,
    } as any)
    expect(applyFinish).toHaveBeenCalledTimes(1)
    const off = vi.mocked(applyFinish).mock.calls[0]![0] as any
    expect(off.getContext().fillText).toHaveBeenCalled()
    // The frame's own glyph pass paints no flat metal under the foil.
    expect(main._fillStyles).not.toContain(METALS.gold[2])
  })
})

describe('foil and the silhouette cache', () => {
  // A feathered layer is normally baked once into a box-sized raster and restamped. Foil is
  // lit over the whole Frame by the Frame's light, so it must never be baked: every paint
  // re-runs the finish, on a frame-sized canvas.
  const feathered = (extra: Record<string, unknown>) => rect({ effects: [createEffect('feather')], ...extra })

  it('a foil fill with a feather re-lights on every paint, over the frame', () => {
    const layer = feathered({ fill: FOIL })
    paint(layer)
    paint(layer)
    expect(applyFinish).toHaveBeenCalledTimes(2)
    for (const [off] of vi.mocked(applyFinish).mock.calls) {
      expect((off as any).width).toBe(20)
      expect((off as any).height).toBe(20)
    }
  })

  it('a foil OUTLINE with a feather is not baked either', () => {
    const layer = feathered({ strokes: [{ id: 's1', paint: FOIL, width: 0.02, distance: 0, style: 'band' }] })
    paint(layer)
    paint(layer)
    expect(applyFinish).toHaveBeenCalledTimes(2)
  })
})

describe('foil as an outline', () => {
  it('a band outline with a foil paint runs the finish; the fill stays solid', () => {
    const main = paint(rect({
      fill: '#ff0000',
      strokes: [{ id: 's1', paint: FOIL, width: 0.02, distance: 0, style: 'band' }],
    }))
    expect(applyFinish).toHaveBeenCalledTimes(1)
    const off = vi.mocked(applyFinish).mock.calls[0]![0] as any
    expect(off.getContext()._strokeStyles).toContain('#ffffff')
    expect(off.getContext().stroke).toHaveBeenCalled()
    expect(main._fillStyles).toContain('#ff0000')
  })

  it('a path layer with a foil fill and a foil outline runs the finish twice', () => {
    vi.stubGlobal('Path2D', class { constructor(public d?: string) {} })
    paint({
      id: 'p1', kind: 'path', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
      d: 'M0 0 L10 0 L10 10 Z', bbox: { w: 10, h: 10 }, scale: 0.02, fill: FOIL,
      strokes: [{ id: 's1', paint: FOIL, width: 1, distance: 0, style: 'band' }],
      effects: [],
    } as any)
    expect(applyFinish).toHaveBeenCalledTimes(2)
  })
})
