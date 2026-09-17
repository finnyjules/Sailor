import { describe, it, expect } from 'vitest'
import { scrolledGradientMapStops } from '~/lib/compositor/postEffects'

const STOPS = [
  { pos: 0, color: '#1436ff' }, { pos: 0.5, color: '#ff2d2d' }, { pos: 1, color: '#ffd21f' },
]

describe('scrolledGradientMapStops', () => {
  it('is identity at phase 0 (same reference)', () => {
    expect(scrolledGradientMapStops(STOPS, 0)).toBe(STOPS)
  })
  it('returns a scrolled wheel at phase > 0', () => {
    const out = scrolledGradientMapStops(STOPS, 0.25)
    expect(out).not.toBe(STOPS)
    expect(out[0]).toHaveProperty('pos')
    expect(out[0]).toHaveProperty('color')
    expect(out.length).toBeGreaterThan(3)
  })
})
