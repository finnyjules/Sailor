/**
 * POST /api/inpaint/remove-bg
 *
 * Cloud background removal via fal (BiRefNet v2) — the "generator" path,
 * higher quality than a local rembg node. Returns the cutout as a transparent
 * PNG so it can replace the image layer in the Compositor.
 *
 * (Lives under inpaint/ alongside flux-fill / text2img so it shares that route
 * group — Nuxt dev only hot-registers new files in already-watched dirs.)
 *
 * Body:
 *   image  string  data URL (or public http URL) of the source image
 *
 * Returns: { image: string }  — a data URL (base64 PNG with alpha), to dodge
 * fal's CDN CORS and let the client re-upload into ComfyUI's input.
 *
 * Helpers (runFal/fetchAsDataUrl) are auto-imported from
 * server/utils/falRun.ts and server/utils/replicate.ts.
 */
import { assertRateLimit } from '../../lib/rateLimit'
import { removeBgInput } from '../../utils/inpaintFalInputs'

const APP = 'fal-ai/birefnet/v2'

interface Body {
  image?: string
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'inpaint-remove-bg', 60)
  const body = await readBody<Body>(event)

  if (!body?.image) throw createError({ statusCode: 400, message: 'image is required' })

  const out = await runFal<{ image?: { url?: string } }>(APP, removeBgInput(body.image), { pollDeadlineMs: 120_000 })

  const url = out?.image?.url
  if (!url) throw createError({ statusCode: 502, message: 'fal returned no image' })

  return { image: await fetchAsDataUrl(url), model: APP }
})
