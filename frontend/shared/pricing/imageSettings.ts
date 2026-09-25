/**
 * The settings an image model's request actually carries that its service
 * bills by — how many pictures, the size or quality tier, the output
 * megapixels, and Nano Banana's paid web search — read from a node's
 * widgets exactly as that model's request builder reads them.
 *
 * The price multiplies a rate by these (imageRates.ts), so it must never
 * read a setting the builder would send differently ("priced on what is
 * sent"). The builders are server/runner/generators/image.ts (fal and
 * Replicate) and, for the models the runner does not build (the Recraft SVG
 * models, Krea 2), comfy_api_nodes/image_models.py. The settings-parity test
 * (tests/unit/image-pricing.unit.spec.ts) runs every runner builder over
 * every setting and checks it sends what this module says.
 *
 * Pure: no server imports, so the badge, the run estimate and the charge all
 * load it. Relative imports only.
 */
import { pyIntOf, pyTruthy } from '../runner/pyText'
import { readModelOptions } from './videoSettings'

export interface ImageSettings {
  /** Pictures the request asks for (every service here bills per output picture). */
  images: number
  /** The priced tier the request carries: a resolution ('1K', '2K'…) or a quality ('high', 'auto'), else null. */
  tier: string | null
  /**
   * Billed megapixels of one picture, for the per-megapixel models; else null.
   * Neither fal nor Replicate says how it rounds, so (controller ruling) a
   * picture is counted as its pixels / 1,000,000 ROUNDED UP to a whole
   * megapixel: 1024 × 1024 is 2 MP, 1024 × 576 is 1 MP.
   */
  megapixels: number | null
  /** Nano Banana 2's web search (a flat extra per request on fal). */
  webSearch: boolean
}

type Adv = Record<string, unknown>

const has = (adv: Adv, key: string) => Object.prototype.hasOwnProperty.call(adv, key)

