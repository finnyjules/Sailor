/**
 * The generative deal's shared seams across the agent surface + inspector:
 *   - ONE mode-precedence rule for create and reconfigure (explicit cellFill >
 *     first tunables object pane → modular → parcel → mosh > a preset's table);
 *   - describeCompositor exposes a deal (look, preset name, tunables, seed);
 *   - a new deal fills the frame (h = aspect), reconfigure never resizes;
 *   - palettePreset resolves against the FINAL look's table only (wrong table /
 *     typo = an error with the options), case-insensitively;
 *   - the vocab "Palette" control only shows when something reads the vocab.
 */
import { describe, it, expect } from 'vitest'
import { applyCompositorCommand, describeCompositor, impliedDealFill, type CompositorState } from '~/lib/agent/surfaces/compositor'
import { dealVocabDrivesLook } from '~/lib/compositor/dealVocab'
import { defaultPane, PANE_PALETTE_PRESETS } from '~/lib/compositor/pane'
import { defaultModular, MODULAR_PALETTE_PRESETS } from '~/lib/compositor/modular'
import { PARCEL_PALETTE_PRESETS } from '~/lib/compositor/parcel'
import { MOSH_PALETTE_PRESETS } from '~/lib/compositor/mosh'

const baseState = (extra: Partial<CompositorState> = {}): CompositorState => ({ layers: [], ...extra })
/** Create a deal with `args`, returning the new layer. */
function create(args: Record<string, unknown>, state = baseState()) {
  const r = applyCompositorCommand(state, { op: 'mosaic', args: { id: 'dd', ...args } })
  if (!r.ok) throw new Error(`create failed: ${r.detail}`)
  return { state: r.template, layer: r.template.layers[0] as any }
}
/** Reconfigure the deal 'dd' in `state` with `args`. */
function reconfigure(state: CompositorState, args: Record<string, unknown>) {
  return applyCompositorCommand(state, { op: 'mosaic', target: 'dd', args })
}
const layerOf = (r: ReturnType<typeof applyCompositorCommand>) => (r as any).template.layers[0]

describe('deal mode precedence — one rule for create and reconfigure', () => {
  it('impliedDealFill: first tunables object wins in pane → modular → parcel → mosh order', () => {
    expect(impliedDealFill({ pane: {}, mosh: {} })).toBe('pane')
    expect(impliedDealFill({ mosh: {}, parcel: {} })).toBe('parcel')
    expect(impliedDealFill({ mosh: {}, modular: {} })).toBe('modular')
    expect(impliedDealFill({ mosh: {} })).toBe('mosh')
    expect(impliedDealFill({ carve: {} })).toBe('carve')
    expect(impliedDealFill({ carve: {}, mosh: {} })).toBe('mosh')   // carve is last in the order
    expect(impliedDealFill({})).toBeNull()
  })
  it('impliedDealFill: a lone palettePreset implies the look whose table names it (any case)', () => {
    expect(impliedDealFill({ palettePreset: 'Riso' })).toBe('modular')
    expect(impliedDealFill({ palettePreset: 'acid on black' })).toBe('parcel')
    expect(impliedDealFill({ palettePreset: 'Print cube' })).toBe('mosh')
    expect(impliedDealFill({ palettePreset: 'CANDY' })).toBe('pane')
    expect(impliedDealFill({ palettePreset: 'broadsheet' })).toBe('carve')
    expect(impliedDealFill({ palettePreset: 'Nope' })).toBeNull()
    // A tunables object outranks the preset's table.
    expect(impliedDealFill({ mosh: {}, palettePreset: 'Riso' })).toBe('mosh')
  })

  it('{pane:{}, mosh:{}} yields the SAME cellFill on create and on reconfigure', () => {
    const c = create({ pane: {}, mosh: {} })
    expect(c.layer.cellFill).toBe('pane')
    // Reconfigure a deal that currently shows a DIFFERENT look — the rule, not the
    // current fill, decides.
    const s = create({ cellFill: 'parcel' }).state
    const r = reconfigure(s, { pane: {}, mosh: {} })
    expect(r.ok).toBe(true)
    expect(layerOf(r).cellFill).toBe('pane')
  })
  it('explicit cellFill:"solid" beside modular:{} wins on both paths; the modular args still land', () => {
    const c = create({ cellFill: 'solid', modular: { gcols: 9 } })
    expect(c.layer.cellFill).toBe('solid')
    expect(c.layer.modular.gcols).toBe(9)
    const s = create({ cellFill: 'mosh' }).state
    const r = reconfigure(s, { cellFill: 'solid', modular: { gcols: 9 } })
    expect(layerOf(r).cellFill).toBe('solid')
    expect(layerOf(r).modular.gcols).toBe(9)
  })
  it('a single mode arg implies that mode on both paths', () => {
    for (const look of ['pane', 'modular', 'parcel', 'mosh', 'carve'] as const) {
      expect(create({ [look]: {} }).layer.cellFill, `create ${look}`).toBe(look)
      const s = create({ cellFill: look === 'pane' ? 'mosh' : 'pane' }).state
      expect(layerOf(reconfigure(s, { [look]: {} })).cellFill, `reconfigure ${look}`).toBe(look)
    }
  })
  it('reconfigure with no fill-bearing args keeps the current fill; every provided look still merges', () => {
    const s = create({ cellFill: 'parcel' }).state
    expect(layerOf(reconfigure(s, { density: 0.4 })).cellFill).toBe('parcel')
    const r = reconfigure(s, { cellFill: 'parcel', pane: { rows: 7 }, mosh: { bands: 2 } })
    const l = layerOf(r)
    expect(l.cellFill).toBe('parcel')
    expect(l.pane.rows).toBe(7)
    expect(l.mosh.bands).toBe(2)
  })
})

