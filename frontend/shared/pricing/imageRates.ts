/**
 * What each image model's FIRST service charges us — the service Sailor's
 * request builder sends it to today: fal for the RUNNER_IMAGE_MODELS ids and
 * the Python `primary="fal"` models (Krea 2), Replicate for the rest
 * (comfy_api_nodes/image_models.py `primary`, default "replicate").
 *
 * Units, following the service:
 *  - `per_image`: dollars per output picture;
 *  - `per_megapixel`: dollars per billed output megapixel, plus a fixed part
 *    per picture where the service has one (Replicate's "per run"), and a
 *    1 MP floor where the service normalises to 1 MP. Neither service says
 *    how it rounds, so a picture's megapixels are its pixels / 1,000,000
 *    rounded UP (controller ruling; imageSettings.ts billedMegapixels), with
 *    the floor applied after the rounding;
 *  - `by_resolution`: dollars per picture by resolution tier (1K / 2K / 4K);
 *  - `by_quality`: dollars per picture by quality tier (low … high, auto).
 * `webSearch` is a flat extra per request when the search is switched on.
 *
 * Input pictures: none of these first services bills the pictures sent in
 * (fal's Nano Banana and Seedream edit endpoints charge per output picture
 * only, at the same price), and the builders that go to services that do
 * bill them (Replicate's Flux 2 bills input megapixels) send none. So no card
 * carries an input charge. GPT Image on Replicate bills output pictures only,
 * and Sailor's builder sends it no pictures.
 *
 * Every entry carries its source page, the date it was read and a
 * confidence: `verified` = the service's published figure, read on that
 * date; `estimate` = not a published per-unit figure.
 *
 * A tier the card has no price for (a value the builder passes through but
 * the service does not list) is priced at the card's highest tier, so an odd
 * setting is never under-priced.
 *
 * Pure data and pure functions; relative imports only (Nitro, the app and
 * vitest all load it).
 */
import { creditsForUsd } from './markup'
import { BFL_MAX_MEGAPIXELS, FAL_MAX_MEGAPIXELS, effectiveImageSettings, maxImageCount, type ImageSettings } from './imageSettings'

interface RateMeta {
  /** The first service: who the builder sends this model to. */
  service: 'fal' | 'replicate'
  /** The page the figure was read from. */
  source: string
  /** ISO date the page was read. */
  read: string
  confidence: 'verified' | 'estimate'
  /** Extra per request when web search is switched on. */
  webSearch?: number
  /** Where the figure comes from when it is not the builder's own endpoint page. */
  note?: string
}

export type ImageRate =
  | (RateMeta & { unit: 'per_image', usd: number })
  | (RateMeta & { unit: 'per_megapixel', perMegapixel: number, perImage?: number, minMegapixels?: number, maxMegapixels: number })
  | (RateMeta & { unit: 'by_resolution' | 'by_quality', byTier: Record<string, number> })

const READ = '2026-09-24'
const fal = (endpoint: string) => `https://fal.ai/models/${endpoint}/llms.txt`
const rep = (slug: string) => `https://replicate.com/${slug}`

const falImage = (endpoint: string, usd: number): ImageRate =>
  ({ unit: 'per_image', usd, service: 'fal', source: fal(endpoint), read: READ, confidence: 'verified' })
const repImage = (slug: string, usd: number): ImageRate =>
  ({ unit: 'per_image', usd, service: 'replicate', source: rep(slug), read: READ, confidence: 'verified' })

/**
 * One rate card per priced id in app/data/image-models.ts IMAGE_MODELS,
 * hidden ones included. Not priced (so refused, never charged at 0):
 * `seedream-5-pro` (fal publishes only "tentative" pricing) and `reve-create`
 * (Replicate publishes no price). A test pins the coverage.
 */
