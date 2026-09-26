import { describe, it, expect } from 'vitest'
import { paintKey } from '~/lib/brushTips/coverage'
describe('paintKey', () => {
  it('is empty without paint and stable when still', () => {
    expect(paintKey(undefined)).toBe('')
    expect(paintKey({ material: 'lava', t: 0 })).toBe('lava@0')
  })
  it('buckets moving time to 1/30 s', () => {
    expect(paintKey({ material: 'foil', t: 1.001 })).toBe(paintKey({ material: 'foil', t: 1.01 }))
    expect(paintKey({ material: 'foil', t: 1.0 })).not.toBe(paintKey({ material: 'foil', t: 1.05 }))
  })
  it('an exact (export) paint keys on its exact time, never the bucket', () => {
    expect(paintKey({ material: 'foil', t: 1.001, exact: true })).not.toBe(paintKey({ material: 'foil', t: 1.01, exact: true }))
    expect(paintKey({ material: 'foil', t: 0, exact: true })).toBe('foil@0')
  })
})
