/**
 * Frame light layers stage 3, Task 2: the painter lights Gold foil and Spot UV with the Frame's
 * light layers (finishLights.ts), once — a foil region is punched out of the lit map through its
 * stamp's `selfLit`, and a Spot UV layer stamps unlit. No light ⇒ the hidden light, as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const finish = vi.hoisted(() => ({ lit: true, seen: [] as unknown[] }))
vi.mock('~/lib/compositor/finishPass', async (importOriginal) => {
  const orig = await importOriginal<typeof import('~/lib/compositor/finishPass')>()
  return { ...orig, applyFinish: vi.fn(() => true) }
})
vi.mock('~/lib/compositor/finishLights', async (importOriginal) => {
  const orig = await importOriginal<typeof import('~/lib/compositor/finishLights')>()
  return { ...orig, applyFinishLit: vi.fn(() => finish.lit) }
})
// The lighting pass "available": what paintLayerStack hands it is what we check (no WebGL in node).
const lightFrame = vi.hoisted(() => vi.fn((..._a: unknown[]) => true))
vi.mock('~/lib/frame/lighting/lightingPass', async (importOriginal) => {
  const orig = await importOriginal<typeof import('~/lib/frame/lighting/lightingPass')>()
  return { ...orig, lightingAvailable: () => true, lightFrame: (...a: unknown[]) => lightFrame(...a) }
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
  paintLayerStack, withFlatFoil, currentFinishLights, type StackItem, type LocalLayer,
} from '~/composables/useCompositorLayers'
import { applyFinish } from '~/lib/compositor/finishPass'
import {
  applyFinishLit, __resetSelfLitPool, enterFinishScope, leaveFinishScope, lightFinishes, armSelfLit, recordSelfLit, takeSelfLit,
} from '~/lib/compositor/finishLights'
import { newLightLayer, DEFAULT_LIGHTING } from '~/lib/frame/lighting/settings'
import type { LightingStamp } from '~/lib/frame/lighting/maps'

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
  // Every ink-laying call, with the composite op it ran under: what a recorder ends up holding.
  ctx._ops = [] as string[]
  for (const name of ['drawImage', 'fill', 'stroke', 'fillText', 'strokeText', 'fillRect']) {
    const f = ctx[name]
    ctx[name] = vi.fn((...a: unknown[]) => { ctx._ops.push(`${ctx.globalCompositeOperation}:${name}`); return f(...a) })
  }
  Object.defineProperty(c, 'width', { get: () => c._w, set: (v) => { c._w = v; ctx.canvas.width = v } })
  Object.defineProperty(c, 'height', { get: () => c._h, set: (v) => { c._h = v; ctx.canvas.height = v } })
  ctx.canvas = { width: 0, height: 0 }
  c.getContext = () => ctx
  return c
}


beforeEach(() => {
  __resetSelfLitPool()   // pooled recorders keep their ink log across paints: each test starts fresh
  finish.lit = true
  finish.seen = []
  vi.mocked(applyFinish).mockClear()
  vi.mocked(applyFinishLit).mockClear()
  vi.mocked(applyFinishLit).mockImplementation(() => { finish.seen.push(currentFinishLights()); return finish.lit })
  lightFrame.mockClear()
  vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'canvas' ? mkCanvas() : ({} as any)) })
  vi.stubGlobal('Path2D', class { constructor(public d?: string) {} })
})

const S = 400
const rect = (id: string, extra: Record<string, unknown> = {}): LocalLayer => ({
  id, kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
  w: 0.1, h: 0.1, radius: 0, fill: '#ff0000', stroke: '', strokeWidth: 0, effects: [], ...extra,
} as any)
const text = (extra: Record<string, unknown>): LocalLayer => ({
  id: 't1', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
  text: 'Foil', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.05,
  color: '#222222', align: 'center', lineHeight: 1.1, boxH: 0, ...extra,
} as any)
const lamp = () => newLightLayer('lamp') as unknown as LocalLayer
const SPOT_UV = { type: 'spot_uv', visible: true, gloss: 0.75, raised: 0.5, varnishOnly: false }

function paint(layers: LocalLayer[], lighting?: { darkness: number; backgroundLit: boolean }) {
  const main = trackedCtx('main', S, S)
  const items: StackItem[] = layers.map(l => ({ type: 'local', key: 'l:' + l.id, layer: l }))
  paintLayerStack(main, S, S, items, layers, undefined, undefined, undefined, undefined, undefined, undefined, undefined, false, undefined, lighting)
  return main
}
const stampsOf = () => (lightFrame.mock.calls[0]?.[3] ?? []) as LightingStamp[]

describe('foil and Spot UV are lit by the Frame\'s light layers', () => {
  it('a light and a foil fill: applyFinishLit runs with the visible lights and the lighting record; applyFinish does not', () => {
    const l = lamp()
    const lighting = { darkness: 0.7, backgroundLit: false }
    paint([rect('r', { fill: FOIL }), l], lighting)
    expect(applyFinishLit).toHaveBeenCalledTimes(1)
    const [, kind, dials, lights, got, , frame] = vi.mocked(applyFinishLit).mock.calls[0]!
    expect(kind).toBe('gold_foil')
    expect(dials).toEqual({ metal: 'gold', brushed: 0.3, pressed: 0.6, grain: 0.7 })
    expect((lights as LocalLayer[]).map(x => x.id)).toEqual([l.id])
    expect(got).toEqual(lighting)
    expect(frame).toEqual({ x: expect.any(Number), y: expect.any(Number), frameW: S, frameH: S })
    expect(applyFinish).not.toHaveBeenCalled()
  })

  it('no light: applyFinish (the hidden light) runs and applyFinishLit never does', () => {
    paint([rect('r', { fill: FOIL })], DEFAULT_LIGHTING)
    expect(applyFinish).toHaveBeenCalledTimes(1)
    expect(applyFinishLit).not.toHaveBeenCalled()
  })

  it('a hidden light lights nothing: the hidden light again', () => {
    paint([rect('r', { fill: FOIL }), { ...lamp(), visible: false } as LocalLayer])
    expect(applyFinishLit).not.toHaveBeenCalled()
    expect(applyFinish).toHaveBeenCalledTimes(1)
  })

  it('applyFinishLit cannot run ⇒ falls back to applyFinish with the same region', () => {
    finish.lit = false
    paint([rect('r', { fill: FOIL }), lamp()])
    expect(applyFinishLit).toHaveBeenCalledTimes(1)
    expect(applyFinish).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyFinish).mock.calls[0]![5]).toEqual(vi.mocked(applyFinishLit).mock.calls[0]![6])
  })

  it('the finish reads the lights from the layers the painter was handed (where the light is now)', () => {
    const l = lamp()
    const ls = [rect('r', { fill: FOIL }), l]
    const items: StackItem[] = ls.map(x => ({ type: 'local', key: 'l:' + x.id, layer: x }))
    // The items carry the light where it was; the layer list (which the painter folds, then
    // reads the lights from) has it moved: the finish sees the moved one, not the item's.
    const moved = { ...l, x: 0.9 } as LocalLayer
    paintLayerStack(trackedCtx('main', S, S), S, S, items, [ls[0]!, moved])
    expect((vi.mocked(applyFinishLit).mock.calls[0]![3] as LocalLayer[])[0]!.x).toBe(0.9)
  })

  it('Spot UV in a lit Frame: applyFinishLit(spot_uv), and the layer stamps unlit', () => {
    paint([rect('r', { effects: [SPOT_UV] }), rect('p'), lamp()])
    const kinds = vi.mocked(applyFinishLit).mock.calls.map(c => c[1])
    expect(kinds).toEqual(['spot_uv'])
    expect(applyFinish).not.toHaveBeenCalled()
    const st = stampsOf()
    expect(st.find(s => s.layer?.id === 'r')!.layer!.lit).toBe(false)
    expect(st.find(s => s.layer?.id === 'p')!.layer!.lit).toBeUndefined()
  })

  it('a hidden Spot UV effect does not make its layer unlit', () => {
    paint([rect('r', { effects: [{ ...SPOT_UV, visible: false }] }), lamp()])
    expect(stampsOf().find(s => s.layer?.id === 'r')!.layer!.lit).toBeUndefined()
  })
})

describe('a foil region is lit once: punched out of the lit map', () => {
  it('a text with a plain fill and a foil outline stamps its recorded foil as selfLit; a plain layer does not', () => {
    paint([text({ strokes: [{ id: 's1', paint: FOIL, width: 0.004, distance: 0, style: 'band' }] }), rect('p'), lamp()])
    const st = stampsOf()
    const t = st.find(s => s.layer?.id === 't1')!
    const p = st.find(s => s.layer?.id === 'p')!
    expect(t.selfLit).toBeTypeOf('function')
    expect(t.sig).toContain('|sl')
    expect(p.selfLit ?? null).toBeNull()
    expect(p.sig).not.toContain('|sl')
    // The recorder is device-sized and holds the region at its device box.
    const lit = vi.mocked(applyFinishLit).mock.calls[0]!
    const scratch = lit[0] as any
    const frame = lit[6] as { x: number; y: number }
    const target = trackedCtx('map', 10, 10)
    t.selfLit!(target)
    const [rec, sx, sy, sw, sh, dx, dy, dw, dh] = target.drawImage.mock.calls[0]!
    expect([rec.width, rec.height]).toEqual([S, S])
    expect([sx, sy, sw, sh, dx, dy, dw, dh]).toEqual([0, 0, S, S, 0, 0, S, S])
    expect(rec.getContext().drawImage).toHaveBeenCalledWith(scratch, frame.x, frame.y)
  })

  it('the recorder is made only for a foil layer in a lit Frame: one canvas, lazily', () => {
    const made = vi.fn()
    vi.stubGlobal('document', { createElement: (tag: string) => { made(tag); return tag === 'canvas' ? mkCanvas() : ({} as any) } })
    const count = (ls: LocalLayer[]) => { made.mockClear(); paint(ls); return made.mock.calls.length }
    __resetSelfLitPool()
    count([rect('r', { fill: FOIL })])   // warm the shared foil scratch
    expect(count([rect('r', { fill: FOIL }), lamp()]) - count([rect('r', { fill: FOIL })])).toBe(1)
    expect(count([rect('p'), lamp()]) - count([rect('p')])).toBe(0)
  })
})

describe('the recorder canvases are pooled (final review I-2)', () => {
  it('two consecutive lit paints of a foil Frame reuse the recorder: the second makes no canvas the unlit paint does not', () => {
    const made = vi.fn()
    vi.stubGlobal('document', { createElement: (tag: string) => { made(tag); return tag === 'canvas' ? mkCanvas() : ({} as any) } })
    const count = (ls: LocalLayer[]) => { made.mockClear(); paint(ls); return made.mock.calls.filter(c => c[0] === 'canvas').length }
    const recorderOf = () => {
      const t = stampsOf().find(x => x.layer?.id === 'r')!
      const target = trackedCtx('map', 10, 10)
      t.selfLit!(target)
      return target.drawImage.mock.calls[0]![0]
    }
    __resetSelfLitPool()
    const unlit = count([rect('r', { fill: FOIL })])
    lightFrame.mockClear()
    expect(count([rect('r', { fill: FOIL }), lamp()])).toBe(unlit + 1)
    const first = recorderOf()
    lightFrame.mockClear()
    expect(count([rect('r', { fill: FOIL }), lamp()])).toBe(unlit)
    const second = recorderOf()
    expect(second).toBe(first)
    // Reused clear: the second paint's ops start with a clearRect, then the one region.
    const ops = (second as any).getContext()._ops as string[]
    expect(ops.at(-1)).toBe('source-over:drawImage')
    expect((second as any).getContext().clearRect).toHaveBeenCalled()
  })

  it('two foil layers in one paint take two canvases; a nested paint never takes one the enclosing paint holds', () => {
    __resetSelfLitPool()
    const main = trackedCtx('main', S, S)
    const src = mkCanvas()
    const outer = enterFinishScope()
    try {
      lightFinishes([lamp()], undefined, DEFAULT_LIGHTING, main, S, S, null)
      armSelfLit(true); recordSelfLit(src, 0, 0, S, S)
      const a = takeSelfLit()
      armSelfLit(true); recordSelfLit(src, 0, 0, S, S)
      const b = takeSelfLit()
      expect(a).toBeTruthy(); expect(b).toBeTruthy(); expect(b).not.toBe(a)
      const inner = enterFinishScope()
      let c: unknown
      try {
        lightFinishes([lamp()], undefined, DEFAULT_LIGHTING, main, S, S, null)
        armSelfLit(true); recordSelfLit(src, 0, 0, S, S)
        c = takeSelfLit()
      } finally { leaveFinishScope(inner) }
      expect(c).toBeTruthy(); expect(c).not.toBe(a); expect(c).not.toBe(b)
      // Back in the enclosing paint, its next layer takes the slot the nested paint used.
      armSelfLit(true); recordSelfLit(src, 0, 0, S, S)
      expect(takeSelfLit()).toBe(c)
    } finally { leaveFinishScope(outer) }
  })
})

describe('a varnish-only Spot UV coat is lit once without an unlit hole (final review I-1)', () => {
  it('stamps lit, and its coat (the effect\'s output) is recorded as selfLit at its device position', () => {
    paint([rect('r', { effects: [{ ...SPOT_UV, varnishOnly: true }] }), rect('p'), lamp()])
    expect(vi.mocked(applyFinishLit).mock.calls.map(c => c[1])).toEqual(['spot_uv'])
    const st = stampsOf()
    const r = st.find(s => s.layer?.id === 'r')!
    expect(r.layer!.lit).toBeUndefined()   // the picture under the coat is lit by the pass
    expect(r.selfLit).toBeTypeOf('function')
    expect(r.sig).toContain('|sl')
    const off = vi.mocked(applyFinishLit).mock.calls[0]![0] as any
    const target = trackedCtx('map', 10, 10)
    r.selfLit!(target)
    const rec = target.drawImage.mock.calls[0]![0] as any
    expect([rec.width, rec.height]).toEqual([S, S])
    expect(rec.getContext().drawImage).toHaveBeenCalledWith(off, 0, 0)
    expect(st.find(s => s.layer?.id === 'p')!.selfLit ?? null).toBeNull()
  })

  it('a non-varnish Spot UV still stamps wholly unlit and records nothing', () => {
    paint([rect('r', { effects: [SPOT_UV] }), lamp()])
    const r = stampsOf().find(s => s.layer?.id === 'r')!
    expect(r.layer!.lit).toBe(false)
    expect(r.selfLit ?? null).toBeNull()
  })

  it('the coat cannot run lit ⇒ the hidden light, and nothing recorded', () => {
    finish.lit = false
    paint([rect('r', { effects: [{ ...SPOT_UV, varnishOnly: true }] }), lamp()])
    expect(applyFinish).toHaveBeenCalledTimes(1)
    expect(stampsOf().find(s => s.layer?.id === 'r')!.selfLit ?? null).toBeNull()
  })
})

describe('_finishLights is scoped to paintLayerStack', () => {
  it('set while a lit Frame paints, null after it returns (so a later withFlatFoil hit-test sees null)', () => {
    const l = lamp()
    paint([rect('r', { fill: FOIL }), l])
    expect((finish.seen[0] as { lights: LocalLayer[] }).lights.map(x => x.id)).toEqual([l.id])
    expect(currentFinishLights()).toBeNull()
    expect(withFlatFoil(() => currentFinishLights())).toBeNull()
  })

  it('a throw mid-paint still clears it', () => {
    vi.mocked(applyFinishLit).mockImplementation(() => { throw new Error('boom') })
    expect(() => paint([rect('r', { fill: FOIL }), lamp()])).toThrow('boom')
    expect(currentFinishLights()).toBeNull()
  })
})

/** The self-lit recorder a layer's stamp draws, and the ink calls it received, in order. */
function recorderOps(layerId: string): string[] {
  const t = stampsOf().find(x => x.layer?.id === layerId)!
  expect(t.selfLit).toBeTypeOf('function')
  const target = trackedCtx('map', 10, 10)
  t.selfLit!(target)
  const rec = target.drawImage.mock.calls[0]![0] as any
  return rec.getContext()._ops as string[]
}
const PLAIN = (extra: Record<string, unknown> = {}) => ({ id: 'p1', paint: '#000000', width: 0.01, distance: 0, style: 'band', ...extra })
const FOIL_STROKE = { id: 'f1', paint: FOIL, width: 0.004, distance: 0, style: 'band' }

