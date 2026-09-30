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
 *                       (pixels/core.ts pilResize, inline: see the report), then
 *                       a PNG from sharp (its bytes differ from PIL's
 *                       optimize=True; its pixels don't).
 *   waveformPeaks       `_gen_waveform_peaks` (:2319-2352) over decode.ts's
 *                       `load` samples (a u8 file: `download`'s, which keeps
 *                       0…255): a packed file is one row of interleaved samples
 *                       (not mixed), a planar one the float32 mean of its
 *                       channels; abs, divided by the peak in float32, then the
 *                       max of each bucket. The samples' scale (Python's
 *                       integers, the decoder's floats) is a power of two, so
 *                       the division by the peak makes it vanish exactly.
 *
 * Every job uses the routes' own slots and their 30 s limit (rule 5). A
 * failure answers Python's own failure ([] or nulls). A failure that says
 * nothing about the file (the time limit, Stop, the tools gone) is marked
 * `cache: false`, so the route doesn't keep it; it is logged.
 */
import sharp from 'sharp'
import { MEDIA_CAPS } from '#shared/runner/media'
import { isHosted } from '../utils/deployMode'
import { pixels } from '../runner/pixels/core'
import { framesScale, decodeAudio } from './decode'
import { MediaError, inputArgs, runMedia } from './run'
import { probeMedia, type MediaProbe, type Rational, type VideoStreamProbe } from './probe'

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

export interface TimelineProbe { duration_sec: number | null; width: number | null; height: number | null }
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

/** Whether a failure is the file's own answer (kept, as Python keeps its []), or the moment's. */
function failure(e: unknown, what: string, file: string): { cache: boolean } {
  const word = e instanceof MediaError ? e.word : null
  const momentary = word === 'timedOut' || word === 'stopped' || word === 'toolsMissing' || word === null
  if (momentary) console.warn(`[media] media.route.${what}: ${word ?? (e as Error)?.message ?? String(e)} (${file})`)
  return { cache: !momentary }
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
  const out: TimelineProbe = { duration_sec: null, width: null, height: null }
  let p: MediaProbe
  try {
    p = await probeMedia(file, { userId: o.userId, signal: o.signal, roots: o.roots, route: true, kind: kind === 'video' ? 'video' : 'sound', anyLength: true })
  }
  catch (e) {
    failure(e, 'probe', file)
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

interface RgbFrame { rgb: Uint8Array; w: number; h: number }

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

/** PIL's resize((max(1, round(w · 48 / h)), 48), BILINEAR), then a PNG. */
async function thumbnailPng(f: RgbFrame): Promise<Buffer> {
  const tw = Math.max(1, pixels.roundHalfEven((f.w * THUMB_HEIGHT_PX) / f.h))
  const px = tw === f.w && THUMB_HEIGHT_PX === f.h ? f.rgb : pixels.pilResize(f.rgb, f.w, f.h, 3, tw, THUMB_HEIGHT_PX, undefined, 'bilinear')
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
    if (!v || v.w * v.h > caps().framePixels) return { pngs: [], cache: true }
    const tb = v.timeBase
    let durSec = v.duration ? seconds(v.duration, tb) : 0
    if (durSec <= 0) durSec = (p.containerDuration ?? 0) / 1_000_000
    if (durSec <= 0) return { pngs: [], cache: true }
    const step = durSec / Math.max(1, count)
    const pngs: Buffer[] = []
    for (let i = 0; i < count; i++) {
      const t = step * (i + 0.5)
      const target = Math.trunc(t / (tb.num / tb.den))
      const frame = await thumbnailFrame(p, v, target, o)
      if (!frame) continue
      pngs.push(await thumbnailPng(frame))
    }
    return { pngs, cache: true }
  }
  catch (e) {
    return { pngs: [], ...failure(e, 'thumbnails', file) }
  }
}

// ── waveforms ────────────────────────────────────────────────────────────────

const INT_FORMATS = new Set(['s16', 's16p', 's32', 's32p', 'u8', 'u8p', 's64', 's64p'])

/**
 * The buckets over Python's `flat` (read through `at`, `len` values): each the
 * float32 max of its stretch divided by the peak (float32(x / peak) grows with
 * x, so the max of the divided values is the divided max). Exported for tests.
 */
export function bucketPeaks(len: number, at: (j: number) => number, buckets: number): number[] {
  let peak = 0
  for (let j = 0; j < len; j++) { const x = at(j); if (x > peak) peak = x }
  const div = peak || 1
  const n = Math.max(1, buckets)
  const chunk = Math.max(1, Math.floor(len / n))
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const start = i * chunk
    const end = i < n - 1 ? (i + 1) * chunk : len
    if (start >= len) { out.push(0); continue }
    let m = at(start)
    for (let j = start + 1; j < end; j++) { const x = at(j); if (x > m) m = x }
    out.push(Math.fround(m / div))
  }
  return out
}

/**
 * `_gen_waveform_peaks(path, buckets)`: [] where Python answers [] (no sound
 * stream, nothing decoded, a file it can't read). Two layouts Python reads
 * that the runner doesn't are answered [] too (named in the R5.6 report): a
 * planar sound of more than 8 channels (Python averages each frame's
 * channels over time there) and a planar u8 sound.
 */
export async function waveformPeaks(file: string, buckets: number, o: RouteMediaOptions): Promise<PeaksAnswer> {
  try {
    const p = await probeMedia(file, { userId: o.userId, signal: o.signal, roots: o.roots, route: true })
    const s = p.sound[0]
    if (!s) return { peaks: [], cache: true }
    const C = s.channels
    const planar = s.sampleFmt.endsWith('p') && C > 1
    const u8 = s.sampleFmt === 'u8' || s.sampleFmt === 'u8p'
    if (planar && (C > 8 || u8)) {
      console.warn(`[media] media.route.waveform: a planar ${s.sampleFmt} sound of ${C} channels is not read (${file})`)
      return { peaks: [], cache: true }
    }
    const d = await decodeAudio(file, {
      decoder: u8 ? 'download' : 'load', stream: 'first',
      userId: o.userId, signal: o.signal, roots: o.roots, probe: p, route: true,
      maxSamples: caps().soundSamples,
      ...(p.video.length ? { within: 'video' as const } : {}),
    })
    const ch = d.channels
    const N = ch[0]?.length ?? 0
    if (N === 0) return { peaks: [], cache: true }
    if (!planar) {
      // One row: the interleaved samples as the file holds them (a mono planar file is one row too).
      return { peaks: bucketPeaks(N * C, j => Math.abs(ch[j % C]![(j / C) | 0]!), buckets), cache: true }
    }
    // numpy's mean over the rows: integers summed exactly (float64), floats in float32, row by row; then / C.
    const exact = INT_FORMATS.has(s.sampleFmt)
    const mono = ch[0]!
    for (let i = 0; i < N; i++) {
      let acc = mono[i]!
      for (let c = 1; c < C; c++) acc = exact ? acc + ch[c]![i]! : Math.fround(acc + ch[c]![i]!)
      mono[i] = Math.abs(Math.fround(acc / C))
    }
    return { peaks: bucketPeaks(N, j => mono[j]!, buckets), cache: true }
  }
  catch (e) {
    return { peaks: [], ...failure(e, 'waveform', file) }
  }
}