export const IMAGE_RATES: Record<string, ImageRate> = {
  // ── fal ─────────────────────────────────────────────────────────────────
  // "Price: $0.04 per megapixels". fal's pricing page normalises image prices
  // to 1MP but does not say how it rounds, so a picture is charged its pixels
  // / 1,000,000 rounded up, never less than 1: square_hd (1024 × 1024) is
  // 2 MP ($0.08), landscape_16_9 (1024 × 576) 1 MP ($0.04).
  'flux-1.1-pro': {
    unit: 'per_megapixel', perMegapixel: 0.04, minMegapixels: 1, maxMegapixels: FAL_MAX_MEGAPIXELS,
    service: 'fal', source: fal('fal-ai/flux-pro/v1.1'), read: READ, confidence: 'verified',
  },
  // "Price: $0.003 per megapixels" (same rounding up, same 1 MP floor).
  'flux-schnell': {
    unit: 'per_megapixel', perMegapixel: 0.003, minMegapixels: 1, maxMegapixels: FAL_MAX_MEGAPIXELS,
    service: 'fal', source: fal('fal-ai/flux/schnell'), read: READ, confidence: 'verified',
  },
  // "$0.15 per image … 4K outputs will be charged at double the standard rate.
  // If web search is used, an additional $0.015" (same text on /edit). The
  // builder's endpoint, google/nano-banana-pro, lists only "$0 per compute
  // seconds" (no published figure), so this is fal's own Nano Banana Pro page;
  // Replicate's google/nano-banana-pro charges the same ($0.15 / $0.15 / $0.30).
  'nano-banana-pro': {
    unit: 'by_resolution', byTier: { '1K': 0.15, '2K': 0.15, '4K': 0.30 },
    service: 'fal', source: fal('fal-ai/nano-banana-pro'), read: READ, confidence: 'verified',
    note: 'priced from the sibling fal-ai/nano-banana-pro page: the builder\'s endpoint google/nano-banana-pro publishes no per-image price',
  },
  // "$0.08 per image … 2K and 4K outputs will be charged at 1.5 times and 2
  // times the standard rate … 0.5K (512px) … 0.75 times … If web search is
  // used, an additional $0.015" (same text on /edit).
  'nano-banana-2': {
    unit: 'by_resolution', byTier: { '0.5K': 0.06, '1K': 0.08, '2K': 0.12, '4K': 0.16 }, webSearch: 0.015,
    service: 'fal', source: fal('fal-ai/nano-banana-2'), read: READ, confidence: 'verified',
  },
  // "$0.03 with TURBO, $0.06 with BALANCED, and $0.09 with QUALITY."
  'ideogram-v3-quality': falImage('fal-ai/ideogram/v3', 0.09),
  'ideogram-v3-balanced': falImage('fal-ai/ideogram/v3', 0.06),
  'ideogram-v3-turbo': falImage('fal-ai/ideogram/v3', 0.03),
  // "Price: $0.035 per images" (text-to-image and /edit alike).
  'seedream-5-lite': falImage('fal-ai/bytedance/seedream/v5/lite/text-to-image', 0.035),
  // "Price: $0.03 per images" (text-to-image and /edit alike).
  'seedream-4': falImage('fal-ai/bytedance/seedream/v4/text-to-image', 0.03),
  // "charged $0.060 (text-to-image) or $0.065 (using image_style_references)".
  // The builder sends no style pictures. Replicate's krea/krea-2-large: the same $0.06.
  'krea-2-large': falImage('krea/v2/large/text-to-image', 0.06),
  // "charged $0.030 (text-to-image) or $0.035 (using image_style_references)".
  'krea-2-medium': falImage('krea/v2/medium/text-to-image', 0.03),

  // ── Replicate (billingConfig on the model page) ─────────────────────────
  'flux-1.1-pro-ultra': repImage('black-forest-labs/flux-1.1-pro-ultra', 0.06),
  'flux-pro': repImage('black-forest-labs/flux-pro', 0.055),
  // "$0.025 per output image", whatever the megapixels.
  'flux-dev': repImage('black-forest-labs/flux-dev', 0.025),
  // "$0.04 per run, $0.03 per input image megapixel, $0.03 per output image megapixel".
  'flux-2-max': {
    unit: 'per_megapixel', perImage: 0.04, perMegapixel: 0.03, maxMegapixels: BFL_MAX_MEGAPIXELS,
    service: 'replicate', source: rep('black-forest-labs/flux-2-max'), read: READ, confidence: 'verified',
  },
  // "$0.015 per run, $0.015 per input image megapixel, $0.015 per output image megapixel".
  'flux-2-pro': {
    unit: 'per_megapixel', perImage: 0.015, perMegapixel: 0.015, maxMegapixels: BFL_MAX_MEGAPIXELS,
    service: 'replicate', source: rep('black-forest-labs/flux-2-pro'), read: READ, confidence: 'verified',
  },
  // "$0.06 per input image megapixel, $0.06 per output image megapixel".
  'flux-2-flex': {
    unit: 'per_megapixel', perMegapixel: 0.06, maxMegapixels: BFL_MAX_MEGAPIXELS,
    service: 'replicate', source: rep('black-forest-labs/flux-2-flex'), read: READ, confidence: 'verified',
  },
  // "$1 per thousand output image megapixels".
  'flux-2-klein-4b': {
    unit: 'per_megapixel', perMegapixel: 0.001, maxMegapixels: BFL_MAX_MEGAPIXELS,
    service: 'replicate', source: rep('black-forest-labs/flux-2-klein-4b'), read: READ, confidence: 'verified',
  },
  // "go_fast=true: $0.012 per output image megapixel" ($0.014 with go_fast
  // false). The builder sends no go_fast and the schema default is true.
  'flux-2-dev': {
    unit: 'per_megapixel', perMegapixel: 0.012, maxMegapixels: BFL_MAX_MEGAPIXELS,
    service: 'replicate', source: rep('black-forest-labs/flux-2-dev'), read: READ, confidence: 'verified',
  },
  'imagen-4-ultra': repImage('google/imagen-4-ultra', 0.06),
  'imagen-4': repImage('google/imagen-4', 0.04),
  'imagen-4-fast': repImage('google/imagen-4-fast', 0.02),
  'imagen-3': repImage('google/imagen-3', 0.05),
  'imagen-3-fast': repImage('google/imagen-3-fast', 0.025),
  'ideogram-v2': repImage('ideogram-ai/ideogram-v2', 0.08),
  'ideogram-v2a-turbo': repImage('ideogram-ai/ideogram-v2a-turbo', 0.025),
  // One price for 2K and 4K.
  'seedream-4.5': repImage('bytedance/seedream-4.5', 0.04),
  'seedream-3': repImage('bytedance/seedream-3', 0.03),
  'recraft-v4-pro': repImage('recraft-ai/recraft-v4-pro', 0.25),
  'recraft-v4-pro-svg': repImage('recraft-ai/recraft-v4-pro-svg', 0.30),
  'recraft-v4': repImage('recraft-ai/recraft-v4', 0.04),
  'recraft-v4-svg': repImage('recraft-ai/recraft-v4-svg', 0.08),
  'recraft-v3': repImage('recraft-ai/recraft-v3', 0.04),
  'recraft-v3-svg': repImage('recraft-ai/recraft-v3-svg', 0.08),
  'stable-diffusion-3.5-large': repImage('stability-ai/stable-diffusion-3.5-large', 0.065),
  'stable-diffusion-3.5-large-turbo': repImage('stability-ai/stable-diffusion-3.5-large-turbo', 0.04),
  'stable-diffusion-3.5-medium': repImage('stability-ai/stable-diffusion-3.5-medium', 0.035),
  // By quality: "auto $0.128, low $0.012, medium $0.047, high $0.128" — auto is
  // billed as the top tier it may pick. Output pictures only.
  'gpt-image-2': {
    unit: 'by_quality', byTier: { low: 0.012, medium: 0.047, high: 0.128, auto: 0.128 },
    service: 'replicate', source: rep('openai/gpt-image-2'), read: READ, confidence: 'verified',
  },
  // "auto $0.136, low $0.013, medium $0.05, high $0.136".
  'gpt-image-1.5': {
    unit: 'by_quality', byTier: { low: 0.013, medium: 0.05, high: 0.136, auto: 0.136 },
    service: 'replicate', source: rep('openai/gpt-image-1.5'), read: READ, confidence: 'verified',
  },
  'qwen-image': repImage('qwen/qwen-image', 0.025),
  'hunyuan-image-3': repImage('tencent/hunyuan-image-3', 0.08),
  'grok-imagine': repImage('xai/grok-imagine-image', 0.02),
  // "$5 per thousand output images".
  'flux-fast': repImage('prunaai/flux-fast', 0.005),
  'p-image': repImage('prunaai/p-image', 0.005),
  // One price for 1 and 2 megapixels.
  'wan-2.2-image-pruna': repImage('prunaai/wan-2.2-image', 0.02),
  'bria-fibo': repImage('bria/fibo', 0.04),
  'bria-image-3.2': repImage('bria/image-3.2', 0.04),
  'photon': repImage('luma/photon', 0.03),
  'photon-flash': repImage('luma/photon-flash', 0.01),
  'minimax-image-01': repImage('minimax/image-01', 0.01),
}

