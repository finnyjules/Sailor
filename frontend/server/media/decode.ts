/**
 * Pictures and sound out of a file, equal to what Python's PyAV hands
 * ComfyUI (step 3, R5.1b). Every byte and sample is checked against fixtures
 * from the real PyAV 17 (scripts/runner_media_fixtures.py --group decode).
 *
 * Pictures (`decodeFrames`) are VideoFromFile.get_components_internal
 * (video_types.py:247-267): every decoded frame of the first video stream
 * whose pts ≥ 0, as `frame.to_ndarray(format='rgb24')`. PyAV 17 converts with
 * sws_scale_frame, SWS_BILINEAR, the frame's own colour matrix, range and
 * chroma siting. ffmpeg's scale filter gives the same bytes with:
 *
 *   select=gte(pts\,0),scale=w=iw:h=ih:eval=frame:flags=bilinear[:in_h_chr_pos=X:in_v_chr_pos=Y],format=rgb24
 *
 * where X, Y are the stream's chroma location as sws reads it
 * (av_chroma_location_enum_to_pos), each given only when the file names a
 * location AND chroma is subsampled on that axis (X for 4:2:0, 4:2:2, 4:1:1;
 * Y for 4:2:0, 4:4:0): the filter's own default ignores the siting, and
 * PyAV's conversion honours it only where chroma is subsampled. It matters
 * where sws really scales chroma (10-bit, 4:2:2, 4:4:4); 8-bit 4:2:0 takes
 * sws's unscaled path either way. Every clip in the fixtures, including
 * tagged 4:4:4 (8-bit, full range, 10-bit) and 10-bit 4:2:2, is byte-equal.
 * With `-copyts` the select filter sees the real pts, as Python's `frame.pts < start_pts` does;
 * `-reinit_filter 0` and `eval=frame` keep a frame of a new size at its own
 * size, and `-stats_mux_pre pipe:3` reports each frame's size and pts, so a
 * size change fails (MEDIA_WORDS.sizeChanged, as Python's torch.stack does)
 * the moment it arrives. `-noautorotate`: PyAV never rotates.
 *
 * Sound (`decodeAudio`) comes out as float32 through `pcm_f32le`. libswresample
 * turns s16 into x · 2⁻¹⁵ and s32 into float32(x) · 2⁻³¹, exactly Python's
 * `f32_pcm` (int16 / 2¹⁵, int32.float() / 2³¹); floats pass as they are. The
 * three decoders are Python's three readers:
 *   - 'load'     nodes_audio.load (:376-400): the first stream. A `dbl` source
 *                is rounded to float32 (Python keeps float64: a deviation).
 *                A u8 or s64 source fails, as `f32_pcm` raises there.
 *   - 'download' nodes_replicate._download_url_to_audio_dict (:425-465): the
 *                first stream's samples in their own scale (int16 and int32
 *                as float32), divided by the peak when the peak is over 1.5.
 *                Python leaves a packed stereo file as one interleaved row;
 *                the runner reads its channels apart (ruling k, a deliberate
 *                difference).
 *   - 'fltp'     get_components' sound (:272-307): by default the last stream,
 *                read after Python's seek to 0 on the video (`pythonSeekArgs`:
 *                in an ffmpeg-muxed MP4 it skips the AAC priming packet), and
 *                the samples before t = 0 skipped frame by frame
 *                (to_skip = max(0, int((0 − pts · time_base) · rate))),
 *                from the decoded frames' own pts and sizes.
 */
import { isHosted } from '../utils/deployMode'
import { MediaError, inputArgs, runMedia } from './run'
import { ffprobeJson, mediaCapsWord, probeMedia, resolveMediaInput, type MediaProbe, type SoundStreamProbe, type VideoStreamProbe } from './probe'

/** sws's position for a chroma location, in 1/256 of a pixel (av_chroma_location_enum_to_pos). */
export const CHROMA_POS: Readonly<Record<string, [number, number]>> = {
  left: [0, 128], center: [128, 128], topleft: [0, 0], top: [128, 0], bottomleft: [0, 256], bottom: [128, 256],
}

