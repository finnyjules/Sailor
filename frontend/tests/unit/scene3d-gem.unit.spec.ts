import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { gemPoints, gemGeometry, GEM_CUTS } from '~/lib/scene3d/gem'
import { PRIMITIVE_KINDS } from '~/lib/scene3d/config'
import { PRIMITIVE_PARAMS } from '~/lib/scene3d/primParams'
import { geometryFor } from '~/lib/scene3d/engine'

describe('scene3d gem geometry', () => {
  it('gemPoints is deterministic for a seed', () => {
    const a = gemPoints(16, 0.5, 1, 3)
    const b = gemPoints(16, 0.5, 1, 3)
    expect(a.length).toBe(16)
    expect(a.map(v => [v.x, v.y, v.z])).toEqual(b.map(v => [v.x, v.y, v.z]))
  })

  it('different seeds produce different clouds', () => {
    const a = gemPoints(16, 0.5, 1, 3)
    const b = gemPoints(16, 0.5, 1, 4)
    expect(a.map(v => v.x)).not.toEqual(b.map(v => v.x))
  })

  it('clamps the point count so a junk import cannot hang the hull', () => {
    expect(gemPoints(1e8, 0.5, 1, 0).length).toBeLessThanOrEqual(64)
    expect(gemPoints(0, 0.5, 1, 0).length).toBeGreaterThanOrEqual(4)
  })

  it('gemGeometry returns a solid hull with UVs', () => {
    const geo = gemGeometry(20, 0.6, 1, 1)
    expect(geo.getAttribute('position').count).toBeGreaterThanOrEqual(12)
    expect(geo.getAttribute('uv')).toBeTruthy()
    geo.dispose()
  })

  it('gemGeometry falls back to a tetrahedron on a degenerate cloud', () => {
    // depth 0 + spread 0 collapses points onto a plane → hull degenerates
    const geo = gemGeometry(4, 0, 0, 0)
    expect(geo.getAttribute('position').count).toBeGreaterThanOrEqual(12)
    geo.dispose()
  })

  it('omitting cut is byte-identical to the raw cut (back-compat)', () => {
    const a = gemGeometry(20, 0.6, 1, 1)
    const b = gemGeometry(20, 0.6, 1, 1, 'raw')
    expect(Array.from(a.getAttribute('position').array))
      .toEqual(Array.from(b.getAttribute('position').array))
    a.dispose(); b.dispose()
  })

  it('every jewellery cut builds a solid, non-degenerate hull', () => {
    for (const cut of GEM_CUTS) {
      const geo = gemGeometry(20, 0.5, 1, 0, cut)
      expect(geo.getAttribute('position').count, cut).toBeGreaterThanOrEqual(12)
      expect(geo.getAttribute('uv'), cut).toBeTruthy()
      // the cut must be an actual solid, not the tetrahedron fallback (24 verts)
      if (cut !== 'raw') expect(geo.getAttribute('position').count, cut).toBeGreaterThan(24)
      geo.dispose()
    }
  })

  it('a higher facet count adds facets to a cut', () => {
    const low = gemGeometry(8, 0.5, 1, 0, 'brilliant')
    const high = gemGeometry(40, 0.5, 1, 0, 'brilliant')
    expect(high.getAttribute('position').count).toBeGreaterThan(low.getAttribute('position').count)
    low.dispose(); high.dispose()
  })
})

describe('scene3d gem registration', () => {
  it('gem is a registered, param-carrying kind', () => {
    expect(PRIMITIVE_KINDS).toContain('gem')
    expect(PRIMITIVE_PARAMS.gem.map(p => p.key)).toEqual(['cut', 'points', 'spread', 'depth', 'gemSeed'])
  })

  it('geometryFor builds the gem hull from params', () => {
    const geo = geometryFor('gem', { points: 24, spread: 0.6, depth: 1, gemSeed: 2 })
    expect(geo.getAttribute('position').count).toBeGreaterThanOrEqual(12)
    expect(geo.getAttribute('uv')).toBeTruthy()
    geo.dispose()
  })
})
