/**
 * POST /api/depth/estimate — monocular depth for an image in ComfyUI's input dir.
 *
 * Body:    { filename }  — an ImageLayer.filename, read straight off disk (no data-URL
 *                          round trip, since the file is already local).
 * Returns: { depthFilename, subfolder, cached }
 *
 * subfolder is returned SEPARATELY because /view proxies to ComfyUI, which takes the
 * subfolder as its own query param — a slash inside `filename` does not resolve.
 *
 * Runs Depth Anything V2 locally via transformers.js — no API call, no per-preview
 * bill. The pipeline is server/utils/depthModel.ts's singleton (shared with the runner's
 * Lens · Depth of field, R7.9), so weights load once (~3.5s) and stay warm; inference is
 * ~1s. Hosted, the model's files ship in the image and are never downloaded; locally the
 * first call fills NUXT_DEPTH_MODEL_DIR (or transformers.js's cache) with the pinned, checked
 * files (depthModel.ts fillDepthModel, R10.5). A cache hit never touches the model at all.
 *
 * Output convention: BRIGHT = NEAR (it's inverse depth / disparity, not distance).
 *
 * /api/depth is allowlisted in server/middleware/comfyui-proxy.ts — without that entry
 * the proxy forwards this to ComfyUI and it 404s.
 */
import { readFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'

import { depthCacheKey, depthCacheName, assetType, safeAssetRelPath } from '~~/server/utils/depthCache'
import { assertInputOwned } from '~~/server/utils/inputOwnership'
import { depthPipeline } from '~~/server/utils/depthModel'

const COMFY_ROOT = join(process.cwd(), '..')
const INPUT_DIR = join(COMFY_ROOT, 'input')
const CACHE_SUBDIR = 'sailor_depth'
// The cache always lives under input/, whatever root the SOURCE came from, so one
// /view?type=input URL serves every depth map.
const CACHE_DIR = join(INPUT_DIR, CACHE_SUBDIR)

/** Depth drives a blur radius, not detail — full resolution buys nothing and costs
 *  cache size plus texture-upload time. Sources here run to 4k. */
const MAX_EDGE = 1024

const exists = (p: string) => access(p).then(() => true, () => false)

export default defineEventHandler(async (event) => {
  const body = await readBody<{ filename?: string; subfolder?: string; type?: string }>(event)

  // A WIRED layer's image is an execution output, so it lives under output/ or temp/,
  // not input/. Same feature must work on both — see the parity rule.
  const root = assetType(body?.type)
  if (!root) throw createError({ statusCode: 400, message: `unknown asset type: ${body?.type}` })
  const rel = safeAssetRelPath(body?.filename ?? '', body?.subfolder)
  if (!rel) throw createError({ statusCode: 400, message: 'a safe filename is required' })

  await assertInputOwned(event, root, body?.subfolder ?? '', body?.filename ?? '')

  const srcPath = join(COMFY_ROOT, root, rel)
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(srcPath))
  } catch {
    throw createError({ statusCode: 404, message: `not found in ${root}: ${rel}` })
  }

  const name = depthCacheName(depthCacheKey(bytes))
  const outPath = join(CACHE_DIR, name)
  if (await exists(outPath)) {
    return { depthFilename: name, subfolder: CACHE_SUBDIR, cached: true }
  }

  try {
    const pipe = await depthPipeline()
    const { depth } = await pipe(srcPath)

    const long = Math.max(depth.width, depth.height)
    const scaled = long > MAX_EDGE
      ? await depth.resize(
          Math.max(1, Math.round((depth.width / long) * MAX_EDGE)),
          Math.max(1, Math.round((depth.height / long) * MAX_EDGE)),
        )
      : depth

    await mkdir(CACHE_DIR, { recursive: true })
    await scaled.save(outPath)
  } catch (err) {
    throw createError({
      statusCode: 502,
      message: `depth estimation failed: ${(err as Error).message}`,
    })
  }

  return { depthFilename: name, subfolder: CACHE_SUBDIR, cached: false }
})
