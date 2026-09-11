/**
 * POST /api/vector/recraft-generate
 *
 * Text→SVG via Recraft (fal-ai/recraft/v3/text-to-image) — the only production
 * model that returns genuinely editable SVG. Body (JSON):
 *   { prompt: string, style?: string, size?: string }
 * Returns: { svg: string, sourceUrl: string }  (fetched SVG markup, ready for svgToPathLayers)
 *
 * `style` still accepts recraft-v3-svg's old vocabulary: 'any' | 'engraving' |
 * 'line_art' | 'line_circuit' | 'linocut' ('any' is the general-purpose vector
 * style); recraftGenerateInput maps these onto fal's `vector_illustration`
 * style family (or passes an already fal-native `vector_illustration[/sub]`
 * value straight through).
 */
import { assertRateLimit } from '../../lib/rateLimit'
import { runFal, firstFalImageUrl } from '../../utils/falRun'
import { recraftGenerateInput } from '../../utils/recraftFalInputs'

const FAL_APP = 'fal-ai/recraft/v3/text-to-image'
const VALID_STYLES = new Set(['any', 'engraving', 'line_art', 'line_circuit', 'linocut'])

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'recraft-generate', 30)
  const body = await readBody(event) as { prompt?: string; style?: string; size?: string }
  const prompt = (body.prompt || '').trim()
  if (!prompt) throw createError({ statusCode: 400, message: 'prompt is required' })

  const style = body.style && VALID_STYLES.has(body.style) ? body.style : 'any'
  const input = recraftGenerateInput(prompt, style, body.size || '1024x1024')

  const output = await runFal(FAL_APP, input, { pollDeadlineMs: 90_000 })
  const url = firstFalImageUrl(output)
  if (!url) throw createError({ statusCode: 502, message: 'Recraft returned no SVG output' })

  // Recraft returns a URL to the .svg; fetch the markup so the client gets a
  // ready-to-import string (and we avoid CORS on fal's CDN).
  const svgRes = await fetch(url)
  if (!svgRes.ok) throw createError({ statusCode: 502, message: `Could not fetch generated SVG (${svgRes.status})` })
  const svg = await svgRes.text()
  return { svg, sourceUrl: url }
})
