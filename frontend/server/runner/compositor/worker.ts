/**
 * The Frame's pixel work, off the server's main thread: one worker thread per
 * process, one composite at a time (a queue), created on first use and
 * unref'd so it never keeps the process alive. Blend scene's kept subject
 * (Task F11b, keep.ts) runs on the same worker, in the same queue, under the
 * same watchdog.
 *
 * The main thread only decodes (sharp, on libvips' own threads) and encodes
 * the PNG. Everything that touches pixels one by one runs in the worker:
 * sharp's raw RGBA8 buffers are handed over (transferred, not copied) and
 * the worker builds the float tensors, composites, and hands back the 8-bit
 * pixels save_live_preview would write.
 *
 * The worker runs the very same `compositorCore` the parity spec checks: its
 * source text (`compositorCore.toString()`) is the worker's script, because
 * the function is self-contained by contract (plane.ts). No separate build
 * entry, so it works the same under vitest and in the Nitro bundle
 * (runner-compositor-engine.unit.spec.ts builds plane.ts with esbuild as
 * Nitro does, minified and not, and runs the result).
 *
 * Stop: the engine's abort signal sets a shared flag the core reads before
 * every copy, and `composeFrame` checks the signal between layers.
 * Watchdog: a render that takes longer than 2 minutes terminates the worker
 * and fails plainly; the next render starts a fresh one.
 */
import { Worker } from 'node:worker_threads'
import { compositorCore, type Picture, type RawPicture } from './plane'
import { composeFrame, type FrameBackend, type FrameLoaders } from './render'
import { pixelsCore, type PixelsPicture } from '../pixels/core'
import { EFFECT_CORES, type EffectCoreEntry } from '../effects/cores'
import type { PilRaw } from '../pixels/pilPixels'

/**
 * The worker's script around a core function's source text. `__name` is
 * esbuild's keepNames helper: a no-op here, so a build with keepNames on
 * (unminified) still runs. Nitro builds with neither keepNames nor a helper
 * (target es2019); the esbuild guard in the engine spec checks both minified
 * and not.
 */
