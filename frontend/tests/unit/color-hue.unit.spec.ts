import { describe, it, expect } from 'vitest'
import { hueDelta, walkHue } from '~/lib/color/hue'

describe('hueDelta', () => {
  it('short arc is the smaller rotation, in (-180, 180]', () => {
    expect(hueDelta(0, 90, false)).toBeCloseTo(90, 6)
    expect(hueDelta(0, 270, false)).toBeCloseTo(-90, 6)   // short way to 270 is backwards
    expect(hueDelta(350, 10, false)).toBeCloseTo(20, 6)    // across the 0/360 seam
    expect(hueDelta(10, 350, false)).toBeCloseTo(-20, 6)
  })

  it('short and long arcs have opposite signs and sum to a full turn', () => {
    for (const [a, b] of [[0, 90], [30, 200], [350, 10], [120, 15]]) {
      const s = hueDelta(a!, b!, false)
      const l = hueDelta(a!, b!, true)
      expect(Math.sign(s)).toBe(-Math.sign(l))            // opposite directions
      expect(Math.abs(s) + Math.abs(l)).toBeCloseTo(360, 6)
    }
  })

  it('the 180 antipode is deterministic: short -180, long +180', () => {
    expect(hueDelta(0, 180, false)).toBeCloseTo(-180, 6)
    expect(hueDelta(0, 180, true)).toBeCloseTo(180, 6)
  })

  it('equal hues: short is 0, long is a full +360 loop', () => {
    expect(hueDelta(120, 120, false)).toBeCloseTo(0, 6)
    expect(hueDelta(120, 120, true)).toBeCloseTo(360, 6)
  })
})

describe('walkHue', () => {
  it('is exact at the endpoints for both arcs', () => {
    expect(walkHue(40, 300, 0, false)).toBeCloseTo(40, 6)
    expect(walkHue(40, 300, 1, false)).toBeCloseTo(300, 6)
    expect(walkHue(40, 300, 0, true)).toBeCloseTo(40, 6)
    expect(walkHue(40, 300, 1, true)).toBeCloseTo(300, 6)
  })

  it('short and long land on different hues in the middle', () => {
    const s = walkHue(40, 300, 0.5, false)
    const l = walkHue(40, 300, 0.5, true)
    expect(Math.abs(s - l)).toBeGreaterThan(1)
  })

  it('wraps across the 0/360 seam correctly', () => {
    // 350 -> 10 short way is +20°, so the midpoint is 0/360, reported as 0.
    expect(walkHue(350, 10, 0.5, false)).toBeCloseTo(0, 6)
    // long way is -340°: midpoint 350 - 170 = 180.
    expect(walkHue(350, 10, 0.5, true)).toBeCloseTo(180, 6)
  })

  it('always returns a value in [0, 360)', () => {
    for (let a = 0; a < 360; a += 37) {
      for (let b = 0; b < 360; b += 53) {
        for (const long of [false, true]) {
          for (const t of [0.2, 0.5, 0.9]) {
            const h = walkHue(a, b, t, long)
            expect(h).toBeGreaterThanOrEqual(0)
            expect(h).toBeLessThan(360)
          }
        }
      }
    }
  })
})
