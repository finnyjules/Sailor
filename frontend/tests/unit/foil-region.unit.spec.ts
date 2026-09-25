/**
 * Foil regions after the final review of "Gold foil becomes a fill":
 *  - each region's GPU pass runs over the LAYER's device box, not the whole canvas, and is told
 *    where that box sits so the lighting stays in frame space (finding 3);
 *  - foil OUTLINES on text are lit, on both the glyph-outline and the fillText routes (finding 2);
 *  - hit-testing draws foil flat, and a draw outside paintLayerStack can name the light (M3/M4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const finish = vi.hoisted(() => ({ ret: true }))
vi.mock('~/lib/compositor/finishPass', async (importOriginal) => {
  const orig = await importOriginal<typeof import('~/lib/compositor/finishPass')>()
  return { ...orig, applyFinish: vi.fn(() => finish.ret) }
})
// The glyph-outline text route needs a font; hand it one whose every run is a 10×10 square.
vi.mock('~/lib/compositor/textOutline', async (importOriginal) => {
  const orig = await importOriginal<typeof import('~/lib/compositor/textOutline')>()
  return {
    ...orig,
    getCompositorFont: () => ({ id: 'stub', axes: [], unitsPerEm: 1000, raw: {} }),
    runToCommands: () => [
      { command: 'moveTo', args: [0, 0] }, { command: 'lineTo', args: [10, 0] },
      { command: 'lineTo', args: [10, 10] }, { command: 'closePath', args: [] },
    ],
  }
})

import {
  paintLayerStack, drawLocalLayer, withFlatFoil, withFrameLight, type StackItem, type LocalLayer,
} from '~/composables/useCompositorLayers'
import { applyFinish, METALS } from '~/lib/compositor/finishPass'

const FOIL = { type: 'foil', metal: 'gold', brushed: 0.3, pressed: 0.6, grain: 0.7 } as const

type M = [number, number, number, number, number, number]
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
]

/** A 2D context stub that TRACKS its transform (save/restore included), so the device box a
 *  foil region is clipped to can be observed. */
function trackedCtx(tag: string, w: number, h: number) {
  let m: M = [1, 0, 0, 1, 0, 0]
  const stack: M[] = []
  const ctx: any = {
    _tag: tag,
    _fillStyles: [] as unknown[],
    _strokeStyles: [] as unknown[],
    _setTransforms: [] as number[][],
    canvas: { width: w, height: h },
    save: vi.fn(() => { stack.push([...m] as M) }),
    restore: vi.fn(() => { m = stack.pop() ?? m }),
    getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }),
    setTransform: vi.fn((a: any, b?: number, c?: number, d?: number, e?: number, f?: number) => {
      m = typeof a === 'object' ? [a.a, a.b, a.c, a.d, a.e, a.f] : [a, b!, c!, d!, e!, f!]
      ctx._setTransforms.push([...m])
    }),
    translate: vi.fn((x: number, y: number) => { m = mul(m, [1, 0, 0, 1, x, y]) }),
    scale: vi.fn((x: number, y: number) => { m = mul(m, [x, 0, 0, y, 0, 0]) }),
    rotate: vi.fn((r: number) => { m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]) }),
    transform: vi.fn((a: number, b: number, c: number, d: number, e: number, f: number) => { m = mul(m, [a, b, c, d, e, f]) }),
    drawImage: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(),
    beginPath: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), clip: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
    roundRect: vi.fn(), fill: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createPattern: vi.fn(() => ({})),
    getImageData: vi.fn((_x: number, _y: number, gw: number, gh: number) =>
      ({ data: new Uint8ClampedArray(gw * gh * 4), width: gw, height: gh })),
    putImageData: vi.fn(),
    measureText: vi.fn((t: string) => ({ width: 10 * (t?.length || 1), actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })),
    fillText: vi.fn(), strokeText: vi.fn(),
    globalCompositeOperation: 'source-over', globalAlpha: 1,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    imageSmoothingEnabled: true, lineWidth: 1, filter: 'none',
  }
  let fs: unknown = '#000', ss: unknown = '#000'
  Object.defineProperty(ctx, 'fillStyle', { get: () => fs, set: (v) => { fs = v; ctx._fillStyles.push(v) } })
  Object.defineProperty(ctx, 'strokeStyle', { get: () => ss, set: (v) => { ss = v; ctx._strokeStyles.push(v) } })
  return ctx
}

