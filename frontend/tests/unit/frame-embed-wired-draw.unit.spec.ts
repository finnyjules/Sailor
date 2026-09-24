/**
 * wiredSourceLongSide: how big a wired layer's SOURCE is drawn (the painter's box and cover crop),
 * shared by the planner's pre-rendered `maxPx` and the Frame player's nested live players.
 */
import { describe, it, expect } from 'vitest'
import { wiredSourceLongSide } from '~/lib/embed/frame/wiredDraw'
import { nestedDeviceSize } from '~/lib/embed/nested'

const W = 1000

describe('wiredSourceLongSide', () => {
  it('an uncropped layer: the box follows the source aspect, so the source long side is the box long side', () => {
    expect(wiredSourceLongSide({ w: 0.5, lastAspect: 0.5 }, W, 800, 450)).toBeCloseTo(500, 9)
    expect(wiredSourceLongSide({ w: 0.3, lastAspect: 1 }, W, 450, 800)).toBeCloseTo(300 * 800 / 450, 9)
  })

  it('a 16:9 source cover-cropped into a portrait 300×533 box is drawn 948 px wide, never 300×169', () => {
    const long = wiredSourceLongSide({ w: 0.3, h: 0.533, crop: { fit: 'cover' }, lastAspect: 0.5625 }, W, 1600, 900)
    expect(long).toBeCloseTo(533 / 0.5625, 6)
    const d = nestedDeviceSize(long, 1600, 900)
    expect(d).toEqual({ w: 948, h: 533 })
    expect(d).not.toEqual({ w: 300, h: 169 })
  })

  it('a cropped square box over an 800×450 source: the player is at least as tall as the box', () => {
    const long = wiredSourceLongSide({ w: 0.4, h: 0.4, crop: { fit: 'cover' } }, W, 800, 450)
    const d = nestedDeviceSize(long, 800, 450)
    expect(d.h).toBeGreaterThanOrEqual(400)
    expect(d.w).toBeGreaterThanOrEqual(400)
  })

  it('a portrait source in a landscape crop box: at least as wide as the box', () => {
    const long = wiredSourceLongSide({ w: 0.8, h: 0.45, crop: { fit: 'cover' } }, W, 900, 1600)
    const d = nestedDeviceSize(long, 900, 1600)
    expect(d.w).toBeGreaterThanOrEqual(800)
    expect(d.h).toBeGreaterThanOrEqual(450)
  })

  it('a stretched (not cover) crop box needs the same scale: both axes at least the box', () => {
    const long = wiredSourceLongSide({ w: 0.3, h: 0.533, crop: { fit: 'stretch' } }, W, 1600, 900)
    expect(long).toBeCloseTo(533 / 0.5625, 6)
  })

  it('`h` without a crop is ignored, as the painter ignores it', () => {
    expect(wiredSourceLongSide({ w: 0.5, h: 2 }, W, 800, 450)).toBeCloseTo(500, 9)
  })

  it('an unlinked layer keeps its lastAspect box and stretches the source into it', () => {
    // Box 500×500; an 800×450 source must be 889 px wide to fill 500 px of height.
    expect(wiredSourceLongSide({ w: 0.5, lastAspect: 1, unlinked: true }, W, 800, 450)).toBeCloseTo(500 / 0.5625, 6)
  })

  it('without a source size, lastAspect stands in for the source aspect', () => {
    expect(wiredSourceLongSide({ w: 0.5, lastAspect: 0.5 }, W)).toBeCloseTo(500, 9)
    expect(wiredSourceLongSide({ w: 0.5, lastAspect: 2 }, W, 0, NaN)).toBeCloseTo(1000, 9)
    expect(wiredSourceLongSide({ w: 0.3, h: 0.533, crop: {}, lastAspect: 0.5625 }, W)).toBeCloseTo(533 / 0.5625, 6)
  })

  it('a layer that draws nothing (w <= 0, the unresolved sentinel) is 0', () => {
    expect(wiredSourceLongSide({ w: 0 }, W, 800, 450)).toBe(0)
    expect(wiredSourceLongSide({ w: -1 }, W, 800, 450)).toBe(0)
  })

  it('nestedDeviceSize clamps the long side to [64, 4096]', () => {
    const huge = wiredSourceLongSide({ w: 0.1, h: 1, crop: { fit: 'cover' } }, W, 1000, 100)
    expect(nestedDeviceSize(huge, 1000, 100)).toEqual({ w: 4096, h: 410 })
    const tiny = wiredSourceLongSide({ w: 0.01, lastAspect: 1 }, W, 1, 1)
    expect(nestedDeviceSize(tiny, 1, 1)).toEqual({ w: 64, h: 64 })
  })
})
