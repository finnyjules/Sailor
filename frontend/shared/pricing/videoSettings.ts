/**
 * The settings a video model's request actually carries — the clip length
 * after the model rounds it, the resolution and the sound setting — read from
 * a node's widgets exactly as that model's request builder reads them.
 *
 * The price multiplies a rate by these, so it must never read a setting the
 * builder would send differently ("priced on what is sent"). The builders are
 * server/runner/generators/video.ts (fal and Replicate) and, for the one model
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
}

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

interface Rule {
  /** The builder's durOr list, or null when it sends no length. */
  durations: readonly number[] | null
  /** The builder's fallback for an unreadable duration (desc.defaultDuration / spec.default_duration). */
  defaultDuration: number
  /** The length the service renders when no length is sent (its schema default). */
  fixedSeconds?: number
  resolution(adv: Adv): string | null
  audio(adv: Adv): boolean
}

const lower = (s: string) => s.toLowerCase()
const res = (key: string, def: string) => (adv: Adv) => lower(optStr(adv, key, def))
const fixed = <T>(v: T) => () => v
const audioOpt = (def: boolean) => (adv: Adv) => optBool(adv, 'generate_audio', def)

/**
 * One rule per video model id, mirroring its builder (video.ts line refs are
 * to the function named in the comment).
 */
const RULES: Record<string, Rule> = {
  // ── fal (RUNNER_VIDEO_MODELS) ──
  // veo31: durOr([4,6,8]), resolution default 720p, generate_audio default true.
  'veo-3.1': { durations: [4, 6, 8], defaultDuration: 8, resolution: res('resolution', '720p'), audio: audioOpt(true) },
  'veo-3.1-fast': { durations: [4, 6, 8], defaultDuration: 8, resolution: res('resolution', '720p'), audio: audioOpt(true) },
  // flux3: durOr([5,10,15,20]), resolution 720p, generate_audio true.
  'flux-3': { durations: [5, 10, 15, 20], defaultDuration: 10, resolution: res('resolution', '720p'), audio: audioOpt(true) },
  // seedance20: sends generate_audio only when set; fal's default is true.
  'seedance-2.0': {
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15], defaultDuration: 5, resolution: res('resolution', '720p'),
    audio: adv => (has(adv, 'generate_audio') ? pyTruthy(adv.generate_audio) : true),
  },
  // hailuoH3Core: H3_RES of the lower-cased option, else 768P. H3 always renders sound.
  'hailuo-h3': { durations: [5, 6, 10], defaultDuration: 5, resolution: adv => H3_RES[lower(optStr(adv, 'resolution', '768p'))] ?? '768p', audio: fixed(true) },
  'hailuo-h3-max': { durations: [5, 6, 10], defaultDuration: 5, resolution: adv => H3_RES[lower(optStr(adv, 'resolution', '768p'))] ?? '768p', audio: fixed(true) },

  // ── Replicate (RUNNER_REPLICATE_VIDEO_MODELS) ──
  // sora2 / sora2Pro send no resolution: Sora 2 has none, Sora 2 Pro's schema default is "standard" (720p). Sora renders sound.
  'sora-2': { durations: [5, 10], defaultDuration: 5, resolution: fixed(null), audio: fixed(true) },
  'sora-2-pro': { durations: [5, 10], defaultDuration: 5, resolution: fixed('720p'), audio: fixed(true) },
  // runwayGen45: no resolution, no sound.
  'runway-gen-4.5': { durations: [5, 10], defaultDuration: 5, resolution: fixed(null), audio: fixed(false) },
  // klingV3 sends no `mode`; the schema default is "pro", which it documents as 1080p.
  'kling-v3': { durations: [5, 10, 15], defaultDuration: 5, resolution: fixed('1080p'), audio: audioOpt(true) },
  'kling-v2.5-turbo-pro': { durations: [5, 10], defaultDuration: 5, resolution: fixed(null), audio: fixed(false) },
  // seedance20Fast sends no generate_audio; the schema default is true.
  'seedance-2.0-fast': { durations: [3, 5, 10], defaultDuration: 5, resolution: res('resolution', '720p'), audio: fixed(true) },
  'hailuo-2.3': { durations: [6, 10], defaultDuration: 6, resolution: res('resolution', '768p'), audio: fixed(false) },
  // wan27T2v / wan25I2vFast send no length: the schema default is 5 s on both.
  'wan-2.7-t2v': { durations: null, defaultDuration: 5, fixedSeconds: 5, resolution: res('resolution', '720p'), audio: fixed(false) },
  'wan-2.5-i2v-fast': { durations: null, defaultDuration: 5, fixedSeconds: 5, resolution: res('resolution', '480p'), audio: fixed(false) },
  // lumaRay2720p: the model is 720p only.
  'luma-ray-2-720p': { durations: [5, 9], defaultDuration: 5, resolution: fixed('720p'), audio: fixed(false) },
  // ltxVideo sends no length or resolution; priced per clip.
  'ltx-video': { durations: null, defaultDuration: 5, fixedSeconds: 5, resolution: fixed(null), audio: fixed(false) },
  'pixverse-v6': { durations: [5, 8], defaultDuration: 5, resolution: res('resolution', '720p'), audio: audioOpt(true) },

  // ── ComfyUI only ──
  // _b_fabric_1_0 (comfy_api_nodes/video_models.py:465-477) ignores the duration
  // and sends resolution default 720p; the clip is as long as the sound, which
  // GenerateVideoNode caps at 60 s (_audio_dict_to_wav_data_url(max_seconds=60),
  // nodes_replicate.py:3974). The price can't see the sound, so it charges the
  // 60 s maximum (controller ruling 1).
  'fabric-1.0': { durations: null, defaultDuration: 60, fixedSeconds: 60, resolution: res('resolution', '720p'), audio: fixed(true) },
}

/** True when the id has settings rules (every VIDEO_MODELS id does; a test pins it). */
export function hasVideoSettings(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(RULES, modelId)
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
 * `aspectRatio` is taken for the signature's sake: no builder's length,
 * resolution or sound depends on it. Null for an id with no rules.
 */
export function effectiveVideoSettings(
  modelId: string,
  duration: unknown,
  _aspectRatio: unknown,
  modelOptions: unknown,
): VideoSettings | null {
  if (!hasVideoSettings(modelId)) return null
  const r = RULES[modelId]!
  const adv = readModelOptions(modelOptions)
  const seconds = r.durations ? durOr(r.durations, durationInt(duration, r.defaultDuration)) : r.fixedSeconds!
  return { seconds, resolution: r.resolution(adv), audio: r.audio(adv) }
}
