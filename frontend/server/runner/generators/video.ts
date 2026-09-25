/**
 * The runner's video models. Builders began as ports of
 * comfy_api_nodes/video_models.py (the fal-provider entries,
 * tests/unit/runner-video-models.unit.spec.ts, and the Replicate-provider
 * ones, family `replicate-video`, tests/unit/runner-replicate-video.unit.spec.ts).
 * Since Task S1b they follow each provider's published schema instead
 * (tests/unit/runner-provider-schemas.unit.spec.ts): where Python sends a
 * field the schema doesn't define, or a value outside it, the runner sends
 * the schema's field and a value inside it. Every such difference is named
 * in the builder below; the Python path is legacy and unchanged.
 */
import { RUNNER_REPLICATE_VIDEO_MODEL_IDS, RUNNER_VIDEO_MODEL_IDS } from '#shared/runner/eligibility'
import { arOr, maybeSetSeed, optBool, optEnum, optFloatIn, optIntIn, optStr, pyTruthy } from './opts'
import type { ReplicateVideoModelDesc, VideoBuildArgs, VideoModelDesc } from './types'

/** video_models._dur_or: the value if supported, else the closest (first on a tie). */
export function durOr(allowed: number[], d: number, fallback: number): number {
  if (allowed.includes(d)) return d
  if (!allowed.length) return fallback
  let best = allowed[0]!
  for (const a of allowed) if (Math.abs(a - d) < Math.abs(best - d)) best = a
  return best
}

const VEO_AR = new Set(['16:9', '9:16'])
const FLUX3_AR = new Set(['16:9', '9:16', '1:1'])
const SEEDANCE_AR = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
const H3_AR = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'])
/** minimax/h3 and h3-max resolutions (their schemas spell them upper-case); anything else 768P. */
const H3_RES: Record<string, string> = { '480p': '480P', '768p': '768P', '2k': '2K', '4k': '4K' }
const H3_MAX_RES: Record<string, string> = { '480p': '480P', '768p': '768P', '1080p': '1080P' }
/** fal-ai/veo3.1 (and /fast): 720p, 1080p or 4k. blackforestlabs/flux-3: 720p or 1080p. bytedance/seedance-2.0: 480p to 4k. */
export const VEO_RESOLUTIONS = ['720p', '1080p', '4k']
export const FLUX3_RESOLUTIONS = ['720p', '1080p']
export const SEEDANCE_RESOLUTIONS = ['480p', '720p', '1080p', '4k']
/** bytedance/seedance-2.0 `duration`: "4" … "15" (its schema; Python's list skips 14). */
export const SEEDANCE_SECONDS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
const H3_PEM_BASE = new Set(['disabled', 'fast', 'balanced', 'quality'])
const H3_PEM_MAX = new Set(['disabled', 'balanced', 'quality'])

function veo31({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    duration: `${durOr([4, 6, 8], duration, 8)}s`,
    resolution: lowerEnum(adv, 'resolution', VEO_RESOLUTIONS, '720p'),
    generate_audio: optBool(adv, 'generate_audio', true),
    auto_fix: optBool(adv, 'enhance_prompt', true),
  }
  const neg = optStr(adv, 'negative_prompt', '')
  if (neg) inp.negative_prompt = neg
  if (image) inp.image_url = image
  else inp.aspect_ratio = arOr(VEO_AR, aspectRatio, '16:9')
  maybeSetSeed(inp, seed)
  return inp
}

// blackforestlabs/flux-3: no seed on text-to-video or image-to-video (Python sends one).
function flux3({ prompt, aspectRatio, duration, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    duration: durOr([5, 10, 15, 20], duration, 10),
    resolution: lowerEnum(adv, 'resolution', FLUX3_RESOLUTIONS, '720p'),
    generate_audio: optBool(adv, 'generate_audio', true),
  }
  if (image) inp.image_url = image
  else inp.aspect_ratio = arOr(FLUX3_AR, aspectRatio, '16:9')
  return inp
}

