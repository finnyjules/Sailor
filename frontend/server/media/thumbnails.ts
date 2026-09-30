/**
 * The Timeline's video thumbnails, sound waveforms and asset probe, made by
 * Sailor's own media tools the way comfy_extras/nodes_timeline.py makes them
 * with PyAV (step 3, R5.6). server/native/media.ts serves them on its four
 * routes when the tools are ready; without them the routes go to the engine as
 * before. Parity: scripts/runner_media_fixtures.py --group timeline-media,
 * which runs the real handlers (lifted with `ast`) over the standard clips.
 *
 *   probeTimelineMedia  `_probe_media` (:2077-2120): a video's first stream's
 *                       width, height and `duration · time_base` (when both
 *                       are set); a sound's first stream's duration; any
 *                       failure gives nulls.
 *   videoThumbnails     `_gen_thumbnails` for a video (:2184-2245). For each
 *                       thumbnail, `t = step · (i + 0.5)`, target
 *                       `int(t / time_base)`; PyAV seeks backward to the
 *                       keyframe at or before it and decodes on to the first
 *                       frame whose pts ≥ target (or the last one decoded, when
 *                       the file ends first). One ffmpeg job per thumbnail makes
 *                       the same seek (`-ss` before `-i`, `-noaccurate_seek`,
 *                       `-seek_timestamp 1`, in whole microseconds that land on
 *                       the target pts) and picks the same frame with
 *                       `select=gte(pts\,target)` over the decoder's own pts
 *                       (`-copyts`); `-noaccurate_seek` alone hands over the
 *                       keyframe, which is Python's frame only when the target
 *                       is a keyframe (the R5.6 report's seek-parity finding).
 *                       When nothing is selected (the file ends before the
 *                       target), a second job from the same seek keeps the last
 *                       frame. rgb24 as decode.ts converts it (PyAV's
 *                       to_ndarray), then Pillow's BILINEAR to 48 px high
 *                       (pixels/core.ts pilResize: inline up to
 *                       THUMB_WORKER_PIXELS, on the Frame's worker above), then
 *                       a PNG from sharp (its bytes differ from PIL's
 *                       optimize=True; its pixels don't).
 *   waveformPeaks       `_gen_waveform_peaks` (:2319-2352), streamed (R5.6 fix
 *                       round 1): the first sound stream as decode.ts's `load`
 *                       reads it (pcm_f32le; a u8 sound back to 0…255), in two
 *                       passes of the same decode. The first counts the
 *                       samples (Python's bucket width needs the length); the
 *                       second keeps only each bucket's largest |value| and the
 *                       peak, so memory is the bucket count, never the sound.
 *                       Python's `flat`: a packed file is one row of interleaved
 *                       samples (not mixed), a planar one numpy's mean of its
 *                       channels (float32 row by row for float samples, float64
 *                       for integer ones). Each bucket is then float32(max /
 *                       peak), which equals Python's max of float32(x / peak):
 *                       float32 division by a positive number never changes
 *                       order. The samples' scale (Python's integers, the
 *                       decoder's floats) is a power of two, so the division by
 *                       the peak makes it vanish exactly.
 *
 * Every job uses the routes' own slots and their 30 s limit (rule 5). A
 * failure answers Python's own failure ([] or nulls). Only Python's genuine
 * empties are marked `cache: true` (no stream, no length, nothing decoded, a
 * file that can't be opened as media); anything from Sailor's own side (a
 * cap, the time limit, Stop, busy slots, a tool failure, the tools gone, the
 * worker) is `cache: false` and logged, so the route keeps nothing and the
 * next request tries again.
 */
import sharp from 'sharp'
import { MEDIA_CAPS } from '#shared/runner/media'
import { isHosted } from '../utils/deployMode'
import { pixelsInWorker } from '../runner/compositor/worker'
import { pixels } from '../runner/pixels/core'
import { framesScale } from './decode'
import { MediaError, inputArgs, runMedia } from './run'
import { mediaCapsWord, probeMedia, type MediaProbe, type Rational, type VideoStreamProbe } from './probe'

/** `_thumb_height_px()`: a thumbnail's height; its width follows the frame's aspect (server/native/media.ts has the same, for images). */
export const THUMB_HEIGHT_PX = 48

export interface RouteMediaOptions {
  /** The folders a file must really be in (`resolveMediaInput`). */
  roots: readonly string[]
  userId: string | null
  signal?: AbortSignal
}

