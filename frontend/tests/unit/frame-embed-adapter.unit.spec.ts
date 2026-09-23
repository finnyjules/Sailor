// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import frameSurface from '~/lib/embed/surfaces/frame'
import { assetKey, type FrameSnapshot, type FrameVariant } from '~/lib/embed/frame/types'
import { clipFrameKey } from '~/lib/compositor/clip'
import { createImageLayer, createRectLayer } from '~/composables/useCompositorLayers'
import * as booleanGeometry from '~/lib/compositor/booleanGeometry'
import * as textOutline from '~/lib/compositor/textOutline'
import { createEffect } from '~/lib/compositor/effectStack'

function snapshotOf(layers: any[], urls: Record<string, string>): FrameSnapshot {
  const v: FrameVariant = {
    width: 100, height: 50, layers, stackOrder: layers.map(l => `l:${l.id}`), groups: [],
    background: '#000000', post: [], motion: null, wiredTreatments: {},
  }
  return {
    version: 1, fit: 'fit', duration: 1, still: true, variants: [v],
    assets: { urls, fonts: [], shaders: [], depth: [] }, wired: {}, notices: [], needsOutlines: false,
  }
}

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const CLIP = { dir: 'sailor_clips/c1', frames: 3, fps: 6, speed: 1, prompt: '', model: '' }

// happy-dom has no FontFaceSet; the adapter awaits document.fonts.ready even with no fonts.
if (!(document as any).fonts) {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), load: async () => [] } })
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('frame adapter — a snapshot missing an inlined asset', () => {
  it('rejects when an image layer has no inlined copy, before touching the container', async () => {
    const box = document.createElement('div')
    document.body.appendChild(box)
    const snap = snapshotOf([createImageLayer('photo.png', 1)], {})
    await expect(frameSurface.mount(box, snap)).rejects.toThrow('embed: frame snapshot is missing an inlined asset')
    expect(box.querySelectorAll('canvas').length).toBe(0)
  })

  it('rejects when one clip frame has no inlined copy', async () => {
    const img = createImageLayer('rose.png', 1) as any
    img.clip = CLIP
    const urls: Record<string, string> = { [assetKey('image', 'rose.png')]: PNG }
    for (const i of [0, 2]) urls[assetKey('clipFrame', clipFrameKey(CLIP, i))] = PNG   // frame 1 missing
    await expect(frameSurface.mount(document.createElement('div'), snapshotOf([img], urls)))
      .rejects.toThrow('embed: frame snapshot is missing an inlined asset')
  })

  // R12: a stand-in that names a file is checked like any image (the gatherer always stores its
  // key), so a snapshot without it refuses; one with no file has nothing to check.
  it('rejects a stand-in whose file has no inlined copy', async () => {
    const standIn = createImageLayer('x.png', 1, { standIn: true } as any)
    await expect(frameSurface.mount(document.createElement('div'), snapshotOf([standIn], {})))
      .rejects.toThrow('embed: frame snapshot is missing an inlined asset')
  })

  it('lets a file-less stand-in, an image layer with no file and a stand-in stored as data:, past the asset check', async () => {
    const standIn = createImageLayer('', 1, { standIn: true } as any)
    const empty = createImageLayer('', 1)
    const gone = createImageLayer('gone.png', 1, { standIn: true } as any)
    const box = document.createElement('div')
    // happy-dom never settles an <img> load; the painter's preload would wait forever. Any src
    // fails at once instead (the painter treats a failed load as "nothing to draw").
    vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null
      complete = false; set src(_u: string) { queueMicrotask(() => this.onerror?.()) } })
    // Past the asset check, the first thing that can fail in happy-dom is the 2D context — proof
    // the check let these through.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(frameSurface.mount(box, snapshotOf([standIn, empty, gone], { [assetKey('image', 'gone.png')]: 'data:,' })))
      .rejects.toThrow('embed: no 2D context')
  })

  // R10: the painter's preload (ensureLayerImages) must not ask for an image layer that has no
  // file — a pattern's stand-in before a photo is applied. It used to request
  // `/view?filename=&type=input`, which in an exported file is a request from a page that must
  // make none. Counted at the only place a load can start: every `Image.src` assignment.
  it('never asks for an image layer that has no file', async () => {
    const srcs: string[] = []
    vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null
      complete = false; set src(u: string) { srcs.push(u); queueMicrotask(() => this.onerror?.()) } })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const standIn = createImageLayer('', 4 / 3, { standIn: true } as any)   // lib/frame/patterns/insert.ts's shape
    const empty = createImageLayer('', 1)
    await expect(frameSurface.mount(document.createElement('div'), snapshotOf([standIn, empty], {})))
      .rejects.toThrow('embed: no 2D context')
    expect(srcs).toEqual([])
  })
})

