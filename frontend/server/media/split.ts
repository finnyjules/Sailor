/**
 * Long sounds in pieces (step 3, R11.5, ruling (h)): the one shared splitter.
 *
 * A node that sends its WHOLE sound to a service (Whisper transcribe, Vocal
 * separator) and is handed one longer than a single call takes sends it in
 * pieces instead. `splitSound`:
 *
 *   1. converts the sound, once, with the media module's own ffmpeg job
 *      (run.ts: the checked build, its limits, Stop), into one 16-bit PCM WAV
 *      at the rate the service is sent (Whisper 16 kHz mono; Vocal separator
 *      Demucs' 44.1 kHz, the sound's own one or two channels) in a folder of
 *      its own. Never past the hard ceiling: the decode stops a sample after
 *      it (`atrim`), so a file whose header lies can't fill the disk;
 *   2. reads that WAV once as it streams: its sha256 (what was measured) and
 *      the loudness of every 50 ms block (the mean square of its samples);
 *   3. cuts it at the quietest block of the last 30 seconds before each limit,
 *      never past the limit (#shared/runner/soundPieces quietestCuts). The
 *      same numbers bound the hold (soundPieceCount), so a sound never makes
 *      more pieces than were held for.
 *
 * Why not ffmpeg's `silencedetect` (the brief's suggestion): it reports what
 * it finds only in its log, and every media job runs at `-loglevel error`
 * with its stderr never read (run.ts), so its findings can't be read back
 * without loosening the job rules. The blocks' loudness, read from the very
 * samples that are sent, finds the quietest point near each limit directly
 * (where silencedetect needs a threshold, and finds nothing in a song with no
 * silence).
 *
 * The pieces are cut from the WAV sample-exact (`pieceSamples`): joined end to
 * end they are the whole sound, with no gap and no overlap.
 *
 * Under the user's matching rule a long sound only has to sound the same:
 * the conversion is ffmpeg's (its channel mix and resampler), not Python's
 * torchaudio port; a sound that fits one call is still sent exactly as before.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { quietestCuts, SOUND_PIECE_WINDOW_SECONDS } from '#shared/runner/soundPieces'
import type { DecodedSound } from './decode'
import type { MediaProbe } from './probe'
import { MediaError, inputArgs, mediaTempDir, removeMediaTempDir, runMedia } from './run'

/** The blocks the loudness is read in (seconds). */
export const SPLIT_BLOCK_SECONDS = 0.05

/** A long sound, converted once and cut: what the pieces are read from. */
export interface SoundPieces {
  /** The converted sound: a 16-bit PCM WAV in `dir`. */
  path: string
  /** Its folder (removed with `removeSoundPieces`). */
  dir: string
  /** Where its samples start in the file. */
  dataOffset: number
  rate: number
  channels: number
  /** Samples per channel. */
  frames: number
  seconds: number
  /** The converted WAV's sha256 (what the node's turn measured). */
  sha: string
  /** Where each piece starts (samples), the first at 0; a piece ends where the next starts. */
  starts: number[]
}

