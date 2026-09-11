/**
 * POST /api/inpaint/text2img
 *
 * Text-to-image via fal, with a tier table across FLUX.1 [schnell]/[dev],
 * Seedream 4.5, and FLUX.2 [pro]. Schnell is the cheap, fast (4-step) default;
 * used by the Compositor's Generative Fill when nothing is selected, to
 * conjure a brand-new subject and drop it in as a layer.
 *
 * (Lives under inpaint/ alongside flux-fill so it shares that route group.)
 *
 * Body:
 *   prompt        string  what to generate (required)
 *   aspect_ratio  string  one of the fal presets, or any `w:h` ratio (default '1:1')
 *   count         number  variations (default 1, max 4)
 *   seed          number  base seed; variation i uses seed+i
 *   model         string  tier: 'flux-schnell' | 'flux-dev' | 'seedream-4.5' | 'flux-2-pro'
 *
 * Returns: { images: string[] } — data URLs (base64), to dodge fal's CDN CORS
 * and let the client re-upload into ComfyUI's input dir.
 *
 * Helpers (runFal/firstFalImageUrl/fetchAsDataUrl) are auto-imported from
 * server/utils/falRun.ts and server/utils/replicate.ts. Payload shapes per
 * tier live in server/utils/inpaintFalInputs.ts (text2imgInput) so the exact
 * fal app + input for each tier is pinned by a unit test.
 */
import { assertRateLimit } from '../../lib/rateLimit'
import { text2imgInput } from '../../utils/inpaintFalInputs'

interface Body {
  prompt?: string
  aspect_ratio?: string
  count?: number
  seed?: number
  model?: string
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'inpaint-text2img', 30)
  const body = await readBody<Body>(event)

  const prompt = (body?.prompt ?? '').trim()
  if (!prompt) throw createError({ statusCode: 400, message: 'prompt is required' })

  const aspect_ratio = body?.aspect_ratio || '1:1'
  const count = Math.max(1, Math.min(4, Math.round(body?.count ?? 1)))
  const baseSeed = Number.isFinite(body?.seed) ? Math.round(body!.seed as number) : Math.floor(Date.now() % 2_000_000_000)
  const tierName = body?.model ?? 'flux-schnell'

  const seeds = Array.from({ length: count }, (_, i) => baseSeed + i)
  const calls = seeds.map(seed => text2imgInput(tierName, prompt, aspect_ratio, seed))
  const app = calls[0]!.app

  const outputs = await Promise.all(
    calls.map(async ({ app: callApp, input }) => {
      const out = await runFal(callApp, input, { pollDeadlineMs: 180_000 })
      const url = firstFalImageUrl(out)
      if (!url) throw createError({ statusCode: 502, message: 'fal returned no image' })
      return fetchAsDataUrl(url)
    }),
  )

  return { images: outputs, model: app }
})
