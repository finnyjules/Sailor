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
 *  - `per_megapixel_step`: a diffusion model billed by GPU time (LC4: Clarity
 *    and the Magic Image Refiner), a ceiling per megapixel of the picture
 *    made per denoising step sent, plus a start cost: `startUsd` + steps ×
 *    (`perMegapixelStep` × MP + `perSquareMegapixelStep` × MP²), the MP its
 *    pixels / 1,000,000 (not rounded: the rate carries the margin). The
 *    squared term (a picture diffused whole: its attention grows with the
 *    square of its size) is absent for a tiled model. Steps not sent (null)
 *    are priced at `maxSteps`;
 *  - `per_run_megapixels`: Replicate's FLUX.2 — a price per run, plus one per
 *    megapixel of the picture sent in and one per megapixel of the picture
 *    that comes back (each rounded up, see below);
 *  - `per_megapixel`: a published price per megapixel of the picture that
 *    comes back, at least one megapixel (Rotate camera on Qwen Image Edit
 *    2511, Task F10);
 *  - `per_input_megapixel`: a model billed by GPU time whose run grows with
 *    the picture sent in (R7.11, Real-ESRGAN): a ceiling per megapixel of
 *    that picture (its pixels / 1,000,000, not rounded: the rate carries the
 *    margin), with a floor, the picture taken at most `maxInputPixels` (the
 *    model's largest input). A picture of unknown size is priced at that cap.
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
  | (RateMeta & { unit: 'per_megapixel_step', startUsd: number, perMegapixelStep: number, perSquareMegapixelStep?: number, maxSteps: number, note: string })
  | (RateMeta & { unit: 'per_run_megapixels', perRun: number, perInputMegapixel: number, perOutputMegapixel: number })
  | (RateMeta & { unit: 'per_megapixel', perMegapixel: number })
  | (RateMeta & { unit: 'per_input_megapixel', perMegapixel: number, minUsd: number, maxInputPixels: number, note: string })

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
  /**
   * Denoising steps the call is sent (LC4: Clarity's `num_inference_steps`, the
   * refiner's `steps`), where the price depends on them; absent, the card's most.
   */
  steps?: number | null
  /**
   * R11.6 fix round 3: how many times the node makes this call in one run
   * (Upscale on Real-ESRGAN over the service's largest picture, in tiles:
   * the most tiles the picture can make, each held at the largest). Absent: once.
   */
  times?: number
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
  // Billed by GPU time (A100 40GB, $0.00115/s; page re-read 2026-10-02: "approximately $0.013 to run",
  // "typically complete within 12 seconds"). LC4 (USER go 2026-10-02): the $0.20 floor (the pre-R3 price
  // policy, 68× the measured bill) is gone; a GPU-time ceiling from the settings sent instead. Clarity is
  // A1111 img2img with tiled diffusion (about 1 MP a tile), so its time is a start cost plus the megapixels
  // made times the steps. MEASURED twice (predict_time):
  //  - 2026-10-01 (upscale-clarity-1x): 512² at scale 1 (0.262 MP made), 18 steps, creativity 0.35: 2.5 s
  //    ($0.0029);
  //  - 2026-10-02 (LC4 calibration, prediction kpz3kxjxg5rn80d0zqz9dhezjw): 1024² at scale 2 (4.19 MP made),
  //    50 steps, creativity 1 (the dearest): 47.92 s ($0.0551).
  // Fitted through both (start + slope × MP × steps), steps counted as sent (creativity ignored) and as
  // denoised (× creativity): the worse slope 0.2216 s / MP / step (as sent: start 1.45 s), the worse start
  // 2.14 s (as denoised: 0.2183 s). Priced at 2× each: 4.28 s × $0.00115 = $0.0050 a call, plus 0.4432 s ×
  // $0.00115 = $0.00051 a megapixel a step, on every step sent. Held at 2.5× the first run's bill and 2.03×
  // the second's. Tiles keep it linear in the area made (the 4.19 MP run is several full tiles). Steps 10–50
  // on the node (validated); a wired one the service's own most, 100. Verified: the second run is at the
  // dearest settings the node sends (50 steps, creativity 1).
  'philz1337x/clarity-upscaler': {
    unit: 'per_megapixel_step', startUsd: 0.005, perMegapixelStep: 0.00051, maxSteps: 100,
    note: 'A100-40 at $0.00115/s; measured 2.5 s (512² made, 18 steps, creativity 0.35, 2026-10-01) and 47.92 s (2048² made, 50 steps, creativity 1, 2026-10-02, kpz3kxjxg5rn80d0zqz9dhezjw); fit ≤ 2.14 s + 0.2216 s/MP/step; ceiling 2× both',
    ...verified('replicate', rep('philz1337x/clarity-upscaler')), read: '2026-10-02',
  },
  // By output image pixels: ≤ 4.4M $0.05, ≤ 8.8M $0.10, ≤ 17.6M $0.20,
  // ≤ 27.5M $0.40, ≤ 55M $0.80, ≤ 110M $1.60, above $3.20.
  'philz1337x/crystal-upscaler': {
    unit: 'by_output_pixels',
    steps: [[4_400_000, 0.05], [8_800_000, 0.10], [17_600_000, 0.20], [27_500_000, 0.40], [55_000_000, 0.80], [110_000_000, 1.60], [Infinity, 3.20]],
    ...verified('replicate', rep('philz1337x/crystal-upscaler')),
  },
  // Real-ESRGAN is billed by GPU time (R7.11 live check, 2026-10-01): its predict_time on Nvidia T4
  // ($0.000225/s, Replicate's T4 rate, as the other T4 cards in paidRates.ts) was 12.13 s for a 1152 × 1152
  // picture (1.33 MP in) at 2×, about $0.00273 — over the $0.002 a picture this card said (read as "$0.002
  // per image output", marked verified, 2026-09-24). Now a ceiling per megapixel sent in: measured 9.14 s a
  // megapixel ($0.00206); carded at $0.003 a megapixel (13.3 s, about 1.46× the measurement), at least $0.003
  // a call (13.3 s, a small picture's start-up), the picture taken at most the 1 572 864 pixels (1536 × 1024)
  // sent in one call (shared/runner/localModels.ts UPSCALE_2X_MAX_PIXELS): the service states 2 096 704 (R11.6's
  // live check, 2026-10-01), but a 2 046 000-pixel tile ran out of GPU memory there (LC4, 2026-10-02), so 75% of
  // it: at most $0.00471859 a call. MEASURED 2026-10-01 (R7.11): 12.13 s at 1.33 MP in, 2×, face_enhance off; the ceiling is above it, so the card is verified.
  'nightmareai/real-esrgan': {
    unit: 'per_input_megapixel', perMegapixel: 0.003, minUsd: 0.003, maxInputPixels: 1_572_864,
    note: 'T4 at $0.000225/s; live check 2026-10-01: 12.13 s for 1152² in (1.33 MP) at 2× = $0.00273 ($0.00206/MP); ceiling $0.003/MP, at least $0.003, input at most 1 572 864 px (1536 × 1024: 75% of the 2 096 704 Replicate states, after a 2 046 000-px tile ran out of GPU memory on 2026-10-02)',
    ...verified('replicate', rep('nightmareai/real-esrgan')), read: '2026-10-01',
  },
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
  // Face swap on Easel: "$0.05 per generations" (llms.txt, read 2026-09-26). No longer called (LC1): kept
  // for the way back should fal's face swap below go away.
  'easel-ai/advanced-face-swap': { unit: 'per_image', usd: 0.05, ...verified('fal', fal('easel-ai/advanced-face-swap')) },
  // Face swap on fal's face swap (family face-swap, LC1 ruling (b)): fal's pricing API, `unit_price` 0.001,
  // `unit` images (re-read 2026-10-01; first read 2026-09-26). The app is hidden from fal's gallery, so its
  // page and llms.txt give no price. One picture a call. The live check (rerun `faceswap-fal`) is owed.
  'fal-ai/face-swap': { unit: 'per_image', usd: 0.001, service: 'fal', source: 'https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai/face-swap', read: '2026-10-01', confidence: 'verified' },
  // ── Restyle with a style LoRA (RestyleWithLoRANode, ComfyUI path) ───────
  // Moondream 2, billed by GPU time (L40S, $0.000975/s): "costs approximately
  // $0.0010 to run" (read 2026-09-28; was $0.0020 on 2026-09-24). The owed live
  // check (2026-10-01) measured 1.26 s = $0.00123 (Describe an image) and 1.04 s
  // = $0.00101 (Restyle's first call), above the $0.001 card (money-rule break
  // #4): raised to $0.0025 (2.56 s, about 2× measured). MEASURED 2026-10-01: the
  // ceiling is above it, so verified. The node captions once and classifies up
  // to four times; each call is 1 credit either way (the minimum).
  'lucataco/moondream2': { unit: 'per_image', usd: 0.0025, ...verified('replicate', rep('lucataco/moondream2')), read: '2026-10-01' },
  // "$0.032 per output image" — but the node runs the user's own trained
  // model instead when the LoRA has one (billed by GPU time; the LoRA
  // category's observed median is ~$0.04, priceBook.ts LORA_RENDER_CREDITS),
  // and the price can't see which. So the dearer $0.04. MEASURED 2026-10-01
  // (owed live checks, tier 1): public link $0.032 a picture, trained model 7.7 s
  // of H100 = $0.012; the $0.04 is above both, so verified.
  'black-forest-labs/flux-dev-lora': { unit: 'per_image', usd: 0.04, ...verified('replicate', rep('black-forest-labs/flux-dev-lora')), read: '2026-10-01' },
  // Billed by GPU time (L40S, $0.000975/s; page re-read 2026-10-02: "approximately $0.021 to run",
  // "typically complete within 22 seconds", "varies significantly based on the inputs"). LC4 (USER go
  // 2026-10-02): the $0.10 floor (42× the measured bill) is gone; a GPU-time ceiling from the settings sent.
  // A diffusers img2img of the whole picture at its own size ("original"), so its attention grows with the
  // square of the picture. MEASURED three times (predict_time; queue and cold start are not billed):
  //  - 2026-10-02 (owed rerun enhance-refine): 512² (0.262 MP), 20 steps, creativity 0.33: 2.46 s ($0.0024);
  //  - 2026-10-02 (LC4 calibration, cxenmsh6rdrmw0d0zqzrq26wbc): 1024² (1.05 MP), 50 steps, detail strength 1
  //    (creativity 0.6, the most Enhance sends): 4.70 s ($0.0046);
  //  - 2026-10-02 (LC4 calibration, 7mnnc321kdrmt0d0zsjvem56zw): 2048² (4.19 MP), 50 steps, creativity 0.6:
  //    24.38 s ($0.0238). 4× the area cost 5.2× the time (about area^1.19 without the start; a power fit with
  //    the start gives area^1.62).
  // Fitted exactly through the three: start + steps × (a × MP + b × MP²), steps as sent: 2.30 s, a 0.0260 s,
  // b 0.0189 s; steps as denoised (× creativity), taken at creativity 0.6: 2.38 s, a 0.0241 s, b 0.0193 s.
  // The worse of each (2.38 s, 0.0260 s, 0.0193 s), at 2×: $0.0047 a call + $0.000051 a megapixel a step +
  // $0.000038 a square megapixel a step. Held at 2.09×, 2.07× and 2.05× the three bills. A linear + squared
  // term (both found positive), not a single power: the attention term is at most quadratic, so the price
  // extrapolated to the 18.9 MP cap stays a bound as the squared term takes over (a power fitted at 1.62
  // would fall under the fit's own squared growth past 4 MP). Steps 10–50 on the node (validated); a wired
  // one 100. Verified to 4.19 MP; above it extrapolated on the squared term.
  'fermatresearch/magic-image-refiner': {
    unit: 'per_megapixel_step', startUsd: 0.0047, perMegapixelStep: 0.000051, perSquareMegapixelStep: 0.000038, maxSteps: 100,
    note: 'L40S at $0.000975/s; measured 2.46 s (512², 20 steps, creativity 0.33), 4.70 s (1024², 50 steps, creativity 0.6, cxenmsh6rdrmw0d0zqzrq26wbc) and 24.38 s (2048², 50 steps, creativity 0.6, 7mnnc321kdrmt0d0zsjvem56zw), all 2026-10-02; fit ≤ 2.38 s + steps × (0.0260 s × MP + 0.0193 s × MP²); ceiling 2× each',
    ...verified('replicate', rep('fermatresearch/magic-image-refiner')), read: '2026-10-02',
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
    case 'per_megapixel_step': {
      const px = call.outputPixels
      // The picture made is always known to the builders (editSettings.ts); unknown, unpriced (refused).
      if (typeof px !== 'number' || !Number.isFinite(px) || px <= 0) return null
      const sent = call.steps
      const steps = typeof sent === 'number' && Number.isFinite(sent) && sent > 0 ? Math.min(sent, rate.maxSteps) : rate.maxSteps
      const mp = px / 1e6
      return tidy(rate.startUsd + steps * (rate.perMegapixelStep * mp + (rate.perSquareMegapixelStep ?? 0) * mp * mp))
    }
    case 'per_run_megapixels':
      return tidy(rate.perRun + rate.perInputMegapixel * megapixelsOf(call.inputPixels ?? 0) + rate.perOutputMegapixel * megapixelsOf(call.outputPixels ?? 0))
    case 'per_megapixel':
      return tidy(rate.perMegapixel * Math.max(1, megapixelsOf(call.outputPixels ?? 0)))
    case 'per_input_megapixel': {
      const sent = call.inputPixels
      const px = typeof sent === 'number' && Number.isFinite(sent) && sent > 0 ? Math.min(sent, rate.maxInputPixels) : rate.maxInputPixels
      return tidy(Math.max(rate.minUsd, rate.perMegapixel * px / 1e6))
    }
  }
}

/** A call a node makes `times` times in one run (a pipeline of several calls). */
export interface EditStep { call: EditCall, times: number }

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
