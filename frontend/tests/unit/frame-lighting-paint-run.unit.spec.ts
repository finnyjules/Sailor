import { describe, it, expect, vi, beforeEach } from 'vitest'

// The pass "available": what paintLayerStack hands it is what we check (no WebGL in node).
const lightFrame = vi.fn((..._a: unknown[]) => true)
vi.mock('~/lib/frame/lighting/lightingPass', () => ({
  lightingAvailable: () => true,
  lightFrame: (...a: unknown[]) => lightFrame(...a),
}))

import { paintLayerStack, type LocalLayer, type StackItem } from '~/composables/useCompositorLayers'
import { newLightLayer, DEFAULT_LIGHTING } from '~/lib/frame/lighting/settings'
import type { LightingStamp } from '~/lib/frame/lighting/maps'

function stubCtx() {
  const ctx: any = new Proxy({
    canvas: { width: 20, height: 20 },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
    measureText: () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    globalCompositeOperation: 'source-over', globalAlpha: 1, filter: 'none',
  } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : (typeof k === 'string' ? (t[k] = vi.fn()) : undefined)),
  })
  return ctx
}

beforeEach(() => {
  lightFrame.mockClear()
  vi.stubGlobal('document', {
    createElement: () => { const c: any = { width: 0, height: 0 }; c.getContext = () => { const x = stubCtx(); x.canvas = c; return x }; return c },
  })
})

const rect = (id: string, patch: Record<string, unknown> = {}): LocalLayer => ({
  id, kind: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1, fill: '#ff0000', ...patch,
} as unknown as LocalLayer)
const itemsOf = (ls: LocalLayer[]): StackItem[] => ls.map(l => ({ type: 'local' as const, key: `l:${l.id}`, layer: l }))

describe('paintLayerStack lighting — with the pass available', () => {
  it('no light layer ⇒ the pass is never called', () => {
    const ls = [rect('a')]
    paintLayerStack(stubCtx(), 20, 20, itemsOf(ls), ls)
    expect(lightFrame).not.toHaveBeenCalled()
  })

  it('a light ⇒ one pass after the loop, with a stamp per drawn layer (not the light, not hidden ones)', () => {
    const lamp = newLightLayer('lamp') as unknown as LocalLayer
    const ls = [rect('a'), rect('h', { visible: false }), lamp, rect('b', { lit: false })]
    const lighting = { darkness: 0.7, backgroundLit: false }
    paintLayerStack(stubCtx(), 20, 20, itemsOf(ls), ls, undefined, undefined, undefined, undefined, undefined, undefined, undefined, false, undefined, lighting)
    expect(lightFrame).toHaveBeenCalledTimes(1)
    const [, W, H, stamps, lights, got] = lightFrame.mock.calls[0]! as [unknown, number, number, LightingStamp[], LocalLayer[], unknown]
    expect([W, H]).toEqual([20, 20])
    expect(stamps.map(s => s.layer?.id)).toEqual(['a', 'b'])
    expect(stamps.every(s => typeof s.sig === 'string')).toBe(true)
    expect(lights.map(l => l.id)).toEqual([lamp.id])
    expect(got).toEqual(lighting)
  })

  it('absent lighting record ⇒ the defaults', () => {
    const ls = [newLightLayer('sun') as unknown as LocalLayer]
    paintLayerStack(stubCtx(), 20, 20, itemsOf(ls), ls)
    expect(lightFrame.mock.calls[0]![5]).toEqual(DEFAULT_LIGHTING)
  })

  it('a hidden light does not light the Frame', () => {
    const ls = [rect('a'), { ...newLightLayer('lamp'), visible: false } as unknown as LocalLayer]
    paintLayerStack(stubCtx(), 20, 20, itemsOf(ls), ls)
    expect(lightFrame).not.toHaveBeenCalled()
  })

  it('the stamp signature does not change when only a light moves', () => {
    const a = rect('a')
    const lamp = newLightLayer('lamp') as unknown as LocalLayer
    const run = (l: LocalLayer) => {
      lightFrame.mockClear()
      const ls = [a, l]
      paintLayerStack(stubCtx(), 20, 20, itemsOf(ls), ls)
      return (lightFrame.mock.calls[0]![3] as LightingStamp[]).map(s => s.sig)
    }
    expect(run({ ...lamp, x: 0.9 } as LocalLayer)).toEqual(run(lamp))
  })

  it('a wired item stamps with no signature (its draw closure is new every paint)', () => {
    const lamp = newLightLayer('lamp') as unknown as LocalLayer
    const items: StackItem[] = [{ type: 'wired', key: 'w:0', draw: vi.fn() }, ...itemsOf([lamp])]
    paintLayerStack(stubCtx(), 20, 20, items, [lamp])
    const stamps = lightFrame.mock.calls[0]![3] as LightingStamp[]
    expect(stamps).toHaveLength(1)
    expect(stamps[0]!.layer).toBeNull()
    expect(stamps[0]!.sig).toBeNull()
  })
})
