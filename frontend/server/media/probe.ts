/**
 * What a video or sound file is, read the way Python's PyAV reads it (step 3,
 * R5.1b). `probeMedia` runs `ffprobe -show_format -show_streams` (capped at
 * `-probesize 5000000 -analyzeduration 5000000`, PyAV's own defaults, and a
 * 10 s limit) and keeps the fields PyAV exposes:
 *   - `avg_frame_rate` for `average_rate` (`0/0` is null);
 *   - `nb_frames` for `frames`;
 *   - `duration_ts` with `time_base` for a stream's `duration`;
 *   - `format.duration` × 1e6 for `container.duration`.
 *
 * The py* helpers are VideoFromFile's own (comfy_api/latest/_input_impl/
 * video_types.py): `_get_raw_duration` (:110-138), `get_frame_count`
 * (:140-210), `get_frame_rate` (:212-233), with no start time or duration.
 * Where Python counts packets, so does the runner (demux only, never a decode).
 *
 * The module checks its own inputs (`resolveMediaInput`): a path must
 * resolve, symlinks followed, to a regular file inside the roots the caller
 * passes (the person's own folders), and every tool then reads that real
 * path. The caller still decides which roots are the person's.
 */
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'
import {
  MEDIA_ANALYZEDURATION, MEDIA_CAPS, MEDIA_PROBE_TIMEOUT_MS, MEDIA_PROBESIZE, MEDIA_SCAN_BYTES_PER_MS, MEDIA_WORDS,
  type MediaCaps, type MediaWord,
} from '#shared/runner/media'
import { MEDIA_SNIFF_BYTES, mediaFormat, type MediaFormat } from '../runner/mediaInputs'
import { isHosted } from '../utils/deployMode'
import { MediaError, inputArgs, runMedia } from './run'

export interface Rational { num: number; den: number }

export interface VideoStreamProbe {
  index: number; w: number; h: number; codec: string; pixFmt: string
  averageRate: Rational | null; frames: number | null
  /** The stream's duration in its time base. */
  duration: number | null; timeBase: Rational
  colorRange: string | null; colorSpace: string | null
  /** 'left', 'center', 'topleft'…, or null when the file doesn't say (the decoder's picture conversion reads it). */
  chromaLocation: string | null
}

export interface SoundStreamProbe {
  index: number; rate: number; channels: number; layout: string | null; codec: string; sampleFmt: string
  duration: number | null; timeBase: Rational
  /**
   * Seconds measured from the stream's packets (demux only), only when
   * neither the stream nor the container states a length (a browser's
   * recording): for the length cap, never for Python's numbers. Null otherwise.
   */
  measuredSeconds: number | null
}

export interface MediaProbe {
  /** The file's real path (symlinks resolved), checked inside the caller's roots: every tool reads this one. */
  path: string
  format: MediaFormat
  /** libavformat's own, e.g. 'mov,mp4,m4a,3gp,3g2,mj2'. */
  formatName: string
  /** AV_TIME_BASE units, as PyAV's container.duration. */
  containerDuration: number | null
  video: VideoStreamProbe[]; sound: SoundStreamProbe[]
  bytes: number
  /**
   * The first video stream's packets, counted only where Python counts them
   * (no container duration, and no frame count or rate to divide):
   * `_get_raw_duration`'s last resort. Null otherwise.
   */
  videoPackets: number | null
}

