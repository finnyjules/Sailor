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

export type MediabunnyLike = Pick<typeof Mediabunny,
  'Output' | 'BufferTarget' | 'Mp4OutputFormat' | 'WebMOutputFormat' | 'VideoSampleSource' | 'VideoSample' | 'Quality'>

export interface RecorderDeps {
  lib?: MediabunnyLike
  createCanvas?: (w: number, h: number) => { canvas: CanvasImageSource; ctx: CanvasRenderingContext2D }
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

const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

/** Size in bytes of one I420A frame (Y, U, V, A planes, chroma halved both ways). */
export function i420aSize(width: number, height: number): number {
  return 2 * width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2)
}

/** Straight (not premultiplied) RGBA, as getImageData returns it → planar
 *  I420A: BT.709 matrix, limited range, 2×2 chroma from the mean of the block's
 *  RGB (the same siting libyuv uses), alpha copied as its own full-size plane.
 *  Planes are packed back to back with no row padding: Y, U, V, A. */
export function rgbaToI420aBt709(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const cw = Math.ceil(width / 2)
  const ch = Math.ceil(height / 2)
  const out = new Uint8Array(i420aSize(width, height))
  const uOff = width * height
  const vOff = uOff + cw * ch
  const aOff = vOff + cw * ch
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      out[y * width + x] = clampByte(16 + Y_SCALE * (KR * rgba[p]! + KG * rgba[p + 1]! + KB * rgba[p + 2]!))
      out[aOff + y * width + x] = rgba[p + 3]!
    }
  }
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let r = 0, g = 0, b = 0, n = 0
      for (let dy = 0; dy < 2; dy++) {
        const y = 2 * cy + dy
        if (y >= height) continue
        for (let dx = 0; dx < 2; dx++) {
          const x = 2 * cx + dx
          if (x >= width) continue
          const p = (y * width + x) * 4
          r += rgba[p]!; g += rgba[p + 1]!; b += rgba[p + 2]!; n++
        }
      }
      r /= n; g /= n; b /= n
      const luma = KR * r + KG * g + KB * b
      out[uOff + cy * cw + cx] = clampByte(128 + C_SCALE * (b - luma) / CB_DIV)
      out[vOff + cy * cw + cx] = clampByte(128 + C_SCALE * (r - luma) / CR_DIV)
    }
  }
  return out
}

export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError'
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
}

function defaultCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) throw new Error('video recorder: no 2D canvas')
  return { canvas, ctx }
}

export async function recordVideo(req: RecordRequest, deps: RecorderDeps = {}): Promise<RecordResult> {
  const plan = planRecording(req)
  throwIfAborted(req.signal)
  const mb: MediabunnyLike = deps.lib ?? await import('mediabunny')
  const { canvas, ctx } = (deps.createCanvas ?? defaultCanvas)(plan.width, plan.height)

  const target = new mb.BufferTarget()
  const format = plan.ext === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat()
  const output = new mb.Output({ format, target })
  const source = new mb.VideoSampleSource({
    codec: plan.codec,
    quality: new mb.Quality(RECORD_QUALITY),
    alpha: plan.alpha ? 'keep' : 'discard',
  })
  output.addVideoTrack(source, { frameRate: plan.fps })

  const dt = 1 / plan.fps
  try {
    await output.start()
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
        ? new mb.VideoSample(rgbaToI420aBt709(ctx.getImageData(0, 0, plan.width, plan.height).data, plan.width, plan.height), {
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
