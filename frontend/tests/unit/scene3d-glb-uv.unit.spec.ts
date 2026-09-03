import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { ensureUv } from '~/lib/scene3d/glb'

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
