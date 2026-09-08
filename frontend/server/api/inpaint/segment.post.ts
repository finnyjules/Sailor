import { buildSamInput, type SamRequestBody } from '../../utils/samInput'
import { assertRateLimit } from '../../lib/rateLimit'

/**
 * POST /api/inpaint/segment  (promptable click-to-select)
 *
 * Turn clicks into an inpaint mask with a promptable Segment-Anything model on
 * fal (fal-ai/sam-3/image). The user clicks an object, SAM 3 returns THAT
 * object's silhouette, and we feed it straight into the FLUX Fill mask. Extra
 * foreground points refine the selection; label-0 points subtract. Saves
 * hand-painting around objects.
 *
 * Body (see SamRequestBody):
 *   image   string  data URL (or public http URL) of the source image
 *   xPx,yPx number  legacy single click, in the source image's pixel space
 *   points  {x,y,label}[]  point prompts (label 1 = foreground, 0 = background);
 *                          wins over xPx/yPx when non-empty
 *   box     {xMin,yMin,xMax,yMax}  optional box prompt (image pixel space)
 *
 * Returns:
 *   { mask: string } — one data URL, WHITE = selected, BLACK = keep. This is the
 *   model's mask for the given points — no client-side segment-picking.
 *
 * NOTE: The SAM model ref and its input mapping are isolated in SAM_MODEL /
 * buildSamInput — if a different promptable SAM is preferred later, adjust just
 * those two. The client (useInpaint.segment) falls back to manual brushing if
 * this route errors, so an unconfigured/failed model degrades gracefully rather
 * than blocking inpainting.
 *
 * Verified live (2026-09-08): a single point selects the whole object at that
 * point's granularity (forehead point → whole dog; tongue point → tongue);
 * point_prompts genuinely steer the model. See samInput.ts for the input
 * fields that made it work (empty prompt, apply_mask:false, sync_mode:true).
 */
const SAM_MODEL = 'fal-ai/sam-3/image'

interface SamImage { url?: string }
interface SamOutput { image?: SamImage; masks?: SamImage[] }

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'inpaint-segment', 60)
  const body = await readBody<SamRequestBody>(event)
  if (!body?.image) throw createError({ statusCode: 400, message: 'image is required' })

  const input = buildSamInput(body)
  if (!input.point_prompts && !input.box_prompts) {
    throw createError({ statusCode: 400, message: 'a point or box prompt is required' })
  }
  const out = await runFal<SamOutput>(SAM_MODEL, input, { pollDeadlineMs: 90_000 })

  // sync_mode:true returns data URIs; prefer masks[0] (the binary mask), fall
  // back to `image` (identical to masks[0] when apply_mask:false).
  const url = out?.masks?.[0]?.url || out?.image?.url || null
  if (!url) throw createError({ statusCode: 502, message: 'Segmentation returned no mask' })

  // Already a data URI in sync_mode; only fetch through if a plain URL comes back.
  const mask = url.startsWith('data:') ? url : await fetchAsDataUrl(url)
  return { mask }
})