/** A file's first bytes, read without reading the rest. */
async function head(path: string, n = 64): Promise<Uint8Array> {
  const fh = await open(path, 'r')
  try {
    const buf = new Uint8Array(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  }
  finally { await fh.close() }
}

/** The container of a file on disk, from its first bytes (`mediaFormat`), or null. */
export async function sniffMediaFormat(path: string): Promise<MediaFormat | null> {
  return mediaFormat(await head(path, MEDIA_SNIFF_BYTES))
}

function rational(s: unknown): Rational | null {
  if (typeof s !== 'string') return null
  const m = /^(-?\d+)\/(\d+)$/.exec(s)
  if (!m) return null
  const num = Number(m[1]); const den = Number(m[2])
  return den === 0 || num === 0 ? null : { num, den }
}

function int(s: unknown): number | null {
  if (typeof s === 'number' && Number.isInteger(s)) return s
  if (typeof s === 'string' && /^-?\d+$/.test(s)) return Number(s)
  return null
}

/** ffprobe prints 'unknown' / 'unspecified' where PyAV says unspecified. */
function tag(s: unknown): string | null {
  return typeof s === 'string' && s !== 'unknown' && s !== 'unspecified' ? s : null
}

type Json = Record<string, unknown>

/** Every ffprobe's read caps (rule 6), before its input. */
export function probeCaps(): string[] {
  return ['-probesize', String(MEDIA_PROBESIZE), '-analyzeduration', String(MEDIA_ANALYZEDURATION)]
}

/** The fixed start of every probe: the caps, then the input. */
function probeInput(path: string, fmt: MediaFormat): string[] {
  return [...probeCaps(), ...inputArgs(path, fmt)]
}

export interface ProbeJobOptions { userId: string | null; signal?: AbortSignal; route?: boolean; timeoutMs?: number }

/** A tool failure or unparsable answer is "can't be read"; Stop, the time limit and missing tools keep their own words. */
function unreadableOnFailure(e: unknown): never {
  if (e instanceof MediaError && e.word === 'failed') throw new MediaError('unreadable')
  throw e
}

/** One ffprobe answer as JSON (header-sized: capped by runMedia's collection limit). */
export async function ffprobeJson(path: string, fmt: MediaFormat, extra: string[], o: ProbeJobOptions): Promise<Json> {
  let out: Uint8Array | null = null
  try {
    ({ stdout: out } = await runMedia({
      tool: 'ffprobe', args: [...probeInput(path, fmt), '-of', 'json', ...extra],
      userId: o.userId, signal: o.signal, route: o.route, timeoutMs: o.timeoutMs ?? MEDIA_PROBE_TIMEOUT_MS,
    }))
  }
  catch (e) { unreadableOnFailure(e) }
  try {
    const j = JSON.parse(Buffer.from(out!).toString('utf8')) as unknown
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object')
    return j as Json
  }
  catch { throw new MediaError('unreadable') }
}

/**
 * A whole-file listing (`-of compact`), streamed a line at a time as
 * `key=value` records, so a long file never piles up in memory.
 */
async function ffprobeRecords(path: string, fmt: MediaFormat, extra: string[], o: ProbeJobOptions, onRecord: (r: Record<string, string>) => void): Promise<void> {
  let rest = ''
  const take = (line: string) => {
    if (!line.trim()) return
    const r: Record<string, string> = {}
    for (const kv of line.trim().split('|')) {
      const at = kv.indexOf('=')
      if (at > 0) r[kv.slice(0, at)] = kv.slice(at + 1)
    }
    onRecord(r)
  }
  try {
    await runMedia({
      tool: 'ffprobe', args: [...probeInput(path, fmt), '-of', 'compact=p=0', ...extra],
      userId: o.userId, signal: o.signal, route: o.route, timeoutMs: o.timeoutMs ?? MEDIA_PROBE_TIMEOUT_MS,
      onStdout: (chunk) => {
        rest += Buffer.from(chunk).toString('latin1')
        let nl: number
        while ((nl = rest.indexOf('\n')) >= 0) { take(rest.slice(0, nl)); rest = rest.slice(nl + 1) }
      },
    })
  }
  catch (e) { unreadableOnFailure(e) }
  take(rest)
}

/** A whole-file scan's own time limit: the probe's, plus a second per 20 MB (so a large local file isn't refused as unreadable). */
export function scanTimeoutMs(bytes: number): number {
  return MEDIA_PROBE_TIMEOUT_MS + Math.ceil(bytes / MEDIA_SCAN_BYTES_PER_MS)
}

/**
 * A media input's real path: absolute, a regular file once symlinks are
 * resolved, and inside one of `roots` (the person's own folders, resolved
 * too). A link out of the folder, a missing file or a folder is refused as
 * "can't be read". Every tool then reads the real path, not the name given.
 */
export async function resolveMediaInput(path: string, roots: readonly string[]): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0')) throw new MediaError('unreadable')
  let real: string
  try {
    real = await realpath(path)
    if (!(await stat(real)).isFile()) throw new Error('not a file')
  }
  catch { throw new MediaError('unreadable') }
  for (const root of roots) {
    if (!isAbsolute(root)) continue
    let r: string
    try { r = await realpath(root) }
    catch { continue }
    if (real.startsWith(r.endsWith(sep) ? r : r + sep)) return real
  }
  throw new MediaError('unreadable')
}

