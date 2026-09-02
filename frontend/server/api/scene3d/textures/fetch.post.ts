/**
 * POST /api/scene3d/textures/fetch  { id }
 * Downloads the 1K-JPG zip for one ambientCG set (first time only) into
 * `input/sailor_textures/<id>/`, keeps just the maps, and returns the manifest.
 * The browser cannot do this itself: ambientCG's download has no CORS header.
 * Concurrent requests for the same id share one in-flight promise.
 */
import { readFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getAmbientcgCatalog } from '../../../utils/ambientcgCatalog'
import { TEXTURE_ID_PREFIX } from '../../../utils/ambientcgResolve'
import { extractTextureZip, type TextureManifest } from '../../../utils/ambientcgExtract'

const COMFY_ROOT = join(process.cwd(), '..')
const TEXTURES_SUBDIR = 'sailor_textures'
const TEXTURES_DIR = join(COMFY_ROOT, 'input', TEXTURES_SUBDIR)
const RESOLUTION = '1K-JPG'
const DOWNLOAD_TIMEOUT_MS = 60_000

const inflight = new Map<string, Promise<TextureManifest>>()
const exists = (p: string) => access(p).then(() => true, () => false)

async function fetchSet(id: string): Promise<TextureManifest> {
  const dir = join(TEXTURES_DIR, id)
  const manifestPath = join(dir, 'manifest.json')
  if (await exists(manifestPath)) return JSON.parse(await readFile(manifestPath, 'utf8'))

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
  if (!/^[A-Za-z0-9]+$/.test(id)) throw createError({ statusCode: 400, message: 'a texture set id is required' })
  const sets = await getAmbientcgCatalog()
  const known = sets.find(s => s.id === id)
  if (!known) throw createError({ statusCode: 400, message: `unknown texture set: ${id}` })

  let p = inflight.get(known.id)
  if (!p) {
    p = fetchSet(known.id).finally(() => inflight.delete(known.id))
    inflight.set(known.id, p)
  }
  try {
    return await p
  } catch (err: any) {
    throw createError({ statusCode: 502, message: `Couldn't download this texture: ${err?.message ?? err}` })
  }
})
