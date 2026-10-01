import { describe, it, expect, vi, beforeEach } from 'vitest'

// Light layers stage 2: what paintLayerStack does with a Relight photo. No WebGL in node — the
// Frame pass and Relight's per-photo pass are stand-ins; what the painter hands them is checked.
const lightFrame = vi.fn((..._a: unknown[]) => true)
vi.mock('~/lib/frame/lighting/lightingPass', () => ({
  lightingAvailable: () => true,
  lightFrame: (...a: unknown[]) => lightFrame(...a),
}))
const fakeCanvas = (w: number, h: number, tag: string) => ({ width: w, height: h, tag, getContext: () => null })
const originalLight = vi.fn((_c: unknown, keep: number, w: number, h: number) => (keep < 0.999 ? fakeCanvas(w, h, 'original') : null))
const facingTile = vi.fn((..._a: unknown[]) => fakeCanvas(_a[3] as number, _a[4] as number, 'tile'))
vi.mock('~/lib/relight/relightPass', () => ({
  relightAvailable: () => true,
  relightOriginalLight: (...a: unknown[]) => originalLight(...(a as [unknown, number, number, number])),
  relightFacingTile: (...a: unknown[]) => facingTile(...a),
  originalLightActive: (k: number) => k < 0.999,
}))
const FIELD = { kind: 'float', width: 2, height: 2, data: new Float32Array(4) }
vi.mock('~/lib/compositor/depthRegistry', async (orig) => ({
  ...(await orig<typeof import('~/lib/compositor/depthRegistry')>()),
  depthImageFor: () => ({ complete: true, naturalWidth: 2, naturalHeight: 2 }),
  requestDepth: () => {},
}))
vi.mock('~/lib/relight/depthField', async (orig) => ({
  ...(await orig<typeof import('~/lib/relight/depthField')>()),
  relightDepthFieldFor: () => FIELD,
}))

import { paintLayerStack, __setImageForTest, type LocalLayer, type StackItem } from '~/composables/useCompositorLayers'
import { newLightLayer } from '~/lib/frame/lighting/settings'
import type { LightingStamp } from '~/lib/frame/lighting/maps'
import { defaultRelightSettings } from '~/lib/relight/settings'

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

const BITMAP = { complete: true, naturalWidth: 40, naturalHeight: 40, width: 40, height: 40, tag: 'bitmap' }

beforeEach(() => {
  lightFrame.mockClear(); originalLight.mockClear(); facingTile.mockClear()
  vi.stubGlobal('document', {
    createElement: () => { const c: any = { width: 0, height: 0 }; c.getContext = () => { const x = stubCtx(); x.canvas = c; return x }; return c },
  })
})

let seq = 0
/** A Relight photo, its own file each time (so the per-photo cache never crosses tests). */
function photo(fx: Record<string, unknown> = {}, patch: Record<string, unknown> = {}): LocalLayer {
  const filename = `puppy-${++seq}.png`
  __setImageForTest(filename, BITMAP as never)
  return {
    id: `p${seq}`, kind: 'image', filename, x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1,
    effects: [{ id: `fx${seq}`, type: 'relight', visible: true, ...defaultRelightSettings(), ...fx }],
    ...patch,
  } as unknown as LocalLayer
}
const rect = (id: string, patch: Record<string, unknown> = {}): LocalLayer => ({
  id, kind: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1, fill: '#ff0000', ...patch,
} as unknown as LocalLayer)
const itemsOf = (ls: LocalLayer[]): StackItem[] => ls.map(l => ({ type: 'local' as const, key: `l:${l.id}`, layer: l }))
const paint = (ls: LocalLayer[], lighting?: unknown) =>
  paintLayerStack(stubCtx(), 20, 20, itemsOf(ls), ls, undefined, undefined, undefined, undefined, undefined, undefined, undefined, false, undefined, lighting as never)

describe('a Relight photo with no light layer and no legacy lights', () => {
  it('draws plain + Original light: no Frame pass, no facing tile', () => {
    paint([photo({ keep: 0.3 })])
    expect(lightFrame).not.toHaveBeenCalled()
    expect(facingTile).not.toHaveBeenCalled()
    expect(originalLight).toHaveBeenCalledTimes(1)
    expect(originalLight.mock.calls[0]![1]).toBe(0.3)
  })

  it('Original light 1 keeps the photo as it is', () => {
    paint([photo({ keep: 1 })])
    expect(originalLight.mock.results.every(r => r.value === null)).toBe(true)
    expect(facingTile).not.toHaveBeenCalled()
  })

  it('a hidden Relight effect does nothing', () => {
    paint([photo({ visible: false })])
    expect(originalLight).not.toHaveBeenCalled()
  })
})

