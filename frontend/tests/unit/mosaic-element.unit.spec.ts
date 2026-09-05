/**
 * The Mosaic element: a playgrnd-style generative composition as ONE layer, added
 * from the toolbar's Shapes menu and tuned in the inspector. Internally it is the
 * `deal` layer kind (persisted data untouched); "Mosaic" is the label people see.
 */
import { describe, it, expect } from 'vitest'
import { TOOLBAR_SHAPES, resolveShapeFace, shapeFaceLabel } from '~/lib/compositor/toolbarMenus'
import { newMosaicLayer } from '~/composables/useCompositorLayers'
import {
  MOSAIC_STYLES, MOSAIC_STYLE_LABELS, DEFAULT_MOSAIC_STYLE,
  mosaicStyleOf, cellFillOfStyle, cellFillOfLabel, mosaicLabelOf, mosaicStyleFromArgs,
  mosaicShaderSpec, mosaicShaderFill, dealShaderFill, mosaicStylePatch, mosaicSeedPatch,
  mosaicLookOf, mosaicLookNames, applyMosaicLook,
} from '~/lib/compositor/mosaic'
import { layerPaints, createDealLayer, type DealLayer } from '~/composables/useCompositorLayers'
import { EFFECT_LOOKS } from '~/lib/shaderstudio/presets'
import { defaultCarve } from '~/lib/compositor/carve'
import { applyCompositorCommand, describeCompositor, type CompositorState } from '~/lib/agent/surfaces/compositor'

describe('Mosaic in the Shapes menu', () => {
  it('is a row beside the primitive shapes, after Star and before the library', () => {
    const ids = TOOLBAR_SHAPES.map(s => s.id)
    expect(ids).toContain('mosaic')
    expect(ids.indexOf('mosaic')).toBe(ids.indexOf('star') + 1)
    // The Scatter element (its sibling) sits between the Mosaic and the library.
    expect(ids.indexOf('mosaic')).toBe(ids.indexOf('scatter') - 1)
    expect(ids.indexOf('scatter')).toBe(ids.indexOf('library') - 1)
    expect(TOOLBAR_SHAPES.find(s => s.id === 'mosaic')!.label).toBe('Mosaic')
  })
  it('can be worn as the last-used face, titled "Add mosaic" by the face button', () => {
    expect(resolveShapeFace('mosaic')).toBe('mosaic')
    expect('Add ' + shapeFaceLabel('mosaic').toLowerCase()).toBe('Add mosaic')
  })
})

describe('newMosaicLayer — what the stamp creates', () => {
  it('is a frame-filling deal layer in the Modular style', () => {
    const l = newMosaicLayer(9 / 16)
    expect(l.kind).toBe('deal')
    expect(l.cellFill).toBe('modular')
    expect(l).toMatchObject({ x: 0.5, y: 0.5, w: 1, h: 9 / 16, rotation: 0, opacity: 1 })
    expect(l.modular).toBeDefined()
    // A fresh mosaic has its own generated grid (never the frame's), so it is non-empty.
    expect(l.grid.mode).toBe('generated')
    expect(l.grid.gen.seed).toBeGreaterThan(0)
  })
  it('a portrait frame gives h > 1; a bad aspect falls back to square', () => {
    expect(newMosaicLayer(4 / 3).h).toBeCloseTo(4 / 3)
    expect(newMosaicLayer(0).h).toBe(1)
    expect(newMosaicLayer(Number.NaN).h).toBe(1)
  })
  it('two stamps are distinct layers', () => {
    expect(newMosaicLayer(1).id).not.toBe(newMosaicLayer(1).id)
  })
})

