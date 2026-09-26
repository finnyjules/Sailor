/**
 * satori (SVG) and resvg (PNG) off the server's main thread (R1.6 fix round
 * 1): one worker thread per process, one render at a time (a queue), created
 * on first use and unref'd. A render that takes longer than a minute (Python
 * gave the route 60 seconds) terminates the worker and fails plainly; an
 * abort (Stop, or the runner's own watchdog) terminates it too. The next
 * render starts a fresh worker.
 *
 * The worker loads the very modules the route imported: their locations are
 * resolved here (import.meta.resolve where the bundle keeps it, else
 * require.resolve) and imported by the worker, so the same code and the
 * same fonts give the same bytes.
 */
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const RENDER_TIMEOUT_MS = 60_000
export const RENDER_TIMEOUT = 'The layout took longer than a minute to render, so it was stopped'

export interface WorkerFont { name: string; data: ArrayBuffer; weight: 400 | 700; style: 'normal' }
export interface SvgJob { tree: unknown; width: number; height: number; fonts: WorkerFont[] }

const SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads')
let mods = null
const load = async () => {
  if (mods) return mods
  const s = await import(workerData.satori)
  const r = await import(workerData.resvg)
  const satori = typeof s.default === 'function' ? s.default : (s.default && s.default.default) || s.satori
  const Resvg = r.Resvg || (r.default && r.default.Resvg)
  mods = { satori, Resvg }
  return mods
}
parentPort.on('message', async (m) => {
  try {
    const { satori, Resvg } = await load()
    const svg = await satori(m.tree, { width: m.width, height: m.height, fonts: m.fonts })
    const png = new Resvg(svg, { fitTo: { mode: 'original' } }).render().asPng()
    const out = new Uint8Array(png.length)
    out.set(png)
    parentPort.postMessage({ id: m.id, png: out }, [out.buffer])
  }
  catch (e) {
    parentPort.postMessage({ id: m.id, error: String((e && e.message) || e) })
  }
})
`

function moduleUrl(name: string): string {
  const meta = import.meta as unknown as { resolve?: (s: string) => string }
  try {
    if (typeof meta.resolve === 'function') return meta.resolve(name)
  }
  catch { /* fall back to require's resolution */ }
  return pathToFileURL(createRequire(import.meta.url).resolve(name)).href
}

interface Thread { worker: Worker; pending: Map<number, { resolve(v: Uint8Array): void; reject(e: Error): void }>; seq: number; dead: string | null }
const g = globalThis as unknown as { __sailorSvgWorker?: Thread | null; __sailorSvgQueue?: Promise<unknown>; __sailorSvgTimeoutMs?: number }

function thread(): Thread {
  const live = g.__sailorSvgWorker
  if (live && !live.dead) return live
  const worker = new Worker(SCRIPT, { eval: true, workerData: { satori: moduleUrl('satori'), resvg: moduleUrl('@resvg/resvg-js') } })
  worker.unref()
  const t: Thread = { worker, pending: new Map(), seq: 0, dead: null }
  worker.on('message', (m: { id: number; png?: Uint8Array; error?: string }) => {
    const p = t.pending.get(m.id)
    if (!p) return
    t.pending.delete(m.id)
    if (m.error !== undefined) p.reject(new Error(m.error))
    else p.resolve(m.png!)
  })
  const die = (why: string) => {
    if (!t.dead) t.dead = why
    if (g.__sailorSvgWorker === t) g.__sailorSvgWorker = null
    for (const p of t.pending.values()) p.reject(new Error(t.dead))
    t.pending.clear()
  }
  worker.on('error', e => die(`The layout renderer stopped (${e.message})`))
  worker.on('exit', code => die(`The layout renderer stopped (exit ${code})`))
  g.__sailorSvgWorker = t
  return t
}

/**
 * satori then resvg for one translated layout, on the worker, waiting its
 * turn. Rejects with RENDER_TIMEOUT past the limit and 'Stopped' on abort,
 * the worker terminated either way.
 */
export function svgToPngInWorker(job: SvgJob, signal?: AbortSignal): Promise<Uint8Array> {
  const run = (): Promise<Uint8Array> => {
    if (signal?.aborted) return Promise.reject(new Error('Stopped'))
    const t = thread()
    const id = ++t.seq
    return new Promise<Uint8Array>((resolve, reject) => {
      const kill = (why: string) => {
        t.dead = why
        void t.worker.terminate()
        reject(new Error(why))
      }
      const timer = setTimeout(() => kill(RENDER_TIMEOUT), g.__sailorSvgTimeoutMs ?? RENDER_TIMEOUT_MS)
      const onAbort = () => kill('Stopped')
      signal?.addEventListener('abort', onAbort, { once: true })
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
      t.pending.set(id, { resolve: (v) => { done(); resolve(v) }, reject: (e) => { done(); reject(e) } })
      t.worker.postMessage({ id, tree: job.tree, width: job.width, height: job.height, fonts: job.fonts })
    })
  }
  const prev = g.__sailorSvgQueue ?? Promise.resolve()
  const next = prev.catch(() => {}).then(run)
  g.__sailorSvgQueue = next.catch(() => {})
  return next
}

/** Tests only: the render limit (null restores a minute). */
export function __setSvgTimeoutForTests(ms: number | null): void {
  g.__sailorSvgTimeoutMs = ms ?? undefined
}
