/**
 * The settings a video model's request actually carries — the clip length
 * after the model rounds it, the resolution and the sound setting — read from
 * a node's widgets exactly as that model's request builder reads them.
 *
 * The price multiplies a rate by these, so it must never read a setting the
 * builder would send differently ("priced on what is sent"). The builders are
 * server/runner/generators/video.ts (fal and Replicate), wan3.ts (Wan 3.0), geminiOmniFlash.ts, veo31Lite.ts, happyHorse11.ts, grokImagineVideo15.ts, ltx25Fast.ts, lumaRay32.ts and twins.ts (the
 * first-service builders of Kling 3.0 and PixVerse v6, and the backups) and, for the one model
 * the runner does not build (Fabric), comfy_api_nodes/video_models.py. The
 * settings-parity test (tests/unit/video-pricing.unit.spec.ts) runs every
 * builder over every setting and checks it sends what this module says.
 *
 * Where a builder does not send a setting, the value is what the service does
 * without it (its schema default), cited per model below.
 *
 * Pure: no server imports, so the badge, the run estimate and the charge all
 * load it. Relative imports only.
 */
import { pyIntOf, pyTruthy } from '../runner/pyText'

export interface VideoSettings {
  /** The clip length the service renders, in seconds. */
  seconds: number
  /** Lower-case resolution the service renders at, or null where it has no such setting. */
  resolution: string | null
  /** Whether the clip comes back with sound. */
  audio: boolean
  /**
   * Seconds of reference video the service also bills (0 for none). Seedance
   * 2.0 on fal bills a reference-to-video call on input + output seconds; the
   * input length can't be seen before the run, so it is fal's maximum total
   * input (SEEDANCE_MAX_INPUT_VIDEO_SECONDS).
   */
  inputVideoSeconds: number
  /**
   * Pictures sent that the service bills one by one (Grok Imagine Video 1.5's
   * first frame on fal: the rate card's `inputImageUsd`). Present only for a
   * model whose rule counts them; absent = 0.
   */
  inputImages?: number
}

/**
 * fal bytedance/seedance-2.0/reference-to-video: "(input video duration +
 * output video duration)" in the token count, and reference videos total at
 * most 15 s (its llms.txt, read 2026-09-24). Priced at the maximum: fail-safe.
 */
export const SEEDANCE_MAX_INPUT_VIDEO_SECONDS = 15

type Adv = Record<string, unknown>

const has = (adv: Adv, key: string) => Object.prototype.hasOwnProperty.call(adv, key)

// Ports of the readers in server/runner/generators/opts.ts (Python's _opt_str /
// _opt_bool). Kept here because shared code must not import the server; the
// settings-parity test holds the two to the same answers.
function optStr(adv: Adv, key: string, def: string): string {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (v === null || v === undefined) return def
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}
function optBool(adv: Adv, key: string, def: boolean): boolean {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['true', '1', 'yes', 'on'].includes(v.toLowerCase())
  return pyTruthy(v)
}

/** video.ts durOr (video_models._dur_or): the value if allowed, else the closest (first on a tie). */
function durOr(allowed: readonly number[], d: number): number {
  if (allowed.includes(d)) return d
  let best = allowed[0]!
  for (const a of allowed) if (Math.abs(a - d) < Math.abs(best - d)) best = a
  return best
}

/** opts.asInt / Python int(duration): a number truncated, numeric text as int() reads it, else the default. */
function durationInt(v: unknown, def: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string') return pyIntOf(v) ?? def
  return def
}

/** `model_options` as the builders read it: JSON text or an already-parsed object; anything else is empty. */
export function readModelOptions(raw: unknown): Adv {
  let v: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return {}
    try { v = JSON.parse(raw) }
    catch { return {} }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Adv : {}
}

const H3_RES: Record<string, string> = { '480p': '480p', '768p': '768p', '2k': '2k', '4k': '4k' }
/** minimax/h3-max renders 480P, 768P or 1080P (its schema; video.ts H3_MAX_RES). */
const H3_MAX_RES: Record<string, string> = { '480p': '480p', '768p': '768p', '1080p': '1080p' }
const h3Res = (table: Record<string, string>) => (adv: Adv) => {
  const r = lower(optStr(adv, 'resolution', '768p'))
  return has(table, r) ? table[r]! : '768p'
}