/**
 * Whether a pixel format's chroma is subsampled across (w) and down (h):
 * its log2_chroma_w / log2_chroma_h are above 0. Null for a format with no
 * chroma planes to site (RGB, grey) or one this table doesn't know.
 */
export function chromaSubsampling(pixFmt: string): { w: boolean; h: boolean } | null {
  const m = /^(?:yuva?j?|yuvj)(420|422|444|440|411|410)/.exec(pixFmt)
  const kind = m ? m[1]!
    : /^(?:nv12|nv21|p010|p012|p016)/.test(pixFmt) ? '420'
    : /^(?:nv16|nv20|p210|p212|p216)/.test(pixFmt) ? '422'
    : /^(?:nv24|nv42|p410|p412|p416)/.test(pixFmt) ? '444'
    : null
  switch (kind) {
    case '420': case '410': return { w: true, h: true }
    case '422': case '411': return { w: true, h: false }
    case '440': return { w: false, h: true }
    case '444': return { w: false, h: false }
    default: return null
  }
}

/**
 * The picture filter, from the probe's numbers and fixed words only. The
 * chroma siting is passed only on an axis where chroma is subsampled, as
 * PyAV's sws conversion reads it (R5.1b review, Important 1: on 4:4:4 and
 * 4:2:2 a position on a full-resolution axis moves the picture). Exported
 * for tests.
 */
export function framesFilter(v: Pick<VideoStreamProbe, 'chromaLocation' | 'pixFmt'>): string {
  const pos = v.chromaLocation && Object.hasOwn(CHROMA_POS, v.chromaLocation) ? CHROMA_POS[v.chromaLocation]! : null
  const sub = chromaSubsampling(v.pixFmt)
  let chroma = ''
  if (pos && sub?.w) chroma += `:in_h_chr_pos=${pos[0]}`
  if (pos && sub?.h) chroma += `:in_v_chr_pos=${pos[1]}`
  return `select=gte(pts\\,0),scale=w=iw:h=ih:eval=frame:flags=bilinear${chroma},format=rgb24`
}

/** One `-stats_mux_pre` line: the frame's bytes, its input pts and time base. */
interface FrameStat { size: number; pts: number | null }

function parseStat(line: string): FrameStat | null {
  const m = /^(\d+) (-?\d+|N\/A) (\d+)\/(\d+)$/.exec(line.trim())
  if (!m) return null
  const pts = m[2] === 'N/A' ? null : (Number(m[2]) * Number(m[3])) / Number(m[4])
  return { size: Number(m[1]), pts }
}

/** The probe of a checked input: the caller's own (for this very file), or a fresh one. */
async function probeFor(path: string, o: { userId: string | null; signal?: AbortSignal; roots: readonly string[]; probe?: MediaProbe; kept?: true }, kind: 'video' | 'sound'): Promise<MediaProbe> {
  if (!o.probe) return probeMedia(path, { userId: o.userId, signal: o.signal, roots: o.roots, kind, ...(o.kept ? { kept: true as const } : {}) })
  if ((await resolveMediaInput(path, o.roots)) !== o.probe.path) throw new MediaError('unreadable')
  return o.probe
}

/**
 * Every frame of the first video stream with pts ≥ 0, as rgb24, handed to
 * `onFrame` one at a time (memory never holds more than one frame). Past
 * `maxFrames` it fails with MEDIA_WORDS.tooManyFrames as it streams; a frame
 * of another size fails with MEDIA_WORDS.sizeChanged. `pts` is in seconds.
 */
