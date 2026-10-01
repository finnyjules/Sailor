import { describe, it, expect, vi } from 'vitest'
import { buildFrameSnapshot, computeNeedsOutlines, formatBytes, isBlocked, type FrameExportIO } from '~/lib/embed/frame/gather'
import { outlinePartnerIds, planFrameExport } from '~/lib/embed/frame/plan'
import { assetKey, type FrameVariant } from '~/lib/embed/frame/types'
import { frameNeedsFullBundle } from '~/lib/embed/frame/needs'
import { createAppFrameExportIO, makeFontSource } from '~/lib/embed/frame/appIO'
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
    wiredFrames: vi.fn(async () => ({ frames: [], failures: [] })),
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
    expect(snap.notices.find(n => n.group === 'blocked')?.text).toBe('A shader this Frame uses isn’t available. Open Shader studio once, then export again.')
  })

  it('a missing My effect says it is gone (by its own name when known), not "open a studio"', async () => {
    const p = plan([]); p.shaderIds = ['mine_aaaaaaaaaaaa~v2']
    const named = await buildFrameSnapshot(p, v([]), fakeIO({ shaderName: () => 'Ink bloom' }))
    expect(isBlocked(named)).toBe(true)
    expect(named.notices.find(n => n.group === 'blocked')?.text)
      .toBe('“Ink bloom” isn’t in My effects any more, so it can’t be exported. Pick another effect for this layer.')
    const p2 = plan([]); p2.shaderIds = ['mine_aaaaaaaaaaaa']
    const unnamed = await buildFrameSnapshot(p2, v([]), fakeIO())
    expect(unnamed.notices.find(n => n.group === 'blocked')?.text)
      .toBe('One of the effects this Frame uses isn’t in My effects any more, so it can’t be exported. Pick another effect for this layer.')
    for (const snap of [named, unnamed]) expect(snap.notices.find(n => n.group === 'blocked')!.text).not.toMatch(/mine_|Shader Studio/)
  })

  it('the app’s IO names a My effect from the library by any of its ids', async () => {
    const lib = await import('~/lib/myEffects/library')
    lib.setMyEffectRecord({ id: 'mine_aaaaaaaaaaaa', name: 'Ink bloom' } as any)
    const io = createAppFrameExportIO({ catalog: [] } as any)
    expect(io.shaderName!('mine_aaaaaaaaaaaa~v1')).toBe('Ink bloom')
    expect(io.shaderName!('water_ripple')).toBeNull()
    lib.setMyEffectRecord(null, 'mine_aaaaaaaaaaaa')
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

  // Frame Morph (final review #1): a text layer at either end of a Motion "Morph into" is
  // outlined by the painter's `resolveMorphs` even though it draws itself with fillText — without
  // its outline font the lean bundle would turn the morph into a cross-fade.
  describe('a Motion "Morph into" transition', () => {
    const morphVariant = (layers: any[], behaviours: any[]): FrameVariant => ({
      ...v(layers), motion: { fps: 30, duration: 3, behaviours } as any,
    })
    const planOf = (variant: FrameVariant) => planFrameExport({
      variant, fit: 'fit', wiredSlots: [], catalogIds: new Set(), hasMotion: true, animatedFill: false,
    })
    const morph = (from: string, to?: string) => ({
      id: 'b1', kind: 'morph', layerId: from, timing: { start: 1, duration: 0.8 },
      params: { style: 'letters', ...(to ? { target: `l:${to}` } : {}) },
    })

    it('forces outlines when its SOURCE is a text layer (target a shape)', () => {
      const t = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 400 })
      const r = createRectLayer({})
      const variant = morphVariant([t, r], [morph(t.id, r.id)])
      expect(computeNeedsOutlines(planOf(variant), variant)).toBe(true)
      // …and through BOTH halves of the rule, not just the second check: the plan's own font
      // carries `outline`, so its outline bytes ship.
      expect(planOf(variant).fonts.find(f => f.family === 'Inter')?.outline).toBe(true)
      // The layer-only half alone (no plan font flag) still says yes.
      expect(computeNeedsOutlines({ fonts: [] }, variant)).toBe(true)
    })

    it('forces outlines when its TARGET is a text layer (source a shape)', () => {
      const t = createTextLayer({ text: 'Yo', fontFamily: 'Inter', fontWeight: 700 })
      const r = createRectLayer({})
      const variant = morphVariant([r, t], [morph(r.id, t.id)])
      expect(computeNeedsOutlines({ fonts: [] }, variant)).toBe(true)
      expect(planOf(variant).fonts.find(f => f.family === 'Inter')?.outline).toBe(true)
    })

    it('does not force outlines for a shape-to-shape morph, or with no morph at all', () => {
      const t = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 400 })
      const a = createRectLayer({}), b = createRectLayer({})
      const shapes = morphVariant([t, a, b], [morph(a.id, b.id)])
      expect(computeNeedsOutlines(planOf(shapes), shapes)).toBe(false)
      const none = morphVariant([t, a], [])
      expect(computeNeedsOutlines(planOf(none), none)).toBe(false)
    })
  })

  // Pixel reveal: a bar that splits text into words, letters or lines takes its pieces from the
  // text's outline font, so that font must ship (and the full bundle with it) — the lean
  // bundle's stand-in has no font and would play every bar as one whole piece.
  describe('a Motion Pixel reveal bar', () => {
    const revealVariant = (layers: any[], behaviours: any[]): FrameVariant => ({
      ...v(layers), motion: { fps: 30, duration: 3, behaviours } as any,
    })
    const planOf = (variant: FrameVariant) => planFrameExport({
      variant, fit: 'fit', wiredSlots: [], catalogIds: new Set(), hasMotion: true, animatedFill: false,
    })
    const bar = (layerId: string, params: Record<string, unknown>) => ({
      id: 'b1', kind: 'pixelreveal', layerId, timing: { start: 0, duration: 1 }, params: { dir: 'in', ...params },
    })

    it('ships the outline font for a text layer it splits into words', () => {
      const t = createTextLayer({ text: 'Two words', fontFamily: 'Inter', fontWeight: 400 })
      const variant = revealVariant([t], [bar(t.id, { look: 'materialize', pieces: 'words' })])
      expect(outlinePartnerIds(variant.layers, variant.motion!.behaviours as any).has(t.id)).toBe(true)
      expect(planOf(variant).fonts.find(f => f.family === 'Inter')?.outline).toBe(true)
      expect(computeNeedsOutlines({ fonts: [] }, variant)).toBe(true)
    })

    it('counts a look whose own default splits the text, with no pieces stored', () => {
      const t = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 400 })
      const variant = revealVariant([t], [bar(t.id, { look: 'materialize' })])
      expect(outlinePartnerIds(variant.layers, variant.motion!.behaviours as any).has(t.id)).toBe(true)
    })

    it('does not ask for outlines when the bar keeps the text whole, or sits on a shape', () => {
      const t = createTextLayer({ text: 'Hi', fontFamily: 'Inter', fontWeight: 400 })
      const r = createRectLayer({})
      const whole = revealVariant([t], [bar(t.id, { look: 'materialize', pieces: 'whole' })])
      expect(outlinePartnerIds(whole.layers, whole.motion!.behaviours as any).has(t.id)).toBe(false)
      expect(computeNeedsOutlines(planOf(whole), whole)).toBe(false)
      const shape = revealVariant([t, r], [bar(r.id, { look: 'materialize', pieces: 'words' })])
      expect(computeNeedsOutlines(planOf(shape), shape)).toBe(false)
    })
  })

  it('buildFrameSnapshot carries needsOutlines through onto the snapshot', async () => {
    const t = createTextLayer({ text: 'Out', fontFamily: 'Inter', fontWeight: 700 })
    ;(t as any).renderAsOutline = true
    const snap = await buildFrameSnapshot(plan([t]), v([t]), fakeIO())
    expect(snap.needsOutlines).toBe(true)
  })
})

