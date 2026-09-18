// POST /api/scene3d/gen-3d — image → 3D (GLB) via a fal image-to-3D model.
// Returns the fal CDN GLB URL (fetchable by the studio's loadGlb).
//
// resolve3dModel is auto-imported from server/utils/scene3dGen.ts; runFal from
// server/utils/falRun.ts — same auto-import convention as /api/inpaint/flux-fill.post.ts.
import { assertRateLimit } from '../../lib/rateLimit'

interface Body {
  imageUrl?: string
  model?: string
  textured?: boolean
  seed?: number
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'scene3d-gen-3d', 6)
  const body = await readBody<Body>(event)
  const imageUrl = (body?.imageUrl ?? '').trim()
  if (!imageUrl) throw createError({ statusCode: 400, message: 'imageUrl is required' })

  const model = resolve3dModel(body?.model)
  const input = model.buildInput(imageUrl, { textured: body?.textured, seed: body?.seed })
  // 3D generation can take up to ~4 min — widen the poll deadline past the default 120s.
  const result = await runFal(model.app, input, { pollDeadlineMs: 300_000 })
  const glbUrl = model.glbUrlFrom(result)
  if (!glbUrl) throw createError({ statusCode: 502, message: 'fal returned no 3D model' })
  return { glbUrl }
})
