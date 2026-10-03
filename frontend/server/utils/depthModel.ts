/**
 * Depth Anything V2 Small, in-process (transformers.js on onnxruntime-node):
 * one loader shared by POST /api/depth/estimate and the runner's Lens · Depth
 * of field (step 3, R7.9). The model loads once and stays warm.
 *
 * The files (USER ruling (l), R7.9): `onnx-community/depth-anything-v2-small`
 * at revision DEPTH_MODEL_REVISION, the fp32 ONNX export of the same weights
 * ComfyUI's _depth.py runs (`depth-anything/Depth-Anything-V2-Small-hf`):
 * config.json, preprocessor_config.json and onnx/model.onnx (99,060,839
 * bytes), 99.1 MB in all, each pinned by its sha256 (DEPTH_MODEL_FILES).
 *   - Hosted: they ship in the image (Dockerfile, stage `depth-model`, checked
 *     against these sha256s at build time) under NUXT_DEPTH_MODEL_DIR, and
 *     are NEVER fetched at run time (`allowRemoteModels` off).
 *   - Locally: read from NUXT_DEPTH_MODEL_DIR when set, else from
 *     transformers.js's own cache (node_modules/@huggingface/transformers/.cache).
 *     A missing or short file is fetched into that folder by Sailor itself
 *     (`fillDepthModel`, step 3 R10.5) at the pinned revision and checked
 *     against its sha256 before it is used, the first time the depth model
 *     is asked for (the depth route, POST /api/depth/estimate). It is the only
 *     model Sailor still keeps on disk: the Toolbox and Settings no longer
 *     download any (R10.5).
 *
 * `depthModelReady()` says whether the files are on disk where the loader
 * reads them (the runner takes Lens · Depth of field only then:
 * server/runner/config.ts).
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isHosted } from './deployMode'

export const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small'
/** The model repository's commit the files were read from (huggingface.co API, 2026-10-01). */
export const DEPTH_MODEL_REVISION = '4472b7362082ad9968fee890ca0f1e5aca36b93d'
/** Every file the loader reads, with its size and sha256 (the Dockerfile checks the same). */
export const DEPTH_MODEL_FILES: readonly { path: string; bytes: number; sha256: string }[] = [
  { path: 'config.json', bytes: 38, sha256: '3aee5b9bc4f711ee885c2526d871f0c8c6c8c4b26b8e04253d0167f6a83264f5' },
  { path: 'preprocessor_config.json', bytes: 461, sha256: '03576db3c13dd0471fdf5f5e1428befcb95de063fe699879150b293dc9e0a2c6' },
  { path: 'onnx/model.onnx', bytes: 99_060_839, sha256: 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c' },
]

/**
 * The longest side handed to the model. Its processor scales a picture so
 * the side nearer 518 lands on 518 (DPT, keep_aspect_ratio), so a long thin
 * picture would reach it thousands of pixels long (and its attention grows
 * with the square of that). A picture is first shrunk to fit 518 × 518: the
 * model then never sees more than 37 × 37 patches. The depth only needs to
 * look right (R7.9, ruling (l)).
 */
export const DEPTH_MODEL_MAX_SIDE = 518

/** transformers.js's own cache folder (where its first download lands), or null when the package can't be found. */
function libraryCacheDir(): string | null {
  try {
    const entry = createRequire(join(process.cwd(), 'noop.js')).resolve('@huggingface/transformers')
    return join(dirname(dirname(entry)), '.cache')
  }
  catch { return null }
}

/** The folder the model's files are read from: `<dir>/onnx-community/depth-anything-v2-small/…`. */
export function depthModelDir(): string | null {
  const own = process.env.NUXT_DEPTH_MODEL_DIR?.trim()
  return own || libraryCacheDir()
}

let readyAt: string | null = null

/** Whether every model file is on disk, at its size, where the loader reads it. */
export function depthModelReady(): boolean {
  const dir = depthModelDir()
  if (!dir) return false
  if (readyAt === dir) return true
  const ok = DEPTH_MODEL_FILES.every((f) => {
    const p = join(dir, DEPTH_MODEL, f.path)
    try { return existsSync(p) && statSync(p).size === f.bytes }
    catch { return false }
  })
  if (ok) readyAt = dir
  return ok
}

/** Where one model file is fetched from: the pinned revision, never `main`. */
export function depthModelFileUrl(path: string): string {
  return `https://huggingface.co/${DEPTH_MODEL}/resolve/${DEPTH_MODEL_REVISION}/${path}`
}

/** No bytes for this long: the download has stalled and is given up. */
export const DEPTH_FILL_STALL_MS = 30_000
/** The whole download (99.1 MB) may take at most this long. */
export const DEPTH_FILL_OVERALL_MS = 15 * 60_000
/** A `*.part` older than this is left from a process that died mid-download, and is swept. */
export const DEPTH_FILL_STALE_PART_MS = 60 * 60_000

export interface DepthModelFill {
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  files: readonly { path: string; bytes: number; sha256: string }[]
  stallMs: number
  overallMs: number
}

const DEFAULT_FILL: DepthModelFill = {
  fetch: (url, init) => globalThis.fetch(url, init),
  files: DEPTH_MODEL_FILES,
  stallMs: DEPTH_FILL_STALL_MS,
  overallMs: DEPTH_FILL_OVERALL_MS,
}
let fillDeps: DepthModelFill = DEFAULT_FILL

/** Tests only: fetch, file list and limits `depthPipeline` fills with (undefined = the real ones). */
export function setDepthModelFillForTests(deps?: Partial<DepthModelFill>): void {
  fillDeps = { ...DEFAULT_FILL, ...deps }
  pipePromise = null
  shared = null
  readyAt = null
}

/** Why the depth model can't be had: its message is plain words, shown as is (the depth route, Lens · Depth of field). */
export class DepthModelUnavailable extends Error {}

const NOT_DOWNLOADED = (why: string) => new DepthModelUnavailable(`Sailor couldn’t download the depth model (${why}). Check the connection and try again.`)
const DAMAGED = (why: string) => new DepthModelUnavailable(`The depth model Sailor downloaded was damaged (${why}). Try again.`)
const stopped = () => new Error('Stopped')

function present(dir: string, f: DepthModelFill['files'][number]): boolean {
  const p = join(dir, DEPTH_MODEL, f.path)
  try { return existsSync(p) && statSync(p).size === f.bytes }
  catch { return false }
}

/** `*.part` files under the model's folder older than an hour: a process killed mid-download left them. */
async function sweepStaleParts(dir: string, now = Date.now()): Promise<void> {
  const root = join(dir, DEPTH_MODEL)
  let names: string[]
  try { names = (await readdir(root, { recursive: true })).map(String) }
  catch { return }
  for (const name of names) {
    if (!name.endsWith('.part')) continue
    const p = join(root, name)
    try { if (now - statSync(p).mtimeMs > DEPTH_FILL_STALE_PART_MS) await rm(p, { force: true }) }
    catch {}
  }
}

async function fetchOne(dir: string, f: DepthModelFill['files'][number], deps: DepthModelFill, signal: AbortSignal): Promise<void> {
  const dest = join(dir, DEPTH_MODEL, f.path)
  await mkdir(dirname(dest), { recursive: true })
  // Written beside the file and renamed in only once whole and checked: a cut
  // download, a Stop or a stall never leaves a file the loader would read.
  const part = `${dest}.${randomUUID()}.part`
  const ctl = new AbortController()
  let why: 'stall' | 'overall' | null = null
  const onStop = () => ctl.abort()
  signal.addEventListener('abort', onStop, { once: true })
  if (signal.aborted) ctl.abort()
  const overall = setTimeout(() => { why ??= 'overall'; ctl.abort() }, deps.overallMs)
  let stall: ReturnType<typeof setTimeout> | undefined
  const kick = () => { clearTimeout(stall); stall = setTimeout(() => { why ??= 'stall'; ctl.abort() }, deps.stallMs) }
  let out: ReturnType<typeof createWriteStream> | null = null
  try {
    kick()
    let res: Response
    try { res = await deps.fetch(depthModelFileUrl(f.path), { signal: ctl.signal }) }
    catch (err) { if (ctl.signal.aborted) throw err; throw NOT_DOWNLOADED(`${f.path}, no answer`) }
    if (ctl.signal.aborted) throw new Error('aborted')
    if (!res.ok || !res.body) throw NOT_DOWNLOADED(`${f.path}, ${res.status}`)
    const reader = res.body.getReader()
    // A body that ignores the signal is cancelled by hand, so a read never outlives Stop or a stall.
    ctl.signal.addEventListener('abort', () => { reader.cancel().catch(() => {}) }, { once: true })
    const hash = createHash('sha256')
    let bytes = 0
    const stream = createWriteStream(part)
    out = stream
    const done = new Promise<void>((resolve, reject) => { stream.on('finish', () => resolve()); stream.on('error', reject) })
    for (;;) {
      const { done: end, value } = await reader.read()
      if (ctl.signal.aborted) throw new Error('aborted')
      if (end) break
      kick()
      bytes += value.byteLength
      if (bytes > f.bytes) { await reader.cancel().catch(() => {}); throw DAMAGED(`${f.path} too large`) }
      hash.update(value)
      if (!stream.write(value)) await new Promise<void>(r => stream.once('drain', () => r()))
    }
    stream.end()
    await done
    if (bytes !== f.bytes || hash.digest('hex') !== f.sha256) throw DAMAGED(`${f.path} didn’t match its checksum`)
    await rename(part, dest)
  }
  catch (err) {
    out?.destroy()
    await rm(part, { force: true })
    if (signal.aborted) throw stopped()
    if (why === 'stall') throw NOT_DOWNLOADED(`${f.path}, nothing arrived for ${Math.round(deps.stallMs / 1000)} s`)
    if (why === 'overall') throw NOT_DOWNLOADED(`${f.path}, it took too long`)
    if (err instanceof DepthModelUnavailable) throw err
    throw NOT_DOWNLOADED(`${f.path}, the download broke off`)
  }
  finally {
    clearTimeout(overall)
    clearTimeout(stall)
    signal.removeEventListener('abort', onStop)
  }
}

/** The one download in flight, shared by every caller waiting on it. */
interface SharedFill { promise: Promise<void>; controller: AbortController; waiters: number }
let shared: SharedFill | null = null

/** `p`, or a Stop error as soon as `signal` aborts (`p` itself goes on). */
function untilStopped<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(stopped())
  return new Promise<T>((resolve, reject) => {
    const on = () => reject(stopped())
    signal.addEventListener('abort', on, { once: true })
    p.then(
      (v) => { signal.removeEventListener('abort', on); resolve(v) },
      (e) => { signal.removeEventListener('abort', on); reject(e) },
    )
  })
}

