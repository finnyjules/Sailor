/**
 * Video and sound out of Sailor's own server, as Python's PyAV writes them
 * (step 3, R5.1c). Every file is made by the checked build through `runMedia`
 * (run.ts), into the job's own temporary folder, then moved to `out`
 * (linked, or copied with O_EXCL across disks): an existing file is never
 * overwritten.
 *
 * Pictures (`encodeVideo`) are VideoFromComponents.save_to
 * (video_types.py:409-470), SaveVideoFramesNode (nodes_video_effects.py:676-714)
 * and Turntable's stitch_clips (_turntable_stitch.py:15-61):
 *   - rgb24 frames go to yuv420p through ffmpeg's scale filter with
 *     `flags=bilinear` and nothing else (PyAV's reformat('yuv420p'): SWS_BILINEAR,
 *     colour space and range unspecified), proven equal to Python's planes;
 *   - frame i is stamped i / fps in a 1/fps time base, fps the stream rate as
 *     Python sets it (`pyStreamRate`);
 *   - H.264 comes from OpenH264 with `h264Args(quality)` (ruling d; libx264
 *     is GPL and not in the build). An odd width or height fails before any
 *     work (libx264's yuv420p refuses it in Python);
 *   - `clips` (Turntable) is one filter graph: every clip after the first
 *     loses its first frame (`trim=start_frame=1`), a clip of another size is
 *     scaled to the first's with `flags=bilinear`, the clips are joined
 *     (`concat`), and the frames renumbered 0, 1, 2… at the given rate. The
 *     scale keeps the clip's chroma siting on both sides, as PyAV's reformat
 *     does (`clipToYuv420p`);
 *   - sound is AAC in one stream: from samples (save_to: `fltp`, the layout by
 *     channel count, cut to `cutSamples`), or from a file (SaveVideoFrames:
 *     its first sound stream, whole frames up to `cutSeconds`, stereo);
 *   - `-movflags +faststart+use_metadata_tags`; tags (ruling i) go in as an
 *     ffmetadata file, never on the command line (a workflow can pass Linux's
 *     128 KiB argument limit).
 *
 * Sound (`encodeAudio`) is AudioSaveHelper.save_audio (_ui.py:265-370): FLAC,
 * MP3 and Opus from float samples, every setting given (the input `f32le`
 * interleaved, `mono` for one channel and `stereo` for two, the encoder's
 * sample format as PyAV picks it, the MP3 quality, the Opus bit rate). Opus
 * at a rate it doesn't take is resampled first with torchaudio's resampler
 * (resample.ts, ruling j). More than two channels fails, as PyAV does.
 *
 * `floatWav` writes the runner's exact sound (IEEE float WAV); `writeFfv1`
 * keeps a frame batch losslessly (FFV1 in Matroska, stored as bgr0, ruling e).
 */
import { constants as fsConstants } from 'node:fs'
import { copyFile, link, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isHosted } from '../utils/deployMode'
import { CHROMA_POS, chromaSubsampling, type DecodedSound } from './decode'
import { h264Args, type H264Quality } from './h264Quality'
import { exactFraction, ffprobeJson, mediaCapsWord, probeMedia, type MediaProbe, type Rational, type VideoStreamProbe } from './probe'
import { opusRate, resampleLikeTorchaudio } from './resample'
import { MediaError, inputArgs, mediaTempDir, removeMediaTempDir, runMedia } from './run'

export { OPENH264_FOR, PYAV_H264_DEFAULT, h264Args, type H264Quality } from './h264Quality'

export type VideoSource =
  /** rgb24 frames, each exactly w · h · 3 bytes. */
  | { kind: 'rgb'; w: number; h: number; frames: AsyncIterable<Uint8Array> }
  /** A kept frame batch (`writeFfv1`). */
  | { kind: 'ffv1'; path: string; w: number; h: number }
  /** Turntable's clips, joined. */
  | { kind: 'clips'; paths: string[]; dropFirstAfterFirst: true }

export type SoundSource =
  | { sound: DecodedSound }
  /** A file's first sound stream, cut after the last whole frame starting at or before `cutSeconds`. */
  | { path: string; stream: 'first'; cutSeconds?: number }

export type SoundLayout = 'mono' | 'stereo' | '5.1'

const LAYOUT_CHANNELS: Readonly<Record<SoundLayout, number>> = { mono: 1, stereo: 2, '5.1': 6 }

