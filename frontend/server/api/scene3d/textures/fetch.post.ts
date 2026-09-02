/**
 * POST /api/scene3d/textures/fetch  { id }
 * Downloads the 1K-JPG zip for one ambientCG set (first time only) into
 * `input/sailor_textures/<id>/`, keeps just the maps, and returns the manifest.
 * The browser cannot do this itself: ambientCG's download has no CORS header.
 * Concurrent requests for the same id share one in-flight promise.
 */
import { rm } from 'node:fs/promises'
import { getAmbientcgCatalog } from '../../../utils/ambientcgCatalog'
import { TEXTURE_ID_PREFIX } from '../../../utils/ambientcgResolve'
import { engineDirForType } from '../../../utils/inputUploads'
import { readDiskManifest, textureSetDir } from '../../../utils/ambientcgDiskCache'
import { extractTextureZip, type TextureManifest } from '../../../utils/ambientcgExtract'

const RESOLUTION = '1K-JPG'
const DOWNLOAD_TIMEOUT_MS = 60_000

const inflight = new Map<string, Promise<TextureManifest>>()

/**
 * The engine's `input/`, resolved per request by the shared walk-up
 * (`main.py` + `input/`, `SAILOR_ENGINE_ROOT` honoured) rather than the old
 * `join(process.cwd(), '..')` guess. inputUploads.ts documents that exact
 * guess as a bug it already fixed: a Nitro process launched from anywhere but
 * `frontend/` wrote the maps into a phantom directory, returned 200, and then
 * every `/view` read of those files 404'd.
 */
function inputDirOrThrow(): string {
  const dir = engineDirForType('input')
  if (!dir) throw createError({ statusCode: 502, message: "Couldn't find the engine's input folder on this server" })
  return dir
}

async function downloadSet(inputDir: string, id: string): Promise<TextureManifest> {
  // Re-check disk inside the in-flight slot: a set can land between the
  // handler's read and this promise actually starting.
  const onDisk = await readDiskManifest(inputDir, id)
  if (onDisk) return onDisk

  const dir = textureSetDir(inputDir, id)
  const url = `https://ambientcg.com/get?file=${id}_${RESOLUTION}.zip`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
  let bytes: Uint8Array
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal })
    if (!r.ok) throw new Error(`ambientCG download ${r.status}`)
    bytes = new Uint8Array(await r.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
  try {
    return await extractTextureZip(bytes, id, dir)
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ id?: unknown }>(event)
  let id = typeof body?.id === 'string' ? body.id.trim() : ''
  if (id.toLowerCase().startsWith(TEXTURE_ID_PREFIX)) id = id.slice(TEXTURE_ID_PREFIX.length)
  // The security-relevant check, and the only one a bind needs: the id becomes
  // a path segment, so it must be alphanumeric.
  if (!/^[A-Za-z0-9]+$/.test(id)) throw createError({ statusCode: 400, message: 'a texture set id is required' })

  const inputDir = inputDirOrThrow()

  // Disk BEFORE the catalog. The catalog is a network call to ambientcg.com;
  // consulting it first meant that after a server restart with ambientcg.com
  // unreachable, every already-downloaded set failed to bind even though its
  // maps were sitting right there. Membership only matters for a download.
  const onDisk = await readDiskManifest(inputDir, id)
  if (onDisk) return onDisk

  const sets = await getAmbientcgCatalog()
  const known = sets.find(s => s.id === id)
  if (!known) throw createError({ statusCode: 400, message: `unknown texture set: ${id}` })

  let p = inflight.get(known.id)
  if (!p) {
    p = downloadSet(inputDir, known.id).finally(() => inflight.delete(known.id))
    inflight.set(known.id, p)
  }
  try {
    return await p
  } catch (err: any) {
    throw createError({ statusCode: 502, message: `Couldn't download this texture: ${err?.message ?? err}` })
  }
})
