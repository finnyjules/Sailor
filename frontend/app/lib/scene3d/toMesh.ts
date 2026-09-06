// Freeze a primitive's built geometry into a `mesh` primitive.
//
// The input is the geometry the engine ALREADY built for this object, so
// modifiers are baked in. That is exactly why `params` and `modifiers` are
// dropped from the result: leaving them would re-apply a twist that is already
// in the vertices.
import type * as THREE from 'three'
import { decodeMesh, encodeMesh, meshDataFromGeometry, MESH_VERTEX_CAP, type MeshData } from '~/lib/scene3d/mesh'
import { contentDigest, type PrimitiveObject } from '~/lib/scene3d/config'
import { remesh } from '~/lib/scene3d/voxel'
import { solidify } from '~/lib/scene3d/voxel/solidify'

export async function convertToMesh(
  obj: PrimitiveObject,
  geo: THREE.BufferGeometry,
): Promise<PrimitiveObject> {
  const encoded = await encodeMesh(meshDataFromGeometry(geo))
  return {
    id: obj.id,
    name: obj.name,
    visible: obj.visible,
    position: [...obj.position] as PrimitiveObject['position'],
    rotation: [...obj.rotation] as PrimitiveObject['rotation'],
    scale: [...obj.scale] as PrimitiveObject['scale'],
    material: obj.material,
    ...(obj.motion ? { motion: obj.motion } : {}),
    ...(obj.treatments ? { treatments: obj.treatments } : {}),
    ...(obj.parentId ? { parentId: obj.parentId } : {}),
    kind: 'primitive',
    primitive: 'mesh',
    content: { mesh: encoded, meshKey: contentDigest(encoded) },
  }
}

/** The Remesh slider's own ceiling (Scene3DStudioSurface.vue imports this for
 *  its `:max`) — `resolutionForTarget` MUST clamp to the same number, not the
 *  other way round. 128 already costs ~16s of blocking work pre-Task-9
 *  optimisation (Finding 1); the slider's ceiling is a deliberate cost limit,
 *  not an arbitrary UI round number, so a resolution picked automatically has
 *  to respect it too. Before this fix an ordinary open PlaneGeometry (any of
 *  the common 1/4/8/16 segment counts) hit `resolutionForTarget`'s OWN prior,
 *  independent ceiling of 160 by default — 32 past what the slider could even
 *  show, so the readout and the thumb permanently disagreed the moment the
 *  user first touched it. One constant, two readers, is what keeps that from
 *  happening again. */
export const REMESH_RESOLUTION_MAX = 128

/** A resolution that lands near `targetVertices`.
 *
 *  Surface nets emits roughly one vertex per sign-changing cell, so the count
 *  scales with surface area over cell squared — i.e. with resolution squared.
 *  One cheap probe at a coarse resolution therefore pins the constant, and the
 *  answer is a scale by sqrt(target / probed). Far cheaper than bisecting with
 *  a full remesh per step. */
export function resolutionForTarget(data: MeshData, targetVertices: number): number {
  const PROBE = 24
  const probed = remesh(data, PROBE).data.positions.length / 3
  if (probed <= 0) return PROBE
  const scaled = PROBE * Math.sqrt(targetVertices / probed)
  return Math.max(8, Math.min(REMESH_RESOLUTION_MAX, Math.round(scaled)))
}

const contentFor = async (data: MeshData) => {
  const mesh = await encodeMesh(data)
  return { mesh, meshKey: contentDigest(mesh) }
}

/** Rebuild `src` at `resolution`, retrying at three-quarter resolution rather
 *  than throwing when the result is over the vertex cap (up to 4 attempts): the
 *  user asked for a shape, not an error, and a slightly coarser shape is a far
 *  better answer than a failure toast. `open` returns `src` UNCHANGED — see
 *  `remesh`.
 *
 *  Takes raw `MeshData` rather than a `PrimitiveObject` so it has two callers:
 *  `remeshObject` below (decodes `obj.content.mesh`, the doc's committed copy)
 *  and the sculpt panel's in-session Remesh (`Scene3DStudioSurface.vue`'s
 *  `remeshSculptSession`, which remeshes `SculptSession.toMeshData()` — the
 *  session's LIVE working buffer, which is the current truth while sculpting
 *  even though `obj.content.mesh` still holds the pre-sculpt mesh). */
export async function remeshMeshData(
  src: MeshData, resolution: number,
): Promise<{ data: MeshData; open: boolean; vertexCount: number }> {
  let res = resolution
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, open } = remesh(src, res)
    if (open) return { data: src, open: true, vertexCount: src.positions.length / 3 }
    const count = data.positions.length / 3
    if (count <= MESH_VERTEX_CAP) return { data, open: false, vertexCount: count }
    res = Math.max(8, Math.round(res * 0.75))
  }
  // Four attempts at shrinking resolution and still over cap — the last resort
  // is the coarse floor, which cannot exceed the cap for any plausible shape.
  const { data } = remesh(src, 8)
  return { data, open: false, vertexCount: data.positions.length / 3 }
}

/** Rebuild the object's mesh at `resolution`. `open` returns the object
 *  UNCHANGED — see `remeshMeshData`. */
export async function remeshObject(
  obj: PrimitiveObject, resolution: number,
): Promise<{ obj: PrimitiveObject; open: boolean; vertexCount: number }> {
  const encoded = obj.content?.mesh
  if (!encoded) return { obj, open: false, vertexCount: 0 }
  const src = await decodeMesh(encoded)
  const out = await remeshMeshData(src, resolution)
  if (out.open) return { obj, open: true, vertexCount: out.vertexCount }
  return {
    obj: { ...obj, content: { ...obj.content, ...(await contentFor(out.data)) } },
    open: false,
    vertexCount: out.vertexCount,
  }
}

/** Thicken an open surface into a closed shell so it can be remeshed. */
export async function solidifyObject(
  obj: PrimitiveObject, thickness: number,
): Promise<PrimitiveObject> {
  const encoded = obj.content?.mesh
  if (!encoded) return obj
  const shell = solidify(await decodeMesh(encoded), thickness)
  return { ...obj, content: { ...obj.content, ...(await contentFor(shell)) } }
}
