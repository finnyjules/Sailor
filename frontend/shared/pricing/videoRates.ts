/**
 * What each video model's FIRST service charges us — the service Sailor's
 * request builder sends it to today (fal for the RUNNER_VIDEO_MODELS ids,
 * Replicate for the rest; comfy_api_nodes/video_models.py `provider`).
 *
 * Units:
 *  - `per_second`: dollars per second of output, by resolution, and split by
 *    sound on/off where the service prices it that way;
 *  - `per_clip`: dollars per clip, by resolution and clip length.
 * A resolution key of '*' means the service has one price whatever the
 * resolution (or the model has no resolution setting).
 *
 * Every entry carries its source page, the date it was read and a confidence:
 * `verified` = the service's published figure, read on that date;
 * `estimate` = not a published per-unit figure (a model billed by compute time).
 *
 * The price is rate × the seconds the request actually carries (see
 * videoSettings.ts). A setting the card does not list (a resolution the
 * service has no published price for) is priced at the card's highest rate,
 * so an odd setting is never under-priced.
 *
 * Pure data and pure functions; relative imports only (Nitro, the app and
 * vitest all load it).
 */
import { creditsForUsd } from './markup'
import { SEEDANCE_MAX_INPUT_VIDEO_SECONDS, effectiveVideoSettings, type VideoSettings } from './videoSettings'

export type PerSecondPrice = number | { audio: number, silent: number }

interface RateMeta {
  /** The first service: who the builder sends this model to. */
  service: 'fal' | 'replicate'
  /** The page the figure was read from. */
  source: string
  /** ISO date the page was read. */
  read: string
  confidence: 'verified' | 'estimate'
  note?: string
  /**
   * Where the service also bills reference-video input seconds (Seedance 2.0
   * reference-to-video): the factor on the per-second rate for input + output
   * seconds together.
   */
  inputVideoFactor?: number
}

export type VideoRate =
  | (RateMeta & { unit: 'per_second', byResolution: Record<string, PerSecondPrice> })
  | (RateMeta & { unit: 'per_clip', byResolution: Record<string, Record<string, number>> })

const READ = '2026-09-24'
const fal = (endpoint: string) => `https://fal.ai/models/${endpoint}/llms.txt`
const rep = (slug: string) => `https://replicate.com/${slug}`

/**
 * One rate card per id in app/data/video-models.ts VIDEO_MODELS, hidden and
 * discontinued ones included (a test pins the coverage).
 */
