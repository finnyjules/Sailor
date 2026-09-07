import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { materialFor, updateMaterial } from '~/lib/scene3d/materials'
import type { SceneMaterial } from '~/lib/scene3d/config'

const MAT = { type: 'standard', color: '#3366cc' } as SceneMaterial
const plain = () => new THREE.BoxGeometry(1, 1, 1)
const tinted = () => {
  const g = plain()
  const n = g.getAttribute('position').count
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3))
  return g
}

describe('materialFor with vertex colours', () => {
  it('leaves an untinted geometry exactly as before', () => {
    const m = materialFor(MAT, plain()) as THREE.MeshStandardMaterial
    expect(m.vertexColors).toBe(false)
    expect(`#${m.color.getHexString()}`).toBe('#3366cc')
  })

  it('switches vertex colours on and neutralises the base colour', () => {
    const m = materialFor(MAT, tinted()) as THREE.MeshStandardMaterial
    expect(m.vertexColors).toBe(true)
    expect(`#${m.color.getHexString()}`).toBe('#ffffff')
  })

  it('ignores vertex colours for image and shaderFill, which have no base colour', () => {
    for (const type of ['image', 'shaderFill'] as const) {
      const m = materialFor({ ...MAT, type } as SceneMaterial, tinted())
      expect((m as THREE.MeshStandardMaterial).vertexColors ?? false).toBe(false)
    }
  })
})

describe('updateMaterial vertex-colour boundary', () => {
  it('updates in place when the tint state is unchanged', () => {
    const m = materialFor(MAT, plain())
    expect(updateMaterial(m, MAT, plain())).toBe(true)
  })

  it('forces a rebuild when the geometry gains a colour attribute', () => {
    const m = materialFor(MAT, plain())
    expect(updateMaterial(m, MAT, tinted())).toBe(false)
  })

  it('forces a rebuild when the geometry loses its colour attribute', () => {
    const m = materialFor(MAT, tinted())
    expect(updateMaterial(m, MAT, plain())).toBe(false)
  })

  it('behaves exactly as before when no geometry is passed', () => {
    const m = materialFor(MAT, plain())
    expect(updateMaterial(m, MAT)).toBe(true)
  })
})