// ── Python's numbers ─────────────────────────────────────────────────────────

function bigGcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b
  while (b) [a, b] = [b, a % b]
  return a
}

/**
 * The stream rate save_to and SaveVideoFrames give H.264:
 * Fraction(round(fps · 1000), 1000), `fps` the float the node holds (Python's
 * round of a Fraction: halves to even), reduced.
 */
export function pyStreamRate(fps: number): Rational {
  if (!(fps > 0) || !Number.isFinite(fps)) throw new MediaError('failed')
  const [n, d] = exactFraction(fps)
  const x = n * 1000n
  let q = x / d
  const r2 = 2n * (x % d)
  if (r2 > d || (r2 === d && q % 2n === 1n)) q += 1n
  const g = bigGcd(q, 1000n)
  return { num: Number(q / g), den: Number(1000n / g) }
}

/**
 * save_to's sound cut, exactly: ceil((rate / Fraction(fps)) · frames), `fps`
 * the float CreateVideo stores as Fraction(fps).
 */
export function pyAudioCutSamples(rate: number, fps: number, frames: number): number {
  const [n, d] = exactFraction(fps)
  const top = BigInt(rate) * d * BigInt(frames)
  const q = top / n
  return Number(top % n === 0n ? q : q + 1n)
}

// ── pieces ───────────────────────────────────────────────────────────────────

/** rgb24 → yuv420p as PyAV's reformat('yuv420p') does it (SWS_BILINEAR, no colour tags). Exported for tests. */
export const RGB_TO_YUV420P = 'scale=w=iw:h=ih:flags=bilinear,format=yuv420p'

/** Tags as an ffmetadata file: '=', ';', '#', '\' and line ends escaped with '\'. */
export function ffmetadataText(tags: Record<string, string>): string {
  const esc = (s: string) => s.replace(/[\\=;#\n\r]/g, c => `\\${c}`)
  return `;FFMETADATA1\n${Object.entries(tags).map(([k, v]) => `${esc(k)}=${esc(v)}`).join('\n')}\n`
}

/** Writes the tags file (when there are tags) and returns its input arguments; the caller maps it with `-map_metadata`. */
async function tagsInput(work: string, tags: Record<string, string> | undefined): Promise<string[] | null> {
  if (!tags || !Object.keys(tags).length) return null
  const p = join(work, 'tags.ffmeta')
  await writeFile(p, ffmetadataText(tags), { flag: 'wx' })
  return ['-protocol_whitelist', 'file,pipe', '-f', 'ffmetadata', '-i', `file:${p}`]
}

/** Moves a finished file out of the job's folder to `dest`, never over an existing file. */
async function moveOut(src: string, dest: string): Promise<void> {
  if (!isAbsolute(dest) || dest.includes('\0')) throw new MediaError('failed')
  try { await link(src, dest) }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw new MediaError('failed')
    try { await copyFile(src, dest, fsConstants.COPYFILE_EXCL) }
    catch { throw new MediaError('failed') }
  }
  await rm(src, { force: true })
}

/** Interleaved little-endian float32 of [C][N] channels, `from`…`to` samples. */
function interleave(s: DecodedSound, from: number, to: number): Uint8Array {
  const C = s.channels.length
  const out = new Float32Array((to - from) * C)
  for (let i = from; i < to; i++) for (let c = 0; c < C; c++) out[(i - from) * C + c] = s.channels[c]![i]!
  return new Uint8Array(out.buffer)
}

/** A sound as f32le chunks of about 64 KiB, for a tool's stdin. */
async function* soundChunks(s: DecodedSound, samples: number): AsyncIterable<Uint8Array> {
  const step = Math.max(1, Math.floor(16384 / Math.max(1, s.channels.length)))
  for (let at = 0; at < samples; at += step) yield interleave(s, at, Math.min(samples, at + step))
}

function soundLength(s: DecodedSound): number {
  const n = s.channels[0]?.length ?? 0
  if (s.channels.some(ch => ch.length !== n)) throw new MediaError('failed')
  return n
}

/** Frames checked one by one: each exactly `bytes` long. */
async function* checkedFrames(frames: AsyncIterable<Uint8Array>, bytes: number, counted: { n: number }, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  for await (const f of frames) {
    if (signal?.aborted) throw new MediaError('stopped')
    if (f.byteLength !== bytes) throw new MediaError('sizeChanged')
    counted.n++
    yield f
  }
}

/**
 * A clip frame to W × H yuv420p as PyAV's `frame.reformat(width, height,
 * format='yuv420p')` does it (stitch_clips): SWS_BILINEAR, and the frame's
 * own chroma siting on both sides, where the clip names one (sws reads it for
 * the source on the axes where its chroma is subsampled, and the new frame
 * keeps it; measured: without the output side, chroma is up to 7 levels off).
 * Built from the probe's numbers and fixed words only.
 */
export function clipToYuv420p(v: Pick<VideoStreamProbe, 'w' | 'h' | 'pixFmt' | 'chromaLocation'>, W: number, H: number): string {
  if (v.w === W && v.h === H && v.pixFmt === 'yuv420p') return 'format=yuv420p'
  const pos = v.chromaLocation && Object.hasOwn(CHROMA_POS, v.chromaLocation) ? CHROMA_POS[v.chromaLocation]! : null
  const sub = chromaSubsampling(v.pixFmt)
  let chroma = ''
  if (pos && sub?.w) chroma += `:in_h_chr_pos=${pos[0]}`
  if (pos && sub?.h) chroma += `:in_v_chr_pos=${pos[1]}`
  if (pos) chroma += `:out_h_chr_pos=${pos[0]}:out_v_chr_pos=${pos[1]}`
  return `scale=w=${W}:h=${H}:flags=bilinear${chroma},format=yuv420p`
}

function evenSize(w: number, h: number): void {
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) throw new MediaError('failed')
  if (w % 2 || h % 2) throw new MediaError('oddSize')
}