export const VIDEO_RATES: Record<string, VideoRate> = {
  // ── fal ─────────────────────────────────────────────────────────────────
  // "$0.20 without audio or $0.40 with audio for 720p or 1080p. At 4k, $0.40
  // per second without audio, or $0.60 with." (same text on image-to-video)
  'veo-3.1': {
    unit: 'per_second', service: 'fal', source: fal('fal-ai/veo3.1'), read: READ, confidence: 'verified',
    byResolution: { '720p': { audio: 0.40, silent: 0.20 }, '1080p': { audio: 0.40, silent: 0.20 }, '4k': { audio: 0.60, silent: 0.40 } },
  },
  // "$0.10 without audio or $0.15 with audio for 720p or 1080p. At 4k, $0.30 … or $0.35 with."
  'veo-3.1-fast': {
    unit: 'per_second', service: 'fal', source: fal('fal-ai/veo3.1/fast'), read: READ, confidence: 'verified',
    byResolution: { '720p': { audio: 0.15, silent: 0.10 }, '1080p': { audio: 0.15, silent: 0.10 }, '4k': { audio: 0.35, silent: 0.30 } },
  },
  // "0.17 $ per second of generated video at 720p, and 0.29 $ per second at 1080p." Sound doesn't change it.
  'flux-3': {
    unit: 'per_second', service: 'fal', source: fal('blackforestlabs/flux-3/text-to-video'), read: READ, confidence: 'verified',
    byResolution: { '720p': 0.17, '1080p': 0.29 },
  },
  // "$0.3034/second" at 720p and "$0.682/second" at 1080p; otherwise $0.014 per
  // 1000 tokens (480p–1080p) or $0.008 (4k), tokens = h × w × seconds × 24 / 1024.
  // 480p from the formula at its largest frame (864×496): $0.1406/s. 4k: fal
  // gives no frame size per aspect ratio, and 3840×2160 (16:9) is $1.5552/s, but
  // a 21:9 frame at 2160 lines is 5040×2160, $2.0412/s — priced at that larger
  // frame so a wide 4k clip is never under-priced. Sound doesn't change the price.
  // Reference-to-video (reference videos, no first frame): "the number of tokens
  // is given by (height × width × (input video duration + output video duration)
  // × 24) / 1024. If video inputs are provided the price is multiplied by 0.6"
  // (fal('bytedance/seedance-2.0/reference-to-video'), read 2026-09-24).
  'seedance-2.0': {
    unit: 'per_second', service: 'fal', source: fal('bytedance/seedance-2.0/text-to-video'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.1406, '720p': 0.3034, '1080p': 0.682, '4k': 2.0412 },
    inputVideoFactor: 0.6,
    note: '4k at the 21:9 frame (5040×2160); reference videos billed on input + output seconds × 0.6',
  },
  // "$0.05 per second at 480p, $0.06 per second at 768p, $0.13 per second at 2K and $0.16 per second at 4K."
  'hailuo-h3': {
    unit: 'per_second', service: 'fal', source: fal('minimax/h3/text-to-video'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.05, '768p': 0.06, '2k': 0.13, '4k': 0.16 },
  },
  // Today's figures ($0.025 / $0.04 / $0.08) are a 50%-off launch promotion
  // that ends 30 Sep; the page gives the list prices after it, used here so the
  // promotion's end never turns a run into a loss: "480p is $0.05/second, 768p
  // is $0.08/second, and 1080p is $0.16/second."
  'hailuo-h3-max': {
    unit: 'per_second', service: 'fal', source: fal('minimax/h3-max/text-to-video'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.05, '768p': 0.08, '1080p': 0.16 },
    note: 'list price after the launch promotion (ends 2026-09-30)',
  },

  // ── Replicate ───────────────────────────────────────────────────────────
  // Billing tiers on the model page (billingConfig), "per second of output video".
  'sora-2': {
    unit: 'per_second', service: 'replicate', source: rep('openai/sora-2'), read: READ, confidence: 'verified',
    byResolution: { '*': 0.10 },
  },
  // standard (720p) $0.30/s, high (1024p) $0.50/s.
  'sora-2-pro': {
    unit: 'per_second', service: 'replicate', source: rep('openai/sora-2-pro'), read: READ, confidence: 'verified',
    byResolution: { '720p': 0.30, '1024p': 0.50 },
  },
  'runway-gen-4.5': {
    unit: 'per_second', service: 'replicate', source: rep('runwayml/gen-4.5'), read: READ, confidence: 'verified',
    byResolution: { '*': 0.12 },
  },
  // mode standard (720p) $0.168 / $0.252 with audio; pro (1080p) $0.224 / $0.336;
  // 4k $0.42 either way. The builder sends no mode, so the schema default "pro" applies.
  'kling-v3': {
    unit: 'per_second', service: 'replicate', source: rep('kwaivgi/kling-v3-video'), read: READ, confidence: 'verified',
    byResolution: { '720p': { audio: 0.252, silent: 0.168 }, '1080p': { audio: 0.336, silent: 0.224 }, '4k': { audio: 0.42, silent: 0.42 } },
  },
  'kling-v2.5-turbo-pro': {
    unit: 'per_second', service: 'replicate', source: rep('kwaivgi/kling-v2.5-turbo-pro'), read: READ, confidence: 'verified',
    byResolution: { '*': 0.07 },
  },
  // Tiers without video input (the builder sends none): 480p $0.07, 720p $0.15.
  'seedance-2.0-fast': {
    unit: 'per_second', service: 'replicate', source: rep('bytedance/seedance-2.0-fast'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.07, '720p': 0.15 },
  },
  // Priced per output video: 768P 6 s $0.28, 768P 10 s $0.56, 1080P 6 s $0.49
  // (the service offers 1080p at 6 s only).
  'hailuo-2.3': {
    unit: 'per_clip', service: 'replicate', source: rep('minimax/hailuo-2.3'), read: READ, confidence: 'verified',
    byResolution: { '768p': { 6: 0.28, 10: 0.56 }, '1080p': { 6: 0.49 } },
  },
  'wan-2.7-t2v': {
    unit: 'per_second', service: 'replicate', source: rep('wan-video/wan-2.7-t2v'), read: READ, confidence: 'verified',
    byResolution: { '*': 0.10 },
  },
  // 720p $0.068, 1080p $0.102. The builder's default "480p" has no tier on the
  // page, so it prices at the highest (the card's fallback).
  'wan-2.5-i2v-fast': {
    unit: 'per_second', service: 'replicate', source: rep('wan-video/wan-2.5-i2v-fast'), read: READ, confidence: 'verified',
    byResolution: { '720p': 0.068, '1080p': 0.102 },
  },
  'luma-ray-2-720p': {
    unit: 'per_second', service: 'replicate', source: rep('luma/ray-2-720p'), read: READ, confidence: 'verified',
    byResolution: { '*': 0.18 },
  },
  // Billed by GPU time: "This model runs on Nvidia L40S GPU hardware", and
  // Replicate's L40S rate is $0.000975 per second (the page's billing line).
  // "Predictions typically complete within 84 seconds" at the schema default of
  // 30 steps; the ceiling scales that to the 50-step maximum: 84 × 50/30 = 140 s
  // × $0.000975 = $0.1365 a clip. (The builder sends `num_inference_steps`, which
  // the schema doesn't have, so the service runs its 30-step default today; the
  // ceiling still holds if the builder is fixed to send `steps` up to 50.)
  'ltx-video': {
    unit: 'per_clip', service: 'replicate', source: rep('lightricks/ltx-video'), read: READ, confidence: 'verified',
    byResolution: { '*': { '*': 0.1365 } },
    note: 'ceiling: L40S $0.000975/s × 140 s (typical 84 s at 30 steps, scaled to 50 steps)',
  },
  // "Billing is per output second, tiered by resolution and audio." The service
  // renders `quality` (default 540p) and `generate_audio_switch` (default off),
  // which the builder doesn't send; videoSettings prices max(sent, 540p), silent.
  'pixverse-v6': {
    unit: 'per_second', service: 'replicate', source: rep('pixverse/pixverse-v6'), read: READ, confidence: 'verified',
    byResolution: {
      '360p': { audio: 0.07, silent: 0.05 },
      '540p': { audio: 0.09, silent: 0.07 },
      '720p': { audio: 0.12, silent: 0.09 },
      '1080p': { audio: 0.23, silent: 0.18 },
    },
  },
  // 480p $0.08/s, 720p $0.15/s.
  'fabric-1.0': {
    unit: 'per_second', service: 'replicate', source: rep('veed/fabric-1.0'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.08, '720p': 0.15 },
  },
}

