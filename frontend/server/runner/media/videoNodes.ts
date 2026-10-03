/**
 * The video nodes, computed here (step 3, R5.4, family `media-video`),
 * exactly as comfy_extras/nodes_video.py runs them. A video file stays a
 * `files` value (Python's VideoFromFile is the file itself); a video a node
 * assembles is a `video` value (VideoFromComponents: its kept frames, its
 * sound and its rate, encoded only when saved or shown); a frame batch is a
 * `frames` value (R5.2, server/media/values.ts). Every probe, decode, copy
 * and encode goes through the media module, into a folder of the job's own,
 * then into the store by path (`saveAssetFromPath`).
 *
 *   LoadVideo          — execute (:188-190): the file as it is, no work. Its
 *                        validate_inputs (:201-204, "Invalid video file") is
 *                        the start-of-run check `loadVideoStartProblems`,
 *                        which also refuses a file with no picture in it (or
 *                        over the caps) before anything runs.
 *   GetVideoComponents — execute (:162-164) → get_components_internal
 *                        (video_types.py:247-310). Of a file: its frames kept
 *                        as one FFV1 batch in one job (keepVideoFrames), its
 *                        last sound stream as an exact float WAV ('fltp' and
 *                        Python's skip rule), and float(average_rate or 1).
 *                        No sound gives slot 1 an empty sound (Python's None).
 *                        Of a made video: its own parts, no work.
 *   CreateVideo        — execute (:131-135): a `video` value naming the frame
 *                        batch, the sound and Fraction(fps), no work.
 *   SaveVideo          — execute (:88-114) → save_to. A file with `format`
 *                        auto or its own container and `codec` auto or its own
 *                        codec: a stream copy (copyVideo) into
 *                        `<prefix>_<nnnnn>_.mp4`, the source's tags kept and the
 *                        prompt and workflow added. Otherwise the file is
 *                        decoded into its parts first, as Python does, and
 *                        encoded as a made video. A made video: H.264 at
 *                        Fraction(round(fps · 1000), 1000), PYAV_H264_DEFAULT,
 *                        its sound cut to the frames as AAC (madeVideoSoundCut).
 *   PreviewVideo       — execute (:277-292, step 4 C4): Save video with no
 *                        format or codec into temp as `preview_video_<nnnnn>_.mp4`,
 *                        no tags added (what it hands on, nothing may read).
 *   Video (card)       — execute (:345-385), VIDEO_CARD_MEDIA_RULE: `source`
 *                        wins, then `file`, else ui `{ images: [] }`. A file
 *                        video is shown as the file itself, as the runner did
 *                        before (Python writes a stream-copied temp preview:
 *                        the same pictures and sound). A made video is encoded
 *                        to a temp preview `preview_video_<nnnnn>_.mp4`. With
 *                        `export` on, a copy (a stream copy of a file, an
 *                        encode of a made video) is saved into output under
 *                        `filename_prefix` and shown (Python writes the temp
 *                        preview too, then shows the copy: the runner skips
 *                        the preview no one sees, as the Audio card does). The
 *                        card calls save_to with no tags: only a file's own.
 *
 * An odd width or height of a made video fails before any work (libx264
 * refuses it in Python). A frame batch of no frames can't reach a save:
 * Get video components fails plainly where Python's batch would be empty.
 *
 * Free: no price, no hold, no charge. Get video components, Save video and
 * the card count as work; Load video and Create video only hand things on.
 */
