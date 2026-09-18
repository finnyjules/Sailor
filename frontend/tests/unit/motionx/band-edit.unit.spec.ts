import { describe, it, expect } from 'vitest'
import {
  shiftTrack, retimeTrack, addPoint, movePoint, setPointValue, setPointEase, removePoint, setBandTrack,
} from '~/lib/motionx/bandEdit'
import type { Track } from '~/lib/motionx'

const num = (path: string, ks: Array<[number, number]>): Track => ({
  path, type: 'number', keyframes: ks.map(([t, value]) => ({ t, value, ease: 'linear' })),
})

describe('shiftTrack', () => {
  it('moves all keyframes by delta', () => {
    const out = shiftTrack(num('p', [[0, 0], [2, 1]]), 0.5)
    expect(out.keyframes.map((k) => k.t)).toEqual([0.5, 2.5])
  })
  it('clamps so the earliest keyframe never goes below 0', () => {
    const out = shiftTrack(num('p', [[1, 0], [3, 1]]), -5)
    expect(out.keyframes.map((k) => k.t)).toEqual([0, 2])
  })
  it('does not mutate the input', () => {
    const t = num('p', [[0, 0], [2, 1]])
    shiftTrack(t, 1)
    expect(t.keyframes[0]!.t).toBe(0)
  })
})

describe('retimeTrack', () => {
  it('linearly remaps the span to [newStart,newEnd]', () => {
    const out = retimeTrack(num('p', [[0, 0], [1, 0.5], [2, 1]]), 1, 5)
    expect(out.keyframes.map((k) => k.t)).toEqual([1, 3, 5])
  })
  it('single keyframe moves to newStart', () => {
    const out = retimeTrack(num('p', [[2, 1]]), 4, 8)
    expect(out.keyframes.map((k) => k.t)).toEqual([4])
  })
  it('degenerate newEnd<=newStart is ignored (unchanged)', () => {
    const t = num('p', [[0, 0], [2, 1]])
    expect(retimeTrack(t, 3, 3).keyframes.map((k) => k.t)).toEqual([0, 2])
  })
})

describe('addPoint', () => {
  it('inserts at t seeded with the interpolated value, sorted, returns its index', () => {
    const { track, index } = addPoint(num('p', [[0, 0], [2, 10]]), 1)
    expect(track.keyframes.map((k) => k.t)).toEqual([0, 1, 2])
    expect(track.keyframes[index]!.t).toBe(1)
    expect(track.keyframes[1]!.value).toBeCloseTo(5, 5)
  })
  it('uses an explicit value when given', () => {
    const { track, index } = addPoint(num('p', [[0, 0], [2, 10]]), 3, 42)
    expect(track.keyframes[index]!.value).toBe(42)
    expect(track.keyframes[index]!.t).toBe(3)
  })
})

describe('movePoint', () => {
  it('changes t, re-sorts, returns the new index', () => {
    const { track, index } = movePoint(num('p', [[0, 0], [1, 5], [2, 10]]), 1, 3)
    expect(track.keyframes.map((k) => k.t)).toEqual([0, 2, 3])
    expect(track.keyframes[index]!.value).toBe(5)
    expect(index).toBe(2)
  })
  it('clamps t to >= 0', () => {
    const { track } = movePoint(num('p', [[1, 0], [2, 1]]), 0, -3)
    expect(track.keyframes.map((k) => k.t)).toEqual([0, 2])
  })
})

describe('setPointValue / setPointEase', () => {
  it('replaces the value at index', () => {
    expect(setPointValue(num('p', [[0, 0], [2, 10]]), 1, 99).keyframes[1]!.value).toBe(99)
  })
  it('replaces the ease at index', () => {
    expect(setPointEase(num('p', [[0, 0], [2, 10]]), 0, 'easeInOut').keyframes[0]!.ease).toBe('easeInOut')
  })
})

describe('removePoint', () => {
  it('removes the keyframe at index', () => {
    expect(removePoint(num('p', [[0, 0], [1, 5], [2, 10]]), 1).keyframes.map((k) => k.t)).toEqual([0, 2])
  })
  it('can empty the track', () => {
    expect(removePoint(num('p', [[0, 0]]), 0).keyframes).toEqual([])
  })
})

describe('setBandTrack', () => {
  const a = num('layers.x.opacity', [[0, 0]])
  const b = num('layers.x.scale', [[0, 1]])
  it('replaces an existing track by path', () => {
    const next = num('layers.x.opacity', [[0, 1]])
    const out = setBandTrack([a, b], 'layers.x.opacity', next)
    expect(out[0]).toBe(next)
    expect(out[1]).toBe(b)
  })
  it('appends when the path is absent', () => {
    const c = num('layers.x.rotation', [[0, 0]])
    expect(setBandTrack([a], 'layers.x.rotation', c)).toEqual([a, c])
  })
  it('removes when next is null', () => {
    expect(setBandTrack([a, b], 'layers.x.opacity', null)).toEqual([b])
  })
})

describe('seedHoldTrack', () => {
  it('seeds a flat hold band: two keyframes at [0, duration] both = the current value', async () => {
    const { seedHoldTrack } = await import('~/lib/motionx/bandEdit')
    const t = seedHoldTrack('layers.a.opacity', 'number', 0.7, 4)
    expect(t.path).toBe('layers.a.opacity')
    expect(t.type).toBe('number')
    expect(t.keyframes.map((k) => [k.t, k.value])).toEqual([[0, 0.7], [4, 0.7]])
    expect(t.behaviourId).toBeUndefined()   // a plain property band, not behaviour-owned
  })
  it('keeps a gradient value intact for a gradient property', async () => {
    const { seedHoldTrack } = await import('~/lib/motionx/bandEdit')
    const g = [{ pos: 0, color: '#000' }, { pos: 1, color: '#fff' }]
    const t = seedHoldTrack('layers.a.fill', 'gradient', g, 2)
    expect(t.keyframes[1]!.value).toEqual(g)
  })
})
