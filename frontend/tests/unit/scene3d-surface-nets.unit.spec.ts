import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { meshDataFromGeometry, geometryFromMeshData } from '~/lib/scene3d/mesh'
import { remesh } from '~/lib/scene3d/voxel'
import { surfaceNets } from '~/lib/scene3d/voxel/surfaceNets'
import type { Sdf } from '~/lib/scene3d/voxel/sdf'

// Signed volume via the divergence theorem over the triangle soup. The SIGN
// depends on winding: outward-facing (correct) triangles integrate positive,
// an inside-out mesh integrates negative. Callers that only care about
// magnitude should wrap this in Math.abs — do not bake the abs in here, or a
// reversed-winding regression becomes invisible (see the winding test below).
const signedVolumeOf = (data: any) => {
  let v = 0
  const p = data.positions, ix = data.indices
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3
    v += (
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
    ) / 6
  }
  return v
}
const volumeOf = (data: any) => Math.abs(signedVolumeOf(data))

// Each remesh runs a real surface-nets pass over a 3D grid; the suite takes ~8s alone and
// overruns the 5s default only under full-suite parallel load.
describe('remesh', { timeout: 20_000 }, () => {
  it('preserves a sphere\'s volume within grid tolerance', () => {
    const src = meshDataFromGeometry(new THREE.SphereGeometry(0.5, 64, 48))
    const { data, open } = remesh(src, 64)
    expect(open).toBe(false)
    const expected = (4 / 3) * Math.PI * 0.5 ** 3
    expect(volumeOf(data)).toBeGreaterThan(expected * 0.92)
    expect(volumeOf(data)).toBeLessThan(expected * 1.08)
    // Magnitude alone can't tell outward winding from inside-out: both give
    // the same |volume| and the same bounding box. Assert the RAW SIGNED
    // volume is positive so a flipped winding regression actually fails here.
    expect(signedVolumeOf(data)).toBeGreaterThan(0)
  })

  it('preserves the bounding box within one cell', () => {
    const src = meshDataFromGeometry(new THREE.SphereGeometry(0.5, 64, 48))
    const { data } = remesh(src, 64)
    const geo = geometryFromMeshData(data)
    geo.computeBoundingBox()
    const b = geo.boundingBox!
    expect(b.max.x).toBeGreaterThan(0.45)
    expect(b.max.x).toBeLessThan(0.56)
  })

  it('produces a closed, indexed mesh', () => {
    const src = meshDataFromGeometry(new THREE.BoxGeometry(1, 1, 1))
    const { data } = remesh(src, 48)
    expect(data.indices.length % 3).toBe(0)
    expect(data.indices.length).toBeGreaterThan(0)
    // Every index addresses a real vertex.
    const n = data.positions.length / 3
    for (let i = 0; i < data.indices.length; i++) expect(data.indices[i]!).toBeLessThan(n)
  })

  it('refuses an open surface instead of meshing garbage', () => {
    const src = meshDataFromGeometry(new THREE.PlaneGeometry(1, 1))
    const result = remesh(src, 48)
    expect(result.open).toBe(true)
    // The global contract: on `open`, `data` comes back as the caller's exact
    // original input, untouched, so a careless caller can't commit a mangled
    // mesh. Same object, not just similar contents.
    expect(result.data).toBe(src)
  })

  it('scales vertex count with resolution', () => {
    const src = meshDataFromGeometry(new THREE.SphereGeometry(0.5, 64, 48))
    const lo = remesh(src, 24).data.positions.length
    const hi = remesh(src, 64).data.positions.length
    expect(hi).toBeGreaterThan(lo * 2)
  })
})

describe('surfaceNets boundary guards', () => {
  it('stays in range when the interior reaches the outermost node layer', () => {
    // Hand-built Sdf (not via buildSdf) so the interior touches the last node
    // layer (k = nz - 1) directly, with no PAD margin protecting it. In
    // production `sdf.ts` always keeps PAD = 2 cells of clearance, which is
    // exactly why this gap was never hit in practice — but surfaceNets is a
    // public export with no enforcement of that precondition, so it must cope
    // on its own.
    //
    // Without the upper-bound guards, the pass-2 quad blocks call cellAt with
    // an off-axis coordinate at its max value (e.g. k = nz - 1), which is one
    // past the valid cell range (cz - 1) and reads past the end of the
    // `cellVertex` typed array. That read returns `undefined`, not out of
    // bounds in a way `-1` sentinels catch (`undefined < 0` is `false`), so it
    // silently coerces to vertex 0 in the final Uint32Array — producing
    // degenerate triangles pinned to vertex 0 instead of throwing.
    const nx = 4, ny = 4, nz = 4
    const values = new Float32Array(nx * ny * nz).fill(1) // outside everywhere
    const nodeAt = (i: number, j: number, k: number) => (k * ny + j) * nx + i
    // Interior block spans j,i in [1,2] and k in [1,3] — reaching k = nz - 1,
    // the outermost node layer.
    for (let k = 1; k <= 3; k++) {
      for (let j = 1; j <= 2; j++) {
        for (let i = 1; i <= 2; i++) {
          values[nodeAt(i, j, k)] = -1
        }
      }
    }
    const sdf: Sdf = { values, dims: [nx, ny, nz], cell: 1, min: [0, 0, 0] }

    const mesh = surfaceNets(sdf)
    const vertexCount = mesh.positions.length / 3

    expect(mesh.indices.length % 3).toBe(0)
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]!, b = mesh.indices[t + 1]!, c = mesh.indices[t + 2]!
      // Every index must address a real vertex...
      expect(a).toBeLessThan(vertexCount)
      expect(b).toBeLessThan(vertexCount)
      expect(c).toBeLessThan(vertexCount)
      // ...and no triangle may be degenerate (two of its three corners
      // resolving to the same vertex, as happens when an out-of-range read
      // silently coerces to vertex 0).
      expect(a).not.toBe(b)
      expect(b).not.toBe(c)
      expect(a).not.toBe(c)
    }
  })
})
