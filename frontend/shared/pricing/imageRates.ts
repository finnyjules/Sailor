/**
 * What each image model's FIRST service charges us — the service Sailor's
 * request builder sends it to today: fal for the RUNNER_IMAGE_MODELS ids and
 * the Python `primary="fal"` models (Krea 2), and the runner-only GPT Image
 * 2.5 (server/runner/generators/gptImage25.ts), Ideogram 4 (ideogram4.ts),
 * Muse Image (museImage.ts) and Reve 2.1 (reve21.ts), Replicate for the rest,
 * the runner-only Qwen Image 3, Grok Imagine 2 and Nano Banana 2 Lite among
 * them (qwenImage3.ts, grokImagine2.ts, nanoBanana2Lite.ts)
 * (comfy_api_nodes/image_models.py `primary`, default "replicate").
 *
 * Units, following the service:
 *  - `per_image`: dollars per output picture;
 *  - `per_megapixel`: dollars per billed output megapixel, plus a fixed part
 *    per picture where the service has one (Replicate's "per run"), and a
 *    1 MP floor where the service normalises to 1 MP. Neither service says
 *    how it rounds, so a picture's megapixels are its pixels / 1,000,000
 *    rounded UP (controller ruling; imageSettings.ts billedMegapixels), with
 *    the floor applied after the rounding. A card whose per-megapixel price
 *    depends on a tier (Ideogram 4's speed) lists it in `perMegapixelByTier`,
 *    and `perMegapixel` is its dearest tier (a tier it doesn't list);
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
 * A model with a BACKUP service (server/runner/generators/twins.ts; its card
 * in IMAGE_BACKUP_RATES) is priced at the first service's price, or the
 * backup's covered at cost, whichever is higher (`imagePriceUsd`; the P4 rule,
 * markup.ts usdChargedAtCost), so a job the backup serves never costs Sailor
 * more than it charged. Settings that go without the backup (ImageSettings
 * `noBackup`: Ideogram 4 at 1K) are priced at the first service alone.
 *
 * Pure data and pure functions; relative imports only (Nitro, the app and
 * vitest all load it).
 */
