// @vitest-environment happy-dom
/**
 * Task 7 (3D Studio on the web, Phase 1): an animated wired layer — a 3D scene, Space Type, Shader
 * or Gradient wired into the Frame — plays in the Frame's web export as frames pre-rendered from
 * the slot's live frame source, instead of freezing to a still.
 *
 * Planner: an animated slot with a known clock goes to `wiredClips`, says "plays as frames" in the
 * "Plays live" group, and counts towards the Frame's loop exactly as an image clip does.
 * Gatherer: asks the IO for round(duration × fps) frames at the planned size and inlines each as
 * WebP in `snap.wired[slot]`. Adapter: picks the frame for the time being painted, wrapping on the
 * clip's own length.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { planFrameExport, type FrameExportInput, type WiredSlotInfo } from '~/lib/embed/frame/plan'
import { buildFrameSnapshot, isBlocked, type FrameExportIO } from '~/lib/embed/frame/gather'
import { pullSourceFrames } from '~/lib/embed/frame/appIO'
import type { FrameSnapshot, FrameVariant } from '~/lib/embed/frame/types'
import frameSurface, { wiredClipFrameAt } from '~/lib/embed/surfaces/frame'
import * as compositorLayers from '~/composables/useCompositorLayers'
import { createImageLayer, createRectLayer } from '~/composables/useCompositorLayers'
import type { StudioFrameSource } from '~/lib/studio/frameSource'

const wired = (id: string, slot: number, extra: Record<string, unknown> = {}) =>
  ({ kind: 'wired', id, slot, w: 0.5, lastAspect: 0.5, x: 0.5, y: 0.5, rotation: 0, opacity: 1, ...extra }) as any

function variant(layers: any[], extra: Partial<FrameVariant> = {}): FrameVariant {
  return {
    width: 1000, height: 500, layers, stackOrder: layers.map(l => `l:${l.id}`), groups: [],
    background: '#101010', post: [], motion: null, wiredTreatments: {}, ...extra,
  }
}
function input(v: FrameVariant, wiredSlots: WiredSlotInfo[], extra: Partial<FrameExportInput> = {}): FrameExportInput {
  return { variant: v, fit: 'fit', wiredSlots, catalogIds: new Set(), hasMotion: false, animatedFill: false, ...extra }
}
const clipped = (frames: number, fps: number) => {
  const img = createImageLayer('rose.png', 1, { w: 0.3, h: 0.3 }) as any
  img.clip = { dir: `sailor_clips/${frames}-${fps}`, frames, fps, speed: 1, prompt: '', model: '' }
  return img
}

describe('planFrameExport — animated wired slots', () => {
  it('an animated wired slot with a clock plays as frames, not as a still', () => {
    const w = wired('w1', 0)
    const p = planFrameExport(input(variant([w]), [{ slot: 0, layerId: 'w1', label: '3D scene', animated: true, fps: 24, duration: 2 }]))
    expect(p.wiredClips).toEqual([{ slot: 0, maxPx: 1000, fps: 24, duration: 2, label: '3D scene', layerId: 'w1' }])
    expect(p.wiredStills).toEqual([])
    expect(p.notices).toContainEqual({ group: 'live', text: '3D scene · plays as frames', layerId: 'w1' })
    expect(p.notices.some(n => n.group === 'still')).toBe(false)
    expect(p.still).toBe(false)
  })

  it('a still wired slot is unchanged', () => {
    const w = wired('w1', 1, { lastAspect: 1 })
    const p = planFrameExport(input(variant([w]), [{ slot: 1, layerId: 'w1', label: 'Photo', animated: false }]))
    expect(p.wiredStills).toEqual([{ slot: 1, maxPx: 1000 }])
    expect(p.wiredClips).toEqual([])
    expect(p.notices).toEqual([])
    expect(p.still).toBe(true)
  })

  it('an animated slot with no known clock stays a still and says so', () => {
    const w = wired('w1', 0)
    const p = planFrameExport(input(variant([w]), [{ slot: 0, layerId: 'w1', label: 'Space Type', animated: true }]))
    expect(p.wiredClips).toEqual([])
    expect(p.wiredStills).toEqual([{ slot: 0, maxPx: 1000 }])
    expect(p.notices).toContainEqual({ group: 'still', text: 'Space Type · shown as a still in this version', layerId: 'w1' })
  })

  // loopSeconds: the Frame's motion duration when it has motion; otherwise deriveMasterClock over
  // the nested loops — a wired clip is one of them, exactly like an image clip.
  it('with no motion, the Frame loops on the wired clip\'s own length', () => {
    const p = planFrameExport(input(variant([wired('w1', 0)]), [{ slot: 0, layerId: 'w1', label: 'Shader', animated: true, fps: 30, duration: 3 }]))
    expect(p.duration).toBe(3)
  })

  it('a wired clip and an image clip loop on the length they both complete whole cycles in', () => {
    const img = clipped(24, 12)   // 2 s
    const p = planFrameExport(input(variant([wired('w1', 0), img]), [{ slot: 0, layerId: 'w1', label: 'Shader', animated: true, fps: 12, duration: 3 }]))
    expect(p.duration).toBe(6)
  })

  it('the Frame\'s own motion wins, and a wired clip that does not divide it gets the seam notice', () => {
    const v = variant([wired('w1', 0)], { motion: { fps: 30, duration: 4 } as any })
    const p = planFrameExport(input(v, [{ slot: 0, layerId: 'w1', label: 'Space Type', animated: true, fps: 30, duration: 3 }], { hasMotion: true }))
    expect(p.duration).toBe(4)
    expect(p.notices).toContainEqual({ group: 'live', layerId: 'w1', text: 'Space Type loops every 3s, the Frame every 4s — it restarts at the seam' })
    const even = planFrameExport(input(v, [{ slot: 0, layerId: 'w1', label: 'Space Type', animated: true, fps: 30, duration: 2 }], { hasMotion: true }))
    expect(even.notices.some(n => n.text.includes('seam'))).toBe(false)
  })
})

function fakeIO(over: Partial<FrameExportIO> = {}): FrameExportIO {
  return {
    fetchBlob: vi.fn(async (url: string) => new Blob([url])),
    blobToImage: vi.fn(async () => ({ width: 10, height: 10 } as any)),
    imageToDataUrl: vi.fn(async (img: any, maxPx: number, mime: string) => `data:${mime};base64,F${img?.i ?? 'S'}-${maxPx}`),
    blobToDataUrl: vi.fn(async () => 'data:image/png;base64,RAW'),
    blobToBase64: vi.fn(async () => 'RkFMTA=='),
    subsetFont: vi.fn(async () => 'U1VC'),
    fontSource: vi.fn(() => null),
    wiredStill: vi.fn(() => ({ width: 4, height: 4 } as any)),
    wiredFrames: vi.fn(async (_slot: number, count: number) => Array.from({ length: count }, (_, i) => ({ i, width: 4, height: 4 } as any))),
    depthImage: vi.fn(() => null),
    shaderDefs: vi.fn(() => []),
    ...over,
  }
}

describe('buildFrameSnapshot — wired clips', () => {
  it('asks for round(duration × fps) frames at the planned size and inlines each as WebP', async () => {
    const v = variant([wired('w1', 2)])
    const plan = planFrameExport(input(v, [{ slot: 2, layerId: 'w1', label: '3D scene', animated: true, fps: 24, duration: 2 }]))
    const io = fakeIO()
    const snap = await buildFrameSnapshot(plan, v, io)
    expect(io.wiredFrames).toHaveBeenCalledWith(2, 48, 1000)
    expect(io.wiredStill).not.toHaveBeenCalled()
    const entry = snap.wired[2]!
    expect(entry.kind).toBe('clip')
    if (entry.kind !== 'clip') return
    expect(entry.fps).toBe(24)
    expect(entry.duration).toBe(2)
    expect(entry.frames).toHaveLength(48)
    expect(entry.frames[0]).toBe('data:image/webp;base64,F0-1000')
    expect(entry.frames[47]).toBe('data:image/webp;base64,F47-1000')
    for (const f of entry.frames) expect(f).toMatch(/^data:image\/webp/)
    expect(isBlocked(snap)).toBe(false)
    expect(snap.notices).toContainEqual(expect.objectContaining({ group: 'live', text: '3D scene · plays as frames', layerId: 'w1' }))
  })

  it('a clip whose clock rounds to no frames still asks for one', async () => {
    const v = variant([wired('w1', 0)])
    const plan = planFrameExport(input(v, [{ slot: 0, layerId: 'w1', label: 'Shader', animated: true, fps: 1, duration: 0.2 }]))
    const io = fakeIO()
    await buildFrameSnapshot(plan, v, io)
    expect(io.wiredFrames).toHaveBeenCalledWith(0, 1, 1000)
  })

  it('frames that cannot be rendered block the export and name the layer', async () => {
    const v = variant([wired('w1', 0)])
    const plan = planFrameExport(input(v, [{ slot: 0, layerId: 'w1', label: '3D scene', animated: true, fps: 24, duration: 1 }]))
    for (const wiredFrames of [vi.fn(async () => { throw new Error('gone') }), vi.fn(async () => [])]) {
      const snap = await buildFrameSnapshot(plan, v, fakeIO({ wiredFrames }))
      expect(isBlocked(snap)).toBe(true)
      expect(snap.notices.find(n => n.group === 'blocked')).toEqual({ group: 'blocked', layerId: 'w1', text: '3D scene couldn\'t be rendered as frames.' })
    }
  })
})

describe('pullSourceFrames', () => {
  it('pulls each frame at t = i / count, sized to fit maxPx at the source\'s aspect, keeping it before the next pull', async () => {
    const log: string[] = []
    const src: StudioFrameSource = {
      duration: 2, fps: 24, width: 1600, height: 900,
      getFrame: vi.fn(async (t01: number, w: number, h: number) => { log.push(`get ${t01} ${w}x${h}`); return { t01 } as any }),
    }
    const keep = vi.fn(async (s: any, w: number, h: number) => { log.push(`keep ${s.t01} ${w}x${h}`); return { kept: s.t01 } as any })
    const out = await pullSourceFrames(src, 4, 800, { keep })
    expect(log).toEqual([
      'get 0 800x450', 'keep 0 800x450',
      'get 0.25 800x450', 'keep 0.25 800x450',
      'get 0.5 800x450', 'keep 0.5 800x450',
      'get 0.75 800x450', 'keep 0.75 800x450',
    ])
    expect(out).toEqual([{ kept: 0 }, { kept: 0.25 }, { kept: 0.5 }, { kept: 0.75 }])
  })

  it('a superseded pull stops before its next frame', async () => {
    const src: StudioFrameSource = { duration: 1, fps: 4, width: 10, height: 10, getFrame: vi.fn(async () => ({}) as any) }
    let n = 0
    await expect(pullSourceFrames(src, 4, 10, { keep: async () => ({}) as any, stale: () => ++n > 2 })).rejects.toThrow()
    expect(src.getFrame).toHaveBeenCalledTimes(2)
  })

  it('two pulls from one source never interleave', async () => {
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const src: StudioFrameSource = {
      duration: 1, fps: 2, width: 10, height: 10,
      getFrame: vi.fn(async (t01: number) => { log.push(`get ${t01}`); if (t01 === 0 && log.length === 1) await gate; return { t01 } as any }),
    }
    const keep = async (s: any) => { log.push(`keep ${s.t01}`); return s }
    const a = pullSourceFrames(src, 2, 10, { keep })
    const b = pullSourceFrames(src, 2, 10, { keep })
    await Promise.resolve(); release()
    await Promise.all([a, b])
    expect(log).toEqual(['get 0', 'keep 0', 'get 0.5', 'keep 0.5', 'get 0', 'keep 0', 'get 0.5', 'keep 0.5'])
  })

  it('a portrait source fits its height; no source is an error', async () => {
    const src: StudioFrameSource = { duration: 1, fps: 1, width: 500, height: 1000, getFrame: vi.fn(async () => ({}) as any) }
    const keep = vi.fn(async () => ({}) as any)
    await pullSourceFrames(src, 1, 600, { keep })
    expect(src.getFrame).toHaveBeenCalledWith(0, 300, 600)
    await expect(pullSourceFrames(undefined, 1, 600, { keep })).rejects.toThrow()
  })
})

describe('wiredClipFrameAt', () => {
  const entry = { frames: Array.from({ length: 48 }), duration: 2 }
  it('wraps on the clip\'s own duration', () => {
    expect(wiredClipFrameAt(entry, 0)).toBe(0)
    expect(wiredClipFrameAt(entry, 1)).toBe(24)
    expect(wiredClipFrameAt(entry, 2)).toBe(0)
    expect(wiredClipFrameAt(entry, 2.5)).toBe(12)
    expect(wiredClipFrameAt(entry, 1.999)).toBe(47)
  })
  it('is 0 for an empty or clockless clip', () => {
    expect(wiredClipFrameAt({ frames: [], duration: 2 }, 1)).toBe(0)
    expect(wiredClipFrameAt({ frames: [1, 2], duration: 0 }, 1)).toBe(0)
  })
})

// happy-dom has no FontFaceSet; the adapter awaits document.fonts.ready even with no fonts.
if (!(document as any).fonts) {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), load: async () => [] } })
}

describe('frame adapter — a wired clip', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

  it('the wired provider hands back the clip frame for the time being painted', async () => {
    // Images "decode" at once, remembering their src.
    vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null
      complete = true; naturalWidth = 4; naturalHeight = 4; src = ''
      decode() { return Promise.resolve() }
      constructor() { return new Proxy(this, { set: (t: any, k, val) => { t[k] = val; if (k === 'src') queueMicrotask(() => t.onload?.()); return true } }) } })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, {
      get: (_t, prop) => (prop === 'canvas' ? undefined : (() => undefined)), set: () => true,
    }) as any)
    const seen: (string | null)[] = []
    vi.spyOn(compositorLayers, 'withWiredContent').mockImplementation(((provider: any) => {
      seen.push((provider?.(3) as any)?.src ?? null)
      return undefined
    }) as any)

    const v = variant([wired('w1', 3), createRectLayer({})])
    const frames = Array.from({ length: 4 }, (_, i) => `data:image/webp;base64,FRAME${i}`)
    const snap: FrameSnapshot = {
      version: 1, fit: 'fit', duration: 4, still: false, variants: [v],
      assets: { urls: {}, fonts: [], shaders: [], depth: [] },
      wired: { 3: { kind: 'clip', frames, fps: 2, duration: 2 } },
      notices: [], needsOutlines: false,
    }
    const box = document.createElement('div')
    document.body.appendChild(box)
    const handle = await frameSurface.mount(box, snap)
    expect(seen.at(-1)).toBe(frames[0])             // first paint, t = 0
    handle.setTime(0.125)                            // 0.5 s of a 4 s Frame → frame 1 of a 2 s clip
    expect(seen.at(-1)).toBe(frames[1])
    handle.setTime(0.5)                              // 2 s → the clip has wrapped
    expect(seen.at(-1)).toBe(frames[0])
    handle.setTime(0.875)                            // 3.5 s → 1.5 s into the clip
    expect(seen.at(-1)).toBe(frames[3])
    handle.destroy()
  })
})
