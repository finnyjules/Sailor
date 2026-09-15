import { describe, it, expect } from 'vitest'
import { addDialTrack, removeDialTrack, type EffectDialTrack } from '~/lib/motion/effectTracks'

/**
 * F8 Task 4 · The pure add/remove reducers behind the Motion-tab dial picker.
 *
 * `addDialTrack` seeds ONE keyframe at the playhead so a dial becomes animatable
 * (the actual second keyframe is authored on the timeline in Task 5), is idempotent
 * on a target already animated, and never mutates its input. `removeDialTrack`
 * filters a target out into a new array, also without mutating.
 */
const TARGET = 'layers.L1.effects.fx:grain:0.grain'
const OTHER = 'layers.L1.effects.fx:blur:0.radius'

describe('addDialTrack', () => {
  it('appends a one-keyframe track at the given t/v', () => {
    const next = addDialTrack(undefined, TARGET, 1.5, 42)
    expect(next).toEqual([{ target: TARGET, keyframes: [{ t: 1.5, v: 42 }] }])
  })

  it('carries the colour space when given', () => {
    const next = addDialTrack([], 'layers.L1.effects.fx:risograph:0.ink', 0, '#ff0000', 'oklch')
    expect(next).toEqual([
      { target: 'layers.L1.effects.fx:risograph:0.ink', keyframes: [{ t: 0, v: '#ff0000' }], space: 'oklch' },
    ])
  })

  it('omits the space key entirely when not given (numeric dial)', () => {
    const next = addDialTrack(undefined, TARGET, 0, 10)
    expect(next[0]).not.toHaveProperty('space')
  })

  it('appends alongside an existing, different target', () => {
    const start: EffectDialTrack[] = [{ target: OTHER, keyframes: [{ t: 0, v: 5 }] }]
    const next = addDialTrack(start, TARGET, 2, 7)
    expect(next).toHaveLength(2)
    expect(next.map((t) => t.target)).toEqual([OTHER, TARGET])
  })

  it('is idempotent — a duplicate target returns the input UNCHANGED (same reference)', () => {
    const start: EffectDialTrack[] = [{ target: TARGET, keyframes: [{ t: 0, v: 5 }] }]
    const next = addDialTrack(start, TARGET, 9, 99)
    expect(next).toBe(start)
    // the original keyframe is untouched — no second keyframe, no value overwrite
    expect(start[0]!.keyframes).toEqual([{ t: 0, v: 5 }])
  })

  it('never mutates the input array (new reference on append)', () => {
    const start: EffectDialTrack[] = [{ target: OTHER, keyframes: [{ t: 0, v: 5 }] }]
    const next = addDialTrack(start, TARGET, 1, 2)
    expect(next).not.toBe(start)
    expect(start).toHaveLength(1)
  })

  it('handles an undefined input by returning a fresh array', () => {
    const next = addDialTrack(undefined, TARGET, 0, 0)
    expect(Array.isArray(next)).toBe(true)
    expect(next).toHaveLength(1)
  })
})

describe('removeDialTrack', () => {
  it('removes the track for the given target', () => {
    const start: EffectDialTrack[] = [
      { target: OTHER, keyframes: [{ t: 0, v: 5 }] },
      { target: TARGET, keyframes: [{ t: 0, v: 1 }] },
    ]
    const next = removeDialTrack(start, TARGET)
    expect(next.map((t) => t.target)).toEqual([OTHER])
  })

  it('never mutates the input array', () => {
    const start: EffectDialTrack[] = [{ target: TARGET, keyframes: [{ t: 0, v: 1 }] }]
    const next = removeDialTrack(start, TARGET)
    expect(next).not.toBe(start)
    expect(start).toHaveLength(1)
  })

  it('is a no-op (new empty array) on undefined input', () => {
    const next = removeDialTrack(undefined, TARGET)
    expect(next).toEqual([])
  })

  it('returns the remaining tracks when the target is absent', () => {
    const start: EffectDialTrack[] = [{ target: OTHER, keyframes: [{ t: 0, v: 5 }] }]
    const next = removeDialTrack(start, TARGET)
    expect(next.map((t) => t.target)).toEqual([OTHER])
  })
})