import { creditsForUsd, usdChargedAtCost } from './markup'
import {
  BFL_MAX_MEGAPIXELS, FAL_MAX_MEGAPIXELS, FLUX_2_DEV_MAX_MEGAPIXELS, IDEOGRAM_4_MAX_MEGAPIXELS, effectiveImageSettings, maxImageCount,
  type ImageSettings,
} from './imageSettings'

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
  | (RateMeta & {
    unit: 'per_megapixel', perMegapixel: number, perImage?: number, minMegapixels?: number, maxMegapixels: number
    /** Dollars per megapixel by tier, where the tier sets it; `perMegapixel` is the dearest. */
    perMegapixelByTier?: Record<string, number>
  })
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
  // "Your request will cost $0.15 per image … 4K outputs will be charged at
  // double the standard rate. If web search is used, an additional $0.015"
  // (same text on /edit). The builder's endpoint since Task S1b is
  // fal-ai/nano-banana-pro itself (it was google/nano-banana-pro, whose page
  // lists only "$0 per compute seconds"). The builder sends no web search.
  // Replicate's google/nano-banana-pro charges the same ($0.15 / $0.15 / $0.30).
  'nano-banana-pro': {
    unit: 'by_resolution', byTier: { '1K': 0.15, '2K': 0.15, '4K': 0.30 },
    service: 'fal', source: fal('fal-ai/nano-banana-pro'), read: READ, confidence: 'verified',
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
  // Ideogram 4 (runner-only, Task F8), fal first: "$0.0075 per megapixel in
  // TURBO mode, $0.015 per megapixel in BALANCED mode, or $0.025 per
  // megapixel in QUALITY mode" (llms.txt, read 2026-09-24). Its worked example
  // ("a 2048 x 2048 image will cost $0.03, $0.06 or $0.10") bills 2048² as
  // 4 MP, but the MP ruling rounds pixels / 1,000,000 up, so 2048² is priced
  // at 5 MP: never under. The builder sends expansion_model "None", which
  // "skips its fee" (the expansion fee isn't published). The 1K sizes are at
  // most 1,000,000 pixels (1 MP); the 2K ones 4 or 5 MP (imageSettings.ts
  // IDEOGRAM_4_SIZES).
  'ideogram-4': {
    unit: 'per_megapixel', perMegapixel: 0.025, perMegapixelByTier: { TURBO: 0.0075, BALANCED: 0.015, QUALITY: 0.025 },
    minMegapixels: 1, maxMegapixels: IDEOGRAM_4_MAX_MEGAPIXELS,
    service: 'fal', source: fal('ideogram/v4'), read: READ, confidence: 'verified',
  },
  // Muse Image (Meta; runner-only, Task F13), fal only: "Price: $0.01 per
  // images" (llms.txt, read 2026-09-24), one picture at Muse's own ~2.5 MP
  // whatever the ratio. The schema has no web search or other paid extra.
  // No backup (Replicate has no Muse, museImage.ts).
  'muse-image': falImage('meta/muse-image/text-to-image', 0.01),
  // Reve 2.1 (runner-only, Task F15), fal only: "Price: $0.25 per images"
  // (llms.txt, read 2026-09-24; the page's billing: unit "images", price
  // 0.25, one tier), whatever the ratio. The schema has no size setting (Reve
  // makes its own large picture, fal's example 5376 × 3072) and no paid
  // extra, so one price. No backup (Replicate has no Reve 2.1, reve21.ts).
  'reve-2.1': falImage('reve/2.1/text-to-image', 0.25),
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
  // false). The builder sends no go_fast and the schema default is true. It
  // sends width × height (at most 1440 × 1440, 3 billed MP; imageSettings.ts
  // flux2DevSize), no longer a resolution label (Task S1b).
  'flux-2-dev': {
    unit: 'per_megapixel', perMegapixel: 0.012, maxMegapixels: FLUX_2_DEV_MAX_MEGAPIXELS,
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
  // GPT Image 2.5 (runner-only, Task F2), fal first; both versions. fal bills
  // tokens ("Image tokens (per 1M): $8.00 input … $30.00 output", llms.txt) and
  // its model page prices the canonical sizes (read 2026-09-24, the same table
  // on Flare and Sunburst): 1024×1024 low $0.00588, medium $0.01317, high
  // $0.05268; 2560×1440 $0.00615, $0.01434, $0.05529 — the dearest row up to the
  // largest picture the builder asks for (2048 × 1152). Priced at that row for
  // every size, so no ratio is under-priced. Replicate's flat price (the backup,
  // below, covered at cost) sits above it at every quality.
  'gpt-image-2.5': {
    unit: 'by_quality', byTier: { low: 0.00615, medium: 0.01434, high: 0.05529 },
    service: 'fal', source: 'https://fal.ai/models/openai/gpt-image-2.5/flare/text-to-image', read: READ, confidence: 'verified',
    note: 'per-size table on the model page; the same on openai/gpt-image-2.5/sunburst/text-to-image',
  },
  'qwen-image': repImage('qwen/qwen-image', 0.025),
  // Qwen Image 3 (runner-only, Task F6), Replicate only: "$0.03 per output
  // image" (billingConfig, image_output_count; the README says the same),
  // whatever the ratio. No backup (fal's is the Pro model, qwenImage3.ts).
  'qwen-image-3': repImage('alibaba/qwen-image-3', 0.03),
  'hunyuan-image-3': repImage('tencent/hunyuan-image-3', 0.08),
  'grok-imagine': repImage('xai/grok-imagine-image', 0.02),
  // Grok Imagine 2 (runner-only, Task F7), Replicate only: "$0.04 per output
  // image" (billingConfig, image_output_count, one tier; the README says the
  // same), whatever the ratio, size or quality. No backup (fal publishes no
  // price for its Grok Imagine 2, grokImagine2.ts).
  'grok-imagine-2': repImage('xai/grok-imagine-image-2', 0.04),
  // Nano Banana 2 Lite (runner-only, Task F14), Replicate only: "$0.034 per
  // output image" (billingConfig, image_output_count, one tier; read
  // 2026-09-24), always a 1K picture (its README), whatever the ratio. Google's
  // own list price is the same ($0.0336 a 1K picture, ai.google.dev pricing).
  // No web search or other paid extra. No backup (fal bills it by tokens and
  // publishes no price a picture, nanoBanana2Lite.ts).
  'nano-banana-2-lite': repImage('google/nano-banana-2-lite', 0.034),
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

/**
 * What the BACKUP service charges, for each model that has one. The backup
 * renders the same picture, so it reads the same ImageSettings (Flux 2 Pro
 * and Max: the label's megapixels, capped at 2048 × 2048; the fal request is
 * that size or, at a wide ratio past 2048 a side, smaller, so never billed
 * more).
 */
export const IMAGE_BACKUP_RATES: Record<string, ImageRate> = {
  // fal-ai/flux-2 (FLUX.2 [dev]): "$0.012 per megapixels". fal doesn't say how
  // it rounds, so a picture is its pixels / 1,000,000 rounded up.
  'flux-2-dev': {
    unit: 'per_megapixel', perMegapixel: 0.012, maxMegapixels: FLUX_2_DEV_MAX_MEGAPIXELS,
    service: 'fal', source: fal('fal-ai/flux-2'), read: READ, confidence: 'verified',
  },
  // fal-ai/flux-2-pro (jpg or png requests only; twins.ts): "$0.03 for the
  // first megapixel of output, plus $0.015 per extra megapixel of input and
  // output, rounded up to the nearest megapixel" = $0.015 + $0.015 per MP, at
  // least 1 MP. The backup sends no input picture. Same as Replicate's card.
  'flux-2-pro': {
    unit: 'per_megapixel', perImage: 0.015, perMegapixel: 0.015, minMegapixels: 1, maxMegapixels: BFL_MAX_MEGAPIXELS,
    service: 'fal', source: fal('fal-ai/flux-2-pro'), read: READ, confidence: 'verified',
  },
  // fal-ai/flux-2-max: "The first processed megapixel will cost $0.07. Each
  // additional megapixel will cost 0.03" = $0.04 + $0.03 per MP, at least
  // 1 MP (rounded up, the ruling above). Same as Replicate's card.
  'flux-2-max': {
    unit: 'per_megapixel', perImage: 0.04, perMegapixel: 0.03, minMegapixels: 1, maxMegapixels: BFL_MAX_MEGAPIXELS,
    service: 'fal', source: fal('fal-ai/flux-2-max'), read: READ, confidence: 'verified',
  },
  // "Price: $0.04 per images" / "$0.25 per images": Replicate's prices.
  'recraft-v4': falImage('fal-ai/recraft/v4/text-to-image', 0.04),
  'recraft-v4-pro': falImage('fal-ai/recraft/v4/pro/text-to-image', 0.25),
  // openai/gpt-image-2.5-flare and -sunburst (billingConfig, the same tiers on
  // both): "low $0.012, medium $0.047, high $0.128" per output image, whatever
  // the size. Output pictures only.
  'gpt-image-2.5': {
    unit: 'by_quality', byTier: { low: 0.012, medium: 0.047, high: 0.128 },
    service: 'replicate', source: rep('openai/gpt-image-2.5-flare'), read: READ, confidence: 'verified',
    note: 'the same tiers on openai/gpt-image-2.5-sunburst',
  },
  // Ideogram 4 on Replicate, one model per speed, 2K pictures only (so a 1K
  // request has no backup; imageSettings.ts `noBackup`): "$0.03 per output
  // image" (ideogram-ai/ideogram-v4-turbo), "$0.06" (-balanced), "$0.10"
  // (-quality), whatever the size (billingConfig, image_output_count, one
  // tier each; the README lists the same three).
  'ideogram-4': {
    unit: 'by_quality', byTier: { TURBO: 0.03, BALANCED: 0.06, QUALITY: 0.10 },
    service: 'replicate', source: rep('ideogram-ai/ideogram-v4-balanced'), read: READ, confidence: 'verified',
    note: 'one model per speed: ideogram-ai/ideogram-v4-turbo, -balanced, -quality',
  },
}

const own = <T>(o: Record<string, T>, k: string): T | undefined =>
  (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

/** The rate card for an id (own keys only), or undefined. */
export function imageRate(modelId: string): ImageRate | undefined {
  return own(IMAGE_RATES, modelId)
}

/** The backup service's card for an id, or undefined when it has no backup. */
export function imageBackupRate(modelId: string): ImageRate | undefined {
  return own(IMAGE_BACKUP_RATES, modelId)
}

/** Round away binary float noise (a tenth of a micro-dollar). */
const tidy = (usd: number) => Math.round(usd * 1e8) / 1e8

/** Dollars for ONE picture at these settings (before the picture count and web search). */
function perPicture(rate: ImageRate, s: ImageSettings): number {
  switch (rate.unit) {
    case 'per_image': return rate.usd
    case 'per_megapixel': {
      const mp = Math.max(rate.minMegapixels ?? 0, Math.min(s.megapixels ?? rate.maxMegapixels, rate.maxMegapixels))
      const tiered = rate.perMegapixelByTier && s.tier != null ? own(rate.perMegapixelByTier, s.tier) : undefined
      return (rate.perImage ?? 0) + (tiered ?? rate.perMegapixel) * mp
    }
    default: {
      const p = s.tier == null ? undefined : own(rate.byTier, s.tier)
      return p ?? Math.max(...Object.values(rate.byTier))
    }
  }
}

/** Dollars on one card for one request with these settings. */
function requestUsd(rate: ImageRate, s: ImageSettings): number {
  return tidy(perPicture(rate, s) * s.images + (s.webSearch && rate.webSearch ? rate.webSearch : 0))
}

/** Dollars the first service charges for one request with these settings, or null for an unpriced id. */
export function imageUsd(modelId: string, s: ImageSettings): number | null {
  const rate = imageRate(modelId)
  return rate ? requestUsd(rate, s) : null
}

/**
 * The price basis for one request: the first service's price, or the
 * backup's covered at cost, whichever is higher (see the header). `credits =
 * creditsForUsd(basis)`. Null for an unpriced id.
 */
export function imagePriceUsd(modelId: string, s: ImageSettings): number | null {
  const first = imageUsd(modelId, s)
  if (first == null) return null
  const backup = imageBackupRate(modelId)
  return backup && !s.noBackup ? Math.max(first, usdChargedAtCost(requestUsd(backup, s))) : first
}

/** The most one picture's request can cost on this card: the largest size, the dearest tier, the web search. */
function maxSettings(modelId: string): ImageSettings {
  const rate = imageRate(modelId)!
  const images = maxImageCount(modelId)
  const tiers = rate.unit === 'by_resolution' || rate.unit === 'by_quality' ? rate.byTier
    : rate.unit === 'per_megapixel' ? rate.perMegapixelByTier
      : undefined
  const tier = tiers ? Object.entries(tiers).sort((a, b) => b[1] - a[1])[0]![0] : null
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

/** imageMaxUsd as a price basis (imagePriceUsd's rule): a linked `model_options`. */
export function imagePriceMaxUsd(modelId: string): number | null {
  if (!imageRate(modelId)) return null
  return imagePriceUsd(modelId, maxSettings(modelId))
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
    // Credits: the charge, which covers the backup (imagePriceUsd); dollars stay the first service's.
    const defaults = effectiveImageSettings(modelId, defaultAspectRatio, {})!
    const b = creditsForUsd(imagePriceUsd(modelId, defaults)!)
    const t = creditsForUsd(imagePriceUsd(modelId, { ...maxSettings(modelId), images: 1 })!)
    const unit = b === 1 ? 'credit' : 'credits'
    return t > b ? `${b} ${unit}, up to ${t}` : `${b} ${unit}`
  }
  return top > base ? `${dollars(base)}, up to ${dollars(top)}` : dollars(base)
}