import { join } from 'node:path'
import { isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { pyFloatOf, pyTruthy } from '#shared/runner/pyText'
import { MEDIA_WORDS } from '#shared/runner/media'
import { VIDEO_CARD_MEDIA_RULE, runnerRuleFor } from '#shared/runner/eligibility'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { parseInputFileRef } from '../inputs'
import { SAVE_NOT_A_FILE, SAVE_OUTSIDE } from '../results'
import { asciiJson, saveImagePrefix } from '../cards/saveImage'
import { copyVideo, pyStreamRateOf } from '../../media/encode'
import { MediaError, mediaTempDir, removeMediaTempDir } from '../../media/run'
import { ffprobeJson, type MediaProbe } from '../../media/probe'
import type { DecodedSound } from '../../media/decode'
import {
  dropVideoFile, encodeVideoParts, keepSound, keepVideoFrames, probeVideoFile, soundNoteOf, videoFileFor, videoSoundOf,
  type MediaValueIO,
} from '../../media/values'

/** LoadVideo's validate_inputs ("Invalid video file: …"), in plain words. */
export const VIDEO_FILE_MISSING = 'A video this workflow needs is missing. Load it again.'
/** A video node with no video wired in (or a wire that brought none). */
export const NO_VIDEO_WIRED = 'There is no video wired in'
/** Create video with no frames wired in. */
export const NO_FRAMES_WIRED = 'There are no frames wired in'
/** A video node run where it can't reach the video tools' files (a live preview). */
export const VIDEO_NEEDS_RUN = 'Video can only be worked on when the workflow runs'
/** A stream the MP4 muxer doesn't take (PyAV: "'mp4' format does not support 'prores' codec"). */
export const VIDEO_NOT_MP4 = 'This video can’t go into an MP4 file as it is'
/** Create video's rate, where Python's Fraction(fps) can't be made. */
export const VIDEO_BAD_FPS = 'This frame rate can’t be used for a video'
/** Save failures in plain words, by cause: only a name problem asks for another name. */
export const VIDEO_SAVE_BAD_NAME = 'The video couldn’t be saved under this file name. Try a shorter, plainer name.'
export const VIDEO_SAVE_NO_ROOM = 'The video couldn’t be saved: the server has no room left.'
export const VIDEO_SAVE_FAILED = 'The video couldn’t be saved.'

/** A save failure's plain words by its cause; the file system's own words (the server's folders) are never shown. */
export function videoSaveWords(e: unknown): string {
  if (e instanceof Error && (e.message === SAVE_OUTSIDE || e.message === SAVE_NOT_A_FILE)) return e.message
  const code = (e as NodeJS.ErrnoException | null)?.code
  if (code === 'ENAMETOOLONG' || code === 'EINVAL' || code === 'EILSEQ') return VIDEO_SAVE_BAD_NAME
  if (code === 'ENOSPC' || code === 'EDQUOT') return VIDEO_SAVE_NO_ROOM
  return VIDEO_SAVE_FAILED
}

/**
 * The codecs an MP4 takes as they are (libavformat's mp4 tags, the ones a
 * person's video can hold): a stream copy that fails with another codec in
 * it failed for that reason, and says so.
 */
const MP4_CODECS: ReadonlySet<string> = new Set([
  'h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg4', 'mpeg2video', 'mpeg1video', 'mjpeg', 'png', 'vc1',
  'aac', 'mp3', 'mp2', 'mp1', 'ac3', 'eac3', 'opus', 'flac', 'alac', 'vorbis', 'dts', 'truehd', 'mov_text',
])

/** Python's str() of a widget value. */
function pyStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (v === null || v === undefined) return 'None'
  return String(v)
}

function mediaOf(io: DeriveIO): MediaValueIO {
  if (!io.media || !io.saveAssetFromPath) throw new Error(VIDEO_NEEDS_RUN)
  return io.media
}

const entry = (f: OutputFile) => ({ filename: f.filename, subfolder: f.subfolder, type: f.type })

/** What a link brings (its value, or its files). */
function wired(ctx: PlanContext, link: ApiLink): RunnerValue {
  return ctx.valueFrom?.(link) ?? { kind: 'files', files: ctx.filesFrom(link) }
}