export interface ProbeOptions {
  userId: string | null; signal?: AbortSignal; route?: boolean
  /** The folders the file must really be in (the person's own). */
  roots: readonly string[]
  /**
   * What the caller will read: its caps are judged from the size and the
   * header before any whole-file scan. Without it, the looser of the two
   * kinds' caps.
   */
  kind?: 'video' | 'sound'
  /**
   * R5.2 fix round 1: the file is the runner's own kept file (a frame batch or
   * an exact sound, its sha256 verified), read back under the caps it was
   * kept under (batchFrames/batchPixels, soundSamples: server/media/values.ts),
   * not the upload caps (videoBytes, soundBytes and the lengths), which are
   * for files a person brings in. The header caps are then not judged here.
   */
  kept?: true
  /**
   * R5.5 fix round 1: a sound of which only a stretch is read (Save video
   * frames' soundtrack, cut at the video's length): its size cap is judged,
   * not its stated length. The caller holds what it decodes to the sample cap.
   */
  anyLength?: true
}

/** The size, frame and stated-length caps, judged from the header alone (before any whole-file scan). */
function headerCapsWord(p: MediaProbe, kind: 'video' | 'sound' | undefined, hosted: boolean, anyLength = false): MediaWord | null {
  const caps: MediaCaps = hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
  const maxBytes = kind === 'video' ? caps.videoBytes : kind === 'sound' ? caps.soundBytes : Math.max(caps.videoBytes, caps.soundBytes)
  if (p.bytes > maxBytes) return 'tooBig'
  if (anyLength) return null
  if (kind === 'video' && p.video[0] && p.video[0].w * p.video[0].h > caps.framePixels) return 'tooBig'
  const maxSeconds = kind === 'video' ? caps.videoSeconds : kind === 'sound' ? caps.soundSeconds : Math.max(caps.videoSeconds, caps.soundSeconds)
  if (p.containerDuration !== null && p.containerDuration / 1e6 > maxSeconds) return 'tooLong'
  if (kind === 'sound') {
    for (const t of p.sound) {
      if (t.duration === null) continue
      const secs = (t.duration * t.timeBase.num) / t.timeBase.den
      if (secs > caps.soundSeconds || secs * t.rate * t.channels > caps.soundSamples) return 'tooLong'
    }
  }
  return null
}

/**
 * The header of one file. Refuses, before any tool starts, a path that
 * isn't a real file inside `roots` (`resolveMediaInput`) and a file whose
 * first bytes aren't a container Sailor knows (a playlist renamed `.mp4`).
 * The size and the header's own lengths are judged against the caps before
 * any whole-file scan, and a scan has its own time limit, scaled to the size.
 */