function rationalOk(r: Rational): boolean {
  return Number.isInteger(r.num) && Number.isInteger(r.den) && r.num > 0 && r.den > 0
}

/** A checked video input's probe (the person's folders; the video caps). */
async function probeVideoInput(path: string, o: { userId: string | null; signal?: AbortSignal; roots: readonly string[] }): Promise<MediaProbe> {
  const p = await probeMedia(path, { userId: o.userId, signal: o.signal, roots: o.roots, kind: 'video' })
  const refused = mediaCapsWord(p, 'video', isHosted())
  if (refused) throw new MediaError(refused)
  return p
}

/**
 * SaveVideoFrames' sound cut: the samples of the first stream's decoded
 * frames up to the first whose time is past `cutSeconds` (`frame.time >
 * target` breaks the loop; a frame without a time is kept).
 */
async function samplesUpTo(p: MediaProbe, cutSeconds: number, o: { userId: string | null; signal?: AbortSignal }): Promise<number> {
  const s = p.sound[0]!
  const j = await ffprobeJson(p.path, p.format, ['-select_streams', 'a:0', '-show_entries', 'frame=pts,nb_samples'], o)
  const frames = Array.isArray(j.frames) ? (j.frames as { pts?: unknown; nb_samples?: unknown }[]) : []
  let kept = 0
  for (const f of frames) {
    if (typeof f.pts === 'number' && (f.pts * s.timeBase.num) / s.timeBase.den > cutSeconds) break
    kept += typeof f.nb_samples === 'number' ? f.nb_samples : 0
  }
  return kept
}

// ── encodeVideo ──────────────────────────────────────────────────────────────

export interface EncodeVideoOptions {
  input: VideoSource
  /** Where the finished MP4 goes (absolute; must not exist yet). */
  out: string
  /** The stream rate as Python sets it (`pyStreamRate`, or a clip's average_rate). */
  fps: Rational
  /** clips: the first clip's; else the input's. */
  size?: { w: number; h: number }
  quality: H264Quality
  sound?: { source: SoundSource; layout: SoundLayout; rate: number; cutSamples?: number } | null
  /** Written with -movflags use_metadata_tags (values as Python writes them: JSON text). */
  metadata?: Record<string, string>
  userId: string | null; signal?: AbortSignal
  /** The folders every input file must really be in (the person's own and the run's kept files). */
  roots?: readonly string[]
}