/** A value as Python holds a VIDEO: a made video, or a file video (its first file); null for none. */
function videoOf(v: RunnerValue): Extract<RunnerValue, { kind: 'video' }> | { kind: 'files'; files: OutputFile[] } | null {
  if (v.kind === 'video') return v
  if (v.kind === 'files' && v.files.length) return { kind: 'files', files: v.files }
  return null
}

/** Where a saved file goes and how Python names it (get_save_image_path with the video's size). */
interface SaveTarget { prefix: string; folder: 'output' | 'temp' }

async function saveFrom(io: DeriveIO, path: string, t: SaveTarget, w: number, h: number): Promise<OutputFile> {
  const { subfolder, filename } = saveImagePrefix(t.prefix, w, h, new Date())
  try {
    return await io.saveAssetFromPath!(path, { prefix: filename, ext: 'mp4', subfolder, folder: t.folder })
  }
  catch (e) {
    // The file system's own words name the server's folders: never shown on a node.
    throw new Error(videoSaveWords(e))
  }
}

/** Python's tags for save_to: `metadata` as SaveVideo makes it (extra_pnginfo's workflow, then the prompt), or none. */
function saveMetadata(io: DeriveIO, tags: boolean): { workflow?: unknown; prompt: unknown } | null {
  if (!tags) return null
  return { ...(io.runWorkflow != null ? { workflow: io.runWorkflow } : {}), prompt: io.runPrompt }
}

/**
 * save_to of a VIDEO into `t` (SaveVideo, and the card's preview and export):
 * a made video encoded; a file copied as it is when Python reuses its
 * streams (format auto or its own container, codec auto or its own), else
 * decoded into its parts and encoded. `tags`: SaveVideo's prompt and workflow
 * (the card writes none). Returns the saved file.
 */
export async function saveVideoFile(
  io: DeriveIO, value: RunnerValue,
  o: SaveTarget & { format: string; codec: string; tags: boolean },
): Promise<OutputFile> {
  const media = mediaOf(io)
  const video = videoOf(value)
  if (!video) throw new Error(NO_VIDEO_WIRED)
  const meta = saveMetadata(io, o.tags)
  // VideoFromComponents.save_to writes json.dumps(value) for every tag.
  const componentsTags = meta ? Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, asciiJson(v)])) : undefined
  if (video.kind === 'video') {
    const { w, h } = video.frames
    // libx264 refuses an odd size in Python: failed here before any work.
    if (w % 2 || h % 2) throw new MediaError('oddSize')
    const made = await videoFileFor(video, media, componentsTags ? { metadata: componentsTags } : {})
    try { return await saveFrom(io, made.path, o, w, h) }
    finally { await dropVideoFile(made) }
  }
  const file = video.files[0]!
  const p = await probeVideoFile(file, media)
  const v = p.video[0]!
  const reuse = (o.format === 'auto' || p.formatName.split(',').includes(o.format)) && (o.codec === 'auto' || o.codec === v.codec)
  if (reuse) {
    // VideoFromFile.save_to: a string tag as it is, anything else as json.dumps.
    const copyTags = meta ? Object.fromEntries(Object.entries(meta).map(([k, x]) => [k, typeof x === 'string' ? x : asciiJson(x)])) : null
    const work = await mediaTempDir()
    try {
      const out = join(work, 'video.mp4')
      try {
        await copyVideo({ probe: p, out, metadata: copyTags, userId: media.userId, signal: media.signal, outRoots: [work] })
      }
      catch (e) {
        if (e instanceof MediaError && e.word === 'failed' && await holdsOtherCodecs(p, media)) throw new Error(VIDEO_NOT_MP4)
        throw e
      }
      return await saveFrom(io, out, o, v.w, v.h)
    }
    finally { await removeMediaTempDir(work) }
  }
  // Not reused: get_components_internal, then VideoFromComponents.save_to (libx264 refuses an odd size).
  if (v.w % 2 || v.h % 2) throw new MediaError('oddSize')
  // The sound first decoded, then the frames kept: a failed or stopped sound step keeps nothing (fix round 1).
  let sound: DecodedSound | null = null
  const frames = await keepVideoFrames(p, media, { before: async () => { sound = await videoSoundOf(p, file, media) } })
  const avg = v.averageRate
  const rate = avg ? pyStreamRateOf(BigInt(avg.num), BigInt(avg.den)) : { num: 1, den: 1 }
  const path = await encodeVideoParts({ frames, sound, rate }, media, componentsTags)
  const made = { path, temporary: true }
  try { return await saveFrom(io, path, o, v.w, v.h) }
  finally { await dropVideoFile(made) }
}

