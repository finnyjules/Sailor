import { describe, it, expect } from 'vitest'
import { HOLOGRAPHIC_FILL_PRESET, FILL_TYPES, DEFAULT_FILL, fillPickerType } from '~/lib/spacetype/fillTile'

describe('holographic fill preset', () => {
  it('is a shader fill naming the generative effect', () => {
    expect(HOLOGRAPHIC_FILL_PRESET.type).toBe('shader')
    expect(HOLOGRAPHIC_FILL_PRESET.shader?.effectId).toBe('holographic_surface')
  })

  it('keys its params without the u_ prefix', () => {
    const keys = Object.keys(HOLOGRAPHIC_FILL_PRESET.shader!.params)
    expect(keys).toContain('surface')
    expect(keys.some((k) => k.startsWith('u_'))).toBe(false)
  })

  it('does NOT add a member to FILL_TYPES', () => {
    // The whole point of a preset. Twelve modules read this constant.
    expect(FILL_TYPES).not.toContain('holographic' as never)
    expect(FILL_TYPES).toHaveLength(11)
  })

  it('carries an input, because ShaderSpec requires one even generatively', () => {
    expect(HOLOGRAPHIC_FILL_PRESET.shader?.input).toBeDefined()
  })
})

describe('fillPickerType', () => {
  it('reports the holographic_surface shader fill as "holographic"', () => {
    expect(fillPickerType(HOLOGRAPHIC_FILL_PRESET)).toBe('holographic')
  })

  it('reports any other shader fill as "shader"', () => {
    const otherShader = { ...DEFAULT_FILL, type: 'shader' as const, shader: { effectId: 'fbm_warp', params: {}, anchor: 'object' as const, speed: 1, seed: 42, input: DEFAULT_FILL } }
    expect(fillPickerType(otherShader)).toBe('shader')
  })

  it('reports a solid fill as "solid"', () => {
    expect(fillPickerType(DEFAULT_FILL)).toBe('solid')
  })
})