/** What the routes are given when the tools are ready (server/native/media.ts). */
export interface NativeMedia {
  probe(file: string, kind: 'video' | 'audio'): Promise<TimelineProbe>
  thumbnails(file: string, count: number): Promise<ThumbnailsAnswer>
  waveform(file: string, buckets: number): Promise<PeaksAnswer>
}

/** `keep: false` when the numbers are missing for Sailor's own reason (a cap, the time limit…): the import records nothing. */
export interface TimelineProbe { duration_sec: number | null; width: number | null; height: number | null; keep: boolean }
/** `cache: false` when the answer says nothing about the file (timed out, stopped, tools gone): not kept. */
export interface ThumbnailsAnswer { pngs: Buffer[]; cache: boolean }
export interface PeaksAnswer { peaks: number[]; cache: boolean }

export function nativeMedia(o: RouteMediaOptions): NativeMedia {
  return {
    probe: (file, kind) => probeTimelineMedia(file, kind, o),
    thumbnails: (file, count) => videoThumbnails(file, count, o),
    waveform: (file, buckets) => waveformPeaks(file, buckets, o),
  }
}

/**
 * Whether a failure is the file's own answer (kept, as Python keeps its []):
 * only 'unreadable', a file that isn't media Sailor can open (PyAV's open
 * failing). Anything else is Sailor's own (a cap, the time limit, Stop, busy
 * slots, a tool failure, the tools gone, an error): not kept, and logged.
 */
function failure(e: unknown, what: string, file: string): { cache: boolean } {
  const word = e instanceof MediaError ? e.word : null
  if (word === 'unreadable') return { cache: true }
  console.warn(`[media] media.route.${what}: ${word ?? (e as Error)?.message ?? String(e)} (${file})`)
  return { cache: false }
}

/** Stop (the request closed) between jobs. */
function checkStop(o: RouteMediaOptions): void {
  if (o.signal?.aborted) throw new MediaError('stopped')
}

function caps() {
  return isHosted() ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
}

/** Python's float(n · Fraction(tb)): exact, then rounded once. */
function seconds(n: number, tb: Rational): number {
  return (n * tb.num) / tb.den
}

// ── the probe ────────────────────────────────────────────────────────────────

/**
 * `_probe_media` for a video or sound extension. Only the header is read, so
 * only the size cap is judged (`anyLength`); the numbers are the stream's own,
 * as PyAV's `stream.duration` and `stream.time_base`.
 */
export async function probeTimelineMedia(file: string, kind: 'video' | 'audio', o: RouteMediaOptions): Promise<TimelineProbe> {
  const out: TimelineProbe = { duration_sec: null, width: null, height: null, keep: true }
  let p: MediaProbe
  try {
    p = await probeMedia(file, { userId: o.userId, signal: o.signal, roots: o.roots, route: true, kind: kind === 'video' ? 'video' : 'sound', anyLength: true })
  }
  catch (e) {
    out.keep = failure(e, 'probe', file).cache
    return out
  }
  if (kind === 'video') {
    const v = p.video[0]
    if (!v) return out
    out.width = v.w
    out.height = v.h
    if (v.duration) out.duration_sec = seconds(v.duration, v.timeBase)
    return out
  }
  const s = p.sound[0]
  if (s?.duration) out.duration_sec = seconds(s.duration, s.timeBase)
  return out
}

// ── thumbnails ───────────────────────────────────────────────────────────────

/** libavutil's av_rescale(a, b, c) for a, b, c ≥ 0: rounded to nearest, halves away from zero. */
function rescale(a: bigint, b: bigint, c: bigint): bigint {
  return (a * b + c / 2n) / c
}

/**
 * The `-ss` (whole microseconds) whose seek lands on `target` in the stream's
 * time base: ffmpeg rescales it with av_rescale (to nearest) into the default
 * stream's time base, as PyAV's seek names the pts directly. Where no
 * microsecond lands exactly (a time base finer than 1 µs), the last one below.
 * Exported for tests.
 */
export function seekMicros(target: number, tb: Rational): number {
  const t = BigInt(target)
  const num = BigInt(tb.num)
  const den = BigInt(tb.den)
  const toPts = (us: bigint) => rescale(us, den, 1_000_000n * num)
  let us = (t * 1_000_000n * num) / den
  while (us > 0n && toPts(us) > t) us--
  while (toPts(us) < t && toPts(us + 1n) <= t) us++
  return Number(us)
}

export interface RgbFrame { rgb: Uint8Array; w: number; h: number }

