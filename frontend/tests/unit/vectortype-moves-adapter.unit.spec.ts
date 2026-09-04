/**
 * Vector Type's `MovesAdapter` (`~/lib/vectortype/movesAdapter.ts`) — a small
 * coverage gap an opus review flagged alongside the Task 5 render-parity fix
 * (`vectortype-preset-motion.unit.spec.ts`'s `migration parity` block):
 * neither the gallery's curated "Letterform first" ordering nor
 * `availability`'s "same dial twice" gate had a direct test.
 *
 * Kept deliberately small — this closes that specific gap, it does not
 * re-test the gallery/availability contract in general (the shared moves
 * panel that will actually drive this adapter is a later task, per
 * `movesAdapter.ts`'s own header).
 */
import { describe, expect, it } from 'vitest'
import { vtMovesAdapter } from '~/lib/vectortype/movesAdapter'
import { DEFAULT_CONFIG, cloneConfig, mergeConfig, type VectorTypeConfig, type VtMove } from '~/lib/vectortype/config'
import type { VtAxis } from '~/lib/vectortype/font'
import type { Move } from '~/lib/studio/moves/types'

// No loaded font needed for either assertion below: the Letterform group is
// listed unconditionally (`gallery`'s own comment — "regardless of
// availability... a font without GRAD still shows the tile, greyed"), and
// `availability`'s "same dial twice" check for a 'tracks' candidate never
// consults `axes` at all (only the axis-preset branch does).
const NO_AXES: readonly VtAxis[] = []

function cfg(patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig {
  return mergeConfig({ ...cloneConfig(DEFAULT_CONFIG), ...patch })
}

describe('vtMovesAdapter — gallery: Letterform leads', () => {
  it('gallery(cfg, "in") returns Letterform as the FIRST group', () => {
    const adapter = vtMovesAdapter(DEFAULT_CONFIG, NO_AXES)
    const groups = adapter.gallery(cfg(), 'in')
    // Sanity: there really are other groups behind it (Axis / kinetic
    // catalog groups) — otherwise "first" would be true for a trivial reason.
    expect(groups.length).toBeGreaterThan(1)
    expect(groups[0]!.label).toBe('Letterform')
    expect(groups[0]!.offers.length).toBeGreaterThan(0)
  })

  it('gallery(cfg, "loop") returns Letterform as the FIRST group', () => {
    const adapter = vtMovesAdapter(DEFAULT_CONFIG, NO_AXES)
    const groups = adapter.gallery(cfg(), 'loop')
    expect(groups.length).toBeGreaterThan(1)
    expect(groups[0]!.label).toBe('Letterform')
    expect(groups[0]!.offers.length).toBeGreaterThan(0)
  })
})

describe('vtMovesAdapter — availability: same dial twice', () => {
  const existingTracksMove: VtMove = {
    id: 'move-existing',
    kind: 'tracks',
    presetId: 'custom',
    at: 0,
    duration: 1,
    loop: false,
    ease: { kind: 'named', name: 'none' },
    tracks: [{ path: 'skewX', from: 0, to: 10, hold: 0, cycleOffset: 0, delay: 0 }],
  }
  const withExisting = cfg({
    motion: { ...DEFAULT_CONFIG.motion, duration: 4, moves: [existingTracksMove] } as VectorTypeConfig['motion'],
  })

  it('returns a non-null reason for a candidate whose dial is already driven', () => {
    const adapter = vtMovesAdapter(DEFAULT_CONFIG, NO_AXES)
    const candidate: Move = {
      id: 'candidate', kind: 'tracks', presetId: 'custom',
      at: 0, duration: 1, loop: false, ease: { kind: 'named', name: 'none' },
      tracks: [{ path: 'skewX', from: 0, to: 20 }],   // same path the existing move already drives
    }
    const reason = adapter.availability(withExisting, candidate)
    expect(reason).not.toBeNull()
    expect(typeof reason).toBe('string')
  })

  it('returns null for a candidate whose dial is free', () => {
    const adapter = vtMovesAdapter(DEFAULT_CONFIG, NO_AXES)
    const candidate: Move = {
      id: 'candidate', kind: 'tracks', presetId: 'custom',
      at: 0, duration: 1, loop: false, ease: { kind: 'named', name: 'none' },
      tracks: [{ path: 'skewY', from: 0, to: 20 }],   // untouched by the existing move
    }
    expect(adapter.availability(withExisting, candidate)).toBeNull()
  })
})
