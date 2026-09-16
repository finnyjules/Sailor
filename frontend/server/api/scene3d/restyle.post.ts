// POST /api/scene3d/restyle — the S7 AI restyle pass. Re-skins ONE 3D object with a
// depth-structure-preserving image model (fal). The CLIENT bakes the object's beauty + depth crop
// (renderObjectPasses) and posts them here; this route builds the fal payload and dispatches it.
//
// THIN by design (mirrors server/api/inpaint/kontext.post.ts): validate → build via the pure
// restyleInput builder → runFal → firstFalImageUrl → return the fal CDN url. ALL metering lives in
// runFal (the ledger hold / moderation / settle) — the route holds no cost logic. runFal REFUSES a
// slug missing a MODEL_COSTS row ("unpriced model") before any request, and RESTYLE_MODELS is the
// dispatch allowlist so a slug the UI can pick is exactly a slug the route can send.
//
// The client then posts the returned `imageUrl` to /api/image-fetch, which copies the bytes into
// ComfyUI's input directory and returns a stable filename — the fal CDN link is temporary, so the
// persisted filename (the treatment's `resultRef`) is what survives a reload.
//
// Data URLs (~1 MP crops) pass straight as `image_url` / `control_image_url`, exactly as
// kontext.post.ts passes its source image. If fal ever rejects a crop for size, upload it first via
// uploadToFalStorage (server/utils/falStorage.ts) and pass the returned url — documented fallback,
// not wired in v1 (the crops are well under fal's inline-payload limit).
//
// runFal / firstFalImageUrl are auto-imported by Nitro from server/utils/falRun.ts.
import { assertRateLimit } from '../../lib/rateLimit'
import { pickRestyleModel } from '~~/app/data/scene3d-restyle-models'
import { restyleInput } from '../../utils/restyleFalInputs'
import { MOODBOARD_MAX_REFS } from '~~/shared/taste/moodboard'

interface Body {
  prompt?: string
  beauty?: string
  depth?: string
  strength?: number
  model?: string
  seed?: number
  styleRefs?: string[] // ≤3 moodboard reference images as data-URLs, resolved client-side
  styleText?: string   // moodboardStyleBlock(reading): palette + prose + avoids
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'scene3d-restyle', 20)
  const body = await readBody<Body>(event)

  const prompt = (body?.prompt ?? '').trim()
  if (!prompt) throw createError({ statusCode: 400, message: 'prompt (the restyle instruction) is required' })

  const styleRefs = Array.isArray(body?.styleRefs)
    ? body.styleRefs.filter((u): u is string => typeof u === 'string' && !!u).slice(0, MOODBOARD_MAX_REFS)
    : []
  const styleText = typeof body?.styleText === 'string' ? body.styleText : ''

  // A Style WITH reference images ⇒ the depth+style model; otherwise today's requested (selectable)
  // model. pickRestyleModel enforces the allowlist and can never return the route-internal model
  // from `requestedId` alone (it is selectable:false, reachable only via hasStyleRefs).
  const model = pickRestyleModel(body?.model, styleRefs.length > 0)

  const beauty = typeof body?.beauty === 'string' ? body.beauty : ''
  const depth = typeof body?.depth === 'string' ? body.depth : ''
  // 'image' models consume the beauty crop; 'depth' and 'depth+style' consume the depth crop.
  const control = model.control === 'image' ? beauty : depth
  if (!control) {
    throw createError({ statusCode: 400, message: `${model.control === 'image' ? 'beauty' : 'depth'} control image is required` })
  }

  const strength = Math.max(0, Math.min(1, Number.isFinite(body?.strength) ? (body!.strength as number) : 0.6))
  const seed = Number.isFinite(body?.seed) ? Math.round(body!.seed as number) : Math.floor(Date.now() % 2_000_000_000)

  const { app, input } = restyleInput(model, prompt, beauty, depth, strength, seed, styleRefs, styleText)
  // 240s: a depth-control generation queues + runs longer than the 120s default under load (the
  // S7 acceptance run saw a job still settling past 120s), and this route is a deliberate one-shot
  // user action, not a hot path — a generous deadline avoids a false timeout on a job that succeeds.
  const out = await runFal(app, input, { pollDeadlineMs: 240_000 })
  const imageUrl = firstFalImageUrl(out)
  if (!imageUrl) throw createError({ statusCode: 502, message: 'fal returned no image' })

  return { imageUrl, model: model.id, seed }
})