/** Whether a file holds a picture, sound or subtitle stream whose codec the MP4 muxer doesn't take (MP4_CODECS). */
async function holdsOtherCodecs(p: MediaProbe, o: { userId: string | null; signal?: AbortSignal }): Promise<boolean> {
  if ([...p.video, ...p.sound].some(s => !MP4_CODECS.has(s.codec))) return true
  // Subtitles aren't in the probe: read them from the header.
  try {
    const j = await ffprobeJson(p.path, p.format, ['-show_streams'], { userId: o.userId, signal: o.signal })
    const streams = Array.isArray(j.streams) ? (j.streams as { codec_type?: unknown; codec_name?: unknown }[]) : []
    return streams.some(s => s.codec_type === 'subtitle' && !MP4_CODECS.has(String(s.codec_name)))
  }
  catch { return false }
}

// ── the loader ───────────────────────────────────────────────────────────────

/** The file a loader's `file` widget names, as get_annotated_filepath opens it; null when it names none it can open. */
function loaderFile(inputs: Record<string, unknown>): OutputFile | null {
  return isLink(inputs.file) ? null : parseInputFileRef(inputs.file)
}

/**
 * What a person's video file is to the runner, from its header, before the
 * run (R5.4 fix round 1): null when the runner can do what it's asked, else
 * the plain words and whether the workflow is left to the engine instead of
 * refused. A switched-on family must never make a working graph fail
 * (progress.md, R5.4 rulings), so:
 *   - a container or stream the build can't read (Python's PyAV may) is left
 *     to the engine, never refused;
 *   - for the Video card's export (`card`), anything it can't do is left to
 *     the engine: before R5.4 the runner ignored the export, and ComfyUI does
 *     it (or fails) as it always has. That includes a stream MP4 can't hold as
 *     it is (ProRes…), which the export's stream copy would need;
 *   - Load video's file with no picture in it, or over the caps (rule 6), is
 *     refused: Python fails on it too, at its first reader.
 */
export async function videoFileVerdict(
  access: MediaValueIO['access'], file: OutputFile,
  o: { userId: string | null; hosted: boolean; signal?: AbortSignal; card?: boolean },
): Promise<{ message: string; engine: boolean } | null> {
  let p: MediaProbe
  try { p = await probeVideoFile(file, { access, userId: o.userId, signal: o.signal, hosted: o.hosted }) }
  catch (e) {
    const word = e instanceof MediaError ? e.word : 'unreadable'
    const message = e instanceof MediaError ? e.message : MEDIA_WORDS.unreadable
    return { message, engine: !!o.card || word === 'unreadable' || word === 'failed' || word === 'toolsMissing' }
  }
  if (o.card && await holdsOtherCodecs(p, o)) return { message: VIDEO_NOT_MP4, engine: true }
  return null
}

/** LoadVideo: the file handed on as it is (Python's VideoFromFile does no work). */
export function planLoadVideo(ctx: PlanContext): NodePlan {
  const file = loaderFile(ctx.prompt[ctx.nodeId]!.inputs ?? {})
  if (!file) throw new Error(VIDEO_FILE_MISSING)
  return {
    kind: 'derive',
    async derive(io) {
      if (io.media && !(await io.media.access.exists(file))) throw new Error(VIDEO_FILE_MISSING)
      return { values: { 0: { kind: 'files', files: [file] } }, ui: null }
    },
  }
}

