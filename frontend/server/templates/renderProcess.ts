/**
 * satori (SVG), resvg (PNG) and the photo-treatment bake in a child process
 * (R1.6 fix round 2), not a thread: resvg's native render can't be
 * interrupted inside a thread, and a native panic or out-of-memory there
 * takes the whole server down. Here:
 *   - Stop (an abort) and the one-minute limit kill the child (SIGKILL): the
 *     native work ends at once and its memory goes back to the system;
 *   - a panic or out-of-memory kills only the child; the render fails plainly;
 *   - the next job waits for the killed child to exit before a new one starts
 *     (never two), spawned on demand; an idle child is kept for the next job.
 * One job at a time, in a queue.
 *
 * The child is `node -e <script>` with an IPC channel (structured clone, so
 * fonts and pictures travel as bytes). It imports the very modules the route
 * used (satori, @resvg/resvg-js, sharp), by the URLs this module resolves:
 * `import.meta.resolve` where the bundle keeps it, else require.resolve. The
 * bake is inlineImages.ts `bakeTreatmentCore`, run from its source text.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { bakeTreatmentCore } from './inlineImages'
import type { TreatmentBakeTag } from '../../shared/template-grid/treatment'

export const RENDER_TIMEOUT_MS = 60_000
export const RENDER_TIMEOUT = 'The layout took longer than a minute to render, so it was stopped'
export const RENDER_CRASHED = 'The layout renderer stopped while rendering this layout'

export interface RenderFont { name: string; data: ArrayBuffer; weight: 400 | 700; style: 'normal' }
export interface SvgJob { tree: unknown; width: number; height: number; fonts: RenderFont[] }

function script(): string {
  return `
const __name = (f) => f
const bake = (${bakeTreatmentCore.toString()})
const urls = JSON.parse(process.argv[1])
let mods = null
const load = async () => {
  if (mods) return mods
  const s = await import(urls.satori)
  const r = await import(urls.resvg)
  const sh = await import(urls.sharp)
  mods = {
    satori: typeof s.default === 'function' ? s.default : (s.default && s.default.default) || s.satori,
    Resvg: r.Resvg || (r.default && r.default.Resvg),
    sharp: typeof sh.default === 'function' ? sh.default : sh,
  }
  return mods
}
process.on('disconnect', () => process.exit(0))
process.on('message', async (m) => {
  try {
    const { satori, Resvg, sharp } = await load()
    let out
    if (m.op === 'render') {
      const svg = await satori(m.tree, { width: m.width, height: m.height, fonts: m.fonts })
      out = new Uint8Array(new Resvg(svg, { fitTo: { mode: 'original' } }).render().asPng())
    }
    else if (m.op === 'bake') out = new Uint8Array(await bake(sharp, m.data, m.treatment))
    else if (m.op === 'ping') out = new Uint8Array(0)
    else throw new Error('unknown job')
    process.send({ id: m.id, out })
  }
  catch (e) {
    process.send({ id: m.id, error: String((e && e.message) || e) })
  }
})
`
}

function moduleUrl(name: string): string {
  const meta = import.meta as unknown as { resolve?: (s: string) => string }
  try {
    if (typeof meta.resolve === 'function') return meta.resolve(name)
  }
  catch { /* fall back to require's resolution */ }
  return pathToFileURL(createRequire(import.meta.url).resolve(name)).href
}

interface Child { proc: ChildProcess; exited: Promise<void>; pending: Map<number, { resolve(v: Uint8Array): void; reject(e: Error): void }>; seq: number; dead: string | null }
type Spawn = typeof spawn
const g = globalThis as unknown as {
  __sailorRenderChild?: Child | null; __sailorRenderQueue?: Promise<unknown>; __sailorRenderTimeoutMs?: number
  __sailorRenderLastExit?: Promise<void>; __sailorRenderJobs?: number; __sailorRenderSpawn?: Spawn | null
}

/** The longest a new child waits for a killed one to be gone before it starts anyway. */
export const CHILD_EXIT_WAIT_MS = 5_000

