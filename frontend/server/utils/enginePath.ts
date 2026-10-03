/**
 * Stage 5 review C1 — canonical engine-path normalization.
 *
 * ComfyUI's server.py registers every route TWICE: once at `path` and once at
 * `"/api" + path`. Sailor's proxy adds a third form by stripping a leading
 * `/comfyui` (the API base SettingsModal talks to). So one engine endpoint has
 * up to four spellings reaching this Nitro server:
 *
 *   /queue   /api/queue   /comfyui/queue   /comfyui/api/queue
 *
 * Every hosted tenant gate must decide on ONE of them or the other three are
 * free bypasses. `normalizeEnginePath` collapses the aliases to the canonical
 * engine path.
 *
 * The `/api` strip is deliberately conditional: `/api/*` is ALSO Sailor's own
 * Nitro namespace (`/api/wallet`, `/api/billing/*`, …). Stripping it blindly
 * would make `/api/view` and `/api/viewport` collide. So `/api` is only
 * removed when the remainder matches a known engine route — anything else is
 * returned untouched and continues to Nitro exactly as before.
 *
 * Pure and side-effect free: no env reads, no h3. Local mode calls it too, but
 * every local decision ignores the result (see comfyui-proxy.ts).
 */

/**
 * STAGE 6 TASK 8 — ComfyUI's per-user settings + userdata surfaces. Under
 * `--multi-user` (hosted only, opt-in) the engine reads the `comfy-user`
 * request header in UserManager.get_request_user_id and files these under
 * `user/<id>/`. These MUST also be in ENGINE_ROUTE_PREFIXES below so the
 * `/api/...` mirror spelling collapses to the canonical form like every other
 * engine route (a free bypass otherwise). `/v2/userdata` is listed separately
 * from `/userdata` because the prefix match is boundary-aware: `/userdata`
 * never matches `/v2/userdata`.
 */
export const USER_SCOPED_PREFIXES = ['/settings', '/userdata', '/v2/userdata']

/** Engine routes the `/api` mirror actually serves. Order irrelevant. */
export const ENGINE_ROUTE_PREFIXES = [
  '/prompt',
  '/queue',
  '/interrupt',
  '/history',
  '/view',
  '/upload',
  '/object_info',
  '/system_stats',
  '/internal',
  '/ws',
  '/extensions',
  '/global_subgraphs',
  ...USER_SCOPED_PREFIXES,
]

/** Verbs the settings/userdata aiohttp routes serve (POST covers /userdata/{file}/move/{dest}). */

function splitQuery(path: string): [string, string] {
  const i = path.indexOf('?')
  return i === -1 ? [path, ''] : [path.slice(0, i), path.slice(i)]
}

/**
 * Round-2 review F6 — fold dot segments before anything else looks at the
 * path.
 *
 * Every gate below is a PREFIX match, so `/extensions/../history` would sail
 * past the `/history` refusal on its way to a proxy that hands aiohttp a path
 * aiohttp then folds back to `/history`. Nitro does normalize upstream today,
 * but that is an undocumented invariant of someone else's router, not a
 * property of this function — and it is one dependency bump away from
 * changing. Canonicalizing here makes the guarantee local.
 *
 * The WHATWG parser folds `.`, `..` and their percent-encoded spellings
 * (`%2e`, `%2E`). It does NOT fold an encoded separator (`..%2f`) — correctly,
 * since that is a literal one-segment name to aiohttp too.
 *
 * The ORIGINAL query string is reattached verbatim: `URL.search` re-encodes
 * (`a b.png` becomes `a%20b.png`) and callers forward the raw path, not this
 * one, so the two must not drift.
 */
function canonicalizePath(pathNoQuery: string): string {
  try {
    return new URL(pathNoQuery, 'http://x').pathname
  }
  catch {
    return pathNoQuery
  }
}

/** Boundary-aware prefix match on a query-stripped path. */
export function isEngineRoute(pathNoQuery: string): boolean {
  return ENGINE_ROUTE_PREFIXES.some(p => pathNoQuery === p || pathNoQuery.startsWith(p + '/'))
}

/**
 * Collapse `/comfyui` and `/api` engine-mirror aliases to the canonical engine
 * path. Query strings are preserved verbatim. Non-engine paths (including all
 * of Nitro's own `/api/*` routes) come back unchanged.
 */
