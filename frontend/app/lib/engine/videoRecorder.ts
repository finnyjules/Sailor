import type * as Mediabunny from 'mediabunny'

// Frames → a video file, in the browser. The caller says how big, how fast, how
// many frames, and how to draw frame i onto a 2D canvas; this asks for the
// frames one at a time and encodes each as it arrives, so memory stays flat
// however long the video is. It knows nothing about studios, Frames or the
// timeline. Spec: docs/superpowers/specs/2026-09-21-browser-video-export-design.md

export interface RecordRequest {
  width: number
  height: number
  fps: number
  frameCount: number
  /** Draw frame i onto `ctx` (already cleared, or filled black when opaque).
   *  May await (a video decode, a font). A WebGL source must be copied onto
   *  `ctx` right after its render call, with no await in between. */
  drawFrame: (i: number, ctx: CanvasRenderingContext2D) => Promise<void> | void
  /** True → VP9 in WebM with an alpha plane. Otherwise H.264 in MP4. */
  alpha?: boolean
  /** Optional sound for the whole video, starting at 0 s (the timeline mix). */
  audio?: AudioBuffer
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export interface RecordResult {
  blob: Blob
  ext: 'mp4' | 'webm'
  contentType: string
  width: number
  height: number
}

export interface RecordingPlan {
  width: number
  height: number
  fps: number
  frameCount: number
  alpha: boolean
  codec: 'avc' | 'vp9'
  ext: 'mp4' | 'webm'
  contentType: string
}

/** The colour standard the server tags today (nodes_timeline.py _apply_bt709). */
export const BT709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } as const

/** Encoder quality. Set by the browser quality gate (Task 3): 'high' unless the
 *  gate showed it falls short of the server's files. */
export const RECORD_QUALITY: 'high' | 'very-high' = 'high'

/** VP9 + alpha rate control (Task 8): a variable-bitrate target. Not a
 *  quality level: 'high' is a fixed quantizer (28) on every frame, and Chrome's
 *  VP9 quantizer mode spends ~6× the server's bits on each inter frame at ANY
 *  quantizer (Space Type 1080p60: 10.0 MB at 28, still 7.2 MB at 48; server
 *  crf 30: 2.0 MB), while the same encoder given a bitrate lands on it.
 *  5 Mbps at 1080p60 (0.04 bits per pixel per frame) is the lowest tried that
 *  keeps Space Type within the gate's pass mark of the server on opaque pixels
 *  (0.032 did not); it scales with the pixel rate to the power 0.75, because a
 *  small video needs more bits per pixel (the 320×180 gate failed at a flat
 *  0.04 and passed at 0.08).
 *  Measurements: task-8-report.md. */
export const VP9_BITRATE_1080P60 = 5_000_000
const VP9_RATE_EXPONENT = 0.75

export function vp9Quality(plan: Pick<RecordingPlan, 'width' | 'height' | 'fps'>): { bitrate: number; bitrateMode: 'variable' } {
  const pixelRate = (plan.width * plan.height * plan.fps) / (1920 * 1080 * 60)
  return { bitrate: Math.round(VP9_BITRATE_1080P60 * Math.pow(pixelRate, VP9_RATE_EXPONENT)), bitrateMode: 'variable' }
}

export type MediabunnyLike = Pick<typeof Mediabunny,
  'Output' | 'BufferTarget' | 'Mp4OutputFormat' | 'WebMOutputFormat' | 'VideoSampleSource' | 'VideoSample' | 'Quality' | 'AudioBufferSource'>

/** AAC in MP4 (the format Chrome and Safari both play), Opus in WebM. */
export function audioCodecFor(ext: 'mp4' | 'webm'): 'aac' | 'opus' {
  return ext === 'mp4' ? 'aac' : 'opus'
}

