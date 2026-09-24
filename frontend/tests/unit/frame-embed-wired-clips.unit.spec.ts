// @vitest-environment happy-dom
/**
 * Task 7 (3D Studio on the web, Phase 1): an animated wired layer — a 3D scene, Space Type, Shader
 * or Gradient wired into the Frame — plays in the Frame's web export as frames pre-rendered from
 * the slot's live frame source, instead of freezing to a still.
 *
 * Planner: an animated slot with a known clock goes to `wiredClips` and counts towards the Frame's
 * loop exactly as an image clip does; the gatherer says it once in the "Plays live" group
 * ("{label} · pre-rendered · {n} frames · adds {size}").
 * Gatherer: asks the IO for round(duration × fps) frames at the planned size and inlines each as
 * WebP in `snap.wired[slot]`, as each frame arrives. A source with its own export session
 * (`openExport`, 3D) is pulled through it — and a session that could not load an asset blocks the
 * export by name instead of baking a hole. Adapter: picks the frame for the time being painted, wrapping on the
 * clip's own length.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { planFrameExport, type FrameExportInput, type WiredSlotInfo } from '~/lib/embed/frame/plan'
import { buildFrameSnapshot, formatBytes, isBlocked, type FrameExportIO } from '~/lib/embed/frame/gather'
import { pullSourceFrames, createAppFrameExportIO } from '~/lib/embed/frame/appIO'
import { makeScene3DFrameSource } from '~/lib/scene3d/motion/frameSource'
import { failureSentence } from '~/lib/scene3d/assetNames'
import type { AssetFailure } from '~/lib/scene3d/assetTracker'
import { StudioExportFailed } from '~/lib/studio/frameSource'
import type { FrameSnapshot, FrameVariant } from '~/lib/embed/frame/types'
import frameSurface, { wiredClipFrameAt } from '~/lib/embed/surfaces/frame'
import { setNestedSurfaceLoader } from '~/lib/embed/nested'
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
    // Said once, by the gatherer, with the frame count and the size — not twice.
    expect(p.notices.some(n => n.layerId === 'w1')).toBe(false)
    expect(p.notices.some(n => n.group === 'still')).toBe(false)
    expect(p.still).toBe(false)
  })

  it('an animated slot alone does not claim "Everything you animated in the Motion tab"', () => {
    const slots = [{ slot: 0, layerId: 'w1', label: 'Layer 1', animated: true, fps: 24, duration: 2 }]
    const motionLine = (p: ReturnType<typeof planFrameExport>) => p.notices.some(n => n.text === 'Everything you animated in the Motion tab')
    expect(motionLine(planFrameExport(input(variant([wired('w1', 0)]), slots, { hasMotion: true, ownMotion: false })))).toBe(false)
    expect(motionLine(planFrameExport(input(variant([wired('w1', 0)]), slots, { hasMotion: true, ownMotion: true })))).toBe(true)
    // A caller that does not say keeps the old reading.
    expect(motionLine(planFrameExport(input(variant([wired('w1', 0)]), slots, { hasMotion: true })))).toBe(true)
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
    wiredFrames: vi.fn(async (_slot: number, count: number, _maxPx: number, encode: (f: any) => Promise<string>) => {
      const frames: string[] = []
      for (let i = 0; i < count; i++) frames.push(await encode({ i, width: 4, height: 4 }))
      return { frames, failures: [] }
    }),
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
    expect(io.wiredFrames).toHaveBeenCalledWith(2, 48, 1000, expect.any(Function))
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
    const lines = snap.notices.filter(n => n.layerId === 'w1')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toMatch(/^3D scene · pre-rendered · 48 frames · adds \d+(\.\d)? (KB|MB)$/)
  })

  it('encodes a wired clip at the pre-rendered route\'s one WebP quality (0.82)', async () => {
    const v = variant([wired('w1', 0)])
    const plan = planFrameExport(input(v, [{ slot: 0, layerId: 'w1', label: '3D scene', animated: true, fps: 2, duration: 1 }]))
    const io = fakeIO()
    await buildFrameSnapshot(plan, v, io)
    expect(io.imageToDataUrl).toHaveBeenCalledTimes(2)
    for (const call of (io.imageToDataUrl as ReturnType<typeof vi.fn>).mock.calls) expect(call.slice(1)).toEqual([1000, 'image/webp', 0.82])
  })

  it('the app IO hands the quality to the encoder, and keeps its own default for every other caller', async () => {
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/webp;base64,X')
    const ctx = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => {} } as any)
    try {
      const io = createAppFrameExportIO({ uploaded: [], wiredStill: () => null, catalog: [] })
      await io.imageToDataUrl({ width: 10, height: 10 } as any, 10, 'image/webp', 0.82)
      await io.imageToDataUrl({ width: 10, height: 10 } as any, 10, 'image/webp')
      expect(toDataURL.mock.calls).toEqual([['image/webp', 0.82], ['image/webp', 0.9]])
    } finally { toDataURL.mockRestore(); ctx.mockRestore() }
  })

  it('counts the size from the frames handed back, so kept frames (no encode) still say what they add', async () => {
    const v = variant([wired('w1', 0)])
    const plan = planFrameExport(input(v, [{ slot: 0, layerId: 'w1', label: 'Layer 1', animated: true, fps: 2, duration: 1 }]))
    const kept = ['data:image/webp;base64,AAAAAAAA', 'data:image/webp;base64,BBBBBBBB']
    const snap = await buildFrameSnapshot(plan, v, fakeIO({ wiredFrames: vi.fn(async () => ({ frames: kept, failures: [] })) }))
    expect(snap.notices).toContainEqual({ group: 'live', text: `Layer 1 · pre-rendered · 2 frames · adds ${formatBytes(12)}`, layerId: 'w1', bytes: 12 })
  })

  it('a clip whose clock rounds to no frames still asks for one', async () => {
    const v = variant([wired('w1', 0)])
    const plan = planFrameExport(input(v, [{ slot: 0, layerId: 'w1', label: 'Shader', animated: true, fps: 1, duration: 0.2 }]))
    const io = fakeIO()
    await buildFrameSnapshot(plan, v, io)
    expect(io.wiredFrames).toHaveBeenCalledWith(0, 1, 1000, expect.any(Function))
  })

  it('frames that cannot be rendered block the export and name the layer', async () => {
    const v = variant([wired('w1', 0)])
    const plan = planFrameExport(input(v, [{ slot: 0, layerId: 'w1', label: '3D scene', animated: true, fps: 24, duration: 1 }]))
    for (const wiredFrames of [vi.fn(async () => { throw new Error('gone') }), vi.fn(async () => ({ frames: [], failures: [] }))]) {
      const snap = await buildFrameSnapshot(plan, v, fakeIO({ wiredFrames }))
      expect(isBlocked(snap)).toBe(true)
      expect(snap.notices.find(n => n.group === 'blocked')).toEqual({ group: 'blocked', layerId: 'w1', text: '3D scene couldn\'t be rendered as frames.' })
    }
  })

  it('a wired clip says what it adds to the file, as an image clip does', async () => {
    const v = variant([wired('w1', 0)])
    const plan = planFrameExport(input(v, [{ slot: 0, layerId: 'w1', label: 'Layer 1', animated: true, fps: 4, duration: 1 }]))
    const snap = await buildFrameSnapshot(plan, v, fakeIO())
    const entry = snap.wired[0]!
    if (entry.kind !== 'clip') throw new Error('expected a clip')
    const bytes = entry.frames.reduce((n, u) => n + Math.floor((u.length - u.indexOf(',') - 1) * 3 / 4), 0)
    expect(snap.notices).toContainEqual({ group: 'live', text: `Layer 1 · pre-rendered · 4 frames · adds ${formatBytes(bytes)}`, layerId: 'w1', bytes })
  })
})

/** The app's wiring, in small: the IO pulls the slot's source through pullSourceFrames. */
const ioOverSource = (src: StudioFrameSource) => fakeIO({
  wiredFrames: vi.fn((_slot: number, count: number, maxPx: number, encode: (f: any) => Promise<string>) =>
    pullSourceFrames(src, count, maxPx, { encode, copy: (s: any) => s })),
})

