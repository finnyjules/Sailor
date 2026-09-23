// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import frameSurface from '~/lib/embed/surfaces/frame'
import { assetKey, type FrameSnapshot, type FrameVariant } from '~/lib/embed/frame/types'
import { clipFrameKey } from '~/lib/compositor/clip'
import { createImageLayer, createRectLayer } from '~/composables/useCompositorLayers'

function snapshotOf(layers: any[], urls: Record<string, string>): FrameSnapshot {
  const v: FrameVariant = {
    width: 100, height: 50, layers, stackOrder: layers.map(l => `l:${l.id}`), groups: [],
    background: '#000000', post: [], motion: null, wiredTreatments: {},
  }
  return {
    version: 1, fit: 'fit', duration: 1, still: true, variants: [v],
    assets: { urls, fonts: [], shaders: [], depth: [] }, wired: {}, notices: [],
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
