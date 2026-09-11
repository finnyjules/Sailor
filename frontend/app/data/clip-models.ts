// The two image-to-video models the Frame's Animate section offers for a living image.
// Both loop by first = last frame (Luma, which had a native loop flag, was dropped on
// Julien's call 2026-09-11: its output was not worth the row).
// Durations mirror comfy_api_nodes/video_models.py (Seedance's list trimmed to ≤ 12 s: a
// loop longer than that is rarely what a layer wants and costs accordingly).
import { VIDEO_MODEL_USD } from '~/data/video-prices'

export interface ClipModel {
  id: 'seedance-2.0' | 'hailuo-h3'
  label: string
  durations: number[]
  defaultDuration: number
}

export const CLIP_MODELS: ClipModel[] = [
  { id: 'seedance-2.0', label: 'Seedance 2.0', durations: [4, 5, 6, 7, 8, 9, 10, 11, 12], defaultDuration: 5 },
  { id: 'hailuo-h3', label: 'Hailuo H3', durations: [5, 6, 10], defaultDuration: 5 },
]

export function clipModel(id: string): ClipModel | null {
  return CLIP_MODELS.find(m => m.id === id) ?? null
}

/**
 * Price for one attempt: the catalog's flat row, NOT scaled by length.
 *
 * The ledger hold this quotes against is the flat 5-second MODEL_COSTS row for the
 * slug (see the metering note in server/api/frame/animate.post.ts) — a duration-aware
 * hold is not wired, so a 10 s clip is held and charged at exactly the same number as
 * a 5 s one. Scaling the quote here made the button promise a price the ledger never
 * takes. Quote what is actually charged.
 */
export function clipPriceUsd(id: string): number | null {
  const row = VIDEO_MODEL_USD[id]
  if (!row) return null
  return row.usd
}