export function workerScript(
  coreFn: () => unknown = compositorCore,
  pixelsFn: () => unknown = pixelsCore,
  effectCores: readonly EffectCoreEntry[] = EFFECT_CORES,
): string {
  // The effect cores (R2), each from its source text, in dependency order.
  const built = effectCores.map(c => `built[${JSON.stringify(c.name)}] = (${c.fn.toString()})(${c.args.map(a => `built[${JSON.stringify(a)}]`).join(', ')})`).join('\n')
  return `
const { parentPort, workerData } = require('node:worker_threads')
const __name = (f) => f
const core = (${coreFn.toString()})()
const px = (${pixelsFn.toString()})()
const built = { px }
${built}
const stop = new Int32Array(workerData.stop)
const stopped = () => { if (Atomics.load(stop, 0) === 1) throw new Error('Stopped') }
const isStopped = () => Atomics.load(stop, 0) === 1
let cv = null
let clipAlpha = null
// The effect under way (fx.begin … fx.end): its op, settings and any state it carries across the batch.
let fx = null
const effectOp = (name) => {
  const dot = name.indexOf('.')
  const c = dot > 0 ? built[name.slice(0, dot)] : null
  const fn = c ? c[name.slice(dot + 1)] : null
  if (typeof fn !== 'function') throw new Error('This effect is not in the runner')
  return fn
}
parentPort.on('message', (m) => {
  try {
    let value = null
    let transfer = []
    if (m.op === 'begin') cv = core.createCanvas(m.ch, m.cw)
    else if (m.op === 'paint') core.paint(cv, m.image, m.mask, m.blend, m.copies, m.protect, () => Atomics.load(stop, 0) === 1)
    else if (m.op === 'overlay') core.overlay(cv, m.image, m.mask)
    else if (m.op === 'finish') {
      const r = core.finish(cv, !!m.protect)
      cv = null
      const px = core.toPreview8(r.image)
      value = { w: r.image.w, h: r.image.h, px }
      transfer = [px.buffer]
      if (r.protect) {
        value.mask = core.mask16Scanlines(r.protect)
        transfer.push(value.mask.buffer)
      }
    }
    else if (m.op === 'keep') {
      const mask = core.maskFromScanlines(m.mask, m.mw, m.mh)
      value = core.keepSubject(m.base, m.edited, mask, m.feather, () => Atomics.load(stop, 0) === 1)
      transfer = [value.px.buffer]
    }
    // The picture utilities (R1.4, ../pixels/core.ts).
    else if (m.op === 'px.channel') {
      stopped()
      value = px.channelMask16(m.picture, m.index, !!m.float)
      transfer = value.data ? [value.scanlines.buffer, value.data.buffer] : [value.scanlines.buffer]
    }
    // A picture an effect made, as its kept float32 tensor (R2.8 fix round 2): Image to mask's channel, Text mask's clip.
    else if (m.op === 'px.channelTensor') {
      stopped()
      const t = built.tk.fromTensorFile(m.tensorFile)
      if (m.index >= t.c) throw new Error('This picture has no alpha channel to make a mask from')
      const n = t.w * t.h
      const data = t.data.slice(m.index * n, (m.index + 1) * n)
      value = { w: t.w, h: t.h, scanlines: px.mask16Of(t.w, t.h, i => data[i]) }
      transfer = [value.scanlines.buffer]
      if (m.float) { value.data = data; transfer.push(data.buffer) }
    }
    else if (m.op === 'px.clipTensor') {
      stopped()
      if (!clipAlpha) throw new Error('The mask to clip with was not made')
      const t = built.tk.fromTensorFile(m.tensorFile)
      value = px.clipPlanar(t.c, t.w, t.h, t.data, clipAlpha, !!m.trunc)
      transfer = [value.px.buffer]
    }
    else if (m.op === 'px.clipBegin') {
      stopped()
      const r = px.clipBegin(m.l, m.mw, m.mh, m.w, m.h)
      clipAlpha = r.alpha
      // The float mask goes back only when asked for (it is handed on to an effect, R2.8 fix round 1).
      value = m.float ? { scanlines: r.scanlines, mask: r.mask } : { scanlines: r.scanlines }
      transfer = m.float ? [r.scanlines.buffer, r.mask.buffer] : [r.scanlines.buffer]
    }
    else if (m.op === 'px.clip') {
      stopped()
      if (!clipAlpha) throw new Error('The mask to clip with was not made')
      value = px.clip(m.picture, clipAlpha, !!m.trunc)
      transfer = [value.px.buffer]
    }
    // PIL's MaxFilter on an 8-bit greyscale mask (R3.7, ../pixels/maxFilter.ts).
    else if (m.op === 'px.maxFilter') {
      stopped()
      value = built.maxf.maxFilterL(m.l, m.w, m.h, m.size, isStopped)
      transfer = [value.buffer]
    }
    // Separate background and foreground (R3.7 fix round 1, ../pixels/pilPixels.ts): the cut-out's
    // alpha as PIL reads it, grown by MaxFilter(size) when size > 1; and a picture's RGB.
    else if (m.op === 'px.splitMask') {
      stopped()
      const l = built.pil.alphaOf(m.raw, isStopped)
      value = m.size > 1 ? built.maxf.maxFilterL(l, m.raw.width, m.raw.height, m.size, isStopped) : l
      transfer = [value.buffer]
    }
    else if (m.op === 'px.rgbOf') {
      stopped()
      value = built.pil.rgbOf(m.raw, isStopped)
      transfer = [value.buffer]
    }
    else if (m.op === 'px.save') {
      stopped()
      value = px.savePixels(m.picture, m.w, m.h, m.flatten, () => Atomics.load(stop, 0) === 1)
      transfer = [value.px.buffer]
    }
    // The effects (R2.1, ../effects/): one picture (or batch index) per fx.run.
    else if (m.op === 'fx.begin') {
      fx = { cls: m.cls, op: effectOp(m.fn), params: m.params, count: m.count, state: {} }
    }
    else if (m.op === 'fx.run') {
      stopped()
      if (!fx) throw new Error('The effect was not begun')
      const tk = built.tk
      const inputs = {}
      for (const name of Object.keys(m.inputs)) {
        const v = m.inputs[name]
        // A painter file (R2.8) is handed on as its 8-bit RGBA: Painter resizes it before any float.
        inputs[name] = v && v.mask16 ? tk.fromMask16(v.mask16, v.w, v.h)
          : v && v.tensorFile ? tk.fromTensorFile(v.tensorFile)
            : v && v.rgba8 ? v
              : tk.fromPicture(v, isStopped)
      }
      // A seeded effect (R2.9: Add noise): the sha256 of the float32 values the op receives, per batch index.
      if (m.hash) {
        const h = require('node:crypto').createHash('sha256')
        for (const name of Object.keys(inputs)) {
          const t = inputs[name]
          h.update(name + ':' + t.c + 'x' + t.h + 'x' + t.w + ';')
          h.update(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength))
        }
        if (!fx.state.inputHashes) fx.state.inputHashes = []
        fx.state.inputHashes[m.index] = h.digest('hex')
      }
      // A two-pass effect's first pass (R2.9): the op gathers or is hashed; nothing comes back.
      fx.state.gathering = !!m.gather
      // The batch's size too (R2.4): how torch split a long sum, and where its clamp kept a −0, depend on it.
      const r = fx.op(inputs, fx.params, isStopped, fx.state, m.index, fx.count)
      stopped()
      const outputs = []
      r.outputs.forEach((t, i) => {
        if (m.masks[i]) {
          const mask16 = tk.mask16(t)
          const o = { w: t.w, h: t.h, mask16 }
          transfer.push(mask16.buffer)
          // Read by an effect or a Frame: the float mask too (R2.8 fix round 1).
          if (m.want.f32 && m.want.f32[i]) { o.tensorFile = tk.tensorFileOf(t); transfer.push(o.tensorFile.buffer) }
          outputs.push(o)
          return
        }
        const o = { w: t.w, h: t.h, channels: t.c }
        if (m.want.round[i]) { o.round8 = tk.quantize(t, 'round', isStopped); transfer.push(o.round8.buffer) }
        if (m.want.trunc[i]) { o.trunc8 = tk.quantize(t, 'trunc', isStopped); transfer.push(o.trunc8.buffer) }
        if (m.want.f32 && m.want.f32[i]) { o.tensorFile = tk.tensorFileOf(t); transfer.push(o.tensorFile.buffer) }
        outputs.push(o)
      })
      value = { outputs }
      if (m.first) {
        const pt = r.preview || r.outputs[0]
        const p8 = tk.quantize(pt, 'trunc', isStopped)
        value.preview = { w: pt.w, h: pt.h, channels: pt.c, px: p8 }
        transfer.push(p8.buffer)
      }
    }
    else if (m.op === 'fx.end') fx = null
    else if (m.op === 'drop') { cv = null; clipAlpha = null; fx = null }
    parentPort.postMessage({ id: m.id, value }, transfer)
  }
  catch (e) {
    // A failed or stopped composite lets its canvas (and a clip its mask, an effect its state) go at once.
    cv = null
    clipAlpha = null
    fx = null
    parentPort.postMessage({ id: m.id, error: String((e && e.message) || e) })
  }
})
`
}

