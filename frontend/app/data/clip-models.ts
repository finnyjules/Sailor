// The image-to-video models the Frame's Animate section offers for a living image.
// Every one loops by first = last frame (Luma, which had a native loop flag, was dropped
// on Julien's call 2026-09-11: its output was not worth the row). H3 Max and Kling 3.0 Pro
// joined the same day on "are there more advanced versions"; the option label carries the
// output resolution and the flat price in parentheses, on Julien's ask.
// Durations mirror what each fal endpoint accepts, trimmed to what a loop wants (≤ 15 s).

export interface ClipModel {
  id: 'seedance-2.0' | 'hailuo-h3' | 'hailuo-h3-max' | 'kling-v3-pro'
  /** Plain name, e.g. "Seedance 2.0". */
  name: string
  /** What the model renders at — the clip is capped at this, so a large still softens below it. */
  resolution: string
  durations: number[]
  defaultDuration: number
  /** Flat price per attempt in USD — the same number the ledger holds (MODEL_COSTS row for
   *  the fal slug in server/utils/priceBook.ts). Kling is not in the shared video catalog,
   *  so the clip catalog owns its prices; a test pins the shared ones to VIDEO_MODEL_USD. */
  usd: number
}

export const CLIP_MODELS: ClipModel[] = [
  { id: 'seedance-2.0', name: 'Seedance 2.0', resolution: '720p', durations: [4, 5, 6, 7, 8, 9, 10, 11, 12], defaultDuration: 5, usd: 0.6 },
  { id: 'hailuo-h3', name: 'Hailuo H3', resolution: '768p', durations: [5, 6, 10], defaultDuration: 5, usd: 0.3 },
  { id: 'hailuo-h3-max', name: 'Hailuo H3 Max', resolution: '768p', durations: [5, 6, 8, 10, 12, 15], defaultDuration: 5, usd: 0.4 },
  { id: 'kling-v3-pro', name: 'Kling 3.0 Pro', resolution: '1080p', durations: [3, 4, 5, 6, 8, 10], defaultDuration: 5, usd: 0.56 },
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
  return clipModel(id)?.usd ?? null
}

/** The dropdown text: "Seedance 2.0 (720p · $0.60)" — name, output resolution, flat price. */
export function clipModelLabel(m: ClipModel): string {
  const usd = clipPriceUsd(m.id)
  return usd == null ? `${m.name} (${m.resolution})` : `${m.name} (${m.resolution} · $${usd.toFixed(2)})`
}
