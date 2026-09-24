import { describe, expect, it } from 'vitest'
import { blendMorphPaint, lerpPlacement, morphFillOf, rideLetterMotion, ringsBBoxOfD, syntheticBoldPx } from '~/lib/compositor/morphDraw'
import { ringsFromD } from '~/lib/vector/morphPieces'

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

// USER 09-24: "it doesn't look like cascade is applying" — a Cascade in under a Morph into on the
// same text was invisible, because the morph draws a shape and the Cascade only moved real text.
describe('rideLetterMotion', () => {
  const sq = (x: number, y: number): [number, number][] => [[x - 5, y - 5], [x + 5, y - 5], [x + 5, y + 5], [x - 5, y + 5]]
  const frame = { rings: [sq(0, 0), sq(100, 0)], anchors: [[0, 0], [100, 0]] as [number, number][] }
  const cell = (x: number) => ({ char: 'A', x, y: 0, w: 20, h: 20, angle: 0, word: 0, line: 0 })
  const cells = [cell(0), cell(100)]
  it('moves, turns, scales and fades each piece with the letter it came from', () => {
    const out = rideLetterMotion(frame, cells, [
      { x: 0, y: 0, rotation: 0, scale: 1, opacity: 0 },            // not started: hidden
      { x: 100, y: 50, rotation: Math.PI / 2, scale: 2, opacity: 0.5 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.opacity).toBe(0.5)
    const pts = ringsFromD(out[0]!.d).flat()
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
    expect(Math.min(...xs)).toBeCloseTo(90); expect(Math.max(...xs)).toBeCloseTo(110)
    expect(Math.min(...ys)).toBeCloseTo(40); expect(Math.max(...ys)).toBeCloseTo(60)
  })
  it('leaves a piece at rest exactly where it was, and merges pieces of equal opacity', () => {
    const rest = cells.map(c => ({ x: c.x, y: c.y, rotation: 0, scale: 1, opacity: 1 }))
    const out = rideLetterMotion(frame, cells, rest)
    expect(out).toHaveLength(1)
    expect(ringsBBoxOfD(out[0]!.d)).toEqual({ w: 110, h: 10 })
  })
})
