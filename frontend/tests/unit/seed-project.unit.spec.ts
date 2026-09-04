import { describe, it, expect } from 'vitest'
import { gradientize, paletteize, distribute } from '~/lib/color/project'
import { hexToOklch } from '~/lib/color/convert'

describe('gradientize', () => {
  it('preserves the input colors verbatim (does NOT relight like toStops)', () => {
    const hexes = ['#b64a1f', '#e8985e', '#3d2c24', '#f4e3d0']
    const stops = gradientize(hexes)
    // every input color survives exactly, only reordered by lightness
    expect(new Set(stops.map(s => s.color))).toEqual(new Set(hexes))
  })
  it('orders stops by ascending lightness with even positions', () => {
    const stops = gradientize(['#f4e3d0', '#3d2c24', '#b64a1f'])
    const Ls = stops.map(s => hexToOklch(s.color)[0])
    for (let i = 1; i < Ls.length; i++) expect(Ls[i]!).toBeGreaterThanOrEqual(Ls[i - 1]!)
    expect(stops.map(s => s.pos)).toEqual([0, 0.5, 1])
  })
})
describe('paletteize', () => {
  it('is identity', () => {
    expect(paletteize(['#a', '#b'] as string[])).toEqual(['#a', '#b'])
  })
})
describe('distribute', () => {
  it('cycles when slots exceed colors', () => {
    expect(distribute(['#1', '#2'], 5, 'cycle')).toEqual(['#1', '#2', '#1', '#2', '#1'])
  })
  it('truncates evenly when colors exceed slots', () => {
    expect(distribute(['#1', '#2', '#3', '#4', '#5'], 3)).toEqual(['#1', '#3', '#5'])
  })
  it('1:1 when equal', () => {
    expect(distribute(['#1', '#2', '#3'], 3)).toEqual(['#1', '#2', '#3'])
  })
})
