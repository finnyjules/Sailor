import { describe, it, expect, vi } from 'vitest'
import { buildFrameSnapshot, computeNeedsOutlines, isBlocked, type FrameExportIO } from '~/lib/embed/frame/gather'
import { planFrameExport } from '~/lib/embed/frame/plan'
import { assetKey, type FrameVariant } from '~/lib/embed/frame/types'
import { makeFontSource } from '~/lib/embed/frame/appIO'
import { createTextLayer, createImageLayer, createRectLayer } from '~/composables/useCompositorLayers'
import { clipFrameKey } from '~/lib/compositor/clip'
import { createEffect } from '~/lib/compositor/effectStack'

const v = (layers: any[]): FrameVariant => ({
  width: 1000, height: 500, layers, stackOrder: layers.map(l => `l:${l.id}`), groups: [],
  background: null, post: [], motion: null, wiredTreatments: {},
})

function fakeIO(over: Partial<FrameExportIO> = {}): FrameExportIO {
  return {
    fetchBlob: vi.fn(async (url: string) => new Blob([url])),
    blobToImage: vi.fn(async () => ({ width: 10, height: 10 } as any)),
    imageToDataUrl: vi.fn(async (_i, maxPx, mime) => `data:${mime};base64,IMG${maxPx}`),
    blobToDataUrl: vi.fn(async () => 'data:image/png;base64,RAW'),
    blobToBase64: vi.fn(async () => 'RkFMTA=='),
    subsetFont: vi.fn(async () => 'U1VC'),
    fontSource: vi.fn((family: string, weight: number) => ({ url: `/f/${family}/${weight}`, origin: 'google' as const, weight })),
    wiredStill: vi.fn(() => ({ width: 4, height: 4 } as any)),
    depthImage: vi.fn(() => null),
    shaderDefs: vi.fn(() => []),
    ...over,
  }
}
const plan = (layers: any[]) => planFrameExport({
  variant: v(layers), fit: 'fit', wiredSlots: [], catalogIds: new Set(), hasMotion: false, animatedFill: false,
})

