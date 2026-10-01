/**
 * SAM 3's requests (fal-ai/sam-3/image), shared by the inpaint click-to-select
 * route (server/api/inpaint/segment.post.ts) and the runner's Mask by text,
 * Mask extractor (step 3, R7.4) and Subject mask (R7.5):
 * server/runner/generators/localModels.ts.
 * Moved here from server/utils/samInput.ts (which re-exports it).
 *
 * Unlike the old segment-everything SAM, SAM 3 actually consumes the points:
 * one click → the object under it, extra points refine, label-0 points subtract.
 * So the route returns the model's single mask directly — no client-side picking.
 *
 * Body shapes (the route's):
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
 *    The runner leaves it out (`syncMode: false`): it downloads the answer's
 *    links as every runner node does.
 */
import { pyFloatOf, pyIntOf } from './pyText'

export interface SamRequestPoint { x: number; y: number; label: 0 | 1 }
export interface SamRequestBox { xMin: number; yMin: number; xMax: number; yMax: number }
export interface SamRequestBody {
  image?: string
  xPx?: number
  yPx?: number
  points?: SamRequestPoint[]
  box?: SamRequestBox
}

/** fal's SAM 3 on pictures: the route's endpoint and the runner's (R7.4, family `sam-3-masks`). */
export const SAM_3_IMAGE_APP = 'fal-ai/sam-3/image'

/**
 * The most masks a text call asks for: the schema's `max_masks` maximum (its
 * default is 3). CLIPSeg, which Mask by text ran, marks every match; the
 * runner takes the union of every mask SAM 3 answers (ruling (k)), so it asks
 * for as many as SAM 3 gives. The price is per request, whatever comes back.
 */
export const SAM_3_MAX_MASKS = 32

export function buildSamInput(body: SamRequestBody, o: { syncMode?: boolean } = {}): Record<string, unknown> {
  const input: Record<string, unknown> = {
    image_url: body.image,
    prompt: '',
    apply_mask: false,
    ...(o.syncMode === false ? {} : { sync_mode: true }),
    output_format: 'png',
    return_multiple_masks: false,
    max_masks: 1,
  }
  // Points: explicit list wins; else the legacy single xPx/yPx click. A box-only
  // request emits NO points — fabricating a (0,0) fallback point would drop a
  // stray foreground marker in the corner and corrupt the box segmentation.
  const pts = body.points?.length
    ? body.points
    : (body.xPx != null || body.yPx != null)
      ? [{ x: body.xPx ?? 0, y: body.yPx ?? 0, label: 1 as const }]
      : []
  if (pts.length) {
    input.point_prompts = pts.map(p => ({ x: Math.round(p.x), y: Math.round(p.y), label: p.label === 0 ? 0 : 1 }))
  }
  if (body.box) {
    input.box_prompts = [{
      x_min: Math.round(body.box.xMin), y_min: Math.round(body.box.yMin),
      x_max: Math.round(body.box.xMax), y_max: Math.round(body.box.yMax),
    }]
  }
  return input
}

/** Mask extractor's call (R7.4): the clicks as pixel points, one mask back (`masks[0]`). */
export function samPointsInput(imageUrl: string, points: readonly SamRequestPoint[]): Record<string, unknown> {
  return buildSamInput({ image: imageUrl, points: [...points] }, { syncMode: false })
}

/** Mask by text's call (R7.4): the words, every mask back (their union is the mask, ruling (k)). */
export function samTextInput(imageUrl: string, prompt: string): Record<string, unknown> {
  return { image_url: imageUrl, prompt, apply_mask: false, output_format: 'png', return_multiple_masks: true, max_masks: SAM_3_MAX_MASKS }
}

/** The candidates Subject mask chooses from: MobileSAM's three (its multimask output), SAM 3's default `max_masks`. */
export const SAM_3_SUBJECT_MASKS = 3

