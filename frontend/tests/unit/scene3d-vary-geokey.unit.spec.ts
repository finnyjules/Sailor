// The wiring seam: an object's Vary settings reaching the geometry build, and the
// geometry cache key invalidating exactly when — and only when — they change.
//
// Two failure modes this guards, in both directions:
//   1. A key that does NOT move when a setting does: the user edits a control and
//      nothing happens on screen, because syncObject serves the cached geometry.
//   2. A key that DOES move when it need not: every tick of a slider disposes the
//      geometry and re-merges all N clone copies to produce identical vertex data.
//      `varyColorStrength` is the whole reason case 2 has a test of its own.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { geoKeyFor, buildGeometry } from '~/lib/scene3d/engine'
import { materialFor, updateMaterial } from '~/lib/scene3d/materials'
import { varySettingsFor } from '~/lib/scene3d/primParams'
import type { PrimitiveObject, SceneMaterial } from '~/lib/scene3d/config'

const obj = (over: Partial<PrimitiveObject> = {}): PrimitiveObject => ({
  id: 'o', kind: 'primitive', primitive: 'box',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  material: { type: 'standard', color: '#ffffff' },
  ...over,
} as PrimitiveObject)

const MAT = { type: 'standard', color: '#3366cc' } as SceneMaterial
const uVary = (m: THREE.Material) =>
  (m.userData.varyUniforms as { uVaryStrength: { value: number } } | undefined)?.uVaryStrength.value

/** Vary as the object model hands it to the build: colour ON with a real palette. */
const VARY_ON = varySettingsFor({ modifiers: { varyColor: 1 }, varyPalette: ['#ff0000', '#00ff00'] })
/** Vary as an untouched object hands it over: every dial at its identity default. */
const VARY_OFF = varySettingsFor({})

const cloned = (variant: 'smooth' | 'facet', vary = VARY_ON) =>
  buildGeometry('box', undefined, { cloneCount: 3, cloneOffsetX: 2 }, variant, undefined, undefined, vary)

describe('geoKeyFor and vary', () => {
  it('is stable for an object with no vary settings — pinned against the modifier-stack key format', () => {
    // Pinned to a literal so an accidental key-format change (which would force a needless
    // geometry rebuild on every object) fails the suite. The format changed deliberately in
    // the S1 modifier-stack slice: the middle segment is now the ACTIVE modifier stack
    // (empty for a plain box, `` — not the old full MODIFIER_SPECS sweep), and the trailing
    // segment is the six vary NUMERIC dials read from the bag (defaults here:
    // mode/seed/color/spread/falloffCenter=0, falloffRadius=0.5), then the empty vary palette.
    // A no-modifier box therefore keys as `box|<params>||smooth||<vary dials>|`.
    expect(geoKeyFor(obj(), 'smooth')).toBe(
      'box|0,2||smooth||0,0,0,0,0,0.5|',
    )
  })

  it('changes when a palette swatch is edited', () => {
    const a = geoKeyFor(obj({ varyPalette: ['#ff0000'] }), 'smooth')
    const b = geoKeyFor(obj({ varyPalette: ['#00ff00'] }), 'smooth')
    expect(a).not.toBe(b)
  })

  it('changes when a swatch is added', () => {
    const a = geoKeyFor(obj({ varyPalette: ['#ff0000'] }), 'smooth')
    const b = geoKeyFor(obj({ varyPalette: ['#ff0000', '#00ff00'] }), 'smooth')
    expect(a).not.toBe(b)
  })

  it('changes when a numeric vary dial moves', () => {
    const a = geoKeyFor(obj({ modifiers: { cloneCount: 4 } }), 'smooth')
    const b = geoKeyFor(obj({ modifiers: { cloneCount: 4, varyMode: 1 } }), 'smooth')
    expect(a).not.toBe(b)
  })

  it('covers EVERY numeric vary dial that reaches the vertices, not just the one above', () => {
    // varySettingsFor reads seven modifier keys. Six of them change vertex data (the
    // driver, its two falloff dials, the colour switch and its spread); the seventh,
    // varyColorStrength, deliberately does not — see its own test below. A dial added
    // to varySettingsFor but forgotten here would be an invisible control.
    for (const [key, moved] of [
      ['varyMode', 1], ['varySeed', 7], ['varyFalloffCenter', 0.75],
      ['varyFalloffRadius', 0.2], ['varyColor', 1], ['varyColorSpread', 1],
    ] as const) {
      const base = { cloneCount: 4 }
      expect(geoKeyFor(obj({ modifiers: base }), 'smooth'), key)
        .not.toBe(geoKeyFor(obj({ modifiers: { ...base, [key]: moved } }), 'smooth'))
    }
  })

  it('does NOT change when the colour strength moves — it is not baked into vertices', () => {
    // Addendum A. Strength reaches the material as an explicit parameter, so making it
    // part of this key would re-merge N clone copies per slider tick for byte-identical
    // vertex data.
    const base = { cloneCount: 4, varyColor: 1 }
    const a = geoKeyFor(obj({ modifiers: base }), 'smooth')
    const b = geoKeyFor(obj({ modifiers: { ...base, varyColorStrength: 0.3 } }), 'smooth')
    expect(a).toBe(b)
  })
})

