/**
 * The Scatter element: thrown marks as ONE self-painting layer, added from the
 * toolbar's Shapes menu beside Mosaic and tuned in the inspector. Internally it is
 * the `scatter` layer kind; its Style picks which generator paints it (Chaff, Strand
 * and Husk).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TOOLBAR_SHAPES, resolveShapeFace, shapeFaceLabel } from '~/lib/compositor/toolbarMenus'
import {
  SCATTER_STYLES, SCATTER_STYLE_LABELS, DEFAULT_SCATTER_STYLE, scatterStyleRow,
  isScatterStyle, scatterStyleOf, scatterLabelOf, scatterStyleOfLabel, scatterStyleFromArgs,
  scatterParams, scatterStylePatch, scatterSeedPatch, freshScatterSeed, paintScatter,
} from '~/lib/compositor/scatter'
import {
  createScatterLayer, newScatterLayer, layerPaints, type ScatterLayer,
} from '~/composables/useCompositorLayers'
import { defaultChaff, normalizeChaff, CHAFF_PRESET_NAMES, CHAFF_PALETTE_PRESETS } from '~/lib/compositor/chaff'
import { defaultStrand, STRAND_PRESET_NAMES, STRAND_PALETTE_PRESETS } from '~/lib/compositor/strand'
import { defaultHusk, HUSK_PRESET_NAMES, HUSK_PALETTE_PRESETS } from '~/lib/compositor/husk'
import { applyCompositorCommand, describeCompositor, type CompositorState } from '~/lib/agent/surfaces/compositor'

// ── The Shapes menu ───────────────────────────────────────────────────────────
describe('Scatter in the Shapes menu', () => {
  it('is a row after Mosaic and before the library', () => {
    const ids = TOOLBAR_SHAPES.map(s => s.id)
    expect(ids).toContain('scatter')
    expect(ids.indexOf('scatter')).toBe(ids.indexOf('mosaic') + 1)
    expect(ids.indexOf('scatter')).toBe(ids.indexOf('library') - 1)
    expect(TOOLBAR_SHAPES.find(s => s.id === 'scatter')!.label).toBe('Scatter')
  })
  it('can be worn as the last-used face, titled "Add scatter" by the face button', () => {
    expect(resolveShapeFace('scatter')).toBe('scatter')
    expect('Add ' + shapeFaceLabel('scatter').toLowerCase()).toBe('Add scatter')
  })
})

// ── What the stamp creates ────────────────────────────────────────────────────
describe('newScatterLayer — what the stamp creates', () => {
  it('is a frame-filling scatter layer in the Chaff style', () => {
    const l = newScatterLayer(9 / 16)
    expect(l.kind).toBe('scatter')
    expect(l.style).toBe('chaff')
    expect(l).toMatchObject({ x: 0.5, y: 0.5, w: 1, h: 9 / 16, rotation: 0, opacity: 1 })
    expect(l.chaff).toEqual(defaultChaff())
    expect(l.seed).toBeGreaterThan(0)
  })
  it('a portrait frame gives h > 1; a bad aspect falls back to square', () => {
    expect(newScatterLayer(4 / 3).h).toBeCloseTo(4 / 3)
    expect(newScatterLayer(0).h).toBe(1)
    expect(newScatterLayer(Number.NaN).h).toBe(1)
  })
  it('two stamps are distinct layers', () => {
    expect(newScatterLayer(1).id).not.toBe(newScatterLayer(1).id)
  })
  it('the default style is chaff — the stamp and the agent create agree', () => {
    expect(DEFAULT_SCATTER_STYLE).toBe('chaff')
    expect(newScatterLayer(1).style).toBe(DEFAULT_SCATTER_STYLE)
  })
})

// ── The style registry ────────────────────────────────────────────────────────
describe('the Scatter style registry', () => {
  it('offers its styles in table order, in plain words', () => {
    expect(SCATTER_STYLES.map(r => r.id)).toContain('chaff')
    expect(SCATTER_STYLE_LABELS).toEqual(SCATTER_STYLES.map(r => r.label))
    expect(scatterLabelOf('chaff')).toBe('Chaff')
    expect(scatterStyleOfLabel('Chaff')).toBe('chaff')
    // An unknown label can never write an unknown style.
    expect(scatterStyleOfLabel('Nope')).toBe(DEFAULT_SCATTER_STYLE)
    expect(scatterStyleOf('bogus')).toBe(DEFAULT_SCATTER_STYLE)
    expect(isScatterStyle('chaff')).toBe(true)
    expect(isScatterStyle('bogus')).toBe(false)
  })

  it('every style is data + a paint function: dials, palettes, defaults, normalize', () => {
    for (const row of SCATTER_STYLES) {
      const d = row.defaults() as Record<string, unknown>
      expect(typeof row.paint).toBe('function')
      expect(row.controls.length).toBeGreaterThan(0)
      expect(row.presetNames.length).toBeGreaterThan(0)
      // Every declared control names a real param — a control the params don't carry
      // is a dead control (it would store a value nothing reads).
      for (const c of row.controls) {
        expect(Object.keys(d)).toContain(c.key)
        expect(c.label).toBeTruthy()
        if (c.kind === 'slider') { expect(c.max).toBeGreaterThan(c.min); expect(c.step).toBeGreaterThan(0) }
        else expect(c.options.length).toBeGreaterThan(1)
      }
      // …and every palette preset applies and reads back.
      for (const n of row.presetNames) {
        const p = row.normalize({ ...d, ...row.presetPatch(n) })
        expect(row.presetOf(p)).toBe(n)
      }
      // normalize is total: garbage in, the defaults out.
      expect(row.normalize(undefined)).toEqual(d)
      expect(row.normalize('nonsense')).toEqual(d)
    }
  })

  it('Chaff registers its own module\'s defaults, dials and palettes', () => {
    const row = scatterStyleRow('chaff')
    expect(row.defaults()).toEqual(defaultChaff())
    expect(row.presetNames).toEqual(CHAFF_PRESET_NAMES)
    expect(row.presetPatch('Night')).toEqual({ inks: [...CHAFF_PALETTE_PRESETS.Night.inks] })
    // The tool's own dial ranges reach the inspector through the registry.
    const count = row.controls.find(c => c.key === 'count')!
    expect(count.kind).toBe('slider')
    expect(count).toMatchObject({ min: 4, max: 400, step: 1 })
    const shape = row.controls.find(c => c.key === 'shape')!
    expect(shape.kind).toBe('select')
    expect((shape as { options: { value: string }[] }).options.map(o => o.value)).toEqual(['crescent', 'leaf', 'bar'])
  })

  it('Strand registers its own module\'s defaults, dials and palettes', () => {
    const row = scatterStyleRow('strand')
    expect(row.label).toBe('Strand')
    expect(row.defaults()).toEqual(defaultStrand())
    expect(row.presetNames).toEqual(STRAND_PRESET_NAMES)
    expect(row.presetPatch('Cobalt')).toEqual({ inks: [...STRAND_PALETTE_PRESETS.Cobalt.inks] })
    // The tool's own two whole-number dials reach the inspector through the registry.
    expect(row.controls.find(c => c.key === 'count')).toMatchObject({ kind: 'slider', label: 'Chains', min: 1, max: 40, step: 1 })
    expect(row.controls.find(c => c.key === 'len')).toMatchObject({ kind: 'slider', label: 'Length', min: 3, max: 90, step: 1 })
    const tex = row.controls.find(c => c.key === 'texKind')!
    expect(tex.kind).toBe('select')
    expect((tex as { options: { value: string }[] }).options.map(o => o.value)).toEqual(['stipple', 'drag', 'screen'])
    // Every dial the tool shows is on the row, none of them twice.
    const keys = row.controls.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(['count', 'len', 'wander', 'branch', 'thick', 'rod', 'notch', 'rough', 'offset', 'edge', 'texKind', 'tex', 'grain'])
  })

  it('Husk registers its own module\'s defaults, dials and palettes', () => {
    const row = scatterStyleRow('husk')
    expect(row.label).toBe('Husk')
    expect(row.defaults()).toEqual(defaultHusk())
    expect(row.presetNames).toEqual(HUSK_PRESET_NAMES)
    expect(row.presetPatch('Ember')).toEqual({ inks: [...HUSK_PALETTE_PRESETS.Ember.inks] })
    // The tool's own whole-number dial reaches the inspector through the registry.
    expect(row.controls.find(c => c.key === 'count')).toMatchObject({ kind: 'slider', label: 'Husks', min: 1, max: 70, step: 1 })
    const bite = row.controls.find(c => c.key === 'bite')!
    expect(bite.kind).toBe('select')
    expect((bite as { options: { value: string }[] }).options.map(o => o.value)).toEqual(['crumble', 'dots'])
    // Every dial the tool shows is on the row, in its order, none of them twice.
    const keys = row.controls.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(['count', 'size', 'vary', 'lump', 'bite', 'eat', 'tex', 'grain'])
  })

  it('an unknown style resolves to the default row rather than throwing', () => {
    expect(scatterStyleRow('bogus' as never).id).toBe(DEFAULT_SCATTER_STYLE)
  })
})

// ── Layer patches shared by the inspector and the agent ───────────────────────
describe('scatter layer patches', () => {
  const layer = (over: Partial<ScatterLayer> = {}) => createScatterLayer({ w: 1, h: 0.5625, ...over })

  it('createScatterLayer fills in every style\'s params so nothing paints blank', () => {
    const l = layer()
    expect(l.kind).toBe('scatter')
    expect(l.style).toBe(DEFAULT_SCATTER_STYLE)
    for (const row of SCATTER_STYLES) expect((l as Record<string, unknown>)[row.id]).toEqual(row.defaults())
  })

  it('a style hop seeds that style\'s params and leaves the box and the seed alone', () => {
    const l = layer({ seed: 123 })
    for (const row of SCATTER_STYLES) {
      const patch = scatterStylePatch(l, row.id)
      expect(patch.style).toBe(row.id)
      expect(patch).not.toHaveProperty('w')
      expect(patch).not.toHaveProperty('h')
      expect(patch).not.toHaveProperty('seed')
      // Params already on the layer are kept, not reset.
      const tuned = { ...row.defaults(), count: 7 }
      const keep = scatterStylePatch({ ...l, [row.id]: tuned } as ScatterLayer, row.id)
      expect((keep as Record<string, unknown>)[row.id]).toBe(tuned)
      // …and a layer missing them entirely gets that style's defaults.
      const bare = { ...l } as Record<string, unknown>
      delete bare[row.id]
      expect(scatterStylePatch(bare as unknown as ScatterLayer, row.id)[row.id as 'chaff']).toEqual(row.defaults())
    }
  })

  it('the seed patch is the whole variation, clamped to the app\'s 1..9999 range', () => {
    const l = layer({ seed: 3 })
    expect(scatterSeedPatch(l, 777)).toEqual({ seed: 777 })
    expect(scatterSeedPatch(l, 0).seed).toBe(1)
    expect(scatterSeedPatch(l, 12.6).seed).toBe(13)
    for (let i = 0; i < 40; i++) {
      const s = freshScatterSeed()
      expect(s).toBeGreaterThanOrEqual(1)
      expect(s).toBeLessThanOrEqual(9999)
      expect(Number.isInteger(s)).toBe(true)
    }
    expect(new Set(Array.from({ length: 30 }, freshScatterSeed)).size).toBeGreaterThan(1)
  })

  it('scatterParams normalizes what the layer actually carries — raw saves included', () => {
    expect(scatterParams(layer())).toEqual(defaultChaff())
    // A hand-edited / imported layer with a partial style object still paints.
    const raw = { ...layer(), chaff: { count: 1e9, shape: 'wobble' } } as unknown as ScatterLayer
    expect(scatterParams(raw)).toEqual(normalizeChaff({ count: 1e9, shape: 'wobble' }))
    // A layer with NO style object at all falls to that style's defaults.
    const bare = { ...layer() } as Record<string, unknown>
    delete bare.chaff
    expect(scatterParams(bare as unknown as ScatterLayer)).toEqual(defaultChaff())
  })

  it('survives a save/load round-trip through JSON', () => {
    const l = layer({ seed: 88 })
    ;(l.chaff as Record<string, unknown>).count = 120
    const back = JSON.parse(JSON.stringify(l)) as ScatterLayer
    expect(back).toEqual(l)
    expect(scatterParams(back).count).toBe(120)
    expect(back.style).toBe('chaff')
  })

  it('registers no Paint slots — a scatter paints itself, it has no authored fills', () => {
    expect(layerPaints(layer() as never)).toEqual([])
  })
})

// ── Painting ──────────────────────────────────────────────────────────────────
describe('drawing a scatter layer', () => {
  const drawImages: string[] = []
  const mainDraws: { x: number; y: number; w: number; h: number }[] = []
  const mainTranslates: [number, number][] = []
  const mainClips: { x: number; y: number; w: number; h: number }[][] = []
  let mainPathRects: { x: number; y: number; w: number; h: number }[] = []
  function recordingCtx(name: string) {
    const g = { addColorStop() {} }
    return {
      canvas: { width: 400, height: 400 },
      globalCompositeOperation: 'source-over', globalAlpha: 1,
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
      getTransform: () => ({ a: 1, b: 0 }), setTransform() {}, save() {}, restore() {},
      translate(dx = 0, dy = 0) { if (name === 'main') mainTranslates.push([dx, dy]) },
      rotate() {}, scale() {}, clip() { if (name === 'main') mainClips.push([...mainPathRects]) },
      beginPath() { if (name === 'main') mainPathRects = [] }, moveTo() {}, lineTo() {}, arc() {}, roundRect() {}, ellipse() {},
      rect(x = 0, y = 0, w = 0, h = 0) { if (name === 'main') mainPathRects.push({ x, y, w, h }) }, closePath() {}, setLineDash() {},
      fill() {}, stroke() {}, clearRect() {},
      fillRect() {},
      putImageData() {}, createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      getImageData(_x = 0, _y = 0, w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      createRadialGradient() { return g }, createLinearGradient() { return g }, createPattern() { return g },
      drawImage(_img: unknown, x = 0, y = 0, w = 0, h = 0) { if (name === 'main') { drawImages.push(name); mainDraws.push({ x, y, w, h }) } },
    } as unknown as CanvasRenderingContext2D
  }
  let seq = 0
  class FakeImageData {
    data: Uint8ClampedArray; width: number; height: number
    constructor(w: number, h: number) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(Math.max(1, w * h) * 4) }
  }
  beforeEach(() => {
    drawImages.length = 0; mainDraws.length = 0; mainTranslates.length = 0; mainClips.length = 0; mainPathRects = []; seq = 0
    vi.stubGlobal('ImageData', FakeImageData)
    vi.stubGlobal('document', { createElement: () => { const c: Record<string, unknown> = { width: 0, height: 0 }; c.getContext = () => recordingCtx(`off-${++seq}`); return c } })
  })
  afterEach(() => vi.unstubAllGlobals())

  async function drawScatter(layer: unknown, W: number, H: number) {
    const { drawLocalLayer } = await import('~/composables/useCompositorLayers')
    drawLocalLayer(recordingCtx('main'), layer as never, W, H)
  }
  const scatter = (over: Record<string, unknown> = {}) => ({
    id: 's1', kind: 'scatter', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 1, h: 1,
    seed: 9, style: 'chaff', chaff: defaultChaff(), ...over,
  })

  it('centres the box (boxH from WIDTH, not height), clips to it, and draws ONE sheet', async () => {
    // Pass H ≠ W so a `* H` regression is distinguishable from the correct `* W`.
    await drawScatter(scatter({ w: 1, h: 0.5 }), 400, 800)
    const boxW = 400, boxH = 200
    expect(mainTranslates.some(([dx, dy]) => Math.abs(dx + boxW / 2) < 1 && Math.abs(dy + boxH / 2) < 1)).toBe(true)
    expect(mainClips.some(rects => rects.some(r => r.x === 0 && r.y === 0 && r.w === boxW && r.h === boxH))).toBe(true)
    expect(mainDraws).toEqual([{ x: 0, y: 0, w: boxW, h: boxH }])
  })

  it('lets the layer\'s own opacity and blend through — the sheet never stomps them', async () => {
    // The shared LayerCommon machinery (paintLayer) puts the layer's opacity and blend
    // ON the ctx around the content draw; the scatter branch must not write either,
    // or a half-transparent multiplied scatter would come back opaque and normal.
    const ctx = recordingCtx('main')
    const { drawLocalLayer } = await import('~/composables/useCompositorLayers')
    drawLocalLayer(ctx, scatter({ opacity: 0.4, blend: 'multiply' }) as never, 400, 400)
    expect(ctx.globalAlpha).toBeCloseTo(0.4)
    expect(ctx.globalCompositeOperation).toBe('multiply')
  })

  it('paints a layer whose style params are missing entirely (an agent-made / hand-edited save)', async () => {
    const bare = scatter() as Record<string, unknown>
    delete bare.chaff
    await drawScatter(bare, 400, 400)
    expect(mainDraws).toHaveLength(1)
  })

  it('paintScatter routes to the layer\'s style row', async () => {
    const painted: string[] = []
    const row = scatterStyleRow('chaff')
    const spy = vi.spyOn(row, 'paint').mockImplementation(() => { painted.push('chaff') })
    paintScatter(recordingCtx('main') as never, scatter() as never, 400, 300)
    expect(painted).toEqual(['chaff'])
    expect(spy.mock.calls[0]!.slice(1)).toEqual([defaultChaff(), 400, 300, 9])
    spy.mockRestore()
  })
})

// ── The agent's `scatter` op ──────────────────────────────────────────────────
describe('agent scatter op', () => {
  const baseState = (extra: Partial<CompositorState> = {}): CompositorState => ({ layers: [], ...extra })
  const layerOf = (r: ReturnType<typeof applyCompositorCommand>) => (r as { template: { layers: Record<string, unknown>[] } }).template.layers[0]!

  it('create with no style is a frame-filling chaff scatter', () => {
    const r = applyCompositorCommand(baseState({ aspect: 9 / 16 }), { op: 'scatter', args: { id: 's' } })
    expect(r.ok).toBe(true)
    expect(layerOf(r)).toMatchObject({ id: 's', kind: 'scatter', style: 'chaff', w: 1, h: 9 / 16, x: 0.5, y: 0.5 })
    expect(layerOf(r).chaff).toEqual(defaultChaff())
  })

  it('takes the style\'s dials, a palette by name, and a seed', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'scatter',
      args: { id: 's', style: 'chaff', chaff: { count: 200, shape: 'bar' }, palettePreset: 'Pine', seed: 31 },
    })
    expect(r.ok).toBe(true)
    const l = layerOf(r)
    expect(l.seed).toBe(31)
    expect(l.chaff).toMatchObject({ count: 200, shape: 'bar', inks: [...CHAFF_PALETTE_PRESETS.Pine.inks] })
  })

  it('makes a Strand scatter, by name or from its dials alone', () => {
    const named = applyCompositorCommand(baseState(), {
      op: 'scatter',
      args: { id: 's', style: 'strand', strand: { count: 20, texKind: 'screen' }, palettePreset: 'Beacon', seed: 44 },
    })
    expect(named.ok).toBe(true)
    const l = layerOf(named)
    expect(l).toMatchObject({ style: 'strand', seed: 44 })
    expect(l.strand).toMatchObject({ count: 20, texKind: 'screen', inks: [...STRAND_PALETTE_PRESETS.Beacon.inks] })
    // A tunables object on its own is enough to say which style is meant.
    const implied = applyCompositorCommand(baseState(), { op: 'scatter', args: { id: 't', strand: { wander: 1 } } })
    expect(implied.ok).toBe(true)
    expect(layerOf(implied)).toMatchObject({ style: 'strand' })
    // …and so is a palette name that only one style's table carries.
    const byPalette = applyCompositorCommand(baseState(), { op: 'scatter', args: { id: 'u', palettePreset: 'Vermilion' } })
    expect(byPalette.ok).toBe(true)
    expect(layerOf(byPalette)).toMatchObject({ style: 'strand' })
  })

  it('makes a Husk scatter, by name or from its dials alone', () => {
    const named = applyCompositorCommand(baseState(), {
      op: 'scatter',
      args: { id: 's', style: 'husk', husk: { count: 12, bite: 'dots' }, palettePreset: 'Harbour', seed: 61 },
    })
    expect(named.ok).toBe(true)
    const l = layerOf(named)
    expect(l).toMatchObject({ style: 'husk', seed: 61 })
    expect(l.husk).toMatchObject({ count: 12, bite: 'dots', inks: [...HUSK_PALETTE_PRESETS.Harbour.inks] })
    // A tunables object on its own is enough to say which style is meant.
    const implied = applyCompositorCommand(baseState(), { op: 'scatter', args: { id: 't', husk: { lump: 1 } } })
    expect(implied.ok).toBe(true)
    expect(layerOf(implied)).toMatchObject({ style: 'husk' })
    // …and so is a palette name that only one style's table carries.
    const byPalette = applyCompositorCommand(baseState(), { op: 'scatter', args: { id: 'u', palettePreset: 'Cinder' } })
    expect(byPalette.ok).toBe(true)
    expect(layerOf(byPalette)).toMatchObject({ style: 'husk' })
  })

  it('rejects a palette name that is not in the style\'s own table, with the options', () => {
    const bad = applyCompositorCommand(baseState(), { op: 'scatter', args: { style: 'chaff', palettePreset: 'Riso' } })
    expect(bad.ok).toBe(false)
    expect((bad as { detail: string }).detail).toMatch(/unknown palettePreset "Riso"/)
    expect((bad as { detail: string }).detail).toContain('Wheat')
  })

  it('restyle by id keeps the layer, its box and its seed; generate re-rolls it', () => {
    const s1 = (applyCompositorCommand(baseState({ aspect: 0.75 }), { op: 'scatter', args: { id: 's', seed: 123 } }) as { template: CompositorState }).template
    const r = applyCompositorCommand(s1, { op: 'scatter', target: 's', args: { chaff: { size: 0.9 } } })
    expect(r.ok).toBe(true)
    expect((r as { template: CompositorState }).template.layers).toHaveLength(1)
    expect(layerOf(r)).toMatchObject({ id: 's', w: 1, h: 0.75, seed: 123 })
    expect((layerOf(r).chaff as Record<string, number>).size).toBe(0.9)
    const r2 = applyCompositorCommand((r as { template: CompositorState }).template, { op: 'scatter', target: 's', args: { generate: true } })
    expect(layerOf(r2).seed).not.toBe(123)
    expect((layerOf(r2).chaff as Record<string, number>).size).toBe(0.9)    // the dials survive
  })

  it('targeting a non-scatter layer is an error in Scatter words', () => {
    const s: CompositorState = { layers: [{ id: 'r', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.3, h: 0.3, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0 } as never] }
    const r = applyCompositorCommand(s, { op: 'scatter', target: 'r', args: {} })
    expect(r.ok).toBe(false)
    expect((r as { detail: string }).detail).toMatch(/no scatter layer/)
  })

  it('reads back as type "scatter" with its style, seed and dials', () => {
    const s = (applyCompositorCommand(baseState(), { op: 'scatter', args: { id: 's', chaff: { count: 77 }, palettePreset: 'Brick', seed: 5 } }) as { template: CompositorState }).template
    const o = describeCompositor(s).objects.find(x => x.id === 's')!
    expect(o.type).toBe('scatter')
    const cur = o.current as Record<string, Record<string, unknown>>
    expect(cur.style).toBe('chaff')
    expect(cur.seed).toBe(5)
    expect(cur.chaff).toMatchObject({ palettePreset: 'Brick', count: 77 })
    // The ink list itself is not dumped into the model's context — the preset name is.
    expect(cur.chaff).not.toHaveProperty('inks')
  })

  it('is on the command menu, and its hint names the styles and the dials', () => {
    const cmd = describeCompositor(baseState()).commands.find(c => c.op === 'scatter')
    expect(cmd).toBeDefined()
    for (const w of ['"chaff"', 'palettePreset', 'seed', 'generate']) expect(cmd!.hint!).toContain(w)
  })

  it('leaves the Mosaic op alone — a scatter is its own element', () => {
    const s = (applyCompositorCommand(baseState(), { op: 'scatter', args: { id: 's' } }) as { template: CompositorState }).template
    const r = applyCompositorCommand(s, { op: 'mosaic', target: 's', args: { style: 'pane' } })
    expect(r.ok).toBe(false)
    expect((r as { detail: string }).detail).toMatch(/no mosaic layer/)
  })
})