function seedance20({ prompt, aspectRatio, duration, image, adv }: VideoBuildArgs) {
  // No seed input on fal's Seedance 2.0.
  const inp: Record<string, unknown> = {
    prompt,
    duration: String(durOr(SEEDANCE_SECONDS, duration, 5)),
    resolution: lowerEnum(adv, 'resolution', SEEDANCE_RESOLUTIONS, '720p'),
  }
  if (Object.prototype.hasOwnProperty.call(adv, 'generate_audio')) inp.generate_audio = pyTruthy(adv.generate_audio)
  const first = image || optStr(adv, 'image_url', '')
  if (first) {
    inp.image_url = first
    const last = optStr(adv, 'end_image_url', '')
    if (last) inp.end_image_url = last
  }
  else {
    inp.aspect_ratio = arOr(SEEDANCE_AR, aspectRatio, '16:9')
    for (const key of ['image_urls', 'video_urls', 'audio_urls']) {
      const vals = adv[key]
      if (Array.isArray(vals) && vals.length) inp[key] = vals
    }
  }
  return inp
}

function hailuoH3Core(a: VideoBuildArgs, pemAllowed: ReadonlySet<string>, resolutions: Record<string, string>) {
  const { prompt, aspectRatio, duration, seed, image, adv } = a
  const pem = optStr(adv, 'prompt_expansion_mode', 'balanced')
  const res = optStr(adv, 'resolution', '768p').toLowerCase()
  const inp: Record<string, unknown> = {
    prompt,
    duration: durOr([5, 6, 10], duration, 5),
    resolution: Object.prototype.hasOwnProperty.call(resolutions, res) ? resolutions[res]! : '768P',
    prompt_expansion_mode: pemAllowed.has(pem) ? pem : 'balanced',
  }
  const first = image || optStr(adv, 'image_url', '')
  if (first) {
    inp.image_url = first
    const last = optStr(adv, 'end_image_url', '')
    if (last) inp.end_image_url = last
  }
  else {
    inp.aspect_ratio = arOr(H3_AR, aspectRatio, '16:9')
  }
  maybeSetSeed(inp, seed)
  return inp
}

export const RUNNER_VIDEO_MODELS: Record<string, VideoModelDesc> = {
  'veo-3.1': { id: 'veo-3.1', label: 'Veo 3.1', app: 'fal-ai/veo3.1', defaultDuration: 8, fnByMode: { t2v: '', firstLast: 'image-to-video', reference: 'image-to-video' }, build: veo31 },
  'veo-3.1-fast': { id: 'veo-3.1-fast', label: 'Veo 3.1 Fast', app: 'fal-ai/veo3.1/fast', defaultDuration: 8, fnByMode: { t2v: '', firstLast: 'image-to-video', reference: 'image-to-video' }, build: veo31 },
  'flux-3': { id: 'flux-3', label: 'FLUX 3', app: 'blackforestlabs/flux-3', defaultDuration: 10, fnByMode: { t2v: 'text-to-video', firstLast: 'image-to-video', reference: 'image-to-video' }, build: flux3 },
  'seedance-2.0': { id: 'seedance-2.0', label: 'Seedance 2.0', app: 'bytedance/seedance-2.0', defaultDuration: 5, fnByMode: { t2v: 'text-to-video', firstLast: 'image-to-video', reference: 'reference-to-video' }, build: seedance20 },
  'hailuo-h3': { id: 'hailuo-h3', label: 'Hailuo H3', app: 'minimax/h3', defaultDuration: 5, fnByMode: { t2v: 'text-to-video', firstLast: 'image-to-video', reference: 'reference-to-video' }, build: a => hailuoH3Core(a, H3_PEM_BASE, H3_RES) },
  'hailuo-h3-max': { id: 'hailuo-h3-max', label: 'Hailuo H3 Max', app: 'minimax/h3-max', defaultDuration: 5, fnByMode: { t2v: 'text-to-video', firstLast: 'image-to-video' }, build: a => hailuoH3Core(a, H3_PEM_MAX, H3_MAX_RES) },
}

for (const id of RUNNER_VIDEO_MODEL_IDS) {
  if (!RUNNER_VIDEO_MODELS[id]) throw new Error(`runner video model ${id} has no description`)
}

