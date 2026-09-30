/**
 * The sound nodes, computed here (step 3, R5.3, family `media-sound`),
 * exactly as comfy_extras/nodes_audio.py runs them. A sound travels as a
 * `files` value with its `sound` note (R5.2, server/media/values.ts): where
 * it is read, it is decoded the way Python's AUDIO was made (`readSound`),
 * and every file written goes through the media module's encoder
 * (`encodeAudio`, AudioSaveHelper.save_audio's own settings) into a folder of
 * the job's own, then into the store by path (`saveAssetFromPath`).
 *
 *   LoadAudio,
 *   RecordAudio   — execute (:420-424, :461-465): the file as it is, read by
 *                   `load` (note 'load'). LoadAudio's validate_inputs
 *                   (:435-438: "Invalid audio file") is the start-of-run
 *                   check `loadAudioStartProblems`; RecordAudio has none, and
 *                   a file that isn't there fails at its turn.
 *   Audio (card)  — execute (:318-350): `source` wins, then the `audio` file
 *                   ('load'), else Python's 1 s of silence at 44.1 kHz (kept
 *                   as an exact float WAV, ui `{ audio: [] }`, never saved or
 *                   exported). The card hands the sound on as it came in (a
 *                   wired sound with the note its maker implies) and shows
 *                   UI.PreviewAudio's FLAC of the samples in temp, or with
 *                   `export` on the copy get_save_audio_ui saves in its format
 *                   and quality into output (Python writes the temp preview
 *                   too, then shows the copy: the runner skips the preview no
 *                   one sees).
 *   SaveAudio,
 *   SaveAudioMP3  — get_save_audio_ui (:155-207): FLAC, or MP3 at V0 / 128k /
 *                   320k, into output under get_save_image_path's name,
 *                   `%batch_num%` per item, the counter moved on per item;
 *                   the prompt and workflow as JSON tags.
 *   PreviewAudio  — UI.PreviewAudio (:238-257): FLAC into temp under
 *                   `ComfyUI_temp_` + five of its 26 letters.
 *
 * Opus at a rate it doesn't take is resampled as torchaudio does it
 * (encodeAudio, server/media/resample.ts). A bit rate libopus refuses for the
 * sound's channels (more than 256 kb/s a channel: PyAV raises) is refused
 * before any work. A 3-to-8-channel sound fails plainly where PyAV raises
 * (encodeAudio). MP3 `192k` from the card falls through save_audio's `if`
 * chain with no rate set (LAME's own default), as in Python.
 *
 * Free: no price, no hold, no charge. The savers, Preview audio and the card
 * count as work; the loaders only hand a file on.
 */