/** H.264 in MP4, as Python saves a video (see the header). Resolves with the frames written. */
export async function encodeVideo(o: EncodeVideoOptions): Promise<{ frames: number }> {
  if (!rationalOk(o.fps)) throw new MediaError('failed')
  const roots = o.roots ?? []
  const input = o.input
  // Sizes first: nothing starts for an odd one.
  let clipProbes: MediaProbe[] = []
  let W: number
  let H: number
  if (input.kind === 'clips') {
    if (!input.paths.length) throw new MediaError('noVideo')
    clipProbes = []
    for (const path of input.paths) clipProbes.push(await probeVideoInput(path, { userId: o.userId, signal: o.signal, roots }))
    W = o.size?.w ?? clipProbes[0]!.video[0]!.w
    H = o.size?.h ?? clipProbes[0]!.video[0]!.h
  }
  else {
    W = input.w
    H = input.h
    if (o.size && (o.size.w !== W || o.size.h !== H)) throw new MediaError('sizeChanged')
  }
  evenSize(W, H)
  const sound = o.sound ?? null
  if (sound && !(Object.hasOwn(LAYOUT_CHANNELS, sound.layout) && Number.isInteger(sound.rate) && sound.rate > 0)) throw new MediaError('failed')

  const work = await mediaTempDir()
  try {
    const args: string[] = []
    let stdin: AsyncIterable<Uint8Array> | undefined
    const counted = { n: 0 }
    const tb = `${o.fps.den}/${o.fps.num}`
    const restamp = `settb=expr=${o.fps.den}/${o.fps.num},setpts=N`
    let videoMap: string
    if (input.kind === 'rgb') {
      stdin = checkedFrames(input.frames, W * H * 3, counted, o.signal)
      args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-framerate', `${o.fps.num}/${o.fps.den}`, '-i', 'pipe:0')
      args.push('-filter_complex', `[0:v]${RGB_TO_YUV420P},${restamp}[v]`)
      videoMap = '[v]'
    }
    else if (input.kind === 'ffv1') {
      const p = await probeVideoInput(input.path, { userId: o.userId, signal: o.signal, roots })
      const v = p.video[0]!
      if (v.w !== W || v.h !== H) throw new MediaError('sizeChanged')
      args.push('-noautorotate', ...inputArgs(p.path, p.format))
      // bgr0 → rgb24 is a lossless shuffle; then exactly the rgb24 path.
      args.push('-filter_complex', `[0:v]format=rgb24,${RGB_TO_YUV420P},${restamp}[v]`)
      videoMap = '[v]'
    }
    else {
      const parts: string[] = []
      clipProbes.forEach((p, i) => {
        args.push('-noautorotate', ...inputArgs(p.path, p.format))
        const steps: string[] = []
        if (i > 0) steps.push('trim=start_frame=1')
        steps.push(clipToYuv420p(p.video[0]!, W, H))
        parts.push(`[${i}:v:0]${steps.join(',')}[c${i}]`)
      })
      const joined = clipProbes.map((_, i) => `[c${i}]`).join('')
      parts.push(`${joined}concat=n=${clipProbes.length}:v=1:a=0,${restamp}[v]`)
      args.push('-filter_complex', parts.join(';'))
      videoMap = '[v]'
    }

    /** The index the next `-i` gets. */
    const nextInput = () => args.filter(a => a === '-i').length
    // Sound: an input of its own.
    let soundIndex: number | null = null
    let soundFilter: string | null = null
    if (sound) {
      soundIndex = nextInput()
      const C = LAYOUT_CHANNELS[sound.layout]
      if ('sound' in sound.source) {
        const s = sound.source.sound
        const n = soundLength(s)
        if (s.channels.length !== C) throw new MediaError('failed')
        const cut = Math.min(n, sound.cutSamples ?? n)
        const raw = join(work, 'sound.f32')
        const chunks: Uint8Array[] = []
        for await (const c of soundChunks(s, cut)) chunks.push(c)
        await writeFile(raw, Buffer.concat(chunks), { flag: 'wx' })
        args.push('-f', 'f32le', '-ar', String(sound.rate), '-ch_layout', sound.layout, '-protocol_whitelist', 'file,pipe', '-i', `file:${raw}`)
      }
      else {
        const p = await probeMedia(sound.source.path, { userId: o.userId, signal: o.signal, roots, kind: 'sound' })
        const refused = mediaCapsWord(p, 'sound', isHosted())
        if (refused) throw new MediaError(refused)
        const keep = sound.source.cutSeconds === undefined ? null : await samplesUpTo(p, sound.source.cutSeconds, { userId: o.userId, signal: o.signal })
        args.push(...inputArgs(p.path, p.format))
        // Python re-stamps every frame (`frame.pts = None`): the sound starts at 0 however the file's did.
        soundFilter = `${keep !== null ? `atrim=end_sample=${keep},` : ''}asetpts=N/SR/TB`
      }
    }

    const tagsArgs = await tagsInput(work, o.metadata)
    const tagsIndex = tagsArgs ? nextInput() : null
    if (tagsArgs) args.push(...tagsArgs)

    const out = join(work, 'out.mp4')
    args.push('-map', videoMap, '-fps_mode', 'passthrough', '-enc_time_base:v', tb, ...h264Args(o.quality))
    if (sound && soundIndex !== null) {
      args.push('-map', `${soundIndex}:a:0`, '-c:a', 'aac', '-ar', String(sound.rate), '-ch_layout', sound.layout)
      if (soundFilter) args.push('-af', soundFilter)
    }
    args.push('-map_metadata', tagsIndex === null ? '-1' : String(tagsIndex))
    args.push('-movflags', '+faststart+use_metadata_tags', '-f', 'mp4', '-y', `file:${out}`)

    await runMedia({ tool: 'ffmpeg', args, userId: o.userId, signal: o.signal, stdin, workDir: work, cleanup: [out] })
    if (input.kind === 'rgb' && counted.n === 0) throw new MediaError('noVideo')
    const made = await probeMedia(out, { userId: o.userId, signal: o.signal, roots: [work], kind: 'video' })
    const frames = made.video[0]?.frames ?? counted.n
    await moveOut(out, o.out)
    return { frames }
  }
  finally {
    await removeMediaTempDir(work)
  }
}