/** A WAV's 'fmt ' and 'data' chunks, from its first bytes. */
export function wavLayout(head: Uint8Array): { format: number; channels: number; rate: number; bits: number; dataOffset: number; dataBytes: number } {
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const ascii = (at: number) => String.fromCharCode(head[at]!, head[at + 1]!, head[at + 2]!, head[at + 3]!)
  if (head.length < 12 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') throw new MediaError('failed')
  let at = 12
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null
  while (at + 8 <= head.length) {
    const id = ascii(at)
    const size = v.getUint32(at + 4, true)
    if (id === 'fmt ' && at + 24 <= head.length) {
      let format = v.getUint16(at + 8, true)
      // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes are the format.
      if (format === 0xFFFE && at + 34 <= head.length) format = v.getUint16(at + 32, true)
      fmt = { format, channels: v.getUint16(at + 10, true), rate: v.getUint32(at + 12, true), bits: v.getUint16(at + 22, true) }
    }
    if (id === 'data') {
      if (!fmt) throw new MediaError('failed')
      return { ...fmt, dataOffset: at + 8, dataBytes: size }
    }
    at += 8 + size + (size % 2)
  }
  throw new MediaError('failed')
}

/**
 * Converts and cuts a long sound (see the header). `stream`: which of the
 * probe's sound streams (Python's reader: the first, or a video's last).
 * `channels`: 1 mixes every channel down (Whisper); 2 keeps one or two as
 * they are and mixes more down to two (Vocal separator). `limit` is the
 * longest piece, `ceiling` the longest sound taken at all (seconds). Throws
 * MEDIA_WORDS.tooLong past the ceiling, MEDIA_WORDS.stopped on Stop; leaves
 * nothing behind on any failure.
 */
export async function splitSound(probe: MediaProbe, o: {
  stream: number; rate: number; channels: 1 | 2
  limit: number; ceiling: number
  userId: string | null; signal?: AbortSignal
}): Promise<SoundPieces> {
  const s = probe.sound[o.stream]
  if (!s || !(s.rate > 0) || !(s.channels > 0)) throw new MediaError('noSound')
  const dir = await mediaTempDir()
  try {
    const out = join(dir, 'sound.wav')
    // The decode stops a sample past the ceiling (at the file's own rate, before the resample).
    const endSample = Math.ceil(o.ceiling * s.rate) + 1
    const layout = o.channels === 1 ? 'mono' : s.channels > 2 ? 'stereo' : null
    await runMedia({
      tool: 'ffmpeg',
      args: [
        ...inputArgs(probe.path, probe.format), '-map', `0:a:${o.stream}`,
        '-af', `atrim=end_sample=${endSample}`,
        '-c:a', 'pcm_s16le', '-ar', String(o.rate), ...(layout ? ['-ch_layout', layout] : []),
        '-fflags', '+bitexact', '-f', 'wav', '-y', `file:${out}`,
      ],
      userId: o.userId, signal: o.signal, workDir: dir, cleanup: [out],
    })
    if (o.signal?.aborted) throw new MediaError('stopped')
    const read = await readLoudness(out, o.rate, o.signal)
    if (read.rate !== o.rate || read.channels < 1 || read.channels > 2) throw new MediaError('failed')
    const seconds = read.frames / o.rate
    if (seconds > o.ceiling) throw new MediaError('tooLong')
    if (read.frames < 1) throw new MediaError('noSound')
    const block = Math.round(SPLIT_BLOCK_SECONDS * o.rate)
    const cuts = quietestCuts(read.quiet, {
      total: read.frames, block,
      limit: Math.floor(o.limit * o.rate), window: Math.floor(SOUND_PIECE_WINDOW_SECONDS * o.rate),
    })
    return {
      path: out, dir, dataOffset: read.dataOffset, rate: o.rate, channels: read.channels, frames: read.frames, seconds,
      sha: read.sha, starts: [0, ...cuts],
    }
  }
  catch (e) {
    await removeMediaTempDir(dir)
    if (o.signal?.aborted) throw new MediaError('stopped')
    throw e
  }
}

/** The converted WAV read once as it streams: its sha256, its layout and each block's loudness. */
async function readLoudness(path: string, rate: number, signal?: AbortSignal): Promise<{ sha: string; dataOffset: number; frames: number; channels: number; rate: number; quiet: Float64Array }> {
  const size = (await stat(path)).size
  const fh = await open(path, 'r')
  let head: Uint8Array
  try {
    const b = new Uint8Array(Math.min(size, 4096))
    await fh.read(b, 0, b.length, 0)
    head = b
  }
  finally { await fh.close() }
  const lay = wavLayout(head)
  if (lay.format !== 1 || lay.bits !== 16) throw new MediaError('failed')
  // ffmpeg writes the real sizes back once it ends; the file's own length is the backstop.
  const dataBytes = Math.min(lay.dataBytes, size - lay.dataOffset)
  const C = lay.channels
  const frames = Math.floor(dataBytes / (2 * C))
  const block = Math.round(SPLIT_BLOCK_SECONDS * rate)
  const quiet = new Float64Array(Math.ceil(frames / block))
  const hash = createHash('sha256')
  let pos = 0
  let carry: Buffer | null = null
  let sample = 0
  for await (const chunk of createReadStream(path)) {
    if (signal?.aborted) throw new MediaError('stopped')
    const buf = chunk as Buffer
    hash.update(buf)
    const start = pos
    pos += buf.length
    // Only the data chunk's samples count, two bytes each, whole frames.
    const from = Math.max(0, lay.dataOffset - start)
    const to = Math.min(buf.length, lay.dataOffset + frames * 2 * C - start)
    if (to <= from) continue
    let bytes = buf.subarray(from, to)
    if (carry) { bytes = Buffer.concat([carry, bytes]); carry = null }
    const whole = bytes.length - (bytes.length % 2)
    if (whole < bytes.length) carry = Buffer.from(bytes.subarray(whole))
    for (let i = 0; i < whole; i += 2) {
      const x = bytes.readInt16LE(i) / 32768
      const k = Math.floor(Math.floor(sample / C) / block)
      quiet[k] = quiet[k]! + x * x
      sample++
    }
  }
  return { sha: hash.digest('hex'), dataOffset: lay.dataOffset, frames, channels: C, rate: lay.rate, quiet }
}

/** Piece i's samples as they were converted (16-bit, interleaved). */
export async function pieceSamples(p: SoundPieces, i: number): Promise<Int16Array> {
  const start = p.starts[i]
  if (start === undefined) throw new MediaError('failed')
  const end = p.starts[i + 1] ?? p.frames
  const bytes = (end - start) * p.channels * 2
  const out = new Int16Array(bytes / 2)
  const fh = await open(p.path, 'r')
  try {
    const { bytesRead } = await fh.read(new Uint8Array(out.buffer), 0, bytes, p.dataOffset + start * p.channels * 2)
    if (bytesRead !== bytes) throw new MediaError('failed')
  }
  finally { await fh.close() }
  return out
}

/** Piece i's seconds and where it starts in the whole sound (seconds). */
export function pieceSpan(p: SoundPieces, i: number): { start: number; seconds: number } {
  const start = p.starts[i]!
  const end = p.starts[i + 1] ?? p.frames
  return { start: start / p.rate, seconds: (end - start) / p.rate }
}

/** Piece i as a 16-bit PCM WAV (what Whisper's piece is sent as). */
export async function pieceWav(p: SoundPieces, i: number): Promise<Uint8Array> {
  const pcm = await pieceSamples(p, i)
  const data = pcm.byteLength
  const out = new Uint8Array(44 + data)
  const v = new DataView(out.buffer)
  const ascii = (at: number, t: string) => { for (let k = 0; k < t.length; k++) out[at + k] = t.charCodeAt(k) }
  ascii(0, 'RIFF'); v.setUint32(4, 36 + data, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, p.channels, true); v.setUint32(24, p.rate, true)
  v.setUint32(28, p.rate * p.channels * 2, true); v.setUint16(32, p.channels * 2, true); v.setUint16(34, 16, true)
  ascii(36, 'data'); v.setUint32(40, data, true)
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, data), 44)
  return out
}