/**
 * The child's environment (fix round 3): only what node needs to run and
 * find its temp folder. No API keys or secrets: the child parses untrusted
 * fonts, pictures and SVG with native code.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SystemRoot', 'windir']) {
    if (env[k] !== undefined) out[k] = env[k]
  }
  return out
}

function child(): Child {
  const live = g.__sailorRenderChild
  if (live && !live.dead) return live
  const urls = { satori: moduleUrl('satori'), resvg: moduleUrl('@resvg/resvg-js'), sharp: moduleUrl('sharp') }
  const proc = (g.__sailorRenderSpawn ?? spawn)(process.execPath, ['-e', script(), JSON.stringify(urls)], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced', env: childEnv(),
  })
  // A spawn that fails (EMFILE, EAGAIN) gives 'error' and never 'exit': either ends it.
  const exited = new Promise<void>((r) => {
    proc.once('exit', () => r())
    proc.once('error', () => r())
  })
  const c: Child = { proc, exited, pending: new Map(), seq: 0, dead: null }
  proc.on('message', (m: { id: number; out?: Uint8Array; error?: string }) => {
    const p = c.pending.get(m.id)
    if (!p) return
    c.pending.delete(m.id)
    if (m.error !== undefined) p.reject(new Error(m.error))
    else p.resolve(m.out!)
  })
  const die = (why: string) => {
    if (!c.dead) c.dead = why
    if (g.__sailorRenderChild === c) g.__sailorRenderChild = null
    for (const p of c.pending.values()) p.reject(new Error(c.dead))
    c.pending.clear()
  }
  proc.on('error', () => die(RENDER_CRASHED))
  proc.on('exit', () => die(RENDER_CRASHED))
  idle(c)
  g.__sailorRenderChild = c
  g.__sailorRenderLastExit = c.exited
  return c
}

/** An idle child doesn't keep the server (or a test run) alive; a busy one does. */
function idle(c: Child): void {
  c.proc.unref?.()
  ;(c.proc.channel as unknown as { unref?(): void } | undefined)?.unref?.()
}
function busy(c: Child): void {
  c.proc.ref?.()
  ;(c.proc.channel as unknown as { ref?(): void } | undefined)?.ref?.()
}

/** One job on the child, waiting its turn; killed (SIGKILL) past the limit or on abort. */
function onChild(msg: Record<string, unknown>, signal?: AbortSignal): Promise<Uint8Array> {
  const run = async (): Promise<Uint8Array> => {
    if (signal?.aborted) throw new Error(stopWords(signal))
    // Never two children: a killed one is gone before the next starts — but
    // never waiting on it for ever (a child that never exits must not wedge the queue).
    if (!g.__sailorRenderChild && g.__sailorRenderLastExit) {
      let t: ReturnType<typeof setTimeout> | undefined
      await Promise.race([g.__sailorRenderLastExit, new Promise<void>((r) => { t = setTimeout(r, CHILD_EXIT_WAIT_MS) })])
      clearTimeout(t)
    }
    if (signal?.aborted) throw new Error(stopWords(signal))
    let c: Child
    try { c = child() }
    catch { throw new Error(RENDER_CRASHED) }
    const id = ++c.seq
    g.__sailorRenderJobs = (g.__sailorRenderJobs ?? 0) + 1
    return new Promise<Uint8Array>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const kill = (why: string) => {
        c.dead = why
        try { c.proc.kill('SIGKILL') }
        catch { /* already gone */ }
      }
      const onAbort = () => kill(stopWords(signal!))
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (!c.dead) idle(c)
      }
      c.pending.set(id, { resolve: (v) => { done(); resolve(v) }, reject: (e) => { done(); reject(e) } })
      timer = setTimeout(() => kill(RENDER_TIMEOUT), g.__sailorRenderTimeoutMs ?? RENDER_TIMEOUT_MS)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        if (c.dead) throw new Error(c.dead)
        if (typeof c.proc.send !== 'function') throw new Error(RENDER_CRASHED)
        busy(c)
        c.proc.send({ ...msg, id })
      }
      catch {
        c.pending.delete(id)
        kill(RENDER_CRASHED)
        done()
        reject(new Error(RENDER_CRASHED))
      }
    })
  }
  const prev = g.__sailorRenderQueue ?? Promise.resolve()
  const next = prev.catch(() => {}).then(run)
  g.__sailorRenderQueue = next.catch(() => {})
  return whileWaiting(next, signal)
}

/** The words for an abort: the render's own deadline, or Stop. */
function stopWords(signal: AbortSignal): string {
  const r = signal.reason as { name?: string } | undefined
  return r?.name === 'TimeoutError' ? RENDER_TIMEOUT : 'Stopped'
}

/** A job still waiting its turn rejects as soon as its signal aborts (its turn then does nothing). */
function whileWaiting<T>(job: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return job
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(stopWords(signal)))
    if (signal.aborted) onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    job.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** satori then resvg for one translated layout, in the render process. */
export function svgToPngInProcess(job: SvgJob, signal?: AbortSignal): Promise<Uint8Array> {
  return onChild({ op: 'render', tree: job.tree, width: job.width, height: job.height, fonts: job.fonts }, signal)
}

/** inlineImages' photo-treatment bake, in the render process. */
export async function bakeInProcess(data: ArrayBuffer, treatment: TreatmentBakeTag, signal?: AbortSignal): Promise<ArrayBuffer> {
  const out = await onChild({ op: 'bake', data, treatment }, signal)
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
}

/** Tests only: the render limit (null restores a minute). */
export function __setRenderTimeoutForTests(ms: number | null): void {
  g.__sailorRenderTimeoutMs = ms ?? undefined
}

/** Tests only: the spawn the render process is started with (null restores node's). */
export function __setRenderSpawnForTests(fn: Spawn | null): void {
  g.__sailorRenderSpawn = fn
}

/** Tests only: how many jobs the render process has been given. */
export function __renderJobsForTests(): number {
  return g.__sailorRenderJobs ?? 0
}

/** Tests only: the render process's pid, if one is running. */
export function __renderChildPidForTests(): number | null {
  const c = g.__sailorRenderChild
  return c && !c.dead ? c.proc.pid ?? null : null
}