// ── encodeAudio ──────────────────────────────────────────────────────────────

export type AudioFormat = 'flac' | 'mp3' | 'opus'
export type AudioQuality = 'V0' | '64k' | '96k' | '128k' | '192k' | '320k'

/** The encoder input format PyAV picks for each (the codec's first; recorded by the encode fixture). */
export const SAVE_AUDIO_SAMPLE_FMT: Readonly<Record<AudioFormat, string>> = { flac: 's16', mp3: 's32p', opus: 's16' }

const BIT_RATE: Readonly<Record<string, string>> = { '64k': '64000', '96k': '96000', '128k': '128000', '192k': '192000', '320k': '320000' }

/** save_audio's quality settings: MP3 V0 is VBR quality 0, 128k/320k a bit rate; Opus a bit rate; FLAC none. */
function qualityArgs(format: AudioFormat, quality: AudioQuality): string[] {
  if (format === 'mp3') {
    if (quality === 'V0') return ['-q:a', '0']
    if (quality === '128k' || quality === '320k') return ['-b:a', BIT_RATE[quality]!]
    return []
  }
  if (format === 'opus') return Object.hasOwn(BIT_RATE, quality) ? ['-b:a', BIT_RATE[quality]!] : []
  return []
}

const CODEC: Readonly<Record<AudioFormat, string>> = { flac: 'flac', mp3: 'libmp3lame', opus: 'libopus' }

/** One sound as FLAC, MP3 or Opus, as AudioSaveHelper.save_audio writes it (see the header). */
export async function encodeAudio(o: {
  sound: DecodedSound; format: AudioFormat
  quality: AudioQuality
  /** The encoder input format PyAV picks (`SAVE_AUDIO_SAMPLE_FMT`). */
  sampleFmt: string
  out: string; metadata?: Record<string, string>
  userId: string | null; signal?: AbortSignal
}): Promise<void> {
  if (!Object.hasOwn(CODEC, o.format) || !/^[a-z0-9]+$/.test(o.sampleFmt)) throw new MediaError('failed')
  const C = o.sound.channels.length
  // PyAV: a layout of 'stereo' can't take more than two rows.
  if (C < 1 || C > 2) throw new MediaError('failed')
  if (!(Number.isInteger(o.sound.rate) && o.sound.rate > 0)) throw new MediaError('failed')
  let sound = o.sound
  const n0 = soundLength(sound)
  if (o.format === 'opus') {
    const rate = opusRate(sound.rate)
    if (rate !== sound.rate) sound = { rate, channels: resampleLikeTorchaudio(sound.channels, sound.rate, rate) }
  }
  const n = sound === o.sound ? n0 : soundLength(sound)
  const layout = C === 1 ? 'mono' : 'stereo'
  const work = await mediaTempDir()
  try {
    const args = ['-f', 'f32le', '-ar', String(sound.rate), '-ch_layout', layout, '-i', 'pipe:0']
    const tagsArgs = await tagsInput(work, o.metadata)
    if (tagsArgs) args.push(...tagsArgs)
    const out = join(work, `out.${o.format}`)
    args.push(
      '-map', '0:a', '-map_metadata', tagsArgs ? '1' : '-1',
      '-c:a', CODEC[o.format], '-threads:a', '1', '-sample_fmt', o.sampleFmt, '-ar', String(sound.rate), '-ch_layout', layout,
      ...qualityArgs(o.format, o.quality),
      '-f', o.format, '-y', `file:${out}`,
    )
    await runMedia({ tool: 'ffmpeg', args, userId: o.userId, signal: o.signal, stdin: soundChunks(sound, n), workDir: work, cleanup: [out] })
    await moveOut(out, o.out)
  }
  finally {
    await removeMediaTempDir(work)
  }
}

