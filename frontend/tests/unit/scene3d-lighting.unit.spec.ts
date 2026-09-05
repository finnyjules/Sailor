import { describe, it, expect } from 'vitest'
import { LOOK_LIBRARY, getLook, warmthToColor, softnessToRadius, resolveDials, resolveLook } from '~/lib/scene3d/lighting'

describe('lighting look library', () => {
  it('has the eight featured looks and >=25 total, all with unique ids', () => {
    const ids = LOOK_LIBRARY.map(l => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(LOOK_LIBRARY.length).toBeGreaterThanOrEqual(25)
    expect(LOOK_LIBRARY.filter(l => l.featured).length).toBe(8)
  })
  it('every recipe has valid ranges', () => {
    for (const r of LOOK_LIBRARY) {
      expect(r.azimuth).toBeGreaterThanOrEqual(0); expect(r.azimuth).toBeLessThanOrEqual(360)
      expect(r.elevation).toBeGreaterThanOrEqual(5); expect(r.elevation).toBeLessThanOrEqual(90)
      expect(r.softness).toBeGreaterThanOrEqual(0); expect(r.softness).toBeLessThanOrEqual(1)
      expect(r.warmth).toBeGreaterThanOrEqual(0); expect(r.warmth).toBeLessThanOrEqual(1)
    }
  })
  it('getLook falls back to the first recipe for an unknown id', () => {
    expect(getLook('nope')).toBe(LOOK_LIBRARY[0])
    expect(getLook('softbox-beauty').id).toBe('softbox-beauty')
  })
})

describe('warmthToColor', () => {
  it('is neutral white at 0.5, cool below, warm above', () => {
    expect(warmthToColor(0.5).toLowerCase()).toBe('#ffffff')
    const cool = warmthToColor(0), warm = warmthToColor(1)
    // cool has more blue than red; warm has more red than blue
    const rgb = (h: string) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]
    const [cr,,cb] = rgb(cool); const [wr,,wb] = rgb(warm)
    expect(cb).toBeGreaterThan(cr)
    expect(wr).toBeGreaterThan(wb)
  })
})

describe('softnessToRadius', () => {
  it('maps 0..1 to a hard..soft shadow radius', () => {
    expect(softnessToRadius(0)).toBeLessThan(softnessToRadius(1))
    expect(softnessToRadius(0)).toBeGreaterThan(0)
  })
})

describe('resolveDials', () => {
  it('scales sun intensity by brightness and derives color+radius from the dials', () => {
    const r = getLook('softbox-beauty')
    const a = resolveDials(r, { softness: r.softness, warmth: r.warmth, brightness: 1 })
    const b = resolveDials(r, { softness: r.softness, warmth: r.warmth, brightness: 2 })
    expect(b.sunIntensity).toBeCloseTo(a.sunIntensity * 2)
    expect(a.sunColor).toBe(warmthToColor(r.warmth))
    expect(a.shadowSoftness).toBe(softnessToRadius(r.softness))
  })
})

describe('resolveLook', () => {
  it('returns the recipe direction, environment and default dials', () => {
    const r = getLook('golden-hour')
    const p = resolveLook(r)
    expect(p.sunAzimuth).toBe(r.azimuth)
    expect(p.sunElevation).toBe(r.elevation)
    expect(p.environment).toBe(r.environment)
    expect(p.softness).toBe(r.softness)
    expect(p.warmth).toBe(r.warmth)
  })
})

import { LOOK_GROUPS, looksInGroup, featuredLooks, searchLooks } from '~/lib/scene3d/lighting'

describe('look library metadata for the picker', () => {
  it('every look has a non-empty blurb', () => {
    for (const r of LOOK_LIBRARY) expect(r.blurb.length, r.id).toBeGreaterThan(3)
  })
  it('rim positions, where present, are valid angles', () => {
    for (const r of LOOK_LIBRARY) if (r.rim) {
      expect(r.rim.azimuth).toBeGreaterThanOrEqual(0); expect(r.rim.azimuth).toBeLessThanOrEqual(360)
      expect(r.rim.elevation).toBeGreaterThanOrEqual(5); expect(r.rim.elevation).toBeLessThanOrEqual(90)
    }
    expect(getLook('rim-on-dark').rim).toBeTruthy()
    expect(getLook('three-point').rim).toBeTruthy()
  })
  it('groups cover every look exactly once, in display order', () => {
    expect(LOOK_GROUPS.map(g => g.id)).toEqual(['product', 'portrait', 'cinematic', 'natural'])
    const all = LOOK_GROUPS.flatMap(g => looksInGroup(g.id).map(l => l.id))
    expect(all.length).toBe(LOOK_LIBRARY.length)
    expect(new Set(all).size).toBe(LOOK_LIBRARY.length)
  })
  it('featuredLooks returns the eight featured; searchLooks filters by label/blurb', () => {
    expect(featuredLooks().length).toBe(8)
    expect(searchLooks('').length).toBe(LOOK_LIBRARY.length)
    expect(searchLooks('golden').map(l => l.id)).toEqual(['golden-hour'])
    expect(searchLooks('SNEAKER').some(l => l.id === 'rim-on-dark')).toBe(true)
  })
})
