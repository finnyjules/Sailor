/**
 * POST /api/scene3d/textures/resolve  { phrase }
 * Plain word → ambientCG set id. A miss is `{ id: null, name: null }` with 200, so the
 * caller can tell "nothing matched" from "the library is down" (502).
 */
import { getAmbientcgCatalog } from '../../../utils/ambientcgCatalog'
import { resolveTexturePhrase } from '../../../utils/ambientcgResolve'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ phrase?: unknown }>(event)
  const phrase = typeof body?.phrase === 'string' ? body.phrase.slice(0, 120) : ''
  if (!phrase.trim()) throw createError({ statusCode: 400, message: 'phrase is required' })
  const sets = await getAmbientcgCatalog()
  return resolveTexturePhrase(phrase, sets) ?? { id: null, name: null }
})
