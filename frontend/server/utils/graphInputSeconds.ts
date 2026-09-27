/**
 * The measured length of a lip-sync node's media, for the hosted /prompt
 * gate's price (P5 fix round 1). The price reads it through priceGraph's
 * `inputSeconds`; what this can't measure is priced at the 60 s cap
 * (shared/pricing/clipSettings.ts billedSeconds).
 *
 * The sound (`audio`) is followed to its source:
 *  - LoadAudio → its file;
 *  - an Audio card → its `source` link when wired (followed on), else its
 *    `audio` file; a card with neither plays its 1 s placeholder silence;
 *  - MusicGen / Generate music → its `duration` widget (sourceAudioSeconds);
 *  - text to speech and anything else → not measured (60 s);
 *  - LipSyncNode's `model_options.audio`, when it is a `/view?…&type=input`
 *    link → that input file; an external URL → not measured.
 * Kling lip-sync bills the source video: LipSyncNode's
 * `model_options.face_video` is measured the same way.
 *
 * Files are measured with mediabunny, which reads the container's byte ranges
 * and never decodes: the primary audio (or video) track's duration. A file
 * over MAX_MEDIA_BYTES, a read slower than MEDIA_READ_TIMEOUT_MS, or anything
 * mediabunny can't read is not measured. Lip-sync media have their own
 * reserved read slots (LIPSYNC_MEDIA_READS), apart from the pictures', handed
 * out in a fixed order (gateNodeOrder → allotMediaFiles) that the canvas
 * badge mirrors, so the badge knows when a clip will be priced at the cap and
 * says "up to". The allotted files are read in parallel. The gate has already
 * checked the caller owns every file it names (validateGraphFileRefs, which
 * vets LipSyncNode's `/view` links too) before pricing.
 */
import { stat } from 'node:fs/promises'
import { ALL_FORMATS, BufferSource, FilePathSource, Input } from 'mediabunny'
import { annotatedFilepath, engineFolder, resolveInside } from '../native/paths'
import {
  allotMediaFiles, gateNodeOrder, mediaFileKey, secondsPricedMedia, sourceAudioSeconds,
  type InputSeconds, type MediaFileRef, type MediaSource,
} from '../../shared/pricing/clipSettings'
import { createGateReads, type GateReads } from './graphInputPixels'
import { readModelOptions } from '../../shared/pricing/videoSettings'
import { readViewRef } from '../../shared/pricing/clipSettings'
import { isShotDirected, resolveVideoModelId } from '../../shared/runner/eligibility'
import { SEEDANCE_REFERENCE_MAX_SECONDS, SEEDANCE_TOO_MANY_REFERENCES, SEEDANCE_TOO_MUCH_SOUND, SEEDANCE_TOO_MUCH_VIDEO, SEEDANCE_UNMEASURED_REFERENCE, type RequestProblem } from '../runner/requestRules'

type Prompt = Record<string, { class_type?: unknown; inputs?: unknown } | undefined>
export type MediaKind = 'audio' | 'video'

const MAX_HOPS = 8
/** Files larger than this are not read (priced at the cap). */
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024
/** A measurement slower than this is abandoned (priced at the cap). */
export const MEDIA_READ_TIMEOUT_MS = 10_000
/** An Audio card with no file and nothing wired plays this much silence (nodes_audio.py). */
const PLACEHOLDER_SECONDS = 1

/**
 * Seconds of the primary audio (or video) track of a media file, or null when
 * it is too big, too slow, has no such track, or can't be read.
 */
export async function mediaSeconds(
  path: string, kind: MediaKind,
  opts: { maxBytes?: number, timeoutMs?: number } = {},
): Promise<number | null> {
  try {
    const st = await stat(path)
    if (!st.isFile() || st.size > (opts.maxBytes ?? MAX_MEDIA_BYTES)) return null
  }
  catch { return null }
  return trackSeconds(new Input({ source: new FilePathSource(path), formats: ALL_FORMATS }), kind, opts.timeoutMs)
}

/**
 * Seconds of the primary audio (or video) track of media already in memory
 * (the runner's result store reads whole files), or null when it is over
 * `maxBytes`, too slow, has no such track, or can't be read.
 */
export async function mediaSecondsOfBytes(
  bytes: Uint8Array, kind: MediaKind,
  opts: { maxBytes?: number, timeoutMs?: number } = {},
): Promise<number | null> {
  return (await mediaInfoOfBytes(bytes, kind, opts))?.seconds ?? null
}

/** What a media file's primary audio (or video) track says about it. */
export interface MediaTrackInfo {
  seconds: number
  /** The video track's display size (after rotation); null for a sound. */
  width: number | null
  height: number | null
  /**
   * The video track's frames a second (its average packet rate over the first
   * 120 frames, read from the container, never decoded), when asked for
   * (`frameRate`: Topaz video upscale, F23); null for a sound, when not asked,
   * or when it can't be read.
   */
  fps?: number | null
}

