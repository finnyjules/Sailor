import { describe, it, expect } from 'vitest'
import { marginBox, toNorm, normLen, fitSize, snapX, snapY } from '~/lib/frame/patterns/space'
import type { ResolvedGrid } from '~/lib/frame/patterns/types'

const frame = { w: 800, h: 1000 }

describe('space helpers', () => {
  it('marginBox insets by margin*width on all sides', () => {
    expect(marginBox(frame, 0.05)).toEqual({ x: 40, y: 40, w: 720, h: 920 })
  })
  it('toNorm converts a px box to a normalized centre', () => {
    expect(toNorm({ x: 0, y: 0, w: 400, h: 500 }, frame)).toEqual({ x: 0.25, y: 0.25 })
    expect(toNorm({ x: 400, y: 500, w: 400, h: 500 }, frame)).toEqual({ x: 0.75, y: 0.75 })
  })
  it('normLen divides by frame width', () => {
    expect(normLen(80, 800)).toBeCloseTo(0.1, 6)
  })
  it('fitSize scales linearly from measure@100', () => {
    const measure = (t: string) => t.length * 60 // 0.6em per char at size 100
    // "AB" is 2*60 = 120px at size 100 → to be 360px wide needs size 300
    expect(fitSize('AB', 360, measure)).toBeCloseTo(300, 6)
  })
  it('snapX/snapY snap to the nearest grid edge, identity when off', () => {
    const grid: ResolvedGrid = { xs: [40, 240, 440, 640, 760], ys: [40, 500, 960], regions: [] }
    expect(snapX(250, grid)).toBe(240)
    expect(snapX(700, grid)).toBe(640)
    expect(snapY(470, grid)).toBe(500)
    expect(snapX(250, null)).toBe(250)
    expect(snapX(250, { xs: [], ys: [], regions: [] })).toBe(250)
  })
})