describe('legacy lights light it through the virtual conversion', () => {
  it('an old Frame (Relight with its own lights, no light layer) is lit by the converted lamps', () => {
    const p = photo({ lights: [{ id: 'k', x: 0.2, y: 0.3, height: 0.4, color: '#ffcf94', brightness: 2, reach: 1, on: true }] })
    const r = rect('r')
    paint([r, p])
    expect(lightFrame).toHaveBeenCalledTimes(1)
    const [, , , stamps, lights, lighting] = lightFrame.mock.calls[0]! as [unknown, number, number, LightingStamp[], LocalLayer[], { darkness: number }]
    expect(lights.map(l => l.id)).toEqual([`ll-rl-${p.id}-k`])
    expect(lighting.darkness).toBe(0.45)
    // The layout looks as before: the rect is not lit (and casts nothing); the photo is.
    const rs = stamps.find(s => s.layer?.id === 'r')!
    expect(rs.layer!.lit).toBe(false)
    expect(stamps.find(s => s.layer?.id === p.id)!.facing).toBeTruthy()
  })

  it('never persisted: the layers handed in are untouched', () => {
    const p = photo({ lights: [{ id: 'k', x: 0.2, y: 0.3, height: 0.4, color: '#ffcf94', brightness: 2, reach: 1, on: true }] })
    const ls = [rect('r'), p]
    const json = JSON.stringify(ls)
    paint(ls)
    expect(JSON.stringify(ls)).toBe(json)
  })

  it('an existing light layer wins: no conversion', () => {
    const p = photo({ lights: [{ id: 'k', x: 0.2, y: 0.3, height: 0.4, color: '#ffcf94', brightness: 2, reach: 1, on: true }] })
    const lamp = newLightLayer('lamp') as unknown as LocalLayer
    paint([p, lamp])
    expect((lightFrame.mock.calls[0]![4] as LocalLayer[]).map(l => l.id)).toEqual([lamp.id])
  })
})

describe('with a Frame light', () => {
  it('the photo stamps its facing tile, made at its rotation, with the Shine dial', () => {
    const p = photo({ shine: 0.4 }, { rotation: 30 })
    const lamp = newLightLayer('lamp') as unknown as LocalLayer
    paint([p, lamp])
    expect(facingTile).toHaveBeenCalledTimes(1)
    const args = facingTile.mock.calls[0]!
    expect(args[1]).toBe(FIELD)                    // the photo's depth field
    expect(args[7]).toBe(30)                       // rotation
    const st = (lightFrame.mock.calls[0]![3] as LightingStamp[]).find(s => s.layer?.id === p.id)!
    expect(st.facing!.shine).toBe(0.4)
    expect(st.sig).toMatch(/\|f.+\|0\.4$/)
  })

  it('the facing stamp draws the tile where the photo\'s pixels go, never the photo itself', () => {
    const p = photo()
    paint([p, newLightLayer('lamp') as unknown as LocalLayer])
    const st = (lightFrame.mock.calls[0]![3] as LightingStamp[]).find(s => s.layer?.id === p.id)!
    const target = stubCtx()
    st.facing!.draw(target)
    const drawn = (target.drawImage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn).not.toContain(BITMAP)
    // The silhouette draw still draws the photo.
    const sil = stubCtx()
    st.draw(sil)
    expect((sil.drawImage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])).toContain(BITMAP)
  })

  it('a second paint with nothing changed runs neither pass again and keeps the signature', () => {
    const p = photo()
    const lamp = newLightLayer('lamp') as unknown as LocalLayer
    paint([p, lamp])
    const sig1 = (lightFrame.mock.calls[0]![3] as LightingStamp[]).find(s => s.layer?.id === p.id)!.sig
    paint([p, { ...lamp, x: 0.9 } as LocalLayer])   // only the light moved
    expect(facingTile).toHaveBeenCalledTimes(1)
    expect(originalLight).toHaveBeenCalledTimes(1)
    expect((lightFrame.mock.calls[1]![3] as LightingStamp[]).find(s => s.layer?.id === p.id)!.sig).toBe(sig1)
  })

  it('a Frame with lights but no Relight photo stamps no facing (stage 1 exactly)', () => {
    paint([rect('a'), rect('b', { lit: false }), newLightLayer('lamp') as unknown as LocalLayer])
    const stamps = lightFrame.mock.calls[0]![3] as LightingStamp[]
    expect(stamps.every(s => !s.facing)).toBe(true)
    expect(facingTile).not.toHaveBeenCalled()
  })
})

describe('the per-photo cache', () => {
  it('moving the photo runs neither pass again', () => {
    const p = photo()
    const lamp = newLightLayer('lamp') as unknown as LocalLayer
    paint([p, lamp])
    paint([{ ...p, x: 0.3, y: 0.6 } as LocalLayer, lamp])
    expect(facingTile).toHaveBeenCalledTimes(1)
    expect(originalLight).toHaveBeenCalledTimes(1)
  })
  it('a dial change runs them again', () => {
    const p = photo()
    const lamp = newLightLayer('lamp') as unknown as LocalLayer
    paint([p, lamp])
    const fx = (p as unknown as { effects: Record<string, unknown>[] }).effects[0]!
    paint([{ ...p, effects: [{ ...fx, depth: 9 }] } as unknown as LocalLayer, lamp])
    expect(facingTile).toHaveBeenCalledTimes(2)
  })
})
