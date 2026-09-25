/**
 * Per-second rate cards for the video calls that are NOT a Generate-a-video
 * model id (videoRates.ts covers those): Frame Animate's fal endpoints, the
 * older one-model video nodes and the lip-sync nodes. Keyed by the exact
 * endpoint the request goes to, because that is all these calls have in
 * common — the route and the Python node each send to one endpoint.
 *
 * Same shape and rules as videoRates.ts: dollars per second of output, by
 * resolution ('*' = one price whatever the resolution), split by sound where
 * the service prices it that way. A resolution the card doesn't list is
 * priced at the card's highest rate (perSecondUsd). Every card carries its
 * source page, the date it was read and a confidence.
 *
 * What each call sends (the seconds, resolution and sound) is read in
 * clipSettings.ts. Pure data; relative imports only.
 */
import { perSecondUsd, type VideoRate } from './videoRates'
import type { VideoSettings } from './videoSettings'

export type ClipRate = VideoRate & { unit: 'per_second' }

const READ = '2026-09-24'
const fal = (endpoint: string) => `https://fal.ai/models/${endpoint}/llms.txt`
const rep = (slug: string) => `https://replicate.com/${slug}`

export const CLIP_RATES: Record<string, ClipRate> = {
  // ── Frame Animate (server/api/frame/animate.post.ts, fal) ────────────────
  // "For every second of 720p video you generated, you will be charged
  // $0.3034/second and for 1080p … $0.682/second"; 480p and 4k by the same
  // token formula as text-to-video (videoRates.ts 'seedance-2.0'). "The cost of
  // video generation is the same regardless of whether audio is generated."
  'bytedance/seedance-2.0/image-to-video': {
    unit: 'per_second', service: 'fal', source: fal('bytedance/seedance-2.0/image-to-video'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.1406, '720p': 0.3034, '1080p': 0.682, '4k': 2.0412 },
    note: '480p and 4k from the token formula, as on text-to-video',
  },
  // "Video costs $0.05 per second at 480p, $0.06 per second at 768p, $0.13 per
  // second at 2K and $0.16 per second at 4K."
  'minimax/h3/image-to-video': {
    unit: 'per_second', service: 'fal', source: fal('minimax/h3/image-to-video'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.05, '768p': 0.06, '2k': 0.13, '4k': 0.16 },
  },
  // Today's $0.025 / $0.04 / $0.08 are a 50%-off launch promotion: "The
  // discount ends September 30, after which 480p is $0.05/second, 768p is
  // $0.08/second, and 1080p is $0.16/second." List price, as videoRates.ts.
  'minimax/h3-max/image-to-video': {
    unit: 'per_second', service: 'fal', source: fal('minimax/h3-max/image-to-video'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.05, '768p': 0.08, '1080p': 0.16 },
    note: 'list price after the launch promotion (ends 2026-09-30)',
  },
  // "For every second of video you generated, you will be charged $0.112
  // (audio off) or $0.168 (audio on), if voice control is used … $0.196."
  // Animate sends no voice, so voice control never applies.
  'fal-ai/kling-video/v3/pro/image-to-video': {
    unit: 'per_second', service: 'fal', source: fal('fal-ai/kling-video/v3/pro/image-to-video'), read: READ, confidence: 'verified',
    byResolution: { '*': { audio: 0.168, silent: 0.112 } },
  },
  // "Your request will be charged at 0.06 $ per second of generated draft video (720p)."
  'blackforestlabs/flux-3/first-last-frame-to-video/draft': {
    unit: 'per_second', service: 'fal', source: fal('blackforestlabs/flux-3/first-last-frame-to-video/draft'), read: READ, confidence: 'verified',
    byResolution: { '720p': 0.06 },
  },

  // ── The older one-model video nodes (comfy_api_nodes/nodes_replicate.py, Replicate) ──
  // billingConfig tiers, "per second of output video": with_audio $0.40, without_audio $0.20.
  'google/veo-3': {
    unit: 'per_second', service: 'replicate', source: rep('google/veo-3'), read: READ, confidence: 'verified',
    byResolution: { '*': { audio: 0.40, silent: 0.20 } },
  },
  // "Standard mode (720p) costs $0.05 per second. Pro (1080p) costs $0.09 per second."
  'kwaivgi/kling-v2.1': {
    unit: 'per_second', service: 'replicate', source: rep('kwaivgi/kling-v2.1'), read: READ, confidence: 'verified',
    byResolution: { '720p': 0.05, '1080p': 0.09 },
  },
  // Tiers without video input (the node sends none): 480p $0.08, 720p $0.18,
  // 1080p $0.45, 4k $1.00. Sound doesn't change the price.
  'bytedance/seedance-2.0': {
    unit: 'per_second', service: 'replicate', source: rep('bytedance/seedance-2.0'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.08, '720p': 0.18, '1080p': 0.45, '4k': 1.00 },
  },

  // ── Lip-sync (comfy_api_nodes/nodes_replicate.py, Replicate) ─────────────
  // Tiers by target resolution: 480p $0.08, 720p $0.15 per second of output.
  // The schema offers 480p and 720p only, so LipSyncNode's "1080p" is priced
  // at the highest rate.
  'veed/fabric-1.0': {
    unit: 'per_second', service: 'replicate', source: rep('veed/fabric-1.0'), read: READ, confidence: 'verified',
    byResolution: { '480p': 0.08, '720p': 0.15 },
  },
  // One tier: $0.014 per second of output video.
  'kwaivgi/kling-lip-sync': {
    unit: 'per_second', service: 'replicate', source: rep('kwaivgi/kling-lip-sync'), read: READ, confidence: 'verified',
    byResolution: { '*': 0.014 },
  },
  // One tier: $0.08325 per second of output video.
  'sync/lipsync-2-pro': {
    unit: 'per_second', service: 'replicate', source: rep('sync/lipsync-2-pro'), read: READ, confidence: 'verified',
    byResolution: { '*': 0.08325 },
  },
}

/** The card for `endpoint`, or null. Own keys only: "constructor" is not an endpoint. */
export function clipRate(endpoint: string): ClipRate | null {
  return Object.prototype.hasOwnProperty.call(CLIP_RATES, endpoint) ? CLIP_RATES[endpoint]! : null
}

/** Dollars `endpoint` charges for one clip with these settings, or null for an endpoint with no card. */
export function clipUsd(endpoint: string, s: Pick<VideoSettings, 'seconds' | 'resolution' | 'audio'>): number | null {
  const rate = clipRate(endpoint)
  return rate ? perSecondUsd(rate, { ...s, inputVideoSeconds: 0 }) : null
}
