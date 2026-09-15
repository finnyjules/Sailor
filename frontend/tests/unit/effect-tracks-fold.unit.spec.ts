import { describe, it, expect } from 'vitest'
import { applyEffectDialTracks, type EffectDialTrack } from '~/lib/motion/effectTracks'
import { effectStackOf } from '~/lib/compositor/effectStack'
import type { LocalLayer } from '~/composables/useCompositorLayers'

/**
 * F8 · Task 3 — `applyEffectDialTracks` is the pure fold + byte-identity seam. These tests pin
 * the two properties the painter relies on: (1) the SAME array reference is returned whenever
 * nothing should change (no tracks / no clock / dangling targets / a value equal to the current
 * dial), so the painter's `!==` guard never rebuilds a frame it didn't need to; (2) when a track
 * DOES fire, only the targeted layer is cloned (others stay `===`), only the target dial changes,
 * the input layer is never mutated, and a legacy layer's `tornEdge`/`feather` are cleared into
 * `.effects` so `effectStackOf` doesn't double them.
 *
 * `applyEffectDialTracks` reads only `.id` / `.effects` / `.tornEdge` / `.feather`, so a minimal
 * object cast to `LocalLayer` exercises it faithfully.
 */
const asLayer = (o: Record<string, unknown>): LocalLayer => o as unknown as LocalLayer

const newLayer = () => asLayer({
  id: 'L1',
  effects: [
    { id: 'e-shadow', type: 'drop_shadow', color: '#123456', x: 0.03, y: 0.04, blur: 0.05, visible: true },
    { id: 'e-grain', type: 'grain', amount: 0.4, size: 3, visible: true },
  ],
})

describe('applyEffectDialTracks — same-reference short-circuit', () => {
  it('returns the SAME array reference when tracks is undefined', () => {
    const layers = [newLayer()]
    expect(applyEffectDialTracks(layers, undefined, 0)).toBe(layers)
  })

  it('returns the SAME array reference when tracks is empty', () => {
    const layers = [newLayer()]
    expect(applyEffectDialTracks(layers, [], 0)).toBe(layers)
  })

  it('returns the SAME array reference when t is undefined', () => {
    const layers = [newLayer()]
    const tracks: EffectDialTrack[] = [{ target: 'layers.L1.effects.e-grain.amount', keyframes: [{ t: 0, v: 0.9 }] }]
    expect(applyEffectDialTracks(layers, tracks, undefined)).toBe(layers)
  })

  it('returns the SAME array reference when every target is dangling/foreign', () => {
    const layers = [newLayer()]
    const tracks: EffectDialTrack[] = [
      { target: 'layers.NOPE.effects.e-grain.amount', keyframes: [{ t: 0, v: 0.9 }] }, // unknown layer
      { target: 'layers.L1.effects.no-such.amount', keyframes: [{ t: 0, v: 0.9 }] },   // unknown effect
      { target: 'garbage.path', keyframes: [{ t: 0, v: 0.9 }] },                       // malformed
      { target: 'objects.L1.foo.bar.baz', keyframes: [{ t: 0, v: 0.9 }] },             // foreign root
    ]
    expect(applyEffectDialTracks(layers, tracks, 0)).toBe(layers)
  })

  it('does not throw on malformed targets', () => {
    const layers = [newLayer()]
    const tracks: EffectDialTrack[] = [{ target: '', keyframes: [{ t: 0, v: 1 }] }]
    expect(() => applyEffectDialTracks(layers, tracks, 0)).not.toThrow()
  })

  it('returns the SAME array reference when the resolved value equals the current dial', () => {
    const layers = [newLayer()]
    // grain.amount is already 0.4; a single-keyframe track holding 0.4 resolves to 0.4 → no clone.
    const tracks: EffectDialTrack[] = [{ target: 'layers.L1.effects.e-grain.amount', keyframes: [{ t: 0, v: 0.4 }] }]
    expect(applyEffectDialTracks(layers, tracks, 5)).toBe(layers)
  })
})