function mkCanvas() {
  const c: any = { _w: 0, _h: 0 }
  const ctx = trackedCtx('offscreen', 0, 0)
  Object.defineProperty(c, 'width', { get: () => c._w, set: (v) => { c._w = v; ctx.canvas.width = v } })
  Object.defineProperty(c, 'height', { get: () => c._h, set: (v) => { c._h = v; ctx.canvas.height = v } })
  ctx.canvas = { width: 0, height: 0 }
  c.getContext = () => ctx
  return c
}

beforeEach(() => {
  finish.ret = true
  vi.mocked(applyFinish).mockClear()
  vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'canvas' ? mkCanvas() : ({} as any)) })
  vi.stubGlobal('Path2D', class { constructor(public d?: string) {} })
})

const S = 400
const rect = (extra: Record<string, unknown>): LocalLayer => ({
  id: 'r1', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
  w: 0.1, h: 0.1, radius: 0, fill: '#ff0000', stroke: '', strokeWidth: 0, effects: [], ...extra,
} as any)
const text = (extra: Record<string, unknown>): LocalLayer => ({
  id: 't1', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
  text: 'Foil', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.05,
  color: '#222222', align: 'center', lineHeight: 1.1, boxH: 0, ...extra,
} as any)

function paint(layer: LocalLayer, light?: { x: number; y: number; height: number }) {
  const main = trackedCtx('main', S, S)
  const items: StackItem[] = [{ type: 'local', key: 'l:' + layer.id, layer }]
  paintLayerStack(main, S, S, items, [layer], undefined, undefined, undefined, undefined, undefined, undefined, undefined, false, light as any)
  return main
}
const calls = () => vi.mocked(applyFinish).mock.calls

describe('a foil region is lit over its layer\'s device box, in frame space', () => {
  it('runs the pass on a box around the layer, tells it where the box sits, and stamps it there', () => {
    const main = paint(rect({ fill: FOIL }))
    expect(calls()).toHaveLength(1)
    const [off, , , , , frame] = calls()[0]!
    const o = off as any
    // A 40 px square in the middle of a 400 px frame: the pass runs on its box, not the frame.
    expect(o.width).toBeLessThan(S / 2)
    expect(o.height).toBeLessThan(S / 2)
    expect(o.width).toBeGreaterThanOrEqual(40)
    expect(frame).toEqual({ x: expect.any(Number), y: expect.any(Number), frameW: S, frameH: S })
    const f = frame as { x: number; y: number }
    // The box contains the square (180..220 on both axes)…
    expect(f.x).toBeLessThanOrEqual(180)
    expect(f.x + o.width).toBeGreaterThanOrEqual(220)
    expect(f.y).toBeLessThanOrEqual(180)
    expect(f.y + o.height).toBeGreaterThanOrEqual(220)
    // …the region was drawn into it shifted by the box origin, and stamped back at that origin.
    const sctx = o.getContext()
    expect(sctx._setTransforms.some((t: number[]) => t[4] === 200 - f.x && t[5] === 200 - f.y)).toBe(true)
    expect(main.drawImage).toHaveBeenCalledWith(off, f.x, f.y)
  })

  it('a layer wholly off the canvas runs no pass', () => {
    paint(rect({ fill: FOIL, x: 3 }))
    expect(applyFinish).not.toHaveBeenCalled()
  })

  it('a layer covering the canvas passes the whole canvas and no frame (the old call exactly)', () => {
    paint(rect({ fill: FOIL, w: 2, h: 2 }))
    const [off, , , , , frame] = calls()[0]!
    expect((off as any).width).toBe(S)
    expect(frame).toBeUndefined()
  })

  it('the fallback floods only the box with the mid metal', () => {
    finish.ret = false
    paint(rect({ fill: FOIL }))
    const off = calls()[0]![0] as any
    expect(off.getContext().fillRect).toHaveBeenCalledWith(0, 0, off.width, off.height)
    expect(off.getContext()._fillStyles).toContain(METALS.gold[2])
  })
})

