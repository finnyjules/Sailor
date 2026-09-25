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
 * mediabunny can't read is not measured. Every file read shares the /prompt's
 * budget and memo with graphInputPixels (createGateReads). The gate has
 * already checked the caller owns every file it names (validateGraphFileRefs,
 * which vets LipSyncNode's `/view` links too) before pricing.
 */
import { stat } from 'node:fs/promises'
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny'
import { annotatedFilepath, engineFolder, resolveInside } from '../native/paths'
import { secondsPricedMedia, sourceAudioSeconds, type InputSeconds, type MediaSource } from '../../shared/pricing/clipSettings'
import { createGateReads, type GateReads } from './graphInputPixels'

type Prompt = Record<string, { class_type?: unknown; inputs?: unknown } | undefined>
export type MediaKind = 'audio' | 'video'

const MAX_HOPS = 8
/** Files larger than this are not read (priced at the cap). */
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024
/** A measurement slower than this is abandoned (priced at the cap). */
export const MEDIA_READ_TIMEOUT_MS = 3000
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
export interface MediaFile { value: string, literalInput: boolean }

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

/** Node id → the measured lengths of each lip-sync node's media that this can see. */
export async function graphInputSeconds(
  prompt: Prompt,
  read: (file: MediaFile, kind: MediaKind) => Promise<number | null> = engineMediaSeconds,
  reads: GateReads = createGateReads(),
): Promise<Record<string, InputSeconds>> {
  const out: Record<string, InputSeconds> = {}
  if (!prompt || typeof prompt !== 'object') return out
  const file = (f: MediaFile, kind: MediaKind) =>
    reads.measure(`${kind}:${f.literalInput ? 'view' : 'engine'}:${f.value}`, () => read(f, kind))

  const measureSource = async (src: MediaSource, kind: MediaKind): Promise<number | null> => {
    if (!src) return null
    if ('inputFile' in src) return file({ value: src.inputFile, literalInput: true }, kind)
    let link: unknown = src.link
    for (let hop = 0; hop < MAX_HOPS && Array.isArray(link); hop++) {
      const node = prompt[String(link[0])]
      const ct = node?.class_type
      const si = inputsOf(node)
      if (ct === 'Audio') {
        // execute: a wired `source` wins, then the file widget, else 1 s of silence.
        if (Array.isArray(si.source)) { link = si.source; continue }
        if (typeof si.audio === 'string' && si.audio) return file({ value: si.audio, literalInput: false }, kind)
        return PLACEHOLDER_SECONDS
      }
      if (ct === 'LoadAudio') return typeof si.audio === 'string' && si.audio ? file({ value: si.audio, literalInput: false }, kind) : null
      return typeof ct === 'string' ? sourceAudioSeconds(ct, si) : null
    }
    return null
  }

  for (const [id, node] of Object.entries(prompt)) {
    const ct = node?.class_type
    if (typeof ct !== 'string') continue
    const media = secondsPricedMedia(ct, inputsOf(node))
    if (!media) continue
    const audio = await measureSource(media.audio, 'audio')
    const video = await measureSource(media.video, 'video')
    const secs: InputSeconds = {}
    if (audio != null && audio > 0) secs.audio = audio
    if (video != null && video > 0) secs.video = video
    if (secs.audio != null || secs.video != null) out[id] = secs
  }
  return out
}