describe('applyEffectDialTracks — a resolving numeric track', () => {
  it('clones ONLY the targeted layer and changes ONLY the target dial, input unmutated', () => {
    const target = newLayer()
    const other = asLayer({ id: 'L2', effects: [{ id: 'e-blur', type: 'layer_blur', radius: 0.02, visible: true }] })
    const layers = [target, other]
    const tracks: EffectDialTrack[] = [{ target: 'layers.L1.effects.e-grain.amount', keyframes: [{ t: 0, v: 0.9 }] }]

    const out = applyEffectDialTracks(layers, tracks, 5)
    expect(out).not.toBe(layers)          // a new array
    expect(out[1]).toBe(other)            // untouched layer → same object reference
    expect(out[0]).not.toBe(target)       // touched layer → fresh clone

    const clonedGrain = (out[0] as any).effects.find((e: any) => e.id === 'e-grain')
    expect(clonedGrain.amount).toBe(0.9)  // target dial changed
    expect(clonedGrain.size).toBe(3)      // sibling dial untouched
    const clonedShadow = (out[0] as any).effects.find((e: any) => e.id === 'e-shadow')
    expect(clonedShadow.blur).toBe(0.05)  // other effect untouched

    // The INPUT layer object is not mutated in place.
    const inputGrain = (target as any).effects.find((e: any) => e.id === 'e-grain')
    expect(inputGrain.amount).toBe(0.4)
  })

  it('interpolates between keyframes at mid-t', () => {
    const layers = [newLayer()]
    const tracks: EffectDialTrack[] = [{
      target: 'layers.L1.effects.e-grain.amount',
      keyframes: [{ t: 0, v: 0, ease: 'linear' }, { t: 2, v: 1, ease: 'linear' }],
    }]
    const out = applyEffectDialTracks(layers, tracks, 1)
    const grain = (out[0] as any).effects.find((e: any) => e.id === 'e-grain')
    expect(grain.amount).toBeCloseTo(0.5, 6)
  })
})

describe('applyEffectDialTracks — a resolving colour track', () => {
  it('writes a mixed hex onto the target colour dial', () => {
    const layers = [newLayer()]
    const tracks: EffectDialTrack[] = [{
      target: 'layers.L1.effects.e-shadow.color',
      keyframes: [{ t: 0, v: '#000000' }, { t: 1, v: '#ffffff' }],
      space: 'srgb',
    }]
    const out = applyEffectDialTracks(layers, tracks, 1)
    const shadow = (out[0] as any).effects.find((e: any) => e.id === 'e-shadow')
    expect(shadow.color).toBe('#ffffff') // exact endpoint at t=1
    expect(out[0]).not.toBe(layers[0])
  })
})

describe('applyEffectDialTracks — legacy layer', () => {
  it('resolves via the deterministic id and folds torn_edge into .effects, clearing the field', () => {
    // Old shape: no ids on effects, a LIVE `tornEdge` field. `effectStackOf` mints
    // `fx:<type>:<ordinal>` ids and folds the torn edge in; the fold targets that minted id.
    const raw = asLayer({
      id: 'L4',
      effects: [{ type: 'grain', amount: 0.2, size: 2 }],
      tornEdge: { style: 'shredded', amount: 40, roughness: 0.2, grain: 5, grainTexture: 0.5, lipWidth: 8, lipVariation: 0.6, lipColor: '#fbf6ee', seed: 3 },
    })
    const layers = [raw]
    // Confirm the id-stamped stack has exactly one torn_edge before the fold.
    expect(effectStackOf(raw).filter(e => e.type === 'torn_edge')).toHaveLength(1)

    const tracks: EffectDialTrack[] = [{
      target: 'layers.L4.effects.fx:torn_edge:0.amount',
      keyframes: [{ t: 0, v: 40 }, { t: 1, v: 80 }],
    }]
    const out = applyEffectDialTracks(layers, tracks, 1)
    const clone = out[0] as any
    expect(clone).not.toBe(raw)
    expect(clone.tornEdge).toBeUndefined()   // legacy field cleared (writeStackToLayer shape)
    expect(clone.feather).toBeUndefined()

    // The value folded into .effects, and effectStackOf does NOT double the torn edge.
    const stackAfter = effectStackOf(clone)
    const torn = stackAfter.filter(e => e.type === 'torn_edge')
    expect(torn).toHaveLength(1)
    expect((torn[0] as any).amount).toBe(80)
  })
})
