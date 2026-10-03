/**
 * Frame Animate's keying, off the server's main thread (LC10 fix round 1,
 * Medium 4): one worker thread per job, at most KEY_WORKERS_MAX at once
 * across the server (a job waits its turn). The worker runs the keyer's own
 * source text (`clipKeyCore.toString()`, self-contained by contract), so there
 * is no separate build entry, as the runner's compositor worker does
 * (server/runner/compositor/worker.ts). Frames go in and keyed RGBA comes
 * back as transferred buffers.
 *
 * Stop (`signal`) terminates the worker at once: every call still waiting
 * fails with MediaError('stopped'), and the slot is given back.
 */
import { Worker } from 'node:worker_threads'
import { MediaError } from '../media/run'
import { clipKeyCore, type RGB } from './clipKey'

export const KEY_WORKERS_MAX = 2

export function keyWorkerScript(coreFn: () => unknown = clipKeyCore): string {
  return `
const { parentPort } = require('node:worker_threads')
const __name = (f) => f
const ck = (${coreFn.toString()})()
let keyer = null
parentPort.on('message', (m) => {
  try {
    if (m.op === 'flatten') {
      const rgba = new Uint8Array(m.rgba)
      const keyHex = ck.pickKeyColour(rgba)
      const rgb = ck.flattenOnto(rgba, ck.fromHex(keyHex))
      parentPort.postMessage({ id: m.id, value: { keyHex, rgb: rgb.buffer } }, [rgb.buffer])
    }
    else if (m.op === 'init') {
      keyer = new ck.ClipKeyer(new Uint8Array(m.still), m.sw, m.sh, m.key, m.fw, m.fh)
      parentPort.postMessage({ id: m.id, value: { ow: keyer.ow, oh: keyer.oh } })
    }
    else if (m.op === 'key') {
      const out = keyer.keyFrame(new Uint8Array(m.frame))
      parentPort.postMessage({ id: m.id, value: out.buffer }, [out.buffer])
    }
    else throw new Error('unknown op')
  }
  catch (e) { parentPort.postMessage({ id: m.id, error: String((e && e.message) || e) }) }
})
`
}

// ── the global cap ──────────────────────────────────────────────────────────

let running = 0
const waiting: Array<{ go: () => void; signal?: AbortSignal; onAbort?: () => void }> = []

function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new MediaError('stopped'))
  if (running < KEY_WORKERS_MAX) { running++; return Promise.resolve() }
  return new Promise((resolve, reject) => {
    const w: (typeof waiting)[number] = { go: () => { running++; resolve() }, signal }
    w.onAbort = () => {
      const i = waiting.indexOf(w)
      if (i >= 0) waiting.splice(i, 1)
      reject(new MediaError('stopped'))
    }
    signal?.addEventListener('abort', w.onAbort, { once: true })
    waiting.push(w)
  })
}
function release(): void {
  running--
  const next = waiting.shift()
  if (next) {
    if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
    next.go()
  }
}

/** For tests: workers running now and jobs waiting for one. */
export function keyWorkers(): { running: number; waiting: number } {
  return { running, waiting: waiting.length }
}

// ── one job ─────────────────────────────────────────────────────────────────

/** A buffer of its own, safe to transfer (sharp's and Buffer's views may share a pool). */
const own = (a: Uint8Array): ArrayBuffer => (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength && a.buffer instanceof ArrayBuffer ? a.buffer : a.slice().buffer as ArrayBuffer)

export interface KeyWorker {
  flatten(rgba: Uint8Array): Promise<{ keyHex: string; rgb: Uint8Array }>
  init(still: Uint8Array, sw: number, sh: number, key: RGB, fw: number, fh: number): Promise<{ ow: number; oh: number }>
  /** One RGB frame (transferred: the caller must not use it after). */
  key(frame: Uint8Array): Promise<Uint8Array>
}

/** Runs `job` with a worker of its own, once a slot is free; the worker ends with the job, or at Stop. */
export async function withKeyWorker<T>(signal: AbortSignal | undefined, job: (w: KeyWorker) => Promise<T>): Promise<T> {
  await acquire(signal)
  const worker = new Worker(keyWorkerScript(), { eval: true })
  worker.unref()
  let nextId = 0
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>()
  let dead: unknown = null
  const failAll = (e: unknown) => {
    if (dead === null) dead = e
    for (const p of pending.values()) p.reject(dead)
    pending.clear()
  }
  worker.on('message', (m: { id: number; value?: unknown; error?: string }) => {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.error !== undefined) p.reject(new Error(m.error))
    else p.resolve(m.value)
  })
  worker.on('error', e => failAll(e))
  worker.on('exit', () => failAll(new MediaError(signal?.aborted ? 'stopped' : 'failed')))
  const onAbort = () => { failAll(new MediaError('stopped')); void worker.terminate() }
  signal?.addEventListener('abort', onAbort, { once: true })
  const call = (msg: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<any> => {
    if (dead !== null) return Promise.reject(dead)
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      worker.postMessage({ ...msg, id }, transfer)
    })
  }
  const kw: KeyWorker = {
    async flatten(rgba) {
      const buf = rgba.slice().buffer
      const v = await call({ op: 'flatten', rgba: buf }, [buf]) as { keyHex: string; rgb: ArrayBuffer }
      return { keyHex: v.keyHex, rgb: new Uint8Array(v.rgb) }
    },
    async init(still, sw, sh, key, fw, fh) {
      const buf = still.slice().buffer
      return call({ op: 'init', still: buf, sw, sh, key, fw, fh }, [buf])
    },
    async key(frame) {
      const buf = own(frame)
      return new Uint8Array(await call({ op: 'key', frame: buf }, [buf]) as ArrayBuffer)
    },
  }
  try {
    if (signal?.aborted) throw new MediaError('stopped')
    return await job(kw)
  }
  finally {
    signal?.removeEventListener('abort', onAbort)
    dead ??= new MediaError('failed')
    await worker.terminate()
    release()
  }
}