export async function decodeFrames(path: string, o: {
  userId: string | null; signal?: AbortSignal
  maxFrames: number
  onFrame(rgb: Uint8Array, index: number, pts: number): Promise<void>
  /** The folders the file must really be in (the person's own; `resolveMediaInput`). */
  roots: readonly string[]
  /** A probe already made of this file (saves a second one). */
  probe?: MediaProbe
  /** The runner's own kept batch (R5.2 fix round 1): no upload caps; the caller has judged the batch caps, and `maxFrames` holds. */
  kept?: true
}): Promise<{ count: number; w: number; h: number }> {
  const p = await probeFor(path, o, 'video')
  const refused = o.kept ? null : mediaCapsWord(p, 'video', isHosted())
  if (refused) throw new MediaError(refused)
  const v = p.video[0]!
  const { w, h } = v
  const frameBytes = w * h * 3
  if (frameBytes <= 0) throw new MediaError('unreadable')

  // Frame sizes and pts, as ffmpeg reports them (never paused, so it can't stall the pictures).
  const stats: FrameStat[] = []
  let statsText = ''
  let statsClosed = false
  let wake: (() => void) | null = null
  const nudge = () => { const f = wake; wake = null; f?.() }
  const statAt = async (i: number): Promise<FrameStat> => {
    while (stats.length <= i && !statsClosed) await new Promise<void>((r) => { wake = r })
    const s = stats[i]
    if (!s) throw new MediaError('failed')
    return s
  }

  let buf = new Uint8Array(frameBytes)
  let filled = 0
  let count = 0

  const takeFrame = async () => {
    if (o.signal?.aborted) throw new MediaError('stopped')
    const s = await statAt(count)
    if (s.size !== frameBytes) throw new MediaError('sizeChanged')
    if (count >= o.maxFrames) throw new MediaError('tooManyFrames')
    const frame = buf
    buf = new Uint8Array(frameBytes)
    filled = 0
    await o.onFrame(frame, count, s.pts ?? Number.NaN)
    count++
  }

  const args = [
    '-copyts', '-reinit_filter', '0', '-noautorotate',
    ...inputArgs(p.path, p.format),
    '-map', '0:v:0', '-fps_mode', 'passthrough',
    '-vf', framesFilter(v),
    '-stats_mux_pre', 'pipe:3', '-stats_mux_pre_fmt', '{size} {ptsi} {tbi}',
    '-f', 'rawvideo', 'pipe:1',
  ]
  try {
    await runMedia({
      tool: 'ffmpeg', args, userId: o.userId, signal: o.signal,
      onSide: (chunk) => {
        try {
          if (chunk === null) { statsClosed = true; return }
          statsText += Buffer.from(chunk).toString('latin1')
          let nl: number
          while ((nl = statsText.indexOf('\n')) >= 0) {
            const line = statsText.slice(0, nl)
            statsText = statsText.slice(nl + 1)
            if (!line.trim()) continue
            const s = parseStat(line)
            if (!s) throw new MediaError('failed')
            // A frame of another size: fail as soon as ffmpeg says so, before its bytes arrive.
            if (s.size !== frameBytes) throw new MediaError('sizeChanged')
            stats.push(s)
          }
        }
        finally { nudge() }
      },
      onStdout: async (chunk) => {
        let at = 0
        while (at < chunk.length) {
          const n = Math.min(frameBytes - filled, chunk.length - at)
          buf.set(chunk.subarray(at, at + n), filled)
          filled += n
          at += n
          if (filled === frameBytes) await takeFrame()
        }
      },
    })
  }
  finally {
    statsClosed = true
    nudge()
  }
  if (filled !== 0) throw new MediaError('sizeChanged')
  return { count, w, h }
}

export type SoundDecoder = 'load' | 'download' | 'fltp'
/** [C][N] float32 samples. */
export interface DecodedSound { rate: number; channels: Float32Array[] }

/** Integer sample formats and the scale that turns libswresample's float back into Python's integers. */
const INT_SCALE: Readonly<Record<string, number>> = { s16: 32768, s16p: 32768, s32: 2 ** 31, s32p: 2 ** 31 }
const FLOAT_FORMATS = new Set(['flt', 'fltp', 'dbl', 'dblp'])

/**
 * get_components' seek (video_types.py:274): before it reads the sound, Python
 * seeks the file to 0 on its first video stream (`container.seek(0, stream=
 * video)`, backward), which in an MP4 also moves every sound stream to the
 * sample at or before the video's own first one. Where the video starts at
 * decode time 0 and the AAC priming packet (pts < 0) comes first (ffmpeg's
 * muxer, OpenH264, no B-frames), that packet is skipped, and the decoder
 * starts from the next one. ffmpeg's `-ss 0 -seek_timestamp 1
 * -noaccurate_seek` makes the same avformat seek (the default stream is the
 * video; no container start added; backward) and trims nothing, so the
 * mirror decodes from the very packet Python does (R5.1c review, Important 3).
 * Only the MP4 family with a video stream is sought: without video,
 * get_components doesn't get this far, and in Matroska the CLI's seek lands
 * 16 samples away from PyAV's while no seek at all equals it (measured on
 * v_two_sounds.mkv), since Matroska's seek to 0 goes back to the file's start.
 */