/** Piece i as float channels (each 16-bit sample / 32768), for an encoder. */
export async function pieceSound(p: SoundPieces, i: number): Promise<DecodedSound> {
  const pcm = await pieceSamples(p, i)
  const C = p.channels
  const n = pcm.length / C
  const channels = Array.from({ length: C }, () => new Float32Array(n))
  for (let j = 0; j < n; j++) for (let c = 0; c < C; c++) channels[c]![j] = pcm[j * C + c]! / 32768
  return { rate: p.rate, channels }
}

/** Whether every sample of piece i is 0 (nothing to send). */
export async function pieceSilent(p: SoundPieces, i: number): Promise<boolean> {
  return (await pieceSamples(p, i)).every(x => x === 0)
}

/** Removes the converted sound (every path: done, failed, stopped). */
export async function removeSoundPieces(p: Pick<SoundPieces, 'dir'>): Promise<void> {
  await removeMediaTempDir(p.dir).catch(() => {})
}

// ── Joining the pieces' answers ─────────────────────────────────────────────

/**
 * Float WAVs joined end to end (each piece's stem, R11.5: Vocal separator's
 * stems), as one float WAV at `out`: every part must be a 32-bit float WAV of
 * the same rate and channels (Demucs' stems are). The parts are appended one
 * at a time as they come (`append`), and the header written once at the end
 * (`finish`), so the join never holds more than one part in memory.
 */