// ── Style ↔ cellFill: one table for the inspector, the agent and the specs ──────
describe('Mosaic styles', () => {
  it('the Style control offers the styles in table order, plain words', () => {
    expect(MOSAIC_STYLE_LABELS).toEqual(['Tiles', 'Pane', 'Modular', 'Parcel', 'Mosh', 'Carve', 'Oddgrid', 'Static'])
    expect(MOSAIC_STYLES.map(r => r.style)).toEqual(['tiles', 'pane', 'modular', 'parcel', 'mosh', 'carve', 'oddgrid', 'static'])
  })
  it('maps every style onto its cellFill and back (tiles is the internal "solid")', () => {
    expect(cellFillOfStyle('tiles')).toBe('solid')
    expect(mosaicStyleOf('solid')).toBe('tiles')
    expect(mosaicStyleOf(undefined)).toBe('tiles') // an old layer with no cellFill
    for (const r of MOSAIC_STYLES) {
      expect(mosaicStyleOf(r.cellFill)).toBe(r.style)
      expect(cellFillOfStyle(r.style)).toBe(r.cellFill)
      expect(cellFillOfLabel(r.label)).toBe(r.cellFill)
      expect(mosaicLabelOf(r.cellFill)).toBe(r.label)
    }
  })
  it('an unknown inspector label can never write an unknown fill', () => {
    expect(cellFillOfLabel('Nope')).toBe('solid')
    expect(mosaicLabelOf('bogus' as any)).toBe('Tiles')
  })
  it('reads a style out of agent args: style first, cellFill as an alias, raw fills and any case', () => {
    expect(mosaicStyleFromArgs({ style: 'pane' })).toBe('pane')
    expect(mosaicStyleFromArgs({ cellFill: 'pane' })).toBe('pane')
    expect(mosaicStyleFromArgs({ style: 'Tiles' })).toBe('tiles')
    expect(mosaicStyleFromArgs({ cellFill: 'solid' })).toBe('tiles')
    expect(mosaicStyleFromArgs({ style: 'mosh', cellFill: 'pane' })).toBe('mosh')
    expect(mosaicStyleFromArgs({ style: 'bogus', cellFill: 'parcel' })).toBe('parcel')
    expect(mosaicStyleFromArgs({})).toBeNull()
    expect(mosaicStyleFromArgs({ style: 42 })).toBeNull()
  })
  it('the default style is modular — the toolbar stamp and the agent create agree', () => {
    expect(DEFAULT_MOSAIC_STYLE).toBe('modular')
    expect(newMosaicLayer(1).cellFill).toBe(cellFillOfStyle(DEFAULT_MOSAIC_STYLE))
  })
})

// ── The agent's `mosaic` op ────────────────────────────────────────────────────
describe('agent mosaic op', () => {
  const baseState = (extra: Partial<CompositorState> = {}): CompositorState => ({ layers: [], ...extra })
  const layerOf = (r: ReturnType<typeof applyCompositorCommand>) => (r as any).template.layers[0]

  it('create with no style is a frame-filling modular mosaic', () => {
    const r = applyCompositorCommand(baseState({ aspect: 9 / 16 }), { op: 'mosaic', args: { id: 'm' } })
    expect(r.ok).toBe(true)
    expect(layerOf(r)).toMatchObject({ id: 'm', kind: 'deal', cellFill: 'modular', w: 1, h: 9 / 16, x: 0.5, y: 0.5 })
  })
  it('style:"pane" and cellFill:"pane" land on the same layer', () => {
    const a = layerOf(applyCompositorCommand(baseState(), { op: 'mosaic', args: { id: 'm', style: 'pane', seed: 7 } }))
    const b = layerOf(applyCompositorCommand(baseState(), { op: 'mosaic', args: { id: 'm', cellFill: 'pane', seed: 7 } }))
    expect(a.cellFill).toBe('pane')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
  it('style:"tiles" is the internal solid fill', () => {
    expect(layerOf(applyCompositorCommand(baseState(), { op: 'mosaic', args: { style: 'tiles' } })).cellFill).toBe('solid')
  })
  it('dealGrid is still accepted as a deprecated alias (same handler, same defaults)', () => {
    const viaAlias = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'm', style: 'mosh' } })
    expect(viaAlias.ok).toBe(true)
    expect(layerOf(viaAlias).cellFill).toBe('mosh')
    expect(layerOf(applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'm' } })).cellFill).toBe('modular')
    // …but the command menu teaches only the new word.
    const ops = describeCompositor(baseState()).commands.map(c => c.op)
    expect(ops).toContain('mosaic')
    expect(ops).not.toContain('dealGrid')
  })
  it('restyle by id keeps the layer, its box and its seed', () => {
    const s1 = (applyCompositorCommand(baseState({ aspect: 0.75 }), { op: 'mosaic', args: { id: 'm', style: 'pane', seed: 123 } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'mosaic', target: 'm', args: { style: 'parcel' } })
    expect(r.ok).toBe(true)
    expect((r as any).template.layers).toHaveLength(1)
    expect(layerOf(r)).toMatchObject({ id: 'm', cellFill: 'parcel', w: 1, h: 0.75 })
    expect(layerOf(r).grid.gen.seed).toBe(123)
  })
  it('reads back as type "mosaic" with a style word — the kind stays internal', () => {
    const s = (applyCompositorCommand(baseState(), { op: 'mosaic', args: { id: 'm', style: 'mosh' } }) as any).template
    const o = describeCompositor(s).objects.find(x => x.id === 'm')!
    expect(o.type).toBe('mosaic')
    expect((o.current as any).style).toBe('mosh')
    expect(s.layers[0].kind).toBe('deal')
  })
  it('targeting a non-mosaic layer is an error in Mosaic words', () => {
    const s: CompositorState = { layers: [{ id: 'r', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.3, h: 0.3, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0 } as any] }
    const r = applyCompositorCommand(s, { op: 'mosaic', target: 'r', args: { style: 'pane' } })
    expect(r.ok).toBe(false)
    expect((r as any).detail).toMatch(/no mosaic layer/)
  })
})

