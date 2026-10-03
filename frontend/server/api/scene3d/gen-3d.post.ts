// POST /api/scene3d/gen-3d — image → 3D (GLB) via a fal image-to-3D model.
// Returns the fal CDN GLB URL (fetchable by the studio's loadGlb).
//
// The image can come from two places: the text→image step (already a public fal
// CDN url) OR a pick from the canvas (a `/view?…` path or a data: URL, neither
// of which fal's servers can fetch). resolveToFalUrl below normalises the
// latter by pulling the bytes and re-hosting them on fal storage; a url that is
// already fal-hosted passes straight through untouched.
//
// resolve3dModel is auto-imported from server/utils/scene3dGen.ts; runFal from
// server/utils/falRun.ts; uploadToFalStorage from server/utils/falStorage.ts —
// same auto-import convention as /api/inpaint/flux-fill.post.ts.
import { assertRateLimit } from '../../lib/rateLimit'
import { isHosted } from '../../utils/deployMode'
import { hostedViewGate } from '../../native/viewGate'
import { readViewFile, viewQueryOf } from '../../native/viewRead'
import { FetchRefused, localViewPorts, safeFetch, type SafeFetchPolicy } from '../../templates/safeFetch'

interface Body {
  imageUrl?: string
  model?: string
  textured?: boolean
  seed?: number
}

const MAX_SOURCE_BYTES = 30 * 1024 * 1024

const WORDS = {
  refused: 'The source image points at a private network address, which is not allowed',
  tooLarge: 'The source image is larger than 30 MB',
  timeout: 'The source image took longer than 20 seconds to download',
}

/** A url already hosted on fal's CDN — passes to the model unchanged. */
function isFalUrl(u: string): boolean {
  try { return /(^|\.)fal\.(media|run|ai)$/.test(new URL(u).host) } catch { return false }
}

/**
 * Turn any image reference into a public, fal-fetchable https url. A fal url is
 * returned as-is; a data: URL is decoded; a canvas pick (a relative `/view?…`
 * path) is read off disk by Sailor itself (server/native/viewRead.ts) — hosted,
 * only the caller's own file, as GET /view; anything else is fetched under the
 * server's safe-fetch policy (no private network; locally an absolute loopback
 * `/view` is read natively too). Nothing reaches the engine (step 3, R10.8).
 * The bytes are re-hosted via uploadToFalStorage so the model's own servers can
 * read them (see falStorage.ts for why fal hosting, not Replicate/localhost).
 */
async function resolveToFalUrl(imageUrl: string, who: { hosted: boolean; userId: string | null; localPort?: number }): Promise<string> {
  if (/^https?:\/\//i.test(imageUrl) && isFalUrl(imageUrl)) return imageUrl

  let bytes: Uint8Array
  let contentType: string
  if (imageUrl.startsWith('data:')) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(imageUrl)
    if (!m) throw createError({ statusCode: 400, message: 'Malformed data URL' })
    contentType = m[1] || 'image/png'
    bytes = m[2]
      ? new Uint8Array(Buffer.from(m[3]!, 'base64'))
      : new Uint8Array(Buffer.from(decodeURIComponent(m[3]!)))
  }
  else if (imageUrl.startsWith('/')) {
    // A canvas pick: `/view?…` (any engine spelling), read by name off disk.
    let u: URL
    try { u = new URL(imageUrl, 'http://sailor.invalid') }
    catch { throw createError({ statusCode: 400, message: 'Malformed image path' }) }
    if (u.host !== 'sailor.invalid' || !/^(\/comfyui)?(\/api)?\/view$/.test(u.pathname)) {
      throw createError({ statusCode: 400, message: 'Only a /view path can be read from this server' })
    }
    const query = viewQueryOf(u.searchParams)
    if (who.hosted) await hostedViewGate(who.userId, query)
    const read = await readViewFile(query, MAX_SOURCE_BYTES)
    if (read.kind === 'tooLarge') throw createError({ statusCode: 413, message: WORDS.tooLarge })
    if (read.kind === 'status') throw createError({ statusCode: read.status === 404 ? 404 : 400, message: read.status === 404 ? 'The source image was not found' : 'Invalid image request' })
    contentType = read.contentType
    bytes = new Uint8Array(read.data)
  }
  else {
    const policy: SafeFetchPolicy = {
      hosted: who.hosted, loopbackView: true, viewPorts: localViewPorts({ localPort: who.localPort }),
      timeoutMs: 20_000, maxBytes: MAX_SOURCE_BYTES, words: WORDS, accept: 'image/*',
    }
    let res: Awaited<ReturnType<typeof safeFetch>>
    try { res = await safeFetch(imageUrl, policy) }
    catch (err) {
      if (err instanceof FetchRefused) throw createError({ statusCode: err.message === WORDS.tooLarge ? 413 : 400, message: err.message })
      throw createError({ statusCode: 502, message: `Could not fetch the source image: ${err instanceof Error ? err.message : String(err)}` })
    }
    if (res.status < 200 || res.status >= 300) throw createError({ statusCode: 502, message: `The source image returned ${res.status}` })
    contentType = (res.contentType || 'image/png').split(';')[0]!.trim()
    bytes = new Uint8Array(res.data)
  }
  if (!bytes.byteLength) throw createError({ statusCode: 502, message: 'The source image was empty' })
  const ext = (contentType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png'
  return await uploadToFalStorage(bytes, `scene3d_src_${Date.now().toString(36)}.${ext}`, contentType)
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'scene3d-gen-3d', 6)
  const body = await readBody<Body>(event)
  const imageUrl = (body?.imageUrl ?? '').trim()
  if (!imageUrl) throw createError({ statusCode: 400, message: 'imageUrl is required' })

  const hosted = isHosted()
  const userId: string | null = event.context.userId ?? null
  if (hosted && !userId) throw createError({ statusCode: 401, message: 'Sign in required' })
  const falImageUrl = await resolveToFalUrl(imageUrl, { hosted, userId, localPort: event.node?.req?.socket?.localPort })
  const model = resolve3dModel(body?.model)
  const input = model.buildInput(falImageUrl, { textured: body?.textured, seed: body?.seed })
  // 3D generation can take up to ~4 min — widen the poll deadline past the default 120s.
  const result = await runFal(model.app, input, { pollDeadlineMs: 300_000 })
  const glbUrl = model.glbUrlFrom(result)
  if (!glbUrl) throw createError({ statusCode: 502, message: 'fal returned no 3D model' })
  return { glbUrl }
})
