/**
 * Client side of ambientCG texture sets for the 3D Studio.
 *
 * A material's `texture` field holds either a RESOLVED id (`ambientcg:Wood095`) or a
 * plain phrase the agent wrote (`wood`) that nothing has resolved yet. Only resolved
 * ids reach the engine; a phrase renders untextured until `resolveTexturePhrase`
 * (called from the agent's apply path, see agent/studioTune.ts) rewrites it.
 *
 * Map filenames are never stored — they derive from the id (see textureMapFilename),
 * and the server's fetch route lays them out under input/sailor_textures/<id>/.
 * Three-free by construction, like config.ts, so the agent bundle can import it.
 */

export const TEXTURE_ID_PREFIX = 'ambientcg:'
export const TEXTURES_SUBDIR = 'sailor_textures'

export type TextureMapKey = 'color' | 'roughness' | 'normal' | 'displacement' | 'ao' | 'metalness'

/** Must match server/utils/ambientcgExtract.ts's TEXTURE_MAP_FILES exactly. */
export const TEXTURE_MAP_FILES: Record<TextureMapKey, string> = {
  color: 'Color.jpg',
  roughness: 'Roughness.jpg',
  normal: 'NormalGL.jpg',
  displacement: 'Displacement.jpg',
  ao: 'AmbientOcclusion.jpg',
  metalness: 'Metalness.jpg',
}

export interface TextureManifest { id: string; maps: TextureMapKey[]; fetchedAt: string }
export interface TextureSet { id: string; name: string; category: string; tags: string[]; thumb: string; popularity: number }

export function isResolvedTexture(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(TEXTURE_ID_PREFIX) && v.length > TEXTURE_ID_PREFIX.length
}

export function bareTextureId(v: string): string {
  return v.startsWith(TEXTURE_ID_PREFIX) ? v.slice(TEXTURE_ID_PREFIX.length) : v
}

/** Slash-joined input-dir path; materials.ts splits it into subfolder + filename for /view. */
export function textureMapFilename(id: string, map: TextureMapKey): string {
  return `${TEXTURES_SUBDIR}/${bareTextureId(id)}/${TEXTURE_MAP_FILES[map]}`
}

type FetchLike = typeof fetch

async function postJson<T>(url: string, body: unknown, fetchImpl: FetchLike): Promise<T> {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.message ?? `${url} ${r.status}`)
  return data as T
}

const manifests = new Map<string, Promise<TextureManifest>>()
let catalog: Promise<TextureSet[]> | null = null

/** One fetch-route call per id per session; a failure is forgotten so the next call retries. */
export function ensureTextureFetched(id: string, fetchImpl: FetchLike = fetch): Promise<TextureManifest> {
  const bare = bareTextureId(id)
  let p = manifests.get(bare)
  if (!p) {
    p = postJson<TextureManifest>('/api/scene3d/textures/fetch', { id: bare }, fetchImpl)
      .catch((err) => { manifests.delete(bare); throw err })
    manifests.set(bare, p)
  }
  return p
}

export function resolveTexturePhrase(phrase: string, fetchImpl: FetchLike = fetch): Promise<{ id: string | null; name: string | null }> {
  return postJson('/api/scene3d/textures/resolve', { phrase }, fetchImpl)
}

export function loadTextureCatalog(fetchImpl: FetchLike = fetch): Promise<TextureSet[]> {
  if (!catalog) {
    catalog = fetchImpl('/api/scene3d/textures/catalog')
      .then(async (r) => {
        if (!r.ok) throw new Error(`catalog ${r.status}`)
        const data: any = await r.json()
        return (data?.sets ?? []) as TextureSet[]
      })
      .catch((err) => { catalog = null; throw err })
  }
  return catalog
}

export function __resetTextureCachesForTest(): void {
  manifests.clear()
  catalog = null
}
