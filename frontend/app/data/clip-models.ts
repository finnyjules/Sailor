// The three image-to-video models the Frame's Animate section offers for a living image.
// Durations mirror comfy_api_nodes/video_models.py (Seedance's list trimmed to ≤ 12 s: a
// loop longer than that is rarely what a layer wants and costs accordingly).
import { VIDEO_MODEL_USD } from '~/data/video-prices'

export interface ClipModel {
  id: 'seedance-2.0' | 'hailuo-h3' | 'luma-ray-2-720p'
  label: string
  durations: number[]
  defaultDuration: number
  provider: 'fal' | 'replicate'
  /** Luma has a native loop flag; the others loop by first = last frame. */
  loopsItself: boolean
}

export const CLIP_MODELS: ClipModel[] = [
  { id: 'luma-ray-2-720p', label: 'Luma, loops by itself', durations: [5, 9], defaultDuration: 5, provider: 'replicate', loopsItself: true },
  { id: 'seedance-2.0', label: 'Seedance', durations: [4, 5, 6, 7, 8, 9, 10, 11, 12], defaultDuration: 5, provider: 'fal', loopsItself: false },
  { id: 'hailuo-h3', label: 'Hailuo', durations: [5, 6, 10], defaultDuration: 5, provider: 'fal', loopsItself: false },
]

export function clipModel(id: string): ClipModel | null {
  return CLIP_MODELS.find(m => m.id === id) ?? null
}

/** Price for one attempt, scaled from the catalog's per-5-second row. */
export function clipPriceUsd(id: string, seconds: number): number | null {
  const row = VIDEO_MODEL_USD[id]
  if (!row) return null
  return row.usd * (Math.max(1, seconds) / 5)
}
