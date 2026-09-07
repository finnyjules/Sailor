import { describe, it, expect } from 'vitest'
import { MODIFIER_SPECS, modifierValue, varySettingsFor } from '~/lib/scene3d/primParams'
import { sanitizeVaryPalette } from '~/lib/scene3d/config'
import { DEFAULT_VARY, varyColorAt } from '~/lib/vary'

const KEYS = ['varyMode', 'varySeed', 'varyFalloffCenter', 'varyFalloffRadius',
  'varyColor', 'varyColorSpread', 'varyColorStrength']

describe('vary modifier schema', () => {
  it('declares every vary key', () => {
    for (const k of KEYS) expect(MODIFIER_SPECS.find((s) => s.key === k), k).toBeTruthy()
  })

  it('defaults to the identity — a fresh object has no variation', () => {
    expect(modifierValue(undefined, 'varyMode')).toBe(0)
    expect(modifierValue(undefined, 'varyColor')).toBe(0)
    expect(modifierValue(undefined, 'varyColorStrength')).toBe(1)
  })

  it('keeps the option lists append-only in their pinned order', () => {
    const mode = MODIFIER_SPECS.find((s) => s.key === 'varyMode')!
    expect(mode.options).toEqual(['sequence', 'random', 'falloff'])
    const spread = MODIFIER_SPECS.find((s) => s.key === 'varyColorSpread')!
    expect(spread.options).toEqual(['cycle', 'blend'])
  })
})

describe('sanitizeVaryPalette', () => {
  it('drops anything that is not a list of hex strings', () => {
    expect(sanitizeVaryPalette(undefined)).toBeUndefined()
    expect(sanitizeVaryPalette('#ff0000')).toBeUndefined()
    expect(sanitizeVaryPalette([])).toBeUndefined()
    expect(sanitizeVaryPalette(['nope', 42])).toBeUndefined()
  })

  it('keeps valid swatches and caps the length', () => {
    expect(sanitizeVaryPalette(['#ff0000', '#0f0'])).toEqual(['#ff0000', '#0f0'])
    const long = Array.from({ length: 12 }, () => '#123456')
    expect(sanitizeVaryPalette(long)!.length).toBe(8)
  })
})

describe('varySettingsFor', () => {
  const obj = (modifiers?: Record<string, number>, varyPalette?: string[]) =>
    ({ id: 'o', kind: 'primitive', primitive: 'box', modifiers, varyPalette }) as never

  it('reads the identity for an untouched object', () => {
    const v = varySettingsFor(obj())
    expect(v.mode).toBe('sequence')
    expect(v.colorEnabled).toBe(false)
    expect(v.palette).toEqual(DEFAULT_VARY.palette)
  })

  it('maps the stored indexes back to names', () => {
    const v = varySettingsFor(obj({ varyMode: 2, varyColor: 1, varyColorSpread: 1 }, ['#abcdef']))
    expect(v.mode).toBe('falloff')
    expect(v.spread).toBe('blend')
    expect(v.colorEnabled).toBe(true)
    expect(v.palette).toEqual(['#abcdef'])
  })

  it('honours a deliberately EMPTIED palette rather than substituting the default', () => {
    // Same rule as `varyOf` in composables/useCloner.ts: MISSING gets the default (above),
    // EMPTY stays empty, because `lib/vary` treats an empty palette as "colour off".
    const v = varySettingsFor(obj({ varyColor: 1 }, []))
    expect(v.palette).toEqual([])
    expect(varyColorAt(0.5, 0, v)).toBeUndefined()
  })
})