/** The longest one Frame may render before its worker is stopped. */
export const FRAME_RENDER_TIMEOUT_MS = 120_000
export const FRAME_TIMEOUT_MESSAGE = 'The Frame took longer than 2 minutes to render, so it was stopped'
/** The same limit for Blend scene's kept subject (the same worker and queue). */
export const KEEP_TIMEOUT_MESSAGE = 'Keeping the subject exact took longer than 2 minutes, so it was stopped'

/**
 * What the worker hands back: save_live_preview's 8-bit RGB pixels, and when
 * asked, the protect_mask as a 16-bit PNG's scanlines (plane.ts mask16Scanlines).
 */
export interface Preview8 { w: number; h: number; px: Uint8Array; mask?: Uint8Array }

interface Pending { resolve(v: unknown): void; reject(e: Error): void }
interface Thread { worker: Worker; stop: Int32Array; pending: Map<number, Pending>; seq: number; dead: string | null }

const g = globalThis as unknown as { __sailorFrameWorker?: Thread | null; __sailorFrameQueue?: Promise<unknown>; __sailorFrameTimeoutMs?: number }

function thread(): Thread {
  const live = g.__sailorFrameWorker
  if (live && !live.dead) return live
  const stopBuf = new SharedArrayBuffer(4)
  const worker = new Worker(workerScript(), { eval: true, workerData: { stop: stopBuf } })
  worker.unref()
  const t: Thread = { worker, stop: new Int32Array(stopBuf), pending: new Map(), seq: 0, dead: null }
  worker.on('message', (m: { id: number; value?: unknown; error?: string }) => {
    const p = t.pending.get(m.id)
    if (!p) return
    t.pending.delete(m.id)
    if (m.error !== undefined) p.reject(new Error(m.error))
    else p.resolve(m.value)
  })
  const die = (e: unknown) => {
    if (!t.dead) t.dead = `The Frame renderer stopped (${e instanceof Error ? e.message : String(e)})`
    if (g.__sailorFrameWorker === t) g.__sailorFrameWorker = null
    for (const p of t.pending.values()) p.reject(new Error(t.dead))
    t.pending.clear()
  }
  worker.on('error', die)
  worker.on('exit', code => die(new Error(`exit ${code}`)))
  g.__sailorFrameWorker = t
  return t
}