/**
 * The length (and, for a video, the display size) of the primary track of
 * media already in memory, or null when it is over `maxBytes`, too slow, has
 * no such track, or can't be read. The runner's media hand-off
 * (server/runner/mediaInputs.ts) reads files this way.
 */
export async function mediaInfoOfBytes(
  bytes: Uint8Array, kind: MediaKind,
  opts: { maxBytes?: number, timeoutMs?: number, frameRate?: boolean } = {},
): Promise<MediaTrackInfo | null> {
  if (bytes.byteLength > (opts.maxBytes ?? MAX_MEDIA_BYTES)) return null
  const copy = bytes.slice()
  return trackInfo(new Input({ source: new BufferSource(copy.buffer), formats: ALL_FORMATS }), kind, opts.timeoutMs, opts.frameRate)
}

/** Frames looked at for a video's frame rate: enough for a steady average, without walking a long file. */
const FRAME_RATE_SAMPLE = 120

async function trackSeconds(input: Input, kind: MediaKind, timeoutMs?: number): Promise<number | null> {
  return (await trackInfo(input, kind, timeoutMs))?.seconds ?? null
}

async function trackInfo(input: Input, kind: MediaKind, timeoutMs?: number, frameRate?: boolean): Promise<MediaTrackInfo | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = (async (): Promise<MediaTrackInfo | null> => {
      const track = kind === 'audio' ? await input.getPrimaryAudioTrack() : await input.getPrimaryVideoTrack()
      if (!track) return null
      const d = await track.computeDuration()
      if (!(Number.isFinite(d) && d > 0)) return null
      if (!track.isVideoTrack()) return { seconds: d, width: null, height: null }
      const [w, h] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()])
      const info: MediaTrackInfo = { seconds: d, width: Number.isFinite(w) && w > 0 ? w : null, height: Number.isFinite(h) && h > 0 ? h : null }
      if (frameRate) {
        const rate = await track.computePacketStats(FRAME_RATE_SAMPLE).then(p => p.averagePacketRate, () => null)
        info.fps = typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null
      }
      return info
    })().catch(() => null)
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs ?? MEDIA_READ_TIMEOUT_MS) })
    return await Promise.race([work, late])
  }
  finally {
    clearTimeout(timer)
    try { input.dispose() } catch { /* already gone */ }
  }
}

/** A file to measure: an annotated engine value (LoadAudio, the Audio card), or a `/view` input name read literally. */
export type MediaFile = MediaFileRef

/** Seconds of an engine media file, resolved inside its engine folder; null when it can't be found or read. */
export async function engineMediaSeconds(file: MediaFile, kind: MediaKind): Promise<number | null> {
  let folder: string | null
  let name: string
  if (file.literalInput) { folder = engineFolder('input'); name = file.value }
  else {
    const a = annotatedFilepath(file.value)
    folder = engineFolder(a.type ?? 'input')
    name = a.name
  }
  if (!folder || !name) return null
  const path = resolveInside(folder, name)
  return path ? mediaSeconds(path, kind) : null
}

const inputsOf = (n: { inputs?: unknown } | undefined): Record<string, unknown> =>
  (n?.inputs && typeof n.inputs === 'object' && !Array.isArray(n.inputs) ? n.inputs as Record<string, unknown> : {})

/** Where a lip-sync node's sound or video comes from, as far as the graph says: a file to read, a known length, or nothing. */
export type MediaOrigin = { file: MediaFile } | { seconds: number } | null

/** Follow a media source through the graph (no reads): LoadAudio / Audio card files, MusicGen's length, an empty card's 1 s. */
export function mediaOrigin(prompt: Prompt, src: MediaSource): MediaOrigin {
  if (!src) return null
  if ('inputFile' in src) return { file: { value: src.inputFile, literalInput: true } }
  let link: unknown = src.link
  for (let hop = 0; hop < MAX_HOPS && Array.isArray(link); hop++) {
    const node = prompt[String(link[0])]
    const ct = node?.class_type
    const si = inputsOf(node)
    if (ct === 'Audio') {
      // execute: a wired `source` wins, then the file widget, else 1 s of silence.
      if (Array.isArray(si.source)) { link = si.source; continue }
      if (typeof si.audio === 'string' && si.audio) return { file: { value: si.audio, literalInput: false } }
      return { seconds: PLACEHOLDER_SECONDS }
    }
    if (ct === 'LoadAudio') return typeof si.audio === 'string' && si.audio ? { file: { value: si.audio, literalInput: false } } : null
    const n = typeof ct === 'string' ? sourceAudioSeconds(ct, si) : null
    return n == null ? null : { seconds: n }
  }
  return null
}