export async function floatWavJoiner(out: string): Promise<{ append(part: Uint8Array): Promise<void>; finish(): Promise<void>; abort(): Promise<void> }> {
  const fh = await open(out, 'wx')
  const HEAD = 58
  let fmt: { channels: number; rate: number } | null = null
  let data = 0
  let closed = false
  await fh.write(new Uint8Array(HEAD), 0, HEAD, 0)
  const close = async () => {
    if (closed) return
    closed = true
    await fh.close()
  }
  return {
    async append(part) {
      const lay = wavLayout(part.subarray(0, Math.min(part.length, 4096)))
      if (lay.format !== 3 || lay.bits !== 32) throw new MediaError('failed')
      if (fmt && (fmt.channels !== lay.channels || fmt.rate !== lay.rate)) throw new MediaError('failed')
      fmt ??= { channels: lay.channels, rate: lay.rate }
      const bytes = Math.min(lay.dataBytes, part.length - lay.dataOffset)
      const whole = bytes - (bytes % (4 * lay.channels))
      if (HEAD + data + whole > 0xFFFFFFFF) throw new MediaError('tooBig')
      await fh.write(part, lay.dataOffset, whole, HEAD + data)
      data += whole
    },
    async finish() {
      if (!fmt) throw new MediaError('failed')
      const head = new Uint8Array(HEAD)
      const v = new DataView(head.buffer)
      const ascii = (at: number, t: string) => { for (let k = 0; k < t.length; k++) head[at + k] = t.charCodeAt(k) }
      const C = fmt.channels
      ascii(0, 'RIFF'); v.setUint32(4, HEAD - 8 + data, true); ascii(8, 'WAVE')
      ascii(12, 'fmt '); v.setUint32(16, 18, true)
      v.setUint16(20, 3, true); v.setUint16(22, C, true); v.setUint32(24, fmt.rate, true)
      v.setUint32(28, fmt.rate * C * 4, true); v.setUint16(32, C * 4, true); v.setUint16(34, 32, true); v.setUint16(36, 0, true)
      ascii(38, 'fact'); v.setUint32(42, 4, true); v.setUint32(46, data / (4 * C), true)
      ascii(50, 'data'); v.setUint32(54, data, true)
      await fh.write(head, 0, HEAD, 0)
      await close()
    },
    async abort() {
      await close().catch(() => {})
      await rm(out, { force: true }).catch(() => {})
    },
  }
}

/** A joined float WAV's samples per channel (for tests and checks). */
export async function floatWavFrames(path: string): Promise<number> {
  const fh = await open(path, 'r')
  try {
    const head = new Uint8Array(4096)
    const { bytesRead } = await fh.read(head, 0, head.length, 0)
    const lay = wavLayout(head.subarray(0, bytesRead))
    return lay.dataBytes / (4 * lay.channels)
  }
  finally { await fh.close() }
}
