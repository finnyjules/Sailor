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
  releaseRelight: () => {},
}))
const FIELD = { kind: 'float', width: 2, height: 2, data: new Float32Array(4) }
// What the depth-field and surfaces registries hand back; a test can make them "arrive".
const reg: { field: unknown; surfaces: unknown } = { field: FIELD, surfaces: null }
vi.mock('~/lib/compositor/surfacesRegistry', async (orig) => ({
  ...(await orig<typeof import('~/lib/compositor/surfacesRegistry')>()),
  surfacesImageFor: () => reg.surfaces,
}))
vi.mock('~/lib/compositor/depthRegistry', async (orig) => ({
  ...(await orig<typeof import('~/lib/compositor/depthRegistry')>()),
  depthImageFor: () => ({ complete: true, naturalWidth: 2, naturalHeight: 2 }),
  requestDepth: () => {},
}))
vi.mock('~/lib/relight/depthField', async (orig) => ({
  ...(await orig<typeof import('~/lib/relight/depthField')>()),
  relightDepthFieldFor: () => reg.field,
}))

import { paintLayerStack, __setImageForTest, __relightPhotoCacheForTest, setRelightBypass, type LocalLayer, type StackItem } from '~/composables/useCompositorLayers'
import { newLightLayer } from '~/lib/frame/lighting/settings'
import { releaseLightingMaps, type LightingStamp } from '~/lib/frame/lighting/maps'
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