describe('foil outlines on text are lit', () => {
  it('fillText route: an on-edge foil outline runs the pass, stroking white; the glyphs stay solid', () => {
    const main = paint(text({ strokes: [{ id: 's1', paint: FOIL, width: 0.004, distance: 0, style: 'band' }] }))
    expect(calls()).toHaveLength(1)
    const sctx = (calls()[0]![0] as any).getContext()
    expect(sctx.strokeText).toHaveBeenCalled()
    expect(sctx._strokeStyles).toContain('#ffffff')
    // The frame's own pass fills the glyphs in their colour and strokes nothing flat.
    expect(main._fillStyles).toContain('#222222')
    expect(main._strokeStyles).not.toContain(METALS.gold[2])
    expect(main.strokeText).not.toHaveBeenCalled()
  })

  it('fillText route: a solid outline next to a foil one still strokes on the frame', () => {
    const main = paint(text({ strokes: [
      { id: 's1', paint: FOIL, width: 0.004, distance: 0, style: 'band' },
      { id: 's2', paint: '#00ff00', width: 0.002, distance: 0, style: 'band' },
    ] }))
    expect(calls()).toHaveLength(1)
    expect(main._strokeStyles).toContain('#00ff00')
    expect(main.strokeText).toHaveBeenCalled()
  })

  it('fillText route: a legacy foil strokeColor is lit too', () => {
    paint(text({ strokeColor: FOIL, strokeWidth: 0.004 }))
    expect(calls()).toHaveLength(1)
  })

  it('fillText route: foil colour AND foil outline run two passes', () => {
    const main = paint(text({ color: FOIL, strokes: [{ id: 's1', paint: FOIL, width: 0.004, distance: 0, style: 'band' }] }))
    expect(calls()).toHaveLength(2)
    expect(main._fillStyles).not.toContain(METALS.gold[2])
  })

  it('glyph-outline route: a foil outline strokes the glyph path white on the scratch', () => {
    const main = paint(text({ renderAsOutline: true, strokes: [{ id: 's1', paint: FOIL, width: 0.004, distance: 0, style: 'band' }] }))
    expect(calls()).toHaveLength(1)
    const sctx = (calls()[0]![0] as any).getContext()
    expect(sctx.stroke).toHaveBeenCalled()
    expect(sctx._strokeStyles).toContain('#ffffff')
    expect(main.stroke).not.toHaveBeenCalled()
    expect(main.fill).toHaveBeenCalled()   // the glyphs themselves, in their colour
  })

  it('a text layer without foil runs no pass (absent means unchanged)', () => {
    paint(text({ strokes: [{ id: 's1', paint: '#00ff00', width: 0.004, distance: 0, style: 'band' }] }))
    paint(text({ renderAsOutline: true, strokes: [{ id: 's1', paint: '#00ff00', width: 0.004, distance: 0, style: 'band' }] }))
    expect(applyFinish).not.toHaveBeenCalled()
  })
})

describe('foil outside paintLayerStack', () => {
  it('withFlatFoil draws the region in the mid metal and runs no pass (hit-testing)', () => {
    const ctx = trackedCtx('hit', S, S)
    withFlatFoil(() => drawLocalLayer(ctx, rect({ fill: FOIL }), S, S))
    expect(applyFinish).not.toHaveBeenCalled()
    expect(ctx._fillStyles).toContain(METALS.gold[2])
    // …and only while inside it.
    drawLocalLayer(trackedCtx('after', S, S), rect({ fill: FOIL }), S, S)
    expect(applyFinish).toHaveBeenCalledTimes(1)
  })

  it('withFrameLight lights a drawLocalLayer with the given light, then restores the previous one', () => {
    const lamp = { x: 0.9, y: 0.8, height: 0.3 }
    paint(rect({ fill: FOIL }), { x: 0.1, y: 0.1, height: 0.5 })
    withFrameLight(lamp, () => drawLocalLayer(trackedCtx('png', S, S), rect({ fill: FOIL }), S, S))
    drawLocalLayer(trackedCtx('later', S, S), rect({ fill: FOIL }), S, S)
    expect(calls()[1]![3]).toEqual(lamp)
    expect(calls()[2]![3]).toEqual({ x: 0.1, y: 0.1, height: 0.5 })
  })
})