/** The rate card for `modelId`, or null. Own keys only: "constructor" is not a model. */
export function videoRate(modelId: string): VideoRate | null {
  return Object.prototype.hasOwnProperty.call(VIDEO_RATES, modelId) ? VIDEO_RATES[modelId]! : null
}

const own = <T>(o: Record<string, T>, k: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined

/** Float noise off a product of two decimals (0.08 × 5 must be 0.4, not 0.4000000000000001). */
const tidy = (usd: number) => Math.round(usd * 1e6) / 1e6

function perSecond(p: PerSecondPrice, audio: boolean): number {
  return typeof p === 'number' ? p : (audio ? p.audio : p.silent)
}

/** The highest per-second figure anywhere on the card (a per-clip card by its dearest second). */
function topPerSecond(rate: VideoRate): number {
  if (rate.unit === 'per_second') {
    return Math.max(...Object.values(rate.byResolution).map(p => (typeof p === 'number' ? p : Math.max(p.audio, p.silent))))
  }
  const perSec: number[] = []
  for (const row of Object.values(rate.byResolution)) {
    for (const [secs, usd] of Object.entries(row)) perSec.push(secs === '*' ? usd : usd / Number(secs))
  }
  return Math.max(...perSec)
}

/** Dollars the first service charges for one clip with these settings, or null for an unknown id. */
export function videoUsd(modelId: string, s: VideoSettings): number | null {
  const rate = videoRate(modelId)
  if (!rate) return null
  const key = s.resolution ?? '*'
  if (rate.unit === 'per_second') {
    const p = own(rate.byResolution, key) ?? own(rate.byResolution, '*')
    const perSec = p === undefined ? topPerSecond(rate) : perSecond(p, s.audio)
    if (s.inputVideoSeconds > 0 && rate.inputVideoFactor) {
      return tidy(perSec * rate.inputVideoFactor * (s.seconds + s.inputVideoSeconds))
    }
    return tidy(perSec * s.seconds)
  }
  const row = own(rate.byResolution, key) ?? own(rate.byResolution, '*')
  const clip = row && (own(row, String(s.seconds)) ?? own(row, '*'))
  if (clip !== undefined) return tidy(clip)
  // A length or resolution the service has no clip price for: its dearest second × the length.
  return tidy(topPerSecond(rate) * s.seconds)
}

/**
 * The most a clip of `seconds` can cost on this card — the price for a node
 * whose `model_options` is linked, so the settings can't be read until it runs.
 * A per-clip card with a flat '*' clip price stays that price.
 */
export function videoMaxUsd(modelId: string, seconds: number): number | null {
  const rate = videoRate(modelId)
  if (!rate) return null
  if (rate.unit === 'per_clip') {
    const flat = own(rate.byResolution, '*')
    const clip = flat && own(flat, '*')
    if (clip !== undefined && Object.keys(rate.byResolution).length === 1) return tidy(clip)
  }
  const top = topPerSecond(rate)
  // Linked options may carry reference videos: the dearer of the two billings.
  const withRefs = rate.inputVideoFactor ? top * rate.inputVideoFactor * (seconds + SEEDANCE_MAX_INPUT_VIDEO_SECONDS) : 0
  return tidy(Math.max(top * seconds, withRefs))
}

function dollars(usd: number): string {
  // Two decimals at least, up to four when the service quotes them ($0.068, $0.3034).
  const s = usd.toFixed(4).replace(/0{1,2}$/, '')
  return `$${s}`
}

function creditsText(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

/**
 * The gallery's price text for a model at its default settings: "$0.08/s at
 * 768p", or, hosted, the credits per second of that default clip ("12 credits/s
 * at 768p"). Per-clip models: "$0.28 for 6 s at 768p" / "42 credits for 6 s".
 */
export function videoRateLabel(modelId: string, opts: { hosted?: boolean } = {}): string | null {
  const rate = videoRate(modelId)
  const s = effectiveVideoSettings(modelId, undefined, undefined, {})
  if (!rate || !s) return null
  const usd = videoUsd(modelId, s)
  if (usd == null) return null
  const at = s.resolution ? ` at ${s.resolution}` : ''
  if (rate.unit === 'per_clip') {
    const flat = Object.keys(rate.byResolution).length === 1 && own(rate.byResolution, '*') && own(rate.byResolution['*']!, '*') !== undefined
    const what = flat ? ' a clip' : ` for ${s.seconds} s`
    return opts.hosted ? `${creditsForUsd(usd)} credits${what}${at}` : `${dollars(usd)}${what}${at}`
  }
  if (opts.hosted) return `${creditsText(creditsForUsd(usd) / s.seconds)} credits/s${at}`
  return `${dollars(usd / s.seconds)}/s${at}`
}
