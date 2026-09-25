import { describe, it, expect } from 'vitest'
import { SNAP_PX, BOW_PX, MIN_RADIUS_PX, pxToUnits } from '~/lib/sketch/tolerance'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }

describe('screen-pixel tolerances', () => {
  it('equal today\'s world-unit values at the dev page default zoom', () => {
    expect(pxToUnits(SNAP_PX, DEV)).toBeCloseTo(0.6, 12)
    expect(pxToUnits(BOW_PX, DEV)).toBeCloseTo(0.15, 12)
    expect(pxToUnits(MIN_RADIUS_PX, DEV)).toBeCloseTo(0.2, 12)
  })
  it('shrink in drawing units when zoomed in', () => {
    const zoomed = { ...DEV, a: 340, d: -340 }
    expect(pxToUnits(SNAP_PX, zoomed)).toBeCloseTo(0.06, 12)
  })
})
