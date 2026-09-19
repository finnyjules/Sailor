import { describe, it, expect } from 'vitest'
import { effectDialTargets } from '~/lib/motion/effectTracks'
import { effectStackOf, type EffectInstance } from '~/lib/compositor/effectStack'
import { getByIdPath } from '~/lib/studio/idPath'
import type { LocalLayer } from '~/composables/useCompositorLayers'

/**
 * F8 · `effectDialTargets` enumerates a layer's animatable dials as id-paths
 * (`layers.<id>.effects.<effectId>.<dial>`). These tests prove the paths are correct for a
 * new-shape layer (effects carry stored ids) AND a legacy layer (deterministic minted ids),
 * and that a path round-trips through `getByIdPath` to the live dial value — the whole point
 * of addressing by id instead of position.
 *
 * `effectDialTargets` reads only `.id` / `.effects` / `.tornEdge` / `.feather`, so a minimal
 * object cast to `LocalLayer` exercises it faithfully without building a full union member.
 */
const asLayer = (o: Record<string, unknown>): LocalLayer => o as unknown as LocalLayer

describe('effectDialTargets — new-shape layer (stored ids)', () => {
  const layer = asLayer({
    id: 'L1',
    effects: [
      { id: 'e-shadow', type: 'drop_shadow', color: '#123456', x: 0.03, y: 0.04, blur: 0.05, visible: true },
      { id: 'e-grain', type: 'grain', amount: 0.4, size: 3, visible: true },
    ],
  })

  it('emits layers.<id>.effects.<effectId>.<dial> paths for each dial', () => {
    const targets = effectDialTargets(layer)
    const paths = targets.map(t => t.path)
    // drop_shadow: x, y, blur, color ; grain: amount, size
    expect(paths).toContain('layers.L1.effects.e-shadow.x')
    expect(paths).toContain('layers.L1.effects.e-shadow.y')
    expect(paths).toContain('layers.L1.effects.e-shadow.blur')
    expect(paths).toContain('layers.L1.effects.e-shadow.color')
    expect(paths).toContain('layers.L1.effects.e-grain.amount')
    expect(paths).toContain('layers.L1.effects.e-grain.size')
  })

  it('carries kind, effectId, dialKey and a sentence-case label', () => {
    const targets = effectDialTargets(layer)
    const blur = targets.find(t => t.path === 'layers.L1.effects.e-shadow.blur')!
    expect(blur.kind).toBe('number')
    expect(blur.effectId).toBe('e-shadow')
    expect(blur.dialKey).toBe('blur')
    expect(blur.label).toBe('Drop shadow · Blur')
    const colour = targets.find(t => t.path === 'layers.L1.effects.e-shadow.color')!
    expect(colour.kind).toBe('color')
    expect(colour.label).toBe('Drop shadow · Colour')
  })

  it('a target path resolves back through getByIdPath to the live dial value', () => {
    const targets = effectDialTargets(layer)
    const blur = targets.find(t => t.path === 'layers.L1.effects.e-shadow.blur')!
    expect(getByIdPath({ layers: [layer] }, blur.path)).toBe(0.05)
    const colour = targets.find(t => t.path === 'layers.L1.effects.e-shadow.color')!
    expect(getByIdPath({ layers: [layer] }, colour.path)).toBe('#123456')
  })
})

describe('effectDialTargets — legacy layer (deterministic minted ids)', () => {
  // Old shape: effects stored WITHOUT ids. `effectStackOf` mints `fx:<type>:<ordinal>` on
  // read; `effectDialTargets` builds its paths from those same ids.
  const raw = asLayer({
    id: 'L2',
    effects: [
      { type: 'drop_shadow', color: '#abcdef', x: 0.01, y: 0.02, blur: 0.03 },
      { type: 'drop_shadow', color: '#fedcba', x: 0.06, y: 0.07, blur: 0.08 },
    ],
  })

  it('uses the deterministic fx:<type>:<ordinal> ids', () => {
    const paths = effectDialTargets(raw).map(t => t.path)
    expect(paths).toContain('layers.L2.effects.fx:drop_shadow:0.blur')
    expect(paths).toContain('layers.L2.effects.fx:drop_shadow:1.blur')
  })

  it('round-trips against the id-stamped stack (how the Task 3 fold operates)', () => {
    // The fold rebuilds `.effects` from `effectStackOf(layer)` (id-stamped) before writing;
    // resolving a legacy path requires that same id-stamped layer, since the raw stored
    // effects carry no ids for the resolver to match.
    const stack: EffectInstance[] = effectStackOf(raw)
    const stamped = asLayer({ ...(raw as unknown as Record<string, unknown>), effects: stack })
    const targets = effectDialTargets(raw)

    const first = targets.find(t => t.path === 'layers.L2.effects.fx:drop_shadow:0.blur')!
    expect(getByIdPath({ layers: [stamped] }, first.path)).toBe(0.03)
    const second = targets.find(t => t.path === 'layers.L2.effects.fx:drop_shadow:1.color')!
    expect(getByIdPath({ layers: [stamped] }, second.path)).toBe('#fedcba')
  })
})

describe('effectDialTargets — folds legacy tornEdge into a target', () => {
  // A live legacy `tornEdge` field is folded into the stack by `effectStockOf` as a
  // `torn_edge` effect at its pipeline position — so its dials must enumerate too.
  const raw = asLayer({
    id: 'L3',
    effects: [],
    tornEdge: { style: 'shredded', amount: 40, roughness: 0.2, grain: 5, grainTexture: 0.5, lipWidth: 8, lipVariation: 0.6, lipColor: '#fbf6ee', seed: 3 },
  })

  it('enumerates the torn-edge dials and round-trips against the id-stamped stack', () => {
    const targets = effectDialTargets(raw)
    const amount = targets.find(t => t.dialKey === 'amount' && t.effectId.startsWith('fx:torn_edge'))
    expect(amount, 'torn_edge amount target').toBeTruthy()

    const stamped = asLayer({ ...(raw as unknown as Record<string, unknown>), effects: effectStackOf(raw) })
    expect(getByIdPath({ layers: [stamped] }, amount!.path)).toBe(40)
  })
})