// ── the runner's own files ───────────────────────────────────────────────────

/** WAV, IEEE float32, interleaved: the runner's exact sound (no tools needed). */
export function floatWav(s: DecodedSound): Uint8Array {
  const C = s.channels.length
  if (C < 1 || !(Number.isInteger(s.rate) && s.rate > 0)) throw new MediaError('failed')
  const n = soundLength(s)
  const data = n * C * 4
  if (data > 0xFFFFFFFF - 58) throw new MediaError('tooBig')
  const head = 12 + 8 + 18 + 12 + 8
  const buf = new ArrayBuffer(head + data)
  const v = new DataView(buf)
  const ascii = (at: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(at + i, t.charCodeAt(i)) }
  ascii(0, 'RIFF'); v.setUint32(4, head - 8 + data, true); ascii(8, 'WAVE')
  // fmt: WAVE_FORMAT_IEEE_FLOAT (3), with cbSize 0 (a non-PCM fmt chunk is 18 bytes).
  ascii(12, 'fmt '); v.setUint32(16, 18, true)
  v.setUint16(20, 3, true); v.setUint16(22, C, true); v.setUint32(24, s.rate, true)
  v.setUint32(28, s.rate * C * 4, true); v.setUint16(32, C * 4, true); v.setUint16(34, 32, true); v.setUint16(36, 0, true)
  // fact: the samples per channel (asked for by every non-PCM WAV).
  ascii(38, 'fact'); v.setUint32(42, 4, true); v.setUint32(46, n, true)
  ascii(50, 'data'); v.setUint32(54, data, true)
  new Uint8Array(buf, head).set(interleave(s, 0, n))
  return new Uint8Array(buf)
}

/**
 * An FFV1 Matroska of rgb24 frames (stored as bgr0, lossless: FFV1's RGB is
 * a reversible transform, and rgb24 ↔ bgr0 only moves bytes). Bit-exact
 * muxing, so the same frames make the same file (kept by sha256).
 */
export async function writeFfv1(o: { frames: AsyncIterable<Uint8Array>; w: number; h: number; out: string; userId: string | null; signal?: AbortSignal }): Promise<{ count: number }> {
  if (!(Number.isInteger(o.w) && Number.isInteger(o.h) && o.w > 0 && o.h > 0)) throw new MediaError('failed')
  const work = await mediaTempDir()
  try {
    const counted = { n: 0 }
    const out = join(work, 'out.mkv')
    const args = [
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${o.w}x${o.h}`, '-framerate', '1', '-i', 'pipe:0',
      '-map', '0:v', '-map_metadata', '-1', '-fps_mode', 'passthrough',
      '-c:v', 'ffv1', '-threads:v', '1', '-pix_fmt', 'bgr0',
      '-fflags', '+bitexact', '-f', 'matroska', '-y', `file:${out}`,
    ]
    await runMedia({ tool: 'ffmpeg', args, userId: o.userId, signal: o.signal, stdin: checkedFrames(o.frames, o.w * o.h * 3, counted, o.signal), workDir: work, cleanup: [out] })
    if (counted.n === 0) throw new MediaError('noVideo')
    await moveOut(out, o.out)
    return { count: counted.n }
  }
  finally {
    await removeMediaTempDir(work)
  }
}