/**
 * The file a Video card on its media row shows, where it is known before the
 * run: its source's (a Load video's file, or another card's, followed back),
 * else its own. 'none' when it shows nothing (then a card reading it falls to
 * its own file, as Python's None does); 'unknown' when it comes from a node
 * that makes it in the run.
 */
function cardFile(prompt: ApiPrompt, id: string, depth = 0): OutputFile | 'none' | 'unknown' {
  const inputs = prompt[id]?.inputs ?? {}
  if (depth > 64) return 'unknown'
  const own = (): OutputFile | 'none' => {
    if (typeof inputs.file !== 'string' || inputs.file === '') return 'none'
    return parseInputFileRef(inputs.file) ?? 'none'
  }
  if (!isLink(inputs.source)) return own()
  const from = prompt[inputs.source[0]]
  if (!from || inputs.source[1] !== 0) return 'unknown'
  if (from.class_type === 'LoadVideo') return loaderFile(from.inputs ?? {}) ?? 'unknown'
  if (from.class_type === 'Video') {
    const up = cardFile(prompt, inputs.source[0], depth + 1)
    return up === 'none' ? own() : up
  }
  return 'unknown'
}

/**
 * The video checks before the run, the first node found or null:
 *   - LoadVideo's validate_inputs: a file that isn't there, or a name
 *     get_annotated_filepath can't open, is refused as ComfyUI refuses the
 *     prompt; then its file's verdict (`verdictOf`, videoFileVerdict);
 *   - (fix round 1) a Video card exporting on its media row (`families`):
 *     the file it will copy, where known before the run, and there when
 *     checked; whatever it can't do leaves the workflow to the engine;
 *   - (fix round 1) a Video card's file read by Get video components or
 *     Save video: one the build can't read leaves it to the engine too.
 * `engine: true`: once left the whole workflow to the engine; R11.9a (row 20) refuses it plainly
 * instead, saying what to change (engine.ts prepareStart, server/runner/stopGapWords.ts).
 */
export async function loadVideoStartProblems(
  prompt: ApiPrompt, exists: (f: OutputFile) => Promise<boolean>,
  verdictOf?: (f: OutputFile, o: { card: boolean }) => Promise<{ message: string; engine: boolean } | null>,
  families: ReadonlySet<RunnerFamily> = NO_FAMILIES,
): Promise<{ message: string; nodeId: string; classType: string; file?: string; engine?: true } | null> {
  for (const [nodeId, n] of Object.entries(prompt)) {
    if (n.class_type !== 'LoadVideo') continue
    const file = loaderFile(n.inputs ?? {})
    if (!file) return { message: VIDEO_FILE_MISSING, nodeId, classType: n.class_type }
    if (!(await exists(file))) return { message: VIDEO_FILE_MISSING, nodeId, classType: n.class_type, file: file.filename }
    const v = verdictOf ? await verdictOf(file, { card: false }) : null
    if (v) return { message: v.message, nodeId, classType: n.class_type, file: file.filename, ...(v.engine ? { engine: true as const } : {}) }
  }
  for (const [nodeId, n] of Object.entries(prompt)) {
    const inputs = n.inputs ?? {}
    if (n.class_type !== 'Video' || runnerRuleFor('Video', inputs, families) !== VIDEO_CARD_MEDIA_RULE || !pyTruthy(inputs.export)) continue
    const file = cardFile(prompt, nodeId)
    // A card showing nothing exports nothing; one whose file comes from the run is judged at its turn;
    // a file that isn't there fails at its turn, as Python's does.
    if (file === 'none' || file === 'unknown' || !(await exists(file))) continue
    const v = verdictOf ? await verdictOf(file, { card: true }) : null
    if (v) return { message: v.message, nodeId, classType: n.class_type, file: file.filename, engine: true }
  }
  // A Video card's file read by Get video components, Save video or Preview video (a Load video's is judged above):
  // one the build can't read leaves the workflow to the engine, as Load video's does.
  for (const [nodeId, n] of Object.entries(prompt)) {
    const link = n.inputs?.video
    if ((n.class_type !== 'GetVideoComponents' && n.class_type !== 'SaveVideo' && n.class_type !== 'PreviewVideo') || !isLink(link) || prompt[link[0]]?.class_type !== 'Video') continue
    const card = prompt[link[0]]!
    if (runnerRuleFor('Video', card.inputs ?? {}, families) !== VIDEO_CARD_MEDIA_RULE) continue
    const file = cardFile(prompt, link[0])
    if (file === 'none' || file === 'unknown' || !(await exists(file))) continue
    const v = verdictOf ? await verdictOf(file, { card: false }) : null
    if (v?.engine) return { message: v.message, nodeId, classType: n.class_type, file: file.filename, engine: true }
  }
  return null
}