/** Node id → the measured lengths of each lip-sync node's media that this can see. */
export async function graphInputSeconds(
  prompt: Prompt,
  read: (file: MediaFile, kind: MediaKind) => Promise<number | null> = engineMediaSeconds,
  reads: GateReads = createGateReads(),
): Promise<Record<string, InputSeconds>> {
  const out: Record<string, InputSeconds> = {}
  if (!prompt || typeof prompt !== 'object') return out

  // 1. Every lip-sync node's media, in the gate's fixed order — no reads yet.
  const plan: Array<{ id: string, audio: MediaOrigin, video: MediaOrigin }> = []
  for (const id of gateNodeOrder(Object.keys(prompt))) {
    const node = prompt[id]
    const ct = node?.class_type
    if (typeof ct !== 'string') continue
    const media = secondsPricedMedia(ct, inputsOf(node))
    if (!media) continue
    plan.push({ id, audio: mediaOrigin(prompt, media.audio), video: mediaOrigin(prompt, media.video) })
  }

  // 2. The files that get a read: the first LIPSYNC_MEDIA_READS distinct ones.
  const keyOf = (o: MediaOrigin, kind: MediaKind) => (o && 'file' in o ? mediaFileKey(kind, o.file) : null)
  const allotted = allotMediaFiles(plan.flatMap(p => [keyOf(p.audio, 'audio'), keyOf(p.video, 'video')]).filter((k): k is string => k != null))

  // 3. Read them in parallel (memoised, in the media pool); the rest stay unmeasured (the cap).
  const lengthOf = (o: MediaOrigin, kind: MediaKind): Promise<number | null> => {
    if (!o) return Promise.resolve(null)
    if ('seconds' in o) return Promise.resolve(o.seconds)
    const key = mediaFileKey(kind, o.file)
    return allotted.has(key) ? reads.measure(key, () => read(o.file, kind), 'media') : Promise.resolve(null)
  }
  await Promise.all(plan.map(async (p) => {
    const [audio, video] = await Promise.all([lengthOf(p.audio, 'audio'), lengthOf(p.video, 'video')])
    const secs: InputSeconds = {}
    if (audio != null && audio > 0) secs.audio = audio
    if (video != null && video > 0) secs.video = video
    if (secs.audio != null || secs.video != null) out[p.id] = secs
  }))
  return out
}

/**
 * Seedance 2.0 reference-to-video takes at most 15 s of reference video in
 * all, and 15 s of reference sound (its schema; S1b fix rounds 1–2, ruling d).
 * Each GenerateVideoNode on seedance-2.0 whose options send references (no
 * first frame) has its `/view?…&type=input` references measured; a total over
 * 15 s is refused in plain words. Never drops a reference.
 *
 * A reference this can't measure (an external link, a file over the size
 * limit, one mediabunny can't read or that is too slow): `strict` (hosted —
 * the /prompt meter and the runner) refuses it, since its length can't be
 * checked; otherwise it isn't counted (the price already bills the 15 s
 * maximum, and fal refuses an over-long one).
 *
 * The /prompt gate reads engine input files (engineMediaSeconds); the runner
 * reads through its result store (runnerMediaReader).
 */
export async function seedanceReferenceSeconds(
  prompt: Prompt,
  read: (file: MediaFile, kind: MediaKind) => Promise<number | null> = engineMediaSeconds,
  opts: { strict?: boolean, reads?: GateReads, filmShots?: boolean } = {},
): Promise<RequestProblem[]> {
  const out: RequestProblem[] = []
  // With `reads` (the hosted gate, G1 follow-up): each distinct reference is
  // read once, and at most SEEDANCE_REFERENCE_READS per prompt, from their own
  // pool; one past the budget is left unread and refused (it can't be checked).
  const OVER = Symbol('over')
  const readOne = (name: string, kind: MediaKind): Promise<number | null | typeof OVER> => {
    const file = { value: name, literalInput: true }
    if (!opts.reads) return read(file, kind).catch(() => null)
    let ran = false
    return opts.reads.measure<number | typeof OVER>(mediaFileKey(kind, file), async () => {
      ran = true
      return (await read(file, kind).catch(() => null)) ?? -1
    }, 'references').then(v => (v == null ? (ran ? null : OVER) : v === -1 ? null : v))
  }
  for (const list of seedanceReferenceLists(prompt, !!opts.filmShots)) {
    const lengths = await Promise.all(list.names.map(name => (name ? readOne(name, list.kind) : Promise.resolve(null))))
    const problem = (message: string): RequestProblem => ({ nodeId: list.nodeId, classType: list.classType, input: 'model_options', message })
    if (lengths.some(s => s === OVER)) { out.push(problem(SEEDANCE_TOO_MANY_REFERENCES)); continue }
    if (opts.strict && lengths.some(s => s == null)) { out.push(problem(SEEDANCE_UNMEASURED_REFERENCE)); continue }
    const total = (lengths as (number | null)[]).reduce<number>((n, s) => n + (s ?? 0), 0)
    if (total > SEEDANCE_REFERENCE_MAX_SECONDS) out.push(problem(list.tooMuch))
  }
  return out
}

