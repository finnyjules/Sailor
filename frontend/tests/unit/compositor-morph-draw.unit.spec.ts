import { describe, expect, it } from 'vitest'
import { blendMorphPaint, lerpPlacement, morphFillOf, ringsBBoxOfD, syntheticBoldPx } from '~/lib/compositor/morphDraw'

describe('morph draw helpers', () => {
  it('reads a text layer colour and a shape fill', () => {
    expect(morphFillOf({ kind: 'text', color: '#112233' })).toBe('#112233')
    expect(morphFillOf({ kind: 'rect', fill: '#445566' })).toBe('#445566')
  })
  it('blends two solid colours and is exact at the ends', () => {
    expect(blendMorphPaint('#000000', '#ffffff', 0).toLowerCase()).toBe('#000000')
    expect(blendMorphPaint('#000000', '#ffffff', 1).toLowerCase()).toBe('#ffffff')
    expect(blendMorphPaint('#000000', '#ffffff', 0.5)).not.toBe('#000000')
  })
  it('switches a non-solid paint at the midpoint', () => {
    const g = { type: 'linear', angle: 0, stops: [] } as never
    expect(blendMorphPaint(g, '#ffffff', 0.4)).toBe(g)
    expect(blendMorphPaint(g, '#ffffff', 0.6)).toBe('#ffffff')
    expect(blendMorphPaint(undefined, undefined, 0.3)).toBe('')
  })
  it('measures a path', () => {
    expect(ringsBBoxOfD('M-5 -2L5 -2L5 2L-5 2Z')).toEqual({ w: 10, h: 4 })
  })
  it('interpolates placement, exact at the ends', () => {
    const a = { x: 0.1, y: 0.2, rotation: 350, skewX: 5 }
    const b = { x: 0.5, y: 0.8, rotation: 10, skewY: -4 }
    expect(lerpPlacement(a, b, 0)).toEqual({ x: 0.1, y: 0.2, rotation: 350, skewX: 5, skewY: 0 })
    expect(lerpPlacement(a, b, 1)).toEqual({ x: 0.5, y: 0.8, rotation: 10, skewX: 0, skewY: -4 })
    const mid = lerpPlacement(a, b, 0.5)
    expect(mid.x).toBeCloseTo(0.3)
    expect(mid.skewX).toBeCloseTo(2.5)
    expect(mid.skewY).toBeCloseTo(-2)
  })
  it('turns the short way: 350 to 10 goes through 0, not 180', () => {
    const at = (t: number) => ((lerpPlacement({ x: 0, y: 0, rotation: 350 }, { x: 0, y: 0, rotation: 10 }, t).rotation % 360) + 360) % 360
    expect(at(0.5)).toBeCloseTo(0)
    expect(at(0.25)).toBeCloseTo(355)
    // the other direction too
    const back = lerpPlacement({ x: 0, y: 0, rotation: 10 }, { x: 0, y: 0, rotation: 350 }, 0.5).rotation
    expect(((back % 360) + 360) % 360).toBeCloseTo(0)
  })
})

describe('syntheticBoldPx — the bold Chromium fakes for a weight the face does not ship', () => {
  const staticFace = (w = 400) => ({ axes: [], raw: { 'OS/2': { usWeightClass: w } } })
  it('matches Skia: fontPx/32 at display sizes (measured: 0.00% ink error at 141 px)', () => {
    expect(syntheticBoldPx(800, staticFace(), 141)).toBeCloseTo(141 / 32, 6)
  })
  it('ramps 1/24 → 1/32 between 9 and 36 px', () => {
    expect(syntheticBoldPx(700, staticFace(), 9)).toBeCloseTo(9 / 24, 6)
    expect(syntheticBoldPx(700, staticFace(), 36)).toBeCloseTo(36 / 32, 6)
  })
  it('is zero when nothing is faked', () => {
    expect(syntheticBoldPx(500, staticFace(), 141)).toBe(0)                                 // not bold
    expect(syntheticBoldPx(800, staticFace(700), 141)).toBe(0)                              // the face is bold
    expect(syntheticBoldPx(800, { axes: [{ tag: 'wght' }], raw: {} }, 141)).toBe(0)         // a weight axis draws it
    expect(syntheticBoldPx(800, null, 141)).toBe(0)                                         // no font
  })
})
