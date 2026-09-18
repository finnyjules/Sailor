import { describe, it, expect } from 'vitest'
import { progress } from '~/lib/motionx/timing'

describe('progress', () => {
  const T = { start: 0, duration: 2 }
  it('0 before start, 1 after end (non-loop)', () => {
    expect(progress(T, -1)).toBe(0)
    expect(progress(T, 0)).toBe(0)
    expect(progress(T, 1)).toBeCloseTo(0.5, 6)
    expect(progress(T, 2)).toBe(1)
    expect(progress(T, 5)).toBe(1)
  })
  it('start + delay shift the window', () => {
    expect(progress({ start: 1, duration: 2, delay: 0.5 }, 1.4)).toBe(0)
    expect(progress({ start: 1, duration: 2, delay: 0.5 }, 2.5)).toBeCloseTo(0.5, 6)
  })
  it('loop wraps', () => {
    expect(progress({ start: 0, duration: 2, loop: true }, 3)).toBeCloseTo(0.5, 6)
    expect(progress({ start: 0, duration: 2, loop: true }, 4)).toBeCloseTo(0, 6)
  })
  it('hold flattens extremes', () => {
    const H = { start: 0, duration: 1, hold: 0.25 }
    expect(progress(H, 0.2)).toBe(0)     // inside the leading hold
    expect(progress(H, 0.5)).toBeCloseTo(0.5, 6)
    expect(progress(H, 0.8)).toBe(1)     // inside the trailing hold
  })
})
