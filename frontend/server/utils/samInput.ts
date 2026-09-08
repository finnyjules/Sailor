/**
 * Map our /api/inpaint/segment request body to SAM 3's promptable input
 * (fal-ai/sam-3/image). Kept as a pure util (out of the route file) so it's
 * unit-testable and so swapping SAM models stays a one-spot change (see
 * segment.post.ts NOTE).
 *
 * Unlike the old segment-everything SAM, SAM 3 actually consumes the points:
 * one click → the object under it, extra points refine, label-0 points subtract.
 * So the route returns the model's single mask directly — no client-side picking.
 *
 * Body shapes:
 *  - legacy click-to-select: { xPx, yPx } → one foreground point
 *  - point prompts:          { points: [{x, y, label}] } — label 1 = foreground,
 *    0 = background (subtract). Wins over xPx/yPx when non-empty.
 *  - optional box prompt:    { box: {xMin,yMin,xMax,yMax} } → one box_prompt.
 *
 * Verified live against fal-ai/sam-3/image:
 *  - prompt MUST be '' — omitting it defaults to the model's text prompt
 *    ("wheel"), which would hijack the segmentation.
 *  - apply_mask:false returns the raw binary mask (white = object, black = keep),
 *    matching the inpaint mask convention; apply_mask:true returns an overlay.
 *  - sync_mode:true returns mask URLs as data URIs (no CDN round-trip / CORS).
 */
export interface SamRequestPoint { x: number; y: number; label: 0 | 1 }
export interface SamRequestBox { xMin: number; yMin: number; xMax: number; yMax: number }
export interface SamRequestBody {
  image?: string
  xPx?: number
  yPx?: number
  points?: SamRequestPoint[]
  box?: SamRequestBox
}

export function buildSamInput(body: SamRequestBody): Record<string, unknown> {
  const pts = (body.points?.length)
    ? body.points
    : [{ x: body.xPx ?? 0, y: body.yPx ?? 0, label: 1 as const }]
  const input: Record<string, unknown> = {
    image_url: body.image,
    prompt: '',
    point_prompts: pts.map(p => ({ x: Math.round(p.x), y: Math.round(p.y), label: p.label === 0 ? 0 : 1 })),
    apply_mask: false,
    sync_mode: true,
    output_format: 'png',
    return_multiple_masks: false,
    max_masks: 1,
  }
  if (body.box) {
    input.box_prompts = [{
      x_min: Math.round(body.box.xMin), y_min: Math.round(body.box.yMin),
      x_max: Math.round(body.box.xMax), y_max: Math.round(body.box.yMax),
    }]
  }
  return input
}
