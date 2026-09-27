/**
 * What each image EDIT call's first service charges us — the endpoint the
 * request builder sends the node to today (editSettings.ts names it: a fal
 * app id or a Replicate slug). The edit tools, Upscale and Enhance detail all
 * price from here.
 *
 * Units, following the service:
 *  - `per_image`: dollars per output picture;
 *  - `by_resolution`: dollars per picture by the resolution tier sent
 *    (1K / 2K / 4K); a tier the card does not list is priced at its top tier;
 *  - `by_quality`: the same, by the quality tier sent (low / medium / high);
 *  - `flux2_megapixels`: fal FLUX.2 edit — a first output megapixel, then a
 *    price per extra megapixel of input AND output, each rounded up to a whole
 *    megapixel of 1024 × 1024 pixels (fal's page says so: 1024² is $0.03,
 *    1920 × 1080 is two);
 *  - `by_output_pixels`: a price per picture that steps up with the output
 *    size (Crystal, Topaz); above the last step, the last step's price, or,
 *    where the service lists no price there, the last step's price per pixel
 *    carried on (`beyondPerPixel`);
 *  - `per_output_megapixel`: a model billed by GPU time, priced per output
 *    megapixel with a floor (an estimate: the service publishes no per-unit
 *    figure);
 *  - `per_run_megapixels`: Replicate's FLUX.2 — a price per run, plus one per
 *    megapixel of the picture sent in and one per megapixel of the picture
 *    that comes back (each rounded up, see below);
 *  - `per_megapixel`: a published price per megapixel of the picture that
 *    comes back, at least one megapixel (Rotate camera on Qwen Image Edit
 *    2511, Task F10).
 *
 * Megapixels: where the service does not say how it counts them, a picture is
 * its pixels / 1,000,000 ROUNDED UP (controller ruling, fail-safe).
 *
 * Every card carries its source page, the date it was read and a confidence:
 * `verified` = the service's published figure; `estimate` = a model billed by
 * compute time, priced above the page's typical run cost.
 *
 * Pure data and pure functions; relative imports only (Nitro, the app and
 * vitest all load it).
 */
import { usdChargedAtCost } from './markup'

interface RateMeta {
  service: 'fal' | 'replicate'
  /** The page the figure was read from. */
  source: string
  /** ISO date the page was read. */
  read: string
  confidence: 'verified' | 'estimate'
}

export type EditRate =
  | (RateMeta & { unit: 'per_image', usd: number })
  | (RateMeta & { unit: 'by_resolution' | 'by_quality', byTier: Record<string, number> })
  | (RateMeta & { unit: 'flux2_megapixels', firstMegapixel: number, extraMegapixel: number, megapixelPixels: number })
  | (RateMeta & { unit: 'by_output_pixels', steps: readonly (readonly [maxPixels: number, usd: number])[], beyondPerPixel?: number })
  | (RateMeta & { unit: 'per_output_megapixel', perMegapixel: number, minUsd: number })
  | (RateMeta & { unit: 'per_run_megapixels', perRun: number, perInputMegapixel: number, perOutputMegapixel: number })
  | (RateMeta & { unit: 'per_megapixel', perMegapixel: number })

/** One priced provider call: the endpoint and the settings it is billed by. */
export interface EditCall {
  /** fal app id or Replicate slug — the key into EDIT_RATES. */
  endpoint: string
  /** The resolution tier the request carries ('1K', '2K'…), or its quality ('medium') on a by-quality card, or null. */
  tier: string | null
  /** Pixels of the pictures sent in, where the service bills them (FLUX.2 edit). */
  inputPixels: number | null
  /** Pixels of the picture that comes back, where the price depends on it. */
  outputPixels: number | null
  /**
   * Every other call this node may make instead of `endpoint`, on either
   * path: the ComfyUI path's fallback chain (_run_nano_banana_edit, Python),
   * the runner's backup service (server/runner/generators/twins.ts, Task
   * S3), and, where the runner's first service moved, the ComfyUI path's own
   * first call. `endpoint` is the runner's first call and carries the markup;
   * each of these is covered at cost (editMaxUsd), so the charge covers
   * whichever one runs.
   */
  fallbacks?: EditCall[]
}

