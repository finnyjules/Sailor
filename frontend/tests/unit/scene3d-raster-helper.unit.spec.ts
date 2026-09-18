import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { isRasterOnlyHelper } from '~/lib/scene3d/passes'

describe('isRasterOnlyHelper', () => {
  it('flags the shadow-catcher (ShadowMaterial)', () => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial())
    expect(isRasterOnlyHelper(m)).toBe(true)
  })
  it('flags grid lines', () => {
    expect(isRasterOnlyHelper(new THREE.GridHelper(2, 2))).toBe(true)
  })
  it('flags a gizmo helper by userData', () => {
    const o = new THREE.Object3D(); o.userData.isGizmoHelper = true
    expect(isRasterOnlyHelper(o)).toBe(true)
  })
  it('does NOT flag a real object', () => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
    expect(isRasterOnlyHelper(m)).toBe(false)
  })
})
