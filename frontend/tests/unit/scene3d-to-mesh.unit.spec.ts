import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { convertToMesh } from '~/lib/scene3d/toMesh'
import { buildGeometry, baseSizeFor } from '~/lib/scene3d/engine'
import { contentDigest, type PrimitiveObject } from '~/lib/scene3d/config'
import { loadMesh, meshCacheGet, meshCacheClear } from '~/lib/scene3d/meshCache'

const sphere = (): PrimitiveObject => ({
  id: 's1', name: 'My sphere', visible: true,
  position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2],
  material: { type: 'standard', color: '#ff0000', roughness: 0.5, metalness: 0 } as any,
  kind: 'primitive', primitive: 'sphere',
  params: { detail: 32 }, modifiers: { twist: 45 },
  parentId: 'g1',
})

describe('convert to mesh', () => {
  it('produces a mesh primitive carrying an encoded buffer', async () => {
    const src = sphere()
    const geo = buildGeometry('sphere', src.params, src.modifiers, 'smooth')
    const out = await convertToMesh(src, geo)
    expect(out.primitive).toBe('mesh')
    expect(typeof out.content?.mesh).toBe('string')
    expect(out.content?.meshKey).toBe(contentDigest(out.content!.mesh!))
  })

  it('preserves identity, transform, material, motion and parent', async () => {
    const src = sphere()
    const geo = buildGeometry('sphere', src.params, src.modifiers, 'smooth')
    const out = await convertToMesh(src, geo)
    expect(out.id).toBe(src.id)
    expect(out.name).toBe('My sphere')
    expect(out.position).toEqual([1, 2, 3])
    expect(out.rotation).toEqual([0.1, 0.2, 0.3])
    expect(out.scale).toEqual([2, 2, 2])
    expect(out.material).toEqual(src.material)
    expect(out.parentId).toBe('g1')
  })

  // Per-object treatments are NOT baked into vertices (they are a render-time stage), so
  // unlike params/modifiers they must survive the rebuild — a Convert to mesh that silently
  // deleted the object's blur would look like the treatment editor losing the user's work.
  it('carries the object\'s treatments across unchanged, ids included', async () => {
    const treatments = [
      { id: 'trt_a', kind: 'blur', enabled: true, invert: false, amount: 0.4 },
      { id: 'trt_b', kind: 'fade', enabled: false, invert: false, opacity: 0.5 },
    ] as PrimitiveObject['treatments']
    const src: PrimitiveObject = { ...sphere(), treatments }
    const geo = buildGeometry('sphere', src.params, src.modifiers, 'smooth')
    const out = await convertToMesh(src, geo)
    expect(out.treatments?.map((t) => t.id)).toEqual(['trt_a', 'trt_b'])
    expect(out.treatments).toEqual(treatments)
  })

  it('drops params and modifiers — they are baked into the vertices', async () => {
    const src = sphere()
    const geo = buildGeometry('sphere', src.params, src.modifiers, 'smooth')
    const out = await convertToMesh(src, geo)
    expect(out.params).toBeUndefined()
    expect(out.modifiers).toBeUndefined()
  })

  it('the frozen buffer decodes to the same vertex count as the source', async () => {
    const src = sphere()
    const geo = buildGeometry('sphere', src.params, src.modifiers, 'smooth')
    const expected = geo.getAttribute('position').count
    const out = await convertToMesh(src, geo)
    await loadMesh(out.content!.mesh!, out.content!.meshKey!)
    expect(meshCacheGet(out.content!.meshKey!)!.positions.length / 3).toBe(expected)
  })

  it('refuses a geometry over the vertex cap with a readable message', async () => {
    const src = sphere()
    const huge = new THREE.SphereGeometry(0.5, 400, 260)
    expect(huge.getAttribute('position').count).toBeGreaterThan(40_000)
    await expect(convertToMesh(src, huge)).rejects.toThrow(/vertex cap/i)
  })

  // Why the Surface needs a `meshGen` bump next to its `fontGen` one: the Size
  // readout goes through baseSizeFor, which peeks the NON-reactive mesh cache.
  // Straight after a conversion the decode hasn't landed, so it measures the
  // 0.3 placeholder cube; the real size only appears once the cache is warm,
  // and warming it changes nothing Vue can see. Nothing here can assert the ref
  // bump itself (it is component-local, like fontGen's) — this pins the stale
  // reading that makes it necessary.
  it('baseSizeFor measures the placeholder until the decode lands', async () => {
    meshCacheClear()
    const src = sphere()
    const geo = buildGeometry('sphere', src.params, src.modifiers, 'smooth')
    const out = await convertToMesh(src, geo)
    const content = out.content!

    const stale = baseSizeFor('mesh', undefined, undefined, content)
    expect(stale[0]).toBeCloseTo(0.3, 5) // the placeholder cube, not the sphere

    await loadMesh(content.mesh!, content.meshKey!)
    const fresh = baseSizeFor('mesh', undefined, undefined, content)
    expect(fresh[0]).toBeGreaterThan(0.5)
  })
})
