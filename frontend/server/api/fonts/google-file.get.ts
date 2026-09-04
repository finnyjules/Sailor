/**
 * GET /api/fonts/google-file?family=<name>&weight=<int>
 *
 * The shared Google Fonts cut route (Vector Type's "any font" program),
 * validated via validateGoogleCut() BEFORE any upstream fetch.
 *
 * The FAMILY is fail-closed: it must exist in the server's Google Fonts catalog
 * (server/utils/googleCatalog.ts), and an unknown one is a 400, never a silent
 * substitution. The WEIGHT is not: an unshipped weight SNAPS to the family's
 * nearest shipped one (ties → the lower), as does a missing weight (nearest to
 * 400). Archivo Black ships only 400, so a caller with a hardcoded `@700` would
 * otherwise 400 for no benefit when 400 is the honest answer. Only a
 * non-numeric weight is a 400.
 *
 * If the catalog itself can't be loaded (e.g. offline), this answers 503 —
 * it never falls open and fetches an unvalidated family/weight anyway.
 *
 * server/api/scene3d/google-font-file.get.ts re-exports this same handler,
 * so the 3D Studio inherits this validation too.
 */
import { getGoogleCatalog } from '../../utils/googleCatalog'
import { fetchGoogleCutTtf, validateGoogleCut } from '../../utils/googleFontFile'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)

  let catalog: Awaited<ReturnType<typeof getGoogleCatalog>>
  try {
    catalog = await getGoogleCatalog()
  } catch (err: any) {
    throw createError({ statusCode: 503, message: `Google Fonts catalog unavailable: ${err?.message ?? err}` })
  }

  const v = validateGoogleCut(catalog, query.family, query.weight)
  if (!v.ok) throw createError({ statusCode: v.status, message: v.message })

  const buf = await fetchGoogleCutTtf(v.family, v.weight)

  setHeader(event, 'Content-Type', 'font/ttf')
  setHeader(event, 'Cache-Control', 'public, max-age=86400, immutable')
  return buf
})
