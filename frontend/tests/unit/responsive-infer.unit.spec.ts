import { describe, it, expect } from 'vitest'
import { inferAxisPin, inferPins, SPAN_STRETCH, CENTER_TOL } from '~/lib/frame/responsive/infer'

describe('inferAxisPin', () => {
  const ref = 1000
  it('spans ≥ 80% and can stretch → both', () => {
    expect(inferAxisPin(100, 800, 0, ref, true)).toBe('both')
    expect(SPAN_STRETCH).toBe(0.8)
  })
  it('touches both edges → both, even below 80%? no — touching both edges means spanning 100%', () => {
    expect(inferAxisPin(0, 1000, 0, ref, true)).toBe('both')
  })
  it('spans ≥ 80% but cannot stretch → center', () => {
    expect(inferAxisPin(100, 800, 0, ref, false)).toBe('center')
  })
  it('centre within 4% of the reference centre → center', () => {
    expect(CENTER_TOL).toBe(0.04)
    expect(inferAxisPin(450, 100, 0, ref, false)).toBe('center')   // centre 500
    expect(inferAxisPin(420, 100, 0, ref, false)).toBe('center')   // centre 470, 3% off
  })
  it('otherwise the nearer edge', () => {
    expect(inferAxisPin(100, 100, 0, ref, false)).toBe('left')     // centre 150
    expect(inferAxisPin(800, 100, 0, ref, false)).toBe('right')    // centre 850
  })
  it('measures against the reference rectangle, not the frame', () => {
    // section from 500 to 900; a box at 520..600 is near the section's near edge
    expect(inferAxisPin(520, 80, 500, 400, false)).toBe('left')
    expect(inferAxisPin(820, 80, 500, 400, false)).toBe('right')
    expect(inferAxisPin(660, 80, 500, 400, false)).toBe('center') // centre 700 = section centre
  })
  it('never infers relative', () => {
    for (let x = 0; x < 900; x += 37) expect(inferAxisPin(x, 90, 0, ref, true)).not.toBe('relative')
  })
})

describe('inferPins', () => {
  it('a full-frame layer is a background: stretches both ways', () => {
    expect(inferPins({ x: 0, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 }, true))
      .toEqual({ h: 'both', v: 'both' })
  })
  it('uses vertical names on the vertical axis', () => {
    expect(inferPins({ x: 40, y: 40, w: 200, h: 60 }, { x: 0, y: 0, w: 1920, h: 1080 }, false))
      .toEqual({ h: 'left', v: 'top' })
    expect(inferPins({ x: 1600, y: 950, w: 200, h: 60 }, { x: 0, y: 0, w: 1920, h: 1080 }, false))
      .toEqual({ h: 'right', v: 'bottom' })
    expect(inferPins({ x: 860, y: 510, w: 200, h: 60 }, { x: 0, y: 0, w: 1920, h: 1080 }, false))
      .toEqual({ h: 'center', v: 'middle' })
  })
})
