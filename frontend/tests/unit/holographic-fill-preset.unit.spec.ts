import { describe, it, expect } from 'vitest'
import { HOLOGRAPHIC_FILL_PRESET, FILL_TYPES } from '~/lib/spacetype/fillTile'

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
