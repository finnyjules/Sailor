// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { setRelightBypass, relightBypassed } from '~/composables/useCompositorLayers'

describe('relight compare bypass', () => {
  it('bypasses one layer at a time and clears', () => {
    setRelightBypass('a')
    expect(relightBypassed('a')).toBe(true)
    expect(relightBypassed('b')).toBe(false)
    setRelightBypass(null)
    expect(relightBypassed('a')).toBe(false)
  })
})
