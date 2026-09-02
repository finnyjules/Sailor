/**
 * GET /api/scene3d/textures/catalog
 * The slim ambientCG material index for the 3D Studio texture picker.
 * Response: `{ sets: AmbientcgSet[], count: number }`.
 */
import { getAmbientcgCatalog } from '../../../utils/ambientcgCatalog'

export default defineEventHandler(async () => {
  const sets = await getAmbientcgCatalog()
  return { sets, count: sets.length }
})