// ── Oddgrid / Static: the shader-as-fill bridge ────────────────────────────────
describe('Mosaic shader styles (Oddgrid / Static)', () => {
  const mosaic = (over: Partial<DealLayer> = {}) => createDealLayer({ cellFill: 'pane', w: 1, h: 0.5625, ...over })

  it('switching to a canvas style seeds that style\'s params and leaves the box, the seed and the other styles alone', () => {
    const l = mosaic()
    const patch = mosaicStylePatch(l, 'carve')
    expect(patch.cellFill).toBe('carve')
    expect(patch.carve).toEqual(defaultCarve())
    expect(patch).not.toHaveProperty('w'); expect(patch).not.toHaveProperty('grid'); expect(patch).not.toHaveProperty('shader')
    // Params already on the layer are kept, not reset.
    const tuned = { ...defaultCarve(), cuts: 3 }
    expect(mosaicStylePatch({ ...l, carve: tuned }, 'carve').carve).toBe(tuned)
  })
  it('switching to oddgrid seeds a ShaderSpec for that effect at the layer seed, still, frame-anchored, first Look', () => {
    const l = mosaic()
    const seed = l.grid.gen.seed
    const patch = mosaicStylePatch(l, 'oddgrid')
    expect(patch.cellFill).toBe('oddgrid')
    expect(patch.shader).toMatchObject({ effectId: 'oddgrid', seed, speed: 0, anchor: 'frame' })
    // The first Look's params, keyed WITHOUT the u_ prefix (the ShaderSpec convention).
    const first = EFFECT_LOOKS.oddgrid![0]!
    for (const [k, v] of Object.entries(first.params)) expect(patch.shader!.params[k.replace(/^u_/, '')]).toBe(v)
    expect(Object.keys(patch.shader!.params).some(k => k.startsWith('u_'))).toBe(false)
    // The box and the seed are untouched by a style hop.
    expect(patch).not.toHaveProperty('w'); expect(patch).not.toHaveProperty('h'); expect(patch).not.toHaveProperty('grid')
  })
  it('static seeds its own effect; a spec already on the same effect is kept (dials survive a hop away and back)', () => {
    const l = mosaic()
    const s1 = mosaicStylePatch(l, 'static').shader!
    expect(s1.effectId).toBe('static')
    expect(mosaicLookOf(s1)).toBe(EFFECT_LOOKS.static![0]!.name)
    const tuned = { ...s1, params: { ...s1.params, glitch: 0.9 } }
    const back = mosaicStylePatch({ ...l, cellFill: 'static', shader: tuned }, 'pane')
    expect(back.cellFill).toBe('pane')
    expect(back).not.toHaveProperty('shader') // left on the layer, not cleared
    const again = mosaicStylePatch({ ...l, cellFill: 'pane', shader: tuned }, 'static').shader!
    expect(again).toBe(tuned)
    // …but a different effect starts fresh from that effect's first Look.
    expect(mosaicStylePatch({ ...l, shader: tuned }, 'oddgrid').shader!.effectId).toBe('oddgrid')
  })
  it('Oddgrid → Static → Oddgrid brings back the Oddgrid dials (per-effect specs are stashed on the hop)', () => {
    const l = mosaic()
    const odd = { ...mosaicStylePatch(l, 'oddgrid').shader!, params: { ...mosaicStylePatch(l, 'oddgrid').shader!.params, cols: 9 } }
    const onOdd: DealLayer = { ...l, cellFill: 'oddgrid', shader: odd }
    const toStatic = mosaicStylePatch(onOdd, 'static')
    expect(toStatic.shader!.effectId).toBe('static')
    expect(toStatic.shaderSpecs?.oddgrid).toBe(odd)            // the spec being left is stashed
    const onStatic: DealLayer = { ...onOdd, ...toStatic }
    const back = mosaicStylePatch(onStatic, 'oddgrid')
    expect(back.shader).toBe(odd)                               // restored, dials intact
    expect(back.shaderSpecs?.static).toBe(toStatic.shader)      // and Static's stashed in turn
    // Hopping to a CANVAS style stashes too, and does not clear the live slot.
    const toPane = mosaicStylePatch(onStatic, 'pane')
    expect(toPane.shaderSpecs?.static).toBe(toStatic.shader)
    expect(toPane).not.toHaveProperty('shader')
  })
  it('layerPaints returns exactly the shader Fill for the shader styles and nothing for the others', () => {
    for (const fill of ['solid', 'pane', 'modular', 'parcel', 'mosh', 'carve'] as const) {
      expect(layerPaints(mosaic({ cellFill: fill })), fill).toEqual([])
    }
    for (const fill of ['oddgrid', 'static'] as const) {
      const l = { ...mosaic(), ...mosaicStylePatch(mosaic(), fill) } as DealLayer
      const paints = layerPaints(l)
      expect(paints).toHaveLength(1)
      expect(paints[0]).toEqual(mosaicShaderFill(l.shader!))
      expect((paints[0] as any).type).toBe('shader')
      expect((paints[0] as any).shader.effectId).toBe(fill)
      // The Fill the paint branch draws with is the same one the pre-pass registers.
      expect(dealShaderFill(l)).toEqual(paints[0])
    }
  })
  it('a shader-style layer with no spec yet (agent-made / hand-edited save) still registers and paints at its seed', () => {
    const l = mosaic({ cellFill: 'oddgrid' })
    delete (l as any).shader
    const paints = layerPaints(l)
    expect(paints).toHaveLength(1)
    expect((paints[0] as any).shader).toMatchObject({ effectId: 'oddgrid', seed: l.grid.gen.seed })
  })
  it('New variation re-rolls grid.gen.seed AND mirrors it into the spec; the seed is in the field key', () => {
    const l = { ...mosaic(), ...mosaicStylePatch(mosaic(), 'oddgrid') } as DealLayer
    const patch = mosaicSeedPatch(l, 777)
    expect(patch.grid!.gen.seed).toBe(777)
    expect(patch.shader!.seed).toBe(777)
    expect(patch.shader!.effectId).toBe('oddgrid')
    // A canvas style with no spec only touches the grid seed.
    const p2 = mosaicSeedPatch(mosaic(), 5)
    expect(p2.grid!.gen.seed).toBe(5)
    expect(p2).not.toHaveProperty('shader')
    // Two seeds are two different fields (specIdentityKey folds the seed in).
    const a = mosaicShaderSpec('oddgrid', 1), b = mosaicShaderSpec('oddgrid', 2)
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })
  it('Looks are the shader styles\' Palette: names come from EFFECT_LOOKS, apply by name, read back by match', () => {
    expect(mosaicLookNames('oddgrid')).toEqual(EFFECT_LOOKS.oddgrid!.map(l => l.name))
    expect(mosaicLookNames('static')).toEqual(EFFECT_LOOKS.static!.map(l => l.name))
    const spec = mosaicShaderSpec('oddgrid', 42)
    const quilt = applyMosaicLook(spec, 'Quilt')
    expect(mosaicLookOf(quilt)).toBe('Quilt')
    expect(quilt.params.motif).toBe(4)
    expect(mosaicLookOf({ ...quilt, params: { ...quilt.params, scale: 3.3 } })).toBe('') // custom
    expect(applyMosaicLook(spec, 'nope')).toBe(spec)
  })
})