/**
 * One job over the frames from the seek on: each frame converted to rgb24
 * (decode.ts's conversion), with its size read beside it (a one-row and a
 * one-column branch into a null output, whose `-stats_mux_pre` sizes are the
 * frame's width and height: decode.ts decodeFramesAnySize's way). `target`:
 * only the first frame with pts ≥ target, then stop; null: every frame, the
 * last one kept.
 */
async function framesFromSeek(p: MediaProbe, v: VideoStreamProbe, us: number, target: number | null, o: RouteMediaOptions): Promise<RgbFrame | null> {
  if (target !== null && !(Number.isSafeInteger(target) && target >= 0)) throw new MediaError('failed')
  const one = target === null ? [] : ['-frames:v', '1']
  const graph = `[0:v:0]${target === null ? '' : `select=gte(pts\\,${target}),`}split=3[a][b][c];[a]${framesScale(v)}[f];`
    + '[b]scale=w=iw:h=1:eval=frame:flags=bilinear,format=gray[wd];[c]scale=w=1:h=ih:eval=frame:flags=bilinear,format=gray[ht]'
  const args = [
    '-copyts', '-reinit_filter', '0', '-noautorotate',
    '-seek_timestamp', '1', '-ss', `${us}us`, '-noaccurate_seek',
    ...inputArgs(p.path, p.format),
    '-filter_complex', graph,
    '-map', '[f]', '-fps_mode', 'passthrough', ...one, '-f', 'rawvideo', 'pipe:1',
    '-map', '[wd]', '-map', '[ht]', '-fps_mode', 'passthrough', ...one, '-c:v', 'rawvideo',
    '-stats_mux_pre', 'pipe:3', '-stats_mux_pre_fmt', '{sidx} {size}', '-f', 'null', 'pipe:1',
  ]
  const framePixels = caps().framePixels
  const lists: number[][] = [[], []]
  let closed = false
  let wake: (() => void) | null = null
  const nudge = () => { const f = wake; wake = null; f?.() }
  const at = async (k: number, i: number): Promise<number> => {
    while (lists[k]!.length <= i && !closed) await new Promise<void>((r) => { wake = r })
    const x = lists[k]![i]
    if (x === undefined) throw new MediaError('failed')
    return x
  }
  let text = ''
  let buf: Uint8Array | null = null
  let w = 0
  let h = 0
  let filled = 0
  let count = 0
  let last: RgbFrame | null = null
  try {
    await runMedia({
      tool: 'ffmpeg', args, userId: o.userId, signal: o.signal, route: true,
      onSide: (chunk) => {
        try {
          if (chunk === null) { closed = true; return }
          text += Buffer.from(chunk).toString('latin1')
          let nl: number
          while ((nl = text.indexOf('\n')) >= 0) {
            const line = text.slice(0, nl).trim()
            text = text.slice(nl + 1)
            if (!line) continue
            const m = /^([01]) (\d+)$/.exec(line)
            if (!m) throw new MediaError('failed')
            lists[Number(m[1])]!.push(Number(m[2]))
          }
        }
        finally { nudge() }
      },
      onStdout: async (chunk) => {
        let i = 0
        while (i < chunk.length) {
          if (!buf) {
            if (target !== null && count >= 1) throw new MediaError('failed')
            w = await at(0, count)
            h = await at(1, count)
            if (w < 1 || h < 1) throw new MediaError('failed')
            if (w * h > framePixels) throw new MediaError('tooBig')
            buf = new Uint8Array(w * h * 3)
            filled = 0
          }
          const take = Math.min(buf.length - filled, chunk.length - i)
          buf.set(chunk.subarray(i, i + take), filled)
          filled += take
          i += take
          if (filled === buf.length) {
            last = { rgb: buf, w, h }
            buf = null
            count++
          }
        }
      },
    })
  }
  finally {
    closed = true
    nudge()
  }
  if (buf) throw new MediaError('failed')
  return last
}

/** The frame `_gen_thumbnails` takes for one target pts, or null where Python's loop decodes nothing. */
async function thumbnailFrame(p: MediaProbe, v: VideoStreamProbe, target: number, o: RouteMediaOptions): Promise<RgbFrame | null> {
  const us = seekMicros(Math.max(0, target), v.timeBase)
  return (await framesFromSeek(p, v, us, target, o)) ?? framesFromSeek(p, v, us, null, o)
}

/**
 * Frames above this many pixels are resized on the Frame's worker (its queue
 * and watchdog); below, inline (R5.6: 1280 × 720 takes about 10 ms here, a
 * 4K frame about 83 ms, too long for the server's own thread).
 */
export const THUMB_WORKER_PIXELS = 2_000_000

