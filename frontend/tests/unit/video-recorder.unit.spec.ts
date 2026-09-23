import { describe, it, expect } from 'vitest'
import { planRecording, recordVideo, isAbortError, BT709, rgbaToI420aBt709, i420aSize, vp9Quality, RECORD_QUALITY, AAC_PRIMING_SAMPLES, audioStartTimestamp } from '../../app/lib/engine/videoRecorder'

// A fake mediabunny that records what the recorder asks of it. The real library
// needs WebCodecs; this checks the ORCHESTRATION: order, timestamps, colour tag,
// cleanup, cancel. The real encode is proven by tests/browser-video-export.spec.ts.
function fakeLib(opts?: { failStart?: boolean }) {
  const log: any = { samples: [] as any[], rawData: [] as (Uint8Array | null)[], closed: 0, started: false, finalized: false, cancelled: false, track: null, source: null, format: null, audio: null, order: [] as string[] }
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
    async add(_s: any) { log.order.push('video') }
  }
  class AudioBufferSource {
    constructor(public config: any, public options: any = {}) { log.audio = { config, options, added: [] as any[] } }
    async add(b: any) { log.audio.added.push(b); log.order.push('audio') }
  }
  class Output {
    constructor(public opts: any) { log.format = opts.format }
    addVideoTrack(_src: any, meta: any) { log.track = meta }
    addAudioTrack(_src: any) { log.audioTrack = true }
    async start() { if (opts?.failStart) throw new Error('no encoder'); log.started = true }
    async finalize() { log.finalized = true; this.opts.target.buffer = new ArrayBuffer(16) }
    async cancel() { log.cancelled = true }
  }
  return { lib: { BufferTarget, Mp4OutputFormat, WebMOutputFormat, Quality, VideoSample, VideoSampleSource, AudioBufferSource, Output } as any, log }
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

describe('vp9Quality', () => {
  it('asks for 5 Mbps VBR at 1080p60 and scales with the pixel rate to the power 0.75', () => {
    expect(vp9Quality({ width: 1920, height: 1080, fps: 60 })).toEqual({ bitrate: 5_000_000, bitrateMode: 'variable' })
    // Half the pixel rate → 2^-0.75 of the bits
    expect(vp9Quality({ width: 1920, height: 1080, fps: 30 }).bitrate).toBe(Math.round(5_000_000 * 0.5 ** 0.75))
    // The gate's 320×180 at 30 fps gets more bits per pixel than 1080p60 does
    const small = vp9Quality({ width: 320, height: 180, fps: 30 }).bitrate
    expect(small).toBeGreaterThan(200_000)
    expect(small / (320 * 180 * 30)).toBeGreaterThan(0.1)
    expect(5_000_000 / (1920 * 1080 * 60)).toBeLessThan(0.05)
  })
})

describe('recordVideo', () => {
  it('draws every frame in order on a black ground, stamps i/fps, tags BT.709, closes each sample', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(4, 2)
    const drawn: number[] = []
    const progress: number[] = []
    const made: any[] = []
    const res = await recordVideo(
      { width: 4, height: 2, fps: 25, frameCount: 3, drawFrame: i => { drawn.push(i); c.ops.push(`draw ${i}`) }, onProgress: d => progress.push(d) },
      { lib, createCanvas: (...args: any[]) => { made.push(args); return { canvas: c.canvas, ctx: c.ctx } } },
    )
    // MP4 hands the canvas itself to the encoder: it stays a GPU canvas.
    expect(made).toEqual([[4, 2, { readBack: false }]])
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
    expect(log.source.quality.level).toBe(RECORD_QUALITY)
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
    const made: any[] = []
    await recordVideo(
      { width: 2, height: 2, fps: 30, frameCount: 2, alpha: true, drawFrame: () => { c.ops.push('draw') } },
      { lib, createCanvas: (...args: any[]) => { made.push(args); return { canvas: c.canvas, ctx: c.ctx } } },
    )
    // The canvas is read back every frame, so it is asked for as a CPU-side one.
    expect(made).toEqual([[2, 2, { readBack: true }]])
    expect(c.ops.slice(-3)).toEqual(['clear 0,0,2,2', 'draw', 'read 0,0,2,2'])
    // One buffer serves every frame (VideoFrame copies what it is given).
    expect(log.rawData[0]).toBe(log.rawData[1])
    const s = log.samples[1]
    expect(s.init).toEqual({ format: 'I420A', codedWidth: 2, codedHeight: 2, timestamp: 1 / 30, duration: 1 / 30, colorSpace: BT709 })
    // The sample's data is the converted frame, not the canvas: Y ×4, U, V, A ×4.
    expect(Array.from(log.rawData[1])).toEqual([63, 63, 63, 63, 102, 240, 128, 128, 128, 128])
    expect(log.closed).toBe(2)
    expect(log.source.codec).toBe('vp9')
    expect(log.source.alpha).toBe('keep')
    // A bitrate target, not a quantizer (see vp9Quality)
    expect(log.source.quality.level).toEqual(vp9Quality({ width: 2, height: 2, fps: 30 }))
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

describe('recordVideo — sound', () => {
  it('MP4 gets an AAC track; the whole buffer is added once, before the first frame', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    const buf = { duration: 1 } as any
    await recordVideo({ width: 2, height: 2, fps: 30, frameCount: 2, audio: buf, drawFrame: () => {} },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) })
    expect(log.audioTrack).toBe(true)
    expect(log.audio.config.codec).toBe('aac')
    expect(log.audio.added).toEqual([buf])
    expect(log.order).toEqual(['audio', 'video', 'video'])
  })

  it('AAC starts its sound early by the encoder priming, so the audible audio lands at 0 s', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    await recordVideo({ width: 2, height: 2, fps: 30, frameCount: 1, audio: { duration: 1, sampleRate: 48000 } as any, drawFrame: () => {} },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) })
    expect(log.audio.options.startTimestamp).toBeCloseTo(-AAC_PRIMING_SAMPLES / 48000, 10)
    expect(audioStartTimestamp('webm', 48000)).toBe(0)
  })

  it('transparent WebM with sound uses Opus', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    await recordVideo({ width: 2, height: 2, fps: 30, frameCount: 1, alpha: true, audio: { duration: 1 } as any, drawFrame: () => {} },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) })
    expect(log.audio.config.codec).toBe('opus')
  })

  it('no audio → no audio track', async () => {
    const { lib, log } = fakeLib()
    const c = fakeCanvas(2, 2)
    await recordVideo({ width: 2, height: 2, fps: 30, frameCount: 1, drawFrame: () => {} },
      { lib, createCanvas: () => ({ canvas: c.canvas, ctx: c.ctx }) })
    expect(log.audioTrack).toBeUndefined()
  })
})

