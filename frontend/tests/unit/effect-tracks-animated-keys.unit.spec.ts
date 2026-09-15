import { describe, it, expect } from 'vitest'
import { effectDialTargets, animatedDialKeysOf, type EffectDialTrack } from '~/lib/motion/effectTracks'
import type { LocalLayer } from '~/composables/useCompositorLayers'

/**
 * F8 Task 6 · `animatedDialKeysOf` — the pure core behind the effect inspector's
 * "animated" (variable) signal. Given a layer's enumerated dial targets, the open
 * effect's id, and the frame's tracks, it returns the set of THAT effect's dial keys
 * a track drives. The inspector uses it to draw the summary + lock the driven dials.
 */
const asLayer = (o: Record<string, unknown>): LocalLayer => o as unknown as LocalLayer

const layer = asLayer({
  id: 'L1',
  effects: [
    { id: 'e-shadow', type: 'drop_shadow', color: '#123456', x: 0.03, y: 0.04, blur: 0.05, visible: true },
    { id: 'e-grain', type: 'grain', amount: 0.4, size: 3, visible: true },
  ],
})
const targets = effectDialTargets(layer)

describe('animatedDialKeysOf', () => {
  it('returns the dial keys of the given effect that a track targets', () => {
    const tracks: EffectDialTrack[] = [
      { target: 'layers.L1.effects.e-grain.amount', keyframes: [{ t: 0, v: 0 }] },
    ]
    expect([...animatedDialKeysOf(targets, 'e-grain', tracks)]).toEqual(['amount'])
  })

  it('scopes to the effect id — a track on a sibling effect does not leak in', () => {
    const tracks: EffectDialTrack[] = [
      { target: 'layers.L1.effects.e-shadow.blur', keyframes: [{ t: 0, v: 0 }] },
    ]
    // Asked about the grain effect → empty; asked about the shadow effect → { blur }.
    expect(animatedDialKeysOf(targets, 'e-grain', tracks).size).toBe(0)
    expect([...animatedDialKeysOf(targets, 'e-shadow', tracks)]).toEqual(['blur'])
  })

  it('collects every driven dial on the effect', () => {
    const tracks: EffectDialTrack[] = [
      { target: 'layers.L1.effects.e-shadow.x', keyframes: [{ t: 0, v: 0 }] },
      { target: 'layers.L1.effects.e-shadow.color', keyframes: [{ t: 0, v: '#fff' }] },
    ]
    const keys = animatedDialKeysOf(targets, 'e-shadow', tracks)
    expect(keys.has('x')).toBe(true)
    expect(keys.has('color')).toBe(true)
    expect(keys.has('y')).toBe(false)
  })

  it('is empty for no tracks, undefined tracks, or a foreign/unknown target', () => {
    expect(animatedDialKeysOf(targets, 'e-grain', []).size).toBe(0)
    expect(animatedDialKeysOf(targets, 'e-grain', undefined).size).toBe(0)
    const foreign: EffectDialTrack[] = [
      { target: 'layers.OTHER.effects.e-grain.amount', keyframes: [{ t: 0, v: 0 }] },
    ]
    expect(animatedDialKeysOf(targets, 'e-grain', foreign).size).toBe(0)
  })
})
