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
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny'
import { annotatedFilepath, engineFolder, resolveInside } from '../native/paths'
import {
  allotMediaFiles, gateNodeOrder, mediaFileKey, secondsPricedMedia, sourceAudioSeconds,
  type InputSeconds, type MediaFileRef, type MediaSource,
} from '../../shared/pricing/clipSettings'
import { createGateReads, type GateReads } from './graphInputPixels'

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
  const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = (async () => {
      const track = kind === 'audio' ? await input.getPrimaryAudioTrack() : await input.getPrimaryVideoTrack()
      if (!track) return null
      const d = await track.computeDuration()
      return Number.isFinite(d) && d > 0 ? d : null
    })().catch(() => null)
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), opts.timeoutMs ?? MEDIA_READ_TIMEOUT_MS) })
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