const READ = '2026-09-24'
const fal = (endpoint: string) => `https://fal.ai/models/${endpoint}/llms.txt`
const rep = (slug: string) => `https://replicate.com/${slug}`
const verified = (service: 'fal' | 'replicate', source: string): RateMeta => ({ service, source, read: READ, confidence: 'verified' })
const estimate = (source: string): RateMeta => ({ service: 'replicate', source, read: READ, confidence: 'estimate' })

export const EDIT_RATES: Record<string, EditRate> = {
  // ── fal ─────────────────────────────────────────────────────────────────
  // "$0.08 per image … 2K and 4K outputs will be charged at 1.5 times and 2
  // times the standard rate … 0.5K (512px) … 0.75 times". The edit builders
  // never send web search or high thinking.
  'fal-ai/nano-banana-2/edit': {
    unit: 'by_resolution', byTier: { '0.5K': 0.06, '1K': 0.08, '2K': 0.12, '4K': 0.16 },
    ...verified('fal', fal('fal-ai/nano-banana-2/edit')),
  },
  // "$0.15 per image … 4K outputs will be charged at double the standard rate."
  'fal-ai/nano-banana-pro/edit': {
    unit: 'by_resolution', byTier: { '1K': 0.15, '2K': 0.15, '4K': 0.30 },
    ...verified('fal', fal('fal-ai/nano-banana-pro/edit')),
  },
  // "$0.03 for the first megapixel of output, plus $0.015 per extra megapixel
  // of input and output, rounded up to the nearest megapixel."
  'fal-ai/flux-2-pro/edit': {
    unit: 'flux2_megapixels', firstMegapixel: 0.03, extraMegapixel: 0.015, megapixelPixels: 1024 * 1024,
    ...verified('fal', fal('fal-ai/flux-2-pro/edit')),
  },
  // GPT Image 2.5 Flare edit (Task F2): billed by tokens; the model page's
  // per-size table "including one input image" (read 2026-09-24; the edit
  // sends exactly one). The edit keeps the input's shape (`image_size` auto),
  // so the size is unknown before it runs: priced at the table's largest row,
  // 3840 × 2160 (the most the model makes, "max edge 3840px").
  'openai/gpt-image-2.5/flare/edit': {
    unit: 'by_quality', byTier: { low: 0.01113, medium: 0.02595, high: 0.10008 },
    ...verified('fal', 'https://fal.ai/models/openai/gpt-image-2.5/flare/edit'),
  },
  // Rotate camera on Qwen Image Edit 2511, multiple angles (Task F10): "$0.035
  // per megapixels" (llms.txt, read 2026-09-24), unit: a megapixel of the
  // picture made, rounded up (ruling). The builder sends no `image_size`, so
  // the picture is made at the input's size (the schema: "If not provided,
  // the size of the input image will be used"): editSettings.ts prices the
  // input's measured size, or the input cap.
  'fal-ai/qwen-image-edit-2511-multiple-angles': {
    unit: 'per_megapixel', perMegapixel: 0.035,
    ...verified('fal', fal('fal-ai/qwen-image-edit-2511-multiple-angles')),
  },
  // Product shot on Bria Product Shot (Task F12): "$0.04 per generations"
  // (llms.txt, read 2026-09-24), unit: one picture made. The builder asks
  // for one (num_results 1, one placement), at about 1 MP whatever the
  // input's size (shot_size), so the price doesn't read the size.
  'fal-ai/bria/product-shot': { unit: 'per_image', usd: 0.04, ...verified('fal', fal('fal-ai/bria/product-shot')) },
  // "Price: $0.04 per images".
  'fal-ai/flux-pro/kontext': { unit: 'per_image', usd: 0.04, ...verified('fal', fal('fal-ai/flux-pro/kontext')) },

  // ── Replicate (billingConfig on the model page) ─────────────────────────
  // By "target resolution": 1K $0.067, 2K $0.101, 4K $0.151 per output image.
  'google/nano-banana-2': {
    unit: 'by_resolution', byTier: { '1K': 0.067, '2K': 0.101, '4K': 0.151 },
    ...verified('replicate', rep('google/nano-banana-2')),
  },
  // By "target resolution": 1K $0.15, 2K $0.15, 4K $0.30 — the last step of
  // Restyle Pro's chain (fal Nano Banana Pro, then this), and its runner backup.
  'google/nano-banana-pro': {
    unit: 'by_resolution', byTier: { '1K': 0.15, '2K': 0.15, '4K': 0.30 },
    ...verified('replicate', rep('google/nano-banana-pro')),
  },
  // "$0.015 per run, $0.015 per input image megapixel, $0.015 per output image
  // megapixel" — the runner's backup for FLUX.2 [pro] edit (Task S3): the
  // picture sent in, and one the same size back (`match_input_image`).
  'black-forest-labs/flux-2-pro': {
    unit: 'per_run_megapixels', perRun: 0.015, perInputMegapixel: 0.015, perOutputMegapixel: 0.015,
    ...verified('replicate', rep('black-forest-labs/flux-2-pro')),
  },
  // "low $0.012, medium $0.047, high $0.128" per output image, whatever the
  // size or the pictures sent in — the runner's backup for the GPT Image 2.5 edit.
  'openai/gpt-image-2.5-flare': {
    unit: 'by_quality', byTier: { low: 0.012, medium: 0.047, high: 0.128 },
    ...verified('replicate', rep('openai/gpt-image-2.5-flare')),
  },
  // "$0.039 per output image" (the original Nano Banana takes no resolution).
  'google/nano-banana': { unit: 'per_image', usd: 0.039, ...verified('replicate', rep('google/nano-banana')) },
  // By "target resolution": 1K $0.045, 2K $0.09 per output image.
  'bytedance/seedream-5-pro': {
    unit: 'by_resolution', byTier: { '1K': 0.045, '2K': 0.09 },
    ...verified('replicate', rep('bytedance/seedream-5-pro')),
  },
  // "$0.035 per output image", whatever the size.
  'bytedance/seedream-5-lite': { unit: 'per_image', usd: 0.035, ...verified('replicate', rep('bytedance/seedream-5-lite')) },
  // "$0.03 per output image".
  'qwen/qwen-image-edit-plus': { unit: 'per_image', usd: 0.03, ...verified('replicate', rep('qwen/qwen-image-edit-plus')) },
  // Community model billed by GPU time (L40S, $0.000975/s): "costs
  // approximately $0.16 to run". Priced at that measured figure, as the
  // line-up page did. Product shot is being retired (decision 7): Bria
  // Product Shot replaces it while its switch is on (Task F12).
  'catacolabs/sdxl-ad-inpaint': { unit: 'per_image', usd: 0.16, ...estimate(rep('catacolabs/sdxl-ad-inpaint')) },
  // Community model billed by GPU time (L40S): "costs approximately $0.0073
  // to run". Priced at $0.05, the figure charged before, about 7 times the
  // typical run, until Restyle's IP-Adapter engine is hidden (decision 7).
  'fofr/style-transfer': { unit: 'per_image', usd: 0.05, ...estimate(rep('fofr/style-transfer')) },

  // ── Upscale and Enhance detail (Replicate) ──────────────────────────────
  // Billed by GPU time (A100 40GB, $0.00115/s), "approximately $0.036 to run"
  // for a typical picture (re-read 2026-09-24; it said $0.020 earlier that day). Tiled upscaling time grows with the output size,
  // so it is priced per output megapixel: $0.0125/MP makes 16 MP out (a 2 × 2K
  // picture at 2×) $0.20, the figure charged before, which stays the floor.
  'philz1337x/clarity-upscaler': {
    unit: 'per_output_megapixel', perMegapixel: 0.0125, minUsd: 0.20,
    ...estimate(rep('philz1337x/clarity-upscaler')),
  },
  // By output image pixels: ≤ 4.4M $0.05, ≤ 8.8M $0.10, ≤ 17.6M $0.20,
  // ≤ 27.5M $0.40, ≤ 55M $0.80, ≤ 110M $1.60, above $3.20.
  'philz1337x/crystal-upscaler': {
    unit: 'by_output_pixels',
    steps: [[4_400_000, 0.05], [8_800_000, 0.10], [17_600_000, 0.20], [27_500_000, 0.40], [55_000_000, 0.80], [110_000_000, 1.60], [Infinity, 3.20]],
    ...verified('replicate', rep('philz1337x/crystal-upscaler')),
  },
  // "$0.002 per image output".
  'nightmareai/real-esrgan': { unit: 'per_image', usd: 0.002, ...verified('replicate', rep('nightmareai/real-esrgan')) },
  // "$6 per thousand output images".
  'recraft-ai/recraft-crisp-upscale': { unit: 'per_image', usd: 0.006, ...verified('replicate', rep('recraft-ai/recraft-crisp-upscale')) },
  // "$0.08 per unit"; the units by output megapixels, from the page's table:
  // 24 MP 1, 48 MP 2, 60 MP 3, 96 MP 4, 132 MP 5, 168 MP 6, 336 MP 11, 512 MP 17.
  // (The same table quotes $0.05 a unit; the billed tier says $0.08, so $0.08.)
  // Above 512 MP the table stops: 17 units per 512 MP, carried on.
  'topazlabs/image-upscale': {
    unit: 'by_output_pixels',
    steps: [[24e6, 0.08], [48e6, 0.16], [60e6, 0.24], [96e6, 0.32], [132e6, 0.40], [168e6, 0.48], [336e6, 0.88], [512e6, 1.36]],
    beyondPerPixel: 1.36 / 512e6,
    ...verified('replicate', rep('topazlabs/image-upscale')),
  },
  // Fix faces on fal's Topaz (family fix-faces): "For a single image, your
  // request will cost $0.08 for up to 24MP, $0.16 for up to 48MP, $0.32 for
  // up to 96MP, and up to $1.36 for 512MP output resolution" (llms.txt, read
  // 2026-09-26). MP read as 1,000,000 pixels (fail-safe). Between 96 and 512
  // MP fal names no step, so the top one.
  'fal-ai/topaz/upscale/image': {
    unit: 'by_output_pixels',
    steps: [[24e6, 0.08], [48e6, 0.16], [96e6, 0.32], [512e6, 1.36]],
    beyondPerPixel: 1.36 / 512e6,
    ...verified('fal', fal('fal-ai/topaz/upscale/image')),
  },
  // Face swap on Easel (family face-swap): "$0.05 per generations" (llms.txt, read 2026-09-26).
  'easel-ai/advanced-face-swap': { unit: 'per_image', usd: 0.05, ...verified('fal', fal('easel-ai/advanced-face-swap')) },
  // ── Restyle with a style LoRA (RestyleWithLoRANode, ComfyUI path) ───────
  // Moondream 2, billed by GPU time (L40S, $0.000975/s): "costs approximately
  // $0.0020 to run". The node captions once and classifies up to four times.
  'lucataco/moondream2': { unit: 'per_image', usd: 0.002, ...estimate(rep('lucataco/moondream2')) },
  // "$0.032 per output image" — but the node runs the user's own trained
  // model instead when the LoRA has one (billed by GPU time; the LoRA
  // category's observed median is ~$0.04, priceBook.ts LORA_RENDER_CREDITS),
  // and the price can't see which. So the dearer $0.04.
  'black-forest-labs/flux-dev-lora': { unit: 'per_image', usd: 0.04, ...estimate(rep('black-forest-labs/flux-dev-lora')) },
  // Billed by GPU time (L40S), "approximately $0.031 to run" for a typical
  // ~1 MP picture. Enhance detail runs it in place, so it is priced per output
  // megapixel, never below the $0.10 charged before.
  'fermatresearch/magic-image-refiner': {
    unit: 'per_output_megapixel', perMegapixel: 0.031, minUsd: 0.10,
    ...estimate(rep('fermatresearch/magic-image-refiner')),
  },
}