describe('buildFrameSnapshot', () => {
  it('inlines each image under its asset key, re-encoded at the planned size', async () => {
    const img = createImageLayer('photo.png', 1, { w: 0.4, h: 0.4 })
    const snap = await buildFrameSnapshot(plan([img]), v([img]), fakeIO())
    expect(snap.assets.urls[assetKey('image', 'photo.png')]).toBe('data:image/webp;base64,IMG800')
    expect(isBlocked(snap)).toBe(false)
  })

  it('a failed image blocks the export and names the file', async () => {
    const img = createImageLayer('gone.png', 1, {})
    const io = fakeIO({ fetchBlob: vi.fn(async () => { throw new Error('404') }) })
    const snap = await buildFrameSnapshot(plan([img]), v([img]), io)
    expect(isBlocked(snap)).toBe(true)
    expect(snap.notices.find(n => n.group === 'blocked')?.text).toBe('The image "gone.png" couldn\'t be loaded.')
  })

  // R12: a stand-in's file is optional. Fetched, it is inlined like any image; unreachable, it is
  // stored as an undecodable `data:,` (the painter then draws the grey stand-in box, as the editor
  // does after a 404) and the export is NOT blocked. A plain image that fails still blocks (above).
  it('a stand-in\'s file is inlined when it loads, and stored undecodable without blocking when it does not', async () => {
    const ok = createImageLayer('here.png', 1, { standIn: true, w: 0.4, h: 0.4 } as any)
    const gone = createImageLayer('gone.png', 1, { standIn: true, w: 0.4, h: 0.4 } as any)
    const io = fakeIO({ fetchBlob: vi.fn(async (url: string) => { if (url.includes('gone.png')) throw new Error('404'); return new Blob([url]) }) })
    const snap = await buildFrameSnapshot(plan([ok, gone]), v([ok, gone]), io)
    expect(snap.assets.urls[assetKey('image', 'here.png')]).toBe('data:image/webp;base64,IMG800')
    expect(snap.assets.urls[assetKey('image', 'gone.png')]).toBe('data:,')
    expect(isBlocked(snap)).toBe(false)
  })

  it('every clip frame is inlined and the clip\'s weight is stated', async () => {
    const img = createImageLayer('rose.png', 1, { w: 0.2, h: 0.2 })
    const clip = { dir: 'c1', frames: 3, fps: 24, speed: 1, prompt: '', model: '' }
    ;(img as any).clip = clip
    const snap = await buildFrameSnapshot(plan([img]), v([img]), fakeIO())
    for (let i = 0; i < 3; i++) expect(snap.assets.urls[assetKey('clipFrame', clipFrameKey(clip, i))]).toMatch(/^data:image\/webp/)
    expect(snap.notices.find(n => n.group === 'live')?.text).toMatch(/^Image clip · adds \d+(\.\d)? (KB|MB)$/)
  })

  it('fonts are subsetted, inlined as faces, and listed by name', async () => {
    const t = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 700 })
    const io = fakeIO()
    const snap = await buildFrameSnapshot(plan([t]), v([t]), io)
    expect(io.subsetFont).toHaveBeenCalledWith('RkFMTA==', 'Hi')
    expect(snap.assets.fonts).toEqual([{ family: 'Inter', weight: 700, dataUrl: 'data:font/ttf;base64,U1VC', origin: 'google' }])
    expect(snap.notices).toContainEqual({ group: 'fonts', text: 'Inter · Google' })
  })

  it('a failed subset falls back to the whole font', async () => {
    const t = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 700 })
    const snap = await buildFrameSnapshot(plan([t]), v([t]), fakeIO({ subsetFont: vi.fn(async () => null) }))
    expect(snap.assets.fonts[0]!.dataUrl).toBe('data:font/ttf;base64,RkFMTA==')
  })

  it('a system family needs nothing and says nothing', async () => {
    const t = createTextLayer({ text: 'Hi', fontFamily: 'Helvetica', fontWeight: 400 })
    const snap = await buildFrameSnapshot(plan([t]), v([t]), fakeIO({ fontSource: vi.fn(() => null) }))
    expect(snap.assets.fonts).toEqual([])
    expect(snap.notices.filter(n => n.group === 'fonts')).toEqual([])
  })

  it('a font that cannot be fetched blocks the export', async () => {
    const t = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 700 })
    const io = fakeIO({ fetchBlob: vi.fn(async () => { throw new Error('offline') }) })
    const snap = await buildFrameSnapshot(plan([t]), v([t]), io)
    expect(snap.notices.find(n => n.group === 'blocked')?.text)
      .toBe('The font "Inter" couldn\'t be loaded, so the export would draw the wrong typeface.')
  })

  it('one variable file serves every weight of its family once', async () => {
    const a = createTextLayer({ text: 'A', fontFamily: 'Inter', fontWeight: 300 })
    const b = createTextLayer({ text: 'B', fontFamily: 'Inter', fontWeight: 800 })
    const io = fakeIO({ fontSource: vi.fn(() => ({ url: '/f/inter-var', origin: 'variable' as const, weight: [100, 900] as const })) })
    const snap = await buildFrameSnapshot(plan([a, b]), v([a, b]), io)
    expect(snap.assets.fonts).toHaveLength(1)
    expect(snap.assets.fonts[0]!.weight).toEqual([100, 900])
    expect(io.subsetFont).toHaveBeenCalledWith('RkFMTA==', 'AB')
  })

  it('outlined text also gets its outline bytes under the Vector Type token', async () => {
    const t = createTextLayer({ text: 'Out', fontFamily: 'Inter', fontWeight: 700 })
    ;(t as any).renderAsOutline = true
    const snap = await buildFrameSnapshot(plan([t]), v([t]), fakeIO())
    expect(Object.keys(snap.assets.urls).some(k => k.startsWith('outlineFont|'))).toBe(true)
  })

  it('wired stills are captured', async () => {
    const w = { kind: 'wired', id: 'w1', slot: 2, w: 0.5, lastAspect: 1, x: 0.5, y: 0.5 } as any
    const snap = await buildFrameSnapshot(plan([w]), v([w]), fakeIO())
    expect(snap.wired[2]).toEqual({ kind: 'still', dataUrl: 'data:image/webp;base64,IMG1000' })
  })

  it('a depth map the editor has cached ships; a missing one is named as left out', async () => {
    const img = createImageLayer('p.png', 1, {})
    ;(img as any).effects = [{ ...createEffect('dof'), visible: true }]
    const missing = await buildFrameSnapshot(plan([img]), v([img]), fakeIO())
    expect(missing.notices).toContainEqual({ group: 'leftOut', text: 'Depth blur on Image · needs a depth map', layerId: img.id })
    const cached = await buildFrameSnapshot(plan([img]), v([img]), fakeIO({ depthImage: vi.fn(() => ({ width: 2, height: 2 } as any)) }))
    expect(cached.assets.depth).toEqual([{ ref: 'p.png', dataUrl: 'data:image/png;base64,IMG4096' }])
  })

  it('shader definitions and their textures are inlined', async () => {
    const io = fakeIO({ shaderDefs: vi.fn(() => [{ id: 'fx', textures: [{ uniform: 'u_atlas', file: 'atlas.png', v: '3' }] } as any]) })
    const p = plan([]); p.shaderIds = ['fx']
    const snap = await buildFrameSnapshot(p, v([]), io)
    expect(snap.assets.shaders.map(d => d.id)).toEqual(['fx'])
    expect(snap.assets.urls[assetKey('shaderTexture', 'atlas.png@3')]).toBe('data:image/png;base64,RAW')
  })

  it('a planned shader the catalog lacks blocks the export', async () => {
    const p = plan([]); p.shaderIds = ['nope']
    const snap = await buildFrameSnapshot(p, v([]), fakeIO())
    expect(isBlocked(snap)).toBe(true)
  })
})

