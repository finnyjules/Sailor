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
import { pixelsCore } from '../pixels/core'

/**
 * The worker's script around a core function's source text. `__name` is
 * esbuild's keepNames helper: a no-op here, so a build with keepNames on
 * (unminified) still runs. Nitro builds with neither keepNames nor a helper
 * (target es2019); the esbuild guard in the engine spec checks both minified
 * and not.
 */
export function workerScript(coreFn: () => unknown = compositorCore, pixelsFn: () => unknown = pixelsCore): string {
  return `
const { parentPort, workerData } = require('node:worker_threads')
const __name = (f) => f
const core = (${coreFn.toString()})()
const px = (${pixelsFn.toString()})()
const stop = new Int32Array(workerData.stop)
const stopped = () => { if (Atomics.load(stop, 0) === 1) throw new Error('Stopped') }
let cv = null
let clipAlpha = null
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
      value = px.channelMask16(m.picture, m.index)
      transfer = [value.scanlines.buffer]
    }
    else if (m.op === 'px.clipBegin') {
      stopped()
      const r = px.clipBegin(m.l, m.mw, m.mh, m.w, m.h)
      clipAlpha = r.alpha
      value = { scanlines: r.scanlines }
      transfer = [r.scanlines.buffer]
    }
    else if (m.op === 'px.clip') {
      stopped()
      if (!clipAlpha) throw new Error('The mask to clip with was not made')
      value = px.clip(m.picture, clipAlpha, !!m.trunc)
      transfer = [value.px.buffer]
    }
    else if (m.op === 'px.save') {
      stopped()
      value = px.savePixels(m.picture, m.w, m.h, m.flatten, () => Atomics.load(stop, 0) === 1)
      transfer = [value.px.buffer]
    }
    else if (m.op === 'drop') { cv = null; clipAlpha = null }
    parentPort.postMessage({ id: m.id, value }, transfer)
  }
  catch (e) {
    // A failed or stopped composite lets its canvas (and a clip its mask) go at once.
    cv = null
    clipAlpha = null
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

/** 16-bit mask scanlines (keep.ts maskPngFromScanlines encodes them), w × h. */
export interface MaskScanlines { w: number; h: number; scanlines: Uint8Array }
/** 8-bit pixels as `_image_tensor_to_data_url` sends them, interleaved RGB or RGBA. */
export interface HandOff8 { w: number; h: number; channels: 3 | 4; px: Uint8Array }

/**
 * What a picture utility may ask of the worker (R1.4). Each picture is handed
 * over (transferred) and is gone from the caller afterwards.
 */
export interface PixelsWorker {
  /** ImageToMask: channel `index` of the picture's tensor as a mask. */
  channelMask(picture: RawPicture, index: number): Promise<MaskScanlines>
  /** Text mask with a source: the render's luma as the mask, resized to w × h; kept on the worker for `clip`. */
  clipBegin(l: Uint8Array, mw: number, mh: number, w: number, h: number): Promise<Uint8Array>
  /** Text mask with a source: one source picture × (1 − mask); `trunc`: quantised as save_images does (core.ts clip). */
  clip(picture: RawPicture, trunc?: boolean): Promise<HandOff8>
  /** Save image (R1.5): the pixels save_images encodes, w × h (Lanczos when that differs), flattened onto white for JPEG. */
  savePixels(picture: RawPicture, w: number, h: number, flatten: boolean): Promise<HandOff8>
  /** Aborted once this job's turn is over (Stop, the watchdog, or done): check before writing anything (R1.6 fix round 1). */
  live: AbortSignal
}

/**
 * A picture utility's pixel work on the Frame's worker, in the same queue,
 * under the same watchdog and Stop: `job` decodes and encodes on this thread
 * and hands each picture's pixels to the worker, one at a time.
 */
export function pixelsInWorker<T>(signal: AbortSignal | undefined, job: (w: PixelsWorker) => Promise<T>): Promise<T> {
  return onWorker(signal, PIXELS_TIMEOUT_MESSAGE, async (t, live) => {
    const w: PixelsWorker = {
      live,
      async channelMask(picture, index) {
        const p = handOver(picture)
        return await call(t, { op: 'px.channel', picture: p.picture, index }, p.buffers) as MaskScanlines
      },
      async clipBegin(l, mw, mh, width, height) {
        const own = l.byteOffset === 0 && l.byteLength === l.buffer.byteLength ? l : l.slice()
        return (await call(t, { op: 'px.clipBegin', l: own, mw, mh, w: width, h: height }, [own.buffer as ArrayBuffer]) as { scanlines: Uint8Array }).scanlines
      },
      async clip(picture, trunc = false) {
        const p = handOver(picture)
        return await call(t, { op: 'px.clip', picture: p.picture, trunc }, p.buffers) as HandOff8
      },
      async savePixels(picture, width, height, flatten) {
        const p = handOver(picture)
        return await call(t, { op: 'px.save', picture: p.picture, w: width, h: height, flatten }, p.buffers) as HandOff8
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
