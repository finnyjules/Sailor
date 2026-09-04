import { describe, it, expect } from 'vitest'
import { distributeToGeoFills } from '~/lib/geoshape/distribute'

describe('distributeToGeoFills', () => {
  it('lands the palette as discrete fills', () => {
    const out = distributeToGeoFills({ fills: ['#000'], fillStrategy: 'single' }, ['#b64a1f', '#e8985e', '#f4e3d0'])
    expect(out.fills).toEqual(['#b64a1f', '#e8985e', '#f4e3d0'])
  })
  it('flips fillStrategy off single so the write is visible', () => {
    const out = distributeToGeoFills({ fills: ['#000'], fillStrategy: 'single' }, ['#a', '#b'])
    expect(out.fillStrategy).toBe('perClone')
  })
  it('leaves a non-single strategy untouched', () => {
    const out = distributeToGeoFills({ fills: ['#000'], fillStrategy: 'pieces' }, ['#a', '#b'])
    expect(out.fillStrategy).toBe('pieces')
  })
})
