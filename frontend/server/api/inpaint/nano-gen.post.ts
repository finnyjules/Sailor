/**
 * POST /api/inpaint/nano-gen   Body: { prompt, image?, images? }
 *
 * High-quality object generation via Google Nano Banana Pro (Gemini 3 Pro
 * Image) on fal — the premium model option for Generate Object.
 *  - No image → text→image (a clean, complete, isolated object).
 *  - With `image` (a cropped scene region) → instruction edit that paints the
 *    object into that region, matched to the surrounding scene.
 *  - With `images` (an ordered list) → multi-image edit, e.g. wardrobe try-on
 *    ([person, garment]). `image_urls` takes an array natively; the prompt refers
 *    to "the first/second image". `images` takes precedence over `image`.
 *
 * Returns: { images: string[]; model } — base64 data URLs (CORS-safe), same
 * shape as /api/inpaint/text2img. Under /api/inpaint → already proxy-allowlisted.
 * Helpers (runFal/fetchAsDataUrl/getFalToken) are auto-imported from
 * server/utils/falRun.ts, server/utils/replicate.ts and server/utils/falStorage.ts.
 */
import { assertRateLimit } from '../../lib/rateLimit'
import { nanoGenInput } from '../../utils/inpaintFalInputs'

interface Body { prompt?: string; image?: string; images?: string[]; aspect_ratio?: string }

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'inpaint-nano-gen', 30)
  if (!getFalToken()) throw createError({ statusCode: 500, message: 'FAL_KEY is not set (add it to frontend/.env)' })
  const body = await readBody<Body>(event)

  const prompt = (body?.prompt ?? '').trim()
  if (!prompt) throw createError({ statusCode: 400, message: 'prompt is required' })

  const imageList = (Array.isArray(body?.images) ? body!.images : (body?.image ? [body.image] : []))
    .filter((s): s is string => typeof s === 'string' && s.length > 0)

  const { app, input } = nanoGenInput(prompt, imageList, typeof body?.aspect_ratio === 'string' ? body.aspect_ratio : undefined)

  const out = await runFal<{ images?: { url?: string }[] }>(app, input, { pollDeadlineMs: 150_000 })
  const url = out?.images?.[0]?.url
  if (!url) throw createError({ statusCode: 502, message: 'fal returned no image' })
  return { images: [await fetchAsDataUrl(url)], model: app }
})