// ── Replicate (video_models.py provider="replicate") ──────────────────────
// Aspect-ratio sets, verbatim (video_models.py:134–144; _SEEDANCE_AR is shared with the fal Seedance above).
const RUNWAY_AR = new Set(['16:9', '9:16', '1:1', '4:3', '3:4'])
const KLING_AR = new Set(['16:9', '9:16', '1:1'])
const WAN_AR = new Set(['16:9', '9:16', '1:1'])
const LUMA_AR = new Set(['16:9', '9:16', '1:1', '4:3', '3:4'])
const LTX_AR = new Set(['16:9', '9:16', '1:1'])
const PIXVERSE_AR = new Set(['16:9', '9:16', '1:1'])

/** A resolution option, lower-cased ("720P" is 720p), kept only when the schema lists it; otherwise `def`. */
function lowerEnum(adv: Record<string, unknown>, key: string, allowed: readonly string[], def: string): string {
  return optEnum({ [key]: optStr(adv, key, def).toLowerCase() }, key, allowed, def)
}

/** Python's `if neg := _opt_str(adv, "negative_prompt", ""): inp["negative_prompt"] = neg`. */
function setNegative(inp: Record<string, unknown>, adv: Record<string, unknown>): void {
  const neg = optStr(adv, 'negative_prompt', '')
  if (neg) inp.negative_prompt = neg
}

/**
 * openai/sora-2 and sora-2-pro take `seconds` (4, 8 or 12) and an
 * orientation ("portrait" / "landscape"), and no seed. Python sends
 * `duration` 5/10, the ratio and a seed, none of which the schema has.
 * 9:16 is portrait; 16:9, 1:1 and anything else landscape (no square).
 */
export const SORA_SECONDS = [4, 8, 12]
function soraInput({ prompt, aspectRatio, duration }: VideoBuildArgs) {
  return { prompt, aspect_ratio: aspectRatio === '9:16' ? 'portrait' : 'landscape', seconds: durOr(SORA_SECONDS, duration, 4) }
}

// _b_sora_2 (:214): text-to-video only; a first frame is ignored.
function sora2(a: VideoBuildArgs) {
  return soraInput(a)
}

// _b_sora_2_pro (:225): `resolution` is left at its "standard" (720p) default, as Python leaves it.
function sora2Pro(a: VideoBuildArgs) {
  return soraInput(a)
}

// _b_runway_gen_4_5 (:237). runwayml/gen-4.5 has no `motion` (Python sends one).
function runwayGen45({ prompt, aspectRatio, duration, seed, image }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(RUNWAY_AR, aspectRatio, '16:9'),
    duration: durOr([5, 10], duration, 5),
  }
  if (image) inp.image = image
  maybeSetSeed(inp, seed)
  return inp
}

// _b_kling_v3 (:252). kwaivgi/kling-v3-video has no `cfg_scale` and no seed (Python sends both).
function klingV3({ prompt, aspectRatio, duration, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(KLING_AR, aspectRatio, '16:9'),
    duration: durOr([5, 10, 15], duration, 5),
    generate_audio: optBool(adv, 'generate_audio', true),
  }
  setNegative(inp, adv)
  if (image) inp.start_image = image
  return inp
}

// _b_kling_v2_5_turbo_pro (:268): no cfg_scale and no seed (the model answers 422 to either).
function klingV25TurboPro({ prompt, aspectRatio, duration, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(KLING_AR, aspectRatio, '16:9'),
    duration: durOr([5, 10], duration, 5),
  }
  setNegative(inp, adv)
  if (image) inp.start_image = image
  return inp
}

/**
 * bytedance/seedance-2.0-fast renders 480p or 720p; 720p is its top option,
 * so 1080p (or anything else) is sent as 720p. It has no `camera_fixed`
 * (Python sends one).
 */
export const SEEDANCE_FAST_RESOLUTIONS = ['480p', '720p']
// _b_seedance_2_0_fast (:313): the aspect ratio only without a first frame.
function seedance20Fast({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    duration: durOr([3, 5, 10], duration, 5),
    resolution: lowerEnum(adv, 'resolution', SEEDANCE_FAST_RESOLUTIONS, '720p'),
  }
  if (image) inp.image = image
  else inp.aspect_ratio = arOr(SEEDANCE_AR, aspectRatio, '16:9')
  maybeSetSeed(inp, seed)
  return inp
}