interface Rule {
  /** The builder's durOr list, or null when it sends no length. */
  durations: readonly number[] | null
  /** The builder's fallback for an unreadable duration (desc.defaultDuration / spec.default_duration). */
  defaultDuration: number
  /** The length the service renders when no length is sent (its schema default). */
  fixedSeconds?: number
  /**
   * The ComfyUI (Python) path's clip length, where Python still sends a field
   * the schema doesn't have and the service renders its default length. The
   * price never goes below it while that path is live (S1b fix round 1).
   */
  pythonPathSeconds?: number
  resolution(adv: Adv): string | null
  audio(adv: Adv): boolean
  /** Billed seconds of reference video, given whether a first frame is sent. Absent = 0. */
  inputVideo?(adv: Adv, firstFrame: boolean): number
  /** Billed input pictures, given whether a first frame is linked. Absent = the settings carry no count. */
  inputImages?(adv: Adv, firstFrame: boolean): number
  /**
   * The length the builder sends when reference pictures (`image_urls`) go,
   * whatever the node's duration: Veo 3.1 / Fast's reference-to-video is
   * always sent as 8 s (video.ts veo31, Ruling K). Absent = the duration rule.
   */
  referenceSeconds?: number
}

const lower = (s: string) => s.toLowerCase()
const fixed = <T>(v: T) => () => v
const audioOpt = (def: boolean) => (adv: Adv) => optBool(adv, 'generate_audio', def)
/**
 * A resolution the builder keeps only when the model's schema lists it
 * (video.ts lowerEnum): the option lower-cased, else the builder's default.
 */
const resIn = (allowed: readonly string[], def: string) => (adv: Adv) => {
  const r = lower(optStr(adv, 'resolution', def))
  return allowed.includes(r) ? r : def
}
const WAN_RESOLUTIONS = ['720p', '1080p']
/**
 * PixVerse v6: the runner sends `quality`; Python sends `resolution`, which the
 * schema doesn't have, so the ComfyUI path renders the schema's 540p, silent.
 * While that path is live the price is the dearer of the two: the quality sent,
 * but never below 540p (the sound sent stays: with sound is never cheaper).
 */
const PIXVERSE_TIERS = ['360p', '540p', '720p', '1080p']
function pixverseResolution(adv: Adv): string {
  const sent = resIn(PIXVERSE_TIERS, '720p')(adv)
  return PIXVERSE_TIERS.indexOf(sent) < PIXVERSE_TIERS.indexOf('540p') ? '540p' : sent
}
/** alibaba/wan-3.0 and -prime: any whole second from 2 to 30; 480p, 720p or 1080p (wan3.ts). */
const WAN_3_SECONDS = Array.from({ length: 29 }, (_, i) => i + 2)
const WAN_3_RESOLUTIONS = ['480p', '720p', '1080p']
/** alibaba/happy-horse/v1.1 and alibaba/happyhorse-1.1: any whole second from 3 to 15 (happyHorse11.ts). */
const HAPPYHORSE_11_SECONDS = Array.from({ length: 13 }, (_, i) => i + 3)
/** xai/grok-imagine-video/v1.5 and xai/grok-imagine-video-1.5: any whole second from 1 to 15 (grokImagineVideo15.ts). */
const GROK_IMAGINE_VIDEO_15_SECONDS = Array.from({ length: 15 }, (_, i) => i + 1)
/** lightricks/ltx-2.5-fast's `duration` enum (ltx25Fast.ts LTX_25_FAST_SECONDS). */
const LTX_25_FAST_SECONDS = [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20]
/** wan-video/wan-2.7-t2v: any whole second from 2 to 15 (video.ts WAN_27_SECONDS). */
const WAN_27_SECONDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

/**
 * One rule per video model id, mirroring its builder (video.ts line refs are
 * to the function named in the comment).
 */