/** The buffers a picture can hand over; a view into a larger buffer is copied first. */
function handOver(p: Picture | null): { picture: Picture | null; buffers: ArrayBuffer[] } {
  if (!p) return { picture: null, buffers: [] }
  const d = p.data
  if (!d) return { picture: p, buffers: [] }
  const whole = d.byteOffset === 0 && d.byteLength === d.buffer.byteLength && !(d.buffer instanceof SharedArrayBuffer)
  const data = whole ? d : d.slice()
  return { picture: { ...p, data } as Picture, buffers: [data.buffer as ArrayBuffer] }
}

function call(t: Thread, msg: Record<string, unknown>, buffers: ArrayBuffer[]): Promise<unknown> {
  if (t.dead) return Promise.reject(new Error(t.dead))
  const id = ++t.seq
  return new Promise((resolve, reject) => {
    t.pending.set(id, { resolve, reject })
    t.worker.postMessage({ ...msg, id }, buffers)
  })
}

function workerBackend(t: Thread, protect: boolean): FrameBackend<Preview8> {
  return {
    async begin(ch, cw) { await call(t, { op: 'begin', ch, cw }, []) },
    async paint(image, mask, blend, copies, protectLayer) {
      const img = handOver(image)
      const m = handOver(mask)
      await call(t, { op: 'paint', image: img.picture, mask: m.picture, blend, copies, protect: protectLayer }, [...img.buffers, ...m.buffers])
    },
    async overlay(image, mask) {
      const img = handOver(image)
      const m = handOver(mask)
      await call(t, { op: 'overlay', image: img.picture, mask: m.picture }, [...img.buffers, ...m.buffers])
    },
    async finish() { return await call(t, { op: 'finish', protect }, []) as Preview8 },
  }
}

/**
 * One job on the worker, waiting its turn behind any other (one at a time),
 * with Stop (the shared flag) and the watchdog, whose message is `timeout`.
 * `live` (R1.6 fix round 1) is aborted by Stop, by the watchdog and once the
 * job's turn is over: a job whose turn ended (it failed or was stopped while
 * its own main-thread work went on) sees it and writes nothing more.
 */
function onWorker<T>(signal: AbortSignal | undefined, timeout: string, job: (t: Thread, live: AbortSignal) => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    if (signal?.aborted) throw new Error('Stopped')
    const t = thread()
    Atomics.store(t.stop, 0, 0)
    const live = new AbortController()
    const onAbort = () => { Atomics.store(t.stop, 0, 1); live.abort() }
    signal?.addEventListener('abort', onAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        live.abort()
        t.dead = timeout
        void t.worker.terminate()
        reject(new Error(timeout))
      }, g.__sailorFrameTimeoutMs ?? FRAME_RENDER_TIMEOUT_MS)
    })
    const work = job(t, live.signal)
    work.catch(() => {})
    try {
      return await Promise.race([work, watchdog])
    }
    catch (e) {
      // The worker lets the canvas go on its own errors; a failure on this side (a read, a Stop between layers) tells it to.
      if (!t.dead) void call(t, { op: 'drop' }, []).catch(() => {})
      throw e
    }
    finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      live.abort()
    }
  }
  const prev = g.__sailorFrameQueue ?? Promise.resolve()
  const next = prev.catch(() => {}).then(run)
  g.__sailorFrameQueue = next.catch(() => {})
  return next
}

export interface WorkerRenderOptions {
  signal?: AbortSignal
  /** The largest canvas (hosted: 4096²). */
  maxCanvasPixels?: number
  /**
   * Also make the protect_mask (a node reads the Frame's second output: Blend
   * scene's keep_subject, Task F11b). Off, the worker never builds it.
   */
  protect?: boolean
}