const own = <T>(o: Record<string, T>, k: string): T | undefined =>
  (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

/** The rate card for an endpoint (own keys only), or undefined. */
export function editRate(endpoint: string): EditRate | undefined {
  return own(EDIT_RATES, endpoint)
}

/** Whole megapixels, rounded up (the controller's rule where a service does not say). */
export const megapixelsOf = (pixels: number) => Math.ceil(pixels / 1e6 - 1e-9)

/** Round away binary float noise (a tenth of a micro-dollar). */
const tidy = (usd: number) => Math.round(usd * 1e8) / 1e8

/**
 * Dollars the service charges for this one call (its fallbacks aside), or
 * null when the endpoint has no card.
 */
export function editUsd(call: EditCall): number | null {
  const rate = editRate(call.endpoint)
  if (!rate) return null
  switch (rate.unit) {
    case 'per_image': return rate.usd
    case 'by_resolution':
    case 'by_quality': {
      const p = call.tier == null ? undefined : own(rate.byTier, call.tier)
      return p ?? Math.max(...Object.values(rate.byTier))
    }
    case 'flux2_megapixels': {
      const whole = (px: number) => Math.ceil(px / rate.megapixelPixels - 1e-9)
      const mp = Math.max(1, whole(call.inputPixels ?? 0) + whole(call.outputPixels ?? 0))
      return tidy(rate.firstMegapixel + rate.extraMegapixel * (mp - 1))
    }
    case 'by_output_pixels': {
      const px = call.outputPixels ?? Infinity
      const step = rate.steps.find(([max]) => px <= max)
      if (step) return step[1]
      const last = rate.steps[rate.steps.length - 1]!
      return rate.beyondPerPixel == null ? last[1] : tidy(Math.max(last[1], rate.beyondPerPixel * px))
    }
    case 'per_output_megapixel':
      return tidy(Math.max(rate.minUsd, rate.perMegapixel * megapixelsOf(call.outputPixels ?? 0)))
    case 'per_run_megapixels':
      return tidy(rate.perRun + rate.perInputMegapixel * megapixelsOf(call.inputPixels ?? 0) + rate.perOutputMegapixel * megapixelsOf(call.outputPixels ?? 0))
    case 'per_megapixel':
      return tidy(rate.perMegapixel * Math.max(1, megapixelsOf(call.outputPixels ?? 0)))
  }
}

/** A call a node makes `times` times in one run (a pipeline of several calls). */
export interface EditStep { call: EditCall, times: number }

/**
 * The price of a node that makes several calls in one run, by the same rule
 * as one call's chain: the calls as first sent, with the usual markup, or the
 * run's worst case (every call on its dearest fallback) covered at cost —
 * whichever is higher. Null when any call has no card.
 */
export function editStepsUsd(steps: readonly EditStep[]): number | null {
  let marked = 0
  let worst = 0
  for (const { call, times } of steps) {
    const first = editUsd(call)
    if (first == null) return null
    let dearest = first
    for (const one of call.fallbacks ?? []) {
      const p = editUsd(one)
      if (p == null) return null
      dearest = Math.max(dearest, p)
    }
    marked += first * times
    worst += dearest * times
  }
  return Math.max(tidy(marked), usdChargedAtCost(tidy(worst)))
}

/**
 * The price that covers this call and every call the ComfyUI path falls back
 * to after it (controller ruling, P4): the first call carries the usual
 * markup, a fallback is only covered at cost — it is rarely taken, so it must
 * never lose money but does not earn the markup. Null when any of them has no
 * card.
 */
export function editMaxUsd(call: EditCall): number | null {
  const first = editUsd(call)
  if (first == null) return null
  let usd = first
  for (const one of call.fallbacks ?? []) {
    const p = editUsd(one)
    if (p == null) return null
    usd = Math.max(usd, usdChargedAtCost(p))
  }
  return usd
}