describe('makeFontSource', () => {
  it('an uploaded family wins and uses its nearest stored weight', () => {
    const src = makeFontSource([{ family: 'Brand', slug: 'brand', weights: { '400': 'b4.otf', '700': 'b7.otf' } }])
    expect(src('Brand', 600)).toEqual({ url: '/api/template-fonts/file/b7.otf', origin: 'uploaded', weight: 700 })
    expect(src('Brand', 400)).toEqual({ url: '/api/template-fonts/file/b4.otf', origin: 'uploaded', weight: 400 })
  })

  it('a system family has no source', () => {
    expect(makeFontSource([])('Helvetica', 400)).toBeNull()
  })

  it('a curated variable family is one file across its weight axis', () => {
    const s = makeFontSource([])('Inter', 700)!
    expect(s.origin).toBe('variable')
    expect(Array.isArray(s.weight)).toBe(true)
  })

  it('anything else is a Google static cut at that weight', () => {
    expect(makeFontSource([])('Lobster', 400)).toEqual({ url: '/api/fonts/google-file?family=Lobster&weight=400', origin: 'google', weight: 400 })
  })
})

// Task 10: FrameSnapshot.needsOutlines picks between frame.js (paper.js + fontkit) and
// frame-lean.js (neither) — see bundleNameFor('frame', snap) in surfaces.ts. Most Frames — plain
// text, no F3 boolean/shatter/morph — need neither, so false is the common case.
describe('computeNeedsOutlines', () => {
  it('is false for a plain Frame — no outlined text, no paper-backed geometry', () => {
    const t = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 400 })
    const r = createRectLayer({})
    expect(computeNeedsOutlines(plan([t, r]), v([t, r]))).toBe(false)
  })

  it('is true when a plan font needs outline bytes', () => {
    const t = createTextLayer({ text: 'Out', fontFamily: 'Inter', fontWeight: 700 })
    ;(t as any).renderAsOutline = true
    expect(computeNeedsOutlines(plan([t]), v([t]))).toBe(true)
  })

  it('is true when a layer carries a visible boolean effect', () => {
    const r = createRectLayer({})
    ;(r as any).effects = [{ ...createEffect('boolean'), visible: true }]
    expect(computeNeedsOutlines(plan([r]), v([r]))).toBe(true)
  })

  it('is true when a layer carries a visible shatter effect', () => {
    const r = createRectLayer({})
    ;(r as any).effects = [{ ...createEffect('shatter'), visible: true }]
    expect(computeNeedsOutlines(plan([r]), v([r]))).toBe(true)
  })

  it('is true when a layer carries a visible morph effect', () => {
    const r = createRectLayer({})
    ;(r as any).effects = [{ ...createEffect('morph'), visible: true }]
    expect(computeNeedsOutlines(plan([r]), v([r]))).toBe(true)
  })

  // R14f: an INVISIBLE boolean/shatter/morph STILL forces the full bundle — the stored `visible`
  // flag is not trustworthy at export-plan time. Motion (motionx) can write an arbitrary value
  // onto `effects.<id>.visible` via a generic apply path (~/lib/motionx/adapter/frame.ts's
  // `effects.<id>.<dial>` branch has no dial allowlist), and while `PropertyValue` excludes
  // `boolean` — so it can never write the literal `false` a "hidden" check tests for — it COULD
  // push a stored `visible: false` to some non-`false` value, which every `!== false` visibility
  // check in this codebase then reads as visible. Counting presence, not visibility, closes that
  // gap without depending on whether such a track could really be authored today.
  for (const kind of ['boolean', 'shatter', 'morph'] as const) {
    it(`an invisible ${kind} effect still forces the full bundle (visible is not trustworthy — R14f)`, () => {
      const r = createRectLayer({})
      ;(r as any).effects = [{ ...createEffect(kind), visible: false }]
      expect(computeNeedsOutlines(plan([r]), v([r]))).toBe(true)
    })
  }

  // R14f, the text half: ANY geometry effect on a TEXT layer forces outline mode (fontkit) when
  // visible — see `textDrawsFromOutlines`/`layerGeometryEffects` (useCompositorLayers.ts) — so
  // this function independently re-checks for one regardless of `visible` too, same reasoning as
  // above. `trim` never touches paper, but it still needs fontkit's outline path on text.
  it('an invisible non-paper geometry effect on TEXT still forces the full bundle (fontkit, not paper)', () => {
    const t = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 400 })
    ;(t as any).effects = [{ ...createEffect('trim'), visible: false }]
    expect(computeNeedsOutlines(plan([t]), v([t]))).toBe(true)
  })

  // The same effect on a NON-text layer (a rect) never needs outline mode — trim/offset/etc. are
  // ordinary SVG-path transforms the painter can apply without fontkit or paper.
  it('a geometry effect that never touches paper, on a non-text layer, does not force the full bundle', () => {
    const r = createRectLayer({})
    ;(r as any).effects = [{ ...createEffect('trim'), visible: true }]
    expect(computeNeedsOutlines(plan([r]), v([r]))).toBe(false)
  })

  it('buildFrameSnapshot carries needsOutlines through onto the snapshot', async () => {
    const t = createTextLayer({ text: 'Out', fontFamily: 'Inter', fontWeight: 700 })
    ;(t as any).renderAsOutline = true
    const snap = await buildFrameSnapshot(plan([t]), v([t]), fakeIO())
    expect(snap.needsOutlines).toBe(true)
  })
})