/** PIL's resize((max(1, round(w · 48 / h)), 48), BILINEAR), then a PNG. Exported for tests. */
export async function thumbnailPng(f: RgbFrame, o: Pick<RouteMediaOptions, 'signal'> = {}): Promise<Buffer> {
  const tw = Math.max(1, pixels.roundHalfEven((f.w * THUMB_HEIGHT_PX) / f.h))
  const same = tw === f.w && THUMB_HEIGHT_PX === f.h
  const px = same ? f.rgb
    : f.w * f.h > THUMB_WORKER_PIXELS ? await pixelsInWorker(o.signal, w => w.resizeRgb(f.rgb, f.w, f.h, tw, THUMB_HEIGHT_PX))
      : pixels.pilResize(f.rgb, f.w, f.h, 3, tw, THUMB_HEIGHT_PX, undefined, 'bilinear')
  return sharp(Buffer.from(px.buffer, px.byteOffset, px.byteLength), { raw: { width: tw, height: THUMB_HEIGHT_PX, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/**
 * `_gen_thumbnails(path, count)` for a video: `count` PNGs, or [] where Python
 * answers [] (no video stream, no length, a file it can't read, any failure
 * on the way: Python's try covers the whole loop, so one failed thumbnail
 * fails them all, and the rest aren't tried).
 */
export async function videoThumbnails(file: string, count: number, o: RouteMediaOptions): Promise<ThumbnailsAnswer> {
  try {
    const p = await probeMedia(file, { userId: o.userId, signal: o.signal, roots: o.roots, route: true, kind: 'video', anyLength: true })
    const v = p.video[0]
    if (!v) return { pngs: [], cache: true }
    // Sailor's own cap, not Python's answer: not kept.
    if (v.w * v.h > caps().framePixels) return { pngs: [], ...failure(new MediaError('tooBig'), 'thumbnails', file) }
    const tb = v.timeBase
    let durSec = v.duration ? seconds(v.duration, tb) : 0
    if (durSec <= 0) durSec = (p.containerDuration ?? 0) / 1_000_000
    if (durSec <= 0) return { pngs: [], cache: true }
    const step = durSec / Math.max(1, count)
    const pngs: Buffer[] = []
    for (let i = 0; i < count; i++) {
      checkStop(o)
      const t = step * (i + 0.5)
      const target = Math.trunc(t / (tb.num / tb.den))
      const frame = await thumbnailFrame(p, v, target, o)
      if (!frame) continue
      pngs.push(await thumbnailPng(frame, o))
    }
    return { pngs, cache: true }
  }
  catch (e) {
    return { pngs: [], ...failure(e, 'thumbnails', file) }
  }
}

// ── waveforms ────────────────────────────────────────────────────────────────

/** Integer sample formats: numpy's row mean is float64 (exact sums) for these. */
const INT_FORMATS = new Set(['s16', 's16p', 's32', 's32p', 'u8', 'u8p', 's64', 's64p'])

/** How a sound's decoded floats make Python's `flat`. */
export interface FlatLayout {
  channels: number
  /** Planar with more than one channel: `flat` is the mean of the channels. */
  mean: boolean
  /** Integer samples: the mean's sum is exact (float64); floats sum in float32. */
  exact: boolean
  /** u8: pcm_f32le's (x − 128) / 128 back to x (0…255). */
  u8: boolean
}

export function flatLayout(sampleFmt: string, channels: number): FlatLayout {
  return {
    channels,
    mean: sampleFmt.endsWith('p') && channels > 1,
    exact: INT_FORMATS.has(sampleFmt),
    u8: sampleFmt === 'u8' || sampleFmt === 'u8p',
  }
}

/**
 * Python's buckets over `flat`, fed as the decoder's interleaved floats arrive
 * (chunks may split a sample anywhere): only each bucket's largest |value|
 * and the peak are kept. `len` is `flat`'s length (from the counting pass).
 * Exported for tests.
 */
export class PeakBuckets {
  private readonly max: Float64Array
  private readonly chunk: number
  private peak = 0
  private j = 0
  private c = 0
  private acc = 0
  private readonly n: number
  constructor(private readonly len: number, buckets: number, private readonly l: FlatLayout) {
    this.n = Math.max(1, buckets)
    this.chunk = Math.max(1, Math.floor(len / this.n))
    this.max = new Float64Array(this.n).fill(-1)
  }

  private take(v: number): void {
    if (this.j >= this.len) throw new MediaError('failed')
    const b = Math.min(Math.floor(this.j / this.chunk), this.n - 1)
    if (v > this.max[b]!) this.max[b] = v
    if (v > this.peak) this.peak = v
    this.j++
  }

  push(floats: Float32Array): void {
    const { channels: C, mean, exact, u8 } = this.l
    for (let k = 0; k < floats.length; k++) {
      const x = u8 ? floats[k]! * 128 + 128 : floats[k]!
      if (!mean) { this.take(Math.abs(x)); continue }
      if (this.c === 0) this.acc = x
      else this.acc = exact ? this.acc + x : Math.fround(this.acc + x)
      if (++this.c === C) {
        this.c = 0
        this.take(Math.abs(Math.fround(this.acc / C)))
      }
    }
  }

  /** float32(max / peak) per bucket (peak `or 1`), 0.0 past the end. Fails when fewer values came than counted. */
  peaks(): number[] {
    if (this.j !== this.len || this.c !== 0) throw new MediaError('failed')
    const div = this.peak || 1
    const out: number[] = []
    for (let b = 0; b < this.n; b++) out.push(b * this.chunk >= this.len ? 0 : Math.fround(this.max[b]! / div))
    return out
  }
}

/**
 * One decode of the first sound stream as float32 (decode.ts's `load` job).
 * `onFloats` null: only counted. Past `maxFloats` it fails (tooLong) as it
 * streams. Returns how many floats came.
 */
async function soundPass(p: MediaProbe, o: RouteMediaOptions, maxFloats: number, onFloats: ((f: Float32Array) => void) | null): Promise<number> {
  let count = 0
  let carry = new Uint8Array(0)
  await runMedia({
    tool: 'ffmpeg',
    args: [...inputArgs(p.path, p.format), '-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
    userId: o.userId, signal: o.signal, route: true,
    onStdout: (chunk) => {
      let bytes = chunk
      if (carry.length) {
        const joined = new Uint8Array(carry.length + chunk.length)
        joined.set(carry)
        joined.set(chunk, carry.length)
        bytes = joined
      }
      const whole = bytes.length - (bytes.length % 4)
      carry = bytes.slice(whole)
      count += whole / 4
      if (count > maxFloats) throw new MediaError('tooLong')
      if (!whole || !onFloats) return
      const floats = new Float32Array(whole / 4)
      new Uint8Array(floats.buffer).set(bytes.subarray(0, whole))
      onFloats(floats)
    },
  })
  if (carry.length) throw new MediaError('failed')
  return count
}

/**
 * `_gen_waveform_peaks(path, buckets)`: [] where Python answers [] (no sound
 * stream, nothing decoded, a file it can't read). Hosted, the sound caps hold
 * (a refusal isn't kept); locally a sound of any length is drawn, as Python
 * does. One layout Python reads isn't: a planar sound of more than 8 channels
 * (Python averages each decoded frame's channels over time there, which needs
 * the frames' own sizes): a named case, answered [] and not kept.
 */
export async function waveformPeaks(file: string, buckets: number, o: RouteMediaOptions): Promise<PeaksAnswer> {
  try {
    const hosted = isHosted()
    const p = await probeMedia(file, { userId: o.userId, signal: o.signal, roots: o.roots, route: true, ...(hosted ? {} : { anyLength: true as const }) })
    const s = p.sound[0]
    if (!s) return { peaks: [], cache: true }
    const l = flatLayout(s.sampleFmt, s.channels)
    if (l.channels < 1) return { peaks: [], cache: true }
    if (l.mean && l.channels > 8) {
      console.warn(`[media] media.route.waveform: a planar sound of ${l.channels} channels is not drawn (${file})`)
      return { peaks: [], cache: false }
    }
    if (hosted) {
      const refused = mediaCapsWord(p, p.video.length ? 'video' : 'sound', true)
      if (refused) throw new MediaError(refused)
    }
    const maxFloats = hosted ? MEDIA_CAPS.hosted.soundSamples : Number.POSITIVE_INFINITY
    const floats = await soundPass(p, o, maxFloats, null)
    if (floats % l.channels !== 0) throw new MediaError('failed')
    const len = l.mean ? floats / l.channels : floats
    // Python: no samples → flat.max() raises → [].
    if (len === 0) return { peaks: [], cache: true }
    checkStop(o)
    const acc = new PeakBuckets(len, buckets, l)
    const again = await soundPass(p, o, floats, f => acc.push(f))
    if (again !== floats) throw new MediaError('failed')
    return { peaks: acc.peaks(), cache: true }
  }
  catch (e) {
    return { peaks: [], ...failure(e, 'waveform', file) }
  }
}