/**
 * Each Seedance 2.0 node's reference videos and sounds that would be sent
 * (no first frame, options not wired): per list, each element's `/view` input
 * name, or null where it isn't one (an external link, a refused path).
 * `filmShots` (the runner's own check only, Task 4 Ruling D): a shot-directed
 * Film a shot too, which the runner plans exactly as Generate a video. The
 * ComfyUI gate leaves it out, as before.
 */
function seedanceReferenceLists(prompt: Prompt, filmShots = false): { nodeId: string, classType: string, kind: MediaKind, tooMuch: string, names: (string | null)[] }[] {
  const out: { nodeId: string, classType: string, kind: MediaKind, tooMuch: string, names: (string | null)[] }[] = []
  if (!prompt || typeof prompt !== 'object') return out
  for (const [nodeId, node] of Object.entries(prompt)) {
    const classType = node?.class_type
    const inputs = inputsOf(node)
    if (classType !== 'GenerateVideoNode' && !(filmShots && classType === 'FilmShotNode' && isShotDirected(inputs))) continue
    if (resolveVideoModelId(inputs.model) !== 'seedance-2.0' || Array.isArray(inputs.model_options) || Array.isArray(inputs.image)) continue
    const options = readModelOptions(inputs.model_options)
    if (typeof options.image_url === 'string' && options.image_url) continue
    for (const [key, kind, tooMuch] of [
      ['video_urls', 'video', SEEDANCE_TOO_MUCH_VIDEO],
      ['audio_urls', 'audio', SEEDANCE_TOO_MUCH_SOUND],
    ] as const) {
      const list = options[key]
      if (!Array.isArray(list) || !list.length) continue
      out.push({
        nodeId, classType, kind, tooMuch,
        names: list.map((v) => {
          let r: ReturnType<typeof readViewRef> = null
          try { r = readViewRef(v) }
          catch { r = null }
          return r?.name && !r.refused ? r.name : null
        }),
      })
    }
  }
  return out
}

/** An input file name ("a.mp4", "sub/a.mp4") as the runner's store names it, or null if unsafe. */
function inputFileOf(name: string): { filename: string, subfolder: string, type: 'input' } | null {
  const parts = name.replace(/\\/g, '/').split('/')
  if (parts.some(p => !p || p === '.' || p === '..')) return null
  const filename = parts.pop()!
  return { filename, subfolder: parts.join('/'), type: 'input' }
}

/** The largest Seedance reference the runner reads to measure (fal's own limit is 50 MB of video in all). */
export const RUNNER_REFERENCE_MAX_BYTES = 64 * 1024 * 1024

/**
 * seedanceReferenceSeconds' reader for the runner: an input file (a `/view`
 * name, "sub/a.mp4" allowed) read through the runner's result store and
 * measured in memory, under RUNNER_REFERENCE_MAX_BYTES and the read timeout.
 */
export function runnerMediaReader(readFile: (f: { filename: string, subfolder: string, type: 'input' }) => Promise<Uint8Array>) {
  return async (file: MediaFile, kind: MediaKind): Promise<number | null> => {
    const f = inputFileOf(file.value)
    if (!f) return null
    let bytes: Uint8Array
    try { bytes = await readFile(f) }
    catch { return null }
    return mediaSecondsOfBytes(bytes, kind, { maxBytes: RUNNER_REFERENCE_MAX_BYTES })
  }
}

/**
 * The runner's check at the start of a run (engine.ts startRun, after the
 * ownership check and before any hold): every Seedance 2.0 reference file
 * must be the caller's own (`assertOwned`, hosted), and the references must
 * fit seedanceReferenceSeconds. The first problem, or null.
 */
export async function runnerReferenceProblems(
  prompts: Prompt[],
  o: {
    readFile: (f: { filename: string, subfolder: string, type: 'input' }) => Promise<Uint8Array>
    strict: boolean
    assertOwned: (files: { filename: string, subfolder: string, type: 'input' }[]) => Promise<void>
  },
): Promise<RequestProblem | null> {
  for (const p of prompts) {
    const files = seedanceReferenceLists(p, true).flatMap(l => l.names)
      .map(n => (n ? inputFileOf(n) : null))
      .filter((f): f is NonNullable<typeof f> => f != null)
    if (files.length) await o.assertOwned(files)
    const problems = await seedanceReferenceSeconds(p, runnerMediaReader(o.readFile), { strict: o.strict, filmShots: true })
    if (problems.length) return problems[0]!
  }
  return null
}
