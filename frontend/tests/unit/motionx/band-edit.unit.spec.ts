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

describe('setBandTrack never touches a behaviour\'s tagged track on the same path', () => {
  const kf = (t: number, value: number) => ({ t, value, ease: 'linear' as const })
  const tagged = { path: 'layers.a.opacity', type: 'number' as const, keyframes: [kf(0, 0), kf(1, 1)], behaviourId: 'b1' }
  const band = { path: 'layers.a.opacity', type: 'number' as const, keyframes: [kf(0, 1), kf(4, 1)] }
  it('adding a band next to a tagged track appends it and leaves the tagged one alone', async () => {
    const { setBandTrack } = await import('~/lib/motionx/bandEdit')
    expect(setBandTrack([tagged], band.path, band)).toEqual([tagged, band])
  })
  it('replacing and removing only ever hit the untagged band', async () => {
    const { setBandTrack } = await import('~/lib/motionx/bandEdit')
    const edited = { ...band, keyframes: [kf(0, 0.5), kf(4, 1)] }
    expect(setBandTrack([tagged, band], band.path, edited)).toEqual([tagged, edited])
    expect(setBandTrack([band, tagged], band.path, null)).toEqual([tagged])
    expect(setBandTrack([tagged], band.path, null)).toEqual([tagged])   // no band → nothing removed
  })
})

describe('bandTrackAt', () => {
  const kf = (t: number, value: number) => ({ t, value, ease: 'linear' as const })
  const tagged = { path: 'layers.a.opacity', type: 'number' as const, keyframes: [kf(0, 0), kf(1, 1)], behaviourId: 'b1' }
  const band = { path: 'layers.a.opacity', type: 'number' as const, keyframes: [kf(0, 1), kf(4, 1)] }
  it('returns undefined when only a tagged track exists on that path', async () => {
    const { bandTrackAt } = await import('~/lib/motionx/bandEdit')
    expect(bandTrackAt([tagged], band.path)).toBeUndefined()
  })
  it('returns the untagged band regardless of array order', async () => {
    const { bandTrackAt } = await import('~/lib/motionx/bandEdit')
    expect(bandTrackAt([tagged, band], band.path)).toBe(band)
    expect(bandTrackAt([band, tagged], band.path)).toBe(band)
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

describe('ripplePoint — drag a boundary, push the later points along (DialKit legs)', () => {
  const kf = (t: number, value = t) => ({ t, value, ease: 'linear' as const })
  const tr = { path: 'layers.a.x', type: 'number' as const, keyframes: [kf(0), kf(1), kf(2), kf(3)] }
  it('lengthens the leg before the point and shifts every later point by the same amount', async () => {
    const { ripplePoint } = await import('~/lib/motionx/bandEdit')
    expect(ripplePoint(tr, 1, 1.5, 10).keyframes.map((k) => k.t)).toEqual([0, 1.5, 2.5, 3.5])
  })
  it('cannot cross the previous point, and cannot push the band past the end of the timeline', async () => {
    const { ripplePoint } = await import('~/lib/motionx/bandEdit')
    expect(ripplePoint(tr, 2, 0.2, 10).keyframes.map((k) => k.t)).toEqual([0, 1, 1.05, 2.05])
    expect(ripplePoint(tr, 1, 9, 4).keyframes.map((k) => k.t)).toEqual([0, 2, 3, 4])
  })
  it('on the first point it shifts the whole band; values and eases are untouched', async () => {
    const { ripplePoint } = await import('~/lib/motionx/bandEdit')
    const out = ripplePoint(tr, 0, 0.5, 10)
    expect(out.keyframes.map((k) => k.t)).toEqual([0.5, 1.5, 2.5, 3.5])
    expect(out.keyframes.map((k) => k.value)).toEqual([0, 1, 2, 3])
    expect(ripplePoint(tr, 0, -5, 10).keyframes[0]!.t).toBe(0)
  })
})

describe('segmentAt — which leg of a band is under a time', () => {
  it('returns the index of the point that STARTS the leg', async () => {
    const { segmentAt } = await import('~/lib/motionx/bandEdit')
    const kf = (t: number) => ({ t, value: 0, ease: 'linear' as const })
    const tr = { path: 'p', type: 'number' as const, keyframes: [kf(0), kf(1), kf(3)] }
    expect(segmentAt(tr, 0.4)).toBe(0)
    expect(segmentAt(tr, 2.9)).toBe(1)
    expect(segmentAt(tr, 99)).toBe(1)
    expect(segmentAt(tr, -1)).toBe(0)
  })
})
