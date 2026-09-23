/**
 * The runner's video models. Builders are ports of comfy_api_nodes/video_models.py
 * (the fal-provider entries) and must match the Python payloads exactly
 * (tests/unit/runner-video-models.unit.spec.ts).
 */
import { RUNNER_VIDEO_MODEL_IDS } from '#shared/runner/eligibility'
import { arOr, maybeSetSeed, optBool, optStr, pyTruthy } from './opts'
import type { VideoBuildArgs, VideoModelDesc } from './types'

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
