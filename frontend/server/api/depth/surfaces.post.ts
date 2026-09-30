/**
 * POST /api/depth/surfaces — photo surfaces from MoGe-2 on fal, for the
 * Relight layer effect (stage 2, Task 1). Replaces the dev-only prototype
 * route `depth/moge-normals.post.ts` (untracked, deleted by this task).
 *
 * Body:    { filename, subfolder?, type? } — same addressing as /api/depth/estimate.
 * Returns: { normalsFilename, subfolder: 'sailor_depth', cached }
 *          503 { off: true }  — kill switch (NUXT_RELIGHT_SURFACES=off)
 *          4xx/5xx { message } — path/ownership/provider failures
 *
 * The map is fal's normal PNG as is: red = right, green = UP, blue = toward the
 * camera. Cached by content hash next to the depth maps (`moge_<hash>.png`), so a
 * photo is paid for once (global-constraints.md: $0.0125/call, metered through
 * runFal). A cache hit never calls fal and is never metered.
 *
 * Hosted: rate-limited, and the source file must be owned by the caller
 * (assertInputOwned) — the moodboards/refs.post.ts pattern. runFal takes the
 * ledger hold before dispatch and releases it on any throw.
 */
import { readFile, mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { depthCacheKey, assetType, safeAssetRelPath } from '../../utils/depthCache'
import { assertRateLimit } from '../../lib/rateLimit'
import { assertInputOwned } from '../../utils/inputOwnership'
import { runFal } from '../../utils/falRun'
import { SURFACES_APP } from '../../../shared/pricing/relightSurfaces'

const CACHE_SUBDIR = 'sailor_depth'

/** Pure path derivation from an engine root — factored out so tests can point
 *  it at a scratch directory instead of the real ComfyUI checkout. */
export function surfacesPaths(root: string): { comfyRoot: string; cacheDir: string } {
  return { comfyRoot: root, cacheDir: join(root, 'input', CACHE_SUBDIR) }
}

let rootOverride: string | undefined
/** Test-only seam: point the route at a scratch engine root. */
export function __setSurfacesRootForTests(root: string | undefined): void { rootOverride = root }

function engineRoot(): string {
  return rootOverride ?? join(process.cwd(), '..')
}

const exists = (p: string) => access(p).then(() => true, () => false)

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

export default defineEventHandler(async (event) => {
  if (process.env.NUXT_RELIGHT_SURFACES === 'off') {
    setResponseStatus(event, 503)
    return { off: true }
  }

  assertRateLimit(event, 'depth-surfaces', 20)

  const body = await readBody<{ filename?: string; subfolder?: string; type?: string }>(event)
  const root = assetType(body?.type)
  if (!root) throw createError({ statusCode: 400, message: `unknown asset type: ${body?.type}` })
  const rel = safeAssetRelPath(body?.filename ?? '', body?.subfolder)
  if (!rel) throw createError({ statusCode: 400, message: 'a safe filename is required' })

  await assertInputOwned(event, root, body?.subfolder ?? '', body?.filename ?? '')

  const { comfyRoot, cacheDir } = surfacesPaths(engineRoot())

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(join(comfyRoot, root, rel)))
  } catch {
    throw createError({ statusCode: 404, message: `not found in ${root}: ${rel}` })
  }

  const name = `moge_${depthCacheKey(bytes)}.png`
  const outPath = join(cacheDir, name)
  if (await exists(outPath)) return { normalsFilename: name, subfolder: CACHE_SUBDIR, cached: true }

  const ext = rel.split('.').pop()?.toLowerCase() ?? 'png'
  const dataUri = `data:${MIME[ext] ?? 'image/png'};base64,${Buffer.from(bytes).toString('base64')}`

  let out: { normal_map?: { url?: string } }
  try {
    out = await runFal<{ normal_map?: { url?: string } }>(SURFACES_APP, {
      image_url: dataUri,
      model: 'vitl-normal',
      apply_mask: false,
      export_glb: false,
      export_ply: false,
    }, { pollDeadlineMs: 300_000 })
  } catch (err) {
    throw createError({ statusCode: 502, message: `moge-2: ${(err as Error).message}` })
  }

  const url = out.normal_map?.url
  if (!url) throw createError({ statusCode: 502, message: 'moge-2 returned no normal map' })

  const png = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!png.ok) throw createError({ statusCode: 502, message: `normal map download ${png.status}` })

  await mkdir(cacheDir, { recursive: true })
  await writeFile(outPath, new Uint8Array(await png.arrayBuffer()))
  return { normalsFilename: name, subfolder: CACHE_SUBDIR, cached: false }
})
