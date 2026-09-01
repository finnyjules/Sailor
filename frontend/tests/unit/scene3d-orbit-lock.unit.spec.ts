import { describe, it, expect } from 'vitest'
import { orbitShouldBeEnabled } from '~/lib/scene3d/interaction'

// Task 13: sculpting becomes the THIRD concern contending for orbit.enabled,
// alongside camera-motion playback and a gizmo drag (scene3d-orbit-gate.unit.spec.ts
// covers those two in isolation). Orbit must stay disabled while ANY of the
// three holds a lock — see interaction.ts's orbitShouldBeEnabled doc.
describe('orbit lock', () => {
  it('is enabled only when no concern holds a lock', () => {
    expect(orbitShouldBeEnabled(false, false, false)).toBe(true)
  })

  it('is disabled by any single concern', () => {
    expect(orbitShouldBeEnabled(true, false, false)).toBe(false)  // camera motion
    expect(orbitShouldBeEnabled(false, true, false)).toBe(false)  // gizmo drag
    expect(orbitShouldBeEnabled(false, false, true)).toBe(false)  // sculpting
    expect(orbitShouldBeEnabled(false, false, false, true)).toBe(false)  // decal grab-drag
  })

  it('the decal-drag lock defaults off when omitted', () => {
    // The 4th arg is optional so the pre-decal-drag call sites (and these tests) still read
    // as three concerns; omitting it must not silently disable orbit.
    expect(orbitShouldBeEnabled(false, false, false)).toBe(true)
  })

  it('stays disabled while several overlap', () => {
    expect(orbitShouldBeEnabled(true, true, true, true)).toBe(false)
  })
})