export function normalizeEnginePath(path: string): string {
  const [raw, query] = splitQuery(path)
  // F6: fold `.`/`..`/`%2e` FIRST — every check below is a prefix match and
  // would otherwise be walked around by a dot segment.
  let p = canonicalizePath(raw)

  // One leading /comfyui — matches the proxy's own backendPath rewrite.
  if (p === '/comfyui' || p.startsWith('/comfyui/')) {
    p = p.slice('/comfyui'.length) || '/'
  }

  // One leading /api, ONLY when what remains is an engine mirror route.
  if (p.startsWith('/api/') || p === '/api') {
    const rest = p.slice('/api'.length) || '/'
    if (isEngineRoute(rest)) p = rest
  }

  return p + query
}

export type EngineDecision =
  | { kind: 'objectInfo' }
  | { kind: 'emptySubgraphs' }
  | { kind: 'outputListing' }
  | { kind: 'upload' }
  | { kind: 'sailorProjects' }
  | { kind: 'sailorData' }
  | { kind: 'proxy' }
  | { kind: 'notFound' }
  | { kind: 'forbid', message: string }

/**
 * A POST to `/prompt` in any spelling (`/api/prompt`, `/comfyui/prompt`, …),
 * taken on the NORMALIZED path: the local proxy's model check (local only —
 * hosted answers every `/prompt` 404, step 3 R10.9).
 */
export function isEnginePromptPost(enginePath: string, method: string): boolean {
  const [p] = splitQuery(enginePath)
  return match(p, '/prompt') && (method || 'GET').toUpperCase() === 'POST'
}

/**
 * Step 3, R10.9 — hosted never reaches the engine. Each of these is an engine
 * route only ComfyUI serves (running a graph, its queue, Stop, its socket,
 * its history and file mirrors, its internals, gate resume, its stats,
 * front-end extensions, per-user settings and userdata); hosted answers each
 * with a plain 404, in every spelling and verb. The routes hosted still
 * answers are Sailor's own (the node list from the saved copy, uploads,
 * projects and files, the shader/preset/font routes, LoadImageOutput's
 * picker from graph_runs), and none of them asks ComfyUI.
 */
export const HOSTED_ENGINE_ONLY = [
  '/prompt',
  '/queue',
  '/interrupt',
  '/ws',
  '/history',
  '/view',
  '/internal',
  '/gate',
  '/system_stats',
  '/extensions',
  ...USER_SCOPED_PREFIXES,
]

/**
 * Engine paths a hosted tenant may reach RAW, with no per-user filtering:
 * none (step 3, R10.9). Hosted never reaches the engine, so `/system_stats`,
 * `/extensions` and `/ws` left this list and answer 404 (HOSTED_ENGINE_ONLY).
 * Kept, empty, as the record of that rule: an entry here would be a path the
 * hosted proxy forwards to ComfyUI, and there is no such path any more.
 *
 * ROUND-2 LESSON (still the rule for anything ever added) — an entry here is
 * a claim about what the HANDLER does, not about what the path looks like.
 */
export const HOSTED_RAW_ALLOW: readonly string[] = []

function match(pathNoQuery: string, prefix: string): boolean {
  return pathNoQuery === prefix || pathNoQuery.startsWith(prefix + '/')
}

/**
 * STAGE 6 TASK 2b — the `/sailor` extension routes, bucketed by a HANDLER
 * AUDIT rather than by how the path reads. This is the round-2 allowlist
 * lesson applied a third time: `/sailor` LOOKED like Sailor's own namespace,
 * so nobody read the ~27 non-project handlers, and Task 2's fallback
 * (`match(p,'/sailor') => proxy`) raw-proxied every one of them cross-tenant.
 * Each list below is a claim about what the upstream handler READS and WRITES,
 * verified against comfy_extras/{nodes_timeline,_lora_training,
 * _model_downloads,nodes_compositor,nodes_shader_effects}.py. The coverage
 * guard in sailor-routes-gate.unit.spec.ts greps those modules and FAILS if a
 * route classifies as `unknown` — a newly-added `/sailor` route fails the
 * suite instead of silently proxying.
 *
 * `classifySailor` is the single source of truth; `hostedEngineDecision`
 * below is a thin map from its bucket onto an EngineDecision.
 */
export type SailorBucket = 'projects' | 'spend' | 'data' | 'proxy' | 'refuse' | 'unknown'