export interface RecorderDeps {
  lib?: MediabunnyLike
  /** `readBack`: the recorder reads the pixels back every frame (VP9 + alpha),
   *  so the canvas should live on the CPU side (willReadFrequently). */
  createCanvas?: (w: number, h: number, opts: { readBack: boolean }) => { canvas: CanvasImageSource; ctx: CanvasRenderingContext2D }
}

// Round up to a whole pixel, then up to even
const even = (n: number) => { const r = Math.ceil(n); return r + (r % 2) }

export function planRecording(req: Pick<RecordRequest, 'width' | 'height' | 'fps' | 'frameCount' | 'alpha'>): RecordingPlan {
  if (!(req.width >= 1) || !(req.height >= 1)) throw new Error(`video recorder: bad size ${req.width}×${req.height}`)
  if (!(req.fps > 0)) throw new Error(`video recorder: bad frame rate ${req.fps}`)
  if (!(req.frameCount >= 1)) throw new Error(`video recorder: bad frame count ${req.frameCount}`)
  const alpha = !!req.alpha
  return {
    width: even(req.width),
    height: even(req.height),
    fps: req.fps,
    frameCount: Math.round(req.frameCount),
    alpha,
    codec: alpha ? 'vp9' : 'avc',
    ext: alpha ? 'webm' : 'mp4',
    contentType: alpha ? 'video/webm' : 'video/mp4',
  }
}

// BT.709 luma weights (ITU-R BT.709-6, table 3). Kg = 1 - Kr - Kb.
const KR = 0.2126
const KB = 0.0722
const KG = 1 - KR - KB
// Limited ("video") range: Y spans 16–235 (219 steps), Cb/Cr 16–240 (224 steps).
const Y_SCALE = 219 / 255
const C_SCALE = 224 / 255
const CB_DIV = 2 * (1 - KB)
const CR_DIV = 2 * (1 - KR)
// The same matrix folded into one weight per channel:
//   Y = 16 + YR·r + YG·g + YB·b,  U = 128 + UR·r + UG·g + UB·b,  V = 128 + VR·r + VG·g + VB·b
const YR = Y_SCALE * KR, YG = Y_SCALE * KG, YB = Y_SCALE * KB
const UR = -C_SCALE * KR / CB_DIV, UG = -C_SCALE * KG / CB_DIV, UB = C_SCALE * (1 - KB) / CB_DIV
const VR = C_SCALE * (1 - KR) / CR_DIV, VG = -C_SCALE * KG / CR_DIV, VB = -C_SCALE * KB / CR_DIV

/** Size in bytes of one I420A frame (Y, U, V, A planes, chroma halved both ways). */
export function i420aSize(width: number, height: number): number {
  return 2 * width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2)
}

// Each pixel is read as one 32-bit word (a third faster than four byte reads
// at 1080p). Where the bytes R,G,B,A sit in that word depends on the
// machine's byte order.
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
const SR = LITTLE_ENDIAN ? 0 : 24
const SG = LITTLE_ENDIAN ? 8 : 16
const SB = LITTLE_ENDIAN ? 16 : 8
const SA = LITTLE_ENDIAN ? 24 : 0

function pixelWords(rgba: ArrayLike<number>, pixels: number): Uint32Array {
  if (rgba.length < pixels * 4) throw new Error(`video recorder: ${rgba.length} bytes of RGBA for ${pixels} pixels`)
  let bytes = rgba instanceof Uint8ClampedArray || rgba instanceof Uint8Array ? rgba : Uint8Array.from(rgba)
  if (bytes.byteOffset % 4 !== 0) bytes = bytes.slice()
  return new Uint32Array(bytes.buffer, bytes.byteOffset, pixels)
}

/** Straight (not premultiplied) RGBA, as getImageData returns it → planar
 *  I420A: BT.709 matrix, limited range, alpha copied as its own full-size
 *  plane, planes packed back to back with no row padding: Y, U, V, A.
 *  Luma is per pixel. Chroma is one value per 2×2 block (the siting libyuv
 *  uses), from the block's mean RGB weighted by alpha: a pixel you cannot see
 *  (clearRect leaves transparent BLACK) must not darken the colour of a visible
 *  neighbour at an anti-aliased edge. A block with nothing visible takes the
 *  plain mean. Pass `out` (i420aSize bytes) to reuse one buffer for a whole
 *  video; every byte is rewritten. All results are within [16, 240], so the
 *  +0.5-and-truncate rounding needs no clamp. */