const RULES: Record<string, Rule> = {
  // ── fal (RUNNER_VIDEO_MODELS) ──
  // veo31: durOr([4,6,8]), resolution default 720p, generate_audio default true.
  // With reference pictures (image_urls) the builder always sends '8s' (reference-to-video).
  'veo-3.1': { durations: [4, 6, 8], defaultDuration: 8, referenceSeconds: 8, resolution: resIn(['720p', '1080p', '4k'], '720p'), audio: audioOpt(true) },
  'veo-3.1-fast': { durations: [4, 6, 8], defaultDuration: 8, referenceSeconds: 8, resolution: resIn(['720p', '1080p', '4k'], '720p'), audio: audioOpt(true) },
  // veo31Lite.ts: veo31 on Lite's app, a resolution outside 720p/1080p (4k) sent as 720p.
  'veo-3.1-lite': { durations: [4, 6, 8], defaultDuration: 8, resolution: resIn(['720p', '1080p'], '720p'), audio: audioOpt(true) },
  // flux3: durOr([5,10,15,20]), resolution 720p, generate_audio true.
  'flux-3': { durations: [5, 10, 15, 20], defaultDuration: 10, resolution: resIn(['720p', '1080p'], '720p'), audio: audioOpt(true) },
  // seedance20: sends generate_audio only when set; fal's default is true.
  'seedance-2.0': {
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], defaultDuration: 5, resolution: resIn(['480p', '720p', '1080p', '4k'], '720p'),
    audio: adv => (has(adv, 'generate_audio') ? pyTruthy(adv.generate_audio) : true),
    // seedance20: with no first frame (the linked image or image_url), a
    // non-empty video_urls goes to reference-to-video, billed on input seconds too.
    inputVideo: (adv, firstFrame) => {
      if (firstFrame || optStr(adv, 'image_url', '')) return 0
      const v = adv.video_urls
      return Array.isArray(v) && v.length ? SEEDANCE_MAX_INPUT_VIDEO_SECONDS : 0
    },
  },
  // hailuoH3Core: the model's own resolution table of the lower-cased option, else 768P. H3 always renders sound.
  'hailuo-h3': { durations: [5, 6, 10], defaultDuration: 5, resolution: h3Res(H3_RES), audio: fixed(true) },
  'hailuo-h3-max': { durations: [5, 6, 10], defaultDuration: 5, resolution: h3Res(H3_MAX_RES), audio: fixed(true) },
  // h3MaxTurbo.ts: H3 Max's builder on Turbo's app (the schemas match field for field).
  'hailuo-h3-max-turbo': { durations: [5, 6, 10], defaultDuration: 5, resolution: h3Res(H3_MAX_RES), audio: fixed(true) },
  // geminiOmniFlash.ts: `duration` the closest of 4/6/8/10 (default 8); no
  // resolution field (fal renders 720p); the clip always has sound.
  'gemini-omni-flash': { durations: [4, 6, 8, 10], defaultDuration: 8, resolution: fixed('720p'), audio: fixed(true) },
  // wan3.ts (every endpoint): `duration` the closest whole second from 2 to 30,
  // `resolution` 480p/720p/1080p else 720p, `audio` from generate_audio (default on).
  'wan-3.0': { durations: WAN_3_SECONDS, defaultDuration: 5, resolution: resIn(WAN_3_RESOLUTIONS, '720p'), audio: audioOpt(true) },
  'wan-3.0-prime': { durations: WAN_3_SECONDS, defaultDuration: 5, resolution: resIn(WAN_3_RESOLUTIONS, '720p'), audio: audioOpt(true) },
  // happyHorse11.ts (both endpoints, and the Replicate backup built from them): `duration` the
  // closest whole second from 3 to 15 (default 5), `resolution` 720p/1080p else 720p; the clip always has sound.
  'happyhorse-1.1': { durations: HAPPYHORSE_11_SECONDS, defaultDuration: 5, resolution: resIn(['720p', '1080p'], '720p'), audio: fixed(true) },
  // grokImagineVideo15.ts (both fal endpoints, and the Replicate backup built from them): `duration`
  // the closest whole second from 1 to 15 (default 6), `resolution` 480p/720p/1080p else 720p; the clip
  // always has sound. One billed picture when a first frame is sent (the linked one, or `image_url`).
  'grok-imagine-video-1.5': {
    durations: GROK_IMAGINE_VIDEO_15_SECONDS, defaultDuration: 6, resolution: resIn(['480p', '720p', '1080p'], '720p'), audio: fixed(true),
    inputImages: (adv, firstFrame) => (firstFrame || optStr(adv, 'image_url', '') ? 1 : 0),
  },

  // ── Replicate (RUNNER_REPLICATE_VIDEO_MODELS) ──
  // sora2 / sora2Pro send `seconds` 4/8/12 (video.ts SORA_SECONDS) and no
  // resolution: Sora 2 has none, Sora 2 Pro's schema default is "standard" (720p). Sora renders sound.
  'sora-2': { durations: [4, 8, 12], defaultDuration: 5, resolution: fixed(null), audio: fixed(true) },
  'sora-2-pro': { durations: [4, 8, 12], defaultDuration: 5, resolution: fixed('720p'), audio: fixed(true) },
  // runwayGen45: no resolution, no sound.
  'runway-gen-4.5': { durations: [5, 10], defaultDuration: 5, resolution: fixed(null), audio: fixed(false) },
  // twins.ts klingV3Fal (first) sends fal's pro endpoints; video.ts klingV3
  // (the Replicate backup) sends no `mode`, whose default "pro" is documented as 1080p.
  'kling-v3': { durations: [5, 10, 15], defaultDuration: 5, resolution: fixed('1080p'), audio: audioOpt(true) },
  'kling-v2.5-turbo-pro': { durations: [5, 10], defaultDuration: 5, resolution: fixed(null), audio: fixed(false) },
  // seedance20Fast sends no generate_audio; the schema default is true. Resolution 480p or 720p, anything else 720p.
  'seedance-2.0-fast': { durations: [3, 5, 10], defaultDuration: 5, resolution: resIn(['480p', '720p'], '720p'), audio: fixed(true) },
  // hailuo23: 768p or 1080p, anything else 768p.
  'hailuo-2.3': { durations: [6, 10], defaultDuration: 6, resolution: resIn(['768p', '1080p'], '768p'), audio: fixed(false) },
  // wan27T2v sends `duration` 2–15; wan25I2vFast `duration` 5 or 10. Both 720p or 1080p, anything else 720p.
  // Python still sends `num_frames` (not in the schema): its clip is the 5 s default, so never priced below 5 s.
  'wan-2.7-t2v': { durations: WAN_27_SECONDS, defaultDuration: 5, pythonPathSeconds: 5, resolution: resIn(WAN_RESOLUTIONS, '720p'), audio: fixed(false) },
  'wan-2.5-i2v-fast': { durations: [5, 10], defaultDuration: 5, resolution: resIn(WAN_RESOLUTIONS, '720p'), audio: fixed(false) },
  // lumaRay2720p: the model is 720p only.
  'luma-ray-2-720p': { durations: [5, 9], defaultDuration: 5, resolution: fixed('720p'), audio: fixed(false) },
  // ltxVideo sends no length or resolution; priced per clip at the 50-step ceiling.
  'ltx-video': { durations: null, defaultDuration: 5, fixedSeconds: 5, resolution: fixed(null), audio: fixed(false) },
  // ltx25Fast.ts (Replicate, no backup): `duration` the closest of 2–6, 8, …, 20 (default 6), `resolution`
  // 720p/1080p/4k else 1080p, `generate_audio` the sound option (default on; the price is the same either way).
  'ltx-2.5-fast': { durations: LTX_25_FAST_SECONDS, defaultDuration: 6, resolution: resIn(['720p', '1080p', '4k'], '1080p'), audio: audioOpt(true) },
  // lumaRay32.ts (Replicate, and the fal backup built from it): `duration` the closer of 5 and 10 (default 5),
  // `resolution` 540p/720p/1080p else 720p; the clip never has sound. The loop doesn't change the price.
  'luma-ray-3.2': { durations: [5, 10], defaultDuration: 5, resolution: resIn(['540p', '720p', '1080p'], '720p'), audio: fixed(false) },
  // twins.ts pixverseV6Fal (first) sends `resolution`, video.ts pixverseV6
  // (the Replicate backup) `quality`: the resolution option, 360p–1080p,
  // anything else 720p; both send `generate_audio_switch` (the sound option,
  // default on). Priced never below the ComfyUI path's 540p (pixverseResolution).
  'pixverse-v6': { durations: [5, 8], defaultDuration: 5, resolution: pixverseResolution, audio: audioOpt(true) },

  // ── Replicate, with a linked sound (R11.2) ──
  // _b_fabric_1_0 (comfy_api_nodes/video_models.py:465-477) ignores the duration
  // and sends resolution default 720p; the clip is as long as the sound, which
  // GenerateVideoNode caps at 60 s (_audio_dict_to_wav_data_url(max_seconds=60),
  // nodes_replicate.py:3974). Unmeasured, the price charges the 60 s maximum
  // (controller ruling 1); the runner measures the sound (nodePrice.ts
  // videoNodeUsd). The runner sends 480p or 720p (its schema), anything else
  // as 720p (video.ts fabric10); Python sends any other value as typed, which
  // Replicate refuses, so 720p, the dearest, is its price too.
  'fabric-1.0': { durations: null, defaultDuration: 60, fixedSeconds: 60, resolution: resIn(['480p', '720p'], '720p'), audio: fixed(true) },
}

