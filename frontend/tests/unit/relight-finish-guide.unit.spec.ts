import { describe, it, expect, vi, beforeEach } from 'vitest'

// Light layers stage 2, Task 4: Finish's guide is the photo's box lit by the Frame's visible
// lights. No WebGL in node: the lighting step and Relight's per-photo pass are stand-ins; what
// renderRelightPair hands them is checked.
const lightBox = vi.fn((..._a: unknown[]) => ({ width: _a[2], height: _a[3], tag: 'lit', getContext: () => null }))
vi.mock('~/lib/frame/lighting/lightingPass', async (orig) => ({
  ...(await orig<typeof import('~/lib/frame/lighting/lightingPass')>()),
  lightBoxWithFrameLights: (...a: unknown[]) => lightBox(...a),
}))
const fake = (w: number, h: number, tag: string) => ({ width: w, height: h, tag, getContext: () => null })
vi.mock('~/lib/relight/relightPass', () => ({
  relightAvailable: () => true,
  relightOriginalLight: (_c: unknown, _k: number, w: number, h: number) => fake(w, h, 'original'),
  relightFacingTile: (_c: unknown, _f: unknown, _fx: unknown, w: number, h: number) => fake(w, h, 'tile'),
  originalLightActive: () => true,
  releaseRelight: () => {},
}))
vi.mock('~/lib/compositor/depthRegistry', async (orig) => ({
  ...(await orig<typeof import('~/lib/compositor/depthRegistry')>()),
  depthImageFor: () => ({ complete: true, naturalWidth: 2, naturalHeight: 2 }),
  requestDepth: () => {},
}))
vi.mock('~/lib/relight/depthField', async (orig) => ({
  ...(await orig<typeof import('~/lib/relight/depthField')>()),
  relightDepthFieldFor: () => ({ kind: 'float', width: 2, height: 2, data: new Float32Array(4) }),
}))

import { renderRelightPair, __setImageForTest, type LocalLayer } from '~/composables/useCompositorLayers'
import { newLightLayer } from '~/lib/frame/lighting/settings'
import { lightsInBox } from '~/lib/frame/lighting/lightingPass'
import { relightBoxToFrame } from '~/lib/frame/lighting/convertRelight'
import { defaultRelightSettings } from '~/lib/relight/settings'

let made: any[] = []
beforeEach(() => {
  lightBox.mockClear(); made = []
  vi.stubGlobal('document', {
    createElement: () => {
      const c: any = { width: 0, height: 0 }
      const x = new Proxy({ canvas: c }, { get: (t: any, k) => (k in t ? t[k] : (t[k] = vi.fn())) })
      c.getContext = () => x
      made.push(c); return c
    },
  })
})

const photo = (): LocalLayer => {
  __setImageForTest('guide.png', { complete: true, naturalWidth: 400, naturalHeight: 200, width: 400, height: 200 } as never)
  return {
    id: 'p', kind: 'image', filename: 'guide.png', x: 0.4, y: 0.6, w: 0.5, h: 0.25, rotation: 20, opacity: 1,
    effects: [{ id: 'fx', type: 'relight', visible: true, ...defaultRelightSettings(), shine: 0.7 }],
  } as unknown as LocalLayer
}

describe('renderRelightPair — the guide takes the Frame\'s lights', () => {
  it('passes the visible lights, the lighting record, the tile and the shine through', async () => {
    const p = photo()
    const a = newLightLayer('lamp', { x: 0.2, y: 0.3 })
    const hidden = { ...newLightLayer('lamp', { x: 0.9, y: 0.9 }), visible: false } as LocalLayer
    const lighting = { darkness: 0.6, backgroundLit: true }
    const r = await renderRelightPair(p, 1000, 500, 1536, { layers: [p, a as LocalLayer, hidden], lighting })
    expect(r).not.toBeNull()
    expect(lightBox).toHaveBeenCalledTimes(1)
    const [color, tile, bw, bh, ph, lights, lit, W, H, shine] = lightBox.mock.calls[0]! as any[]
    // The painter's own copies of Relight's Original-light canvas and facing tile.
    const drew = (c: any) => c.getContext().drawImage.mock.calls.map((a: any[]) => a[0]?.tag)
    expect(drew(color)).toContain('original')
    expect(drew(tile)).toContain('tile')
    expect([bw, bh]).toEqual([r!.w, r!.h])
    expect(ph).toBe(p)
    expect((lights as any[]).map(l => l.id)).toEqual([a.id])
    expect(lit).toBe(lighting)
    expect([W, H]).toEqual([1000, 500])
    expect(shine).toBe(0.7)
    expect((r!.guide as any).tag).toBe('lit')
    // pair aligned, source resolution (400x200 source, 0.5x0.25 box => 2:1)
    expect(r!.original.width).toBe(r!.guide.width)
    expect(r!.original.height).toBe(r!.guide.height)
  })

  it('no visible light: the guide is the photo with Original light only, copied', async () => {
    const p = photo()
    const r = await renderRelightPair(p, 1000, 500, 1536, { layers: [p], lighting: { darkness: 0.5, backgroundLit: true } })
    expect(lightBox).not.toHaveBeenCalled()
    expect(r).not.toBeNull()
    expect(r!.guide).not.toBe(r!.original)
  })

  it('no frame argument behaves like no lights', async () => {
    const r = await renderRelightPair(photo(), 1000, 500)
    expect(lightBox).not.toHaveBeenCalled()
    expect(r).not.toBeNull()
  })
})

describe('Frame -> box -> Frame mapping is the identity', () => {
  it('a light mapped into the box and back lands where it started', () => {
    const p = photo()
    const l = newLightLayer('spot', { x: 0.27, y: 0.71 })
    const [b] = lightsInBox(p, [l as LocalLayer & typeof l], 1000, 500)
    const back = relightBoxToFrame(p, b!.x, b!.y, 1000, 500)
    expect(back.x).toBeCloseTo(l.x, 6)
    expect(back.y).toBeCloseTo(l.y, 6)
    const aimBack = relightBoxToFrame(p, b!.light.aimX, b!.light.aimY, 1000, 500)
    expect(aimBack.x).toBeCloseTo(l.light.aimX, 6)
    expect(aimBack.y).toBeCloseTo(l.light.aimY, 6)
  })
})
