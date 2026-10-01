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
 *     transformers.js's own cache (node_modules/@huggingface/transformers/.cache),
 *     where the depth route's first use has always downloaded them.
 *
 * `depthModelReady()` says whether the files are on disk where the loader
 * reads them (the runner takes Lens · Depth of field only then:
 * server/runner/config.ts).
 */
import { existsSync, statSync } from 'node:fs'
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

let pipePromise: Promise<any> | null = null

/**
 * The depth-estimation pipeline, loaded once. Hosted, only from the files on
 * disk (never a download); locally a missing file is fetched into
 * transformers.js's cache, as the depth route always did.
 */
export function depthPipeline(): Promise<any> {
  if (!pipePromise) {
    pipePromise = import('@huggingface/transformers')
      .then(({ env, pipeline }) => {
        const dir = depthModelDir()
        if (dir) env.localModelPath = dir
        env.allowLocalModels = true
        env.allowRemoteModels = !isHosted()
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