/** Whether every depth model file is in `depthModelDir()` at its size (locally, before a run is held: engine.ts). */
export function depthModelFilesPresent(deps: DepthModelFill = fillDeps): boolean {
  const dir = depthModelDir()
  return !!dir && deps.files.every(f => present(dir, f))
}

/**
 * Locally, put every depth model file that is missing or the wrong size into
 * `depthModelDir()`, from the pinned revision, each checked against its
 * sha256 (step 3, R10.5). Stale `*.part` files are swept first.
 *   - One download at a time, shared by every caller; a failure lets the next
 *     call retry.
 *   - `signal` (a run's Stop) ends this caller's wait at once. The download
 *     itself is cancelled, its `.part` deleted, only when no caller is left
 *     waiting on it: one run's Stop never breaks another run's fill.
 *   - It gives up when nothing arrives for `stallMs` (30 s) or the whole takes
 *     longer than `overallMs` (15 min).
 * Failures are DepthModelUnavailable, in plain words. Hosted never
 * downloads: the image ships the files.
 */
export async function fillDepthModel(deps: DepthModelFill = fillDeps, signal?: AbortSignal): Promise<void> {
  if (isHosted()) throw new DepthModelUnavailable('The depth model isn\'t installed on this server.')
  const dir = depthModelDir()
  if (!dir) throw new DepthModelUnavailable('Sailor can\'t find a folder for the depth model. Set NUXT_DEPTH_MODEL_DIR.')
  if (deps.files.every(f => present(dir, f))) return
  if (signal?.aborted) throw stopped()
  if (!shared) {
    const s: SharedFill = { controller: new AbortController(), waiters: 0, promise: Promise.resolve() }
    s.promise = (async () => {
      await sweepStaleParts(dir)
      for (const f of deps.files) {
        if (!present(dir, f)) await fetchOne(dir, f, deps, s.controller.signal)
      }
    })().finally(() => { if (shared === s) shared = null })
    s.promise.catch(() => {}) // every waiter may have left: never an unhandled rejection
    shared = s
  }
  const s = shared
  s.waiters++
  try {
    await untilStopped(s.promise, signal)
  }
  finally {
    s.waiters--
    // The last caller stopped: cancel the download (its `.part` is deleted), and let the next caller start afresh.
    if (s.waiters === 0 && signal?.aborted) {
      s.controller.abort()
      if (shared === s) shared = null
    }
  }
}

