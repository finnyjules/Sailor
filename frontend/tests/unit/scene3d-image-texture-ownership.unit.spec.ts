// @vitest-environment happy-dom
// The image material's per-material texture ownership (Task 3 of the image-material-options
// plan) is a DOM-only bug: `materials.ts`'s `hasDOM` const is false in the node environment
// `scene3d-materials.unit.spec.ts` runs under, so `materialFor` there never binds a `.map` at
// all — that spec's "disposing one image material leaves another on the same file untouched"
// test hand-assigns two fresh `THREE.Texture`s onto `a.map`/`b.map` itself and then asserts a
// fact it just constructed, so it would pass whether or not the underlying fix exists (see the
// finding this file addresses). This sibling spec opts into happy-dom (this repo's convention
// for DOM-needing specs — see scene3d-svg-path.unit.spec.ts) so `materialFor` takes its REAL
// `ownedImageTexture` path, and stubs `THREE.TextureLoader.prototype.load` so that path never
// touches the network.
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { materialFor, disposeMaterial } from '~/lib/scene3d/materials'
import type { SceneMaterial } from '~/lib/scene3d/config'

const img = (patch: Partial<SceneMaterial> = {}): SceneMaterial =>
  ({ type: 'image', color: '#ffffff', roughness: 0.6, metalness: 0, image: 'shared.png', ...patch })

describe('image material texture ownership (DOM)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gives two materials on the SAME filename two DIFFERENT Texture instances', () => {
    vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture())

    const a = materialFor(img()) as THREE.MeshStandardMaterial
    const b = materialFor(img()) as THREE.MeshStandardMaterial
    expect(a.map).toBeTruthy()
    expect(b.map).toBeTruthy()
    expect(a.map).not.toBe(b.map)
  })

  it('disposing one image material does not dispose the map of another on the same file', () => {
    vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture())

    const a = materialFor(img()) as THREE.MeshStandardMaterial
    const b = materialFor(img()) as THREE.MeshStandardMaterial
    const disposed = vi.fn()
    b.map!.addEventListener('dispose', disposed)

    disposeMaterial(a)

    expect(disposed).not.toHaveBeenCalled()
    expect(b.map).toBeTruthy()
  })

  it('each material\'s map carries its OWN tiling transform', () => {
    vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture())

    const a = materialFor(img({ imageTiling: 2 })) as THREE.MeshStandardMaterial
    const b = materialFor(img({ imageTiling: 5 })) as THREE.MeshStandardMaterial

    expect(a.map!.repeat.x).toBe(2)
    expect(b.map!.repeat.x).toBe(5)
  })
})
