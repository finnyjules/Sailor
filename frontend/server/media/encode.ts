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
 *     its first sound stream, whole frames up to `cutSeconds`, stereo, its
 *     packets numbered from 0 as Python's muxer numbers frames with no pts,
 *     so the encoder's priming stays in front: R5.5, measured exact);
 *   - SaveVideoFrames' odd sizes are padded to even with black (`padToEven`,
 *     R5.5) where save_to's are refused;
 *   - decode times two frames ahead of presentation (`H264_DTS_DELAY`, the
 *     `setts` bitstream filter), as libx264's B-frames make them in Python's
 *     files: pictures are untouched, and Python's own get_components reads
 *     the sound of a Sailor file exactly as it reads its own (it seeks the
 *     video to 0 first; with the video's first decode time at 0 that seek
 *     drops the AAC priming packet);
 *   - `-movflags +faststart+use_metadata_tags`; tags (ruling i) go in as an
 *     ffmetadata file, never on the command line (a workflow can pass Linux's
 *     128 KiB argument limit).
 *
 * Sound (`encodeAudio`) is AudioSaveHelper.save_audio (_ui.py:265-370): FLAC,
 * MP3 and Opus from float samples, every setting given (the input `f32le`
 * interleaved, `mono` for one channel and `stereo` for two, the encoder's
 * sample format as PyAV picks it, the MP3 quality, the Opus bit rate). Opus
 * at a rate it doesn't take is resampled first with torchaudio's resampler
 * (resample.ts, ruling j), on the compositor worker; a rate pair whose kernel
 * passes RESAMPLE_MAX_TAPS is refused (MEDIA_WORDS.oddRate). More than two
 * channels fails, as PyAV does.
 *
 * `out` must be in the caller's own folders (`outRoots`, realpath-checked).
 *
 * `floatWav` writes the runner's exact sound (IEEE float WAV); `writeFfv1`
 * keeps a frame batch losslessly (FFV1 in Matroska, stored as bgr0, ruling e).
 */
import { constants as fsConstants } from 'node:fs'
import { copyFile, link, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { isHosted } from '../utils/deployMode'
import { MEDIA_CAPS } from '#shared/runner/media'
import { CHROMA_POS, chromaSubsampling, type DecodedSound } from './decode'
import { h264Args, type H264Quality } from './h264Quality'
import { exactFraction, ffprobeJson, mediaCapsWord, probeMedia, type MediaProbe, type Rational, type VideoStreamProbe } from './probe'
import { resampleInWorker } from '../runner/compositor/worker'
import { RESAMPLE_MAX_TAPS, opusRate, resampleTaps } from './resample'
import { FROM_ZERO_BSF, MediaError, fromZeroBsfCut, inputArgs, mediaTempDir, removeMediaTempDir, runMedia, type MediaLease } from './run'

export { OPENH264_FOR, PYAV_H264_DEFAULT, h264Args, type H264Quality } from './h264Quality'

export type VideoSource =
  /** rgb24 frames, each exactly w · h · 3 bytes. */
  | { kind: 'rgb'; w: number; h: number; frames: AsyncIterable<Uint8Array> }
  /**
   * A kept frame batch (`writeFfv1`): the runner's own file, read without the upload caps (the caller judges the batch caps).
   * `range` (R11.7, Slow motion (AI)'s segments): only frames start … start + count − 1 of it.
   */
  | { kind: 'ffv1'; path: string; w: number; h: number; range?: { start: number; count: number } }
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
  return pyStreamRateOf(n, d)
}

/**
 * The same for a rate Python holds as a Fraction (R5.4: a file's
 * average_rate, which Save video's re-encode keeps exact): n / d, both
 * positive.
 */
