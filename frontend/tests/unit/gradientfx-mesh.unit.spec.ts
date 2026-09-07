import { describe, expect, it } from 'vitest'
import {
  MESH_MAX_POINTS, buildMeshPoints, defaultMesh, driftedMeshPositions, recolorMeshPoints,
} from '~/lib/gradientfx/mesh'
import { meshConfig } from '~/lib/gradientfx/randomize'
import { GRADIENT_FS } from '~/lib/gradientfx/shaders'
import { LAYOUTS, ensureConfigDefaults } from '~/lib/gradientfx/types'
import type { ColorStop } from '~/lib/gradientfx/types'

const STOPS: ColorStop[] = [
  { color: '#ff7a3d', pos: 0 }, { color: '#f5a6cd', pos: 0.5 }, { color: '#2b3a55', pos: 1 },
]

describe('gradientfx mesh placement', () => {
  it('is deterministic for the same seed and differs across seeds', () => {
    expect(buildMeshPoints(8, STOPS, '#a')).toEqual(buildMeshPoints(8, STOPS, '#a'))
    expect(buildMeshPoints(8, STOPS, '#a')).not.toEqual(buildMeshPoints(8, STOPS, '#b'))
  })
  it('clamps count to [2, MESH_MAX_POINTS]', () => {
    expect(buildMeshPoints(0, STOPS, '#s').length).toBe(2)
    expect(buildMeshPoints(999, STOPS, '#s').length).toBe(MESH_MAX_POINTS)
  })
  it('places every point inside the unit frame with a valid hex color', () => {
    for (const p of buildMeshPoints(12, STOPS, '#s')) {
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(1)
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(1)
      expect(p.color).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
  it('recolor keeps positions but changes colors from a new palette', () => {
    const pts = buildMeshPoints(6, STOPS, '#s')
    const recol = recolorMeshPoints(pts, [{ color: '#00ff00', pos: 0 }, { color: '#0000ff', pos: 1 }], '#s')
    expect(recol.map(p => [p.x, p.y])).toEqual(pts.map(p => [p.x, p.y]))
    expect(recol.some((p, i) => p.color !== pts[i]!.color)).toBe(true)
  })
})

describe('gradientfx mesh drift', () => {
  const pts = buildMeshPoints(8, STOPS, '#drift')
  it('returns positions unchanged at amount 0', () => {
    const d = driftedMeshPositions(pts, 0, 0.37, '#drift')
    expect(d).toEqual(pts.map(p => ({ x: p.x, y: p.y })))
  })
  it('closes a seamless loop: phase 0 equals phase 1', () => {
    const a = driftedMeshPositions(pts, 0.8, 0, '#drift')
    const b = driftedMeshPositions(pts, 0.8, 1, '#drift')
    a.forEach((p, i) => {
      expect(p.x).toBeCloseTo(b[i]!.x, 6)
      expect(p.y).toBeCloseTo(b[i]!.y, 6)
    })
  })
  it('actually moves points mid-loop', () => {
    const moved = driftedMeshPositions(pts, 0.8, 0.5, '#drift')
    expect(moved.some((p, i) => Math.abs(p.x - pts[i]!.x) > 1e-4)).toBe(true)
  })
})

describe('gradientfx mesh integration', () => {
  it('LAYOUTS includes mesh', () => {
    expect(LAYOUTS).toContain('mesh')
  })
  it('meshConfig produces a mesh layout with >=2 points', () => {
    const c = meshConfig('#m')
    expect(c.canvas.layout).toBe('mesh')
    expect(c.layers[0]!.mesh!.points.length).toBeGreaterThanOrEqual(2)
  })
  it('ensureConfigDefaults backfills a mesh on a mesh-layout config that lacks one', () => {
    const c = meshConfig('#m2')
    delete (c.layers[0] as any).mesh
    ensureConfigDefaults(c)
    expect(c.layers[0]!.mesh!.points.length).toBeGreaterThanOrEqual(2)
  })
  it('defaultMesh has sane defaults', () => {
    const m = defaultMesh(STOPS, '#dm')
    expect(m.points.length).toBe(6)
    expect(m.drift).toBe(0)
  })
  it('shader declares the mesh branch + uniforms', () => {
    expect(GRADIENT_FS).toContain('u_meshCount')
    expect(GRADIENT_FS).toContain('u_layout[i] > 4.5')
    // u_flowOffset (rigid drift) was retired for u_flowAnimAmt (in-place churn) — see
    // ace982eb6 "agent tune-up presets + gradient studio eval harness".
    expect(GRADIENT_FS).toContain('u_flowAnimAmt')
    expect(GRADIENT_FS).toContain('u_meshBlur')
    expect(GRADIENT_FS).toContain('vec3 meshColorAt')
  })
  it('defaultMesh + meshConfig carry a blur field', () => {
    expect(defaultMesh(STOPS, '#b').blur).toBe(0)
    expect(typeof meshConfig('#b2').layers[0]!.mesh!.blur).toBe('number')
  })
})