function pythonSeekArgs(p: MediaProbe, decoder: SoundDecoder): string[] {
  const mov = p.format === 'mp4' || p.format === 'mov' || p.format === 'm4a'
  return decoder === 'fltp' && mov && p.video.length ? ['-seek_timestamp', '1', '-ss', '0', '-noaccurate_seek'] : []
}

/**
 * The leading decoded frames' pts and sizes, read the way the decode itself
 * reads the file (the same seek): `-stats_mux_pre` of the first `frames`
 * frames, their sizes as pcm_f32le, for get_components' skip rule.
 */
async function leadingFrames(p: MediaProbe, k: number, s: SoundStreamProbe, frames: number, o: { userId: string | null; signal?: AbortSignal }): Promise<{ pts: number | null; samples: number }[]> {
  let text = ''
  await runMedia({
    tool: 'ffmpeg',
    args: [
      '-copyts', ...pythonSeekArgs(p, 'fltp'), ...inputArgs(p.path, p.format),
      '-map', `0:a:${k}`, '-frames:a', String(frames), '-c:a', 'pcm_f32le',
      '-stats_mux_pre', 'pipe:3', '-stats_mux_pre_fmt', '{size} {ptsi} {tbi}', '-f', 'null', 'pipe:1',
    ],
    userId: o.userId, signal: o.signal,
    onSide: (chunk) => { if (chunk) text += Buffer.from(chunk).toString('latin1') },
  })
  const out: { pts: number | null; samples: number }[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const m = /^(\d+) (-?\d+|N\/A) (\d+)\/(\d+)$/.exec(line.trim())
    if (!m) throw new MediaError('failed')
    // In the stream's own time base, as PyAV's frame.pts (the input time base is the stream's).
    const tb = { num: Number(m[3]), den: Number(m[4]) }
    if (tb.num !== s.timeBase.num || tb.den !== s.timeBase.den) throw new MediaError('failed')
    out.push({ pts: m[2] === 'N/A' ? null : Number(m[2]), samples: Number(m[1]) / (4 * s.channels) })
  }
  return out
}

/** How many samples get_components drops before t = 0, frame by frame; null when no frame reaches 0 (Python's sound is then None). */
async function samplesBeforeZero(p: MediaProbe, k: number, s: SoundStreamProbe, o: { userId: string | null; signal?: AbortSignal }): Promise<number | null> {
  const num = BigInt(s.timeBase.num); const den = BigInt(s.timeBase.den); const rate = BigInt(s.rate)
  for (let packets = 64; ; packets *= 4) {
    const frames = await leadingFrames(p, k, s, packets, o)
    let skipped = 0
    for (const f of frames) {
      if (f.pts === null) throw new MediaError('unreadable')   // Python: None * time_base raises
      // int((0 − pts · tb) · rate), truncated toward zero; negative offsets give 0.
      const toSkip = f.pts < 0 ? Number((BigInt(-f.pts) * num * rate) / den) : 0
      if (toSkip < f.samples) return skipped + toSkip
      skipped += f.samples
    }
    if (frames.length < packets || packets >= 4096) return frames.length < packets ? null : skipped
  }
}

/**
 * One sound stream as float32 channels, the way the named Python reader
 * makes it. Fails with MEDIA_WORDS.tooLong past `maxSamples` (channels ×
 * samples) as it streams.
 */