describe('agent mosaic op — shader styles', () => {
  const baseState = (extra: Partial<CompositorState> = {}): CompositorState => ({ layers: [], ...extra })
  const layerOf = (r: ReturnType<typeof applyCompositorCommand>) => (r as any).template.layers[0]

  it('style:"oddgrid" creates a frame-filling mosaic carrying an oddgrid spec at the layer seed', () => {
    const r = applyCompositorCommand(baseState({ aspect: 0.5 }), { op: 'mosaic', args: { id: 'm', style: 'oddgrid', seed: 99 } })
    expect(r.ok).toBe(true)
    const l = layerOf(r)
    expect(l).toMatchObject({ kind: 'deal', cellFill: 'oddgrid', w: 1, h: 0.5 })
    expect(l.shader).toMatchObject({ effectId: 'oddgrid', seed: 99, speed: 0 })
    expect(l.grid.gen.seed).toBe(99)
  })
  it('look picks a Look by name (any case; palettePreset is the same word); unknown looks are errors with the options', () => {
    const l = layerOf(applyCompositorCommand(baseState(), { op: 'mosaic', args: { style: 'static', look: 'black on lime' } }))
    expect(mosaicLookOf(l.shader)).toBe('Black on Lime')
    const l2 = layerOf(applyCompositorCommand(baseState(), { op: 'mosaic', args: { style: 'oddgrid', palettePreset: 'Drift' } }))
    expect(mosaicLookOf(l2.shader)).toBe('Drift')
    const bad = applyCompositorCommand(baseState(), { op: 'mosaic', args: { style: 'oddgrid', look: 'Riso' } })
    expect(bad.ok).toBe(false)
    expect((bad as any).detail).toMatch(/unknown look "Riso" for oddgrid/)
    expect((bad as any).detail).toContain('Patchwork')
    // A Look name alone implies its style — after the generators ("Bloom" is Modular's first).
    expect(layerOf(applyCompositorCommand(baseState(), { op: 'mosaic', args: { look: 'Quilt' } })).cellFill).toBe('oddgrid')
    expect(layerOf(applyCompositorCommand(baseState(), { op: 'mosaic', args: { look: 'Bloom' } })).cellFill).toBe('modular')
  })
  it('shader.params fine-tunes the spec (u_ prefix optional); restyle keeps the layer, box and seed', () => {
    const s1 = (applyCompositorCommand(baseState({ aspect: 0.75 }), { op: 'mosaic', args: { id: 'm', style: 'oddgrid', seed: 12 } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'mosaic', target: 'm', args: { shader: { params: { cols: 20, u_grain: 0.1 } } } })
    expect(r.ok).toBe(true)
    expect((r as any).template.layers).toHaveLength(1)
    expect(layerOf(r)).toMatchObject({ id: 'm', cellFill: 'oddgrid', w: 1, h: 0.75 })
    expect(layerOf(r).shader.params).toMatchObject({ cols: 20, grain: 0.1 })
    expect(layerOf(r).shader.seed).toBe(12)
    // generate re-rolls BOTH seeds together.
    const r2 = applyCompositorCommand((r as any).template, { op: 'mosaic', target: 'm', args: { generate: true } })
    const l2 = layerOf(r2)
    expect(l2.grid.gen.seed).not.toBe(12)
    expect(l2.shader.seed).toBe(l2.grid.gen.seed)
    // Switching back to Pane keeps the layer and its box (and the spec for a later hop back).
    const r3 = applyCompositorCommand((r2 as any).template, { op: 'mosaic', target: 'm', args: { style: 'pane' } })
    expect(layerOf(r3)).toMatchObject({ id: 'm', cellFill: 'pane', w: 1, h: 0.75 })
    expect(layerOf(r3).shader.effectId).toBe('oddgrid')
  })
  it('reads back as style + the Look name + the spec params', () => {
    const s = (applyCompositorCommand(baseState(), { op: 'mosaic', args: { id: 'm', style: 'static', look: 'Blue on Cream' } }) as any).template
    const cur = describeCompositor(s).objects.find(x => x.id === 'm')!.current as any
    expect(cur.style).toBe('static')
    expect(cur.static.look).toBe('Blue on Cream')
    expect(cur.static.ink).toBe('#1B3FA8')
    const hint = describeCompositor(baseState()).commands.find(c => c.op === 'mosaic')!.hint!
    for (const w of ['"oddgrid"', '"static"', 'look', 'shader: { params']) expect(hint).toContain(w)
  })
})
