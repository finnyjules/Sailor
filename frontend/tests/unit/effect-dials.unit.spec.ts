import { describe, it, expect } from 'vitest'
import {
  EFFECT_DIAL_SCHEMA,
  dialSpecsFor,
  type DialSpec,
} from '~/lib/compositor/effectDials'
import {
  EFFECT_ORDER,
  createEffect,
  type EffectKind,
} from '~/lib/compositor/effectStack'

/**
 * F8 · The dial schema is the declarative table of animatable effect dials. These tests are
 * the DEAD-CONTROL GUARD (the F8 acceptance gate): every key must be a real field on its
 * effect's interface, so no target ever names a dial the renderer does not read.
 */
describe('EFFECT_DIAL_SCHEMA', () => {
  it('is a total record over every EffectKind', () => {
    // EFFECT_ORDER `satisfies readonly EffectKind[]` and lists every member of the union,
    // so it is the authoritative key set to check totality against.
    for (const kind of EFFECT_ORDER) {
      expect(EFFECT_DIAL_SCHEMA, `missing schema entry for ${kind}`).toHaveProperty(kind)
      expect(Array.isArray(EFFECT_DIAL_SCHEMA[kind])).toBe(true)
    }
    // And no stray keys beyond the union.
    for (const key of Object.keys(EFFECT_DIAL_SCHEMA)) {
      expect(EFFECT_ORDER as readonly string[]).toContain(key)
    }
  })

  it('every dial key is a real top-level field on its effect interface', () => {
    for (const kind of EFFECT_ORDER) {
      const inst = createEffect(kind) as unknown as Record<string, unknown>
      for (const spec of EFFECT_DIAL_SCHEMA[kind]) {
        expect(spec.key in inst, `${kind}.${spec.key} is not a real field`).toBe(true)
      }
    }
  })

  it('never lists an excluded field (seed / visible / type / id / enum-pick / nested)', () => {
    const banned = new Set([
      'seed', 'visible', 'type', 'id',
      // enum / pick fields and sibling refs
      'op', 'field', 'blend', 'align', 'style', 'curve', 'refLayerId', 'effectId',
      // nested / complex — `stops` is now the one permitted exception: Plan 3 gives
      // gradientMap.stops its own `gradient`-kind dial (see the next assertion), so it is
      // excluded from this ban rather than added to a per-kind allowlist.
      'params',
    ])
    for (const kind of EFFECT_ORDER) {
      for (const spec of EFFECT_DIAL_SCHEMA[kind]) {
        expect(banned.has(spec.key), `${kind}.${spec.key} should be excluded`).toBe(false)
      }
    }
  })

  it('emits only number, colour, and gradient specs (gradient reserved for gradientMap.stops)', () => {
    for (const kind of EFFECT_ORDER) {
      for (const spec of EFFECT_DIAL_SCHEMA[kind]) {
        expect(['number', 'color', 'gradient']).toContain(spec.kind)
        if (spec.kind === 'gradient') {
          expect(kind, `${kind}.${spec.key} is gradient-kind outside gradientMap`).toBe('gradientMap')
          expect(spec.key).toBe('stops')
        }
      }
    }
  })

  it('number specs carry a min/max range; colour specs do not', () => {
    for (const kind of EFFECT_ORDER) {
      for (const spec of EFFECT_DIAL_SCHEMA[kind]) {
        if (spec.kind === 'number') {
          expect(typeof spec.min, `${kind}.${spec.key} min`).toBe('number')
          expect(typeof spec.max, `${kind}.${spec.key} max`).toBe('number')
          expect(spec.min! < spec.max!, `${kind}.${spec.key} min<max`).toBe(true)
        }
      }
    }
  })

  it('pins the known colour dials to kind "color"', () => {
    const colourDials: Array<[EffectKind, string]> = [
      ['drop_shadow', 'color'],
      ['inner_shadow', 'color'],
      ['long_shadow', 'color'],
      ['inner_glow', 'color'],
      ['outer_glow', 'color'],
      ['color_overlay', 'color'],
      ['gradient_overlay', 'from'],
      ['gradient_overlay', 'to'],
      ['stroke_from_alpha', 'color'],
      ['duotone', 'shadows'],
      ['duotone', 'highlights'],
      ['risograph', 'ink'],
      ['risograph', 'inkTwo'],
      ['letterpress', 'ink'],
      ['torn_edge', 'lipColor'],
    ]
    for (const [kind, key] of colourDials) {
      const spec = EFFECT_DIAL_SCHEMA[kind].find(s => s.key === key)
      expect(spec, `${kind}.${key} missing`).toBeTruthy()
      expect(spec!.kind).toBe('color')
    }
  })

  it('has no duplicate dial keys within a kind', () => {
    for (const kind of EFFECT_ORDER) {
      const keys = EFFECT_DIAL_SCHEMA[kind].map((s: DialSpec) => s.key)
      expect(new Set(keys).size, `${kind} has duplicate keys`).toBe(keys.length)
    }
  })

  it('dialSpecsFor mirrors the table', () => {
    for (const kind of EFFECT_ORDER) {
      expect(dialSpecsFor(kind)).toBe(EFFECT_DIAL_SCHEMA[kind])
    }
  })

  it('boolean has no animatable dials (op + sibling ref only)', () => {
    expect(dialSpecsFor('boolean')).toEqual([])
  })
})