import { join } from 'node:path'
import { isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { pyTruthy } from '#shared/runner/pyText'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { parseInputFileRef } from '../inputs'
import { SAVE_NOT_A_FILE, SAVE_OUTSIDE } from '../results'
import { asciiJson, saveImagePrefix } from '../cards/saveImage'
import type { DecodedSound } from '../../media/decode'
import { SAVE_AUDIO_SAMPLE_FMT, encodeAudio, type AudioFormat, type AudioQuality } from '../../media/encode'
import { MediaError, mediaTempDir, removeMediaTempDir } from '../../media/run'
import { probeMedia } from '../../media/probe'
import { MEDIA_WORDS } from '#shared/runner/media'
import { keepSound, readSound, soundNoteOf, type MediaValueIO } from '../../media/values'

/** LoadAudio's validate_inputs ("Invalid audio file: …"), in plain words. */
export const SOUND_FILE_MISSING = 'A sound this workflow needs is missing. Load it again.'
/** A sound node with no sound wired in (or a wire that brought no sound). */
export const NO_SOUND_WIRED = 'There is no sound wired in'
/** A sound node run where it can't reach the video tools' files (a live preview). */
export const SOUND_NEEDS_RUN = 'Sound can only be worked on when the workflow runs'
/** libopus refuses more than 256 kb/s a channel (PyAV raises "Invalid argument"). */
export const OPUS_BIT_RATE_REFUSED = 'Opus can’t save this sound at this quality. Pick a lower quality.'
/** Save failures in plain words, by cause (fix round 1, Minor 4): only a name problem asks for another name. */
export const SOUND_SAVE_BAD_NAME = 'The sound couldn’t be saved under this file name. Try a shorter, plainer name.'
export const SOUND_SAVE_NO_ROOM = 'The sound couldn’t be saved: the server has no room left.'
export const SOUND_SAVE_FAILED = 'The sound couldn’t be saved.'

/** A save failure's plain words by its cause; the file system's own words (the server's folders) are never shown. */
export function soundSaveWords(e: unknown): string {
  if (e instanceof Error && (e.message === SAVE_OUTSIDE || e.message === SAVE_NOT_A_FILE)) return e.message
  const code = (e as NodeJS.ErrnoException | null)?.code
  if (code === 'ENAMETOOLONG' || code === 'EINVAL' || code === 'EILSEQ') return SOUND_SAVE_BAD_NAME
  if (code === 'ENOSPC' || code === 'EDQUOT') return SOUND_SAVE_NO_ROOM
  return SOUND_SAVE_FAILED
}

/** UI.PreviewAudio's letters (comfy_api/latest/_ui.py): all 26, unlike PreviewImage's. */
export const AUDIO_PREVIEW_LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/** Five of PreviewAudio's letters, drawn at random. */
export function audioPreviewLetters(): string {
  return Array.from({ length: 5 }, () => AUDIO_PREVIEW_LETTERS[Math.floor(Math.random() * AUDIO_PREVIEW_LETTERS.length)]).join('')
}

/** save_audio's Opus bit rates (the qualities it names; any other sets none). */
const OPUS_BIT_RATES: Readonly<Record<string, number>> = { '64k': 64000, '96k': 96000, '128k': 128000, '192k': 192000, '320k': 320000 }

/** Python's str() of a widget value. */
function pyStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (v === null || v === undefined) return 'None'
  return String(v)
}

function mediaOf(io: DeriveIO): MediaValueIO {
  if (!io.media || !io.saveAssetFromPath) throw new Error(SOUND_NEEDS_RUN)
  return io.media
}

const entry = (f: OutputFile) => ({ filename: f.filename, subfolder: f.subfolder, type: f.type })

/**
 * save_audio over a batch (each item one sound): the name from
 * get_save_image_path (its subfolder, `%batch_num%` per item, the counter
 * moved on per item), each item encoded as Python encodes it into the job's
 * own folder, then saved from its path. `folder` 'temp' for a preview (not an
 * asset). The run's prompt and workflow go in as tags.
 */
export async function saveAudioFiles(
  io: DeriveIO, sounds: readonly DecodedSound[],
  o: { prefix: string; format: AudioFormat; quality: string; folder: 'output' | 'temp' },
): Promise<OutputFile[]> {
  const media = mediaOf(io)
  const { subfolder, filename } = saveImagePrefix(o.prefix, 0, 0, new Date())
  const metadata: Record<string, string> = { prompt: asciiJson(io.runPrompt) }
  if (io.runWorkflow != null) metadata.workflow = asciiJson(io.runWorkflow)
  const saved: OutputFile[] = []
  for (const [i, sound] of sounds.entries()) {
    if (io.signal.aborted) throw new MediaError('stopped')
    const bitRate = o.format === 'opus' && Object.hasOwn(OPUS_BIT_RATES, o.quality) ? OPUS_BIT_RATES[o.quality]! : 0
    if (bitRate > 256000 * sound.channels.length) throw new Error(OPUS_BIT_RATE_REFUSED)
    const named = filename.replaceAll('%batch_num%', String(i))
    const work = await mediaTempDir()
    try {
      const path = join(work, `sound.${o.format}`)
      await encodeAudio({
        sound, format: o.format, quality: o.quality as AudioQuality, sampleFmt: SAVE_AUDIO_SAMPLE_FMT[o.format],
        out: path, metadata, userId: media.userId, signal: io.signal, outRoots: [work],
      })
      try {
        saved.push(await io.saveAssetFromPath!(path, {
          prefix: named, ext: o.format, subfolder, folder: o.folder,
          // The counter is read once over the prefix as typed (with `%batch_num%` in it) and moved on per item.
          ...(named !== filename ? { counter: { prefix: filename, offset: i } } : {}),
        }))
      }
      catch (e) {
        // The file system's own words name the server's folders: never shown on a node.
        throw new Error(soundSaveWords(e))
      }
    }
    finally {
      await removeMediaTempDir(work)
    }
  }
  return saved
}