/** True when the id has settings rules (every VIDEO_MODELS id does; a test pins it). */
export function hasVideoSettings(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(RULES, modelId)
}

/**
 * R11.9a fix round 2 (I1): which of a clip's size settings the model has, so
 * advice names only those: more than one length, and a resolution that
 * changes with the option (tried over every tier the services name).
 */
export function videoSizeChoices(modelId: string): { duration: boolean; resolution: boolean } | null {
  if (!hasVideoSettings(modelId)) return null
  const r = RULES[modelId]!
  const tiers = ['360p', '480p', '540p', '720p', '768p', '1080p', '2k', '4k']
  const seen = new Set(tiers.map(t => r.resolution({ resolution: t })))
  return { duration: !!r.durations && r.durations.length > 1, resolution: seen.size > 1 }
}

/** The longest clip the model's builder can send — what a linked (unknown) length is priced at. */
export function maxVideoSeconds(modelId: string): number | null {
  if (!hasVideoSettings(modelId)) return null
  const r = RULES[modelId]!
  return r.durations ? Math.max(...r.durations) : r.fixedSeconds!
}

/**
 * The seconds, resolution and sound the request for `modelId` carries, given
 * the node's raw `duration` widget and `model_options` (JSON text or object).
 * `firstFrame` is the node's `image` input (a link reference or a URL; empty =
 * none): it decides whether Seedance 2.0's reference videos are sent, and
 * whether Grok Imagine Video 1.5 sends a picture.
 * `aspectRatio` is taken for the signature's sake: no builder's length,
 * resolution or sound depends on it. Null for an id with no rules.
 */
export function effectiveVideoSettings(
  modelId: string,
  duration: unknown,
  _aspectRatio: unknown,
  modelOptions: unknown,
  firstFrame?: unknown,
): VideoSettings | null {
  if (!hasVideoSettings(modelId)) return null
  const r = RULES[modelId]!
  const adv = readModelOptions(modelOptions)
  const withRefs = r.referenceSeconds !== undefined && Array.isArray(adv.image_urls) && adv.image_urls.length > 0
  const sent = withRefs ? r.referenceSeconds!
    : r.durations ? durOr(r.durations, durationInt(duration, r.defaultDuration)) : r.fixedSeconds!
  const seconds = Math.max(sent, r.pythonPathSeconds ?? 0)
  const inputVideoSeconds = r.inputVideo ? r.inputVideo(adv, pyTruthy(firstFrame)) : 0
  const out: VideoSettings = { seconds, resolution: r.resolution(adv), audio: r.audio(adv), inputVideoSeconds }
  if (r.inputImages) out.inputImages = r.inputImages(adv, pyTruthy(firstFrame))
  return out
}