describe('the recorder holds the foil still SEEN at the end of the layer (review fix round 1)', () => {
  it('a plain stroke over a foil fill is erased from the recorder: the stroke reads lit, the fill stays unlit', () => {
    paint([rect('r', { fill: FOIL, strokes: [PLAIN()] }), lamp()])
    const ops = recorderOps('r')
    // The foil fill lands first (lit by its own shader ⇒ punched), then the stroke erases it.
    expect(ops[0]).toBe('source-over:drawImage')
    expect(ops.slice(1).length).toBeGreaterThan(0)
    expect(ops.slice(1).every(o => o.startsWith('destination-out:'))).toBe(true)
    expect(ops.filter(o => o === 'source-over:drawImage')).toHaveLength(1)   // the fill is still recorded
  })

  it('outline route: a plain glyph over a foil outline is erased (the letter reads lit), the outline stays', () => {
    paint([text({ renderAsOutline: true, color: '#222222', strokes: [FOIL_STROKE] }), lamp()])
    const ops = recorderOps('t1')
    expect(ops).toEqual(['source-over:drawImage', 'destination-out:fill'])
  })

  it('fillText route: the plain glyphs drawn after the foil outline are erased from it', () => {
    paint([text({ color: '#222222', strokes: [FOIL_STROKE] }), lamp()])
    const ops = recorderOps('t1')
    expect(ops[0]).toBe('source-over:drawImage')
    expect(ops.slice(1)).toContain('destination-out:fillText')
    expect(ops.slice(1).every(o => o.startsWith('destination-out:'))).toBe(true)
  })

  it('a plain outline UNDER a foil glyph colour erases nothing: the whole foil glyph stays unlit', () => {
    paint([text({ renderAsOutline: true, color: FOIL, strokes: [PLAIN({ width: 0.004 })] }), lamp()])
    expect(recorderOps('t1')).toEqual(['source-over:drawImage'])
  })

})