/**
 * PER-USER DATA. Reads are filtered to the caller's owned files/assets and
 * writes/deletes are ownership-checked (404 when unowned — no existence
 * disclosure). `handleHostedSailorData` re-derives the exact route. The
 * `/sailor/assets` prefix deliberately also covers DELETE
 * `/sailor/assets/{asset_id}`; `asset_import`, `asset_thumbnails` and
 * `asset_waveform` are distinct sibling names, not `assets/` subpaths.
 */
export const SAILOR_DATA_PREFIXES = [
  '/sailor/input_listing',
  '/sailor/output_listing',
  '/sailor/input_file',
  '/sailor/output_file',
  '/sailor/input_thumbnail',
  '/sailor/assets',
  '/sailor/asset_import',
  '/sailor/asset_thumbnails',
  '/sailor/asset_waveform',
]

/**
 * STATELESS shared catalog / capability — safe to raw-proxy in hosted, EACH
 * entry audited against its handler:
 *   /sailor/shader_effects (+ /assets/{name})  reads the bundled shader dir; no writes, no per-user data.
 *   /sailor/space_defaults / space_thumbnails   read the operator-seeded shared preset dir (read-only listing).
 *   /sailor/font_subset                          pure fn: base64 font in → subsetted base64 out, touches no disk.
 * NOTE space_thumbnail/{id} is handled by VERB in classifySailor: GET reads a
 * shared thumb (proxy), POST writes one (refuse) — so it is NOT a flat prefix
 * here.
 */
export const HOSTED_SAILOR_PROXY = [
  '/sailor/shader_effects',
  '/sailor/space_defaults',
  '/sailor/space_thumbnails',
  '/sailor/font_subset',
]

const SPACE_THUMB_WRITE_MSG = 'Space preset thumbnails are operator content in hosted mode'

/**
 * COMPUTE / SHARED-STATE WRITE — refused this stage (fail closed; per-user
 * versions are later work). Each writes to shared engine disk or spends
 * compute that will be metered later. `verb` narrows the two routes whose
 * refusal is method-specific (space_default/{id} POST; space_thumbnail/{id}
 * POST is refused in classifySailor's verb branch above the proxy list).
 * The engine's Timeline render routes (Task R9.3) and its video encode route
 * (Task R10.4) and the model-bundle routes (Task R10.5) are no longer
 * listed: nothing in Sailor calls them, so in hosted they fall to `unknown`
 * and are refused by default.
 */
const SAILOR_REFUSE: { prefix: string, verb?: string, message: string }[] = [
  { prefix: '/sailor/motion', message: 'Frame cleanup is not available in hosted mode — it deletes from the shared input directory' },
  { prefix: '/sailor/lora', message: 'Dataset writes are not available in hosted mode — they mutate the shared training directory' },
  { prefix: '/sailor/space_default', verb: 'POST', message: 'Space presets are operator content in hosted mode' },
]

/**
 * Classify a NORMALIZED `/sailor` path + method into exactly one bucket.
 * Returns `unknown` for anything unclassified (including non-`/sailor` paths)
 * so callers fail CLOSED. Spend/projects come first because they own the
 * broadest sub-namespaces; data before proxy/refuse because a data prefix can
 * never collide with a capability one; the verb-split for space_thumbnail/{id}
 * sits above the proxy list so its POST is refused rather than proxied.
 */
export function classifySailor(pathNoQuery: string, method: string): { bucket: SailorBucket, message?: string } {
  const p = pathNoQuery
  const verb = (method || 'GET').toUpperCase()
  if (!match(p, '/sailor')) return { bucket: 'unknown' }
  if (match(p, '/sailor/spend')) return { bucket: 'spend' }
  if (match(p, '/sailor/projects')) return { bucket: 'projects' }
  if (SAILOR_DATA_PREFIXES.some(a => match(p, a))) return { bucket: 'data' }
  // space_thumbnail/{id}: GET reads a shared preset thumb, POST writes one.
  // (space_thumbnailS — the plural listing — never matches this prefix.)
  if (match(p, '/sailor/space_thumbnail')) {
    return verb === 'GET' ? { bucket: 'proxy' } : { bucket: 'refuse', message: SPACE_THUMB_WRITE_MSG }
  }
  if (HOSTED_SAILOR_PROXY.some(a => match(p, a))) return { bucket: 'proxy' }
  for (const r of SAILOR_REFUSE) {
    if (match(p, r.prefix) && (!r.verb || r.verb === verb)) return { bucket: 'refuse', message: r.message }
  }
  return { bucket: 'unknown' }
}