/**
 * `composeFrame` with the pixel work on the worker thread, waiting its turn
 * behind any other Frame. The protect_mask only when asked.
 */
export function renderFrameInWorker(inputs: Record<string, unknown>, loaders: FrameLoaders, opts: WorkerRenderOptions = {}): Promise<Preview8> {
  const protect = !!opts.protect
  return onWorker(opts.signal, FRAME_TIMEOUT_MESSAGE, t =>
    composeFrame(inputs, loaders, workerBackend(t, protect), { protect, signal: opts.signal, maxCanvasPixels: opts.maxCanvasPixels }))
}

/** Blend scene's kept subject: what the worker's `keep` takes (plane.ts keepSubject). */
export interface KeepJob {
  /** The picture Blend was given, as its source decodes it. */
  base: RawPicture
  /** The provider's answer, as the download decodes it (source provider). */
  edited: RawPicture
  /** The kept region: a 16-bit greyscale PNG's inflated scanlines, mw × mh. */
  mask: Uint8Array
  mw: number
  mh: number
  feather: number
}

/** `keepSubject` on the worker, in the Frame's queue: the 8-bit RGB result. */
export function keepSubjectInWorker(job: KeepJob, opts: { signal?: AbortSignal } = {}): Promise<Preview8> {
  return onWorker(opts.signal, KEEP_TIMEOUT_MESSAGE, async (t) => {
    const base = handOver(job.base)
    const edited = handOver(job.edited)
    const mask = job.mask.byteOffset === 0 && job.mask.byteLength === job.mask.buffer.byteLength ? job.mask : job.mask.slice()
    return await call(t, {
      op: 'keep', base: base.picture, edited: edited.picture, mask, mw: job.mw, mh: job.mh, feather: job.feather,
    }, [...base.buffers, ...edited.buffers, mask.buffer as ArrayBuffer]) as Preview8
  })
}

/** The longest one picture utility may take on the worker (the Frame's limit). */
export const PIXELS_TIMEOUT_MESSAGE = 'This card took longer than 2 minutes to work on its pictures, so it was stopped'
/** The same limit for an effect (R2.1). */
export const EFFECT_TIMEOUT_MESSAGE = 'This effect took longer than 2 minutes to work on its pictures, so it was stopped'

/** 16-bit mask scanlines (keep.ts maskPngFromScanlines encodes them), w × h. */
export interface MaskScanlines { w: number; h: number; scanlines: Uint8Array; data?: Float32Array }
/** 8-bit pixels as `_image_tensor_to_data_url` sends them, interleaved RGB or RGBA. */
export interface HandOff8 { w: number; h: number; channels: 3 | 4; px: Uint8Array }

/**
 * What a picture utility may ask of the worker (R1.4). Each picture is handed
 * over (transferred) and is gone from the caller afterwards.
 */
export interface PixelsWorker {
  /** ImageToMask: channel `index` of the picture's tensor as a mask. */
  channelMask(picture: RawPicture, index: number, float?: boolean): Promise<MaskScanlines>
  /** Text mask with a source: the render's luma as the mask, resized to w × h; kept on the worker for `clip`. `float`: the float32 mask back too. */
  clipBegin(l: Uint8Array, mw: number, mh: number, w: number, h: number, float?: boolean): Promise<{ scanlines: Uint8Array; mask?: Float32Array }>
  /** Image to mask of a picture an effect made: channel `index` of its kept float32 tensor (R2.8 fix round 2). */
  channelMaskTensor(tensorFile: Uint8Array, index: number, float?: boolean): Promise<MaskScanlines>
  /** Text mask with a source an effect made: its kept float32 tensor × (1 − mask) (R2.8 fix round 2). */
  clipTensor(tensorFile: Uint8Array, trunc?: boolean): Promise<HandOff8>
  /** Text mask with a source: one source picture × (1 − mask); `trunc`: quantised as save_images does (core.ts clip). */
  clip(picture: RawPicture, trunc?: boolean): Promise<HandOff8>
  /** PIL's MaxFilter(size) of an 8-bit greyscale mask, w × h, one byte a pixel (R3.7, ../pixels/maxFilter.ts). */
  maxFilter(l: Uint8Array, w: number, h: number, size: number): Promise<Uint8Array>
  /** Split's mask (R3.7 fix round 1): the alpha of PIL's convert("RGBA") of `raw`, then MaxFilter(size) when size > 1. */
  splitMask(raw: PilRaw, size: number): Promise<Uint8Array>
  /** A picture's RGB as PIL's convert("RGBA") has it, 3 bytes a pixel (R3.7 fix round 1). */
  rgbOf(raw: PilRaw): Promise<Uint8Array>
  /** Save image (R1.5): the pixels save_images encodes, w × h (Lanczos when that differs), flattened onto white for JPEG. */
  savePixels(picture: RawPicture, w: number, h: number, flatten: boolean): Promise<HandOff8>
  /** An effect (R2.1) starts its batch: `fn` its op ('<core>.<fn>'), `params` its widgets, `count` the batch's length. */
  effectBegin(job: { cls: string; fn: string; params: Record<string, unknown>; count: number }): Promise<void>
  /**
   * One picture (or batch index) of the effect: its inputs by name (pictures
   * as decoded, masks as a kept mask's scanlines), handed over. `masks`: which
   * outputs are masks; `want`: which 8-bit forms of each picture output.
   * `first`: also the live preview's pixels.
   */
  effectRun(job: EffectRunJob): Promise<EffectRunResult>
  effectEnd(): Promise<void>
  /** Aborted once this job's turn is over (Stop, the watchdog, or done): check before writing anything (R1.6 fix round 1). */
  live: AbortSignal
}

