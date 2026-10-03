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
import { mkdir, rename, rm } from 'node:fs/promises'
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

export interface DepthModelFill {
  fetch: (url: string) => Promise<Response>
  files: readonly { path: string; bytes: number; sha256: string }[]
}

const DEFAULT_FILL: DepthModelFill = { fetch: url => globalThis.fetch(url), files: DEPTH_MODEL_FILES }
let fillDeps: DepthModelFill = DEFAULT_FILL

/** Tests only: fetch and file list `depthPipeline` fills with (undefined = the real ones). */
export function setDepthModelFillForTests(deps?: Partial<DepthModelFill>): void {
  fillDeps = { ...DEFAULT_FILL, ...deps }
  pipePromise = null
  filling = null
  readyAt = null
}

async function fetchOne(dir: string, f: DepthModelFill['files'][number], doFetch: DepthModelFill['fetch']): Promise<void> {
  const dest = join(dir, DEPTH_MODEL, f.path)
  await mkdir(dirname(dest), { recursive: true })
  const res = await doFetch(depthModelFileUrl(f.path))
  if (!res.ok || !res.body) throw new Error(`Sailor couldn’t download the depth model (${f.path}, ${res.status}). Check the connection and try again.`)
  // Written beside the file and renamed in only once whole and checked: a cut
  // download never leaves a file the loader would read.
  const part = `${dest}.${randomUUID()}.part`
  const hash = createHash('sha256')
  let bytes = 0
  try {
    const out = createWriteStream(part)
    const done = new Promise<void>((resolve, reject) => { out.on('finish', () => resolve()); out.on('error', reject) })
    const reader = res.body.getReader()
    for (;;) {
      const { done: end, value } = await reader.read()
      if (end) break
      bytes += value.byteLength
      if (bytes > f.bytes) { await reader.cancel().catch(() => {}); throw new Error(`The depth model Sailor downloaded was damaged (${f.path} too large). Try again.`) }
      hash.update(value)
      if (!out.write(value)) await new Promise<void>(r => out.once('drain', () => r()))
    }
    out.end()
    await done
    if (bytes !== f.bytes || hash.digest('hex') !== f.sha256) throw new Error(`The depth model Sailor downloaded was damaged (${f.path} didn’t match its checksum). Try again.`)
    await rename(part, dest)
  }
  catch (err) {
    await rm(part, { force: true })
    throw err
  }
}

let filling: Promise<void> | null = null

/**
 * Locally, put every depth model file that is missing or the wrong size into
 * `depthModelDir()`, from the pinned revision, each checked against its
 * sha256 (step 3, R10.5). One fill at a time; a failure lets the next call
 * retry. Hosted never downloads: the image ships the files.
 */
export function fillDepthModel(deps: DepthModelFill = fillDeps): Promise<void> {
  if (isHosted()) return Promise.reject(new Error('The depth model isn\'t installed on this server.'))
  const dir = depthModelDir()
  if (!dir) return Promise.reject(new Error('Sailor can\'t find a folder for the depth model. Set NUXT_DEPTH_MODEL_DIR.'))
  if (!filling) {
    filling = (async () => {
      for (const f of deps.files) {
        const p = join(dir, DEPTH_MODEL, f.path)
        let have = false
        try { have = existsSync(p) && statSync(p).size === f.bytes }
        catch {}
        if (!have) await fetchOne(dir, f, deps.fetch)
      }
    })().finally(() => { filling = null })
  }
  return filling
}

let pipePromise: Promise<any> | null = null

/**
 * The depth-estimation pipeline, loaded once, always from the files on disk
 * (transformers.js never downloads: `allowRemoteModels` off). Locally the
 * files are first filled by `fillDepthModel`; hosted they ship in the image.
 */
export function depthPipeline(): Promise<any> {
  if (!pipePromise) {
    pipePromise = (isHosted() ? Promise.resolve() : fillDepthModel())
      .then(() => import('@huggingface/transformers'))
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
export async function depthOfRgb(rgb: Uint8Array, w: number, h: number): Promise<RawDepth> {
  const pipe = await depthPipeline()
  const { RawImage } = await import('@huggingface/transformers')
  const image = new RawImage(rgb, w, h, 3)
  const inputs = await pipe.processor(image)
  const { predicted_depth: out } = await pipe.model(inputs)
  const dims: number[] = out.dims
  const oh = dims[dims.length - 2]!
  const ow = dims[dims.length - 1]!
  return { w: ow, h: oh, data: new Float32Array(out.data as Float32Array) }
}
