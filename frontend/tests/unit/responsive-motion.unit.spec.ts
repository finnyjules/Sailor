import { describe, it, expect } from 'vitest'
import { remapMotion } from '~/lib/frame/responsive/motion'
import { axisMap, applyMap } from '~/lib/frame/responsive/axis'
import { evaluateTracks } from '~/lib/motionx/evaluate'
import type { FrameMotion } from '~/lib/motion/types'
import type { Track } from '~/lib/motionx/types'

const W0 = 1000, H0 = 500, W = 2000, H = 500   // fit s = 1, spare x = 1000
const maps = new Map([['a', { h: axisMap('right', W0, 1, 1000, 0), v: axisMap('center', H0, 1, 0, 0) }]])

const track = (path: string, a: number, b: number): Track => ({
  path, type: 'number',
  keyframes: [{ t: 0, value: a, ease: 'linear' }, { t: 1, value: b, ease: 'linear' }],
})

describe('remapMotion', () => {
  it('returns the same reference when nothing targets a mapped layer', () => {
    const m: FrameMotion = { fps: 30, duration: 1, motionx: [track('layers.zzz.x', 0, 1)] }
    expect(remapMotion(m, maps, W0, H0, W, H)).toBe(m)
    expect(remapMotion(null, maps, W0, H0, W, H)).toBeNull()
  })
  it('maps x keyframes through the layer\'s horizontal map and y through the vertical', () => {
    const m: FrameMotion = { fps: 30, duration: 1, motionx: [track('layers.a.x', 0.1, 0.5), track('layers.a.y', 0.2, 0.8)] }
    const out = remapMotion(m, maps, W0, H0, W, H)!
    expect(out).not.toBe(m)
    const [tx, ty] = out.motionx!
    expect(tx!.keyframes[0]!.value).toBeCloseTo(applyMap(maps.get('a')!.h, 0.1 * W0) / W, 9)   // (100 + 1000)/2000
    expect(tx!.keyframes[1]!.value).toBeCloseTo((500 + 1000) / 2000, 9)
    expect(ty!.keyframes[0]!.value).toBeCloseTo(0.2, 9)   // vertical: no spare, s = 1
  })
  it('map-then-interpolate equals interpolate-then-map (the map is a straight line)', () => {
    const m: FrameMotion = { fps: 30, duration: 1, motionx: [track('layers.a.x', 0.1, 0.9)] }
    const out = remapMotion(m, maps, W0, H0, W, H)!
    for (const t of [0.25, 0.5, 0.75]) {
      const mapped = evaluateTracks(out.motionx!, t).get('layers.a.x') as number
      const raw = evaluateTracks(m.motionx!, t).get('layers.a.x') as number
      expect(mapped).toBeCloseTo(applyMap(maps.get('a')!.h, raw * W0) / W, 9)
    }
  })
  it('leaves scale, rotation, opacity and effect tracks untouched (same track reference)', () => {
    const s = track('layers.a.scale', 1, 2), r = track('layers.a.rotation', 0, 90)
    const m: FrameMotion = { fps: 30, duration: 1, motionx: [s, r, track('layers.a.x', 0, 1)] }
    const out = remapMotion(m, maps, W0, H0, W, H)!
    expect(out.motionx![0]).toBe(s); expect(out.motionx![1]).toBe(r)
  })
})