export async function probeMedia(path: string, o: ProbeOptions): Promise<MediaProbe> {
  const real = await resolveMediaInput(path, o.roots)
  let bytes: number
  try { bytes = (await stat(real)).size }
  catch { throw new MediaError('unreadable') }
  const format = await sniffMediaFormat(real).catch(() => null)
  if (!format) throw new MediaError('unreadable')
  path = real

  const j = await ffprobeJson(path, format, ['-show_format', '-show_streams'], o)
  const fmt = (j.format ?? {}) as Json
  const streams = Array.isArray(j.streams) ? (j.streams as Json[]) : []
  const video: VideoStreamProbe[] = []
  const sound: SoundStreamProbe[] = []
  for (const s of streams) {
    const timeBase = rational(s.time_base)
    const index = int(s.index)
    if (!timeBase || index === null) continue
    if (s.codec_type === 'video') {
      video.push({
        index, w: int(s.width) ?? 0, h: int(s.height) ?? 0,
        codec: String(s.codec_name ?? ''), pixFmt: String(s.pix_fmt ?? ''),
        averageRate: rational(s.avg_frame_rate), frames: int(s.nb_frames),
        duration: int(s.duration_ts), timeBase,
        colorRange: tag(s.color_range), colorSpace: tag(s.color_space), chromaLocation: tag(s.chroma_location),
      })
    }
    else if (s.codec_type === 'audio') {
      const channels = int(s.channels) ?? 0
      sound.push({
        index, rate: int(s.sample_rate) ?? 0, channels,
        // ffprobe leaves out a layout with no channel order; PyAV names it "N channels" (av_channel_layout_describe).
        layout: typeof s.channel_layout === 'string' ? s.channel_layout : channels > 0 ? `${channels} channels` : null,
        codec: String(s.codec_name ?? ''), sampleFmt: String(s.sample_fmt ?? ''),
        duration: int(s.duration_ts), timeBase, measuredSeconds: null,
      })
    }
  }
  const secs = typeof fmt.duration === 'string' ? Number(fmt.duration) : Number.NaN
  const p: MediaProbe = {
    path,
    format,
    formatName: String(fmt.format_name ?? ''),
    // ffprobe prints container.duration / 1e6 to six places: the microseconds are exact.
    containerDuration: Number.isFinite(secs) ? Math.round(secs * 1e6) : null,
    video, sound, bytes, videoPackets: null,
  }
  const early = o.kept ? null : headerCapsWord(p, o.kind, isHosted(), !!o.anyLength)
  if (early) throw new MediaError(early)
  const scan: ProbeJobOptions = { userId: o.userId, signal: o.signal, route: o.route, timeoutMs: scanTimeoutMs(bytes) }
  const v = video[0]
  if (p.containerDuration === null && v && !(v.frames && v.averageRate) && v.averageRate) {
    p.videoPackets = await countVideoPackets(path, format, scan)
  }
  if (p.containerDuration === null && sound.some(t => t.duration === null)) await measureSound(path, p, scan)
  return p
}

/** Each sound stream's span from its packets' pts and durations (demux only, streamed). */
async function measureSound(path: string, p: MediaProbe, o: ProbeJobOptions): Promise<void> {
  const span = new Map<number, { start: number; end: number }>()
  await ffprobeRecords(path, p.format, ['-select_streams', 'a', '-show_entries', 'packet=stream_index,pts,duration'], o, (k) => {
    const index = int(k.stream_index); const pts = int(k.pts); const dur = int(k.duration) ?? 0
    if (index === null || pts === null) return
    const sp = span.get(index)
    if (!sp) span.set(index, { start: pts, end: pts + dur })
    else { sp.start = Math.min(sp.start, pts); sp.end = Math.max(sp.end, pts + dur) }
  })
  for (const t of p.sound) {
    const sp = span.get(t.index)
    if (t.duration === null && sp) t.measuredSeconds = ((sp.end - sp.start) * t.timeBase.num) / t.timeBase.den
  }
}

/** The first video stream's packets, by demuxing only. */
async function countVideoPackets(path: string, fmt: MediaFormat, o: ProbeJobOptions): Promise<number> {
  const j = await ffprobeJson(path, fmt, ['-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets'], o)
  const n = int(((j.streams as Json[] | undefined)?.[0] ?? {}).nb_read_packets)
  if (n === null) throw new MediaError('unreadable')
  return n
}

/**
 * `_get_raw_duration`: container.duration / AV_TIME_BASE; else the first
 * video stream's frames / average_rate; else (packets + 1) / average_rate —
 * PyAV's demux ends with an empty flush packet, and Python counts it. Null
 * where Python raises.
 */
export function pyRawDuration(p: MediaProbe): number | null {
  if (p.containerDuration !== null) return p.containerDuration / 1e6
  const v = p.video[0]
  if (v && v.frames && v.averageRate) return (v.frames * v.averageRate.den) / v.averageRate.num
  if (v && v.averageRate && p.videoPackets !== null) {
    const count = p.videoPackets + 1
    return (count * v.averageRate.den) / v.averageRate.num
  }
  return null
}

