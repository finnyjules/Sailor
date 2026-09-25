/**
 * What the calls priced on clipRates.ts actually send — the clip length, the
 * resolution and the sound setting — and their price.
 *
 * Two kinds of caller:
 *
 *  - A server route that sends a fal request itself (Frame Animate). Its
 *    price is read from the REQUEST it sends: `requestPrice(endpoint, input)`.
 *    runFal (server/utils/falRun.ts) calls it for every request, so the hold
 *    and the charge are whatever the request carries, and the Animate button
 *    prices the same request (app/data/clip-models.ts clipRequest).
 *
 *  - A ComfyUI node that calls one endpoint: the older one-model video nodes
 *    and the lip-sync nodes. `remoteVideoNodeUsd(classType, inputs)` reads the
 *    node's widgets as its Python `execute` does (lines cited below) and
 *    priceNode (nodePrice.ts) prices it for the charge, the badge and the run
 *    estimate alike.
 *
 * Lip-sync length (ruling on open question 1): the price depends on the sound
 * clip's length, which the ComfyUI path can't see before the run. It charges
 * the longest clip the call can make: 60 s, the audio cap the nodes encode
 * with (`_audio_dict_to_wav_data_url(audio, max_seconds=60)`) and Fabric's
 * longest output, or the service's own shorter limit (Kling lip-sync: a 2–10 s
 * source video). The badge shows the same figure, so it is never below the
 * charge.
 *
 * Fail-safe: a linked setting, or a value the service doesn't list, is priced
 * at its dearest; an unreadable length at the longest the service accepts.
 * Pure; relative imports only.
 */
import { creditsForUsd } from './markup'
import { clipRate, clipUsd } from './clipRates'
import { readModelOptions } from './videoSettings'
import { pyIntOf, pyTruthy } from '../runner/pyText'

export interface ClipCall {
  endpoint: string
  /** Seconds of output the service bills. */
  seconds: number
  /** The resolution key sent (lower case for fal requests), or null where it has none. */
  resolution: string | null
  audio: boolean
}

type Inputs = Record<string, unknown>

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
/** An API-prompt link reference (`[nodeId, slot]`), known only at run time. */
const linked = (v: unknown) => Array.isArray(v)
/** A resolution key no card lists: perSecondUsd prices it at the card's highest rate. */
const UNLISTED = '(unlisted)'

// ── Server-sent fal requests (Frame Animate) ──────────────────────────────

interface RequestRule {
  /** Seconds when the request sends no `duration`; null = the service picks ("auto"), priced at the longest. */
  defaultSeconds: number | null
  minSeconds: number
  maxSeconds: number
  /** The service's resolution when none is sent (lower case), or null where it has no setting. */
  defaultResolution: string | null
  /** The service's `generate_audio` default, where the price depends on it. */
  defaultAudio: boolean
}

/**
 * Each endpoint's schema, from its fal llms.txt (read 2026-09-24):
 *  - seedance i2v: duration "auto", "4"…"15" (default "auto"); resolution default "720p";
 *  - h3 i2v: duration integer 5–15 (default 5); resolution default "2K";
 *  - h3-max i2v: duration integer 5–15 (default 5); resolution default "768P";
 *  - kling v3 pro i2v: duration "3"…"15" (default "5"); generate_audio default true;
 *  - flux-3 first-last-frame draft: duration 5–20 (default 5); 720p only.
 */
const REQUEST_RULES: Record<string, RequestRule> = {
  'bytedance/seedance-2.0/image-to-video': { defaultSeconds: null, minSeconds: 4, maxSeconds: 15, defaultResolution: '720p', defaultAudio: true },
  'minimax/h3/image-to-video': { defaultSeconds: 5, minSeconds: 5, maxSeconds: 15, defaultResolution: '2k', defaultAudio: true },
  'minimax/h3-max/image-to-video': { defaultSeconds: 5, minSeconds: 5, maxSeconds: 15, defaultResolution: '768p', defaultAudio: true },
  'fal-ai/kling-video/v3/pro/image-to-video': { defaultSeconds: 5, minSeconds: 3, maxSeconds: 15, defaultResolution: null, defaultAudio: true },
  'blackforestlabs/flux-3/first-last-frame-to-video/draft': { defaultSeconds: 5, minSeconds: 5, maxSeconds: 20, defaultResolution: '720p', defaultAudio: true },
}

