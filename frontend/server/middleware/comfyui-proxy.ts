// Proxy ComfyUI API paths to the backend.
// The ComfyUI iframes load directly from :8188, but the Nuxt frontend
// still makes fetch() calls to these paths (e.g. /queue, /comfyui/settings).

import { resolveWorkerTarget } from '../utils/workerRoute'
import { PROXY_PREFIXES } from '../utils/authGuard'
import { deployMode, engineMultiUser } from '../utils/deployMode'
import { handleMeteredPrompt } from '../utils/meterGraphRun'
import { handleHostedQueueGet, handleHostedInterrupt, handleHostedObjectInfo, handleHostedUpload, handleHostedSailor, handleHostedSailorData, handleHostedOutputListing, handleHostedUserScoped } from '../utils/engineGate'
import { normalizeEnginePath, hostedEngineDecision } from '../utils/enginePath'
import { NITRO_API_PATHS, NITRO_API_PREFIXES } from '../lib/nitroApiPaths'
import { nativeEngineRoute } from '../native/router'

// Paths under PROXY_PREFIXES that should be handled by Nitro routes, not proxied
// — the lists live in their own module so the reachability guard can import the
// real values rather than scrape this file. See server/lib/nitroApiPaths.ts.
const NITRO_ROUTE_PREFIXES = ['/view', '/history']

export default defineEventHandler(async (event) => {
  const path = event.path

  // Stage 6 Task 8 — HEADER SPOOF RULE. A client must NEVER supply its own
  // `comfy-user`: under --multi-user the engine treats that header as identity,
  // so an inbound one would let any caller read/write another tenant's
  // settings + userdata. Strip it here, before ANY branch or proxy, in EVERY
  // mode. Local is single-user so the header is inert there, but stripping
  // uniformly guarantees no raw-proxy or forward can ever carry a
  // client-injected id to the engine. The one legitimate `comfy-user` is set
  // server-side in handleHostedUserScoped, downstream of this strip.
  const reqHeaders = event.node?.req?.headers as Record<string, unknown> | undefined
  if (reqHeaders && 'comfy-user' in reqHeaders) delete reqHeaders['comfy-user']

  // Skip proxying for Nitro's own API routes and server routes
  if (NITRO_API_PATHS.some((p) => path === p || path.startsWith(p + '?'))) return
  if (NITRO_API_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'))) return
  if (NITRO_ROUTE_PREFIXES.some((p) => path === p || path.startsWith(p + '?') || path.startsWith(p + '/'))) return

  // Engine-free Phase A: the /sailor routes Sailor now serves itself (projects,
  // spend, media, the small A3 routes) — same folders, same formats as the
  // Python it replaces. LOCAL MODE
  // ONLY here: hosted reaches the same handlers through the tenant gates below,
  // after the ownership check, never directly.
  if (deployMode() !== 'hosted') {
    const native = await nativeEngineRoute(event)
    if (native !== undefined) return native
  }

  // Stage 5 review C1: ComfyUI serves every route at BOTH `/x` and `/api/x`,
  // and this proxy strips a leading `/comfyui` — so one endpoint has up to
  // four spellings. Gating a literal path left the other three as free
  // bypasses (unmetered /api/prompt, cross-tenant /comfyui/history, …).
  // Every hosted decision below is taken on the canonical form instead.
  //
  // LOCAL MODE: this whole block is SHORT-CIRCUITED by the deployMode() check
  // below — normalizeEnginePath is never even called, and the raw proxy loop
  // that follows sees the ORIGINAL path. A local install behaves exactly as it
  // did before Stage 5. (F7: this comment used to claim normalization "is
  // computed but never consulted", which described code that no longer runs.)
  if (deployMode() === 'hosted' && PROXY_PREFIXES.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'))) {
    const decision = hostedEngineDecision(normalizeEnginePath(path), event.method)
    if (decision.kind === 'meterPrompt') return handleMeteredPrompt(event)
    if (decision.kind === 'queueGet') return handleHostedQueueGet(event)
    if (decision.kind === 'interrupt') return handleHostedInterrupt(event)
    // F2: the canvas needs the node schemas, so this passes through a scrubber
    // that empties the shared input-directory listings instead of 403-ing.
    if (decision.kind === 'objectInfo') return handleHostedObjectInfo(event)
    // F4: refuses an `overwrite` field, then forwards the identical bytes.
    if (decision.kind === 'upload') return handleHostedUpload(event)
    // Stage 6 Task 7: LoadImageOutput's remote picker — the caller's OWN
    // outputs (from graph_runs), matching the engine's flat-array shape, in
    // place of the shared /internal enumeration oracle.
    if (decision.kind === 'outputListing') return handleHostedOutputListing(event)
    // Stage 6 Task 2: the projects extension has no identity of its own, so
    // ownership is checked here against resource_owners before the engine is
    // asked anything — a project that isn't yours 404s, list included.
    if (decision.kind === 'sailorProjects') return handleHostedSailor(event)
    // Stage 6 Task 2b: the per-user /sailor DATA routes (input/output file
    // listings + deletes + thumbnails, and the timeline-asset library). Reads
    // are filtered to owned rows and deletes 404 when the file/asset isn't the
    // caller's — the engine is never touched on an ownership miss.
    if (decision.kind === 'sailorData') return handleHostedSailorData(event)
    // Stage 6 Task 8: ComfyUI's per-user settings + userdata, forwarded with a
    // server-set `comfy-user`. Gated on engineMultiUser() — the engine must be
    // running --multi-user for these to be per-user (single-user would make
    // /userdata a SHARED cross-tenant dir). With the switch off (the default)
    // they stay 403, exactly as before this task.
    if (decision.kind === 'userScoped') {
      if (!engineMultiUser()) throw createError({ statusCode: 403, message: 'Per-user engine data is not enabled in hosted mode' })
      return handleHostedUserScoped(event)
    }
    // Deny by default: an engine path that isn't explicitly allowlisted for
    // hosted raw proxying is refused, so a route nobody has audited can
    // never become a cross-tenant surface merely by existing upstream.
    if (decision.kind === 'forbid') throw createError({ statusCode: 403, message: decision.message })
    // Engine-free Phase A (A3): the audited stateless /sailor routes (shader
    // catalog, Space Type preset reads, font subset, model status) keep their
    // hosted 'proxy' classification but are answered by Sailor itself, from
    // the same folders. Everything else classified 'proxy' is not native and
    // falls through to the raw proxy below.
    if (decision.kind === 'proxy') {
      const native = await nativeEngineRoute(event)
      if (native !== undefined) return native
    }
  }

  for (const prefix of PROXY_PREFIXES) {
    // Match /view, /view/, /view?query=..., /view/subpath, etc.
    if (path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?')) {
      // `?comfyWorker=N` selects a headless pool worker (8189+N) instead of
      // the main instance (8188); see server/utils/workerRoute.ts.
      const { port, cleanUrl } = resolveWorkerTarget(path)
      const target = `http://127.0.0.1:${port}`
      const backendPath = cleanUrl.startsWith('/comfyui')
        ? cleanUrl.replace(/^\/comfyui/, '') || '/'
        : cleanUrl
      // Override the Origin header so ComfyUI's origin-check middleware
      // sees host == origin (both 127.0.0.1:<port>) instead of blocking the
      // Nuxt dev-server port (3000) with a 403.
      return proxyRequest(event, `${target}${backendPath}`, {
        fetchOptions: { headers: { origin: target } },
      })
    }
  }
})
