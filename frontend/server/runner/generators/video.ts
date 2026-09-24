/**
 * The runner's video models. Builders are ports of comfy_api_nodes/video_models.py
 * and must match the Python payloads exactly: the fal-provider entries
 * (tests/unit/runner-video-models.unit.spec.ts) and the Replicate-provider
 * ones, family `replicate-video` (tests/unit/runner-replicate-video.unit.spec.ts).
 */
import { RUNNER_REPLICATE_VIDEO_MODEL_IDS, RUNNER_VIDEO_MODEL_IDS } from '#shared/runner/eligibility'
import { arOr, maybeSetSeed, optBool, optFloat, optInt, optStr, pyTruthy } from './opts'
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
const H3_RES: Record<string, string> = { '480p': '480P', '768p': '768P', '2k': '2K', '4k': '4K' }
const H3_PEM_BASE = new Set(['disabled', 'fast', 'balanced', 'quality'])
const H3_PEM_MAX = new Set(['disabled', 'balanced', 'quality'])

function veo31({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    duration: `${durOr([4, 6, 8], duration, 8)}s`,
    resolution: optStr(adv, 'resolution', '720p'),
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

function flux3({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    duration: durOr([5, 10, 15, 20], duration, 10),
    resolution: optStr(adv, 'resolution', '720p'),
    generate_audio: optBool(adv, 'generate_audio', true),
  }
  if (image) inp.image_url = image
  else inp.aspect_ratio = arOr(FLUX3_AR, aspectRatio, '16:9')
  maybeSetSeed(inp, seed)
  return inp
}

function seedance20({ prompt, aspectRatio, duration, image, adv }: VideoBuildArgs) {
  // No seed input on fal's Seedance 2.0.
  const inp: Record<string, unknown> = {
    prompt,
    duration: String(durOr([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15], duration, 5)),
    resolution: optStr(adv, 'resolution', '720p'),
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

function hailuoH3Core(a: VideoBuildArgs, pemAllowed: ReadonlySet<string>) {
  const { prompt, aspectRatio, duration, seed, image, adv } = a
  const pem = optStr(adv, 'prompt_expansion_mode', 'balanced')
  const inp: Record<string, unknown> = {
    prompt,
    duration: durOr([5, 6, 10], duration, 5),
    resolution: H3_RES[optStr(adv, 'resolution', '768p').toLowerCase()] ?? '768P',
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
  'hailuo-h3': { id: 'hailuo-h3', label: 'Hailuo H3', app: 'minimax/h3', defaultDuration: 5, fnByMode: { t2v: 'text-to-video', firstLast: 'image-to-video', reference: 'reference-to-video' }, build: a => hailuoH3Core(a, H3_PEM_BASE) },
  'hailuo-h3-max': { id: 'hailuo-h3-max', label: 'Hailuo H3 Max', app: 'minimax/h3-max', defaultDuration: 5, fnByMode: { t2v: 'text-to-video', firstLast: 'image-to-video' }, build: a => hailuoH3Core(a, H3_PEM_MAX) },
}

for (const id of RUNNER_VIDEO_MODEL_IDS) {
  if (!RUNNER_VIDEO_MODELS[id]) throw new Error(`runner video model ${id} has no description`)
}

// ── Replicate (video_models.py provider="replicate") ──────────────────────
// Aspect-ratio sets, verbatim (video_models.py:134–144; _SEEDANCE_AR is shared with the fal Seedance above).
const SORA_AR = new Set(['16:9', '9:16', '1:1'])
const SORA_PRO_AR = new Set(['16:9', '9:16'])
const RUNWAY_AR = new Set(['16:9', '9:16', '1:1', '4:3', '3:4'])
const KLING_AR = new Set(['16:9', '9:16', '1:1'])
const HAILUO_AR = new Set(['16:9', '9:16', '1:1'])
const WAN_AR = new Set(['16:9', '9:16', '1:1'])
const LUMA_AR = new Set(['16:9', '9:16', '1:1', '4:3', '3:4'])
const LTX_AR = new Set(['16:9', '9:16', '1:1'])
const PIXVERSE_AR = new Set(['16:9', '9:16', '1:1'])

/** Python's `if neg := _opt_str(adv, "negative_prompt", ""): inp["negative_prompt"] = neg`. */
function setNegative(inp: Record<string, unknown>, adv: Record<string, unknown>): void {
  const neg = optStr(adv, 'negative_prompt', '')
  if (neg) inp.negative_prompt = neg
}

// _b_sora_2 (:214): text-to-video only; a first frame is ignored.
function sora2({ prompt, aspectRatio, duration, seed }: VideoBuildArgs) {
  const inp: Record<string, unknown> = { prompt, aspect_ratio: arOr(SORA_AR, aspectRatio, '16:9'), duration: durOr([5, 10], duration, 5) }
  maybeSetSeed(inp, seed)
  return inp
}

// _b_sora_2_pro (:225)
function sora2Pro({ prompt, aspectRatio, duration, seed }: VideoBuildArgs) {
  const inp: Record<string, unknown> = { prompt, aspect_ratio: arOr(SORA_PRO_AR, aspectRatio, '16:9'), duration: durOr([5, 10], duration, 5) }
  maybeSetSeed(inp, seed)
  return inp
}

// _b_runway_gen_4_5 (:237)
function runwayGen45({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(RUNWAY_AR, aspectRatio, '16:9'),
    duration: durOr([5, 10], duration, 5),
    motion: optInt(adv, 'motion', 5),
  }
  if (image) inp.image = image
  maybeSetSeed(inp, seed)
  return inp
}

// _b_kling_v3 (:252)
function klingV3({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(KLING_AR, aspectRatio, '16:9'),
    duration: durOr([5, 10, 15], duration, 5),
    generate_audio: optBool(adv, 'generate_audio', true),
    cfg_scale: optFloat(adv, 'cfg_scale', 0.5),
  }
  setNegative(inp, adv)
  if (image) inp.start_image = image
  maybeSetSeed(inp, seed)
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

// _b_seedance_2_0_fast (:313): the aspect ratio only without a first frame.
function seedance20Fast({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    duration: durOr([3, 5, 10], duration, 5),
    resolution: optStr(adv, 'resolution', '720p'),
    camera_fixed: optBool(adv, 'camera_fixed', false),
  }
  if (image) inp.image = image
  else inp.aspect_ratio = arOr(SEEDANCE_AR, aspectRatio, '16:9')
  maybeSetSeed(inp, seed)
  return inp
}

// _b_hailuo_2_3 (:330)
function hailuo23({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    duration: durOr([6, 10], duration, 6),
    resolution: optStr(adv, 'resolution', '768p'),
    prompt_optimizer: optBool(adv, 'prompt_optimizer', true),
  }
  if (image) inp.first_frame_image = image
  else inp.aspect_ratio = arOr(HAILUO_AR, aspectRatio, '16:9')
  maybeSetSeed(inp, seed)
  return inp
}

// _b_wan_2_7_t2v (:402): text-to-video only.
function wan27T2v({ prompt, aspectRatio, seed, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(WAN_AR, aspectRatio, '16:9'),
    resolution: optStr(adv, 'resolution', '720p'),
    num_frames: optInt(adv, 'num_frames', 81),
  }
  setNegative(inp, adv)
  maybeSetSeed(inp, seed)
  return inp
}

// _b_wan_2_5_i2v_fast (:415): a first frame is required.
function wan25I2vFast({ prompt, aspectRatio, seed, image, adv }: VideoBuildArgs) {
  if (!image) throw new Error('Wan 2.5 I2V Fast requires an input image.')
  const inp: Record<string, unknown> = {
    prompt,
    image,
    aspect_ratio: arOr(WAN_AR, aspectRatio, '16:9'),
    resolution: optStr(adv, 'resolution', '480p'),
  }
  setNegative(inp, adv)
  maybeSetSeed(inp, seed)
  return inp
}

// _b_luma_ray_2_720p (:432): Luma takes the first frame as start_image_url.
function lumaRay2720p({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(LUMA_AR, aspectRatio, '16:9'),
    duration: durOr([5, 9], duration, 5),
    loop: optBool(adv, 'loop', false),
  }
  if (image) inp.start_image_url = image
  maybeSetSeed(inp, seed)
  return inp
}

// _b_ltx_video (:448): the image before the negative prompt, as in Python (key order).
function ltxVideo({ prompt, aspectRatio, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(LTX_AR, aspectRatio, '16:9'),
    guidance_scale: optFloat(adv, 'guidance_scale', 3.0),
    num_inference_steps: optInt(adv, 'num_inference_steps', 30),
  }
  if (image) inp.image = image
  setNegative(inp, adv)
  maybeSetSeed(inp, seed)
  return inp
}

// _b_pixverse_v6 (:482)
function pixverseV6({ prompt, aspectRatio, duration, seed, image, adv }: VideoBuildArgs) {
  const inp: Record<string, unknown> = {
    prompt,
    aspect_ratio: arOr(PIXVERSE_AR, aspectRatio, '16:9'),
    duration: durOr([5, 8], duration, 5),
    resolution: optStr(adv, 'resolution', '720p'),
    generate_audio: optBool(adv, 'generate_audio', true),
  }
  const style = optStr(adv, 'style', 'none')
  if (style && style !== 'none') inp.style = style
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