export function rgbaToI420aBt709(rgba: ArrayLike<number>, width: number, height: number, out?: Uint8Array): Uint8Array {
  const size = i420aSize(width, height)
  if (out && out.length !== size) throw new Error(`video recorder: I420A buffer is ${out.length} bytes, ${width}×${height} needs ${size}`)
  const dst = out ?? new Uint8Array(size)
  const s32 = pixelWords(rgba, width * height)
  const cw = Math.ceil(width / 2)
  const ch = Math.ceil(height / 2)
  const uOff = width * height
  const vOff = uOff + cw * ch
  const aOff = vOff + cw * ch
  for (let cy = 0; cy < ch; cy++) {
    const row0 = 2 * cy * width
    const hasRow1 = 2 * cy + 1 < height
    const row1 = row0 + width
    const cRow = cy * cw
    for (let cx = 0; cx < cw; cx++) {
      const x = 2 * cx
      const hasCol1 = x + 1 < width
      // top-left pixel (always exists)
      let i = row0 + x
      let v = s32[i]!
      let r = (v >>> SR) & 255, g = (v >>> SG) & 255, b = (v >>> SB) & 255, a = (v >>> SA) & 255
      dst[i] = (16.5 + YR * r + YG * g + YB * b) | 0
      dst[aOff + i] = a
      let sr = a * r, sg = a * g, sb = a * b, sa = a
      let pr = r, pg = g, pb = b, n = 1
      if (hasCol1) {
        i++; v = s32[i]!
        r = (v >>> SR) & 255; g = (v >>> SG) & 255; b = (v >>> SB) & 255; a = (v >>> SA) & 255
        dst[i] = (16.5 + YR * r + YG * g + YB * b) | 0
        dst[aOff + i] = a
        sr += a * r; sg += a * g; sb += a * b; sa += a
        pr += r; pg += g; pb += b; n++
      }
      if (hasRow1) {
        i = row1 + x
        v = s32[i]!
        r = (v >>> SR) & 255; g = (v >>> SG) & 255; b = (v >>> SB) & 255; a = (v >>> SA) & 255
        dst[i] = (16.5 + YR * r + YG * g + YB * b) | 0
        dst[aOff + i] = a
        sr += a * r; sg += a * g; sb += a * b; sa += a
        pr += r; pg += g; pb += b; n++
        if (hasCol1) {
          i++; v = s32[i]!
          r = (v >>> SR) & 255; g = (v >>> SG) & 255; b = (v >>> SB) & 255; a = (v >>> SA) & 255
          dst[i] = (16.5 + YR * r + YG * g + YB * b) | 0
          dst[aOff + i] = a
          sr += a * r; sg += a * g; sb += a * b; sa += a
          pr += r; pg += g; pb += b; n++
        }
      }
      let mr: number, mg: number, mb: number
      if (sa > 0) { const k = 1 / sa; mr = sr * k; mg = sg * k; mb = sb * k } else { const k = 1 / n; mr = pr * k; mg = pg * k; mb = pb * k }
      dst[uOff + cRow + cx] = (128.5 + UR * mr + UG * mg + UB * mb) | 0
      dst[vOff + cRow + cx] = (128.5 + VR * mr + VG * mg + VB * mb) | 0
    }
  }
  return dst
}

export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError'
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
}

function defaultCanvas(w: number, h: number, opts: { readBack: boolean }) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  // Read back every frame → keep it on the CPU: getImageData is then a copy,
  // not a GPU read-back. The MP4 path hands the canvas itself to the encoder,
  // so it stays a GPU canvas.
  const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: opts.readBack })
  if (!ctx) throw new Error('video recorder: no 2D canvas')
  return { canvas, ctx }
}