/** Python's round(): halves to even. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d > 0.5) return f + 1
  if (d < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/**
 * `get_frame_count`: the stream's frames when > 0; else
 * int(round(duration · time_base · float(average_rate))) when > 0; else the
 * packets from the first one stamped at or after 0 (demux order), counted.
 *
 * That last branch is where the runner differs from Python: Python's loop
 * compares the empty flush packet's pts (None) and raises TypeError, so every
 * file that reaches it (a Matroska or WebM, whose header has neither a frame
 * count nor a stream duration) fails in Python. The runner returns the count
 * the loop means. Named in the R5.1b report.
 */
export async function pyFrameCount(p: MediaProbe, path: string, o: { userId: string | null; signal?: AbortSignal }): Promise<number> {
  // The probe's own checked real path is what the tool reads; `path` must name the same file.
  if (path !== p.path && (await realpath(path).catch(() => null)) !== p.path) throw new MediaError('unreadable')
  const v = p.video[0]
  if (!v) throw new MediaError('noVideo')
  if (v.frames && v.frames > 0) return v.frames
  if (v.duration !== null && v.averageRate) {
    const seconds = (v.duration * v.timeBase.num) / v.timeBase.den
    const estimated = roundHalfEven(seconds * (v.averageRate.num / v.averageRate.den))
    if (estimated > 0) return estimated
  }
  // Streamed: every packet from the first stamped at or after 0 counts.
  let counted = 0
  let from = false
  await ffprobeRecords(p.path, p.format, ['-select_streams', 'v:0', '-show_entries', 'packet=pts'], { userId: o.userId, signal: o.signal, timeoutMs: scanTimeoutMs(p.bytes) }, (k) => {
    const t = int(k.pts)
    if (!from && t !== null && t >= 0) from = true
    if (from) counted++
  })
  if (!from) throw new MediaError('unreadable')
  return counted
}

/** R6.1 fix round 1: frames added to a rate × length bound, for a length the header rounds. */
export const FRAME_BOUND_MARGIN = 2

/**
 * A TRUE upper bound on the frames a decode of the first video stream can
 * give (R6.1 fix round 1: the video effects' start pass; `pyFrameCount` is
 * Python's estimate, which a file can pass). ceil(length × the faster of
 * avg_frame_rate and r_frame_rate) + FRAME_BOUND_MARGIN, never under the
 * header's frame count; and the stream's packets counted instead (a demux,
 * no decode, within the scan's time limit) where the file's rate is
 * variable (the two rates differ), where it has no usable length or rate, or
 * where the caller asks (`count`: the bound lands near a limit). Every
 * decoded frame comes from a packet, so the count bounds the frames.
 * `counted`: the packets were counted.
 */
export async function pyFrameBound(p: MediaProbe, o: { userId: string | null; signal?: AbortSignal; count?: boolean }): Promise<{ frames: number; counted: boolean }> {
  const v = p.video[0]
  if (!v) throw new MediaError('noVideo')
  const counted = async () => ({ frames: await countVideoPackets(p.path, p.format, { userId: o.userId, signal: o.signal, timeoutMs: scanTimeoutMs(p.bytes) }), counted: true })
  if (o.count) return counted()
  const j = await ffprobeJson(p.path, p.format, ['-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate'], { userId: o.userId, signal: o.signal })
  const real = rational(((j.streams as Json[] | undefined)?.[0] ?? {}).r_frame_rate)
  const avg = v.averageRate
  const secs = v.duration !== null ? (v.duration * v.timeBase.num) / v.timeBase.den
    : p.containerDuration !== null ? p.containerDuration / 1e6 : null
  if (!avg || !real || avg.num * real.den !== real.num * avg.den || secs === null || !(secs > 0) || !Number.isFinite(secs)) return counted()
  const rate = Math.max(avg.num / avg.den, real.num / real.den)
  const bound = Math.ceil(secs * rate) + FRAME_BOUND_MARGIN
  return { frames: Math.max(bound, v.frames ?? 0), counted: false }
}

// ── Fraction(float).limit_denominator(), exactly ─────────────────────────────

