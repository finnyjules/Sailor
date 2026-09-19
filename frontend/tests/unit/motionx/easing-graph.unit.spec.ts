import { describe, it, expect } from 'vitest'
import { fitEasingGraph, moveEasingHandle, easingGuideEnd, easingHandleFromKey, parseEase, formatEase } from '~/lib/motionx/easingGraph'

describe('fitEasingGraph', () => {
  it('keeps the 0→1 reference at 45° (equal axis scale) and centres it', () => {
    const g = fitEasingGraph([0.42, 0, 0.58, 1], 256, 180)
    expect(g.scale.x).toBe(g.scale.y)
    expect(g.end.x - g.start.x).toBeCloseTo(g.start.y - g.end.y, 6)
    expect((g.start.x + g.end.x) / 2).toBeCloseTo(128, 6)
    expect((g.start.y + g.end.y) / 2).toBeCloseTo(90, 6)
  })
  it('shrinks the unit so an overshooting handle still fits vertically', () => {
    const calm = fitEasingGraph([0.42, 0, 0.58, 1], 256, 180)
    const wild = fitEasingGraph([0.3, 2, 0.6, 1], 256, 180)
    expect(wild.scale.y).toBeLessThan(calm.scale.y)
    expect(wild.handles[0].y).toBeGreaterThanOrEqual(0)
  })
})

describe('moveEasingHandle', () => {
  const scale = { x: 100, y: 100 }
  it('moves by pixel delta / scale, y inverted, rounded to 2dp', () => {
    expect(moveEasingHandle([0.4, 0, 0.6, 1], 0, 10, -20, scale)).toEqual([0.5, 0.2, 0.6, 1])
    expect(moveEasingHandle([0.4, 0, 0.6, 1], 1, -10, 10, scale)).toEqual([0.4, 0, 0.5, 0.9])
  })
  it('clamps x to 0..1 and y to -1..2', () => {
    expect(moveEasingHandle([0.4, 0, 0.6, 1], 0, 900, -900, scale)).toEqual([1, 2, 0.6, 1])
    expect(moveEasingHandle([0.4, 0, 0.6, 1], 0, -900, 900, scale)).toEqual([0, -1, 0.6, 1])
  })
  it('a bad scale is a no-op', () => {
    expect(moveEasingHandle([0.4, 0, 0.6, 1], 0, 10, 10, { x: 0, y: 0 })).toEqual([0.4, 0, 0.6, 1])
  })
})

describe('keyboard + guide + text', () => {
  it('arrow keys nudge 0.01 (shift 0.1); other keys are ignored', () => {
    expect(easingHandleFromKey([0.4, 0, 0.6, 1], 0, 'ArrowRight', false)).toEqual([0.41, 0, 0.6, 1])
    expect(easingHandleFromKey([0.4, 0, 0.6, 1], 1, 'ArrowDown', true)).toEqual([0.4, 0, 0.6, 0.9])
    expect(easingHandleFromKey([0.4, 0, 0.6, 1], 0, 'a', false)).toBeUndefined()
  })
  it('the tangent guide stops at the handle radius', () => {
    const end = easingGuideEnd({ x: 0, y: 0 }, { x: 10, y: 0 }, 5)
    expect(end).toEqual({ x: 5, y: 0 })
    expect(easingGuideEnd({ x: 0, y: 0 }, { x: 3, y: 0 }, 5)).toEqual({ x: 0, y: 0 })
  })
  it('parses and formats "x1, y1, x2, y2"', () => {
    expect(parseEase('0.42, 0, 0.58, 1')).toEqual([0.42, 0, 0.58, 1])
    expect(parseEase('1.2, 0, 0.5, 1')).toBeNull()      // x out of range
    expect(parseEase('0.4, 0, 0.5')).toBeNull()
    expect(parseEase('0.3, 9, 0.5, 1')).toEqual([0.3, 2, 0.5, 1])  // y clamped
    expect(formatEase([0.42, 0, 0.58, 1])).toBe('0.42, 0, 0.58, 1')
  })
})
