import { describe, it, expect } from 'vitest'
import { evaluateTrack } from '~/lib/motionx/track'
import type { Track } from '~/lib/motionx/types'

describe('evaluateTrack', () => {
  const num: Track = { path: 'opacity', type: 'number', keyframes: [
    { t: 0, value: 0, ease: 'linear' }, { t: 2, value: 10, ease: 'linear' },
  ] }
  it('undefined for empty', () => {
    expect(evaluateTrack({ path: 'x', type: 'number', keyframes: [] }, 0)).toBeUndefined()
  })
  it('clamps and interpolates', () => {
    expect(evaluateTrack(num, -1)).toBe(0)
    expect(evaluateTrack(num, 3)).toBe(10)
    expect(evaluateTrack(num, 1)).toBeCloseTo(5, 6)
  })
  it('applies the FROM keyframe ease', () => {
    const eased: Track = { path: 'o', type: 'number', keyframes: [
      { t: 0, value: 0, ease: 'easeIn' }, { t: 1, value: 1, ease: 'linear' },
    ] }
    expect(evaluateTrack(eased, 0.5)).toBeCloseTo(0.25, 6) // easeIn(0.5)=0.25
  })
  it('loop wraps t into the keyframe span', () => {
    const loopT = { path: 'p', type: 'number' as const, loop: true, keyframes: [
      { t: 0, value: 0, ease: 'linear' as const }, { t: 2, value: 1, ease: 'linear' as const } ] }
    expect(evaluateTrack(loopT, 0)).toBe(0)
    expect(evaluateTrack(loopT, 2.0)).toBeCloseTo(0, 6) // wraps
    expect(evaluateTrack(loopT, 3.0)).toBeCloseTo(0.5, 6)
  })
})
