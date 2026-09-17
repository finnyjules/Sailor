import { describe, it, expect } from 'vitest'
import { evaluateTracks } from '~/lib/motionx/evaluate'
import type { Track } from '~/lib/motionx/types'

describe('evaluateTracks', () => {
  const tracks: Track[] = [
    { path: 'opacity', type: 'number', keyframes: [{ t: 0, value: 0, ease: 'linear' }, { t: 1, value: 1, ease: 'linear' }] },
    { path: 'x', type: 'number', keyframes: [{ t: 0, value: 0, ease: 'linear' }, { t: 1, value: 100, ease: 'linear' }] },
  ]
  it('maps path -> value at t', () => {
    const m = evaluateTracks(tracks, 0.5)
    expect(m.get('opacity')).toBeCloseTo(0.5, 6)
    expect(m.get('x')).toBeCloseTo(50, 6)
  })
  it('empty tracks -> empty map', () => {
    expect(evaluateTracks([], 0).size).toBe(0)
  })
})
