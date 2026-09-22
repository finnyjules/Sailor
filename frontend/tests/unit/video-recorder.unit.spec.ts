import { describe, it, expect } from 'vitest'
import { planRecording, recordVideo, isAbortError, BT709, rgbaToI420aBt709, i420aSize } from '../../app/lib/engine/videoRecorder'

// A fake mediabunny that records what the recorder asks of it. The real library
// needs WebCodecs; this checks the ORCHESTRATION: order, timestamps, colour tag,
// cleanup, cancel. The real encode is proven by tests/browser-video-export.spec.ts.
function fakeLib(opts?: { failStart?: boolean }) {
  const log: any = { samples: [] as any[], rawData: [] as (Uint8Array | null)[], closed: 0, started: false, finalized: false, cancelled: false, track: null, source: null, format: null }
  class BufferTarget { buffer: ArrayBuffer | null = null }
  class Mp4OutputFormat { kind = 'mp4'; constructor(public opts?: any) {} }
  class WebMOutputFormat { kind = 'webm'; constructor(public opts?: any) {} }
  class Quality { constructor(public level: any) {} }
  class VideoSample {
    constructor(public data: any, public init: any) {
      log.samples.push({ init, snapshot: data.snapshot?.() })
      log.rawData.push(data instanceof Uint8Array ? data : null)
    }
    close() { log.closed++ }
  }
  class VideoSampleSource {
    constructor(public config: any) { log.source = config }
    async add(_s: any) {}
  }
  class Output {
    constructor(public opts: any) { log.format = opts.format }
    addVideoTrack(_src: any, meta: any) { log.track = meta }
    async start() { if (opts?.failStart) throw new Error('no encoder'); log.started = true }
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
    getImageData: (x: number, y: number, rw: number, rh: number) => {
      ops.push(`read ${x},${y},${rw},${rh}`)
      const data = new Uint8ClampedArray(rw * rh * 4)
      for (let p = 0; p < data.length; p += 4) { data[p] = 255; data[p + 3] = 128 }   // half-transparent red
      return { data, width: rw, height: rh }
    },
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
    expect([p.width, p.height]).toEqual([642, 362])
    expect(planRecording({ width: 640.3, height: 2, fps: 30, frameCount: 1 }).width).toBe(642)
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

  it('transparent: clears instead of filling, reads the pixels back, hands over BT.709 I420A', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    await recordVideo(
      { width: 2, height: 2, fps: 30, frameCount: 2, alpha: true, drawFrame: () => { c.ops.push('draw') } },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) },
    )
    expect(c.ops.slice(-3)).toEqual(['clear 0,0,2,2', 'draw', 'read 0,0,2,2'])
    const s = log.samples[1]
    expect(s.init).toEqual({ format: 'I420A', codedWidth: 2, codedHeight: 2, timestamp: 1 / 30, duration: 1 / 30, colorSpace: BT709 })
    // The sample's data is the converted frame, not the canvas: Y ×4, U, V, A ×4.
    expect(Array.from(log.rawData[1])).toEqual([63, 63, 63, 63, 102, 240, 128, 128, 128, 128])
    expect(log.closed).toBe(2)
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

  it('start() failure cancels the output and passes the error on', async () => {
    const { lib, log } = fakeLib({ failStart: true })
    const c = fakeCanvas(2, 2)
    const err = await recordVideo(
      { width: 2, height: 2, fps: 30, frameCount: 5, drawFrame: () => {} },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) },
    ).then(() => null, e => e)
    expect(err?.message).toBe('no encoder')
    expect(log.cancelled).toBe(true)
    expect(log.finalized).toBe(false)
  })
})

describe('rgbaToI420aBt709', () => {
  // One 2×2 block of a flat colour: Y ×4, U, V, A ×4.
  const flat = (r: number, g: number, b: number, a = 255) => {
    const px = new Uint8ClampedArray(16)
    for (let p = 0; p < 16; p += 4) { px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = a }
    const out = rgbaToI420aBt709(px, 2, 2)
    return { y: out[0], u: out[4], v: out[5], a: out[6], all: Array.from(out) }
  }

  // Reference values: ITU-R BT.709, 8-bit limited range (the colour-bar codes).
  it.each([
    ['white', [255, 255, 255], [235, 128, 128]],
    ['black', [0, 0, 0], [16, 128, 128]],
    ['red', [255, 0, 0], [63, 102, 240]],
    ['green', [0, 255, 0], [173, 42, 26]],
    ['blue', [0, 0, 255], [32, 240, 118]],
    // The gate's #c00000 bar, and what a BT.601 conversion would have given (65, 100, 212)
    ['#c00000', [192, 0, 0], [51, 109, 212]],
  ] as const)('%s → BT.709 limited-range Y/U/V', (_name, rgb, yuv) => {
    const r = flat(rgb[0], rgb[1], rgb[2])
    expect([r.y, r.u, r.v]).toEqual(yuv)
  })

  it('packs Y, U, V, A back to back and copies alpha untouched', () => {
    const r = flat(0, 0, 0, 37)
    expect(r.all).toEqual([16, 16, 16, 16, 128, 128, 37, 37, 37, 37])
    expect(i420aSize(2, 2)).toBe(10)
    expect(i420aSize(4, 2)).toBe(20)
  })

  it('chroma is the mean of the 2×2 block; luma is per pixel', () => {
    // Left column white, right column black
    const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255])
    const out = rgbaToI420aBt709(px, 2, 2)
    expect(Array.from(out.subarray(0, 4))).toEqual([235, 16, 235, 16])
    expect([out[4], out[5]]).toEqual([128, 128])
  })

  it('handles an odd size by averaging only the pixels that exist', () => {
    // 3×1: red, red, blue → chroma blocks (red,red) and (blue)
    const px = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255])
    const out = rgbaToI420aBt709(px, 3, 1)
    expect(out.length).toBe(i420aSize(3, 1))
    expect(Array.from(out.subarray(0, 3))).toEqual([63, 63, 32])
    expect(Array.from(out.subarray(3, 5))).toEqual([102, 240])   // U: red block, blue block
    expect(Array.from(out.subarray(5, 7))).toEqual([240, 118])   // V
    expect(Array.from(out.subarray(7))).toEqual([255, 255, 255])
  })
})