/** The endpoints a sent request is priced for. */
export const REQUEST_PRICED_ENDPOINTS: readonly string[] = Object.keys(REQUEST_RULES)

/** A request's whole-number seconds: an integer, or integer text ("5"); anything else is null. */
function requestInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number.parseInt(v, 10)
  return null
}

/** The settings a fal request carries, as its endpoint bills them, or null for an endpoint with no rule. */
export function requestSettings(endpoint: string, input: Inputs): ClipCall | null {
  if (!hasOwn(REQUEST_RULES, endpoint)) return null
  const rule = REQUEST_RULES[endpoint]!
  let seconds: number
  if (input.duration === undefined && rule.defaultSeconds != null) seconds = rule.defaultSeconds
  else {
    // "auto", an odd value, or a length out of range: the longest the service renders.
    const n = requestInt(input.duration)
    seconds = n != null && n >= rule.minSeconds && n <= rule.maxSeconds ? n : rule.maxSeconds
  }
  const resolution = rule.defaultResolution == null
    ? null
    : (typeof input.resolution === 'string' ? input.resolution.toLowerCase() : input.resolution === undefined ? rule.defaultResolution : UNLISTED)
  // Only a plain boolean is read; anything else is priced with sound, the dearer.
  const audio = typeof input.generate_audio === 'boolean' ? input.generate_audio : (input.generate_audio === undefined ? rule.defaultAudio : true)
  return { endpoint, seconds, resolution, audio }
}

/**
 * The price of a fal request as it is sent: dollars, and the credits held and
 * charged for it. Null for an endpoint with no per-second card (its flat
 * MODEL_COSTS row applies).
 */
export function requestPrice(endpoint: string, input: Inputs): { usd: number, credits: number } | null {
  const s = requestSettings(endpoint, input)
  if (!s || !clipRate(endpoint)) return null
  const usd = clipUsd(endpoint, s)!
  return { usd, credits: creditsForUsd(usd) }
}

// ── ComfyUI nodes that call one endpoint ──────────────────────────────────

/** The node classes priced here. Each has left the flat table (GRAPH_NODE_CREDITS). */
export const REMOTE_VIDEO_NODE_CLASSES: readonly string[] = [
  'Veo3RemoteNode',
  'KlingVideoRemoteNode',
  'Seedance2RemoteNode',
  'LipSyncNode',
  'LipsyncNode',
  'LipsyncRemoteNode',
]

/**
 * The longest sound clip a lip-sync node sends: every lip-sync `execute`
 * encodes a wired clip with `_audio_dict_to_wav_data_url(audio, max_seconds=60)`
 * (nodes_replicate.py LipsyncRemoteNode, LipsyncNode, LipSyncNode), and 60 s
 * is Fabric's longest output ("60s cap matches Fabric's max output length",
 * GenerateVideoNode.execute).
 */
export const LIPSYNC_MAX_SECONDS = 60

/**
 * kwaivgi/kling-lip-sync relips a source video "with a duration of 2-10
 * seconds" (its schema's video_url, read 2026-09-24), and bills seconds of
 * output video: never more than 10.
 */
export const KLING_LIPSYNC_MAX_SECONDS = 10

/**
 * Python int(v) for a widget value: a number truncated, integer text as int()
 * reads it, else null (int() raises, and the node fails before any call).
 */
function pyInt(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null
  if (typeof v === 'string') return pyIntOf(v)
  return null
}

/** `int(duration)` as sent, when the service accepts it (1…max); else the service's longest. */
function lengthSent(v: unknown, max: number): number {
  if (linked(v)) return max
  const n = pyInt(v)
  return n != null && n >= 1 && n <= max ? n : max
}

