/**
 * POST /api/inpaint/kontext
 *
 * Mask-FREE instruction editing via FLUX.1 Kontext on fal. The user gives
 * the whole image plus an instruction ("make the sky a sunset") and the model
 * decides the region itself — the complement to the masked /flux-fill route.
 *
 * Body:
 *   image   string  data URL (or public http URL) of the source image
 *   prompt  string  the edit instruction
 *   count   number  variations (default 1, max 4)
 *   seed    number  base seed; variation i uses seed+i
 *
 * Returns: { images: string[] }  — data URLs (base64), to dodge CORS like /flux-fill.
 */
import { assertRateLimit } from '../../lib/rateLimit'
import { kontextInput } from '../../utils/inpaintFalInputs'

const APP = 'fal-ai/flux-kontext/dev'

interface Body { image?: string; prompt?: string; count?: number; seed?: number }

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'inpaint-kontext', 30)
  const body = await readBody<Body>(event)

  if (!body?.image) throw createError({ statusCode: 400, message: 'image is required' })
  const prompt = (body.prompt ?? '').trim()
  if (!prompt) throw createError({ statusCode: 400, message: 'prompt (the edit instruction) is required' })

  const count = Math.max(1, Math.min(4, Math.round(body.count ?? 1)))
  const baseSeed = Number.isFinite(body.seed) ? Math.round(body.seed as number) : Math.floor(Date.now() % 2_000_000_000)

  const seeds = Array.from({ length: count }, (_, i) => baseSeed + i)
  const images = await Promise.all(
    seeds.map(async (seed) => {
      const out = await runFal(APP, kontextInput(prompt, body.image as string, seed), { pollDeadlineMs: 120_000 })
      const url = firstFalImageUrl(out)
      if (!url) throw createError({ statusCode: 502, message: 'fal returned no image' })
      return fetchAsDataUrl(url)
    }),
  )

  return { images, model: APP }
})