// Task 2 (live wired layers): an animated wired slot whose studio can play live carries that
// studio's own embed player instead of pre-rendered frames. Anything else keeps the frames path.
describe('buildFrameSnapshot — a wired slot that plays live', () => {
  const wiredLayer = (id: string, slot: number) =>
    ({ kind: 'wired', id, slot, w: 0.5, lastAspect: 0.5, x: 0.5, y: 0.5, rotation: 0, opacity: 1 }) as any
  const gradientEmbed = (seed = 1) => ({
    surface: 'gradient', bundle: 'gradient', config: { cfg: { seed, layers: [{}] }, duration: 4 },
    width: 1080, height: 608, duration: 4,
  })
  const configBytes = (c: unknown) => new TextEncoder().encode(JSON.stringify(c)).length
  const livePlan = (layers: any[], slots: { slot: number; layerId: string; label: string }[], extra: Record<string, unknown> = {}) =>
    planFrameExport({
      variant: v(layers), fit: 'fit', catalogIds: new Set(), hasMotion: false, animatedFill: false,
      wiredSlots: slots.map(s => ({ ...s, animated: true, fps: 30, duration: 4 })), ...extra,
    })

  it('carries the player and its config, pulls no frames, and says what it adds', async () => {
    const w = wiredLayer('w1', 0)
    const p = livePlan([w], [{ slot: 0, layerId: 'w1', label: 'Gradient' }])
    const embed = gradientEmbed()
    const io = fakeIO({ wiredEmbed: vi.fn(async () => embed), bundleBytes: vi.fn(async () => 300_000) })
    const snap = await buildFrameSnapshot(p, v([w]), io)
    expect(io.wiredEmbed).toHaveBeenCalledWith(0)
    expect(io.wiredFrames).not.toHaveBeenCalled()
    expect(io.bundleBytes).toHaveBeenCalledWith('gradient')
    expect(snap.wired[0]).toEqual({ kind: 'live', ...embed })
    const bytes = 300_000 + configBytes(embed.config)
    expect(snap.notices).toContainEqual({ group: 'live', text: `Gradient · plays live · adds ${formatBytes(bytes)}`, layerId: 'w1', bytes })
    expect(snap.notices.some(n => n.text.includes('pre-rendered'))).toBe(false)
    expect(isBlocked(snap)).toBe(false)
  })

  it('a source that cannot play live, or fails to say, keeps the pre-rendered frames — no block', async () => {
    const w = wiredLayer('w1', 0)
    const p = livePlan([w], [{ slot: 0, layerId: 'w1', label: 'Gradient' }])
    const frames = ['data:image/webp;base64,AAAA']
    for (const wiredEmbed of [vi.fn(async () => null), vi.fn(async () => { throw new Error('no') })]) {
      const io = fakeIO({ wiredEmbed, bundleBytes: vi.fn(async () => 300_000), wiredFrames: vi.fn(async () => ({ frames: Array(120).fill(frames[0]), failures: [] })) })
      const snap = await buildFrameSnapshot(p, v([w]), io)
      expect(io.wiredFrames).toHaveBeenCalledTimes(1)
      expect(snap.wired[0]?.kind).toBe('clip')
      expect(snap.notices.find(n => n.layerId === 'w1')!.text).toMatch(/^Gradient · pre-rendered · 120 frames · adds /)
      expect(isBlocked(snap)).toBe(false)
    }
  })

  it('a player whose bundle cannot be measured keeps the pre-rendered frames', async () => {
    const w = wiredLayer('w1', 0)
    const p = livePlan([w], [{ slot: 0, layerId: 'w1', label: 'Gradient' }])
    const io = fakeIO({
      wiredEmbed: vi.fn(async () => gradientEmbed()), bundleBytes: vi.fn(async () => { throw new Error('404') }),
      wiredFrames: vi.fn(async () => ({ frames: Array(120).fill('data:image/webp;base64,AAAA'), failures: [] })),
    })
    const snap = await buildFrameSnapshot(p, v([w]), io)
    expect(snap.wired[0]?.kind).toBe('clip')
    expect(isBlocked(snap)).toBe(false)
  })

  it('an IO without the live route (no wiredEmbed, or no bundleBytes) is today\'s frames path', async () => {
    const w = wiredLayer('w1', 0)
    const p = livePlan([w], [{ slot: 0, layerId: 'w1', label: 'Gradient' }])
    const frames = vi.fn(async () => ({ frames: Array(120).fill('data:image/webp;base64,AAAA'), failures: [] }))
    const noBytes = fakeIO({ wiredEmbed: vi.fn(async () => gradientEmbed()), wiredFrames: frames })
    expect((await buildFrameSnapshot(p, v([w]), noBytes)).wired[0]?.kind).toBe('clip')
    expect(noBytes.wiredEmbed).not.toHaveBeenCalled()
    expect((await buildFrameSnapshot(p, v([w]), fakeIO({ wiredFrames: frames }))).wired[0]?.kind).toBe('clip')
  })

  it('two slots on one player: the second counts only its config', async () => {
    const a = wiredLayer('w1', 0), b = wiredLayer('w2', 1)
    const p = livePlan([a, b], [{ slot: 0, layerId: 'w1', label: 'Gradient' }, { slot: 1, layerId: 'w2', label: 'Layer 2' }])
    const embeds = [gradientEmbed(1), gradientEmbed(22)]
    const io = fakeIO({ wiredEmbed: vi.fn(async (slot: number) => embeds[slot]!), bundleBytes: vi.fn(async () => 300_000) })
    const snap = await buildFrameSnapshot(p, v([a, b]), io)
    expect(snap.wired[0]).toEqual({ kind: 'live', ...embeds[0] })
    expect(snap.wired[1]).toEqual({ kind: 'live', ...embeds[1] })
    const first = 300_000 + configBytes(embeds[0]!.config), second = configBytes(embeds[1]!.config)
    expect(snap.notices).toContainEqual({ group: 'live', text: `Gradient · plays live · adds ${formatBytes(first)}`, layerId: 'w1', bytes: first })
    expect(snap.notices).toContainEqual({ group: 'live', text: `Layer 2 · plays live · adds ${formatBytes(second)}`, layerId: 'w2', bytes: second })
  })

  it('the Frame\'s loop is the plan\'s, whichever route a slot takes', async () => {
    const w = wiredLayer('w1', 0)
    const p = planFrameExport({
      variant: v([w]), fit: 'fit', catalogIds: new Set(), hasMotion: false, animatedFill: false,
      wiredSlots: [{ slot: 0, layerId: 'w1', label: 'Gradient', animated: true, fps: 30, duration: 3 }],
    })
    const live = await buildFrameSnapshot(p, v([w]), fakeIO({
      wiredEmbed: vi.fn(async () => ({ ...gradientEmbed(), duration: 3 })), bundleBytes: vi.fn(async () => 1),
    }))
    expect(p.duration).toBe(3)
    expect(live.duration).toBe(3)
    expect(live.still).toBe(false)
  })
})

