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
 * sync-3 (Lip-sync a character's runner-only engine, model line-up F22) bills
 * the clip it makes (sync.so's sync mode guide): the sound's length for loop,
 * bounce and remap, the shorter of sound and video for cut off; "silence" is
 * refused. The runner measures both files before the call and refuses a clip
 * over 60 s, so the 60 s figure (the hold, and the badge's "up to") is never
 * below the charge.
 *
 * Topaz video upscale on fal (Enhance a video while topaz-video is on, model
 * line-up F23; nodePrice.ts FAMILY_PRICED_CLASSES) bills every second of the
 * video by the output's size band and frame rate: `topazVideoCalls`, from the
 * video the runner measured (its length, size and frame rate). Unmeasured,
 * the ceiling: 60 s, above 1080p, 60 fps.
 *
 * Fail-safe: a linked setting, or a value the service doesn't list, is priced
 * at its dearest; an unreadable length at the longest the service accepts.
 * Pure; relative imports only.
 */
import { creditsForUsd } from './markup'
import { clipRate, clipUsd } from './clipRates'
import { readModelOptions } from './videoSettings'
import { pyIntOf, pyTruthy } from '../runner/pyText'
import { SYNC_3_ENGINE, lipSyncSyncMode, sync3ModeRefusal } from '../runner/lipSync'
import {
  TOPAZ_VIDEO_ENDPOINT, TOPAZ_VIDEO_MAX_SECONDS, TOPAZ_VIDEO_UNKNOWN_SETTING, topazVideoPlan, topazVideoRateKey, topazVideoTarget, topazVideoTargetFps,
} from '../runner/topazVideo'

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
  /**
   * The video's display size and frame rate, where the runner measured them
   * (Topaz video upscale, model line-up F23: the price reads the output's size
   * band and frame rate, shared/runner/topazVideo.ts). Absent or null = not measured.
   */
  videoWidth?: number | null
  videoHeight?: number | null
  videoFps?: number | null
}

/**
 * Seconds billed for a measured clip: whole seconds rounded up (the services
 * bill by the second), never above the 60 s cap. Not measured: the cap.
 */
export function billedSeconds(measured: number | null | undefined, cap: number = LIPSYNC_MAX_SECONDS): number {
  if (typeof measured !== 'number' || !Number.isFinite(measured) || !(measured > 0)) return cap
  return Math.min(Math.ceil(Math.round(measured * 1e6) / 1e6), cap)
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

/**
 * Python's `urllib.parse.parse_qs(qs)` (3.12, keep_blank_values=False,
 * separator "&"), for reading `/view?` links exactly as the engine does:
 *  - split on "&" only (";" is not a separator);
 *  - a piece with no "=" is dropped, and so is one whose RAW value is empty
 *    ("filename=" — the blank-value rule that `URLSearchParams` does not have);
 *  - name and value: "+" → space, then percent-decoded (`unquote`).
 * Returns key → its non-blank values in order, or null when a name or value
 * can't be decoded the way Python would (invalid UTF-8 after percent-decoding:
 * Python substitutes U+FFFD, which is refused here rather than guessed).
 */
export function pyParseQs(qs: string): Map<string, string[]> | null {
  const out = new Map<string, string[]>()
  for (const piece of qs.split('&')) {
    if (!piece) continue
    const eq = piece.indexOf('=')
    if (eq < 0) continue
    const rawValue = piece.slice(eq + 1)
    if (!rawValue.length) continue
    const name = pyUnquote(piece.slice(0, eq))
    const value = pyUnquote(rawValue)
    if (name == null || value == null) return null
    const list = out.get(name)
    if (list) list.push(value)
    else out.set(name, [value])
  }
  return out
}

/** `unquote(s.replace('+', ' '))`: each run of %XX bytes decoded as UTF-8; a malformed %… kept as-is; invalid UTF-8 → null. */
function pyUnquote(s: string): string | null {
  const t = s.replace(/\+/g, ' ')
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let out = ''
  let i = 0
  while (i < t.length) {
    const bytes: number[] = []
    while (i + 2 < t.length && t[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(t.slice(i + 1, i + 3), 16))
      i += 3
    }
    if (bytes.length) {
      try { out += decoder.decode(new Uint8Array(bytes)) }
      catch { return null }
      continue
    }
    out += t[i]
    i++
  }
  return out
}

/** A `/view?` link read the way the engine reads it, and whether it is safe to vet. */
export interface ViewRefRead {
  /** The input-folder file the engine opens (parse_view_ref), or null when it opens none. */
  name: string | null
  /**
   * Why the link is refused outright, or null: it names `filename`, `type` or
   * `subfolder` more than once (with a value), or can't be decoded as Python
   * would — two parsers could then disagree about which file it means.
   */
  refused: string | null
}

export const VIEW_REF_REFUSED = 'A file link (/view?…) names its file, folder or type more than once, or can\'t be read, so Sailor can\'t check which file it opens. Remove the extra filename=, type= or subfolder=.'

/**
 * THE `/view?` link parser for the engine's input files — every ownership
 * check, measurement and price reads links through this, so they all agree
 * with video_models.py `parse_view_ref`:
 *   `urlsplit(src).query` (tab, CR and LF removed; "#…" dropped) →
 *   `parse_qs` → `type` must be "input" → `filename`, its first value, with
 *   no "/", "\" or "..".
 * Null for anything that isn't a string starting "/view?".
 */
export function readViewRef(src: unknown): ViewRefRead | null {
  if (typeof src !== 'string' || !src.startsWith('/view?')) return null
  // urlsplit removes these three characters anywhere in the URL, then splits "#", then "?".
  const url = src.replace(/[\t\r\n]/g, '')
  const noFragment = url.split('#')[0]!
  const q = pyParseQs(noFragment.slice(noFragment.indexOf('?') + 1))
  if (!q) return { name: null, refused: VIEW_REF_REFUSED }
  const refused = ['filename', 'type', 'subfolder'].some(k => (q.get(k)?.length ?? 0) > 1) ? VIEW_REF_REFUSED : null
  const first = (k: string) => q.get(k)?.[0] ?? ''
  if (first('type') !== 'input') return { name: null, refused }
  const name = first('filename')
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return { name: null, refused }
  return { name, refused }
}

/**
 * Thrown by parseViewRef for a link that must be refused (see
 * ViewRefRead.refused). Shaped like server/utils/requestMeter.ts's
 * MeterRefusalError (h3 recognises an error by `constructor.__h3_error__`, not
 * by class), so when it escapes the /prompt gate's ownership check
 * (validateGraphFileRefs → extractFileRefs) the caller gets a 403 with this
 * plain message — fail closed, no hold taken, the engine never touched.
 */
export class ViewRefRefusedError extends Error {
  static __h3_error__ = true
  statusCode = 403
  statusMessage: string
  fatal = false
  unhandled = false
  constructor(message: string) {
    super(message)
    this.name = 'ViewRefRefusedError'
    this.statusMessage = message
  }
}

/**
 * The input file a `/view?` link makes the engine open, or null — for the
 * ownership check. A link that must be refused THROWS ViewRefRefusedError, so
 * no caller can quietly vet nothing (the gate turns it into a plain 403).
 */
export function parseViewRef(src: unknown): string | null {
  const r = readViewRef(src)
  if (!r) return null
  if (r.refused) throw new ViewRefRefusedError(r.refused)
  return r.name
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
  // A link the gate refuses is never measured (the run is refused before pricing matters).
  const file = (v: unknown): MediaSource => { const r = readViewRef(v); return r?.name && !r.refused ? { inputFile: r.name } : null }
  // execute: `audio_url = … if audio is not None else _resolve(audio_src)`.
  return { audio: wired ?? file(opts.audio), video: file(opts.face_video) }
}

/**
 * Lip-sync media files the /prompt gate reads per prompt: their OWN reserved
 * slots, apart from the pictures' (graphInputPixels.ts MAX_MEASURED_FILES), so
 * a graph full of pictures can't use them up. Files past the budget are priced
 * at the 60 s cap; which files get a slot is fixed by `allotMediaFiles`, so the
 * canvas badge can tell (and say "up to").
 */
export const LIPSYNC_MEDIA_READS = 8

/** A media file the gate reads: an annotated engine value (LoadAudio, the Audio card), or a `/view` input name read literally. */
export interface MediaFileRef { value: string, literalInput: boolean }

/** The one key for a media file read — the gate's memo and slot, and the badge's prediction of it. */
export function mediaFileKey(kind: 'audio' | 'video', f: MediaFileRef): string {
  return `${kind}:${f.literalInput ? 'view' : 'engine'}:${f.value}`
}

/**
 * The order the gate walks a graph's lip-sync nodes in, and so hands out
 * media slots: integer ids ascending, then any other id in string order.
 */
export function gateNodeOrder(ids: Iterable<string>): string[] {
  const isInt = (s: string) => /^\d+$/.test(s)
  return [...ids].sort((a, b) => {
    const ia = isInt(a); const ib = isInt(b)
    if (ia && ib) return Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0)
    if (ia !== ib) return ia ? -1 : 1
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/** The media file keys that get a read: the first LIPSYNC_MEDIA_READS distinct ones, in gate order. */
export function allotMediaFiles(orderedKeys: Iterable<string>, max: number = LIPSYNC_MEDIA_READS): Set<string> {
  const out = new Set<string>()
  for (const k of orderedKeys) {
    if (out.size >= max) break
    out.add(k)
  }
  return out
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

/** The fal endpoint LipSyncNode's sync-3 engine calls (server/runner/generators/sync3.ts). */
export const SYNC_3_ENDPOINT = 'fal-ai/sync-lipsync/v3'

/**
 * The Lip-Sync Studio's price hint for sync-3 (final fix F8): 30 seconds of
 * the video it makes, read from its rate card (clipRates.ts), in dollars, or
 * in credits in hosted mode (what is charged), so it follows the card at the
 * next rate change.
 */
export function sync3PriceHint(opts: { hosted?: boolean } = {}): { text: string, title: string } {
  const usd = (seconds: number) => clipUsd(SYNC_3_ENDPOINT, { seconds, resolution: null, audio: false }) ?? 0
  if (opts.hosted) {
    return { text: `~${creditsForUsd(usd(30))} credits / 30s`, title: `sync-3 costs ${creditsForUsd(usd(60))} credits per minute of video it makes` }
  }
  const dollars = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`
  return { text: `~${dollars(usd(30))} / 30s`, title: `sync-3 bills ${dollars(usd(60))} per minute of video it makes` }
}

/**
 * sync-3's call as the runner sends it: the clip it makes, from the measured
 * sound (and video, for cut off); unmeasured, the 60 s cap. A sync mode it
 * isn't run with is refused.
 */
function sync3Calls(inputs: Inputs, measured: InputSeconds): ClipCall[] | { refused: string } {
  const mode = lipSyncSyncMode(inputs)
  const refused = sync3ModeRefusal(mode)
  if (refused) return { refused }
  const audio = billedSeconds(measured.audio)
  const seconds = mode === 'cut_off' ? Math.min(audio, billedSeconds(measured.video)) : audio
  return [{ endpoint: SYNC_3_ENDPOINT, seconds, resolution: null, audio: false }]
}

function lipSyncCalls(inputs: Inputs, measured: InputSeconds): ClipCall[] | { refused: string } {
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
  // sync-3 runs only in the runner (the ComfyUI path refuses it, shared/runner/blockedModels.ts).
  if (engine === SYNC_3_ENGINE) return sync3Calls(inputs, measured)
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

// ── Topaz video upscale (Enhance a video while topaz-video is on, F23) ────

export { TOPAZ_VIDEO_ENDPOINT }

/**
 * Topaz's call as the runner sends it (server/runner/generators/topazVideo.ts):
 * the measured video's seconds (whole seconds rounded up, 60 at most), at the
 * output's size band and frame rate (shared/runner/topazVideo.ts). What
 * wasn't measured prices at the top: 60 s, "4k", a high frame rate — the
 * hold for a node with no record, and the badge's "up to" (the canvas can't
 * read the video). A setting or video Topaz can't take is refused, with the
 * words the runner refuses it with.
 */
export function topazVideoCalls(inputs: Inputs, measured: InputSeconds = {}): ClipCall[] | { refused: string } {
  const sized = typeof measured.videoWidth === 'number' && typeof measured.videoHeight === 'number'
  if (!sized) {
    // No size (with or without a length): the whole ceiling, 60 s at the top band, doubled — so
    // "unmeasured" is never below any charge (F23 fix round 1) — unless the node's own settings can't be read.
    if (topazVideoTarget(inputs) == null || topazVideoTargetFps(inputs) === undefined) return { refused: TOPAZ_VIDEO_UNKNOWN_SETTING }
    return [{ endpoint: TOPAZ_VIDEO_ENDPOINT, seconds: TOPAZ_VIDEO_MAX_SECONDS, resolution: topazVideoRateKey('4k', true), audio: false }]
  }
  const seconds = billedSeconds(measured.video, TOPAZ_VIDEO_MAX_SECONDS)
  const p = topazVideoPlan(inputs, { width: measured.videoWidth, height: measured.videoHeight, fps: measured.videoFps })
  if ('refused' in p) return p
  return [{ endpoint: TOPAZ_VIDEO_ENDPOINT, seconds, resolution: topazVideoRateKey(p.band, p.highFps), audio: false }]
}

/** Dollars for Topaz's call as configured and measured, or the refusal. */
export function topazVideoUsd(inputs: Inputs, measured: InputSeconds = {}): number | { refused: string } {
  const calls = topazVideoCalls(inputs, measured)
  if ('refused' in calls) return calls
  return clipUsd(calls[0]!.endpoint, calls[0]!)!
}