describe('frame adapter — a first paint that throws', () => {
  it('leaves no canvas in the container', async () => {
    const box = document.createElement('div')
    document.body.appendChild(box)
    const broken = new Proxy({}, { get: () => () => { throw new Error('paint broke') } })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(broken as any)
    await expect(frameSurface.mount(box, snapshotOf([createRectLayer({})], {}))).rejects.toThrow('paint broke')
    expect(box.querySelectorAll('canvas').length).toBe(0)
  })
})

// R14c: a Frame whose snapshot says it needs paper.js (`needsOutlines: true` — F3's
// `boolean`/`shatter`/`morph`) must not silently draw the unclipped shape if paper never warms.
// `warmPaperBoolean` itself never rejects (its own `.catch` swallows a failed `import('paper')`),
// so the adapter has to check `isPaperWarm()` afterwards and refuse the mount itself — these tests
// spy on both booleanGeometry exports directly (rather than actually breaking the real dynamic
// `import('paper')`, which the module-level singleton state in booleanGeometry.ts makes hard to
// reset deterministically once warmed by another test in the same process) to prove that exact
// contract: paper-fails-to-warm rejects the mount (→ bundle.ts's runtime keeps the poster — a
// correct still, never a silent wrong picture — see paperLean.embed.ts's doc for the full chain),
// and a Frame that does NOT need paper never even asks.
describe('frame adapter — paper.js required and unavailable (R14c)', () => {
  it('rejects the mount when needsOutlines is true but paper never warms', async () => {
    vi.spyOn(booleanGeometry, 'warmPaperBoolean').mockResolvedValue(undefined)
    vi.spyOn(booleanGeometry, 'isPaperWarm').mockReturnValue(false)
    const box = document.createElement('div')
    document.body.appendChild(box)
    const snap = snapshotOf([createRectLayer({})], {})
    snap.needsOutlines = true
    await expect(frameSurface.mount(box, snap)).rejects.toThrow('embed: paper.js failed to load for a Frame that needs it')
    expect(box.querySelectorAll('canvas').length).toBe(0)
  })

  // happy-dom has no real canvas 2D backend (getContext returns null); every other passing-mount
  // assertion in this file works around that with a permissive stand-in context. This one never
  // throws and never returns anything meaningful — fine here, since these two tests only check
  // whether mount() RESOLVES and whether warmPaperBoolean was called, never the painted pixels.
  function permissiveCtx2D(): CanvasRenderingContext2D {
    return new Proxy({}, {
      get: (_t, prop) => (prop === 'canvas' ? undefined : (() => undefined)),
      set: () => true,
    }) as unknown as CanvasRenderingContext2D
  }

  it('mounts normally when needsOutlines is true and paper does warm', async () => {
    vi.spyOn(booleanGeometry, 'warmPaperBoolean').mockResolvedValue(undefined)
    vi.spyOn(booleanGeometry, 'isPaperWarm').mockReturnValue(true)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(permissiveCtx2D())
    const box = document.createElement('div')
    document.body.appendChild(box)
    const snap = snapshotOf([createRectLayer({})], {})
    snap.needsOutlines = true
    const handle = await frameSurface.mount(box, snap)
    expect(box.querySelectorAll('canvas').length).toBe(1)
    handle.destroy()
  })

  it('never checks paper at all when needsOutlines is false and no layer needs it (the common case)', async () => {
    const warmSpy = vi.spyOn(booleanGeometry, 'warmPaperBoolean')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(permissiveCtx2D())
    const box = document.createElement('div')
    document.body.appendChild(box)
    const handle = await frameSurface.mount(box, snapshotOf([createRectLayer({})], {}))
    expect(warmSpy).not.toHaveBeenCalled()
    handle.destroy()
  })

  // Fix round 2 (R14a, second half): the gate must not depend SOLELY on `snap.needsOutlines`. If
  // `computeNeedsOutlines` (gather.ts) ever under-counted — the bug class this test simulates by
  // hand-setting `needsOutlines: false` on a snapshot whose one layer plainly carries a `shatter`
  // effect — the OLD gate (`if (snap.needsOutlines)`) would never even call `warmPaperBoolean`,
  // and the first paint would silently ship the unclipped shape. `layersNeedPaper(v.layers)`
  // (./needs.ts) re-derives the answer from the layers mount() is actually about to paint,
  // independent of the snapshot's own precomputed flag, so this still catches it.
  it('R14a (fix round 2): still warms and rejects when needsOutlines is FALSE but a layer carries a shatter effect', async () => {
    const warmSpy = vi.spyOn(booleanGeometry, 'warmPaperBoolean').mockResolvedValue(undefined)
    vi.spyOn(booleanGeometry, 'isPaperWarm').mockReturnValue(false)
    const box = document.createElement('div')
    document.body.appendChild(box)
    const shattered = createRectLayer({}) as any
    shattered.effects = [{ ...createEffect('shatter'), visible: true }]
    const snap = snapshotOf([shattered], {})   // needsOutlines: false, from snapshotOf's default
    await expect(frameSurface.mount(box, snap)).rejects.toThrow('embed: paper.js failed to load for a Frame that needs it')
    expect(warmSpy).toHaveBeenCalled()
    expect(box.querySelectorAll('canvas').length).toBe(0)
  })

  it('R14a (fix round 2): warms and mounts normally when needsOutlines is FALSE, a layer carries a shatter effect, and paper does warm', async () => {
    vi.spyOn(booleanGeometry, 'warmPaperBoolean').mockResolvedValue(undefined)
    vi.spyOn(booleanGeometry, 'isPaperWarm').mockReturnValue(true)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(permissiveCtx2D())
    // happy-dom has no Path2D — a layer carrying a geometry effect (shatter here) takes
    // drawLayerContent's computed-outline branch, which builds one (`new Path2D(gd)`) before
    // handing it to the (permissive, no-op) ctx.
    vi.stubGlobal('Path2D', class { constructor(public d?: string) {} })
    const box = document.createElement('div')
    document.body.appendChild(box)
    const shattered = createRectLayer({}) as any
    shattered.effects = [{ ...createEffect('shatter'), visible: true }]
    const handle = await frameSurface.mount(box, snapshotOf([shattered], {}))
    expect(box.querySelectorAll('canvas').length).toBe(1)
    handle.destroy()
  })
})