/** A mask handed to an effect: a kept 16-bit mask's inflated scanlines. */
export interface EffectMaskIn { mask16: Uint8Array; w: number; h: number }
/** A picture another effect made, as the float32 tensor it kept (effects/core/tensor.ts tensorFileOf). */
export interface EffectTensorIn { tensorFile: Uint8Array }
/** A painter file (R2.8), RGBA8 as decoded, handed to the op as it is (effects/core/mask.ts PainterFile). */
export interface EffectRawIn { rgba8: Uint8Array; w: number; h: number }

export interface EffectRunJob {
  index: number
  inputs: Record<string, PixelsPicture | EffectMaskIn | EffectTensorIn | EffectRawIn>
  first: boolean
  masks: boolean[]
  /** Which forms of each picture output: 8-bit round, 8-bit trunc, and the float32 tensor file (read by effects or Frames). */
  want: { round: boolean[]; trunc: boolean[]; f32: boolean[] }
  /** A two-pass effect's first pass (R2.9): the op gathers (or is hashed); it returns no outputs. */
  gather?: boolean
  /** Hash the float32 values the op receives for this index into its batch state (R2.9: Add noise's seed). */
  hash?: boolean
}

/** One output of an effect's run: a picture's 8-bit bytes (interleaved, its own channels) or a mask's scanlines. */
export type EffectOut = { w: number; h: number; channels: number; round8?: Uint8Array; trunc8?: Uint8Array; tensorFile?: Uint8Array } | { w: number; h: number; mask16: Uint8Array; tensorFile?: Uint8Array }

export interface EffectRunResult {
  outputs: EffectOut[]
  /** save_live_preview's pixels: trunc(f32(255·x)), interleaved, the preview tensor's own channels. */
  preview?: { w: number; h: number; channels: number; px: Uint8Array }
}

/** Raw samples the worker takes over (transferred): always a copy of its own (sharp's buffers can't be transferred). */
function ownRaw(raw: PilRaw): PilRaw {
  return { ...raw, data: raw.data.slice() }
}

/**
 * A picture utility's pixel work on the Frame's worker, in the same queue,
 * under the same watchdog and Stop: `job` decodes and encodes on this thread
 * and hands each picture's pixels to the worker, one at a time.
 */
