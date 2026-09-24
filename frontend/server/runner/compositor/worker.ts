/**
 * The Frame's pixel work, off the server's main thread: one worker thread per
 * process, one composite at a time (a queue), created on first use and
 * unref'd so it never keeps the process alive.
 *
 * The worker runs the very same `compositorCore` the parity spec checks: its
 * source text (`compositorCore.toString()`) is the worker's script, because
 * the function is self-contained by contract (plane.ts). No separate build
 * entry, so it works the same under vitest and in the Nitro bundle.
 *
 * Stop: the engine's abort signal sets a shared flag the core reads before
 * every copy, and `composeFrame` checks the signal between layers.
 */
import { Worker } from 'node:worker_threads'
import { compositorCore, type Plane } from './plane'
import { composeFrame, type FrameBackend, type FrameLoaders, type FrameResult } from './render'

const SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads')
const core = (${compositorCore.toString()})()
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
      value = core.finish(cv)
      cv = null
      transfer = [value.image.data.buffer, value.protect.data.buffer]
    }
    parentPort.postMessage({ id: m.id, value }, transfer)
  }
  catch (e) {
    parentPort.postMessage({ id: m.id, error: String((e && e.message) || e) })
  }
})
`

interface Pending { resolve(v: unknown): void; reject(e: Error): void }
interface Thread { worker: Worker; stop: Int32Array; pending: Map<number, Pending>; seq: number }

const g = globalThis as unknown as { __sailorFrameWorker?: Thread | null; __sailorFrameQueue?: Promise<unknown> }

function thread(): Thread {
  if (g.__sailorFrameWorker) return g.__sailorFrameWorker
  const stopBuf = new SharedArrayBuffer(4)
  const worker = new Worker(SCRIPT, { eval: true, workerData: { stop: stopBuf } })
  worker.unref()
  const t: Thread = { worker, stop: new Int32Array(stopBuf), pending: new Map(), seq: 0 }
  worker.on('message', (m: { id: number; value?: unknown; error?: string }) => {
    const p = t.pending.get(m.id)
    if (!p) return
    t.pending.delete(m.id)
    if (m.error !== undefined) p.reject(new Error(m.error))
    else p.resolve(m.value)
  })
  const die = (e: unknown) => {
    if (g.__sailorFrameWorker === t) g.__sailorFrameWorker = null
    for (const p of t.pending.values()) p.reject(new Error(`The Frame renderer stopped (${e instanceof Error ? e.message : String(e)})`))
    t.pending.clear()
  }
  worker.on('error', die)
  worker.on('exit', code => die(new Error(`exit ${code}`)))
  g.__sailorFrameWorker = t
  return t
}

/** A plane whose buffer can be handed over (a view into a larger buffer is copied first). */
function owned(p: Plane): Plane {
  const d = p.data
  return d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? p : { ...p, data: d.slice() }
}

function call(t: Thread, msg: Record<string, unknown>, planes: Plane[]): Promise<unknown> {
  const id = ++t.seq
  return new Promise((resolve, reject) => {
    t.pending.set(id, { resolve, reject })
    t.worker.postMessage({ ...msg, id }, planes.map(p => p.data.buffer as ArrayBuffer))
  })
}

function workerBackend(t: Thread): FrameBackend {
  return {
    async begin(ch, cw) { await call(t, { op: 'begin', ch, cw }, []) },
    async paint(image, mask, blend, copies, protect) {
      const img = owned(image)
      const m = mask ? owned(mask) : null
      await call(t, { op: 'paint', image: img, mask: m, blend, copies, protect }, m ? [img, m] : [img])
    },
    async overlay(image, mask) {
      const img = owned(image)
      const m = mask ? owned(mask) : null
      await call(t, { op: 'overlay', image: img, mask: m }, m ? [img, m] : [img])
    },
    async finish() { return await call(t, { op: 'finish' }, []) as FrameResult },
  }
}

/**
 * `composeFrame` with the pixel work on the worker thread, waiting its turn
 * behind any other Frame. No protect_mask (the runner never reads it).
 */
export function renderFrameInWorker(inputs: Record<string, unknown>, loaders: FrameLoaders, signal?: AbortSignal): Promise<FrameResult> {
  const run = async (): Promise<FrameResult> => {
    if (signal?.aborted) throw new Error('Stopped')
    const t = thread()
    Atomics.store(t.stop, 0, 0)
    const onAbort = () => Atomics.store(t.stop, 0, 1)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await composeFrame(inputs, loaders, workerBackend(t), { protect: false, signal })
    }
    finally {
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
