// POST /api/scene3d/gen-3d — image → 3D (GLB) via a fal image-to-3D model.
// Returns the fal CDN GLB URL (fetchable by the studio's loadGlb).
//
// The image can come from two places: the text→image step (already a public fal
// CDN url) OR a pick from the canvas (a ComfyUI `/view?…` path or a data: URL,
// neither of which fal's servers can fetch). resolveToFalUrl below normalises the
// latter by pulling the bytes and re-hosting them on fal storage; a url that is
// already fal-hosted passes straight through untouched.
//
// resolve3dModel is auto-imported from server/utils/scene3dGen.ts; runFal from
// server/utils/falRun.ts; uploadToFalStorage from server/utils/falStorage.ts —
// same auto-import convention as /api/inpaint/flux-fill.post.ts.
import { assertRateLimit } from '../../lib/rateLimit'

interface Body {
  imageUrl?: string
  model?: string
  textured?: boolean
  seed?: number
}

const COMFY_BACKEND = 'http://127.0.0.1:8188'

/** A url already hosted on fal's CDN — passes to the model unchanged. */
function isFalUrl(u: string): boolean {
  try { return /(^|\.)fal\.(media|run|ai)$/.test(new URL(u).host) } catch { return false }
}

/**
 * Turn any image reference into a public, fal-fetchable https url. A fal url is
 * returned as-is; a data: URL is decoded; a ComfyUI `/view?…` path is resolved
 * against the local backend and fetched; anything else is fetched directly. The
 * bytes are re-hosted via uploadToFalStorage so the model's own servers can read
 * them (see falStorage.ts for why fal hosting, not Replicate/localhost).
 */
async function resolveToFalUrl(imageUrl: string): Promise<string> {
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
  } else {
    // A canvas pick is a relative `/view?…` path → resolve against ComfyUI.
    const fetchUrl = imageUrl.startsWith('/') ? `${COMFY_BACKEND}${imageUrl}` : imageUrl
    const res = await fetch(fetchUrl, { redirect: 'follow', signal: AbortSignal.timeout(20_000) })
      .catch((err: unknown) => { throw createError({ statusCode: 502, message: `Could not fetch the source image: ${err instanceof Error ? err.message : String(err)}` }) })
    if (!res.ok) throw createError({ statusCode: 502, message: `The source image returned ${res.status}` })
    contentType = (res.headers.get('content-type') || 'image/png').split(';')[0]!.trim()
    bytes = new Uint8Array(await res.arrayBuffer())
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

  const falImageUrl = await resolveToFalUrl(imageUrl)
  const model = resolve3dModel(body?.model)
  const input = model.buildInput(falImageUrl, { textured: body?.textured, seed: body?.seed })
  // 3D generation can take up to ~4 min — widen the poll deadline past the default 120s.
  const result = await runFal(model.app, input, { pollDeadlineMs: 300_000 })
  const glbUrl = model.glbUrlFrom(result)
  if (!glbUrl) throw createError({ statusCode: 502, message: 'fal returned no 3D model' })
  return { glbUrl }
})
