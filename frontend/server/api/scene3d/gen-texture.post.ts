// POST /api/scene3d/gen-texture — text → a flat, tileable surface swatch via fal FLUX, for
// the 3D Studio's image material. Sibling of gen-image.post.ts, which shapes its prompt the
// other way (one clean object on a plain ground, as a reference for image-to-3D).
//
// Returns a public fal CDN URL. The CLIENT then posts that url to /api/image-fetch, which
// downloads it into ComfyUI's input directory and hands back the filename `material.image`
// needs — a generated texture must live in the input directory like an uploaded one, or it
// vanishes the moment the CDN link expires.
//
// runFal / firstFalImageUrl / shapeTexturePrompt are auto-imported by Nitro from server/utils.
import { assertRateLimit } from '../../lib/rateLimit'

interface Body {
  prompt?: string
  seed?: number
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'scene3d-gen-texture', 30)
  const body = await readBody<Body>(event)
  const prompt = (body?.prompt ?? '').trim()
  if (!prompt) throw createError({ statusCode: 400, message: 'prompt is required' })
  const seed = Number.isFinite(body?.seed) ? Math.round(body!.seed as number) : Math.floor(Date.now() % 2_000_000_000)

  const result = await runFal('fal-ai/flux/dev', {
    prompt: shapeTexturePrompt(prompt),
    image_size: 'square_hd',
    num_images: 1,
    seed,
  })
  const imageUrl = firstFalImageUrl(result)
  if (!imageUrl) throw createError({ statusCode: 502, message: 'fal returned no image' })
  return { imageUrl, seed }
})
