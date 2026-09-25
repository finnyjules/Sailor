/**
 * What each video model's FIRST service charges us — the service Sailor's
 * request builder sends it to first (fal for the RUNNER_VIDEO_MODELS ids and,
 * since Task S3, Kling 3.0 and PixVerse v6; Replicate for the rest;
 * server/runner/generators/twins.ts has the table) — and, for a model with a
 * BACKUP service, what the backup charges (VIDEO_BACKUP_RATES).
 *
 * The price basis is the first service's price, or the backup's covered at
 * cost, whichever is higher (`videoPriceUsd`; the P4 rule, markup.ts
 * usdChargedAtCost): the node is charged once, and a job the backup serves
 * never costs Sailor more than it charged. The ComfyUI path of a model whose
 * first service moved still sends the old one, which is now the backup, so
 * that path is covered at cost too.
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
import { creditsForUsd, usdChargedAtCost } from './markup'
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
  /**
   * Dollars per input picture the service bills on top of the seconds (Grok
   * Imagine Video 1.5 image-to-video on fal): × the settings' `inputImages`.
   */
  inputImageUsd?: number
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
  // Veo 3.1 Lite (family veo-3.1-lite, runner-only; no backup). The same text
  // on text- and image-to-video: "$0.05 for 720p with audio, $0.03 for 720p
  // without audio, $0.08 for 1080p with audio or $0.05 for 1080p without audio"
  // per second. (Replicate's google/veo-3.1-lite, not a backup: $0.05 / $0.08
  // a second, always with sound.)
  'veo-3.1-lite': {
    unit: 'per_second', service: 'fal', source: fal('fal-ai/veo3.1/lite'), read: READ, confidence: 'verified',
    byResolution: { '720p': { audio: 0.05, silent: 0.03 }, '1080p': { audio: 0.08, silent: 0.05 } },
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
  // Hailuo H3 Max Turbo (family h3-max-turbo, runner-only; no backup). The
  // same kind of text on both endpoints: today's $0.0125 / $0.02 / $0.04 are a
  // 50%-off launch promotion that ends 30 Sep; the list prices after it, used
  // here as H3 Max's are: "480p is $0.025/second, 768p is $0.04/second, and
  // 1080p is $0.08/second." H3 always renders sound.
  'hailuo-h3-max-turbo': {
    unit: 'per_second', service: 'fal', source: fal('minimax/h3-max-turbo/text-to-video'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.025, '768p': 0.04, '1080p': 0.08 },
    note: 'list price after the launch promotion (ends 2026-09-30)',
  },
  // Gemini Omni Flash (family gemini-omni-flash, runner-only; no backup). fal
  // bills tokens ($21.875 per 1M output tokens; image-to-video also $1.875 per
  // 1M input tokens) and gives the per-second figure itself: text-to-video
  // "For 720p video this costs approximately $0.125 per second of video",
  // image-to-video "approximately $0.13 per second of video". Both endpoints
  // render 720p only, with sound. One card at the higher figure, so the input
  // tokens (the prompt, the picture) are covered on either endpoint.
  'gemini-omni-flash': {
    unit: 'per_second', service: 'fal', source: fal('google/gemini-omni-flash/image-to-video'), read: READ, confidence: 'verified',
    byResolution: { '720p': 0.13 },
    note: 'fal bills tokens; its own per-second figure at 720p (text-to-video $0.125, image-to-video $0.13)',
  },
  // Wan 3.0 (family wan-3, runner-only; no backup). Text-, image- and
  // reference-to-video share one card: "For every second of video you
  // generate, you will be charged $0.05 480p, $0.10 720p, or $0.20 1080p."
  // (the same text on all three endpoints). Sound doesn't change it.
  'wan-3.0': {
    unit: 'per_second', service: 'fal', source: fal('alibaba/wan-3.0/text-to-video'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.05, '720p': 0.10, '1080p': 0.20 },
  },
  // "$0.068 at 480p, $0.14 at 720p, or $0.28 at 1080p" per second (image-to-video, its one endpoint).
  'wan-3.0-prime': {
    unit: 'per_second', service: 'fal', source: fal('alibaba/wan-3.0-prime/image-to-video'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.068, '720p': 0.14, '1080p': 0.28 },
  },
  // HappyHorse 1.1 (family happyhorse-1.1, runner-only; Replicate the backup,
  // VIDEO_BACKUP_RATES). The same text on text- and image-to-video: "For every
  // second of 720p video you generated, you will be charged $0.14/second. For
  // 1080p video you will be charged $0.18/second." The clip always has sound.
  'happyhorse-1.1': {
    unit: 'per_second', service: 'fal', source: fal('alibaba/happy-horse/v1.1/text-to-video'), read: '2026-09-25', confidence: 'verified',
    byResolution: { '720p': 0.14, '1080p': 0.18 },
  },
  // Grok Imagine Video 1.5 (family grok-imagine-video-1.5, runner-only; Replicate
  // the backup for image-to-video at 480p/720p, VIDEO_BACKUP_RATES). Both
  // endpoints: "Priced per second of output video, by resolution: 480p at
  // $0.08/sec, 720p at $0.14/sec, 1080p at $0.25/sec." Image-to-video adds
  // "Each reference image adds $0.01 (1–7 supported)"; its schema takes one
  // picture and no references, and text-to-video says "No input images or
  // references, so no per-image charges apply", so the one picture is priced
  // at $0.01 (the fail-safe reading). The clip always has sound.
  'grok-imagine-video-1.5': {
    unit: 'per_second', service: 'fal', source: fal('xai/grok-imagine-video/v1.5/image-to-video'), read: '2026-09-25', confidence: 'verified',
    byResolution: { '480p': 0.08, '720p': 0.14, '1080p': 0.25 },
    inputImageUsd: 0.01,
    note: 'image-to-video: $0.01 for its one picture ("Each reference image adds $0.01")',
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
  // First service fal since Task S3 (the pro endpoints, 1080p): "$0.112 (audio
  // off) or $0.168 (audio on)" a second; voice control ($0.196) is never sent.
  // Replicate is the backup (VIDEO_BACKUP_RATES).
  'kling-v3': {
    unit: 'per_second', service: 'fal', source: fal('fal-ai/kling-video/v3/pro/text-to-video'), read: READ, confidence: 'verified',
    byResolution: { '1080p': { audio: 0.168, silent: 0.112 } },
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
  // 720p $0.068, 1080p $0.102. The builder sends 720p or 1080p only (480p, the
  // old default, is outside the schema and is sent as 720p since Task S1b).
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
  // × $0.000975 = $0.1365 a clip, whatever steps the builder sends (`steps`,
  // 1–50, since Task S1b). Controller ruling (S1b fix round 1): a flat ceiling,
  // not a per-step price.
  'ltx-video': {
    unit: 'per_clip', service: 'replicate', source: rep('lightricks/ltx-video'), read: READ, confidence: 'verified',
    byResolution: { '*': { '*': 0.1365 } },
    note: 'ceiling: L40S $0.000975/s × 140 s (typical 84 s at 30 steps × 50/30)',
  },
  // LTX-2.5 Fast (family ltx-2.5-fast, runner-only; no backup: fal's is 2–3×
  // dearer, controller ruling F20 fix round 1). Billing tiers by "target
  // resolution", "per second of output video": 720p $0.03, 1080p $0.06, 2k
  // $0.12, 4k $0.24 (the model page's billingConfig; the sound and frame rate
  // don't change it). The builder sends 720p, 1080p or 4k (2k is not offered,
  // and is sent as 1080p).
  'ltx-2.5-fast': {
    unit: 'per_second', service: 'replicate', source: rep('lightricks/ltx-2.5-fast'), read: '2026-09-25', confidence: 'verified',
    byResolution: { '720p': 0.03, '1080p': 0.06, '4k': 0.24 },
  },
  // First service fal since Task S3 (half Replicate's rate): "For 360p … $0.025
  // per second without audio and $0.035 per second with audio. For 540p … $0.035
  // … $0.045 … For 720p … $0.045 … $0.060 … For 1080p … $0.090 … $0.115". The
  // builder sends `resolution` and `generate_audio_switch`. Replicate is the
  // backup (VIDEO_BACKUP_RATES).
  'pixverse-v6': {
    unit: 'per_second', service: 'fal', source: fal('fal-ai/pixverse/v6/text-to-video'), read: READ, confidence: 'verified',
    byResolution: {
      '360p': { audio: 0.035, silent: 0.025 },
      '540p': { audio: 0.045, silent: 0.035 },
      '720p': { audio: 0.06, silent: 0.045 },
      '1080p': { audio: 0.115, silent: 0.09 },
    },
  },
  // 480p $0.08/s, 720p $0.15/s.
  'fabric-1.0': {
    unit: 'per_second', service: 'replicate', source: rep('veed/fabric-1.0'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.08, '720p': 0.15 },
  },
}

/**
 * What the BACKUP service charges, for each model that has one
 * (server/runner/generators/twins.ts). The backup renders the same settings,
 * so it reads the same VideoSettings.
 */
export const VIDEO_BACKUP_RATES: Record<string, VideoRate> = {
  // mode standard (720p) $0.168 / $0.252 with audio; pro (1080p) $0.224 / $0.336;
  // 4k $0.42 either way. The builder sends no mode, so the schema default "pro" applies.
  'kling-v3': {
    unit: 'per_second', service: 'replicate', source: rep('kwaivgi/kling-v3-video'), read: READ, confidence: 'verified',
    byResolution: { '720p': { audio: 0.252, silent: 0.168 }, '1080p': { audio: 0.336, silent: 0.224 }, '4k': { audio: 0.42, silent: 0.42 } },
  },
  // "Billing is per output second, tiered by resolution and audio." The builder
  // sends `quality` (the node's resolution) and `generate_audio_switch` (its
  // sound option), so the price reads both (Task S1b).
  'pixverse-v6': {
    unit: 'per_second', service: 'replicate', source: rep('pixverse/pixverse-v6'), read: READ, confidence: 'verified',
    byResolution: {
      '360p': { audio: 0.07, silent: 0.05 },
      '540p': { audio: 0.09, silent: 0.07 },
      '720p': { audio: 0.12, silent: 0.09 },
      '1080p': { audio: 0.23, silent: 0.18 },
    },
  },
  // Billing tiers "t2v_i2v": 720p $0.17, 1080p $0.29 per second of output video
  // (the same as fal). The backup sends neither `draft` nor a start video.
  'flux-3': {
    unit: 'per_second', service: 'replicate', source: rep('black-forest-labs/flux-3'), read: READ, confidence: 'verified',
    byResolution: { '720p': 0.17, '1080p': 0.29 },
  },
  // Billing tiers by "target resolution": 720p $0.14, 1080p $0.18 per second of
  // output video (the same as fal, so fal's marked-up price stands).
  'happyhorse-1.1': {
    unit: 'per_second', service: 'replicate', source: rep('alibaba/happyhorse-1.1'), read: '2026-09-25', confidence: 'verified',
    byResolution: { '720p': 0.14, '1080p': 0.18 },
  },
  // One billing tier, no criteria: "$0.08 per second of output video" (the
  // model page's billingConfig) at 480p or 720p alike. Never dearer than fal,
  // so fal's marked-up price stands.
  'grok-imagine-video-1.5': {
    unit: 'per_second', service: 'replicate', source: rep('xai/grok-imagine-video-1.5'), read: '2026-09-25', confidence: 'verified',
    byResolution: { '*': 0.08 },
  },
}

/** The rate card for `modelId`, or null. Own keys only: "constructor" is not a model. */
export function videoRate(modelId: string): VideoRate | null {
  return Object.prototype.hasOwnProperty.call(VIDEO_RATES, modelId) ? VIDEO_RATES[modelId]! : null
}

/** The backup service's card for `modelId`, or null when it has no backup. */
export function videoBackupRate(modelId: string): VideoRate | null {
  return Object.prototype.hasOwnProperty.call(VIDEO_BACKUP_RATES, modelId) ? VIDEO_BACKUP_RATES[modelId]! : null
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

/**
 * Dollars for one clip on a per-second card: the rate at the resolution and
 * sound sent × the seconds. A resolution the card doesn't list is priced at
 * its highest rate. Shared with the cards keyed by endpoint (clipRates.ts).
 */
export function perSecondUsd(rate: VideoRate & { unit: 'per_second' }, s: VideoSettings): number {
  const p = own(rate.byResolution, s.resolution ?? '*') ?? own(rate.byResolution, '*')
  const perSec = p === undefined ? topPerSecond(rate) : perSecond(p, s.audio)
  if (s.inputVideoSeconds > 0 && rate.inputVideoFactor) {
    return tidy(perSec * rate.inputVideoFactor * (s.seconds + s.inputVideoSeconds))
  }
  return tidy(perSec * s.seconds + (rate.inputImageUsd ?? 0) * (s.inputImages ?? 0))
}

/** Dollars the first service charges for one clip with these settings, or null for an unknown id. */
export function videoUsd(modelId: string, s: VideoSettings): number | null {
  const rate = videoRate(modelId)
  return rate ? clipUsd(rate, s) : null
}

/** Dollars the backup service charges for the same clip, or null when the model has no backup. */
export function videoBackupUsd(modelId: string, s: VideoSettings): number | null {
  const rate = videoBackupRate(modelId)
  return rate ? clipUsd(rate, s) : null
}

/**
 * The price basis for one clip: the first service's price, or the backup's
 * covered at cost, whichever is higher (see the header). `credits =
 * creditsForUsd(basis)`. Null for an unknown id.
 */
export function videoPriceUsd(modelId: string, s: VideoSettings): number | null {
  const first = videoUsd(modelId, s)
  if (first == null) return null
  const backup = videoBackupUsd(modelId, s)
  return backup == null ? first : Math.max(first, usdChargedAtCost(backup))
}

/** Dollars on one card for one clip with these settings. */
function clipUsd(rate: VideoRate, s: VideoSettings): number {
  const key = s.resolution ?? '*'
  if (rate.unit === 'per_second') return perSecondUsd(rate, s)
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
  return rate ? clipMaxUsd(rate, seconds) : null
}

/** videoMaxUsd with the backup covered at cost (videoPriceUsd's rule): the price basis of a linked `model_options`. */
export function videoPriceMaxUsd(modelId: string, seconds: number): number | null {
  const first = videoMaxUsd(modelId, seconds)
  if (first == null) return null
  const rate = videoBackupRate(modelId)
  return rate ? Math.max(first, usdChargedAtCost(clipMaxUsd(rate, seconds))) : first
}

/** The most a clip of `seconds` can cost on one card. */
function clipMaxUsd(rate: VideoRate, seconds: number): number {
  if (rate.unit === 'per_clip') {
    const flat = own(rate.byResolution, '*')
    const clip = flat && own(flat, '*')
    if (clip !== undefined && Object.keys(rate.byResolution).length === 1) return tidy(clip)
  }
  const top = topPerSecond(rate)
  // Linked options may carry reference videos: the dearer of the two billings.
  const withRefs = rate.inputVideoFactor ? top * rate.inputVideoFactor * (seconds + SEEDANCE_MAX_INPUT_VIDEO_SECONDS) : 0
  // Linked options may carry a first frame (`image_url`): the one billed picture.
  return tidy(Math.max(top * seconds + (rate.inputImageUsd ?? 0), withRefs))
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
  // Dollars: the first service's rate. Credits: the charge, which covers the backup (videoPriceUsd).
  // The dollar label follows the RUNNER's first service. The ComfyUI path
  // still sends Kling 3.0 and PixVerse v6 to Replicate (their runner backup),
  // so a local ComfyUI run of those costs Replicate's rate, not the label's.
  const usd = opts.hosted ? videoPriceUsd(modelId, s) : videoUsd(modelId, s)
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
