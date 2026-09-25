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
 * Lip-sync length (ruling on open question 1, P5 fix round 1): the price is
 * the clip's own length, rounded up to whole seconds, where the caller
 * measured it (`InputSeconds`: the hosted /prompt gate reads the sound file,
 * and for Kling lip-sync the source video; the badge uses what the canvas
 * knows). What can't be measured is priced at 60 s, the audio cap the nodes
 * encode with (`_audio_dict_to_wav_data_url(audio, max_seconds=60)`) and
 * Fabric's longest output — and 60 s is the most any clip is billed. The badge
 * says "up to" when it shows that ceiling, so it is never below the charge.
 * sync.so's "silence" mode (and a linked sync mode) is refused.
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
 * The longest sound clip a lip-sync node bills: every lip-sync `execute`
 * encodes a wired clip with `_audio_dict_to_wav_data_url(audio, max_seconds=60)`
 * (nodes_replicate.py LipsyncRemoteNode, LipsyncNode, LipSyncNode), and 60 s
 * is Fabric's longest output ("60s cap matches Fabric's max output length",
 * GenerateVideoNode.execute). A clip the caller couldn't measure is priced at it.
 */
export const LIPSYNC_MAX_SECONDS = 60

/**
 * What the caller measured about a lip-sync node's media before the run, in
 * seconds (P5 fix round 1): the sound clip (`audio`) and, for the Kling
 * engine, the source video (`video`). The hosted /prompt gate reads the files
 * (server/utils/graphInputSeconds.ts); the canvas badge passes what the card
 * knows. Absent or null = not measured.
 */
export interface InputSeconds {
  audio?: number | null
  video?: number | null
}

/**
 * Seconds billed for a measured clip: whole seconds rounded up (the services
 * bill by the second), never above the 60 s cap. Not measured: the cap.
 */
export function billedSeconds(measured: number | null | undefined): number {
  if (typeof measured !== 'number' || !Number.isFinite(measured) || !(measured > 0)) return LIPSYNC_MAX_SECONDS
  return Math.min(Math.ceil(Math.round(measured * 1e6) / 1e6), LIPSYNC_MAX_SECONDS)
}

/**
 * sync.so's modes that never bill more than the sound clip: `loop`, `bounce`
 * and `remap` fit the video to the sound, `cut_off` stops at the shorter one.
 * `silence` pads the sound to the VIDEO's length — a URL whose length the
 * price can't see — so it is refused, as is a mode that is linked (unknown
 * until the run) or one the node doesn't offer.
 */
const SYNC_MODES_PRICED = ['loop', 'bounce', 'cut_off', 'remap']

/** Why a sync.so node can't be priced, or null when its sync mode is fine. */
function syncModeRefusal(v: unknown): string | null {
  if (linked(v)) return 'the lip-sync mode must be set on the node, not linked: the price depends on it'
  if (v === undefined || (typeof v === 'string' && SYNC_MODES_PRICED.includes(v))) return null
  if (v === 'silence') return 'the lip-sync mode "silence" can\'t be priced: it bills the whole source video, whose length is unknown. Choose loop, bounce, cut off or remap'
  return 'the lip-sync mode is not one Sailor can price. Choose loop, bounce, cut off or remap'
}

/** The name in a `/view?filename=X&type=input` link (video_models.py parse_view_ref), or null for anything else. */
export function parseViewRef(src: unknown): string | null {
  if (typeof src !== 'string' || !src.startsWith('/view?')) return null
  const q = new URLSearchParams(src.slice('/view?'.length).split('#')[0])
  if ((q.get('type') ?? '') !== 'input') return null
  const name = q.get('filename') ?? ''
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null
  return name
}

/** Where a lip-sync node's media comes from: a link to follow, an input file, or nothing the price can read. */
export type MediaSource = { link: unknown[] } | { inputFile: string } | null