// Ports of the readers in server/runner/generators/opts.ts (Python's _opt_str,
// _opt_int, _opt_bool). Kept here because shared code must not import the
// server; the settings-parity test holds the two to the same answers.
function optStr(adv: Adv, key: string, def: string): string {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (v === null || v === undefined) return def
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}
function optInt(adv: Adv, key: string, def: number): number {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : def
  if (typeof v !== 'string') return def
  return pyIntOf(v) ?? def
}
function optBool(adv: Adv, key: string, def: boolean): boolean {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['true', '1', 'yes', 'on'].includes(v.toLowerCase())
  return pyTruthy(v)
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/**
 * fal's named sizes, in pixels (fal's ImageSize enum), and the aspect ratio
 * → name map the fal builders use (image.ts FAL_IMAGE_SIZE_BY_AR; anything
 * else is square_hd).
 */
const FAL_SIZE_PIXELS: Record<string, number> = {
  square_hd: 1024 * 1024,
  landscape_4_3: 1024 * 768,
  portrait_4_3: 768 * 1024,
  landscape_16_9: 1024 * 576,
  portrait_16_9: 576 * 1024,
}
const FAL_IMAGE_SIZE_BY_AR: Record<string, string> = {
  '1:1': 'square_hd',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '3:2': 'landscape_4_3',
  '5:4': 'landscape_4_3',
  '16:10': 'landscape_16_9',
  '21:9': 'landscape_16_9',
  '2:1': 'landscape_16_9',
  '2:3': 'portrait_4_3',
  '4:5': 'portrait_4_3',
  '10:16': 'portrait_16_9',
  '9:21': 'portrait_16_9',
  '1:2': 'portrait_16_9',
}
/** The fal size name the builder sends for this aspect ratio. */
export function falSizeFor(aspectRatio: string): string {
  return Object.prototype.hasOwnProperty.call(FAL_IMAGE_SIZE_BY_AR, aspectRatio) ? FAL_IMAGE_SIZE_BY_AR[aspectRatio]! : 'square_hd'
}
/** Pixels / 1,000,000, rounded up to a whole megapixel (the ruling above). */
export function billedMegapixels(pixels: number): number {
  return Math.ceil(pixels / 1_000_000)
}

/** Billed megapixels of a fal named size. */
export function falSizeMegapixels(name: string): number {
  return billedMegapixels(FAL_SIZE_PIXELS[name] ?? FAL_SIZE_PIXELS.square_hd!)
}

/**
 * Black Forest Labs' megapixel labels ("1 MP", "4"): one label MP is 1024 ×
 * 1024 pixels (a 1:1 "1 MP" picture is 1024 × 1024; other ratios keep about
 * the same area), capped at 2048 × 2048, the largest picture the service
 * makes. The cap applies to the pixels, then the count is rounded up: "1 MP"
 * is 2 billed MP, "4 MP" is 2048² = 4,194,304 pixels, 5 billed MP. A ratio
 * the model doesn't take (21:9 on Flux 2) is sent as 1:1, so "1 MP" there is
 * 2 MP too. The builders send a label the service doesn't list as their
 * default ("1 MP", "1"), and the price reads it the same way (Task S1b).
 */
const BFL_LABEL_PIXELS = 1024 * 1024
const BFL_CAP_PIXELS = 2048 * 2048
function bflMegapixels(label: string, allowed: readonly string[], def: string): number {
  const n = Number.parseFloat(allowed.includes(label) ? label : def)
  return billedMegapixels(Math.min(n * BFL_LABEL_PIXELS, BFL_CAP_PIXELS))
}
export const FLUX_2_RESOLUTIONS: readonly string[] = ['0.5 MP', '1 MP', '2 MP', '4 MP']
export const FLUX_KLEIN_MEGAPIXELS: readonly string[] = ['0.25', '0.5', '1', '2', '4']

/**
 * black-forest-labs/flux-2-dev is sized by `width` × `height` (aspect_ratio
 * "custom"): each a multiple of 32 from 256 to 1440 (its saved schema, read
 * 2026-09-24). The runner's builder (image.ts rFlux2Dev) sends the node's
 * resolution label as that many BFL megapixels at the node's ratio, scaled
 * down so neither side passes 1440, each side rounded to a multiple of 32.
 * A ratio Flux 2 doesn't take is 1:1. The price reads the same pixels.
 */
const FLUX_2_DEV_RATIOS = ['1:1', '16:9', '3:2', '2:3', '4:5', '5:4', '9:16', '3:4', '4:3']
const FLUX_2_DEV_MAX_SIDE = 1440
export function flux2DevSize(label: string, aspectRatio: string): { width: number, height: number } {
  const mp = FLUX_2_RESOLUTIONS.includes(label) ? Number.parseFloat(label) : 1
  const [a, b] = (FLUX_2_DEV_RATIOS.includes(aspectRatio) ? aspectRatio : '1:1').split(':').map(Number) as [number, number]
  const pixels = mp * BFL_LABEL_PIXELS
  let w = Math.sqrt(pixels * a / b)
  let h = Math.sqrt(pixels * b / a)
  const scale = Math.min(1, FLUX_2_DEV_MAX_SIDE / Math.max(w, h))
  w *= scale
  h *= scale
  const snap = (x: number) => Math.max(256, Math.min(FLUX_2_DEV_MAX_SIDE, Math.round(x / 32) * 32))
  return { width: snap(w), height: snap(h) }
}
/**
 * The ComfyUI (Python) path still sends Flux 2 Dev a `resolution` label, which
 * the schema doesn't have, and no width × height, so the service makes its own
 * default size. Neither the saved schema nor its page states that size, so
 * (controller ruling, S1b fix round 1) it is taken as 2 billed MP, and the
 * price never goes below it while that path is live.
 */
export const FLUX_2_DEV_PYTHON_PATH_MEGAPIXELS = 2
/** Billed megapixels of the largest Flux 2 Dev picture (1440 × 1440): 3. */
export const FLUX_2_DEV_MAX_MEGAPIXELS = billedMegapixels(FLUX_2_DEV_MAX_SIDE * FLUX_2_DEV_MAX_SIDE)

type Rule = (adv: Adv, aspectRatio: string) => ImageSettings

const GPT_QUALITIES = ['low', 'medium', 'high', 'auto']
const gptQuality = (adv: Adv) => {
  const q = optStr(adv, 'quality', 'auto')
  return GPT_QUALITIES.includes(q) ? q : 'auto'
}

/** GPT Image 2.5 (gptImage25.ts): low / medium / high, anything else "high". The version and size don't move fal's card. */
const GPT_25_QUALITIES = ['low', 'medium', 'high']
const gpt25Quality = (adv: Adv) => {
  const q = optStr(adv, 'quality', 'high')
  return GPT_25_QUALITIES.includes(q) ? q : 'high'
}

const one = (tier: string | null = null): ImageSettings => ({ images: 1, tier, megapixels: null, webSearch: false })
const flat: Rule = () => one()

/**
 * One rule per priced image model id, mirroring its builder (the name in each
 * comment is the builder function in image.ts, or the Python builder).
 */
const RULES: Record<string, Rule> = {
  // ── fal (RUNNER_IMAGE_MODELS) ──
  // fluxProV11: image_size from the ratio, one picture.
  'flux-1.1-pro': (_adv, ar) => ({ ...one(), megapixels: falSizeMegapixels(falSizeFor(ar)) }),
  // fluxSchnell: image_size from the ratio, num_images = num_outputs clamped 1–4.
  'flux-schnell': (adv, ar) => ({
    ...one(), images: clamp(optInt(adv, 'num_outputs', 1), 1, 4), megapixels: falSizeMegapixels(falSizeFor(ar)),
  }),
  // nanoBananaPro: resolution 1K/2K/4K, anything else 2K. No web search sent.
  'nano-banana-pro': (adv) => {
    const r = optStr(adv, 'resolution', '2K')
    return one(['1K', '2K', '4K'].includes(r) ? r : '2K')
  },
  // nanoBanana2: resolution 0.5K/1K/2K/4K, anything else 1K; enable_web_search
  // from google_search. (The edit endpoint, used when moodboard pictures ride
  // along, gets no web search; the price can't see the pictures, so it counts
  // the search whenever it is switched on: never under.)
  'nano-banana-2': (adv) => {
    const r = optStr(adv, 'resolution', '1K')
    return { ...one(['0.5K', '1K', '2K', '4K'].includes(r) ? r : '1K'), webSearch: optBool(adv, 'google_search', false) }
  },
  // ideogramV3: the speed is the model id; one picture.
  'ideogram-v3-quality': flat,
  'ideogram-v3-balanced': flat,
  'ideogram-v3-turbo': flat,
  // seedream5Lite: max_images 1, or 1–6 when sequential_image_generation is "auto".
  // The ComfyUI path falls over to Replicate (_b_seedream_5_lite), which
  // clamps max_images to 1–15, not fal's 1–6: the price covers the larger.
  'seedream-5-lite': adv => ({
    ...one(),
    images: optStr(adv, 'sequential_image_generation', 'disabled') === 'auto' ? clamp(optInt(adv, 'max_images', 1), 1, 15) : 1,
  }),
  'seedream-4': flat,

  // ── Replicate (RUNNER_REPLICATE_IMAGE_MODELS) ──
  'flux-1.1-pro-ultra': flat,
  'flux-pro': flat,
  // rFluxDev: num_outputs clamped 1–4 (billed per output picture; megapixels don't change it).
  'flux-dev': adv => ({ ...one(), images: clamp(optInt(adv, 'num_outputs', 1), 1, 4) }),
  // rFlux2Basic / rFlux2Flex: resolution label, default (and anything unlisted) "1 MP".
  'flux-2-max': adv => ({ ...one(), megapixels: bflMegapixels(optStr(adv, 'resolution', '1 MP'), FLUX_2_RESOLUTIONS, '1 MP') }),
  'flux-2-pro': adv => ({ ...one(), megapixels: bflMegapixels(optStr(adv, 'resolution', '1 MP'), FLUX_2_RESOLUTIONS, '1 MP') }),
  'flux-2-flex': adv => ({ ...one(), megapixels: bflMegapixels(optStr(adv, 'resolution', '1 MP'), FLUX_2_RESOLUTIONS, '1 MP') }),
  // rFlux2Dev: width × height from the label and the ratio (flux2DevSize),
  // never below the ComfyUI path's default size (FLUX_2_DEV_PYTHON_PATH_MEGAPIXELS).
  'flux-2-dev': (adv, ar) => {
    const { width, height } = flux2DevSize(optStr(adv, 'resolution', '1 MP'), ar)
    return { ...one(), megapixels: Math.max(billedMegapixels(width * height), FLUX_2_DEV_PYTHON_PATH_MEGAPIXELS) }
  },
  // rFluxKlein: output_megapixels label, default (and anything unlisted) "1".
  'flux-2-klein-4b': adv => ({ ...one(), megapixels: bflMegapixels(optStr(adv, 'output_megapixels', '1'), FLUX_KLEIN_MEGAPIXELS, '1') }),
  'imagen-4-ultra': flat,
  'imagen-4': flat,
  'imagen-4-fast': flat,
  'imagen-3': flat,
  'imagen-3-fast': flat,
  'ideogram-v2': flat,
  'ideogram-v2a-turbo': flat,
  // rSeedream45 sends size 2K/4K; Replicate charges one price for both.
  'seedream-4.5': flat,
  'seedream-3': flat,
  'recraft-v4-pro': flat,
  'recraft-v4': flat,
  'recraft-v3': flat,
  'stable-diffusion-3.5-large': flat,
  'stable-diffusion-3.5-large-turbo': flat,
  'stable-diffusion-3.5-medium': flat,
  // rGptImage2 / rGptImage15: quality low/medium/high/auto, anything else "auto"; one picture.
  'gpt-image-2': adv => one(gptQuality(adv)),
  'gpt-image-1.5': adv => one(gptQuality(adv)),
  // gptImage25Generate (runner-only, fal first): quality; one picture.
  'gpt-image-2.5': adv => one(gpt25Quality(adv)),
  'qwen-image': flat,
  // qwenImage3Generate (runner-only, Replicate): one picture, one price for every ratio.
  'qwen-image-3': flat,
  'hunyuan-image-3': flat,
  'grok-imagine': flat,
  // grokImagine2Generate (runner-only, Replicate): one picture, one price for every ratio, size and quality.
  'grok-imagine-2': flat,
  'flux-fast': flat,
  'p-image': flat,
  // rWan22Pruna sends megapixels 1/2; Replicate charges one price for both.
  'wan-2.2-image-pruna': flat,
  'bria-fibo': flat,
  'bria-image-3.2': flat,
  'photon': flat,
  'photon-flash': flat,
  'minimax-image-01': flat,

  // ── ComfyUI only (comfy_api_nodes/image_models.py) ──
  // _b_recraft_v4 / _b_recraft_v3_svg: prompt, ratio (and style); one picture.
  'recraft-v4-pro-svg': flat,
  'recraft-v4-svg': flat,
  'recraft-v3-svg': flat,
  // _fal_krea2: prompt, ratio, creativity, seed — no style pictures, so the text-to-image price.
  'krea-2-large': flat,
  'krea-2-medium': flat,
}

/** True when the id has settings rules (every priced image model does; a test pins it). */
export function hasImageSettings(modelId: string): boolean {
  return has(RULES, modelId)
}

/**
 * What the request for `modelId` carries that its price depends on, given
 * the node's `aspect_ratio` widget and `model_options` (JSON text or object),
 * read as the builder reads them (an empty ratio is 1:1, as the executor
 * sends it). Null for an id with no rules.
 */
export function effectiveImageSettings(modelId: string, aspectRatio: unknown, modelOptions: unknown): ImageSettings | null {
  if (!hasImageSettings(modelId)) return null
  const ar = (typeof aspectRatio === 'string' && aspectRatio) || '1:1'
  return RULES[modelId]!(readModelOptions(modelOptions), ar)
}

/**
 * The most pictures a builder can ask for in one request (flux-schnell /
 * flux-dev: num_outputs up to 4; Seedream 5 Lite: max_images up to 15 on its
 * Python Replicate fallover, 6 on fal).
 */
const MAX_IMAGES: Record<string, number> = { 'flux-schnell': 4, 'flux-dev': 4, 'seedream-5-lite': 15 }
export function maxImageCount(modelId: string): number {
  return has(MAX_IMAGES, modelId) ? MAX_IMAGES[modelId]! : 1
}

/**
 * The ratio whose picture is the largest for every model whose size follows
 * the ratio (fal's square_hd, 1024 × 1024). A linked ratio, unknown until the
 * run, is priced at it. A test pins that no ratio prices higher.
 */
export const LARGEST_RATIO = '1:1'

/** Billed megapixels of the largest picture the fal per-megapixel models can be asked for (any ratio): 2. */
export const FAL_MAX_MEGAPIXELS = billedMegapixels(Math.max(...Object.values(FAL_SIZE_PIXELS)))
/** Billed megapixels of the largest picture a BFL label can come back as (2048²): 5. */
export const BFL_MAX_MEGAPIXELS = billedMegapixels(BFL_CAP_PIXELS)