/** Every canvas the painter made this test, with the one 2D context it handed out. */
let made: { c: any; x: any }[] = []
beforeEach(() => {
  lightFrame.mockClear(); originalLight.mockClear(); facingTile.mockClear()
  reg.field = FIELD; reg.surfaces = null
  made = []
  vi.stubGlobal('document', {
    createElement: () => {
      const c: any = { width: 0, height: 0 }
      let x: any = null
      c.getContext = () => (x ??= Object.assign(stubCtx(), { canvas: c }))
      made.push({ c, get x() { return x } } as never)
      return c
    },
  })
})
/** The painter's own copy of the tile the facing pass returned (copyCanvas draws it in). */
const tileCopy = () => made.find(m => m.x?.drawImage?.mock?.calls.some((a: unknown[]) => (a[0] as { tag?: string })?.tag === 'tile'))?.c

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
const paint = (ls: LocalLayer[], lighting?: unknown, ctx = stubCtx()) =>
  paintLayerStack(ctx, 20, 20, itemsOf(ls), ls, undefined, undefined, undefined, undefined, undefined, undefined, undefined, false, undefined, lighting as never)

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
    const [, , , stamps, lights, lighting] = lightFrame.mock.calls[0]! as [unknown, number, number, LightingStamp[], LocalLayer[], { darkness: number; backgroundLit: boolean }]
    expect(lights.map(l => l.id)).toEqual([`ll-rl-${p.id}-k`])
    expect(lighting).toEqual({ darkness: 0.45, backgroundLit: false })
    // The layout looks as before: the rect is not lit (and casts nothing); the photo is.
    const rs = stamps.find(s => s.layer?.id === 'r')!
    expect(rs.layer!.lit).toBe(false)
    expect(stamps.find(s => s.layer?.id === p.id)!.facing).toBeTruthy()
  })

  it('the defaults handed in (no stored record, as painters read it) still give the conversion\'s unlit background; a real record wins', () => {
    const p = photo({ lights: [{ id: 'k', x: 0.2, y: 0.3, height: 0.4, color: '#ffcf94', brightness: 2, reach: 1, on: true }] })
    paint([rect('r'), p], { darkness: 0.45, backgroundLit: true })
    expect(lightFrame.mock.calls[0]![5]).toEqual({ darkness: 0.45, backgroundLit: false })
    lightFrame.mockClear()
    paint([rect('r'), p], { darkness: 0.7, backgroundLit: true })
    expect(lightFrame.mock.calls[0]![5]).toEqual({ darkness: 0.7, backgroundLit: true })
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

describe('Compare (the Relight bypass hold)', () => {
  it('shows the original photo: no Relight passes, and it stamps unlit — only while held', () => {
    const p = photo({ keep: 0.3 })
    const lamp = newLightLayer('lamp') as unknown as LocalLayer
    setRelightBypass(p.id)
    try { paint([p, lamp]) } finally { setRelightBypass(null) }
    expect(originalLight).not.toHaveBeenCalled()
    expect(facingTile).not.toHaveBeenCalled()
    const held = (lightFrame.mock.calls[0]![3] as LightingStamp[]).find(s => s.layer?.id === p.id)!
    expect(held.layer!.lit).toBe(false)
    expect(held.facing).toBeFalsy()
    expect(p.lit).toBeUndefined()                  // the layer itself is untouched
    paint([p, lamp])
    const after = (lightFrame.mock.calls[1]![3] as LightingStamp[]).find(s => s.layer?.id === p.id)!
    expect(after.layer!.lit).toBeUndefined()
    expect(after.facing).toBeTruthy()
    expect(after.sig).not.toBe(held.sig)
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

describe('fix round 1', () => {
  const lampL = () => newLightLayer('lamp') as unknown as LocalLayer
  const fxOf = (p: LocalLayer) => (p as unknown as { effects: Record<string, unknown>[] }).effects[0]!
  const withFx = (p: LocalLayer, patch: Record<string, unknown>) => ({ ...p, effects: [{ ...fxOf(p), ...patch }] } as unknown as LocalLayer)

  it('the tile IS what the facing stamp draws, and the visible canvas never draws it', () => {
    const p = photo()
    const ctx = stubCtx()
    paint([p, lampL()], undefined, ctx)
    const copy = tileCopy()
    expect(copy).toBeTruthy()
    const st = (lightFrame.mock.calls[0]![3] as LightingStamp[]).find(s => s.layer?.id === p.id)!
    const target = stubCtx()
    st.facing!.draw(target)
    expect((target.drawImage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])).toContain(copy)
    expect((ctx.drawImage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])).not.toContain(copy)
  })

  it('Shine reruns neither pass; Original light reruns only the paint; Depth / Texture / Shadows only the tile', () => {
    const p = photo()
    const lamp = lampL()
    paint([p, lamp])
    paint([withFx(p, { shine: 0.9 }), lamp])
    expect([originalLight.mock.calls.length, facingTile.mock.calls.length]).toEqual([1, 1])
    paint([withFx(p, { keep: 0.5 }), lamp])
    expect([originalLight.mock.calls.length, facingTile.mock.calls.length]).toEqual([2, 1])
    paint([withFx(p, { depth: 7 }), lamp])
    expect([originalLight.mock.calls.length, facingTile.mock.calls.length]).toEqual([2, 2])
    paint([withFx(p, { texture: 5 }), lamp])
    paint([withFx(p, { shadows: false }), lamp])
    expect([originalLight.mock.calls.length, facingTile.mock.calls.length]).toEqual([2, 4])
  })

  it('a new source image reruns both passes', () => {
    const p = photo()
    const lamp = lampL()
    paint([p, lamp])
    __setImageForTest((p as unknown as { filename: string }).filename, { ...BITMAP } as never)
    paint([p, lamp])
    expect([originalLight.mock.calls.length, facingTile.mock.calls.length]).toEqual([2, 2])
  })

  it('the depth field arriving makes the tile; surfaces arriving remake it', () => {
    const p = photo()
    const lamp = lampL()
    reg.field = null
    paint([p, lamp])
    expect(facingTile).not.toHaveBeenCalled()
    expect((lightFrame.mock.calls[0]![3] as LightingStamp[]).find(s => s.layer?.id === p.id)!.facing).toBeFalsy()
    reg.field = FIELD
    paint([p, lamp])
    expect(facingTile).toHaveBeenCalledTimes(1)
    reg.surfaces = { tag: 'moge' }
    paint([p, lamp])
    expect(facingTile).toHaveBeenCalledTimes(2)
    expect(facingTile.mock.calls[1]![6]).toBe(reg.surfaces)
    expect(originalLight).toHaveBeenCalledTimes(1)
  })

  it('the caches are sized by the visible Relight photos, and emptied when lighting is released', () => {
    releaseLightingMaps()
    expect(__relightPhotoCacheForTest()).toMatchObject({ paint: 0, tile: 0 })
    const ps = Array.from({ length: 5 }, () => photo())
    paint([...ps, lampL()])
    expect(__relightPhotoCacheForTest().max).toBe(12)
    expect(__relightPhotoCacheForTest().tile).toBe(5)
  })

  it('the legacy view is memoised: one conversion per stack, the same lights every paint', () => {
    const p = photo({ lights: [{ x: 0.2, y: 0.3, height: 0.4, color: '#ffcf94', brightness: 2, reach: 1, on: true }] })
    const ls = [rect('r'), p]
    paint(ls)
    paint(ls)
    const a = lightFrame.mock.calls[0]![4] as LocalLayer[], b = lightFrame.mock.calls[1]![4] as LocalLayer[]
    expect(a[0]).toBe(b[0])                              // same object: converted once
    expect(a[0]!.id).toBe(`ll-rl-${p.id}-i0`)            // no stored id: derived, never random
    paint([...ls])                                       // a new stack array converts again, same ids
    expect((lightFrame.mock.calls[2]![4] as LocalLayer[])[0]!.id).toBe(a[0]!.id)
  })
})
