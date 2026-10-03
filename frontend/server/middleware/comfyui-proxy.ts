// Proxy ComfyUI API paths to the backend — LOCAL ONLY.
// Locally the app still sends decision 4's local-only runs to the engine
// (/prompt, /queue, /interrupt, the socket). Hosted never reaches the engine
// (step 3, R10.9): every engine path there is answered by Sailor itself or
// refused with a plain 404, and nothing falls through to the proxy below.

import { PROXY_PREFIXES } from '../utils/authGuard'
import { deployMode } from '../utils/deployMode'
import { handleHostedObjectInfo, handleHostedUpload, handleHostedSailor, handleHostedSailorData, handleHostedOutputListing } from '../utils/engineGate'
import { normalizeEnginePath, hostedEngineDecision, isEnginePromptPost } from '../utils/enginePath'
import { NITRO_API_PATHS, NITRO_API_PREFIXES } from '../lib/nitroApiPaths'
import { nativeEngineRoute } from '../native/router'
import { ENGINE_MAIN_PORT, engineHealth } from '../native/engineHealth'
import { readRawBody, setResponseStatus } from 'h3'
import { blockedPromptRefusal, nodeProblemsBody } from '../utils/blockedModels'
import { seedanceReferenceSeconds } from '../utils/graphInputSeconds'
import { GENERATE_3D_RUNNER_ONLY, jsonNamesGenerate3d } from '../../shared/runner/gen3d'
import { jsonNamesRetiredClass, retiredUnparsedResponse } from '../../shared/runner/retired'
import { blockedImageModelInJson } from '../../shared/runner/blockedModels'

/** A refusal for a prompt too large to read (Generate a 3D model, R3.9 fix round 2; an image model that never runs on ComfyUI, R11.4): ComfyUI's 400 shape, no node named. */
function unparsedRefusal(message: string = GENERATE_3D_RUNNER_ONLY): ReturnType<typeof blockedPromptRefusal> {
  return { error: { type: 'value_not_valid', message, details: '', extra_info: {} }, node_errors: {} } as unknown as ReturnType<typeof blockedPromptRefusal>
}

// Paths under PROXY_PREFIXES that should be handled by Nitro routes, not proxied
// — the lists live in their own module so the reachability guard can import the
// real values rather than scrape this file. See server/lib/nitroApiPaths.ts.
//
// These catch the bare `/view` and `/history` spellings only. The aliases
// `/api/view`, `/comfyui/view` and `/api/history` are NOT caught here, so in
// local mode they still fall through to the raw proxy below and reach the
// engine directly (hosted mode gates every spelling through the canonical
// path). Sailor's app doesn't use those spellings.
const NITRO_ROUTE_PREFIXES = ['/view', '/history']

/** Spec ruling 4: an engine-only route asked for while the engine is down. */
const NEEDS_LOCAL_ENGINE_MESSAGE = 'This needs the local engine'

/** The largest local /prompt body parsed for the model check (bytes); a larger one is forwarded unchecked. */
export const PROMPT_CHECK_MAX_BYTES = 8 * 1024 * 1024

/** `/ws` in any of its spellings (`/comfyui/ws`, `/api/ws`, …) — the socket keeps its own handling. */
function isWsPath(p: string): boolean {
  let bare = p.split('?')[0] ?? p
  if (bare === '/comfyui' || bare.startsWith('/comfyui/')) bare = bare.slice('/comfyui'.length) || '/'
  if (bare === '/api' || bare.startsWith('/api/')) bare = bare.slice('/api'.length) || '/'
  return bare === '/ws' || bare.startsWith('/ws/')
}

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

  // Hosted never reaches the engine (R10.9): a hosted path that is not an
  // engine path is not this middleware's to answer.
  if (deployMode() === 'hosted') return

  // Local /prompt (any spelling): a discontinued or runner-only model can't
  // run on ComfyUI, so it is refused here in ComfyUI's own 400 shape
  // (server/utils/blockedModels.ts). Hosted never gets here (R10.9).
  if (isEnginePromptPost(normalizeEnginePath(path), event.method)) {
    // The proxy below buffers the same body (h3 caches it), so reading it here
    // costs no second copy; only parsing it does. Over the cap the check is
    // skipped: the browser has already checked, and ComfyUI's own "Value not
    // in list" is still the last net.
    let prompt: unknown
    let oversized: ReturnType<typeof blockedPromptRefusal> = null
    try {
      const raw = await readRawBody(event, false)
      if (raw && raw.length <= PROMPT_CHECK_MAX_BYTES) prompt = JSON.parse(raw.toString('utf8'))?.prompt
      // Over the cap, Generate a 3D model is still refused (R3.9 fix round 2): ComfyUI would pay for its
      // call and then fail on the answer. Its class is looked for in the text, without parsing it.
      // A retired partner node too (Task R4.1): ComfyUI would bill it through Comfy's account;
      // and a Timeline node (Task R9.1), which only its editor exports, in its own words.
      // Unparsed, whether an output reads it isn't knowable, so it is refused anyway (the safe side).
      else if (raw) {
        const text = raw.toString('utf8')
        // R11.4 fix round 1: an image model with no price yet, or a Recraft SVG model (ComfyUI would pay
        // for the SVG and then fail to decode it), the same way: named in the text, refused unparsed.
        const imageModel = blockedImageModelInJson(text)
        if (jsonNamesGenerate3d(text)) oversized = unparsedRefusal()
        else if (jsonNamesRetiredClass(text)) oversized = retiredUnparsedResponse(text)
        else if (imageModel) oversized = unparsedRefusal(imageModel)
      }
    }
    catch { prompt = undefined }
    const blocked = oversized ?? blockedPromptRefusal(prompt)
      ?? nodeProblemsBody(prompt && typeof prompt === 'object' ? await seedanceReferenceSeconds(prompt as Parameters<typeof seedanceReferenceSeconds>[0]) : [])
    if (blocked) {
      setResponseStatus(event, 400)
      return blocked
    }
  }

  for (const prefix of PROXY_PREFIXES) {
    // Match /view, /view/, /view?query=..., /view/subpath, etc.
    if (path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?')) {
      const target = `http://127.0.0.1:${ENGINE_MAIN_PORT}`
      const backendPath = path.startsWith('/comfyui')
        ? path.replace(/^\/comfyui/, '') || '/'
        : path
      // Spec ruling 4: with the main engine known down (the cached health
      // check, server/native/engineHealth.ts), an engine-only route (/prompt, …)
      // answers a plain 503 rather than h3's 502 from a refused proxy. Local
      // only: hosted returned above (R10.9).
      if (!isWsPath(backendPath) && await engineHealth() === 'down') {
        setResponseStatus(event, 503)
        return { error: NEEDS_LOCAL_ENGINE_MESSAGE }
      }
      // Override the Origin header so ComfyUI's origin-check middleware
      // sees host == origin (both 127.0.0.1:<port>) instead of blocking the
      // Nuxt dev-server port (3000) with a 403.
      return proxyRequest(event, `${target}${backendPath}`, {
        fetchOptions: { headers: { origin: target } },
      })
    }
  }
})