// ── the parts ────────────────────────────────────────────────────────────────

/** GetVideoComponents: a file's frames, sound and rate (one job for the frames); a made video's own parts. */
export function planGetVideoComponents(ctx: PlanContext): NodePlan {
  const link = ctx.prompt[ctx.nodeId]!.inputs?.video
  if (!isLink(link)) throw new Error(NO_VIDEO_WIRED)
  return {
    kind: 'derive',
    async derive(io) {
      const media = mediaOf(io)
      const video = videoOf(wired(ctx, link))
      if (!video) throw new Error(NO_VIDEO_WIRED)
      if (video.kind === 'video') {
        // VideoFromComponents.get_components: its images, its audio as given, float(Fraction(fps)).
        const { file, count, w, h } = video.frames
        return {
          values: {
            0: { kind: 'frames', file, count, w, h },
            1: video.sound ? { kind: 'files', files: [video.sound.file], sound: video.sound.note } : { kind: 'files', files: [] },
            2: { kind: 'number', value: video.fps, int: false },
          },
          ui: null,
        }
      }
      const file = video.files[0]!
      const p = await probeVideoFile(file, media)
      // The sound step runs before the frames are kept (fix round 1): when it fails or is stopped, the
      // frames just written are removed and never count toward the run's kept total.
      let soundValue: RunnerValue = { kind: 'files', files: [] }
      const frames = await keepVideoFrames(p, media, {
        before: async () => {
          const sound = await videoSoundOf(p, file, media)
          if (sound) soundValue = await keepSound(media.runId, sound, media.kept, { hosted: media.hosted })
        },
      })
      const avg = p.video[0]!.averageRate
      return {
        values: {
          0: frames,
          1: soundValue,
          // float(Fraction(average_rate) if average_rate else Fraction(1)).
          2: { kind: 'number', value: avg ? avg.num / avg.den : 1, int: false },
        },
        ui: null,
      }
    },
  }
}

/** Python's float() of Create video's fps (a typed widget, or the rate a wire brought, already in place). */
function fpsOf(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? pyFloatOf(v) : null
  if (n === null || !Number.isFinite(n) || !(n > 0)) throw new Error(VIDEO_BAD_FPS)
  return n
}

/** CreateVideo: a `video` value naming the frame batch, the sound (or none) and the rate; no work. */
export function planCreateVideo(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const images = inputs.images
  if (!isLink(images)) throw new Error(NO_FRAMES_WIRED)
  const fps = fpsOf(inputs.fps)
  const audio = isLink(inputs.audio) ? inputs.audio : null
  return {
    kind: 'derive',
    async derive() {
      const frames = wired(ctx, images)
      if (frames.kind !== 'frames') throw new Error(NO_FRAMES_WIRED)
      let sound: Extract<RunnerValue, { kind: 'video' }>['sound'] = null
      if (audio) {
        const got = wired(ctx, audio)
        // A wire that brought no sound (Get video components of a silent video) is Python's None.
        if (got.kind === 'files' && got.files.length) sound = { file: got.files[0]!, note: soundNoteOf(got, ctx.prompt[audio[0]]?.class_type ?? '') }
        else if (got.kind !== 'files') throw new Error('There is no sound wired in')
      }
      const { file, count, w, h } = frames
      return { values: { 0: { kind: 'video', frames: { file, count, w, h }, fps, sound } }, ui: null }
    },
  }
}

