// GLB loading with per-URL caching. Fetch first so we can enforce a size cap
// before parsing; GLTFLoader.parse then works from the ArrayBuffer directly.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { addSphericalUV } from './roundedGeometry'

export const GLB_SIZE_CAP_BYTES = 50 * 1024 * 1024

const cache = new Map<string, Promise<THREE.Group>>()

export function loadGlb(url: string): Promise<THREE.Group> {
  let p = cache.get(url)
  if (!p) {
    p = fetchAndParse(url)
    // Don't cache failures — a retry should actually retry.
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  // Clone per consumer so the same GLB can appear multiple times in a scene.
  return p.then((g) => g.clone(true))
}

/** Drop every cached parsed GLB. Needed after a WebGL context loss: the cached
 *  `THREE.Group`'s geometries/materials live on the LOST GPU context, and
 *  `clone(true)` shares them by reference — so a scene rebuilt from the cache
 *  would bind dead buffers. Clearing forces a fresh fetch+parse (new geometry
 *  objects → fresh GPU uploads) on the next `loadGlb`. See SceneEngine's
 *  context-restore handler. */
export function clearGlbCache(): void {
  cache.clear()
}

async function fetchAndParse(url: string): Promise<THREE.Group> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`glb fetch failed: ${res.status}`)
  const buf = await res.arrayBuffer()
  if (buf.byteLength > GLB_SIZE_CAP_BYTES) throw new Error('too-large')
  const loader = new GLTFLoader()
  const gltf = await loader.parseAsync(buf, '')
  return gltf.scene
}

/** Imported meshes with no `uv` attribute would read every UV-anchored finish (the screen,
 *  a shaderFill, a texture set) as one giant cell. Give them the same spherical projection
 *  the gem hull gets. Returns how many geometries were patched. */
export function ensureUv(root: THREE.Object3D): number {
  let n = 0
  root.traverse((c) => {
    const mesh = c as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    if (!mesh.geometry.getAttribute('uv')) { addSphericalUV(mesh.geometry); n++ }
  })
  return n
}
