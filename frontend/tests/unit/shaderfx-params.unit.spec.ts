import { describe, expect, it } from 'vitest'
import { parseParams, resolveUniforms, serializeParams } from '~/lib/shaderfx/params'
import type { EffectDef } from '~/lib/shaderfx/types'

const eff: EffectDef = {
  id: 'x', name: 'X', category: 'distortion', animated: true, passes: 1,
  centerParam: null, textures: [], source: '',
  params: [
    { uniform: 'u_amount', label: 'Amount', type: 'float', min: 0, max: 0.3, default: 0.06, step: 0.005 },
    { uniform: 'u_scale', label: 'Scale', type: 'float', min: 1, max: 20, default: 4, step: 0.5 },
  ],
}

describe('shaderfx params', () => {
  it('parses bad JSON to empty object', () => {
    expect(parseParams('{nope')).toEqual({})
    expect(parseParams('')).toEqual({})
  })

  it('resolves defaults, clamps overrides, drops unknown keys', () => {
    expect(resolveUniforms(eff, {})).toEqual({ u_amount: 0.06, u_scale: 4 })
    const u = resolveUniforms(eff, { u_amount: 99, u_bogus: 1 })
    expect(u.u_amount).toBe(0.3)
    expect('u_bogus' in u).toBe(false)
  })

  it('serializes only non-default values', () => {
    expect(serializeParams(eff, { u_amount: 0.06, u_scale: 9 })).toBe('{"u_scale":9}')
    expect(serializeParams(eff, { u_amount: 0.06, u_scale: 4 })).toBe('{}')
  })
})

const enumEff: EffectDef = {
  id: 'd', name: 'Dither', category: 'stylize', animated: false, passes: 1,
  centerParam: null, textures: [], source: '',
  params: [
    { uniform: 'u_pattern', label: 'Pattern', type: 'enum', default: 1,
      options: [{ label: 'A', value: 0 }, { label: 'B', value: 1 }, { label: 'C', value: 2 }] },
    { uniform: 'u_scale', label: 'Scale', type: 'float', min: 1, max: 10, default: 4, step: 1 },
  ],
}

describe('shaderfx params — enum', () => {
  it('defaults the enum when missing', () => {
    expect(resolveUniforms(enumEff, {})).toEqual({ u_pattern: 1, u_scale: 4 })
  })
  it('keeps a valid enum value and clamps floats', () => {
    const u = resolveUniforms(enumEff, { u_pattern: 2, u_scale: 999 })
    expect(u.u_pattern).toBe(2)
    expect(u.u_scale).toBe(10)
  })
  it('falls back to default on invalid enum value', () => {
    expect(resolveUniforms(enumEff, { u_pattern: 99 }).u_pattern).toBe(1)
  })
})

describe('shaderfx params — serializeParams enum round-trip', () => {
  it('stores only non-default enum value', () => {
    expect(serializeParams(enumEff, { u_pattern: 2, u_scale: 4 })).toBe('{"u_pattern":2}')
  })
  it('omits enum when at default', () => {
    expect(serializeParams(enumEff, { u_pattern: 1, u_scale: 4 })).toBe('{}')
  })
})