// C1: a still export paints once, so every outline font the snapshot carries (`outlineFont|<token>`)
// must be warm in getCompositorFont's cache before that paint — and one that fails must reject
// the mount (the runtime keeps the poster) rather than draw fillText without the effect.
describe('frame adapter — outline fonts (C1)', () => {
  const OUTLINE = { [assetKey('outlineFont', 'google:Inter@700')]: 'data:font/ttf;base64,AA' }

  it('warms every outline font in the snapshot before the first paint', async () => {
    const order: string[] = []
    vi.spyOn(textOutline, 'warmCompositorFont').mockImplementation(async (t) => { order.push(`warm ${t}`); return true })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => { order.push('paint'); return null })
    await expect(frameSurface.mount(document.createElement('div'), snapshotOf([createRectLayer({})], OUTLINE)))
      .rejects.toThrow('embed: no 2D context')
    expect(order).toEqual(['warm google:Inter@700', 'paint'])
  })

  it('rejects the mount when an outline font does not load, leaving nothing behind', async () => {
    vi.spyOn(textOutline, 'warmCompositorFont').mockResolvedValue(false)
    const box = document.createElement('div')
    document.body.appendChild(box)
    await expect(frameSurface.mount(box, snapshotOf([createRectLayer({})], OUTLINE)))
      .rejects.toThrow('embed: an outline font did not load')
    expect(box.querySelectorAll('canvas').length).toBe(0)
  })

  it('asks for no outline font when the snapshot carries none', async () => {
    const warm = vi.spyOn(textOutline, 'warmCompositorFont')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(frameSurface.mount(document.createElement('div'), snapshotOf([createRectLayer({})], {})))
      .rejects.toThrow('embed: no 2D context')
    expect(warm).not.toHaveBeenCalled()
  })
})
