/**
 * The Frame's pixel work, off the server's main thread: one worker thread per
 * process, one composite at a time (a queue), created on first use and
 * unref'd so it never keeps the process alive.
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
import { compositorCore, type Picture } from './plane'
import { composeFrame, type FrameBackend, type FrameLoaders } from './render'

/**
 * The worker's script around a core function's source text. `__name` is
 * esbuild's keepNames helper: a no-op here, so a build with keepNames on
 * (unminified) still runs. Nitro builds with neither keepNames nor a helper
 * (target es2019); the esbuild guard in the engine spec checks both minified
 * and not.
 */
export function workerScript(coreFn: () => unknown = compositorCore): string {
  return `
const { parentPort, workerData } = require('node:worker_threads')
const __name = (f) => f
const core = (${coreFn.toString()})()
const stop = new Int32Array(workerData.stop)
let cv = null
parentPort.on('message', (m) => {
  try {
    let value = null
    let transfer = []
    if (m.op === 'begin') cv = core.createCanvas(m.ch, m.cw)
    else if (m.op === 'paint') core.paint(cv, m.image, m.mask, m.blend, m.copies, m.protect, () => Atomics.load(stop, 0) === 1)
    else if (m.op === 'overlay') core.overlay(cv, m.image, m.mask)
    else if (m.op === 'finish') {
      const r = core.finish(cv, false)
      cv = null
      const px = core.toPreview8(r.image)
      value = { w: r.image.w, h: r.image.h, px }
      transfer = [px.buffer]
    }
    else if (m.op === 'drop') cv = null
    parentPort.postMessage({ id: m.id, value }, transfer)
  }
  catch (e) {
    // A failed or stopped composite lets its canvas go at once.
    cv = null
    parentPort.postMessage({ id: m.id, error: String((e && e.message) || e) })
  }
})
`
}

/** The longest one Frame may render before its worker is stopped. */
export const FRAME_RENDER_TIMEOUT_MS = 120_000
export const FRAME_TIMEOUT_MESSAGE = 'The Frame took longer than 2 minutes to render, so it was stopped'

/** What the worker hands back: save_live_preview's 8-bit RGB pixels. */
export interface Preview8 { w: number; h: number; px: Uint8Array }

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

function workerBackend(t: Thread): FrameBackend<Preview8> {
  return {
    async begin(ch, cw) { await call(t, { op: 'begin', ch, cw }, []) },
    async paint(image, mask, blend, copies, protect) {
      const img = handOver(image)
      const m = handOver(mask)
      await call(t, { op: 'paint', image: img.picture, mask: m.picture, blend, copies, protect }, [...img.buffers, ...m.buffers])
    },
    async overlay(image, mask) {
      const img = handOver(image)
      const m = handOver(mask)
      await call(t, { op: 'overlay', image: img.picture, mask: m.picture }, [...img.buffers, ...m.buffers])
    },
    async finish() { return await call(t, { op: 'finish' }, []) as Preview8 },
  }
}

export interface WorkerRenderOptions {
  signal?: AbortSignal
  /** The largest canvas (hosted: 4096²). */
  maxCanvasPixels?: number
}

/**
 * `composeFrame` with the pixel work on the worker thread, waiting its turn
 * behind any other Frame. No protect_mask (the runner never reads it).
 */
export function renderFrameInWorker(inputs: Record<string, unknown>, loaders: FrameLoaders, opts: WorkerRenderOptions = {}): Promise<Preview8> {
  const { signal } = opts
  const run = async (): Promise<Preview8> => {
    if (signal?.aborted) throw new Error('Stopped')
    const t = thread()
    Atomics.store(t.stop, 0, 0)
    const onAbort = () => Atomics.store(t.stop, 0, 1)
    signal?.addEventListener('abort', onAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        t.dead = FRAME_TIMEOUT_MESSAGE
        void t.worker.terminate()
        reject(new Error(FRAME_TIMEOUT_MESSAGE))
      }, g.__sailorFrameTimeoutMs ?? FRAME_RENDER_TIMEOUT_MS)
    })
    const work = composeFrame(inputs, loaders, workerBackend(t), { protect: false, signal, maxCanvasPixels: opts.maxCanvasPixels })
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
    }
  }
  const prev = g.__sailorFrameQueue ?? Promise.resolve()
  const next = prev.catch(() => {}).then(run)
  g.__sailorFrameQueue = next.catch(() => {})
  return next
}

/** Tests only: the worker thread, if one is running. */
export function __frameWorkerForTests(): Worker | null {
  return g.__sailorFrameWorker?.worker ?? null
}

/** Tests only: the watchdog's limit (null restores the 2 minutes). */
export function __setFrameTimeoutForTests(ms: number | null): void {
  g.__sailorFrameTimeoutMs = ms ?? undefined
}
