// The image-to-video models the Frame's Animate section offers for a living image.
// Every one loops by first = last frame (Luma, which had a native loop flag, was dropped
// on Julien's call 2026-09-11: its output was not worth the row). H3 Max and Kling 3.0 Pro
// joined the same day on "are there more advanced versions"; the option label carries the
// output resolution and the price in parentheses, on Julien's ask — in CREDITS, not
// dollars, on his 2026-09-12 "instead of $ can we use credits".
// Durations mirror what each fal endpoint accepts, trimmed to what a loop wants (≤ 15 s).
//
// Priced per second (Task P5): `clipRequest` is THE request the route sends
// (server/api/frame/animate.post.ts calls it), and the price shown here is the
// shared price of that same request (shared/pricing/clipSettings.ts requestPrice) —
// the figure runFal holds and charges. So the button and the ledger agree for every
// model × length, pinned by test.
import { requestPrice } from '../../shared/pricing/clipSettings'

export interface ClipModel {
  id: 'seedance-2.0' | 'hailuo-h3' | 'hailuo-h3-max' | 'kling-v3-pro' | 'flux-3-draft'
  /** Plain name, e.g. "Seedance 2.0". */
  name: string
  /** What the model renders at — the clip is capped at this, so a large still softens below it. */
  resolution: string
  durations: number[]
  defaultDuration: number
}

export const CLIP_MODELS: ClipModel[] = [
  { id: 'seedance-2.0', name: 'Seedance 2.0', resolution: '720p', durations: [4, 5, 6, 7, 8, 9, 10, 11, 12], defaultDuration: 5 },
  { id: 'hailuo-h3', name: 'Hailuo H3', resolution: '768p', durations: [5, 6, 10], defaultDuration: 5 },
  { id: 'hailuo-h3-max', name: 'Hailuo H3 Max', resolution: '768p', durations: [5, 6, 8, 10, 12, 15], defaultDuration: 5 },
  { id: 'kling-v3-pro', name: 'Kling 3.0 Pro', resolution: '1080p', durations: [3, 4, 5, 6, 8, 10], defaultDuration: 5 },
  // FLUX 3 (BFL) has a first-class first-last-frame endpoint on fal — the loop the other
  // models are coaxed into (still as first AND last) is native here. The DRAFT tier (720p,
  // ~$0.06/s) is the row: a keyed looping element rarely needs 1080p and the keyer downscales
  // anyway, so this is the cheap fast loop; full quality is a one-line endpoint swap if wanted.
  { id: 'flux-3-draft', name: 'FLUX 3 draft', resolution: '720p', durations: [5, 10, 15], defaultDuration: 5 },
]

export function clipModel(id: string): ClipModel | null {
  return CLIP_MODELS.find(m => m.id === id) ?? null
}

/**
 * The fal request the route sends for one Animate attempt: endpoint and payload.
 * `seconds` must already be one of the model's `durations` (the route clamps it).
 */
export function clipRequest(id: ClipModel['id'], seconds: number, prompt: string, stillUrl: string): { endpoint: string, input: Record<string, unknown> } {
  switch (id) {
    case 'seedance-2.0':
      return { endpoint: 'bytedance/seedance-2.0/image-to-video', input: {
        prompt, duration: String(seconds), resolution: '720p',
        image_url: stillUrl, end_image_url: stillUrl,
      } }
    // Same payload on both H3 endpoints: INTEGER duration, uppercase-P resolution,
    // prompt_expansion_mode required (Max's enum has no 'fast'; 'balanced' is on both).
    case 'hailuo-h3':
    case 'hailuo-h3-max':
      return { endpoint: id === 'hailuo-h3-max' ? 'minimax/h3-max/image-to-video' : 'minimax/h3/image-to-video', input: {
        prompt, duration: seconds, resolution: '768P', prompt_expansion_mode: 'balanced',
        image_url: stillUrl, end_image_url: stillUrl,
      } }
    // Kling names its frames start_/end_image_url, takes duration as a STRING enum
    // ("3".."15"), and generates audio by default — off, a loop has no use for it.
    case 'kling-v3-pro':
      return { endpoint: 'fal-ai/kling-video/v3/pro/image-to-video', input: {
        prompt, duration: String(seconds), generate_audio: false,
        start_image_url: stillUrl, end_image_url: stillUrl,
      } }
    // FLUX 3 (BFL) on fal has a dedicated first-last-frame endpoint — the loop is native,
    // not coaxed. DRAFT tier (720p). Frames are start_/end_image_url like Kling; duration is
    // an INTEGER (5/10/15) and resolution a lowercase string, matching video_models.py's
    // FLUX 3 builder. Audio is omitted (a keyed loop has no use for it); the draft is one
    // price with or without it.
    case 'flux-3-draft':
      return { endpoint: 'blackforestlabs/flux-3/first-last-frame-to-video/draft', input: {
        prompt, duration: seconds, resolution: '720p',
        start_image_url: stillUrl, end_image_url: stillUrl,
      } }
  }
}

/** The length an attempt runs at: `seconds` if the model offers it, else its default. */
export function clipSeconds(m: ClipModel, seconds: unknown): number {
  const n = Number(seconds)
  return m.durations.includes(n) ? n : m.defaultDuration
}

/** The shared price of the request an attempt sends ({ usd, credits }), or null for an unknown model. */
export function clipPrice(id: string, seconds: number): { usd: number, credits: number } | null {
  const m = clipModel(id)
  if (!m) return null
  const req = clipRequest(m.id, clipSeconds(m, seconds), '', '')
  return requestPrice(req.endpoint, req.input)
}

/** The price in dollars for one attempt of `seconds`. */
export function clipPriceUsd(id: string, seconds: number): number | null {
  return clipPrice(id, seconds)?.usd ?? null
}

/** The price in credits for one attempt of `seconds` — what the ledger holds and charges. */
export function clipPriceCredits(id: string, seconds: number): number | null {
  return clipPrice(id, seconds)?.credits ?? null
}

/** Short price text for the button: "228 credits". */
export function clipPriceLabel(id: string, seconds: number): string {
  const credits = clipPriceCredits(id, seconds)
  return credits == null ? '' : `${credits} credits`
}

/**
 * The dropdown text: "Seedance 2.0 (720p · 228 credits)" — name, output resolution, and
 * the price at the length the model would run if picked now (`seconds` if it offers it,
 * else its default), so the option quotes what the button will.
 */
export function clipModelLabel(m: ClipModel, seconds: number = m.defaultDuration): string {
  const price = clipPriceLabel(m.id, seconds)
  return price ? `${m.name} (${m.resolution} · ${price})` : `${m.name} (${m.resolution})`
}