describe('a source with its own export session (3D)', () => {
  const plan3d = (v: FrameVariant) => planFrameExport(input(v, [{ slot: 0, layerId: 'w1', label: 'Layer 1', animated: true, fps: 2, duration: 2 }]))

  it('a session that could not load an asset blocks, naming the layer and the asset, and is never pulled', async () => {
    const frame = vi.fn(() => ({}) as any)
    const close = vi.fn()
    const src: StudioFrameSource = {
      duration: 2, fps: 2, width: 1000, height: 500, getFrame: vi.fn(async () => ({}) as any),
      openExport: vi.fn(async () => ({ failures: [{ name: 'model "Sneaker"', reason: 'HTTP 404' }], frame, close })),
    }
    const v = variant([wired('w1', 0)])
    const snap = await buildFrameSnapshot(plan3d(v), v, ioOverSource(src))
    expect(isBlocked(snap)).toBe(true)
    // A source that does not word the clause itself: the plain fact, no advice guessed.
    expect(snap.notices.filter(n => n.group === 'blocked')).toEqual([
      { group: 'blocked', layerId: 'w1', text: 'Layer 1 · model "Sneaker" couldn\'t load' },
    ])
    expect(frame).not.toHaveBeenCalled()
    expect(src.getFrame).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(snap.wired[0]).toBeUndefined()
  })

  it('frames come from the session at t = i / count and the pull size, never from getFrame; the session is closed', async () => {
    const ts: number[] = []
    const close = vi.fn()
    const src: StudioFrameSource = {
      duration: 2, fps: 2, width: 1000, height: 500, getFrame: vi.fn(async () => ({}) as any),
      openExport: vi.fn(async () => ({ failures: [], frame: (t01: number) => { ts.push(t01); return { i: ts.length - 1 } as any }, close })),
    }
    const v = variant([wired('w1', 0)])
    const snap = await buildFrameSnapshot(plan3d(v), v, ioOverSource(src))
    expect(isBlocked(snap)).toBe(false)
    expect(src.openExport).toHaveBeenCalledWith({ width: 1000, height: 500 })
    expect(ts).toEqual([0, 0.25, 0.5, 0.75])
    expect(src.getFrame).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    const entry = snap.wired[0]!
    expect(entry.kind === 'clip' && entry.frames).toEqual([0, 1, 2, 3].map(i => `data:image/webp;base64,F${i}-1000`))
  })

  it('the session is closed even when a frame throws, and the export blocks', async () => {
    const close = vi.fn()
    const src: StudioFrameSource = {
      duration: 2, fps: 2, width: 1000, height: 500, getFrame: vi.fn(async () => ({}) as any),
      openExport: vi.fn(async () => ({ failures: [], frame: (t01: number) => { if (t01 > 0.3) throw new Error('context lost'); return {} as any }, close })),
    }
    await expect(pullSourceFrames(src, 4, 1000, { encode: async () => 'data:,', copy: (s: any) => s })).rejects.toThrow('context lost')
    expect(close).toHaveBeenCalledTimes(1)
    const v = variant([wired('w1', 0)])
    const snap = await buildFrameSnapshot(plan3d(v), v, ioOverSource(src))
    expect(snap.notices.find(n => n.group === 'blocked')?.text).toBe('Layer 1 couldn\'t be rendered as frames.')
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('a 3D slot\'s failures read as 3D Studio\'s own sheet words them — advice by kind, lower case after the layer', async () => {
    const failures: AssetFailure[] = [
      { kind: 'model', name: '/view?filename=Sneaker.glb&type=input', reason: 'glb fetch failed: 404' },
      { kind: 'hdri', name: 'studio_small', reason: 'HTTP 404' },
      { kind: 'shader', name: 'Shader effects', reason: 'offline' },
      { kind: 'font', name: '/fonts/Inter-Bold.ttf', reason: "didn't finish loading" },
    ]
    const close = vi.fn()
    const src = makeScene3DFrameSource({
      getClock: () => ({ duration: 2, fps: 2, width: 1000, height: 500 }), renderAt: () => null,
      openExport: vi.fn(async () => ({ failures, frame: () => ({}) as any, close })),
    })
    const v = variant([wired('w1', 0)])
    const snap = await buildFrameSnapshot(plan3d(v), v, ioOverSource(src))
    const lines = snap.notices.filter(n => n.group === 'blocked').map(n => n.text)
    expect(lines).toEqual([
      'Layer 1 · model "Sneaker" couldn\'t load — re-generate or re-upload it',
      'Layer 1 · lighting "studio_small" couldn\'t load',
      'Layer 1 · shader effects couldn\'t load',
      'Layer 1 · font "Inter-Bold" didn\'t finish loading — try again',
    ])
    // The same clause as the 3D sheet's sentence, but mid-sentence.
    lines.forEach((l, i) => {
      const sentence = failureSentence(failures[i]!)
      expect(l.slice('Layer 1 · '.length)).toBe(sentence.charAt(0).toLowerCase() + sentence.slice(1, -1))
    })
  })

  it('a frame that finds a failed load stops the pull and blocks by name', async () => {
    const close = vi.fn()
    const frame = vi.fn(async (t01: number) => {
      if (t01 >= 0.5) throw Object.assign(new Error('late'), { assetFailures: [{ kind: 'decal', name: 'Logo', reason: 'HTTP 404' }] })
      return {} as any
    })
    const src = makeScene3DFrameSource({
      getClock: () => ({ duration: 2, fps: 2, width: 1000, height: 500 }), renderAt: () => null,
      openExport: vi.fn(async () => ({ failures: [], frame, close })),
    })
    const session = await src.openExport!({ width: 10, height: 10 })
    await expect(session.frame(0.5)).rejects.toBeInstanceOf(StudioExportFailed)
    const v = variant([wired('w1', 0)])
    const snap = await buildFrameSnapshot(plan3d(v), v, ioOverSource(src))
    expect(snap.notices.filter(n => n.group === 'blocked').map(n => n.text)).toEqual(['Layer 1 · sticker "Logo" couldn\'t load'])
    expect(frame).toHaveBeenCalledTimes(4)          // 0, 0.25, 0.5 of this pull (+ the direct call above); never 0.75
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a superseded pull closes its session before its next frame', async () => {
    const frame = vi.fn(() => ({}) as any)
    const close = vi.fn()
    const src: StudioFrameSource = {
      duration: 1, fps: 4, width: 10, height: 10, getFrame: vi.fn(async () => ({}) as any),
      openExport: vi.fn(async () => ({ failures: [], frame, close })),
    }
    let n = 0
    await expect(pullSourceFrames(src, 4, 10, { encode: async () => 'data:,', copy: (s: any) => s, stale: () => ++n > 2 })).rejects.toThrow()
    expect(frame).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('pullSourceFrames', () => {
  it('pulls each frame at t = i / count, sized to fit maxPx at the source\'s aspect, encoding it before the next pull', async () => {
    const log: string[] = []
    const src: StudioFrameSource = {
      duration: 2, fps: 24, width: 1600, height: 900,
      getFrame: vi.fn(async (t01: number, w: number, h: number) => { log.push(`get ${t01} ${w}x${h}`); return { t01 } as any }),
    }
    const copy = vi.fn((s: any, w: number, h: number) => { log.push(`copy ${s.t01} ${w}x${h}`); return { kept: s.t01 } as any })
    const encode = vi.fn(async (f: any) => { log.push(`encode ${f.kept}`); return `data:image/webp;base64,${f.kept}` })
    const out = await pullSourceFrames(src, 4, 800, { copy, encode })
    expect(log).toEqual([
      'get 0 800x450', 'copy 0 800x450', 'encode 0',
      'get 0.25 800x450', 'copy 0.25 800x450', 'encode 0.25',
      'get 0.5 800x450', 'copy 0.5 800x450', 'encode 0.5',
      'get 0.75 800x450', 'copy 0.75 800x450', 'encode 0.75',
    ])
    expect(out).toEqual({ frames: [0, 0.25, 0.5, 0.75].map(t => `data:image/webp;base64,${t}`), failures: [] })
  })

  it('a superseded pull stops before its next frame', async () => {
    const src: StudioFrameSource = { duration: 1, fps: 4, width: 10, height: 10, getFrame: vi.fn(async () => ({}) as any) }
    let n = 0
    await expect(pullSourceFrames(src, 4, 10, { copy: s => s as any, encode: async () => 'data:,', stale: () => ++n > 2 })).rejects.toThrow()
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
    const copy = (s: any) => { log.push(`keep ${s.t01}`); return s }
    const encode = async () => 'data:,'
    const a = pullSourceFrames(src, 2, 10, { copy, encode })
    const b = pullSourceFrames(src, 2, 10, { copy, encode })
    await Promise.resolve(); release()
    await Promise.all([a, b])
    expect(log).toEqual(['get 0', 'keep 0', 'get 0.5', 'keep 0.5', 'get 0', 'keep 0', 'get 0.5', 'keep 0.5'])
  })

  it('a portrait source fits its height; no source is an error', async () => {
    const src: StudioFrameSource = { duration: 1, fps: 1, width: 500, height: 1000, getFrame: vi.fn(async () => ({}) as any) }
    const opts = { copy: vi.fn(() => ({}) as any), encode: async () => 'data:,' }
    await pullSourceFrames(src, 1, 600, opts)
    expect(src.getFrame).toHaveBeenCalledWith(0, 300, 600)
    await expect(pullSourceFrames(undefined, 1, 600, opts)).rejects.toThrow()
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

/**
 * Nested live players (the live route): a wired slot whose studio can play as code carries that
 * studio's own embed player. The Frame adapter mounts it off-document, hands its canvas to the
 * painter, drives its time from the Frame's (wrapped on the slot's own loop, as a clip is), sizes
 * it to the slot's drawn box only when that box changes, and destroys it with the handle.
 */
describe('frame adapter — a live wired layer', () => {
  type FakeHandle = { setTime: ReturnType<typeof vi.fn>; setSize: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }
  const made: { canvas: HTMLCanvasElement; handle: FakeHandle; container: HTMLElement }[] = []
  const fakeSurface = (opts: { reject?: boolean } = {}) => ({
    kind: 'fake', caps: { alpha: true },
    mount: vi.fn(async (container: HTMLElement) => {
      if (opts.reject) throw new Error('nested mount failed')
      const canvas = document.createElement('canvas')
      container.appendChild(canvas)
      const handle = { setTime: vi.fn(), setSize: vi.fn(), destroy: vi.fn() }
      made.push({ canvas, handle, container })
      return handle
    }),
  })
  const live = (bundle: string, duration = 4) =>
    ({ kind: 'live' as const, surface: 'gradient', bundle, config: { c: bundle }, width: 800, height: 450, duration })
  const snapWith = (wiredEntries: FrameSnapshot['wired'], layers: any[], duration = 6): FrameSnapshot => ({
    version: 1, fit: 'fit', duration, still: false, variants: [variant(layers)],
    assets: { urls: {}, fonts: [], shaders: [], depth: [] },
    wired: wiredEntries, notices: [], needsOutlines: false,
  })
  let seen: unknown[] = []

  beforeEach(() => {
    made.length = 0
    seen = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, {
      get: (_t, prop) => (prop === 'canvas' ? undefined : (() => undefined)), set: () => true,
    }) as any)
    vi.spyOn(compositorLayers, 'withWiredContent').mockImplementation(((provider: any) => {
      seen.push(provider?.(3) ?? null)
      return undefined
    }) as any)
  })
  afterEach(() => {
    setNestedSurfaceLoader(null)
    vi.restoreAllMocks(); document.body.innerHTML = ''
  })

  const box = () => { const b = document.createElement('div'); document.body.appendChild(b); return b }

  it('the provider hands back the nested player\'s canvas, mounted off-document with the entry\'s config', async () => {
    const surface = fakeSurface()
    setNestedSurfaceLoader(async name => (name === 'gradient' ? surface as any : null))
    const handle = await frameSurface.mount(box(), snapWith({ 3: live('gradient') }, [wired('w1', 3)]))
    expect(surface.mount).toHaveBeenCalledTimes(1)
    expect(surface.mount.mock.calls[0]![1]).toEqual({ c: 'gradient' })
    expect(made[0]!.container.isConnected).toBe(false)
    expect(seen.at(-1)).toBe(made[0]!.canvas)
    handle.destroy()
  })

  it('setTime gets the slot\'s own loop phase of the Frame time', async () => {
    setNestedSurfaceLoader(async () => fakeSurface() as any)
    const handle = await frameSurface.mount(box(), snapWith({ 3: live('gradient', 4) }, [wired('w1', 3)], 6))
    const nestedTime = made[0]!.handle.setTime
    expect(nestedTime).toHaveBeenLastCalledWith(0)
    handle.setTime(0.75)                            // 4.5 s of a 6 s Frame → 0.5 s into a 4 s loop
    expect(nestedTime.mock.calls.at(-1)![0]).toBeCloseTo(0.125, 10)
    // Sized and timed BEFORE the painter reads the canvas.
    const order = [made[0]!.handle.setTime.mock.invocationCallOrder.at(-1)!, (compositorLayers.withWiredContent as any).mock.invocationCallOrder.at(-1)!]
    expect(order[0]).toBeLessThan(order[1]!)
    handle.destroy()
  })

  it('is sized to the slot\'s drawn box once per size, and again after the Frame handle\'s setSize', async () => {
    setNestedSurfaceLoader(async () => fakeSurface() as any)
    // Two layers on the slot: the larger one (w 0.5 of a 1000 px Frame → 500 px long) wins.
    const handle = await frameSurface.mount(box(), snapWith({ 3: live('gradient') }, [wired('w1', 3), wired('w2', 3, { w: 0.2 })]))
    const setSize = made[0]!.handle.setSize
    expect(setSize.mock.calls).toEqual([[500, 281]])  // 1000×500 canvas, scale 1; 800×450 source aspect
    handle.setTime(0.1); handle.setTime(0.2); handle.setTime(0.3)
    expect(setSize).toHaveBeenCalledTimes(1)
    handle.setSize(2000, 1000)                       // scale 2
    expect(setSize.mock.calls.at(-1)).toEqual([1000, 563])
    handle.setTime(0.4)
    expect(setSize).toHaveBeenCalledTimes(2)
    handle.destroy()
  })

  it('destroy destroys the nested player', async () => {
    setNestedSurfaceLoader(async () => fakeSurface() as any)
    const handle = await frameSurface.mount(box(), snapWith({ 3: live('gradient') }, [wired('w1', 3)]))
    handle.destroy()
    expect(made[0]!.handle.destroy).toHaveBeenCalledTimes(1)
  })

  it('a nested mount that rejects rejects the Frame mount and destroys the players already mounted', async () => {
    const ok = fakeSurface(), bad = fakeSurface({ reject: true })
    setNestedSurfaceLoader(async name => (name === 'gradient' ? ok : bad) as any)
    const b = box()
    await expect(frameSurface.mount(b, snapWith({ 1: live('gradient'), 2: live('spacetype-x') }, [wired('w1', 1), wired('w2', 2)])))
      .rejects.toThrow('nested mount failed')
    expect(made).toHaveLength(1)
    expect(made[0]!.handle.destroy).toHaveBeenCalledTimes(1)
    expect(b.querySelector('canvas')).toBeNull()
  })

  it('a live layer whose player cannot be found rejects the mount', async () => {
    await expect(frameSurface.mount(box(), snapWith({ 3: live('gradient') }, [wired('w1', 3)])))
      .rejects.toThrow('embed: a live layer\'s player is missing')
  })
})