export function pyStreamRateOf(n: bigint, d: bigint): Rational {
  if (!(n > 0n && d > 0n)) throw new MediaError('failed')
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

/**
 * Tags as an ffmetadata file: '=', ';', '#', '\' and line ends escaped with
 * '\'. A value ending in '\' can't be written: ffmetadata's line reader takes
 * any line ending after a backslash (even an escaped one) as a continuation,
 * so it would swallow the next tag (R5.1c review, Minor 3, measured). Such a
 * value is refused (JSON text, what Python writes, never ends in one).
 */
export function ffmetadataText(tags: Record<string, string>): string {
  if (Object.entries(tags).some(([k, v]) => k.endsWith('\\') || v.endsWith('\\') || !k)) throw new MediaError('failed')
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

/**
 * Moves a finished file out of the job's folder to `dest`, never over an
 * existing file, and only into the caller's own folders: `dest`'s folder,
 * symlinks resolved, must be one of `roots` or inside one (R5.1c review,
 * Minor 4), and the name itself is a plain one in it.
 */
async function moveOut(src: string, dest: string, roots: readonly string[]): Promise<void> {
  if (!isAbsolute(dest) || dest.includes('\0')) throw new MediaError('failed')
  const name = basename(dest)
  if (!name || name === '.' || name === '..') throw new MediaError('failed')
  let folder: string
  try { folder = await realpath(dirname(dest)) }
  catch { throw new MediaError('failed') }
  let inside = false
  for (const r of roots) {
    if (!isAbsolute(r)) continue
    const real = await realpath(r).catch(() => null)
    if (real && (folder === real || folder.startsWith(real + sep))) { inside = true; break }
  }
  if (!inside) throw new MediaError('failed')
  dest = join(folder, name)
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

/** A sound as f32le chunks of about 64 KiB, for a tool's stdin or a file. */
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
async function probeVideoInput(path: string, o: { userId: string | null; signal?: AbortSignal; roots: readonly string[]; kept?: true }): Promise<MediaProbe> {
  const p = await probeMedia(path, { userId: o.userId, signal: o.signal, roots: o.roots, kind: 'video', ...(o.kept ? { kept: true as const } : {}) })
  // A kept batch (the 'ffv1' input) is judged by the batch caps it was kept under, before this (R5.2 fix round 1).
  const refused = o.kept ? null : mediaCapsWord(p, 'video', isHosted())
  if (refused) throw new MediaError(refused)
  return p
}

/** The loop's end was reached: the scan stops there (the rest of the file is never decoded). */
class CutReached extends Error {}

/**
 * SaveVideoFrames' sound cut: the samples of the first stream's decoded
 * frames up to the first whose time is past `cutSeconds` (`frame.time >
 * target` breaks the loop; a frame without a time is kept). The frames come
 * from a decode that stops at the first decode error, as PyAV raises there
 * (`-xerror`); then `broken` (R5.5 fix round 1): Python's loop ends in its
 * `except`, its AAC encoder never flushed. The decode stops once the cut is
 * reached (fix round 1, Minor 2: a soundtrack longer than the caps is read
 * only as far as the video), and the samples it keeps are held to
 * `maxSamples` (channels · samples) as they come.
 */
async function samplesUpTo(p: MediaProbe, cutSeconds: number, o: { userId: string | null; signal?: AbortSignal; maxSamples: number }): Promise<{ kept: number; broken: boolean }> {
  const s = p.sound[0]!
  const C = Math.max(1, s.channels)
  let kept = 0
  let text = ''
  let done = false
  try {
    await runMedia({
      tool: 'ffmpeg',
      args: [
        '-xerror', '-copyts', ...inputArgs(p.path, p.format), '-map', '0:a:0', '-c:a', 'pcm_f32le',
        '-stats_mux_pre', 'pipe:3', '-stats_mux_pre_fmt', '{size} {ptsi} {tbi}', '-f', 'null', 'pipe:1',
      ],
      userId: o.userId, signal: o.signal,
      onSide: (chunk) => {
        if (chunk === null || done) return
        text += Buffer.from(chunk).toString('latin1')
        let nl: number
        while ((nl = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, nl).trim()
          text = text.slice(nl + 1)
          if (!line) continue
          const m = /^(\d+) (-?\d+|N\/A) (\d+)\/(\d+)$/.exec(line)
          if (!m) throw new MediaError('failed')
          // Python's frame.time: pts · time_base of the stream (the packets carry the decoded frames' own).
          if (m[2] !== 'N/A' && (Number(m[2]) * Number(m[3])) / Number(m[4]) > cutSeconds) {
            done = true
            throw new CutReached()
          }
          kept += Number(m[1]) / (4 * C)
          if (kept * C > o.maxSamples) throw new MediaError('tooLong')
        }
      },
    })
  }
  catch (e) {
    if (e instanceof CutReached) return { kept, broken: false }
    // A decode error (the file opened: a probe read it). Stop, time limits and the caps stay failures.
    if (e instanceof MediaError && e.word === 'failed') return { kept, broken: true }
    throw e
  }
  return { kept, broken: false }
}

/** The AAC encoder's frame, in samples: a packet comes out for each one after the first. */
const AAC_FRAME = 1024

// ── encodeVideo ──────────────────────────────────────────────────────────────

export interface EncodeVideoOptions {
  input: VideoSource
  /** Where the finished MP4 goes (absolute; must not exist yet). */
  out: string
  /** The stream rate as Python sets it (`pyStreamRate`, or a clip's average_rate). */
  fps: Rational
  /** clips: the first clip's; else the input's. */
  size?: { w: number; h: number }
  /**
   * SaveVideoFrames (R5.5, nodes_video_effects.py:679-706): an odd width or
   * height is padded to even with black at the right and bottom (rgb24 zeros,
   * before the conversion to yuv420p, as Python pads its array) instead of
   * refused. 'ffv1' input only.
   */
  padToEven?: true
  quality: H264Quality
  sound?: { source: SoundSource; layout: SoundLayout; rate: number; cutSamples?: number } | null
  /** Written with -movflags use_metadata_tags (values as Python writes them: JSON text). */
  metadata?: Record<string, string>
  userId: string | null; signal?: AbortSignal
  /** The folders every input file must really be in (the person's own and the run's kept files). */
  roots?: readonly string[]
  /** The folders `out` may be written to (its folder, symlinks resolved, must be one of them or inside one). */
  outRoots: readonly string[]
  /** The job's own time limit (rule 5's by default). */
  timeoutMs?: number
}

/** Frames by which decode times run ahead of presentation, as libx264's defaults (B-frames, pyramid) make them. */
export const H264_DTS_DELAY = 2

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
  if (o.padToEven && input.kind !== 'ffv1') throw new MediaError('failed')
  /** The frames' own size (the kept batch's), before any padding. */
  const inW = W
  const inH = H
  if (o.padToEven) {
    if (!(Number.isInteger(W) && Number.isInteger(H) && W > 0 && H > 0)) throw new MediaError('failed')
    W += W % 2
    H += H % 2
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
      const p = await probeVideoInput(input.path, { userId: o.userId, signal: o.signal, roots, kept: true })
      const v = p.video[0]!
      if (v.w !== inW || v.h !== inH) throw new MediaError('sizeChanged')
      // `-r` as an input option: the kept batch's own stamps (FFV1_KEPT_RATE) are replaced by frames at
      // the video's rate, so each frame lasts 1/fps as a piped frame does (R5.2: without it the last
      // frame kept the batch file's duration, and the MP4 came out a frame short of Python's length).
      args.push('-noautorotate', '-r', `${o.fps.num}/${o.fps.den}`, ...inputArgs(p.path, p.format))
      // bgr0 → rgb24 is a lossless shuffle; then (R5.5) black padding to even, as Python's zeros; then exactly the rgb24 path.
      const pad = W !== inW || H !== inH ? `pad=w=${W}:h=${H}:x=0:y=0:color=black,` : ''
      const r = input.range
      if (r && !(Number.isInteger(r.start) && Number.isInteger(r.count) && r.start >= 0 && r.count >= 1)) throw new MediaError('failed')
      // R11.7: a segment of the batch, by frame number (the restamp after it numbers its frames from 0).
      const trim = r ? `trim=start_frame=${r.start}:end_frame=${r.start + r.count},` : ''
      args.push('-filter_complex', `[0:v]${trim}format=rgb24,${pad}${RGB_TO_YUV420P},${restamp}[v]`)
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
      // R3.17 fix round 1: `fps` after the renumbering keeps every frame (their times are already exactly
      // i / fps) and gives each one a duration of one frame, which `setpts` leaves as the clip's own: a clip
      // at another rate (a first clip at 25 fps, the rest at 24) otherwise changed the file's average rate.
      parts.push(`${joined}concat=n=${clipProbes.length}:v=1:a=0,${restamp},fps=${o.fps.num}/${o.fps.den}[v]`)
      args.push('-filter_complex', parts.join(';'))
      videoMap = '[v]'
    }

    /** The index the next `-i` gets. */
    const nextInput = () => args.filter(a => a === '-i').length
    // Sound: an input of its own.
    let soundIndex: number | null = null
    let soundFilter: string | null = null
    /** R5.5 fix round 1: how many AAC packets Python's file holds when its sound failed partway (null: all). */
    let soundPackets: number | null = null
    if (sound) {
      soundIndex = nextInput()
      const C = LAYOUT_CHANNELS[sound.layout]
      if ('sound' in sound.source) {
        const s = sound.source.sound
        const n = soundLength(s)
        if (s.channels.length !== C) throw new MediaError('failed')
        const cut = Math.min(n, sound.cutSamples ?? n)
        const raw = join(work, 'sound.f32')
        // Streamed to the file a chunk at a time: never a second whole copy (R5.1c review, Minor 5).
        await writeFile(raw, soundChunks(s, cut), { flag: 'wx' })
        args.push('-f', 'f32le', '-ar', String(sound.rate), '-ch_layout', sound.layout, '-protocol_whitelist', 'file,pipe', '-i', `file:${raw}`)
      }
      else {
        const cut = sound.source.cutSeconds
        // With a cut (SaveVideoFrames), only as much is read as the video lasts: the size cap is judged, not
        // the length (R5.5 fix round 1, Minor 2); what is decoded is held to the sample cap as it comes.
        const p = await probeMedia(sound.source.path, { userId: o.userId, signal: o.signal, roots, kind: 'sound', ...(cut !== undefined ? { anyLength: true as const } : {}) })
        const refused = cut !== undefined ? (p.sound.length ? null : 'noSound') : mediaCapsWord(p, 'sound', isHosted())
        if (refused) throw new MediaError(refused)
        const caps = isHosted() ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
        const keep = cut === undefined ? null : await samplesUpTo(p, cut, { userId: o.userId, signal: o.signal, maxSamples: caps.soundSamples })
        let end = keep?.kept ?? null
        if (keep?.broken) {
          // Python's loop ended in its `except` (R5.5 fix round 1): the encoder was never flushed, so the file
          // holds the packets it had made: one for each whole 1024-sample frame after the first. Only whole
          // frames go in, and every packet after that many is dropped (run.ts fromZeroBsfCut).
          const whole = Math.floor(keep.kept / AAC_FRAME)
          end = whole * AAC_FRAME
          soundPackets = whole - 1
        }
        if (soundPackets !== null && soundPackets < 1) {
          // No packet made before the error: Python's file has a sound stream with none in it. Named case:
          // the runner saves no sound stream.
          soundIndex = null
        }
        else {
          args.push(...inputArgs(p.path, p.format))
          // Python re-stamps every frame (`frame.pts = None`): the sound starts at 0 however the file's did.
          soundFilter = `${end !== null ? `atrim=end_sample=${end},` : ''}asetpts=N/SR/TB`
        }
      }
    }

    const tagsArgs = await tagsInput(work, o.metadata)
    const tagsIndex = tagsArgs ? nextInput() : null
    if (tagsArgs) args.push(...tagsArgs)

    const out = join(work, 'out.mp4')
    // Decode times two frames early (`setts`), as libx264's B-frames put them in Python's files: the
    // pictures are untouched (pts), and PyAV's get_components, which seeks the video to 0 before it
    // reads the sound, then keeps the AAC priming packet as it does in Python's own files (R5.1c
    // review, Important 3: with the video starting at 0 the seek drops it, and the sound starts
    // with 448 zeros).
    // No `encoder` tag on the streams (R5.4): PyAV's streams carry none, and the CLI's would name the build.
    args.push('-map', videoMap, '-fps_mode', 'passthrough', '-enc_time_base:v', tb, ...h264Args(o.quality), '-bsf:v', `setts=dts=DTS-${H264_DTS_DELAY}`, '-metadata:s:v:0', 'encoder=')
    if (sound && soundIndex !== null) {
      args.push('-map', `${soundIndex}:a:0`, '-c:a', 'aac', '-ar', String(sound.rate), '-ch_layout', sound.layout, '-metadata:s:a:0', 'encoder=')
      if (soundFilter) args.push('-af', soundFilter)
      // A file's sound (SaveVideoFrames, R5.5): Python sets every frame's pts to None, so the muxer numbers
      // the AAC packets from 0 and the encoder's priming (1024 samples) is not trimmed by an edit list: the
      // packets are numbered from 0 here too, which is what Python's reader then decodes.
      if (!('sound' in sound.source)) args.push('-bsf:a', soundPackets !== null ? fromZeroBsfCut(soundPackets) : FROM_ZERO_BSF)
    }
    args.push('-map_metadata', tagsIndex === null ? '-1' : String(tagsIndex))
    args.push('-movflags', '+faststart+use_metadata_tags', '-f', 'mp4', '-y', `file:${out}`)

    await runMedia({ tool: 'ffmpeg', args, userId: o.userId, signal: o.signal, stdin, workDir: work, cleanup: [out], timeoutMs: o.timeoutMs })
    if (input.kind === 'rgb' && counted.n === 0) throw new MediaError('noVideo')
    // The job's own output, only counted here: not held to the upload caps (R5.2 fix round 1: a made
    // video within the batch caps could pass videoBytes or videoSeconds and be refused after its encode).
    const made = await probeMedia(out, { userId: o.userId, signal: o.signal, roots: [work], kind: 'video', kept: true })
    const frames = made.video[0]?.frames ?? counted.n
    await moveOut(out, o.out, o.outRoots)
    return { frames }
  }
  finally {
    await removeMediaTempDir(work)
  }
}

// ── copyVideo ────────────────────────────────────────────────────────────────

/**
 * The MP4 muxer's own tag for a codec it can write under more than one
 * (libavformat's codec_mp4_tags, the first for each): what PyAV's copy gets,
 * since `add_stream_from_template` resets the codec tag to 0 and the muxer
 * then picks this one. A codec with a single MP4 tag needs no entry.
 */
export const MP4_DEFAULT_TAG: Readonly<Record<string, string>> = { h264: 'avc1', hevc: 'hev1' }

/**
 * A file's streams into an MP4 as they are, as VideoFromFile.save_to copies
 * them when it reuses them (video_types.py:344-374, R5.4): every video, sound
 * and subtitle stream (`add_stream_from_template`; data streams and chapters
 * are left out), packets untouched (`-c copy`), each stream at the time base
 * PyAV's muxer gives a stream it set none for (1/90000 for pictures and
 * subtitles, 1/rate for sound), `movflags use_metadata_tags`.
 *
 * The rule, as PyAV's copy (R5.4 fix round 1): the streams keep nothing of
 * the source's but their packets and codec parameters. Their codec tag is
 * reset (PyAV sets `codec_tag = 0`, so an `hvc1` HEVC comes out `hev1`, an
 * `avc3` H.264 `avc1`: MP4_DEFAULT_TAG), and no stream tag is copied
 * (`-map_metadata:s -1`: the muxer writes its own language and handler, as
 * PyAV's). The container's tags are Python's: the source's own, then
 * `metadata` over them (Python writes its tags after copying every source
 * tag they don't name), as an ffmetadata file. A codec the MP4 muxer doesn't
 * take fails, as PyAV raises.
 *
 * `probe`: the source's (probeMedia of the person's file, checked against the
 * video caps by the caller).
 */
export async function copyVideo(o: {
  probe: MediaProbe
  /** Where the finished MP4 goes (absolute; must not exist yet). */
  out: string
  /** Python's tags (text as it writes them); null for none (the Video card). */
  metadata: Record<string, string> | null
  userId: string | null; signal?: AbortSignal
  /** The folders `out` may be written to. */
  outRoots: readonly string[]
  timeoutMs?: number
}): Promise<void> {
  const p = o.probe
  if (!p.video.length) throw new MediaError('noVideo')
  const j = await ffprobeJson(p.path, p.format, ['-show_format', '-show_streams'], { userId: o.userId, signal: o.signal })
  const fmt = (j.format ?? {}) as { tags?: Record<string, unknown> }
  const source: Record<string, string> = {}
  for (const [k, v] of Object.entries(fmt.tags ?? {})) if (typeof v === 'string' && (!o.metadata || !Object.hasOwn(o.metadata, k))) source[k] = v
  const tags = { ...source, ...(o.metadata ?? {}) }
  const streams = Array.isArray(j.streams) ? (j.streams as { codec_type?: unknown; codec_name?: unknown; sample_rate?: unknown }[]) : []
  const rates = streams.filter(s => s.codec_type === 'audio').map(s => Number(s.sample_rate))
  const videoCodecs = streams.filter(s => s.codec_type === 'video').map(s => String(s.codec_name ?? ''))
  const work = await mediaTempDir()
  try {
    const args: string[] = [...inputArgs(p.path, p.format)]
    const tagsArgs = await tagsInput(work, tags)
    if (tagsArgs) args.push(...tagsArgs)
    const out = join(work, 'out.mp4')
    args.push('-map', '0:v', '-map', '0:a?', '-map', '0:s?', '-c', 'copy', '-map_chapters', '-1')
    args.push('-time_base:v', '1/90000', '-time_base:s', '1/90000')
    rates.forEach((r, k) => { if (Number.isInteger(r) && r > 0) args.push(`-time_base:a:${k}`, `1/${r}`) })
    videoCodecs.forEach((c, k) => { if (Object.hasOwn(MP4_DEFAULT_TAG, c)) args.push(`-tag:v:${k}`, MP4_DEFAULT_TAG[c]!) })
    args.push('-map_metadata', tagsArgs ? '1' : '-1', '-map_metadata:s', '-1', '-movflags', 'use_metadata_tags', '-f', 'mp4', '-y', `file:${out}`)
    await runMedia({ tool: 'ffmpeg', args, userId: o.userId, signal: o.signal, workDir: work, cleanup: [out], timeoutMs: o.timeoutMs })
    await moveOut(out, o.out, o.outRoots)
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
  /** The folders `out` may be written to. */
  outRoots: readonly string[]
  timeoutMs?: number
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
    if (rate !== sound.rate) {
      // A rate pair whose kernel would pass the cap is refused before any work (torchaudio would exhaust memory too).
      if (resampleTaps(sound.rate, rate) > RESAMPLE_MAX_TAPS) throw new MediaError('oddRate')
      // On the compositor worker, a channel at a time, under its Stop and watchdog: never on the server's main thread.
      try { sound = { rate, channels: await resampleInWorker(sound.channels, sound.rate, rate, o.signal) } }
      catch { throw new MediaError(o.signal?.aborted ? 'stopped' : 'failed') }
    }
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
    await runMedia({ tool: 'ffmpeg', args, userId: o.userId, signal: o.signal, stdin: soundChunks(sound, n), workDir: work, cleanup: [out], timeoutMs: o.timeoutMs })
    await moveOut(out, o.out, o.outRoots)
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
 * The rate a kept frame batch is stamped at (R5.2): a batch's own rate travels
 * beside it, so the file's only has to keep a long batch's length inside the
 * video caps its reader checks (`mediaCapsWord`: at 1 fps a local batch of
 * 10,000 frames would read as 2.8 hours and be refused). One frame per
 * Matroska millisecond: exact in its 1/1000 time base.
 */
export const FFV1_KEPT_RATE = 1000

/**
 * The FFV1 encoder settings every kept batch is written with (`writeFfv1`,
 * values.ts keepDecodedFrames). LC2: FFV1 version 4 (`-level 4`). The encoder
 * allocates each frame's packet at its worst case before coding it
 * (libavcodec/ffv1enc.c ff_ffv1_encode_buffer_size): for version 3 (what
 * ffmpeg picks over 720 × 576) that is (3·W·H + slices·(800 + 2(W + H))) ×
 * (2·8 + 5) bytes, about 63 bytes a pixel of bgr0 — 0.52 GB for one
 * 3840 × 2160 frame, about 1.05 GB at 16.6 MP, clamped near INT_MAX (2.1 GB)
 * past 34 MP — and a loaded machine refused it ("Failed to allocate packet").
 * Version 4's estimate is (3·W·H + slices·800) × (8 + 1) / 8, about 3.4 bytes
 * a pixel: 28 MB at 3840 × 2160, 226 MB at 8192 × 8192 (MEDIA_CAPS.local's
 * largest frame). Still lossless (the same reversible RGB transform), still
 * bit-exact, about the same size (measured on noise: within 0.5 % of version
 * 3, under KEPT_BATCH_RATIO). ffmpeg 8.0.3's encoder still marks version 4
 * experimental, hence `-strict experimental`; its decoder reads it without,
 * and reads the version 3 batches kept before LC2 as before. Sailor's ffmpeg
 * is pinned (tools.ts), so a kept file is written and read by one build.
 */
export const FFV1_KEPT_ENCODE: readonly string[] = ['-c:v', 'ffv1', '-threads:v', '1', '-pix_fmt', 'bgr0', '-level', '4', '-strict', 'experimental']

/**
 * An FFV1 Matroska of rgb24 frames (stored as bgr0, lossless: FFV1's RGB is
 * a reversible transform, and rgb24 ↔ bgr0 only moves bytes). Bit-exact
 * muxing, so the same frames make the same file (kept by sha256).
 */
export async function writeFfv1(o: { frames: AsyncIterable<Uint8Array>; w: number; h: number; out: string; outRoots: readonly string[]; userId: string | null; signal?: AbortSignal; timeoutMs?: number; lease?: MediaLease }): Promise<{ count: number }> {
  if (!(Number.isInteger(o.w) && Number.isInteger(o.h) && o.w > 0 && o.h > 0)) throw new MediaError('failed')
  const work = await mediaTempDir()
  try {
    const counted = { n: 0 }
    const out = join(work, 'out.mkv')
    const args = [
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${o.w}x${o.h}`, '-framerate', String(FFV1_KEPT_RATE), '-i', 'pipe:0',
      '-map', '0:v', '-map_metadata', '-1', '-fps_mode', 'passthrough',
      ...FFV1_KEPT_ENCODE,
      '-fflags', '+bitexact', '-f', 'matroska', '-y', `file:${out}`,
    ]
    await runMedia({ tool: 'ffmpeg', args, userId: o.userId, signal: o.signal, stdin: checkedFrames(o.frames, o.w * o.h * 3, counted, o.signal), workDir: work, cleanup: [out], timeoutMs: o.timeoutMs, ...(o.lease ? { lease: o.lease } : {}) })
    if (counted.n === 0) throw new MediaError('noVideo')
    await moveOut(out, o.out, o.outRoots)
    return { count: counted.n }
  }
  finally {
    await removeMediaTempDir(work)
  }
}
