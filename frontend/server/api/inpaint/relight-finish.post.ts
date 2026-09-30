/**
 * POST /api/inpaint/relight-finish — Relight stage 3 ("Finish", spec
 * 2026-09-30-relight-stage3-finish, Task 1). Sends the Relight layer's photo
 * (the ORIGINAL) and the live relit render (the GUIDE, a rough lighting
 * preview only) to Nano Banana 2 on fal, which redraws the original with the
 * guide's lighting. Sibling of pose.post.ts: same fal app
 * (fal-ai/nano-banana-2/edit), two images in, one image out.
 *
 * The prompt is fixed on the server (RELIGHT_FINISH_PROMPT) — the client
 * never sends one.
 *
 * Body:
 *   original  string  data URL of the layer's photo, without Relight
 *   guide     string  data URL of the box render WITH Relight applied — a
 *                      rough lighting preview only, not a picture to keep
 *
 * Returns: { images: [dataUrl] }
 *          503 { off: true }    — kill switch (NUXT_RELIGHT_FINISH=off), or a
 *                                 hosted unpriced/unmetered refusal
 *          402 { message }      — hosted, not enough credits
 *          400 { message }      — a missing/non-data-URL image, or one over 20 MB
 *          502 { message }      — provider failure (no image, or its download failed)
 */
import { assertRateLimit } from '../../lib/rateLimit'
import { relightFinishInput } from '../../utils/inpaintFalInputs'
import { runFal, firstFalImageUrl } from '../../utils/falRun'
import { fetchAsDataUrl } from '../../utils/replicate'
import { MeterRefusalError } from '../../utils/requestMeter'
import { FINISH_APP } from '../../../shared/pricing/relightFinish'

/** Guide/original are inlined into the request body as data URLs — 20 MB of
 *  base64 text is already a very large photo, and fal's own request-size
 *  limits would refuse well before this anyway. */
const MAX_IMAGE_STRING_LENGTH = 20 * 1024 * 1024

interface Body { original?: string; guide?: string }

function assertDataUrlImage(value: string | undefined, field: string): asserts value is string {
  if (!value) throw createError({ statusCode: 400, message: `${field} image is required` })
  if (!value.startsWith('data:image/')) throw createError({ statusCode: 400, message: `${field} must be a data:image/ URL` })
  if (value.length > MAX_IMAGE_STRING_LENGTH) throw createError({ statusCode: 400, message: `${field} image is too large (over 20 MB)` })
}

/** A run's non-provider outcome, answered with its own status (not thrown as a 502) — mirrors
 *  depth/surfaces.post.ts's SurfacesAnswer. */
class FinishAnswer extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) { super(String(body.message ?? status)) }
}

export default defineEventHandler(async (event) => {
  if (process.env.NUXT_RELIGHT_FINISH === 'off') {
    setResponseStatus(event, 503)
    return { off: true }
  }

  assertRateLimit(event, 'inpaint-relight-finish', 20)

  const body = await readBody<Body>(event)
  assertDataUrlImage(body?.original, 'original')
  assertDataUrlImage(body?.guide, 'guide')

  try {
    const out = await runFal(FINISH_APP, relightFinishInput(body.original, body.guide), { pollDeadlineMs: 150_000 })
    const url = firstFalImageUrl(out)
    if (!url) throw createError({ statusCode: 502, message: 'fal returned no image' })
    const image = await fetchAsDataUrl(url)
    return { images: [image] }
  } catch (err) {
    // Hosted refusals pass through as themselves, as the surfaces route does:
    // 402 no balance; an unpriced/unmetered refusal is a server decision the
    // user can't act on, so it is quiet like the kill switch.
    if (err instanceof MeterRefusalError) {
      const answer = err.statusCode === 402
        ? new FinishAnswer(402, { message: err.message })
        : new FinishAnswer(503, { off: true, message: err.message })
      setResponseStatus(event, answer.status)
      return answer.body
    }
    // Anything else from the provider (FAILED status, poll deadline, a failed result fetch)
    // answers 502 { message } like the surfaces route, never a bare 500.
    if ((err as { statusCode?: number })?.statusCode === 502) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw createError({ statusCode: 502, message: `nano-banana-2: ${message}` })
  }
})