export function pixelsInWorker<T>(signal: AbortSignal | undefined, job: (w: PixelsWorker) => Promise<T>, timeout: string = PIXELS_TIMEOUT_MESSAGE): Promise<T> {
  return onWorker(signal, timeout, async (t, live) => {
    const w: PixelsWorker = {
      live,
      async channelMask(picture, index, float = false) {
        const p = handOver(picture)
        return await call(t, { op: 'px.channel', picture: p.picture, index, float }, p.buffers) as MaskScanlines
      },
      async clipBegin(l, mw, mh, width, height, float = false) {
        const own = l.byteOffset === 0 && l.byteLength === l.buffer.byteLength ? l : l.slice()
        return await call(t, { op: 'px.clipBegin', l: own, mw, mh, w: width, h: height, float }, [own.buffer as ArrayBuffer]) as { scanlines: Uint8Array; mask?: Float32Array }
      },
      async channelMaskTensor(tensorFile, index, float = false) {
        const own = tensorFile.byteOffset === 0 && tensorFile.byteLength === tensorFile.buffer.byteLength && !(tensorFile.buffer instanceof SharedArrayBuffer) ? tensorFile : tensorFile.slice()
        return await call(t, { op: 'px.channelTensor', tensorFile: own, index, float }, [own.buffer as ArrayBuffer]) as MaskScanlines
      },
      async clipTensor(tensorFile, trunc = false) {
        const own = tensorFile.byteOffset === 0 && tensorFile.byteLength === tensorFile.buffer.byteLength && !(tensorFile.buffer instanceof SharedArrayBuffer) ? tensorFile : tensorFile.slice()
        return await call(t, { op: 'px.clipTensor', tensorFile: own, trunc }, [own.buffer as ArrayBuffer]) as HandOff8
      },
      async clip(picture, trunc = false) {
        const p = handOver(picture)
        return await call(t, { op: 'px.clip', picture: p.picture, trunc }, p.buffers) as HandOff8
      },
      async maxFilter(l, width, height, size) {
        const own = l.byteOffset === 0 && l.byteLength === l.buffer.byteLength && !(l.buffer instanceof SharedArrayBuffer) ? l : l.slice()
        return await call(t, { op: 'px.maxFilter', l: own, w: width, h: height, size }, [own.buffer as ArrayBuffer]) as Uint8Array
      },
      async splitMask(raw, size) {
        const r = ownRaw(raw)
        return await call(t, { op: 'px.splitMask', raw: r, size }, [r.data.buffer as ArrayBuffer]) as Uint8Array
      },
      async rgbOf(raw) {
        const r = ownRaw(raw)
        return await call(t, { op: 'px.rgbOf', raw: r }, [r.data.buffer as ArrayBuffer]) as Uint8Array
      },
      async savePixels(picture, width, height, flatten) {
        const p = handOver(picture)
        return await call(t, { op: 'px.save', picture: p.picture, w: width, h: height, flatten }, p.buffers) as HandOff8
      },
      async effectBegin(job) {
        await call(t, { op: 'fx.begin', cls: job.cls, fn: job.fn, params: job.params, count: job.count }, [])
      },
      async effectRun(job) {
        const inputs: Record<string, unknown> = {}
        const buffers: ArrayBuffer[] = []
        for (const [name, v] of Object.entries(job.inputs)) {
          if ('mask16' in v) {
            const own = v.mask16.byteOffset === 0 && v.mask16.byteLength === v.mask16.buffer.byteLength ? v.mask16 : v.mask16.slice()
            inputs[name] = { mask16: own, w: v.w, h: v.h }
            buffers.push(own.buffer as ArrayBuffer)
          }
          else if ('tensorFile' in v) {
            const b = v.tensorFile
            const own = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && !(b.buffer instanceof SharedArrayBuffer) ? b : b.slice()
            inputs[name] = { tensorFile: own }
            buffers.push(own.buffer as ArrayBuffer)
          }
          else if ('rgba8' in v) {
            const b = v.rgba8
            const own = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && !(b.buffer instanceof SharedArrayBuffer) ? b : b.slice()
            inputs[name] = { rgba8: own, w: v.w, h: v.h }
            buffers.push(own.buffer as ArrayBuffer)
          }
          else {
            const p = handOver(v as Picture)
            inputs[name] = p.picture
            buffers.push(...p.buffers)
          }
        }
        return await call(t, { op: 'fx.run', index: job.index, inputs, first: job.first, masks: job.masks, want: job.want, gather: !!job.gather, hash: !!job.hash }, buffers) as EffectRunResult
      },
      async effectEnd() {
        await call(t, { op: 'fx.end' }, [])
      },
    }
    try { return await job(w) }
    finally { if (!t.dead) void call(t, { op: 'drop' }, []).catch(() => {}) }
  })
}

/** Tests only: the worker thread, if one is running. */
export function __frameWorkerForTests(): Worker | null {
  return g.__sailorFrameWorker?.worker ?? null
}

/** Tests only: the watchdog's limit (null restores the 2 minutes). */
export function __setFrameTimeoutForTests(ms: number | null): void {
  g.__sailorFrameTimeoutMs = ms ?? undefined
}