/** minimax/hailuo-2.3 renders 768p or 1080p; anything else is sent as 768p. */
export const HAILUO_23_RESOLUTIONS = ['768p', '1080p']
// _b_hailuo_2_3 (:330). minimax/hailuo-2.3 has no `aspect_ratio` and no seed (Python sends both).
function hailuo23({ prompt, duration, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    duration: durOr([6, 10], duration, 6),
    resolution: lowerEnum(adv, 'resolution', HAILUO_23_RESOLUTIONS, '768p'),
    prompt_optimizer: optBool(adv, 'prompt_optimizer', true),
  }
  if (image) inp.first_frame_image = image
  return inp
}

/** wan-video/wan-2.7-t2v and wan-2.5-i2v-fast render 720p or 1080p; anything else (480p) is sent as 720p. */
export const WAN_RESOLUTIONS = ['720p', '1080p']
/** wan-video/wan-2.7-t2v: `duration` is any whole second from 2 to 15. */
export const WAN_27_SECONDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
/** wan-video/wan-2.5-i2v-fast: `duration` is 5 or 10. */
export const WAN_25_SECONDS = [5, 10]

// _b_wan_2_7_t2v (:402): text-to-video only. The clip length is `duration`
// (Python sends `num_frames`, which the schema doesn't have, so its clip is
// always the 5 s default).
function wan27T2v({ prompt, aspectRatio, duration, seed, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(WAN_AR, aspectRatio, '16:9'),
    resolution: lowerEnum(adv, 'resolution', WAN_RESOLUTIONS, '720p'),
    duration: durOr(WAN_27_SECONDS, duration, 5),
  }
  setNegative(inp, adv)
  maybeSetSeed(inp, seed)
  return inp
}

// _b_wan_2_5_i2v_fast (:415): a first frame is required. The schema has no
// `aspect_ratio` (the picture sets it) and takes `duration`; Python's default
// 480p is outside its 720p/1080p, so the default is 720p.
function wan25I2vFast({ prompt, duration, seed, image, adv }: VideoBuildArgs) {
  if (!image) throw new Error('Wan 2.5 I2V Fast requires an input image.')
  const inp: Record<string, unknown> = {
    prompt,
    image,
    resolution: lowerEnum(adv, 'resolution', WAN_RESOLUTIONS, '720p'),
    duration: durOr(WAN_25_SECONDS, duration, 5),
  }
  setNegative(inp, adv)
  maybeSetSeed(inp, seed)
  return inp
}

// _b_luma_ray_2_720p (:432): Luma takes the first frame as start_image_url. No seed on luma/ray-2-720p (Python sends one).
function lumaRay2720p({ prompt, aspectRatio, duration, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(LUMA_AR, aspectRatio, '16:9'),
    duration: durOr([5, 9], duration, 5),
    loop: optBool(adv, 'loop', false),
  }
  if (image) inp.start_image_url = image
  return inp
}

/**
 * lightricks/ltx-video names its guidance `cfg` (1–20) and its step count
 * `steps` (1–50); Python sends them as `guidance_scale` and
 * `num_inference_steps`, which the schema doesn't have. The node's options
 * keep Python's names; the price reads the steps (videoSettings.ts).
 */
export const LTX_STEPS = { def: 30, min: 1, max: 50 }
// _b_ltx_video (:448): the image before the negative prompt, as in Python (key order).
function ltxVideo({ prompt, aspectRatio, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(LTX_AR, aspectRatio, '16:9'),
    cfg: optFloatIn(adv, 'guidance_scale', 3.0, 1, 20),
    steps: optIntIn(adv, 'num_inference_steps', LTX_STEPS.def, LTX_STEPS.min, LTX_STEPS.max),
  }
  if (image) inp.image = image
  setNegative(inp, adv)
  maybeSetSeed(inp, seed)
  return inp
}

/**
 * pixverse/pixverse-v6 renders `quality` (360p–1080p) and makes sound when
 * `generate_audio_switch` is on. Python sends the node's `resolution` and
 * `generate_audio` under those names, and a `style`, none of which the
 * schema has, so its clip is always 540p and silent. The node's options keep
 * their names; an unknown resolution is sent as the 720p default.
 */
export const PIXVERSE_QUALITIES = ['360p', '540p', '720p', '1080p']
// _b_pixverse_v6 (:482)
function pixverseV6({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(PIXVERSE_AR, aspectRatio, '16:9'),
    duration: durOr([5, 8], duration, 5),
    quality: lowerEnum(adv, 'resolution', PIXVERSE_QUALITIES, '720p'),
    generate_audio_switch: optBool(adv, 'generate_audio', true),
  }
  setNegative(inp, adv)
  if (image) inp.image = image
  maybeSetSeed(inp, seed)
  return inp
}