describe('buildGeometry threads vary into the merge', () => {
  it('stamps varyTint and writes a colour attribute when colour is on', () => {
    const g = cloned('smooth')
    expect(g.userData.varyTint).toBe(true)
    expect(g.getAttribute('color')).toBeDefined()
  })

  it('does NOT stamp the strength on the geometry any more', () => {
    // Addendum A: the geometry is not the channel. A leftover stamp would let the
    // old read-through path quietly come back.
    expect(cloned('smooth').userData.varyStrength).toBeUndefined()
  })

  it('keeps the stamp across the facet path, which rebuilds the geometry object', () => {
    // Addendum B: `toNonIndexed()` returns a bare geometry and copies attributes
    // only — userData does not come across, so the stamp was silently dropped.
    const g = cloned('facet')
    expect(g.index).toBeNull()
    expect(g.userData.varyTint).toBe(true)
    // The stamp is a PROMISE that the colour attribute is there — materials.ts turns on
    // vertexColors on the strength of it, and a stamp over a missing attribute would
    // render the whole clone set black. `toNonIndexed` expands attributes, so it is.
    expect(g.getAttribute('color')).toBeDefined()
  })

  it('ZERO-CHANGE: an untouched object gets no stamp and no colour attribute', () => {
    const g = cloned('smooth', VARY_OFF)
    expect(g.userData.varyTint).toBeUndefined()
    expect(g.getAttribute('color')).toBeUndefined()
    // ...and its material is built exactly as it would be with no vary in play.
    expect((materialFor(MAT, g) as THREE.MeshStandardMaterial).vertexColors).toBe(false)
    expect(materialFor(MAT, g).userData.vertexTint).toBeUndefined()
  })
})

describe('colour strength reaches the material explicitly', () => {
  it('is read from the parameter, not from the geometry', () => {
    const m = materialFor(MAT, cloned('smooth'), undefined, 0.4)
    expect(uVary(m)).toBe(0.4)
  })

  it('updates IN PLACE across a strength change — no geometry rebuild, no material rebuild', () => {
    // The two halves of Addendum A in one assertion: the SAME geometry object (nothing
    // rebuilt it, because the key did not move) carries a new strength to the uniform,
    // and updateMaterial reports true, so the material is not rebuilt either.
    const g = cloned('smooth')
    const m = materialFor(MAT, g, undefined, 1)
    expect(uVary(m)).toBe(1)
    expect(updateMaterial(m, MAT, g, 0.25)).toBe(true)
    expect(uVary(m)).toBe(0.25)
  })

  it('defaults to 1 and clamps to 0..1', () => {
    expect(uVary(materialFor(MAT, cloned('smooth')))).toBe(1)
    expect(uVary(materialFor(MAT, cloned('smooth'), undefined, -3))).toBe(0)
    expect(uVary(materialFor(MAT, cloned('smooth'), undefined, 7))).toBe(1)
  })
})