/** The sound a link brings, decoded as Python's AUDIO holds it (its note, or its maker's). */
async function wiredSound(ctx: PlanContext, link: ApiLink, media: MediaValueIO): Promise<{ value: RunnerValue & { kind: 'files' }; sound: DecodedSound }> {
  const got = ctx.valueFrom?.(link) ?? { kind: 'files' as const, files: ctx.filesFrom(link) }
  if (got.kind !== 'files' || !got.files.length) throw new Error(NO_SOUND_WIRED)
  const maker = ctx.prompt[link[0]]?.class_type ?? ''
  const value = { ...got, sound: soundNoteOf(got, maker) }
  return { value, sound: await readSound(value, maker, media) }
}

/** The file a loader's `audio` widget names, as get_annotated_filepath opens it; null when it names none it can open. */
function loaderFile(inputs: Record<string, unknown>): OutputFile | null {
  return isLink(inputs.audio) ? null : parseInputFileRef(inputs.audio)
}

/**
 * Why a loader's file can't give Python's `load` a sound, from its header
 * (R5.3 fix round 1, B), or null. `load` raises "No audio stream found in the
 * file." for a file with no sound stream: in plain words, MEDIA_WORDS.noSound.
 * A file the tools can't read (or over the caps) is refused in the probe's own
 * plain words.
 */
export async function soundStreamProblem(access: Pick<MediaValueIO['access'], 'pathOf' | 'rootOf'>, file: OutputFile, userId: string | null, signal?: AbortSignal): Promise<string | null> {
  try {
    const p = await probeMedia(access.pathOf(file), { userId, signal, roots: [access.rootOf(file)], kind: 'sound' })
    return p.sound.length ? null : MEDIA_WORDS.noSound
  }
  catch (e) {
    return e instanceof MediaError ? e.message : MEDIA_WORDS.unreadable
  }
}

/** LoadAudio and RecordAudio: the file handed on as it is, read by `load` where it is read. */
export function planLoadAudio(ctx: PlanContext): NodePlan {
  const file = loaderFile(ctx.prompt[ctx.nodeId]!.inputs ?? {})
  if (!file) throw new Error(SOUND_FILE_MISSING)
  return {
    kind: 'derive',
    async derive(io) {
      if (io.media) {
        if (!(await io.media.access.exists(file))) throw new Error(SOUND_FILE_MISSING)
        // Python's `load` fails here, at the loader, on a file with no sound (backstop for the start check).
        const why = await soundStreamProblem(io.media.access, file, io.media.userId, io.signal)
        if (why) throw new Error(why)
      }
      return { values: { 0: { kind: 'files', files: [file], sound: { decode: 'load' } } }, ui: null }
    },
  }
}

/**
 * The loaders' checks before the run, the first failing node or null:
 *   - LoadAudio's validate_inputs: a file that isn't there (or a name
 *     get_annotated_filepath can't open) is refused, as ComfyUI refuses the
 *     prompt before running anything;
 *   - LoadAudio and RecordAudio (fix round 1, B): a file with no sound stream
 *     (`soundOf`: soundStreamProblem) is refused at that node, as Python's
 *     `load` fails there. A RecordAudio file that isn't there is left to its turn.
 */
