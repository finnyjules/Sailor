import { describe, it, expect } from 'vitest'
import { dialSpecsFor } from '~/lib/compositor/effectDials'

describe('gradientMap gradient dial', () => {
  it('lists a gradient-kind stops dial', () => {
    const dials = dialSpecsFor('gradientMap')
    const stops = dials.find(d => d.key === 'stops')
    expect(stops).toBeTruthy()
    expect(stops!.kind).toBe('gradient')
  })
  it('keeps the scalar dials too', () => {
    const keys = dialSpecsFor('gradientMap').map(d => d.key)
    expect(keys).toEqual(expect.arrayContaining(['contrast', 'mix', 'scrollPhase', 'stops']))
  })
})
