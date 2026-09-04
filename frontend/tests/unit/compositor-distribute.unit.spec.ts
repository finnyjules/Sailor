import { describe, it, expect } from 'vitest'
import { layerPaletteAssignments } from '~/lib/compositor/distribute'

describe('layerPaletteAssignments', () => {
  it('assigns one color per layer, cycling when short', () => {
    expect(layerPaletteAssignments(['a', 'b', 'c'], ['#1', '#2'])).toEqual({ a: '#1', b: '#2', c: '#1' })
  })
  it('resamples down when colors exceed layers', () => {
    expect(layerPaletteAssignments(['a', 'b'], ['#1', '#2', '#3', '#4'])).toEqual({ a: '#1', b: '#4' })
  })
})
