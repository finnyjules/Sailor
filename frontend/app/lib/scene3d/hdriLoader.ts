// Loads a Poly Haven .hdr equirect into a three DataTexture, via our same-origin cache route
// (server/api/scene3d/hdri/[slug].get.ts fetches + caches from Poly Haven's CDN). Kept apart from
// the pure registry (hdri.ts) so the registry stays three-free and unit-testable.
//
// The RGBELoader DataTexture is HDR (HalfFloat, `.image.data`) — exactly what BOTH consumers want:
// PMREMGenerator.fromEquirectangular for the raster preview, and three-gpu-pathtracer's importance
// sampler for cinematic (EquirectHdrInfoUniform reads `.image.data` directly).
import * as THREE from 'three'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'

// One in-flight/settled promise per slug: a chosen HDRI is fetched + parsed once per session, then
// reused instantly on re-select (and on a context-restore reload). The DataTexture is owned HERE,
// never disposed by the engine — the engine only points its PMREM/tracer env at it.
const cache = new Map<string, Promise<THREE.DataTexture>>()

/** Load (or reuse) the equirect HDR for a Poly Haven slug. Rejects on network/parse failure; the
 *  cache entry is dropped so a later attempt retries rather than sticking on the failure. */
export function loadHdriEquirect(slug: string): Promise<THREE.DataTexture> {
  let p = cache.get(slug)
  if (!p) {
    p = new RGBELoader()
      .loadAsync(`/api/scene3d/hdri/${encodeURIComponent(slug)}`)
      .then((tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping
        tex.name = `hdri:${slug}`
        return tex
      })
      .catch((err) => { cache.delete(slug); throw err })
    cache.set(slug, p)
  }
  return p
}
