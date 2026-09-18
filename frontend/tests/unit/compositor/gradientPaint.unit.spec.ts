import { describe, it, expect } from 'vitest'
import type { Gradient } from '~/lib/compositor/paint'
import { paintStopsToColor, withScrolledStops, withGradientStops } from '~/lib/compositor/gradientPaint'

const G: Gradient = { type: 'linear', angle: 45, stops: [
  { offset: 0, color: '#1436ff' }, { offset: 0.5, color: '#ff2d2d' }, { offset: 1, color: '#ffd21f' },
] }

describe('paintStopsToColor', () => {
  it('maps offset→pos', () => {
    expect(paintStopsToColor(G)).toEqual([
      { pos: 0, color: '#1436ff' }, { pos: 0.5, color: '#ff2d2d' }, { pos: 1, color: '#ffd21f' },
    ])
  })
})

describe('withScrolledStops', () => {
  it('keeps type + angle and returns offset-shaped stops', () => {
    const out = withScrolledStops(G, 0.25)
    expect(out.type).toBe('linear')
    expect((out as any).angle).toBe(45)
    expect(out.stops[0]).toHaveProperty('offset')
    expect(out.stops[0]).not.toBe(G.stops[0]) // fresh objects, no mutation
  })
  it('is seamless in phase (0 == 1)', () => {
    expect(withScrolledStops(G, 0)).toEqual(withScrolledStops(G, 1))
  })
})

describe('withGradientStops', () => {
  const stops = [
    { pos: 0, color: '#0000ff' }, { pos: 0.5, color: '#00ff00' }, { pos: 1, color: '#ff0000' },
  ]

  it('keeps type + angle and maps pos→offset', () => {
    const out = withGradientStops(G, stops)
    expect(out.type).toBe('linear')
    expect((out as any).angle).toBe(45)
    expect(out.stops).toEqual([
      { offset: 0, color: '#0000ff' }, { offset: 0.5, color: '#00ff00' }, { offset: 1, color: '#ff0000' },
    ])
    expect(out.stops[0]).not.toBe(G.stops[0]) // fresh objects, no mutation
  })

  it('radial omits angle', () => {
    const radial: Gradient = { type: 'radial', stops: G.stops }
    const out = withGradientStops(radial, stops)
    expect(out.type).toBe('radial')
    expect((out as any).angle).toBeUndefined()
  })
})
