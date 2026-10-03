// The engine-style paths (PROXY_PREFIXES: /object_info, /view, /upload,
// /sailor/…), answered by Sailor itself. There is no engine behind them any
// more (step 4, C5: Sailor is online-only, no local generation): locally the
// native routes answer, hosted the tenant gates do (step 3, R10.9), and
// everything else — /prompt, /queue, /interrupt, /ws, /system_stats, settings,
// userdata, extensions — is a plain 404, here and hosted alike. The file keeps
// its old name.

import { PROXY_PREFIXES } from '../utils/authGuard'
import { deployMode } from '../utils/deployMode'
import { handleHostedObjectInfo, handleHostedUpload, handleHostedSailor, handleHostedSailorData, handleHostedOutputListing } from '../utils/engineGate'
import { normalizeEnginePath, hostedEngineDecision } from '../utils/enginePath'
import { NITRO_API_PATHS, NITRO_API_PREFIXES } from '../lib/nitroApiPaths'
import { nativeEngineRoute } from '../native/router'

// Paths under PROXY_PREFIXES that should be handled by Nitro routes, not proxied
// — the lists live in their own module so the reachability guard can import the
// real values rather than scrape this file. See server/lib/nitroApiPaths.ts.
//
// These catch the bare `/view` and `/history` spellings only. The aliases
// `/api/view`, `/comfyui/view` and `/api/history` are NOT caught here: locally
// the native router answers what it serves and the rest is a 404 (hosted mode
// gates every spelling through the canonical path). Sailor's app doesn't use
// those spellings.
const NITRO_ROUTE_PREFIXES = ['/view', '/history']

export default defineEventHandler(async (event) => {
  const path = event.path

  // Stage 6 Task 8 — HEADER SPOOF RULE. A client must NEVER supply its own
  // `comfy-user`: under --multi-user the engine treats that header as identity,
  // so an inbound one would let any caller read/write another tenant's
  // settings + userdata. Strip it here, before ANY branch or proxy, in EVERY
  // mode. Local is single-user so the header is inert there, but stripping
  // uniformly guarantees no raw-proxy or forward can ever carry a
  // client-injected id to the engine. (Hosted no longer forwards settings or
  // userdata at all since step 3, R10.9, so no `comfy-user` is ever set.)
  const reqHeaders = event.node?.req?.headers as Record<string, unknown> | undefined
  if (reqHeaders && 'comfy-user' in reqHeaders) delete reqHeaders['comfy-user']

  // Skip proxying for Nitro's own API routes and server routes
  if (NITRO_API_PATHS.some((p) => path === p || path.startsWith(p + '?'))) return
  if (NITRO_API_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'))) return
  if (NITRO_ROUTE_PREFIXES.some((p) => path === p || path.startsWith(p + '?') || path.startsWith(p + '/'))) return

  const engineStyle = PROXY_PREFIXES.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'))
  if (!engineStyle) return

  // Engine-free Phase A: the routes Sailor serves itself (projects, spend,
  // media, the small A3 routes, /object_info, /view, /upload, …) — same
  // folders, same formats as the Python they replaced. LOCAL MODE ONLY here:
  // hosted reaches the same handlers through the tenant gates below, after the
  // ownership check, never directly.
  if (deployMode() !== 'hosted') {
    const native = await nativeEngineRoute(event)
    if (native !== undefined) return native
    // Step 4, C5: no engine behind it — anything else is a plain 404, as hosted.
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  // Stage 5 review C1: ComfyUI serves every route at BOTH `/x` and `/api/x`,
  // and this proxy strips a leading `/comfyui` — so one endpoint has up to
  // four spellings. Gating a literal path left the other three as free
  // bypasses (unmetered /api/prompt, cross-tenant /comfyui/history, …).
  // Every hosted decision below is taken on the canonical form instead.
  //
  // LOCAL MODE returned above (the native routes, else a 404).
  {
    const decision = hostedEngineDecision(normalizeEnginePath(path), event.method)
    // F2: the canvas needs the node schemas — served from the saved copy (or
    // the committed baseline) with the shared input-directory listings
    // scrubbed; ComfyUI is never asked (step 3, R10.9).
    if (decision.kind === 'objectInfo') return handleHostedObjectInfo(event)
    // Step 3, R10.6: hosted offers no blueprint (they are built from local-only
    // classes) — the list is empty, answered here without the engine.
    if (decision.kind === 'emptySubgraphs') return {}
    // F4: refuses an `overwrite` field, then writes the identical bytes natively.
    if (decision.kind === 'upload') return handleHostedUpload(event)
    // Stage 6 Task 7: LoadImageOutput's remote picker — the caller's OWN
    // outputs (from graph_runs), matching the engine's flat-array shape, in
    // place of the shared /internal enumeration oracle.
    if (decision.kind === 'outputListing') return handleHostedOutputListing(event)
    // Stage 6 Task 2: the projects extension has no identity of its own, so
    // ownership is checked here against resource_owners — a project that
    // isn't yours 404s, list included.
    if (decision.kind === 'sailorProjects') return handleHostedSailor(event)
    // Stage 6 Task 2b: the per-user /sailor DATA routes (input/output file
    // listings + deletes + thumbnails, and the timeline-asset library). Reads
    // are filtered to owned rows and deletes 404 when the file/asset isn't the
    // caller's.
    if (decision.kind === 'sailorData') return handleHostedSailorData(event)
    // A refused /sailor route (or upload verb, or one blueprint) keeps its words.
    if (decision.kind === 'forbid') throw createError({ statusCode: 403, message: decision.message })
    // Engine-free Phase A (A3): the audited stateless /sailor routes (shader
    // catalog, Space Type preset reads, font subset) are answered by Sailor
    // itself, from the same folders.
    if (decision.kind === 'proxy') {
      const native = await nativeEngineRoute(event)
      if (native !== undefined) return native
    }
    // Step 3, R10.9: everything else — /prompt, /queue, /interrupt, /ws, the
    // engine's /history and /view mirrors, /object_info writes, stats,
    // extensions, settings, userdata, anything unaudited — is a plain 404.
    // Hosted never falls through to the proxy below.
    throw createError({ statusCode: 404, message: 'Not found' })
  }
})
