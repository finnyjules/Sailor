/**
 * Shared helpers for the media module's parity specs (step 3, R5): the
 * fixtures written by scripts/runner_media_fixtures.py
 * (runner-media-<group>.json), the standard clips it makes
 * (fixtures/media/), and the real tools.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mediaTools, type MediaTools } from '~~/server/media/tools'

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** The folder the standard clips must really be in (the media module's `roots`). */
export const CLIP_ROOTS: readonly string[] = [resolve(FIXTURES, 'media')]

/** A standard clip's absolute path. */
export function clipPath(name: string): string {
  return resolve(FIXTURES, 'media', name)
}

export interface PyRational { num: number; den: number }
/** A Python call's answer, or the error it raised. */
export type PyAnswer<T> = { value: T } | { error: string }

export interface PyVideoHeader {
  index: number; w: number; h: number; codec: string; pixFmt: string
  averageRate: PyRational | null; frames: number
  duration: number | null; timeBase: PyRational
  /** AVColorRange / AVColorSpace numbers, as PyAV holds them. */
  colorRange: number; colorSpace: number
}
export interface PySoundHeader {
  index: number; rate: number; channels: number; layout: string; codec: string; sampleFmt: string | null
  duration: number | null; timeBase: PyRational
}
export interface ProbeCase {
  clip: string
  header: { formatName: string; containerDuration: number | null; video: PyVideoHeader[]; sound: PySoundHeader[]; bytes: number }
  rawDuration: PyAnswer<number>
  frameCount: PyAnswer<number>
  frameRate: PyAnswer<PyRational>
  dimensions: PyAnswer<[number, number]>
}

/** A float32 sound: whole (base64) when small, else its sha256 and each channel's first 256 samples. */
export interface PySound { rate: number; rows: number; samples: number; sha256: string; f32?: string; f32z?: string; head?: string; dtype?: string }
export interface DecodeCase {
  clip: string
  frames: { w: number; h: number; list: { sha256: string; rgb?: string }[] } | { error: string }
  frameRate?: PyRational
  components?: PySound | null
  load: PySound | { error: string }
  download: PySound | { error: string }
}

export interface MediaFixture<C> {
  av: string; libraries: Record<string, number[]>; platform: string
  clips: Record<string, string>
  cases: C[]
}

export function mediaFixture<C>(group: 'probe' | 'decode' | 'encode'): MediaFixture<C> {
  return JSON.parse(readFileSync(resolve(FIXTURES, `runner-media-${group}.json`), 'utf8')) as MediaFixture<C>
}

export function sha256Hex(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex')
}

/** The real build, or a failure that says how to make it (never a skip: a skipped parity test reads as a pass). */
export async function requireMediaTools(): Promise<MediaTools> {
  const t = await mediaTools()
  if (!t) throw new Error('The video tools aren’t built on this machine: run scripts/media-tools/build.sh')
  return t
}

/** [C][N] float32 channels as the fixture's row-major bytes. */
export function soundBytes(channels: Float32Array[]): Uint8Array {
  const n = channels[0]?.length ?? 0
  const out = new Float32Array(channels.length * n)
  channels.forEach((ch, c) => out.set(ch, c * n))
  return new Uint8Array(out.buffer)
}

/** A Python sound left as one interleaved row (Python's 'download' of a packed file), read into its channels. */
export function deinterleave(row: Float32Array, channels: number): Float32Array[] {
  const n = row.length / channels
  return Array.from({ length: channels }, (_, c) => {
    const ch = new Float32Array(n)
    for (let i = 0; i < n; i++) ch[i] = row[i * channels + c]!
    return ch
  })
}

export function f32(b64: string): Float32Array {
  const b = Buffer.from(b64, 'base64')
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

// ── the encode group (R5.1c) ─────────────────────────────────────────────────

/** Bytes kept as zlib + base64 in the fixture. */
export function unz(b64: string): Uint8Array {
  return new Uint8Array(inflateSync(Buffer.from(b64, 'base64')))
}

/** zlib'd float32 bytes as a Float32Array. */
export function unzF32(b64: string): Float32Array {
  const b = unz(b64)
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

/**
 * The fixture script's `smooth_frame` (integer-only, so both make the same
 * bytes): two wrapping ramps and a disc that moves with i. rgb24.
 */
export function smoothFrame(w: number, h: number, i: number): Uint8Array {
  const out = new Uint8Array(w * h * 3)
  const cx = Math.floor(w / 2) + ((i * 3) % 16) - 8
  const cy = Math.floor(h / 2)
  const r2 = Math.floor(h / 3) ** 2
  let o = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[o++] = (x * 7 + y * 3 + i * 4) % 256
      out[o++] = (y * 9 + i * 2) % 256
      out[o++] = (x - cx) ** 2 + (y - cy) ** 2 < r2 ? 220 : (40 + y) & 255
    }
  }
  return out
}

/** A saved H.264 file as Python recorded it. */
export interface PyVideoOut {
  header: ProbeCase['header']
  frameCount: number; frameRate: PyRational; duration: number
  /** sha256 of each decoded rgb24 frame (get_components). */
  frames: string[]
  /** The decoded frames, zlib'd (the libx264 runs only). */
  rgbz?: string
  /** PSNR (dB) of the decoded frames against the source, rgb24. */
  psnr?: number | null
  sound: PySound | null
  tags?: Record<string, string>
}
export interface EncodeCases {
  openh264Qp: Record<string, number>
  saveTo: {
    name: string; fps: number; frames: number; w: number; h: number
    sound: { rate: number; channels: number; f32z: string } | null
    x264: PyVideoOut; openh264: PyVideoOut
  }[]
  rows: { crf: number; frames: string[]; frameCount: number }[]
  saveAudio: {
    format: 'flac' | 'mp3' | 'opus'; quality: 'V0' | '128k' | '320k'; channels: number; rate: number
    input: string; encoderSampleFmt: string; encoderRate: number; filename: string
    decoded: PySound; tags: Record<string, string>
  }[]
  resample: { orig: number; new: number; input: string; output: string; samples: number }[]
  stitch: { clips: string[]; x264: PyVideoOut; openh264: PyVideoOut }
  reformat: { name: string; w: number; h: number; yuv: string; sha256: string }[]
}