let pipePromise: Promise<any> | null = null

/**
 * The depth-estimation pipeline, loaded once, always from the files on disk
 * (transformers.js never downloads: `allowRemoteModels` off). Locally the
 * files are first filled by `fillDepthModel` (at once when they are there);
 * hosted they ship in the image.
 */
export async function depthPipeline(signal?: AbortSignal): Promise<any> {
  if (!isHosted()) await fillDepthModel(fillDeps, signal)
  if (!pipePromise) {
    pipePromise = import('@huggingface/transformers')
      .then(({ env, pipeline }) => {
        const dir = depthModelDir()
        if (dir) env.localModelPath = dir
        env.allowLocalModels = true
        env.allowRemoteModels = false
        return pipeline('depth-estimation', DEPTH_MODEL)
      })
      .catch((err) => { pipePromise = null; throw err }) // let the next request retry
  }
  return pipePromise
}

/** The model's raw answer for one picture: `predicted_depth`, h × w float32 (bright = near), before any resize. */
export interface RawDepth { w: number; h: number; data: Float32Array }

/**
 * Depth Anything's raw depth for an 8-bit RGB picture (interleaved, w × h × 3),
 * as _depth.py's `_run_model` asks the model for it (the processor's resize,
 * rescale and normalise, then the model), without the resize back: the
 * runner resizes it to the picture itself (bicubic, as _depth.py does).
 */
export async function depthOfRgb(rgb: Uint8Array, w: number, h: number, signal?: AbortSignal): Promise<RawDepth> {
  const pipe = await depthPipeline(signal)
  const { RawImage } = await import('@huggingface/transformers')
  const image = new RawImage(rgb, w, h, 3)
  const inputs = await pipe.processor(image)
  const { predicted_depth: out } = await pipe.model(inputs)
  const dims: number[] = out.dims
  const oh = dims[dims.length - 2]!
  const ow = dims[dims.length - 1]!
  return { w: ow, h: oh, data: new Float32Array(out.data as Float32Array) }
}