// The textbook conversion, written for clarity not speed: BT.709 matrix,
// limited range, per-pixel luma, 2×2 chroma from the alpha-weighted mean RGB
// of the pixels that exist (plain mean when none is visible), alpha copied.
function referenceI420a(rgba: ArrayLike<number>, w: number, h: number): number[] {
  const kr = 0.2126, kb = 0.0722, kg = 1 - kr - kb
  const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2)
  const Y: number[] = [], U: number[] = [], V: number[] = [], A: number[] = []
  for (let i = 0; i < w * h; i++) {
    const p = i * 4
    Y.push(Math.round(16 + (219 / 255) * (kr * rgba[p]! + kg * rgba[p + 1]! + kb * rgba[p + 2]!)))
    A.push(rgba[p + 3]!)
  }
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const px: number[] = []
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const x = 2 * cx + dx!, y = 2 * cy + dy!
        if (x < w && y < h) px.push((y * w + x) * 4)
      }
      const visible = px.some(p => rgba[p + 3]! > 0)
      let r = 0, g = 0, b = 0, n = 0
      for (const p of px) {
        const wt = visible ? rgba[p + 3]! : 1
        r += wt * rgba[p]!; g += wt * rgba[p + 1]!; b += wt * rgba[p + 2]!; n += wt
      }
      r /= n; g /= n; b /= n
      const l = kr * r + kg * g + kb * b
      U.push(Math.round(128 + (224 / 255) * (b - l) / (2 * (1 - kb))))
      V.push(Math.round(128 + (224 / 255) * (r - l) / (2 * (1 - kr))))
    }
  }
  return [...Y, ...U, ...V, ...A]
}

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

  it('weights a block\'s chroma by alpha, so a transparent pixel does not tint its visible neighbours', () => {
    // Three opaque #c00000 pixels and one fully transparent black one (what
    // clearRect leaves): the block's chroma is #c00000's, not a darker red.
    const px = new Uint8ClampedArray([192, 0, 0, 255, 0, 0, 0, 0, 192, 0, 0, 255, 192, 0, 0, 255])
    const out = rgbaToI420aBt709(px, 2, 2)
    expect([out[4], out[5]]).toEqual([109, 212])
    expect(Array.from(out.subarray(0, 4))).toEqual([51, 16, 51, 51])   // luma stays per pixel
    expect(Array.from(out.subarray(6))).toEqual([255, 0, 255, 255])
    // Half-transparent white beside opaque black: weighted 1:2 towards black (still grey → 128)
    const g = rgbaToI420aBt709(new Uint8ClampedArray([255, 255, 255, 128, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]), 2, 2)
    expect([g[4], g[5]]).toEqual([128, 128])
  })

  it('a block with no visible pixel falls back to the plain mean', () => {
    const px = new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0])
    const out = rgbaToI420aBt709(px, 2, 2)
    expect([out[4], out[5]]).toEqual([102, 240])
  })

  it('matches a straightforward BT.709 reference within ±1 on random frames of many sizes', () => {
    let seed = 12345
    const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 16) & 255 }
    for (const [w, h] of [[2, 2], [3, 1], [1, 3], [5, 3], [64, 34], [33, 17], [7, 8]] as const) {
      const px = new Uint8ClampedArray(w * h * 4)
      for (let p = 0; p < px.length; p++) {
        const v = rnd()
        // alpha: mostly 0 or 255 (the real edges), some in between
        px[p] = (p & 3) === 3 ? (v < 80 ? 0 : v > 170 ? 255 : v) : v
      }
      const got = rgbaToI420aBt709(px, w, h)
      const want = referenceI420a(px, w, h)
      expect(got.length).toBe(want.length)
      let worst = 0
      for (let k = 0; k < want.length; k++) worst = Math.max(worst, Math.abs(got[k]! - want[k]!))
      expect(worst, `${w}×${h}`).toBeLessThanOrEqual(1)
    }
  })

  it('writes into a caller\'s buffer (one buffer for a whole video) and refuses one of the wrong size', () => {
    const px = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255])
    const buf = new Uint8Array(i420aSize(2, 2)).fill(7)
    const out = rgbaToI420aBt709(px, 2, 2, buf)
    expect(out).toBe(buf)
    expect(Array.from(buf)).toEqual([63, 63, 63, 63, 102, 240, 255, 255, 255, 255])
    expect(() => rgbaToI420aBt709(px, 2, 2, new Uint8Array(9))).toThrow()
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
