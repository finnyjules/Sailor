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
import { packLight, shadePixel } from '~/lib/frame/lighting/shade'
import type { LightLayer, FrameLighting } from '~/lib/frame/lighting/settings'
import type { Track } from '~/lib/motionx'

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

  it('a light hidden by its group does not light the Frame (the loop\'s own visibility)', () => {
    const lamp = { ...newLightLayer('lamp'), groupId: 'g' } as unknown as LocalLayer
    const ls = [rect('a'), lamp]
    paintLayerStack(stubCtx(), 20, 20, itemsOf(ls), ls, undefined, undefined, undefined, undefined, undefined, [{ id: 'g', hidden: true }] as any)
    expect(lightFrame).not.toHaveBeenCalled()
  })

  it('only the lights the loop reaches are passed, in stack order', () => {
    const a = newLightLayer('lamp') as unknown as LocalLayer
    const b = { ...newLightLayer('sun'), groupId: 'g' } as unknown as LocalLayer
    const c = newLightLayer('spot') as unknown as LocalLayer
    const ls = [a, b, c]
    paintLayerStack(stubCtx(), 20, 20, itemsOf(ls), ls, undefined, undefined, undefined, undefined, undefined, [{ id: 'g', hidden: true }] as any)
    expect((lightFrame.mock.calls[0]![4] as LocalLayer[]).map(l => l.id)).toEqual([a.id, c.id])
  })

  it('a layer whose content is still loading stamps with no signature (never cached stale)', () => {
    const img = { id: 'i', kind: 'image', filename: 'not-loaded.png', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1, castsShadow: true } as unknown as LocalLayer
    const ls = [img, newLightLayer('lamp') as unknown as LocalLayer]
    paintLayerStack(stubCtx(), 20, 20, itemsOf(ls), ls)
    const stamps = lightFrame.mock.calls[0]![3] as LightingStamp[]
    expect(stamps[0]!.layer?.id).toBe('i')
    expect(stamps[0]!.sig).toBeNull()
  })
})

describe('paintLayerStack lighting — light bands (stage 4)', () => {
  const band = (path: string, a: number, b: number): Track =>
    ({ path, type: 'number', keyframes: [{ t: 0, value: a, ease: 'linear' }, { t: 1, value: b, ease: 'linear' }] })
  // What the lighting pass is handed at `t`, shaded at one pixel by the TS mirror of its shader.
  function litAt(ls: LocalLayer[], tracks: Track[], t: number, x: number, y: number): number {
    lightFrame.mockClear()
    paintLayerStack(stubCtx(), 20, 20, itemsOf(ls), ls, undefined, t, { fps: 30, duration: 1, motionx: tracks },
      undefined, undefined, undefined, undefined, false, undefined, { darkness: 0.2, backgroundLit: true })
    expect(lightFrame).toHaveBeenCalledTimes(1)
    const [, , , , lights, lighting] = lightFrame.mock.calls[0]! as [unknown, number, number, unknown, LightLayer[], FrameLighting]
    return shadePixel([0.6, 0.6, 0.6], lights.map(l => packLight(l, 1)), [x, y, 0], lighting.darkness)[0]
  }

  it('a Darkness band 0→1 makes t=1 darker than t=0 far from the lamp', () => {
    const lamp = newLightLayer('lamp', { x: 0.05, y: 0.05 }) as unknown as LocalLayer
    const ls = [rect('a'), lamp]
    const tracks = [band('frame.darkness', 0, 1)]
    expect(litAt(ls, tracks, 1, 0.95, 0.95)).toBeLessThan(litAt(ls, tracks, 0, 0.95, 0.95))
  })

  it('a Brightness band brightens at the lamp', () => {
    const lamp = newLightLayer('lamp', { x: 0.5, y: 0.5 }) as unknown as LocalLayer
    const ls = [rect('a'), lamp]
    const tracks = [band(`layers.${lamp.id}.light.brightness`, 0.2, 3)]
    expect(litAt(ls, tracks, 1, 0.5, 0.5)).toBeGreaterThan(litAt(ls, tracks, 0, 0.5, 0.5))
  })

  it('no light band ⇒ the lighting record and lights reach the pass by identity', () => {
    const lamp = newLightLayer('lamp') as unknown as LocalLayer
    const ls = [rect('a'), lamp]
    const lighting = { darkness: 0.2, backgroundLit: true }
    paintLayerStack(stubCtx(), 20, 20, itemsOf(ls), ls, undefined, 0.5, { fps: 30, duration: 1, motionx: [band('layers.a.opacity', 0, 1)] },
      undefined, undefined, undefined, undefined, false, undefined, lighting)
    const [, , , , lights, got] = lightFrame.mock.calls[0]! as [unknown, number, number, unknown, LocalLayer[], FrameLighting]
    expect(got).toBe(lighting)
    expect(lights[0]).toBe(lamp)
  })
})
