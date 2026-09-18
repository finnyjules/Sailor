import { describe, it, expect } from 'vitest'
import { evaluateTracks } from '~/lib/motionx/evaluate'
import { evaluateTrack } from '~/lib/motionx/track'
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

describe('evaluateTracks precedence: most recently STARTED band wins on a shared path', () => {
  const num = (start: number, a: number, b: number, dur = 1): Track => ({
    path: 'opacity', type: 'number', keyframes: [{ t: start, value: a, ease: 'linear' }, { t: start + dur, value: b, ease: 'linear' }],
  })
  it('In then Out on one property: the fade-in plays, holds, then the later-starting fade-out takes over', () => {
    const fadeIn = num(0, 0, 1)      // 0..1s
    const fadeOut = num(3, 1, 0)     // 3..4s, added LATER in the array
    const tracks = [fadeIn, fadeOut]
    expect(evaluateTracks(tracks, 0.5).get('opacity')).toBeCloseTo(0.5, 6)  // fade-in in charge (fade-out not started)
    expect(evaluateTracks(tracks, 2).get('opacity')).toBe(1)                 // fade-in holds its end
    expect(evaluateTracks(tracks, 3.5).get('opacity')).toBeCloseTo(0.5, 6)  // fade-out started later → wins
  })
  it('before ANY band has started, the earliest-starting band\'s lead-in value holds (single-track byte-identity)', () => {
    const late = num(1, 0, 1)
    expect(evaluateTracks([late], 0.5).get('opacity')).toBe(0)   // same as evaluateTrack alone (hold-before)
    expect(evaluateTracks([late], 0.5).get('opacity')).toBe(evaluateTrack(late, 0.5))
  })
  it('same start time → the later-added band wins (deterministic tie-break)', () => {
    const a = num(0, 0, 1), b = num(0, 1, 0)
    expect(evaluateTracks([a, b], 0.25).get('opacity')).toBeCloseTo(0.75, 6)
    expect(evaluateTracks([b, a], 0.25).get('opacity')).toBeCloseTo(0.25, 6)
  })
})
