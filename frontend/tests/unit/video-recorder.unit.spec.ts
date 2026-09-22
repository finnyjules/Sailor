import { describe, it, expect } from 'vitest'
import { planRecording, recordVideo, isAbortError, BT709 } from '../../app/lib/engine/videoRecorder'

// A fake mediabunny that records what the recorder asks of it. The real library
// needs WebCodecs; this checks the ORCHESTRATION: order, timestamps, colour tag,
// cleanup, cancel. The real encode is proven by tests/browser-video-export.spec.ts.
function fakeLib() {
  const log: any = { samples: [] as any[], closed: 0, started: false, finalized: false, cancelled: false, track: null, source: null, format: null }
  class BufferTarget { buffer: ArrayBuffer | null = null }
  class Mp4OutputFormat { kind = 'mp4'; constructor(public opts?: any) {} }
  class WebMOutputFormat { kind = 'webm'; constructor(public opts?: any) {} }
  class Quality { constructor(public level: any) {} }
  class VideoSample {
    constructor(public data: any, public init: any) { log.samples.push({ init, snapshot: data.snapshot?.() }) }
    close() { log.closed++ }
  }
  class VideoSampleSource {
    constructor(public config: any) { log.source = config }
    async add(_s: any) {}
  }
  class Output {
    constructor(public opts: any) { log.format = opts.format }
    addVideoTrack(_src: any, meta: any) { log.track = meta }
    async start() { log.started = true }
    async finalize() { log.finalized = true; this.opts.target.buffer = new ArrayBuffer(16) }
    async cancel() { log.cancelled = true }
  }
  return { lib: { BufferTarget, Mp4OutputFormat, WebMOutputFormat, Quality, VideoSample, VideoSampleSource, Output } as any, log }
}

// A fake 2D context that remembers how each frame was prepared.
function fakeCanvas(w: number, h: number) {
  const ops: string[] = []
  const ctx: any = {
    canvas: { width: w, height: h },
    fillStyle: '',
    setTransform: () => {},
    fillRect: (x: number, y: number, fw: number, fh: number) => ops.push(`fill ${ctx.fillStyle} ${x},${y},${fw},${fh}`),
    clearRect: (x: number, y: number, fw: number, fh: number) => ops.push(`clear ${x},${y},${fw},${fh}`),
  }
  const canvas: any = { width: w, height: h, snapshot: () => ops.slice() }
  return { canvas, ctx, ops }
}

describe('planRecording', () => {
  it('opaque → H.264 in MP4', () => {
    expect(planRecording({ width: 1920, height: 1080, fps: 30, frameCount: 90 })).toEqual({
      width: 1920, height: 1080, fps: 30, frameCount: 90, alpha: false, codec: 'avc', ext: 'mp4', contentType: 'video/mp4',
    })
  })

  it('transparent → VP9 in WebM', () => {
    const p = planRecording({ width: 640, height: 360, fps: 24, frameCount: 10, alpha: true })
    expect([p.codec, p.ext, p.contentType, p.alpha]).toEqual(['vp9', 'webm', 'video/webm', true])
  })

  it('rounds odd sizes UP to even and fractional sizes to whole pixels', () => {
    const p = planRecording({ width: 641, height: 360.4, fps: 30, frameCount: 1 })
    expect([p.width, p.height]).toEqual([642, 360])
  })

  it('refuses nonsense', () => {
    expect(() => planRecording({ width: 0, height: 10, fps: 30, frameCount: 1 })).toThrow()
    expect(() => planRecording({ width: 10, height: 10, fps: 0, frameCount: 1 })).toThrow()
    expect(() => planRecording({ width: 10, height: 10, fps: 30, frameCount: 0 })).toThrow()
  })
})

describe('recordVideo', () => {
  it('draws every frame in order on a black ground, stamps i/fps, tags BT.709, closes each sample', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(4, 2)
    const drawn: number[] = []
    const progress: number[] = []
    const res = await recordVideo(
      { width: 4, height: 2, fps: 25, frameCount: 3, drawFrame: i => { drawn.push(i); c.ops.push(`draw ${i}`) }, onProgress: d => progress.push(d) },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) },
    )
    expect(drawn).toEqual([0, 1, 2])
    expect(progress).toEqual([1, 2, 3])
    expect(log.samples.map((s: any) => s.init.timestamp)).toEqual([0, 0.04, 0.08])
    expect(log.samples.every((s: any) => s.init.duration === 0.04)).toBe(true)
    expect(log.samples[0].init.colorSpace).toEqual(BT709)
    // Each frame starts from a black fill, then the surface draws on top.
    expect(log.samples[1].snapshot.slice(-2)).toEqual(['fill #000000 0,0,4,2', 'draw 1'])
    expect(log.closed).toBe(3)
    expect(log.source.codec).toBe('avc')
    expect(log.source.alpha).toBe('discard')
    expect(log.track.frameRate).toBe(25)
    expect(log.format.kind).toBe('mp4')
    expect(log.finalized).toBe(true)
    expect(res.ext).toBe('mp4')
    expect(res.blob.type).toBe('video/mp4')
    expect(res.blob.size).toBe(16)
  })

  it('transparent: clears instead of filling, and keeps alpha', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    await recordVideo(
      { width: 2, height: 2, fps: 30, frameCount: 1, alpha: true, drawFrame: () => { c.ops.push('draw') } },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) },
    )
    expect(log.samples[0].snapshot.slice(-2)).toEqual(['clear 0,0,2,2', 'draw'])
    expect(log.source.codec).toBe('vp9')
    expect(log.source.alpha).toBe('keep')
    expect(log.format.kind).toBe('webm')
  })

  it('cancel: stops with an AbortError, cancels the output, never finalizes', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    const ac = new AbortController()
    const run = recordVideo(
      { width: 2, height: 2, fps: 30, frameCount: 10, signal: ac.signal, drawFrame: i => { if (i === 3) ac.abort() } },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) },
    )
    const err = await run.then(() => null, e => e)
    expect(isAbortError(err)).toBe(true)
    expect(log.cancelled).toBe(true)
    expect(log.finalized).toBe(false)
    expect(log.samples.length).toBeLessThanOrEqual(4)
  })

  it('a failing frame cancels the output and passes the error on', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    const err = await recordVideo(
      { width: 2, height: 2, fps: 30, frameCount: 5, drawFrame: i => { if (i === 2) throw new Error('boom') } },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) },
    ).then(() => null, e => e)
    expect(err?.message).toBe('boom')
    expect(isAbortError(err)).toBe(false)
    expect(log.cancelled).toBe(true)
    expect(log.finalized).toBe(false)
  })
})