/**
 * The single hosted routing decision, taken on the NORMALIZED engine path so
 * `/queue`, `/api/queue`, `/comfyui/queue` and `/comfyui/api/queue` all land
 * on the same branch.
 *
 * Canonical `/history` and `/view` never arrive here — comfyui-proxy returns
 * them to their tenant-scoped Nitro routes before consulting this. Anything
 * that DOES arrive spelled `/history` or `/view` is therefore an alias of the
 * ungated engine mirror, and is refused rather than silently re-routed.
 */
export function hostedEngineDecision(enginePath: string, method: string): EngineDecision {
  const [p] = splitQuery(enginePath)
  const verb = (method || 'GET').toUpperCase()

  // Step 3, R10.9: an engine-only route is a plain 404 — every verb, every
  // spelling. LoadImageOutput's picker (GET /internal/files/output) is the one
  // `/internal` route hosted answers, from graph_runs, never from ComfyUI.
  if (p === '/internal/files/output' && verb === 'GET') return { kind: 'outputListing' }
  if (HOSTED_ENGINE_ONLY.some(a => match(p, a))) return { kind: 'notFound' }

  // F2: needed by the canvas (graphToPrompt reads the node schemas) but the
  // upload-widget combos embed the shared input directory listing, so the
  // response is scrubbed on the way out instead of proxied raw.
  // Step 3, R10.9: served from the saved copy (or the committed baseline),
  // never from ComfyUI; any other verb is the engine's alone.
  if (match(p, '/object_info')) {
    if (verb === 'GET') return { kind: 'objectInfo' }
    return { kind: 'notFound' }
  }

  // Step 3, R10.6 (decision 4): blueprints run only on the local engine, so
  // hosted offers none. The list answers empty here (the canvas then shows no
  // blueprint section); one blueprint by id is refused. ComfyUI is never asked.
  if (match(p, '/global_subgraphs')) {
    if (p === '/global_subgraphs' && (verb === 'GET' || verb === 'HEAD')) return { kind: 'emptySubgraphs' }
    return { kind: 'forbid', message: 'Blueprints are not available in hosted mode' }
  }

  // F4: the upload sink itself stays open, but ComfyUI's image_upload() honours
  // an `overwrite` form field, and the input directory is shared across
  // tenants this stage — so `overwrite=true` with a guessed name is a
  // cross-tenant clobber. Gated in engineGate, not proxied raw.
  if (match(p, '/upload')) {
    if (verb === 'POST') return { kind: 'upload' }
    return { kind: 'forbid', message: 'Only POST /upload is available in hosted mode' }
  }

  // Stage 6 Task 2 — the durable-projects extension trusts its path uuid with
  // zero identity: `_is_safe_id` is the ONLY check between a signed-in tenant
  // and any other tenant's saved graph. Ownership is enforced HERE, in the
  // proxy layer, against the resource_owners registry, because the engine has
  // nowhere to keep it. The spend summary aggregates the whole install's
  // ledger across every project and user — operator data, not tenant data.
  // Stage 6 Task 2b — every `/sailor` route is now classified by a handler
  // audit (classifySailor). Projects keep their dedicated ownership gate;
  // spend stays operator-only; per-user DATA routes are filtered/ownership-
  // checked; audited stateless catalog/capability routes raw-proxy; compute/
  // shared-write routes are refused; and ANYTHING unclassified — a route added
  // upstream since this audit — falls to the deny-by-default forbid rather
  // than silently proxying cross-tenant.
  if (match(p, '/sailor')) {
    const c = classifySailor(p, verb)
    if (c.bucket === 'spend') return { kind: 'forbid', message: 'Spend summary is operator data in hosted mode' }
    if (c.bucket === 'projects') return { kind: 'sailorProjects' }
    if (c.bucket === 'data') return { kind: 'sailorData' }
    if (c.bucket === 'proxy') return { kind: 'proxy' }
    if (c.bucket === 'refuse') return { kind: 'forbid', message: c.message! }
    return { kind: 'forbid', message: 'This Sailor engine route is not available in hosted mode' }
  }

  // R10.9: HOSTED_RAW_ALLOW is empty — nothing else is forwarded to ComfyUI.
  if (HOSTED_RAW_ALLOW.some(a => match(p, a))) return { kind: 'proxy' }
  return { kind: 'notFound' }
}
