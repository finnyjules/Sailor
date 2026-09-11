/**
 * POST /api/vector/recraft-vectorize
 *
 * Raster→SVG via Recraft's vectorize model (fal-ai/recraft/vectorize) —
 * higher-fidelity tracing than local VTracer, at a per-call cost. Body (JSON):
 *   { image: string }   // data URL or public http(s) URL
 * Returns: { svg: string, sourceUrl: string }
 *
 * Use this when trace quality matters; default interactive vectorize should
 * prefer the free local /api/vector/trace.
 */
import { assertRateLimit } from '../../lib/rateLimit'
import { runFal } from '../../utils/falRun'
import { recraftVectorizeInput } from '../../utils/recraftFalInputs'

const FAL_APP = 'fal-ai/recraft/vectorize'

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'recraft-vectorize', 60)
  const body = await readBody(event) as { image?: string }
  if (!body.image) throw createError({ statusCode: 400, message: 'image is required (data URL or URL)' })

  const output = await runFal(FAL_APP, recraftVectorizeInput(body.image), { pollDeadlineMs: 90_000 })
  const url = (output as { image?: { url?: string } })?.image?.url
  if (!url) throw createError({ statusCode: 502, message: 'Recraft vectorize returned no output' })

  const svgRes = await fetch(url)
  if (!svgRes.ok) throw createError({ statusCode: 502, message: `Could not fetch vectorized SVG (${svgRes.status})` })
  const svg = await svgRes.text()
  return { svg, sourceUrl: url }
})
