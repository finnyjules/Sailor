import { describe, it, expect } from 'vitest'
import { fieldKey, specIdentityKey } from '~/lib/shaderfill/descriptor'
import { DEFAULT_SHADER_SPEC } from '~/lib/spacetype/fillTile'

const base = { ...DEFAULT_SHADER_SPEC, seed: 42 }

describe('shader fill seed is part of the cache identity', () => {
  it('two seeds produce different fieldKeys', () => {
    const a = fieldKey(base, 100, 100, 0)
    const b = fieldKey({ ...base, seed: 43 }, 100, 100, 0)
    expect(a).not.toBe(b)
  })
  it('two seeds produce different specIdentityKeys', () => {
    expect(specIdentityKey(base)).not.toBe(specIdentityKey({ ...base, seed: 43 }))
  })
  it('the same seed is stable', () => {
    expect(specIdentityKey(base)).toBe(specIdentityKey({ ...base, seed: 42 }))
  })
})
