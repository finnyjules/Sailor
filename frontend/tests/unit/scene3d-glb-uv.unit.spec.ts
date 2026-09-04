import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { ensureUv } from '~/lib/scene3d/glb'
import { geometryFromMeshData } from '~/lib/scene3d/mesh'

describe('ensureUv — GLB meshes without UVs', () => {
  it('adds spherical UVs only to geometries that lack them', () => {
    const g = new THREE.Group()
    const withUv = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    const bare = new THREE.BufferGeometry()
    bare.setAttribute('position', new THREE.Float32BufferAttribute([0, 1, 0, 1, 0, 0, 0, 0, 1], 3))
    const withoutUv = new THREE.Mesh(bare)
    g.add(withUv, withoutUv)
    expect(ensureUv(g)).toBe(1)
    expect(withoutUv.geometry.getAttribute('uv').count).toBe(3)
    for (let i = 0; i < 3; i++) {
      const u = withoutUv.geometry.getAttribute('uv').getX(i), v = withoutUv.geometry.getAttribute('uv').getY(i)
      expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThanOrEqual(1)
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1)
    }
    // The box's own UVs are untouched.
    expect(withUv.geometry.getAttribute('uv').count).toBe(24)
    expect(ensureUv(g)).toBe(0)
  })
})

describe('geometryFromMeshData — the `mesh` primitive', () => {
  it('gives sculpt/remesh/text-to-3D bakes spherical UVs', () => {
    // A tetrahedron: the smallest closed mesh, so the spherical projection has something
    // to wrap. Without UVs the screen finish samples one texel and the whole object
    // renders as a single giant dot.
    const geo = geometryFromMeshData({
      positions: new Float32Array([1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1]),
      indices: new Uint32Array([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]),
    })
    const uv = geo.getAttribute('uv')
    expect(uv, 'geometryFromMeshData produced no uv attribute').toBeDefined()
    expect(uv.count).toBe(geo.getAttribute('position').count)
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0); expect(uv.getX(i)).toBeLessThanOrEqual(1)
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0); expect(uv.getY(i)).toBeLessThanOrEqual(1)
    }
  })
})