describe('describeCompositor exposes a deal', () => {
  it('a Pane deal reports its look, the preset name, tunables (no ink arrays), seed and density', () => {
    const { state } = create({ cellFill: 'pane', palettePreset: 'Candy', pane: { rows: 3, cells: 5, vary: 0.2, diag: 0.7, soft: 0.5, spread: 0.55 }, seed: 321, density: 0.8 })
    const snap = describeCompositor(state)
    const o = snap.objects.find(x => x.id === 'dd')!
    expect(o.type).toBe('mosaic') // the agent never sees the internal kind 'deal'
    expect(o.label).toBe('mosaic')
    const cur = o.current as Record<string, any>
    expect(cur).not.toHaveProperty('cellFill') // one vocabulary: style, the word the args take
    expect(cur).toMatchObject({ style: 'pane', vocab: 'brand', density: 0.8, cellInset: 0, seed: 321 })
    expect(cur.pane).toMatchObject({ palettePreset: 'Candy', rows: 3, cells: 5, vary: 0.2, diag: 0.7, soft: 0.5, spread: 0.55 })
    expect(cur.pane).not.toHaveProperty('inks')
    expect(cur).not.toHaveProperty('modular')
    expect(cur).not.toHaveProperty('mosh')
  })
  it('a Tiles mosaic reports style:"tiles" + vocab and no look block', () => {
    const { state } = create({ style: 'tiles', vocab: 'cool' })
    const cur = describeCompositor(state).objects.find(x => x.id === 'dd')!.current as Record<string, any>
    expect(cur).toMatchObject({ style: 'tiles', vocab: 'cool' })
    for (const k of ['pane', 'modular', 'parcel', 'mosh', 'carve']) expect(cur).not.toHaveProperty(k)
  })
  it('a deal saved without cellFill reads as tiles; custom / vocab palettes are named as such', () => {
    const s = create({ cellFill: 'modular' }).state
    delete (s.layers[0] as any).cellFill
    expect((describeCompositor(s).objects[0]!.current as any).style).toBe('tiles')
    // Modular default has no inks of its own → 'vocab'; a custom ink list → 'custom'.
    expect((describeCompositor(create({ modular: {} }).state).objects[0]!.current as any).modular.palettePreset).toBe('vocab')
    const custom = create({ modular: { inks: ['#111111', '#222222'] } }).state
    expect((describeCompositor(custom).objects[0]!.current as any).modular.palettePreset).toBe('custom')
    expect((describeCompositor(create({ palettePreset: 'Riso' }).state).objects[0]!.current as any).modular.palettePreset).toBe('Riso')
  })
  it('Parcel and Mosh looks report their preset and tunables', () => {
    const p = (describeCompositor(create({ palettePreset: 'Blue on olive', parcel: { cells: 20 } }).state).objects[0]!.current as any)
    expect(p.style).toBe('parcel')
    expect(p.parcel).toMatchObject({ palettePreset: 'Blue on olive', cells: 20, ...PARCEL_PALETTE_PRESETS['Blue on olive'] })
    const m = (describeCompositor(create({ mosh: { bands: 3 } }).state).objects[0]!.current as any)
    expect(m.style).toBe('mosh')
    expect(m.mosh).toMatchObject({ palettePreset: 'Pure cube', bands: 3 })
    expect(m.mosh).not.toHaveProperty('inks')
  })
})

describe('an agent-created deal fills the frame', () => {
  it('h follows state.aspect (H/W); absent aspect = square', () => {
    expect(create({}, baseState({ aspect: 9 / 16 })).layer).toMatchObject({ w: 1, h: 9 / 16 })
    expect(create({}, baseState({ aspect: 1.25 })).layer).toMatchObject({ w: 1, h: 1.25 })
    expect(create({}).layer).toMatchObject({ w: 1, h: 1 })
    expect(create({}, baseState({ aspect: 0 })).layer.h).toBe(1)
  })
  it('reconfigure never changes w/h', () => {
    const { state } = create({ cellFill: 'pane' }, baseState({ aspect: 9 / 16 }))
    const r = reconfigure({ ...state, aspect: 2 }, { mosh: {}, palettePreset: 'Warm cube', density: 0.5, seed: 4 })
    expect(r.ok).toBe(true)
    expect(layerOf(r)).toMatchObject({ w: 1, h: 9 / 16, cellFill: 'mosh' })
  })
  it('the hint tells the truth about filling the frame, the style word and the default', () => {
    const cmds = describeCompositor(baseState()).commands
    expect(cmds.some(c => c.op === 'dealGrid')).toBe(false) // the menu teaches only `mosaic`
    const hint = cmds.find(c => c.op === 'mosaic')!.hint!
    expect(hint).toContain('MOSAIC')
    expect(hint).toContain('fills the whole frame')
    expect(hint).toContain('default style modular')
    expect(hint).toContain('cellFill is accepted as an alias of style')
    for (const w of ['"tiles"', '"pane"', '"modular"', '"parcel"', '"mosh"', '"carve"']) expect(hint).toContain(w)
  })
})