const own = <T>(o: Record<string, T>, k: string): T | undefined =>
  (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

/** The rate card for an id (own keys only), or undefined. */
export function imageRate(modelId: string): ImageRate | undefined {
  return own(IMAGE_RATES, modelId)
}

/** Round away binary float noise (a tenth of a micro-dollar). */
const tidy = (usd: number) => Math.round(usd * 1e8) / 1e8

/** Dollars for ONE picture at these settings (before the picture count and web search). */
function perPicture(rate: ImageRate, s: ImageSettings): number {
  switch (rate.unit) {
    case 'per_image': return rate.usd
    case 'per_megapixel': {
      const mp = Math.max(rate.minMegapixels ?? 0, Math.min(s.megapixels ?? rate.maxMegapixels, rate.maxMegapixels))
      return (rate.perImage ?? 0) + rate.perMegapixel * mp
    }
    default: {
      const p = s.tier == null ? undefined : own(rate.byTier, s.tier)
      return p ?? Math.max(...Object.values(rate.byTier))
    }
  }
}

/** Dollars the first service charges for one request with these settings, or null for an unpriced id. */
export function imageUsd(modelId: string, s: ImageSettings): number | null {
  const rate = imageRate(modelId)
  if (!rate) return null
  return tidy(perPicture(rate, s) * s.images + (s.webSearch && rate.webSearch ? rate.webSearch : 0))
}

/** The most one picture's request can cost on this card: the largest size, the dearest tier, the web search. */
function maxSettings(modelId: string): ImageSettings {
  const rate = imageRate(modelId)!
  const images = maxImageCount(modelId)
  const tier = rate.unit === 'by_resolution' || rate.unit === 'by_quality'
    ? Object.entries(rate.byTier).sort((a, b) => b[1] - a[1])[0]![0]
    : null
  const megapixels = rate.unit === 'per_megapixel' ? rate.maxMegapixels : null
  return { images, tier, megapixels, webSearch: !!rate.webSearch }
}

/**
 * The most a request can cost on this card — the price for a node whose
 * `model_options` is linked, so the settings can't be read until it runs.
 * Null for an unpriced id.
 */
export function imageMaxUsd(modelId: string): number | null {
  if (!imageRate(modelId)) return null
  return imageUsd(modelId, maxSettings(modelId))
}

/**
 * The most ONE picture can cost (the largest size, the dearest tier, the web
 * search), for the gallery's per-image "up to" figure. Several pictures in one
 * request (flux-dev ×4, a Seedream series) are not in it; the node badge
 * prices those. Null for an unpriced id.
 */
export function imageMaxPictureUsd(modelId: string): number | null {
  if (!imageRate(modelId)) return null
  return imageUsd(modelId, { ...maxSettings(modelId), images: 1 })
}

/**
 * Dollars for one picture at the model's default settings and ratio — the
 * figure the gallery shows and IMAGE_MODELS `pricePerImage` holds (a test
 * pins the two together). Null for an unpriced id.
 */
export function imageDefaultUsd(modelId: string, defaultAspectRatio: string): number | null {
  const s = effectiveImageSettings(modelId, defaultAspectRatio, {})
  return s ? imageUsd(modelId, s) : null
}

function dollars(usd: number): string {
  // Two decimals at least, three under a dollar when the service quotes them ($0.035, $0.128).
  if (usd < 0.01) return `$${usd.toFixed(4).replace(/0+$/, '')}`
  return `$${usd.toFixed(3).replace(/0$/, '')}`
}

/**
 * The gallery's price text PER IMAGE: one picture at the default settings,
 * and "up to" the dearest single picture when the size or quality changes it
 * — "$0.08, up to $0.175". Hosted, in credits: "16 credits, up to 27".
 */
export function imageRateLabel(modelId: string, defaultAspectRatio: string, opts: { hosted?: boolean } = {}): string | null {
  const base = imageDefaultUsd(modelId, defaultAspectRatio)
  const top = imageMaxPictureUsd(modelId)
  if (base == null || top == null) return null
  if (opts.hosted) {
    const b = creditsForUsd(base)
    const t = creditsForUsd(top)
    const unit = b === 1 ? 'credit' : 'credits'
    return t > b ? `${b} ${unit}, up to ${t}` : `${b} ${unit}`
  }
  return top > base ? `${dollars(base)}, up to ${dollars(top)}` : dollars(base)
}