/** A widget sent as-is (`"resolution": resolution`): its text, or a key no card lists. */
function sentAsIs(v: unknown): string {
  return typeof v === 'string' ? v : UNLISTED
}

function lipSyncCalls(inputs: Inputs): ClipCall[] {
  const fabric = (resolution: string): ClipCall => ({ endpoint: 'veed/fabric-1.0', seconds: LIPSYNC_MAX_SECONDS, resolution, audio: false })
  const kling: ClipCall = { endpoint: 'kwaivgi/kling-lip-sync', seconds: KLING_LIPSYNC_MAX_SECONDS, resolution: null, audio: false }
  // model_options linked: the engine and resolution can't be read — both engines, Fabric at its dearest.
  if (linked(inputs.model_options)) return [fabric(UNLISTED), kling]
  // LipSyncNode.execute: `opts = json.loads(model_options or "{}")` (non-dict → {}),
  // then `resolution = opts.get("resolution", resolution)`, `engine = opts.get("engine", engine)`.
  const opts = readModelOptions(inputs.model_options)
  const engine = hasOwn(opts, 'engine') ? opts.engine : inputs.engine
  const resolution = hasOwn(opts, 'resolution') ? opts.resolution : inputs.resolution
  const fabricCall = fabric(linked(resolution) ? UNLISTED : sentAsIs(resolution))
  if (linked(engine)) return [fabricCall, kling]
  // _lipsync_resolve_engine: "fabric"/"sync" win; else a video → sync, otherwise fabric.
  const eng = engine === 'fabric' || engine === 'sync' ? engine : (pyTruthy(opts.face_video) ? 'sync' : 'fabric')
  return [eng === 'sync' ? kling : fabricCall]
}

/**
 * The call(s) a node's widgets can make. More than one when a linked setting
 * leaves the choice open; the price is the dearest.
 */
export function remoteVideoCalls(classType: string, inputs: Inputs): ClipCall[] | null {
  switch (classType) {
    // Veo3RemoteNode.execute sends prompt, aspect_ratio, image, negative_prompt
    // and seed — no duration, no generate_audio. google/veo-3's schema defaults:
    // duration 8, generate_audio true.
    case 'Veo3RemoteNode':
      return [{ endpoint: 'google/veo-3', seconds: 8, resolution: null, audio: true }]
    // KlingVideoRemoteNode.execute: "duration": int(duration); no `mode`, so the
    // schema default "standard" (720p). The schema accepts 5 or 10.
    case 'KlingVideoRemoteNode':
      return [{ endpoint: 'kwaivgi/kling-v2.1', seconds: lengthSent(inputs.duration, 10), resolution: '720p', audio: false }]
    // Seedance2RemoteNode.execute: "resolution": resolution (as-is), "duration":
    // int(duration). The schema accepts up to 15 s (-1 = the model picks).
    case 'Seedance2RemoteNode':
      return [{
        endpoint: 'bytedance/seedance-2.0',
        seconds: lengthSent(inputs.duration, 15),
        resolution: linked(inputs.resolution) ? UNLISTED : sentAsIs(inputs.resolution),
        audio: true,
      }]
    // Both call sync/lipsync-2-pro with the sound clip capped at 60 s.
    case 'LipsyncRemoteNode':
    case 'LipsyncNode':
      return [{ endpoint: 'sync/lipsync-2-pro', seconds: LIPSYNC_MAX_SECONDS, resolution: null, audio: false }]
    case 'LipSyncNode':
      return lipSyncCalls(inputs)
    default:
      return null
  }
}

/** Dollars for a node in REMOTE_VIDEO_NODE_CLASSES as configured (the dearest call it can make), or null. */
export function remoteVideoNodeUsd(classType: string, inputs: Inputs): number | null {
  const calls = remoteVideoCalls(classType, inputs)
  if (!calls) return null
  let usd = 0
  for (const c of calls) {
    const one = clipUsd(c.endpoint, c)
    if (one == null) return null
    usd = Math.max(usd, one)
  }
  return usd
}
