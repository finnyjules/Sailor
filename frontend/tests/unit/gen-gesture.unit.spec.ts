import { describe, it, expect } from 'vitest'
import { genGestureDefaults, genBoxIsValid, genBarPlacement } from '~/lib/compositor/genGesture'

describe('genGestureDefaults', () => {
  it('pins box / style / flux', () => {
    expect(genGestureDefaults()).toEqual({ tool: 'box', mode: 'style', model: 'flux' })
  })
})

describe('genBoxIsValid', () => {
  const disp = { w: 1000, h: 600 }
  it('rejects a click-sized box', () => {
    expect(genBoxIsValid({ minX: 100, minY: 100, maxX: 103, maxY: 101 }, disp.w, disp.h)).toBe(false)
  })
  it('accepts a real drag', () => {
    expect(genBoxIsValid({ minX: 100, minY: 100, maxX: 300, maxY: 260 }, disp.w, disp.h)).toBe(true)
  })
  it('normalizes height to WIDTH, matching the layer model', () => {
    // hN uses dispW as the divisor: 100px tall / 1000px wide = 0.1 ≥ 0.002 → valid
    expect(genBoxIsValid({ minX: 0, minY: 0, maxX: 60, maxY: 100 }, disp.w, disp.h)).toBe(true)
  })
  it('is safe when dispW is zero', () => {
    expect(genBoxIsValid({ minX: 0, minY: 0, maxX: 60, maxY: 100 }, 0, 0)).toBe(false)
  })
})

describe('genBarPlacement', () => {
  it('sits below the box when there is room', () => {
    const p = genBarPlacement({ minX: 400, minY: 100, maxX: 600, maxY: 300 }, 1000, 600)
    expect(p.flip).toBe(false)
    expect(p.top).toBe(312)          // maxY + margin(12)
    expect(p.left).toBe(500)         // box centre, within clamp
  })
  it('flips above when the box is near the bottom', () => {
    const p = genBarPlacement({ minX: 400, minY: 380, maxX: 600, maxY: 580 }, 1000, 600, 44, 12)
    expect(p.flip).toBe(true)
    expect(p.top).toBe(324)          // minY - margin - barH = 380 - 12 - 44
  })
  it('clamps the horizontal centre away from the edges', () => {
    expect(genBarPlacement({ minX: 0, minY: 0, maxX: 20, maxY: 40 }, 1000, 600).left).toBe(90)
    expect(genBarPlacement({ minX: 980, minY: 0, maxX: 1000, maxY: 40 }, 1000, 600).left).toBe(910)
  })
})