/**
 * Subject mask's call (R7.5): one positive click at `(point_x·W, point_y·H)`,
 * rounded to whole pixels as the route rounds them and kept on the picture
 * (a click at 1.0 is the last pixel, not one past it), and every candidate
 * back (`return_multiple_masks`) for the node's best / largest / smallest.
 */
export function samSubjectInput(imageUrl: string, pointX: number, pointY: number, w: number, h: number): Record<string, unknown> {
  const x = Math.max(0, Math.min(w - 1, Math.round(pointX * w)))
  const y = Math.max(0, Math.min(h - 1, Math.round(pointY * h)))
  return { ...buildSamInput({ image: imageUrl, points: [{ x, y, label: 1 }] }, { syncMode: false }), return_multiple_masks: true, max_masks: SAM_3_SUBJECT_MASKS }
}

/**
 * How Mask extractor's `points` text reads (comfy_extras/nodes_matte_ml.py
 * :190-208), for a picture `w` × `h`:
 *   - `ok`: the pixel points Python's processor receives (exact);
 *   - `fails`: Python raises on it (an entry that isn't an object, no x or y,
 *     a number float() or int() refuses, an infinite or NaN coordinate);
 *   - `label`: Python runs it, but a label is neither 0 nor 1, which SAM 3's
 *     schema doesn't take (a stop-gap: left to the engine);
 *   - `unreadable`: text JSON.parse refuses that Python's json.loads may read
 *     (NaN, Infinity): left to the engine as the bake cards' params are.
 */
export type MaskPoints =
  | { ok: true; points: SamRequestPoint[] }
  | { ok: false; why: 'fails' | 'label' | 'unreadable' }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Python float(v) for a JSON value, or null where float() raises. */
function pyFloat(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') return pyFloatOf(v)
  return null
}

/** Python int(v) for a JSON value, or null where int() raises. */
function pyInt(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null
  if (typeof v === 'string') return pyIntOf(v)
  return null
}

/** One coordinate: max(0, min(side − 1, int(float(v) · side))), or null where Python raises. */
function coordOf(v: unknown, side: number): number | null {
  const f = pyFloat(v)
  if (f === null) return null
  const x = f * side
  if (!Number.isFinite(x)) return null
  return Math.max(0, Math.min(side - 1, Math.trunc(x)))
}

export function parseMaskPoints(text: unknown, w: number, h: number): MaskPoints {
  let pts: unknown = []
  if (typeof text === 'string' && text) {
    try { pts = JSON.parse(text) }
    catch {
      if (/NaN|Infinity/.test(text)) return { ok: false, why: 'unreadable' }
      pts = []
    }
  }
  else if (text !== undefined && text !== null && text !== '' && typeof text !== 'string') return { ok: false, why: 'fails' }
  if (!Array.isArray(pts)) pts = []
  const list = (pts as unknown[]).length ? (pts as unknown[]) : [{ x: 0.5, y: 0.5, label: 1 }]
  const points: SamRequestPoint[] = []
  const labels: number[] = []
  for (const p of list) {
    if (!isObject(p) || !Object.prototype.hasOwnProperty.call(p, 'x') || !Object.prototype.hasOwnProperty.call(p, 'y')) return { ok: false, why: 'fails' }
    const x = coordOf(p.x, w)
    const y = coordOf(p.y, h)
    if (x === null || y === null) return { ok: false, why: 'fails' }
    points.push({ x, y, label: 1 })
  }
  // Python reads every label after every coordinate (two list comprehensions).
  for (const p of list as Record<string, unknown>[]) {
    const l = Object.prototype.hasOwnProperty.call(p, 'label') ? pyInt(p.label) : 1
    if (l === null) return { ok: false, why: 'fails' }
    labels.push(l)
  }
  if (labels.some(l => l !== 0 && l !== 1)) return { ok: false, why: 'label' }
  return { ok: true, points: points.map((p, i) => ({ ...p, label: labels[i] as 0 | 1 })) }
}