export async function loadAudioStartProblems(
  prompt: ApiPrompt, exists: (f: OutputFile) => Promise<boolean>,
  soundOf?: (f: OutputFile) => Promise<string | null>,
): Promise<{ message: string; nodeId: string; classType: string; file?: string } | null> {
  for (const [nodeId, n] of Object.entries(prompt)) {
    if (n.class_type !== 'LoadAudio' && n.class_type !== 'RecordAudio') continue
    const file = loaderFile(n.inputs ?? {})
    const load = n.class_type === 'LoadAudio'
    if (!file) {
      if (load) return { message: SOUND_FILE_MISSING, nodeId, classType: n.class_type }
      continue
    }
    if (!(await exists(file))) {
      if (load) return { message: SOUND_FILE_MISSING, nodeId, classType: n.class_type, file: file.filename }
      continue
    }
    const why = soundOf ? await soundOf(file) : null
    if (why) return { message: why, nodeId, classType: n.class_type, file: file.filename }
  }
  return null
}

/** The Audio card in full (AUDIO_CARD_MEDIA_RULE): see the header. */
export function planAudioCard(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const exporting = pyTruthy(inputs.export)
  const prefix = pyStr(inputs.filename_prefix ?? 'audio/ComfyUI')
  const format = String(inputs.format ?? 'flac') as AudioFormat
  const quality = String(inputs.quality ?? 'V0')
  const source = isLink(inputs.source) ? inputs.source : null
  // Python: `elif audio:` — any non-empty name is opened.
  const named = !source && typeof inputs.audio === 'string' && inputs.audio !== ''
  const file = named ? parseInputFileRef(inputs.audio) : null
  if (named && !file) throw new Error(SOUND_FILE_MISSING)
  const letters = audioPreviewLetters()
  return {
    kind: 'derive',
    async derive(io) {
      const media = mediaOf(io)
      let value: RunnerValue
      let sound: DecodedSound
      if (source) ({ value, sound } = await wiredSound(ctx, source, media))
      else if (file) {
        value = { kind: 'files', files: [file], sound: { decode: 'load' } }
        sound = await readSound(value, 'Audio', media)
      }
      else {
        // 1 s of silence, and nothing shown or saved (Python returns before its preview and export).
        const silence = await keepSound(media.runId, { rate: 44100, channels: [new Float32Array(44100)] }, media.kept, { hosted: media.hosted })
        return { values: { 0: silence }, ui: { audio: [] } }
      }
      const shown = exporting
        ? await saveAudioFiles(io, [sound], { prefix, format, quality, folder: 'output' })
        : await saveAudioFiles(io, [sound], { prefix: `ComfyUI_temp_${letters}`, format: 'flac', quality: '128k', folder: 'temp' })
      return { values: { 0: value }, ui: { audio: shown.map(entry) } }
    },
  }
}

/** SaveAudio (FLAC) and SaveAudioMP3. */
export function planSaveAudio(ctx: PlanContext): NodePlan {
  const node = ctx.prompt[ctx.nodeId]!
  const inputs = node.inputs ?? {}
  const link = inputs.audio
  if (!isLink(link)) throw new Error(NO_SOUND_WIRED)
  const mp3 = node.class_type === 'SaveAudioMP3'
  const prefix = pyStr(inputs.filename_prefix ?? 'ComfyUI')
  // SaveAudio.execute hands save_audio its default quality (128k), which FLAC ignores.
  const quality = mp3 ? pyStr(inputs.quality ?? '128k') : '128k'
  return {
    kind: 'derive',
    async derive(io) {
      const { sound } = await wiredSound(ctx, link, mediaOf(io))
      const files = await saveAudioFiles(io, [sound], { prefix, format: mp3 ? 'mp3' : 'flac', quality, folder: 'output' })
      return { values: {}, ui: { audio: files.map(entry) } }
    },
  }
}

/** PreviewAudio: FLAC into temp under `ComfyUI_temp_` + five letters. */
export function planPreviewAudio(ctx: PlanContext): NodePlan {
  const link = ctx.prompt[ctx.nodeId]!.inputs?.audio
  if (!isLink(link)) throw new Error(NO_SOUND_WIRED)
  const letters = audioPreviewLetters()
  return {
    kind: 'derive',
    async derive(io) {
      const { sound } = await wiredSound(ctx, link, mediaOf(io))
      const files = await saveAudioFiles(io, [sound], { prefix: `ComfyUI_temp_${letters}`, format: 'flac', quality: '128k', folder: 'temp' })
      return { values: {}, ui: { audio: files.map(entry) } }
    },
  }
}
