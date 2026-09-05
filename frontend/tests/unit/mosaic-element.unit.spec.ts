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
} from '~/lib/compositor/mosaic'
import { applyCompositorCommand, describeCompositor, type CompositorState } from '~/lib/agent/surfaces/compositor'

describe('Mosaic in the Shapes menu', () => {
  it('is a row beside the primitive shapes, after Star and before the library', () => {
    const ids = TOOLBAR_SHAPES.map(s => s.id)
    expect(ids).toContain('mosaic')
    expect(ids.indexOf('mosaic')).toBe(ids.indexOf('star') + 1)
    expect(ids.indexOf('mosaic')).toBe(ids.indexOf('library') - 1)
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
    expect(MOSAIC_STYLE_LABELS).toEqual(['Tiles', 'Pane', 'Modular', 'Parcel', 'Mosh'])
    expect(MOSAIC_STYLES.map(r => r.style)).toEqual(['tiles', 'pane', 'modular', 'parcel', 'mosh'])
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