export async function recordVideo(req: RecordRequest, deps: RecorderDeps = {}): Promise<RecordResult> {
  const plan = planRecording(req)
  throwIfAborted(req.signal)
  const mb: MediabunnyLike = deps.lib ?? await import('mediabunny')
  const { canvas, ctx } = (deps.createCanvas ?? defaultCanvas)(plan.width, plan.height, { readBack: plan.alpha })
  // VP9 + alpha: one I420A buffer for the whole video. Safe to refill each
  // frame because mediabunny 1.59's VideoSample constructor copies the bytes
  // (`toUint8Array(data).slice()` in mediabunny/dist/modules/src/sample.js,
  // unless `_doNotCopy`), so the buffer is free again as soon as the
  // constructor returns. Never pass `_doNotCopy` here.
  const i420a = plan.alpha ? new Uint8Array(i420aSize(plan.width, plan.height)) : null

  const target = new mb.BufferTarget()
  const format = plan.ext === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat()
  const output = new mb.Output({ format, target })
  const source = new mb.VideoSampleSource({
    codec: plan.codec,
    quality: new mb.Quality(plan.alpha ? vp9Quality(plan) : RECORD_QUALITY),
    alpha: plan.alpha ? 'keep' : 'discard',
  })
  output.addVideoTrack(source, { frameRate: plan.fps })
  const audioSource = req.audio
    ? new mb.AudioBufferSource({ codec: audioCodecFor(plan.ext), quality: new mb.Quality('high') })
    : null
  if (audioSource) output.addAudioTrack(audioSource)

  const dt = 1 / plan.fps
  try {
    await output.start()
    if (audioSource) await audioSource.add(req.audio!)
    for (let i = 0; i < plan.frameCount; i++) {
      throwIfAborted(req.signal)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      if (plan.alpha) {
        ctx.clearRect(0, 0, plan.width, plan.height)
      } else {
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, plan.width, plan.height)
      }
      await req.drawFrame(i, ctx)
      throwIfAborted(req.signal)
      // VP9 + alpha: we convert to YUV ourselves. Handed the canvas, mediabunny
      // 1.59 splits colour from alpha into a fresh RGBX VideoFrame that drops the
      // BT.709 colour space; Chrome then converts it to I420 with BT.601 and
      // tags the file smpte170m (pixels and tag agree, but not BT.709 like the
      // server's files). Worse, mediabunny's own alpha DECODE rebuilds each
      // frame as I420A without a colour space, which Chrome reads as BT.709, so
      // that BT.601 file came back ~6 levels off (gate, 2026-09-22). An I420A
      // sample made with the BT.709 matrix goes through the splitter untouched
      // (colour planes as I420, which WebCodecs defaults to BT.709), so the
      // encoder tags BT.709 and the pixels match the tag. H.264 keeps the canvas
      // path: there the colour space is honoured.
      const sample = plan.alpha
        ? new mb.VideoSample(rgbaToI420aBt709(ctx.getImageData(0, 0, plan.width, plan.height).data, plan.width, plan.height, i420a!), {
          format: 'I420A', codedWidth: plan.width, codedHeight: plan.height, timestamp: i * dt, duration: dt, colorSpace: BT709,
        })
        : new mb.VideoSample(canvas, { timestamp: i * dt, duration: dt, colorSpace: BT709 })
      try {
        await source.add(sample)
      } finally {
        sample.close()
      }
      req.onProgress?.(i + 1, plan.frameCount)
    }
    await output.finalize()
  } catch (err) {
    await output.cancel().catch(() => {})
    throw err
  }

  const buffer = target.buffer
  if (!buffer) throw new Error('video recorder: the encoder produced no file')
  return {
    blob: new Blob([buffer], { type: plan.contentType }),
    ext: plan.ext,
    contentType: plan.contentType,
    width: plan.width,
    height: plan.height,
  }
}