function bigAbs(n: bigint): bigint { return n < 0n ? -n : n }
function gcd(a: bigint, b: bigint): bigint {
  a = bigAbs(a); b = bigAbs(b)
  while (b) [a, b] = [b, a % b]
  return a
}
/** Python's floor division. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q
}

/** A double's exact value as a reduced fraction (Python's Fraction(float)). */
export function exactFraction(x: number): [bigint, bigint] {
  const buf = new DataView(new ArrayBuffer(8))
  buf.setFloat64(0, x)
  const hi = buf.getUint32(0); const lo = buf.getUint32(4)
  const sign = hi >>> 31 ? -1n : 1n
  const exp = (hi >>> 20) & 0x7FF
  let mant = (BigInt(hi & 0xFFFFF) << 32n) | BigInt(lo)
  let e: number
  if (exp === 0) e = -1074
  else { mant |= 1n << 52n; e = exp - 1075 }
  let num = sign * mant; let den = 1n
  if (e >= 0) num <<= BigInt(e)
  else den <<= BigInt(-e)
  const g = gcd(num, den) || 1n
  return [num / g, den / g]
}

/** CPython's Fraction.limit_denominator (3.12). */
export function limitDenominator(num: bigint, den: bigint, maxDen = 1_000_000n): [bigint, bigint] {
  if (den <= maxDen) return [num, den]
  let p0 = 0n; let q0 = 1n; let p1 = 1n; let q1 = 0n
  let n = num; let d = den
  for (;;) {
    const a = floorDiv(n, d)
    const q2 = q0 + a * q1
    if (q2 > maxDen) break
    ;[p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2]
    ;[n, d] = [d, n - a * d]
  }
  const k = floorDiv(maxDen - q0, q1)
  if (2n * d * (q0 + k * q1) <= den) return [p1, q1]
  return [p0 + k * p1, q0 + k * q1]
}

/**
 * `get_frame_rate`: average_rate; else Fraction(frames / seconds)
 * .limit_denominator() from the container's duration; else 1.
 */
export function pyFrameRate(p: MediaProbe): Rational {
  const v = p.video[0]
  if (!v) throw new MediaError('noVideo')
  if (v.averageRate) return { ...v.averageRate }
  if (v.frames && p.containerDuration) {
    const seconds = p.containerDuration / 1e6
    if (seconds > 0) {
      const [n, d] = limitDenominator(...exactFraction(v.frames / seconds))
      return { num: Number(n), den: Number(d) }
    }
  }
  return { num: 1, den: 1 }
}

/** A sound stream's length in seconds: its own duration, else the container's, else its packets'. */
function soundSeconds(p: MediaProbe, s: SoundStreamProbe): number | null {
  if (s.duration !== null) return (s.duration * s.timeBase.num) / s.timeBase.den
  if (p.containerDuration !== null) return p.containerDuration / 1e6
  return s.measuredSeconds
}

/**
 * The size, length and dimension caps (ruling f), judged from the probe
 * alone, before any decode: the MEDIA_WORDS key, or null. In hosted, a file
 * whose length can't be read is refused.
 */
export function mediaCapsWord(p: MediaProbe, kind: 'video' | 'sound', hosted: boolean): MediaWord | null {
  const caps = hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
  if (kind === 'video') {
    if (p.bytes > caps.videoBytes) return 'tooBig'
    const v = p.video[0]
    if (!v) return 'noVideo'
    if (v.w * v.h > caps.framePixels) return 'tooBig'
    const seconds = pyRawDuration(p)
    if (seconds === null) return hosted ? 'unreadable' : null
    if (seconds > caps.videoSeconds) return 'tooLong'
    return null
  }
  if (p.bytes > caps.soundBytes) return 'tooBig'
  if (!p.sound.length) return 'noSound'
  let unknown = false
  for (const t of p.sound) {
    const secs = soundSeconds(p, t)
    if (secs === null) { unknown = true; continue }
    if (secs > caps.soundSeconds || secs * t.rate * t.channels > caps.soundSamples) return 'tooLong'
  }
  return unknown && hosted ? 'unreadable' : null
}

/** `mediaCapsWord` in words: a MEDIA_WORDS entry, or null. */
export function checkMediaCaps(p: MediaProbe, kind: 'video' | 'sound', hosted: boolean): string | null {
  const word = mediaCapsWord(p, kind, hosted)
  return word ? MEDIA_WORDS[word] : null
}