describe('createAppFrameExportIO — the live route', () => {
  it('passes wiredEmbed through, and measures each bundle once, in bytes, from the file export.ts inlines', async () => {
    const fetch = vi.fn(async (url: string) => (url.includes('missing')
      ? new Response('', { status: 404 })
      : new Response('é'.repeat(10))))   // 10 characters, 20 bytes
    vi.stubGlobal('fetch', fetch)
    try {
      const wiredEmbed = vi.fn(async () => null)
      const io = createAppFrameExportIO({ uploaded: [], wiredStill: () => null, catalog: [], wiredEmbed })
      expect(io.wiredEmbed).toBe(wiredEmbed)
      expect(await io.bundleBytes!('gradient')).toBe(20)
      expect(await io.bundleBytes!('gradient')).toBe(20)
      expect(fetch.mock.calls.map(c => c[0])).toEqual(['/embed/gradient.js'])
      await expect(io.bundleBytes!('missing')).rejects.toThrow('404')
      await expect(io.bundleBytes!('missing')).rejects.toThrow('404')
      expect(fetch).toHaveBeenCalledTimes(3)   // a failure is not remembered as a size
      expect(createAppFrameExportIO({ uploaded: [], wiredStill: () => null, catalog: [] }).wiredEmbed).toBeUndefined()
    } finally { vi.unstubAllGlobals() }
  })

  it('a live layer\'s check (bundleText) and its size on the sheet share one fetch of the bundle', async () => {
    const fetch = vi.fn(async () => new Response('window.__SAILOR_SURFACE__ = {}'))
    vi.stubGlobal('fetch', fetch)
    try {
      const io = createAppFrameExportIO({ uploaded: [], wiredStill: () => null, catalog: [] })
      expect(await io.bundleText('spacetype-field')).toBe('window.__SAILOR_SURFACE__ = {}')
      expect(await io.bundleBytes!('spacetype-field')).toBe(30)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally { vi.unstubAllGlobals() }
  })
})

// Light layers final review: frame-lean.js also stubs brush tips, Pixel reveal and Relight, so a
// Frame using any of them takes the full bundle (folded into needsOutlines by buildFrameSnapshot).
describe('frameNeedsFullBundle', () => {
  it('is null for a plain Frame (and for a brush with only legacy stamps)', () => {
    const r = createRectLayer({})
    const legacyBrush = { id: 'b', kind: 'brush', strokes: [{ pts: [0, 0], size: 0.01 }] }
    expect(frameNeedsFullBundle([r, legacyBrush])).toBeNull()
  })
  it('names brush tips, Pixel reveal and Relight (Relight even hidden)', () => {
    expect(frameNeedsFullBundle([{ id: 'b', kind: 'brush', strokes: [{ tip: 'spray', pts: [] }] }])).toBe('brush tips')
    expect(frameNeedsFullBundle([createRectLayer({})], [{ kind: 'pixelreveal' }])).toBe('Pixel reveal')
    const img = createImageLayer('a.png')
    ;(img as any).effects = [{ ...createEffect('relight'), visible: false }]
    expect(frameNeedsFullBundle([img])).toBe('Relight')
  })
  it('a Shape morph between two shapes (no text partner) is not an outline need, but still takes the full bundle', () => {
    const a = createRectLayer({}), b = createRectLayer({})
    const behaviours = [{ id: 'm', kind: 'morph', layerId: a.id, params: { style: 'shape', target: `l:${b.id}` } }]
    expect(computeNeedsOutlines(plan([a, b]), { layers: [a, b], motion: { behaviours } } as any)).toBe(false)
    expect(frameNeedsFullBundle([a, b], behaviours)).toBe('Morph')
    expect(frameNeedsFullBundle([a, b], [{ ...behaviours[0], params: { style: 'letters', target: `l:${b.id}` } }])).toBe('Morph')
  })
})