// ── the savers ───────────────────────────────────────────────────────────────

/** SaveVideo: the video saved into output under Python's name, with the prompt and workflow as tags. */
export function planSaveVideo(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const link = inputs.video
  if (!isLink(link)) throw new Error(NO_VIDEO_WIRED)
  const prefix = pyStr(inputs.filename_prefix ?? 'video/ComfyUI')
  const format = String(inputs.format ?? 'auto')
  const codec = String(inputs.codec ?? 'auto')
  return {
    kind: 'derive',
    async derive(io) {
      const f = await saveVideoFile(io, wired(ctx, link), { prefix, folder: 'output', format, codec, tags: true })
      return { values: {}, ui: { images: [entry(f)], animated: [true] } }
    },
  }
}

/**
 * Step 4, C4: PreviewVideo (nodes_video.py :259-292), a temporary Save video:
 * save_to with no format or codec (a file's stream copy, a made video's
 * H.264) into temp as `preview_video_<nnnnn>_.mp4`, no tags of its own.
 * Python hands the video on too; here nothing may read it (the rule's
 * outputsNotLinked), so nothing is handed on.
 */
export function planPreviewVideo(ctx: PlanContext): NodePlan {
  const link = ctx.prompt[ctx.nodeId]!.inputs?.video
  if (!isLink(link)) throw new Error(NO_VIDEO_WIRED)
  return {
    kind: 'derive',
    async derive(io) {
      const f = await saveVideoFile(io, wired(ctx, link), { prefix: 'preview_video', folder: 'temp', format: 'auto', codec: 'auto', tags: false })
      // Nothing reads it on (its rule's outputsNotLinked), as Preview audio hands nothing on.
      return { values: {}, ui: { images: [entry(f)], animated: [true] } }
    },
  }
}

/** The Video card on its media row (VIDEO_CARD_MEDIA_RULE): see the header. */
export function planVideoCard(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const exporting = pyTruthy(inputs.export)
  const prefix = pyStr(inputs.filename_prefix ?? 'video/ComfyUI')
  const source = isLink(inputs.source) ? inputs.source : null
  // Python: `elif file:` — any non-empty name is opened.
  const named = typeof inputs.file === 'string' && inputs.file !== ''
  const file = named ? parseInputFileRef(inputs.file) : null
  return {
    kind: 'derive',
    async derive(io) {
      // A wire that brought nothing is Python's None: the card falls to its own file.
      const came = source ? videoOf(wired(ctx, source)) : null
      let value: RunnerValue
      if (came) value = came.kind === 'video' ? came : wired(ctx, source!)
      else if (named) {
        if (!file) throw new Error(VIDEO_FILE_MISSING)
        value = { kind: 'files', files: [file] }
      }
      else return { values: { 0: { kind: 'files', files: [] } }, ui: { images: [] } }
      if (value.kind === 'files' && !exporting) {
        // A file video is shown as the file itself, as the runner did before R5.4.
        return { values: { 0: value }, ui: { images: value.files.map(entry), animated: [true] } }
      }
      const target: SaveTarget = exporting ? { prefix, folder: 'output' } : { prefix: 'preview_video', folder: 'temp' }
      const shown = await saveVideoFile(io, value, { ...target, format: 'auto', codec: 'auto', tags: false })
      return { values: { 0: value }, ui: { images: [entry(shown)], animated: [true] } }
    },
  }
}