export async function decodeAudio(path: string, o: {
  decoder: SoundDecoder; stream?: 'first' | 'last'
  userId: string | null; signal?: AbortSignal; maxSamples: number
  /** The folders the file must really be in (the person's own; `resolveMediaInput`). */
  roots: readonly string[]
  probe?: MediaProbe
  /** The runner's own kept sound (R5.2 fix round 1): no upload caps; `maxSamples` (soundSamples) holds as it streams. */
  kept?: true
}): Promise<DecodedSound> {
  const p = await probeFor(path, o, 'sound')
  const refused = o.kept ? null : mediaCapsWord(p, 'sound', isHosted())
  if (refused) throw new MediaError(refused)
  const k = (o.stream ?? (o.decoder === 'fltp' ? 'last' : 'first')) === 'last' ? p.sound.length - 1 : 0
  const s = p.sound[k]!
  const C = s.channels
  if (C < 1) throw new MediaError('unreadable')
  const intScale = Object.hasOwn(INT_SCALE, s.sampleFmt) ? INT_SCALE[s.sampleFmt]! : null
  const known = intScale !== null || FLOAT_FORMATS.has(s.sampleFmt) || s.sampleFmt === 'u8' || s.sampleFmt === 'u8p'
  if (!known) throw new MediaError('unreadable')
  if (o.decoder === 'load' && (s.sampleFmt === 'u8' || s.sampleFmt === 'u8p')) throw new MediaError('unreadable')

  const skip = o.decoder === 'fltp' ? await samplesBeforeZero(p, k, s, o) : 0
  const rate = o.decoder === 'download' ? (s.rate || 44100) : o.decoder === 'fltp' ? (s.rate || 1) : s.rate
  if (skip === null) return { rate, channels: Array.from({ length: C }, () => new Float32Array(0)) }

  // Straight into the channels, de-interleaved as the samples stream: one buffer per channel, sized
  // from the header and grown only if the file holds more (peak memory ≈ the sound itself, R5.1b review
  // Minor 2). The cap is checked as it streams.
  const perChannelCap = Math.floor(o.maxSamples / C)
  const stated = s.duration !== null ? (s.duration * s.timeBase.num) / s.timeBase.den
    : p.containerDuration !== null ? p.containerDuration / 1e6 : (s.measuredSeconds ?? 0)
  let capacity = Math.min(perChannelCap, Math.ceil(stated * s.rate) + 8192)
  let channels = Array.from({ length: C }, () => new Float32Array(capacity))
  const grow = () => {
    if (capacity >= perChannelCap) throw new MediaError('tooLong')
    const next = Math.min(perChannelCap, Math.max(capacity + 65536, Math.ceil(capacity * 1.25)))
    channels = channels.map((ch) => { const g = new Float32Array(next); g.set(ch); return g })
    capacity = next
  }
  let c = 0
  let n = -skip
  let carry = new Uint8Array(0)
  await runMedia({
    tool: 'ffmpeg',
    args: [...pythonSeekArgs(p, o.decoder), ...inputArgs(p.path, p.format), '-map', `0:a:${k}`, '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
    userId: o.userId, signal: o.signal,
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
      if (!whole) return
      // An aligned copy of this chunk only (a pipe chunk is 64 KiB at most).
      const floats = new Float32Array(whole / 4)
      new Uint8Array(floats.buffer).set(bytes.subarray(0, whole))
      for (let j = 0; j < floats.length; j++) {
        if (n >= 0) {
          if (n >= capacity) grow()
          channels[c]![n] = floats[j]!
        }
        if (++c === C) { c = 0; n++ }
      }
    },
  })
  if (carry.length || c !== 0) throw new MediaError('failed')

  const N = Math.max(0, n)
  const out = channels.map(ch => ch.subarray(0, N))
  if (o.decoder === 'download') {
    // Back to the samples' own scale (int16 and int32 as float32; u8 as 0…255), then Python's peak rule.
    if (intScale !== null) for (const ch of out) for (let i = 0; i < N; i++) ch[i] = ch[i]! * intScale
    else if (s.sampleFmt === 'u8' || s.sampleFmt === 'u8p') for (const ch of out) for (let i = 0; i < N; i++) ch[i] = ch[i]! * 128 + 128
    let peak = 0
    for (const ch of out) for (let i = 0; i < N; i++) { const a = Math.abs(ch[i]!); if (a > peak) peak = a }
    if (peak > 1.5) for (const ch of out) for (let i = 0; i < N; i++) ch[i] = ch[i]! / peak
  }
  return { rate, channels: out }
}
