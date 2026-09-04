import { describe, it, expect } from 'vitest'
import { familyToStops } from '~/components/vue-canvas/studio/paletteEmit'
import { hexToOklch } from '~/lib/color/convert'

describe('familyToStops (literal emit)', () => {
  it('keeps the exact hexes even when lightness is non-monotonic in input order', () => {
    // deliberately NON-MONOTONIC lightness order — a laundered path would rewrite these
    const hexes = ['#e8985e', '#3d2c24', '#f4e3d0', '#b64a1f']
    const stops = familyToStops(hexes)
    expect(new Set(stops.map(s => s.color))).toEqual(new Set(hexes))
  })
  it('does not force a 0.22..0.92 ramp (a laundered path would)', () => {
    const stops = familyToStops(['#111111', '#151515', '#191919']) // all very dark
    const Ls = stops.map(s => hexToOklch(s.color)[0])
    expect(Math.max(...Ls)).toBeLessThan(0.4) // stays dark; toStops would push toward 0.92
  })
})
