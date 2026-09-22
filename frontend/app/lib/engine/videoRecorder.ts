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
      const sample = new mb.VideoSample(canvas, { timestamp: i * dt, duration: dt, colorSpace: BT709 })
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