/**
 * The media a lip-sync node's price depends on, as its `execute` resolves it:
 *  - `audio`: a wired `audio` port wins (all three nodes); otherwise
 *    LipSyncNode's `model_options.audio` — a `/view?…&type=input` link names an
 *    input file; anything else (an external URL, a data URL) isn't measured;
 *  - `video`: LipSyncNode's `model_options.face_video`, the same way (the
 *    Kling engine bills the source video's length).
 * Null for a class with no such media. A linked `model_options` names nothing.
 */
export function secondsPricedMedia(classType: string, inputs: Inputs): { audio: MediaSource, video: MediaSource } | null {
  if (classType !== 'LipSyncNode' && classType !== 'LipsyncNode' && classType !== 'LipsyncRemoteNode') return null
  const wired = linked(inputs.audio) ? { link: inputs.audio as unknown[] } : null
  if (classType !== 'LipSyncNode') return { audio: wired, video: null }
  const opts = linked(inputs.model_options) ? {} : readModelOptions(inputs.model_options)
  const file = (v: unknown): MediaSource => { const n = parseViewRef(v); return n ? { inputFile: n } : null }
  // execute: `audio_url = … if audio is not None else _resolve(audio_src)`.
  return { audio: wired ?? file(opts.audio), video: file(opts.face_video) }
}

/**
 * Seconds of sound an upstream node makes, where its settings say so:
 * MusicGen / Generate music render their `duration` widget (1–30 s,
 * MusicGenRemoteNode's IO.Int bounds; a linked or unreadable one prices at
 * 30). Null for anything else (a file is measured; text to speech is not
 * known, so it prices at the 60 s cap). The gate and the badge both read this.
 */
export function sourceAudioSeconds(classType: string, inputs: Inputs): number | null {
  if (classType !== 'MusicGenRemoteNode' && classType !== 'GenerateMusicNode') return null
  const n = linked(inputs.duration) ? null : pyInt(inputs.duration)
  return n == null ? 30 : Math.min(Math.max(n, 1), 30)
}

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

function lipSyncCalls(inputs: Inputs, measured: InputSeconds): ClipCall[] {
  // Fabric bills the sound clip; Kling lip-sync bills the source video (its output).
  const fabric = (resolution: string): ClipCall => ({ endpoint: 'veed/fabric-1.0', seconds: billedSeconds(measured.audio), resolution, audio: false })
  const kling: ClipCall = { endpoint: 'kwaivgi/kling-lip-sync', seconds: billedSeconds(measured.video), resolution: null, audio: false }
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
export function remoteVideoCalls(classType: string, inputs: Inputs, measured: InputSeconds = {}): ClipCall[] | { refused: string } | null {
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
    // Both call sync/lipsync-2-pro with the sound clip capped at 60 s: billed
    // for the clip, in the sync modes that never run past it.
    case 'LipsyncRemoteNode':
    case 'LipsyncNode': {
      const refused = syncModeRefusal(inputs.sync_mode)
      if (refused) return { refused }
      return [{ endpoint: 'sync/lipsync-2-pro', seconds: billedSeconds(measured.audio), resolution: null, audio: false }]
    }
    case 'LipSyncNode':
      return lipSyncCalls(inputs, measured)
    default:
      return null
  }
}

/**
 * Dollars for a node in REMOTE_VIDEO_NODE_CLASSES as configured (the dearest
 * call it can make), the refusal for a setting that can't be priced, or null
 * for a class not priced here. `measured`: the media lengths the caller read.
 */
export function remoteVideoNodeUsd(classType: string, inputs: Inputs, measured: InputSeconds = {}): number | { refused: string } | null {
  const calls = remoteVideoCalls(classType, inputs, measured)
  if (!calls || 'refused' in calls) return calls
  let usd = 0
  for (const c of calls) {
    const one = clipUsd(c.endpoint, c)
    if (one == null) return null
    usd = Math.max(usd, one)
  }
  return usd
}