describe('palettePreset resolves against the final look only', () => {
  it('a wrong-table preset is an error with the options, on create and reconfigure', () => {
    const r = applyCompositorCommand(baseState(), { op: 'mosaic', args: { style: 'pane', palettePreset: 'Riso' } })
    expect(r.ok).toBe(false)
    expect((r as any).detail).toMatch(/unknown palettePreset "Riso" for pane; options: Hot pink \| Electric/)
    const s = create({ cellFill: 'modular' }).state
    const r2 = reconfigure(s, { mosh: {}, palettePreset: 'riso' })
    expect(r2.ok).toBe(false)
    expect((r2 as any).detail).toMatch(/for mosh; options: Pure cube/)
    // The failing command left the state untouched (pure): still modular.
    expect((s.layers[0] as any).cellFill).toBe('modular')
  })
  it('a preset on a Tiles mosaic is an error that points at the styles with inks', () => {
    const r = applyCompositorCommand(baseState(), { op: 'mosaic', args: { style: 'tiles', palettePreset: 'Riso' } })
    expect(r.ok).toBe(false)
    expect((r as any).detail).toMatch(/needs a style/)
  })
  it('a right-table preset is applied, case-insensitively, and never recolours another look', () => {
    const c = create({ pane: {}, palettePreset: 'sorbet' })
    expect(c.layer.cellFill).toBe('pane')
    expect(c.layer.pane.inks).toEqual([...PANE_PALETTE_PRESETS.Sorbet])
    expect(c.layer.modular).toEqual(defaultModular())
    const s = create({ cellFill: 'parcel' }).state
    const r = reconfigure(s, { palettePreset: 'ACID ON BLACK' })
    expect(r.ok).toBe(true)
    expect(layerOf(r).cellFill).toBe('parcel')
    expect(layerOf(r).parcel).toMatchObject(PARCEL_PALETTE_PRESETS['Acid on black'])
    const r2 = reconfigure(s, { mosh: {}, palettePreset: 'cool CUBE' })
    expect(layerOf(r2).cellFill).toBe('mosh')
    expect(layerOf(r2).mosh.inks).toEqual([...MOSH_PALETTE_PRESETS['Cool cube']])
    // The Mosh preset touched mosh only — parcel is exactly what it was.
    expect(layerOf(r2).parcel).toEqual((s.layers[0] as any).parcel)
  })
  it('a lone preset implies its look and lands its colours (the previous behaviour, kept)', () => {
    const m = create({ palettePreset: 'Heat' }).layer
    expect(m.cellFill).toBe('modular')
    expect(m.modular).toMatchObject({ bg: MODULAR_PALETTE_PRESETS.Heat.bg, inks: [...MODULAR_PALETTE_PRESETS.Heat.inks] })
  })
})

describe('the vocab Palette control only shows when the vocab is read', () => {
  it('true for solid (and absent) and Modular with no inks; false for parcel / mosh; pane by ink count', () => {
    expect(dealVocabDrivesLook({})).toBe(true)
    expect(dealVocabDrivesLook({ cellFill: 'solid' })).toBe(true)
    expect(dealVocabDrivesLook({ cellFill: 'modular', modular: defaultModular() })).toBe(true)
    expect(dealVocabDrivesLook({ cellFill: 'modular' })).toBe(true)
    expect(dealVocabDrivesLook({ cellFill: 'modular', modular: { inks: ['#111111', '#222222'] } })).toBe(false)
    expect(dealVocabDrivesLook({ cellFill: 'parcel' })).toBe(false)
    expect(dealVocabDrivesLook({ cellFill: 'mosh' })).toBe(false)
    expect(dealVocabDrivesLook({ cellFill: 'carve' })).toBe(false)   // carve ships its own six inks
    expect(dealVocabDrivesLook({ cellFill: 'pane', pane: defaultPane() })).toBe(false) // ships 8 inks
    expect(dealVocabDrivesLook({ cellFill: 'pane', pane: { ...defaultPane(), inks: [] } })).toBe(true)
    expect(dealVocabDrivesLook({ cellFill: 'pane', pane: { ...defaultPane(), inks: ['#111111'] } })).toBe(true)
    expect(dealVocabDrivesLook({ cellFill: 'pane' })).toBe(false) // absent params paint at defaultPane() = 8 inks
  })
})
