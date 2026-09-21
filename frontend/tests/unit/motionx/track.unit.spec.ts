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

describe('evaluateTrack with a bézier segment ease', () => {
  it('interpolates through the custom curve (overshoot goes past the end value mid-segment)', async () => {
    const { evaluateTrack } = await import('~/lib/motionx')
    const tr = { path: 'x', type: 'number' as const, keyframes: [
      { t: 0, value: 0, ease: [0.34, 1.56, 0.64, 1] as [number, number, number, number] },
      { t: 1, value: 10, ease: 'linear' as const },
    ] }
    expect(evaluateTrack(tr, 0)).toBe(0)
    expect(evaluateTrack(tr, 1)).toBe(10)
    expect(evaluateTrack(tr, 0.7) as number).toBeGreaterThan(10)
  })
})

describe('evaluateTrack — steps ease', () => {
  const n = 4
  const tr: Track = { path: 'x', type: 'number', keyframes: [
    { t: 0, value: 0, ease: { type: 'steps', count: n } as never }, { t: 1, value: 1, ease: 'linear' },
  ] }
  it('holds the previous step just before a jump, and lands exactly on it just after', () => {
    const k = 2
    const boundary = k / n
    expect(evaluateTrack(tr, boundary - 0.001)).toBeCloseTo((k - 1) / n, 6)
    expect(evaluateTrack(tr, boundary)).toBeCloseTo(k / n, 6)
    expect(evaluateTrack(tr, boundary + 0.001)).toBeCloseTo(k / n, 6)
  })
  it('starts exactly at 0 and ends exactly at 1', () => {
    expect(evaluateTrack(tr, 0)).toBe(0)
    expect(evaluateTrack(tr, 1)).toBe(1)
  })
})

describe('evaluateTrack — spring tail', () => {
  const spring = { type: 'spring' as const, bounce: 0.5 }
  const tr = { path: 'x', type: 'number' as const, keyframes: [
    { t: 1, value: 0, ease: spring }, { t: 2, value: 10, ease: 'linear' as const },
  ] }
  it('keeps bouncing past the last keyframe, then rests on the end value', async () => {
    const { evaluateTrack } = await import('~/lib/motionx')
    const tail = [2.1, 2.2, 2.3, 2.4, 2.6].map((t) => evaluateTrack(tr, t) as number)
    expect(Math.max(...tail)).toBeGreaterThan(10)
    expect(evaluateTrack(tr, 9)).toBe(10)
    expect(evaluateTrack(tr, 0.5)).toBe(0)
  })
  it('a looping track has no tail (it wraps instead)', async () => {
    const { evaluateTrack } = await import('~/lib/motionx')
    const v = evaluateTrack({ ...tr, loop: true }, 2.2) as number
    expect(v).toBeLessThan(10)
  })
  it('non-spring tracks still hold the last value exactly', async () => {
    const { evaluateTrack } = await import('~/lib/motionx')
    const plain = { ...tr, keyframes: [{ t: 1, value: 0, ease: 'easeOut' as const }, tr.keyframes[1]!] }
    expect(evaluateTrack(plain, 2)).toBe(10)
    expect(evaluateTrack(plain, 2.3)).toBe(10)
  })
})