const BOTH = ['t2v', 'i2v'] as const
/** video_models.py MODELS, the Replicate entries the runner takes (every one but fabric-1.0, which needs sound). */
export const RUNNER_REPLICATE_VIDEO_MODELS: Record<string, ReplicateVideoModelDesc> = {
  'sora-2': { id: 'sora-2', label: 'Sora 2', slug: 'openai/sora-2', defaultDuration: 5, modes: ['t2v'], build: sora2 },
  'sora-2-pro': { id: 'sora-2-pro', label: 'Sora 2 Pro', slug: 'openai/sora-2-pro', defaultDuration: 5, modes: ['t2v'], build: sora2Pro },
  'runway-gen-4.5': { id: 'runway-gen-4.5', label: 'Runway Gen-4.5', slug: 'runwayml/gen-4.5', defaultDuration: 5, modes: BOTH, build: runwayGen45 },
  'kling-v3': { id: 'kling-v3', label: 'Kling Video 3.0', slug: 'kwaivgi/kling-v3-video', defaultDuration: 5, modes: BOTH, build: klingV3 },
  'kling-v2.5-turbo-pro': { id: 'kling-v2.5-turbo-pro', label: 'Kling v2.5 Turbo Pro', slug: 'kwaivgi/kling-v2.5-turbo-pro', defaultDuration: 5, modes: BOTH, build: klingV25TurboPro },
  'seedance-2.0-fast': { id: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast', slug: 'bytedance/seedance-2.0-fast', defaultDuration: 5, modes: BOTH, build: seedance20Fast },
  'hailuo-2.3': { id: 'hailuo-2.3', label: 'Hailuo 2.3', slug: 'minimax/hailuo-2.3', defaultDuration: 6, modes: BOTH, build: hailuo23 },
  'wan-2.7-t2v': { id: 'wan-2.7-t2v', label: 'Wan 2.7 T2V', slug: 'wan-video/wan-2.7-t2v', defaultDuration: 5, modes: ['t2v'], build: wan27T2v },
  'wan-2.5-i2v-fast': { id: 'wan-2.5-i2v-fast', label: 'Wan 2.5 I2V Fast', slug: 'wan-video/wan-2.5-i2v-fast', defaultDuration: 5, modes: ['i2v'], build: wan25I2vFast },
  'luma-ray-2-720p': { id: 'luma-ray-2-720p', label: 'Luma Ray 2 (720p)', slug: 'luma/ray-2-720p', defaultDuration: 5, modes: BOTH, build: lumaRay2720p },
  'ltx-video': { id: 'ltx-video', label: 'LTX-Video', slug: 'lightricks/ltx-video', defaultDuration: 5, modes: BOTH, build: ltxVideo },
  'pixverse-v6': { id: 'pixverse-v6', label: 'PixVerse v6', slug: 'pixverse/pixverse-v6', defaultDuration: 5, modes: BOTH, build: pixverseV6 },
}

for (const id of RUNNER_REPLICATE_VIDEO_MODEL_IDS) {
  if (!RUNNER_REPLICATE_VIDEO_MODELS[id]) throw new Error(`runner Replicate video model ${id} has no description`)
}
if (Object.keys(RUNNER_REPLICATE_VIDEO_MODELS).length !== RUNNER_REPLICATE_VIDEO_MODEL_IDS.length) {
  throw new Error('runner Replicate video models and their id list disagree')
}

/** nodes_replicate._fal_fn_for_input. */
export function falVideoFn(payload: Record<string, unknown>, fnByMode: VideoModelDesc['fnByMode']): string {
  if (payload.image_url) return fnByMode.firstLast
  const hasRefs = ['image_urls', 'video_urls', 'audio_urls'].some(k => Array.isArray(payload[k]) && (payload[k] as unknown[]).length > 0)
  if (hasRefs) {
    if (fnByMode.reference === undefined) throw new Error('This video model cannot take reference clips or pictures')
    return fnByMode.reference
  }
  return fnByMode.t2v
}
