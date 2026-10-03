/**
 * Hosted tenant gates for shared-engine endpoints (Stage 5 Task 5). Pure
 * filters + thin h3 handlers. Local mode never reaches any of this —
 * comfyui-proxy and the history/view routes call these ONLY under
 * deployMode() === 'hosted'.
 */
import path from 'node:path'
import type { H3Event } from 'h3'
import { createError, getRequestHeader, readRawBody, setResponseHeader, setResponseStatus } from 'h3'
import { ownedOutputKeys, ownedPromptIds, ownsPrompt, outputKey, pendingRuns } from './graphRuns'
import { ENGINE_MAIN_PORT } from '../native/engineHealth'
import { settleGraphSuccess } from './meterGraphRun'
import { assertCanonicalMultipart, parseUploadForm } from './multipart'
import { canonicalUploadKey, engineDirForType, ownedInputFilenames, recordUpload, releaseUpload, unsafeUploadTarget, uploadExistsOnDisk, uploadOwner } from './inputUploads'
import { bakeFolderAbandoned } from '../runner/shaderBakeFiles'
import { normalizeEnginePath } from './enginePath'
import { hostedCanMutate, ownedIds, ownerOf, recordOwner, releaseOwner } from './resourceOwners'
import { annotatedFilepath, isSafeId, pyBasename, userDir } from '../native/paths'
import { decodeSegment, dispatchNative, dispatchUpload, nativeEnginePath } from '../native/router'
import { INPUT_FOLDER_INPUTS, findSpec, matchObjectInfoRoute, objectInfoBody, setComboOptions, storedObjectInfoBody, withModelOverlay } from '../native/objectInfo'
import { ensureBootMigrationsRan, listProjects, projectsRoot } from '../native/projects'

// Review C2's exact mirror of folder_paths.annotated_filepath() lives in
// server/native/paths.ts now, shared with the native /view and mask upload.
export { annotatedFilepath }

export type ViewGate =
  | { kind: 'ungated' }
  | { kind: 'reject', status: number, message: string }
  | { kind: 'check', key: string }

/**
 * The hosted /view decision, resolved the way the engine resolves it:
 * annotation first, `type` only as the fallback, basename last (server.py
 * does `os.path.basename(filename)` after joining the subfolder).
 */
export function viewGateDecision(q: { filename: string, type?: string, subfolder?: string }): ViewGate {
  // The engine's second resolution mode: `blake3:<hash>` goes through the
  // asset store, never through (type, subfolder, filename) — there is no key
  // to check ownership against, so hosted refuses it rather than guessing.
  if (q.filename.startsWith('blake3:')) {
    return { kind: 'reject', status: 400, message: 'Hashed asset reads are not available in hosted mode' }
  }
  const { name, type: annotated } = annotatedFilepath(q.filename)
  const effective = annotated ?? (q.type || 'output')
  // type=temp / type=input stay ungated this stage (documented gap) — but
  // only when that is what the engine will ACTUALLY read.
  if (effective !== 'output') return { kind: 'ungated' }
  // The native resolver's own basename rule (POSIX: `/` only), so the key
  // checked is the file served — `x\mine.png` is its own file, not `mine.png`.
  const basename = pyBasename(name)
  return { kind: 'check', key: outputKey({ filename: basename, subfolder: q.subfolder || '', type: 'output' }) }
}

/**
 * Review M5: allowlist, don't spread. The old `{ ...queue, ... }` forwarded
 * every OTHER top-level key ComfyUI puts on /queue — and every key a future
 * ComfyUI adds — to every tenant unfiltered. Only the two filtered arrays
 * leave this function.
 */
export function filterQueuePayload(queue: any, owned: Set<string>): any {
  const keep = (entries: any[]) => (Array.isArray(entries) ? entries : []).filter(e => owned.has(String(e?.[1])))
  return { queue_running: keep(queue?.queue_running), queue_pending: keep(queue?.queue_pending) }
}

/**
 * Review M4: prompt ids are keys here, and a key of `__proto__` assigned onto
 * a `{}` literal walks the prototype setter instead of adding a property —
 * mutating Object.prototype for the whole process. Null-prototype output plus
 * an explicit skip of the three magic names.
 */
const HOSTILE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function filterHistoryPayload(hist: Record<string, any>, owned: Set<string>): Record<string, any> {
  const out: Record<string, any> = Object.create(null)
  for (const [id, entry] of Object.entries(hist ?? {})) {
    if (HOSTILE_KEYS.has(id)) continue
    if (owned.has(id)) out[id] = entry
  }
  return out
}

export async function handleHostedQueueGet(event: H3Event): Promise<any> {
  const userId = event.context.userId
  if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })
  const res = await fetch(`http://127.0.0.1:${ENGINE_MAIN_PORT}/queue`)
  if (!res.ok) throw createError({ statusCode: 502, message: 'Engine queue unavailable' })
  return filterQueuePayload(await res.json(), await ownedPromptIds(userId))
}

export async function handleHostedInterrupt(event: H3Event): Promise<any> {
  const userId = event.context.userId
  if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })
  const target = `http://127.0.0.1:${ENGINE_MAIN_PORT}`
  const qres = await fetch(`${target}/queue`)
  const queue = qres.ok ? await qres.json() : {}
  const running = Array.isArray(queue?.queue_running) ? queue.queue_running : []
  const runningId = running.length ? String(running[0]?.[1]) : null
  if (!runningId || !(await ownsPrompt(userId, runningId))) {
    throw createError({ statusCode: 403, message: 'No interruptible run of yours is active' })
  }
  // Review M2: between the read above and this POST the running job can turn
  // over to a victim's run, and a bare /interrupt cancels whatever is running
  // NOW. ComfyUI's interrupt accepts a prompt_id and no-ops unless that id is
  // the executing one, which closes the window.
  const res = await fetch(`${target}/interrupt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: target },
    body: JSON.stringify({ prompt_id: runningId }),
  })
  setResponseStatus(event, res.status)
  // Review M3: `null` makes h3 send an empty body, so a client doing
  // res.json() on a 200 gets a parse error instead of a success.
  return { ok: true }
}

// ---------------------------------------------------------------------------
// F2 — /object_info leaks every tenant's uploaded filenames.
// ---------------------------------------------------------------------------

/**
 * The option keys ComfyUI marks a file-picker widget with. Verified against a
 * live catalog (864 nodes): these four are the complete set, and the 11 inputs
 * carrying them are EXACTLY the 11 that embed real input-directory filenames —
 * traced by probing the catalog for known uploads, not by reading names.
 * Model/checkpoint/LoRA combos carry none of them and are shared assets
 * anyway, so they survive untouched.
 */
export const UPLOAD_FLAG_KEYS = ['image_upload', 'video_upload', 'audio_upload', 'file_upload']

function declaresUploadWidget(opts: unknown): boolean {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) return false
  return UPLOAD_FLAG_KEYS.some(k => Boolean((opts as Record<string, unknown>)[k]))
}

/**
 * Refill the filename list on one input spec with the CALLER's own uploaded
 * filenames, in place, leaving every other byte of it alone.
 *
 * ComfyUI serves upload widgets in TWO shapes and a hosted scrubber that
 * knows only the documented one still leaks three node families:
 *
 *   legacy  ["<file>", "<file>", …], { image_upload: true }]   LoadImage, …
 *   v2      ["COMBO", { options: ["<file>", …], audio_upload: true }]
 *
 * A third shape carries the flag but no inline list and needs no scrubbing:
 * Painter is ["STRING", {...}], and LoadImageOutput points the client at
 * `remote: { route: "/internal/files/output" }` — already a hosted 403.
 *
 * The `image_upload` flag itself is PRESERVED: the frontend keys its upload
 * button off it, and the point is to hide other tenants' filenames, not to
 * take the widget away.
 *
 * `ownedFilenames` is spread into a fresh array at each call site rather than
 * assigned by reference — two specs on the same node (or two nodes) must not
 * end up sharing one mutable array.
 */
function scrubUploadSpec(spec: unknown[], ownedFilenames: string[]): void {
  if (Array.isArray(spec[0])) spec[0] = [...ownedFilenames]
  const opts = spec[1]
  if (opts && typeof opts === 'object' && Array.isArray((opts as Record<string, unknown>).options)) {
    ;(opts as Record<string, unknown>).options = [...ownedFilenames]
  }
  // R3: emptying the list is not enough. ComfyUI seeds `default` with the
  // FIRST entry of that same directory listing, so AudioWaveform.audio_file
  // shipped the alphabetically-first filename in the shared input dir to every
  // tenant with the options stripped. Stage 6: the default becomes the
  // caller's own first-owned filename (or '' if they own nothing) — same
  // reasoning as ComfyUI's own seeding, scoped to what the caller can see.
  if (opts && typeof opts === 'object' && typeof (opts as Record<string, unknown>).default === 'string') {
    ;(opts as Record<string, unknown>).default = ownedFilenames[0] ?? ''
  }
}

/**
 * Replace the shared input-directory listing in an /object_info response
 * with the CALLER's own uploaded filenames.
 *
 * `ownedFilenames` defaults to `[]` — an omitted second argument (every
 * pre-Task-6 call site, and every test that doesn't care about refilling)
 * empties the pickers exactly as the Stage 5 scrubber did, so "no known
 * ownership" fails to the same safe, no-leak behavior it always had.
 *
 * Everything else must survive byte-identical — direct execution's
 * graphToPrompt validates against these schemas client-side, so a scrubber
 * that drops or reorders node definitions breaks every hosted render.
 * Mutates a structured clone; key insertion order is preserved by JS for the
 * non-numeric keys ComfyUI uses.
 */
export function scrubObjectInfo(catalog: unknown, ownedFilenames: string[] = []): unknown {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return catalog
  const out = structuredClone(catalog) as Record<string, any>
  for (const node of Object.values(out)) {
    const input = node?.input
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue
    for (const section of Object.values(input)) {
      if (!section || typeof section !== 'object' || Array.isArray(section)) continue
      for (const spec of Object.values(section as Record<string, unknown>)) {
        if (Array.isArray(spec) && declaresUploadWidget(spec[1])) scrubUploadSpec(spec, ownedFilenames)
      }
    }
  }
  // A5 fix round 1: the dataset folder pickers list input/'s SUBFOLDERS —
  // shared across tenants, and carrying no upload flag, so the rule above
  // misses them. Hosted doesn't offer dataset folders; they are emptied.
  for (const key of INPUT_FOLDER_INPUTS) setComboOptions(findSpec(out, key), [], false)
  return out
}

/**
 * Stage 6 Task 7 — the `ClassType.inputName` pairs whose widget embeds a file
 * from a shared engine directory, harvested from the SAME object_info catalog
 * the scrubber reads (`declaresUploadWidget` over `UPLOAD_FLAG_KEYS`). This is
 * the map the graph-file-reference validator consults to decide which inputs
 * carry a filename it must vet for ownership before a graph runs. Pure over the
 * catalog — the caller caches it (~60s) so a submission doesn't refetch it.
 *
 * NOTE `LoadImageOutput.image` is deliberately NOT here: its widget is
 * remote-routed (`remote: {route: "/internal/files/output"}`, nodes.py:1951-
 * 1959) rather than upload-flagged, so it never carries an UPLOAD_FLAG_KEYS
 * key — the validator adds that pair by hand.
 */
export function collectUploadFlaggedInputs(catalog: unknown): Set<string> {
  const out = new Set<string>()
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return out
  for (const [className, node] of Object.entries(catalog as Record<string, any>)) {
    const input = node?.input
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue
    for (const section of Object.values(input)) {
      if (!section || typeof section !== 'object' || Array.isArray(section)) continue
      for (const [inputName, spec] of Object.entries(section as Record<string, unknown>)) {
        if (Array.isArray(spec) && declaresUploadWidget(spec[1])) out.add(`${className}.${inputName}`)
      }
    }
  }
  return out
}

/**
 * Stage 6 Task 7 — LoadImageOutput's picker is remote-routed to
 * `/internal/files/output`; the rest of `/internal` is a cross-tenant
 * enumeration oracle and stays 403 (enginePath.ts). Here the caller sees ONLY
 * their OWN outputs, served from `graph_runs`, in the SAME flat JSON array of
 * filename strings the engine's route returns (api_server/routes/internal/
 * internal_routes.py:54-70) so the remote combo renders. Because outputs now
 * land in `output/u_<hash>/...`, each entry carries its per-user subfolder
 * (`<subfolder>/<filename>`) — the value the widget submits then resolves under
 * that subfolder and is re-checked for ownership by the graph validator.
 */
export async function handleHostedOutputListing(event: H3Event): Promise<string[]> {
  const userId = event.context.userId
  if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })
  const owned = await ownedOutputKeys(userId)
  const names: string[] = []
  for (const key of owned) {
    // key === `<type>:<subfolder>:<filename>` (outputKey) — subfolder/filename
    // never contain a colon, so split on the first two.
    const first = key.indexOf(':')
    if (first < 0) continue
    const second = key.indexOf(':', first + 1)
    if (second < 0) continue
    const type = key.slice(0, first)
    if (type !== 'output') continue
    const subfolder = key.slice(first + 1, second)
    const filename = key.slice(second + 1)
    if (!filename) continue
    names.push(subfolder ? `${subfolder}/${filename}` : filename)
  }
  names.sort()
  return names
}

export async function handleHostedObjectInfo(event: H3Event): Promise<unknown> {
  const userId = event.context.userId
  if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })
  const p = nativeEnginePath(event.path)
  const match = p ? matchObjectInfoRoute(p, 'GET', decodeSegment) : null
  if (!p || match?.kind !== 'route') throw createError({ statusCode: 404, message: 'Not Found' })
  // Engine-free Phase A (A5): the engine's catalog while it answers, else the
  // saved copy / committed baseline refreshed from disk (objectInfo.ts).
  // The ownership lookup and the catalog are independent, so they run in
  // parallel.
  const [owned, got] = await Promise.all([
    ownedInputFilenames(userId),
    objectInfoBody(event.path, p, match.node),
  ])
  // An engine answer JSON.parse refuses (Python's NaN/Infinity) can't be
  // scrubbed, so hosted serves the stored catalog instead of the raw text.
  const served = got?.body ? got : storedObjectInfoBody(match.node)
  if (!served?.body) throw createError({ statusCode: 502, message: 'Engine object_info unavailable' })
  // Sorted for a stable `default` (ComfyUI itself seeds default from the
  // alphabetically-first directory entry — this mirrors that ordering scoped
  // to the caller's own files) and for deterministic tests.
  const ownedFilenames = Array.from(owned).sort()
  // Sailor's model menus go on after the scrub, which still applies.
  return withModelOverlay(scrubObjectInfo(served.body, ownedFilenames) as Record<string, any>)
}

// ---------------------------------------------------------------------------
// F4 — cross-tenant overwrite via /upload.
// ---------------------------------------------------------------------------

/**
 * The hosted upload body cap (R4). The gate has to hold the whole body to
 * inspect it and write the same parsed form, so the size has to be bounded
 * somewhere — `proxyRequest` used to stream it and never did.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/**
 * VERIFIED in ComfyUI's server.py image_upload(): without a truthy `overwrite`
 * the handler loops `while os.path.exists(filepath)` and auto-suffixes
 * `name (1).png`, `name (2).png`, … so the upload can never clobber a file it
 * did not write. WITH it the write is unconditional — and the input directory
 * is shared across tenants until per-tenant dirs land in Stage 6.
 *
 * The engine's test is `overwrite == "true" or overwrite == "1"` on the exact
 * string. Ours trims and lowercases first, so every value the engine honours is
 * inside the set we gate, plus a few it would ignore. Erring wide here costs at
 * most a refusal of an upload the engine would have auto-suffixed anyway.
 */
export function isOverwriteValue(v: string): boolean {
  const s = v.trim().toLowerCase()
  return s === 'true' || s === '1'
}

/**
 * Field names as the ENGINE will read them.
 *
 * aiohttp un-escapes backslashes inside a quoted Content-Disposition parameter
 * and undici does not, so `name="over\write"` is the field `over\write` to our
 * parser and `overwrite` to the engine — a body that parses cleanly on both
 * sides and still means different things. Un-escaping (plus trim/lowercase,
 * since aiohttp accepts `NAME=`) collapses that gap. Everything ELSE aiohttp
 * tolerates and undici refuses never gets this far: the parse fails and the
 * body is rejected with a 400 rather than written.
 */
export function normalizeFieldName(raw: string): string {
  return raw.replace(/\\(.)/g, '$1').trim().toLowerCase()
}

/**
 * The whole overwrite rule: it is yours, or it is nobody's.
 *
 * A name with no ownership row that already exists on disk is NOT free — every
 * upload that predates the table is unclaimed, and treating unclaimed as free
 * would hand back exactly the cross-tenant clobber this gate exists to stop.
 *
 * `existsOnDisk === null` (S2) means the engine root couldn't be resolved —
 * the disk answer is UNKNOWN, not "nothing's there". Ownership still decides
 * outright when there's an owner; only the "nobody claims it" branch needs
 * the disk answer, and an unknown answer there fails CLOSED exactly like a
 * known `true` would.
 */
export function decideOverwrite(userId: string, owner: string | null, existsOnDisk: boolean | null): boolean {
  if (owner !== null) return owner === userId
  if (existsOnDisk === null) return false
  return !existsOnDisk
}

/**
 * F4 (round 3) — /upload is ownership-scoped rather than overwrite-free.
 *
 * The body is PARSED for inspection, and (engine-free Phase A) the SAME parsed
 * form is then written natively (server/native/uploads.ts) — the form the gate
 * checked is the form that is written, so no second parser can read it
 * differently. Ownership is then recorded from the write's response, because
 * the name stored may be an auto-suffixed `shot (1).png` rather than the one
 * that was asked for.
 */
export async function handleHostedUpload(event: H3Event): Promise<unknown> {
  const userId = event.context.userId
  if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })

  // Controller ruling (A4 fix 1): a mask upload copies whatever file its
  // `original_ref` names — any tenant's output — under the caller's name. The
  // app never uses it, so hosted refuses it outright, before the body is read.
  if (nativeEnginePath(event.path) === '/upload/mask') {
    throw createError({ statusCode: 403, message: 'Mask uploads are not available in hosted mode' })
  }

  // Refuse an over-cap upload from its declared length, BEFORE buffering it.
  // A lying Content-Length is caught again on the buffer below.
  const declared = Number(getRequestHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw createError({ statusCode: 413, message: 'Upload exceeds the 100 MB limit' })
  }

  // Read ONCE, as a Buffer. This is proxy middleware, so the request stream is
  // still unconsumed here — but it is single-shot, and proxyRequest is no
  // longer downstream of us to re-read it. The form parsed from it is the one
  // written below.
  const body = await readRawBody(event, false)
  if (body && body.length > MAX_UPLOAD_BYTES) {
    throw createError({ statusCode: 413, message: 'Upload exceeds the 100 MB limit' })
  }

  const contentType = getRequestHeader(event, 'content-type')
  // LC3: the part headers must be in the one shape every real client sends
  // BEFORE undici reads them. Which non-canonical spellings undici refuses
  // changes with the Node version (Node 26's undici 8 accepts `name= "x"` and
  // `name*=utf-8''x`), so that cannot be the defence; this check is.
  assertCanonicalMultipart(body ?? Buffer.alloc(0), contentType || '')
  const form = await parseUploadForm(body ?? Buffer.alloc(0), contentType || 'application/octet-stream')

  // A backslash in a part NAME is the last place the two parsers can disagree
  // about what a body says: undici keeps `sub\folder` as written, aiohttp
  // un-escapes it to `subfolder` and reads the field we never looked at. That
  // would let a request pass the gate on one path and be written to another. No
  // client sends one, so the whole class is refused rather than emulated.
  if (form.names().some(n => n.includes('\\'))) {
    throw createError({ statusCode: 400, message: 'Upload field names are not addressable' })
  }

  // Scan every text part rather than looking one key up: duplicates, casing and
  // ordering are all decided by the engine's parser, not ours, so ANY part that
  // reads as a truthy `overwrite` puts the request on the gated path.
  const overwrite = form.textEntries()
    .some(([name, value]) => normalizeFieldName(name) === 'overwrite' && isOverwriteValue(value))
  const subfolder = form.text('subfolder')
  const type = form.text('type') || 'input'

  // R11.9c fix round 2 (N3): a Shader effect bake's folder (shader_bake/…) takes only the bake's own frames,
  // `shader_bake_<32 hex>.png`: nothing else (a `.claimed` marker, another file) can be put into one.
  const bakeTarget = path.posix.normalize((subfolder ?? '').trim().replace(/\\/g, '/') || '.').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (bakeTarget === 'shader_bake' || bakeTarget.startsWith('shader_bake/')) {
    const name = (await form.file('image'))?.filename || ''
    if (!/^shader_bake_[0-9a-f]{32}\.png$/.test(name)) {
      throw createError({ statusCode: 400, message: 'Only a shader’s own frames can be uploaded there' })
    }
    // Fix round 3 (B2): a bake given up (Stop, a failure) takes no more frames.
    const inputRoot = engineDirForType('input')
    if (inputRoot && await bakeFolderAbandoned(inputRoot, bakeTarget)) {
      throw createError({ statusCode: 409, message: 'This shader’s frames were given up. Run it again.' })
    }
  }

  if (overwrite) {
    const file = await form.file('image')
    const filename = file?.filename || ''
    if (!filename) {
      throw createError({ statusCode: 400, message: 'An overwriting upload must carry a named file' })
    }
    if (unsafeUploadTarget(subfolder, filename)) {
      throw createError({ statusCode: 400, message: 'Upload path is not addressable' })
    }
    // S1: the same canonicalization the record below uses — a raw `type` or
    // `subfolder` alias (`bogus`, `.`) must resolve to the identical key an
    // earlier canonical-form upload was recorded under, or the lookup below
    // silently misses an owner that actually exists.
    const key = canonicalUploadKey(type, subfolder, filename)
    const owner = await uploadOwner(key)
    const onDisk = uploadExistsOnDisk(type, subfolder, filename)
    // S2: no owner AND the disk answer is unknown (engine root unresolved) —
    // this is a server misconfiguration, not an ownership conflict. Named
    // separately so the response doesn't lie about why the write was refused.
    if (owner === null && onDisk === null) {
      throw createError({
        statusCode: 403,
        message: 'Upload refused: the server could not resolve its engine input directory '
          + '(configuration issue) — this is not an ownership conflict',
      })
    }
    if (!decideOverwrite(userId, owner, onDisk)) {
      throw createError({
        statusCode: 403,
        message: `${filename} already belongs to another account — upload it under a different name`,
      })
    }
  }

  // Any spelling of the path (`/api/…`, `/comfyui/…`, a query) names the
  // same two routes.
  const p = nativeEnginePath(event.path) ?? event.path.split('?')[0]!
  const res = await dispatchUpload(p, (event.method || 'POST').toUpperCase(), form)
  setResponseStatus(event, res.status)
  if (res.text) setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  const parsed = res.body

  if (res.status >= 200 && res.status < 300) {
    const stored = parsed as { name?: unknown, subfolder?: unknown, type?: unknown }
    if (typeof stored?.name === 'string' && stored.name) {
      // Record what was ACTUALLY stored — the engine auto-suffixes on collision,
      // and recording the requested name would claim a file we do not hold.
      // A failure here is logged, not thrown: the write already happened, and a
      // missing row fails CLOSED (an unclaimed name that exists on disk is
      // refused to everyone) rather than opening the file to the next caller.
      const key = canonicalUploadKey(
        typeof stored.type === 'string' && stored.type ? stored.type : 'input',
        typeof stored.subfolder === 'string' ? stored.subfolder : '',
        stored.name,
      )
      try {
        await recordUpload(userId, key)
      }
      catch (e) {
        console.error('[engineGate] failed to record upload ownership', { key, error: e })
      }
    }
  }
  return parsed
}

const MAIN_ENGINE = `http://127.0.0.1:${ENGINE_MAIN_PORT}`
const HARVEST_CAP = 20

/**
 * Review I5: /view calls harvestPendingOutputs on EVERY ownership miss. One
 * page of 40 not-yet-settled thumbnails fired 40 harvests, each polling up to
 * HARVEST_CAP history endpoints — ~800 engine requests from a single page
 * load, all racing to do the identical work. One harvest per user per window
 * is enough: the second caller's answer would be the first's anyway.
 */
const HARVEST_TTL_MS = 3000
const lastHarvest = new Map<string, number>()

export function __resetHarvestMemoForTests(): void { lastHarvest.clear() }

/** Pure: has this user been harvested inside the window ending at `now`? */
export function harvestIsFresh(last: number | undefined, now: number): boolean {
  return last !== undefined && now - last < HARVEST_TTL_MS
}

/**
 * /view race-window fallback: the client saw the WS 'executed' event a beat
 * before the settle watcher (settleOnCompletion, polling every 2s) recorded
 * this run's outputs into graph_runs. Rather than reimplement settlement,
 * this re-polls the same main-engine history endpoint the watcher uses and
 * calls the SAME settleGraphSuccess exported from meterGraphRun.ts — one
 * settlement implementation, two callers.
 */
export async function harvestPendingOutputs(userId: string): Promise<void> {
  const now = Date.now()
  if (harvestIsFresh(lastHarvest.get(userId), now)) return
  lastHarvest.set(userId, now)

  // Ordering and the cap both live in SQL now (review I3) — an unordered
  // LIMIT picked an arbitrary 20, so a user with a backlog of stale pendings
  // could have their just-finished run fall outside the harvest window.
  const pending = await pendingRuns(userId, HARVEST_CAP)
  for (const { promptId, holdId, credits, target } of pending) {
    // Review I4: poll the engine this run was DISPATCHED to. Pre-migration
    // rows carry no target and are main-engine runs by construction.
    const engine = target ?? MAIN_ENGINE
    try {
      const res = await fetch(`${engine}/history/${encodeURIComponent(promptId)}`)
      if (!res.ok) continue
      const hist = await res.json() as Record<string, any>
      const status = hist[promptId]?.status
      if (status?.status_str === 'success' && status.completed) {
        await settleGraphSuccess(engine, promptId, holdId, credits)
      }
    } catch (e) {
      console.error('[engineGate] harvest failed for pending run', { promptId, error: e })
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 6 Task 2 — /sailor projects are per-tenant.
// ---------------------------------------------------------------------------

/**
 * The projects extension (comfy_extras/nodes_sailor_projects.py) reads the
 * project uuid out of the path and serves it. Its ONLY check is `_is_safe_id`
 * — path traversal — because the store predates accounts entirely: there is no
 * identity in the request and none on disk. Hosted ownership therefore has to
 * be decided here, against the resource_owners registry, before the engine is
 * ever asked.
 *
 * PROJECTS ARE PERSONAL. Stage 6's "a record with no owner row is curated
 * content: readable by all" rule (resourceOwners.hostedCanRead) deliberately
 * does NOT apply: an unowned project is somebody's orphaned saved work, not
 * house content. Unowned reads and deletes 404 like anyone else's. The single
 * thing an unowned uuid permits is the WRITE that creates it — that is how a
 * new project is born, and the same write against an OWNED uuid is refused.
 *
 * Refusals are 404, never 403: a 403 confirms the uuid exists, which turns the
 * gate into an enumeration oracle for exactly the ids it protects.
 */
export type SailorRoute =
  | { kind: 'list' }
  | { kind: 'project', uuid: string, access: 'read' | 'write' | 'delete' }
  | { kind: 'reject', status: number, message: string }

const PROJECTS_PREFIX = '/sailor/projects'

/**
 * `_is_safe_id` from nodes_sailor_projects.py — the one shared guard
 * (server/native/paths.ts) the native project storage also uses. An id the
 * storage would refuse can never legitimately be owned, so it is refused here
 * too.
 */
export function isSafeProjectId(value: string): boolean {
  return isSafeId(value)
}

/**
 * The path/verb table, taken from the aiohttp routes themselves rather than
 * from what the frontend happens to call. Anything the engine does not serve
 * is refused here — an unexpected verb or an unknown subroute must never fall
 * through to a raw proxy.
 *
 * Segments are percent-DECODED first because aiohttp matches and fills
 * `match_info` from the decoded path: `%76ersions` is the versions route to
 * the engine, and `%70-abc` is the same project on disk as `p-abc`. Keying
 * ownership off the raw spelling would let an encoded alias walk past the
 * owner check on its way to the identical file.
 */
export function sailorProjectsRoute(pathNoQuery: string, method: string): SailorRoute {
  const verb = (method || 'GET').toUpperCase()
  const reject = (status: number, message: string): SailorRoute => ({ kind: 'reject', status, message })
  const badVerb = reject(405, 'This method is not available on Sailor projects')
  const notFound = reject(404, 'Not found')

  if (pathNoQuery !== PROJECTS_PREFIX && !pathNoQuery.startsWith(PROJECTS_PREFIX + '/')) return notFound

  const raw = pathNoQuery.slice(PROJECTS_PREFIX.length).split('/').filter(Boolean)
  const segs: string[] = []
  for (const s of raw) {
    let decoded: string
    try {
      decoded = decodeURIComponent(s)
    }
    catch {
      return reject(400, 'Project path is not addressable')
    }
    segs.push(decoded)
  }

  if (segs.length === 0) return verb === 'GET' ? { kind: 'list' } : badVerb

  const uuid = segs[0]!
  if (!isSafeProjectId(uuid)) return reject(400, 'Project id is not addressable')

  if (segs.length === 1) {
    if (verb === 'GET') return { kind: 'project', uuid, access: 'read' }
    if (verb === 'PUT') return { kind: 'project', uuid, access: 'write' }
    if (verb === 'DELETE') return { kind: 'project', uuid, access: 'delete' }
    return badVerb
  }

  if (segs.length === 2) {
    // POST .../versions and POST .../generations both call ensure_project
    // upstream, so they CREATE a project as readily as PUT does — same rule.
    if (segs[1] === 'versions') return verb === 'POST' ? { kind: 'project', uuid, access: 'write' } : badVerb
    if (segs[1] === 'generations') {
      if (verb === 'POST') return { kind: 'project', uuid, access: 'write' }
      if (verb === 'GET') return { kind: 'project', uuid, access: 'read' }
      return badVerb
    }
    return notFound
  }

  if (segs.length === 3 && segs[1] === 'versions') {
    if (!isSafeProjectId(segs[2]!)) return reject(400, 'Version id is not addressable')
    return verb === 'GET' ? { kind: 'project', uuid, access: 'read' } : badVerb
  }

  return notFound
}

/**
 * The index is rebuilt from the caller's own ownership rows — allowlist, never
 * spread (Stage 5 review M5): only `projects` leaves this function, so a key
 * the extension adds later cannot ride out unfiltered.
 */
async function listOwnedProjects(userId: string): Promise<unknown> {
  const dir = userDir()
  if (!dir) throw createError({ statusCode: 503, message: 'Sailor can\'t find its data folder' })
  // Carried from the A1 fix: this reads projectsRoot(dir) directly rather than
  // going through dispatchNative/context() (which already calls this), so it
  // needs its own boot-migration call — otherwise a still-comfynext-named user
  // dir, or a project file with un-migrated comfynext_* keys, is read before
  // either migration has ever run for this base.
  ensureBootMigrationsRan(dir)
  const owned = await ownedIds('project', userId)
  const list = listProjects(projectsRoot(dir))
  return { projects: list.filter(e => owned.has(String(e.uuid))) }
}

export async function handleHostedSailor(event: H3Event): Promise<unknown> {
  const userId = event.context.userId
  if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })

  const [pathNoQuery] = normalizeEnginePath(event.path).split('?')
  const route = sailorProjectsRoute(pathNoQuery ?? '', event.method)
  if (route.kind === 'reject') throw createError({ statusCode: route.status, message: route.message })
  if (route.kind === 'list') return listOwnedProjects(userId)

  const owner = await ownerOf('project', route.uuid)
  // Same 404 for "owned by someone else" and "does not exist" — the caller
  // must not be able to tell those apart.
  const missing = () => createError({ statusCode: 404, message: 'Project not found' })
  if (route.access === 'read' || route.access === 'delete') {
    if (owner !== userId) throw missing()
  }
  else if (owner !== null && !hostedCanMutate(owner, userId)) {
    throw missing()
  }

  // Engine-free Phase A: the projects are served from Sailor's own copy of
  // the storage (server/native/projects.ts), same files as the Python — only
  // ever AFTER the ownership decision above.
  const native = await dispatchNative(event)
  if (!native) throw missing()
  const { status, body } = native
  setResponseStatus(event, status)
  if (native.text) setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  const wrote = status >= 200 && status < 300

  // Claim only what the STORAGE actually created: a refused write must not
  // leave an ownership row pointing at a project that does not exist.
  if (wrote && route.access === 'write' && owner === null) {
    try {
      await recordOwner('project', route.uuid, userId)
    }
    catch (e) {
      // The write already happened; a missing row fails CLOSED (the project is
      // invisible and unreadable to everyone, including its author, until the
      // next save re-claims it) rather than exposing it.
      console.error('[engineGate] failed to record project ownership', { uuid: route.uuid, error: e })
    }
  }
  if (wrote && route.access === 'delete') {
    try {
      await releaseOwner('project', route.uuid)
    }
    catch (e) {
      // Harmless the other way round: the row outlives a deleted project and
      // keeps the uuid claimed by its author, which no one else can use.
      console.error('[engineGate] failed to release project ownership', { uuid: route.uuid, error: e })
    }
  }
  return body
}

// ---------------------------------------------------------------------------
// Stage 6 Task 2b — the per-user /sailor DATA routes (files + timeline assets).
// ---------------------------------------------------------------------------

/**
 * Timeline assets live in a SINGLE global user/timeline_assets.json with no
 * owner field, so the resource_owners registry (kind 'timeline-asset', id =
 * the asset uuid) IS the owner. Assets are PERSONAL like projects: an unowned
 * asset is orphaned, not house content, so it is invisible in the list and
 * 404s on every access — the same 404 for "yours doesn't exist" and "someone
 * else's" so the gate can't be used to enumerate ids.
 */
export const SAILOR_ASSET_KIND = 'timeline-asset'

export type SailorDataRoute =
  | { kind: 'inputListing' }
  | { kind: 'outputListing' }
  | { kind: 'assetsList' }
  | { kind: 'assetImport' }
  | { kind: 'assetDelete', assetId: string }
  | { kind: 'assetThumbnails', assetId: string }
  | { kind: 'assetWaveform', assetId: string }
  | { kind: 'inputThumbnail', filename: string }
  | { kind: 'inputFileDelete', filename: string }
  | { kind: 'outputFileDelete', filename: string, subfolder: string }
  | { kind: 'reject', status: number, message: string }

/**
 * The exact path/verb table for the DATA bucket, parsed from the aiohttp
 * routes themselves. Query params (`filename`, `subfolder`, `asset_id`) are
 * read the way the engine reads them — decoded, via URLSearchParams — so the
 * ownership key we build names the same file the engine will touch. An
 * unexpected verb is refused here rather than falling through to a raw proxy.
 */
export function sailorDataRoute(pathNoQuery: string, query: string, method: string): SailorDataRoute {
  const verb = (method || 'GET').toUpperCase()
  const q = new URLSearchParams(query)
  const reject = (status: number, message: string): SailorDataRoute => ({ kind: 'reject', status, message })
  const badVerb = reject(405, 'This method is not available on this Sailor route')

  if (pathNoQuery === '/sailor/input_listing') return verb === 'GET' ? { kind: 'inputListing' } : badVerb
  if (pathNoQuery === '/sailor/output_listing') return verb === 'GET' ? { kind: 'outputListing' } : badVerb
  if (pathNoQuery === '/sailor/assets') return verb === 'GET' ? { kind: 'assetsList' } : badVerb
  if (pathNoQuery === '/sailor/asset_import') return verb === 'POST' ? { kind: 'assetImport' } : badVerb
  if (pathNoQuery.startsWith('/sailor/assets/')) {
    let assetId: string
    try {
      assetId = decodeURIComponent(pathNoQuery.slice('/sailor/assets/'.length))
    }
    catch {
      return reject(400, 'Asset id is not addressable')
    }
    // matchMediaRoute (server/native/media.ts) 404s a decoded id carrying a
    // '/' or '\\' — an encoded separator that would otherwise let a DELETE
    // reach a different file than the one this gate just checked ownership
    // of. Refuse it here the same way, same status, so the two routers can
    // never disagree about which id a request names.
    if (assetId.includes('/') || assetId.includes('\\')) return reject(404, 'Not found')
    return verb === 'DELETE' ? { kind: 'assetDelete', assetId } : badVerb
  }
  if (pathNoQuery === '/sailor/asset_thumbnails') return verb === 'GET' ? { kind: 'assetThumbnails', assetId: q.get('asset_id') || '' } : badVerb
  if (pathNoQuery === '/sailor/asset_waveform') return verb === 'GET' ? { kind: 'assetWaveform', assetId: q.get('asset_id') || '' } : badVerb
  if (pathNoQuery === '/sailor/input_thumbnail') return verb === 'GET' ? { kind: 'inputThumbnail', filename: q.get('filename') || '' } : badVerb
  if (pathNoQuery === '/sailor/input_file') return verb === 'DELETE' ? { kind: 'inputFileDelete', filename: q.get('filename') || '' } : badVerb
  if (pathNoQuery === '/sailor/output_file') return verb === 'DELETE' ? { kind: 'outputFileDelete', filename: q.get('filename') || '', subfolder: q.get('subfolder') || '' } : badVerb

  return reject(404, 'Not found')
}

/**
 * The per-user DATA gate. Reads are filtered to the caller's owned files/
 * assets; deletes and metadata reads are ownership-checked and 404 when the
 * resource is not the caller's (no existence disclosure), with the ENGINE
 * NEVER TOUCHED on a miss. Everything past the ownership decision is served
 * by the native media library (server/native/media.ts); a video/audio request
 * it hands on to the engine keeps the same worker and normalized path, with no
 * client-supplied identity headers.
 */
export async function handleHostedSailorData(event: H3Event): Promise<unknown> {
  const userId = event.context.userId
  if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })

  const [pathNoQuery, query = ''] = normalizeEnginePath(event.path).split('?')
  const route = sailorDataRoute(pathNoQuery ?? '', query, event.method)
  if (route.kind === 'reject') throw createError({ statusCode: route.status, message: route.message })

  // Same 404 for "unowned/other-owned" and "does not exist" — no oracle.
  const notFound = () => createError({ statusCode: 404, message: 'Not found' })

  // Engine-free Phase A: the data routes are served by Sailor's own port of
  // the media library (server/native/media.ts), same files as the Python —
  // only ever AFTER the ownership decision for the route.
  const serve = async (): Promise<{ status: number, body: unknown }> => {
    const r = await dispatchNative(event)
    if (!r) throw notFound()
    setResponseStatus(event, r.status)
    if (r.text) setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
    for (const [k, v] of Object.entries(r.headers ?? {})) setResponseHeader(event, k, v)
    return r
  }
  const forwardJson = async (unavailable: string): Promise<{ status: number, body: unknown }> => {
    const r = await dispatchNative(event)
    if (!r || r.status < 200 || r.status >= 300) throw createError({ statusCode: 502, message: unavailable })
    return r
  }

  switch (route.kind) {
    case 'inputListing': {
      const { body } = await forwardJson('Engine input listing unavailable')
      const owned = await ownedInputFilenames(userId)
      const items = Array.isArray((body as { items?: unknown })?.items) ? (body as { items: unknown[] }).items : []
      return { items: items.filter(it => owned.has(String((it as { filename?: unknown })?.filename ?? ''))) }
    }
    case 'outputListing': {
      const { body } = await forwardJson('Engine output listing unavailable')
      const owned = await ownedOutputKeys(userId)
      const items = Array.isArray((body as { items?: unknown })?.items) ? (body as { items: unknown[] }).items : []
      return {
        items: items.filter((it) => {
          const o = it as { filename?: unknown, subfolder?: unknown }
          return owned.has(outputKey({ filename: String(o?.filename ?? ''), subfolder: String(o?.subfolder ?? ''), type: 'output' }))
        }),
      }
    }
    case 'assetsList': {
      const { body } = await forwardJson('Engine assets list unavailable')
      const owned = await ownedIds(SAILOR_ASSET_KIND, userId)
      const list = Array.isArray((body as { assets?: unknown })?.assets) ? (body as { assets: unknown[] }).assets : []
      return { assets: list.filter(a => owned.has(String((a as { id?: unknown })?.id ?? ''))) }
    }
    case 'assetImport': {
      // The engine (comfy_extras/nodes_timeline.py) reads `path` from the JSON
      // body, uses an ABSOLUTE path verbatim and joins a relative one onto
      // input_dir with NO `..`/normpath rejection, then probes+reads the file
      // and mints an asset the CALLER owns pointing at it — which
      // asset_thumbnails/asset_waveform then render back. Left ungated a tenant
      // imports `/etc/hostname` or `../other-tenant-file`, becomes the owner of
      // the forged asset, and reads arbitrary host files back through the
      // ownership-checked media routes. So the import must name an input file
      // the caller ALREADY owns; the engine is NEVER touched otherwise.
      //
      // Buffer the body ONCE and validate it before serving. readRawBody
      // caches on the request, so the native import below reads the very
      // same bytes (no second network-observable read of a mutated stream).
      const raw = await readRawBody(event, false)
      let importPath: unknown
      try {
        importPath = raw ? (JSON.parse(raw.toString('utf8')) as { path?: unknown }).path : undefined
      }
      catch {
        throw createError({ statusCode: 400, message: 'Asset import body must be JSON' })
      }
      if (typeof importPath !== 'string' || !importPath) {
        throw createError({ statusCode: 400, message: "Asset import requires a 'path'" })
      }
      // Reject the RAW path as absolute/unsafe before it is ever split into
      // subfolder+basename. A depth-1 absolute path like `/app` splits to
      // subfolder='' + basename='app' — unsafeUploadTarget('', 'app') only
      // catches an absolute path when the SUBFOLDER carries the leading `/`,
      // so a one-segment path slipped past that check while `os.path.isabs`
      // in the engine still reads it at filesystem root. Checked independent
      // of the split so every depth of absolute path is caught here.
      if (importPath.startsWith('/') || /^[a-zA-Z]:/.test(importPath) || importPath.split('/').some(seg => seg === '..')) {
        throw createError({ statusCode: 400, message: 'Asset import path is not addressable' })
      }
      // The engine treats `path` as `os.path.join(input_dir, path)` — dirname is
      // the subfolder, basename the file. unsafeUploadTarget is the second gate:
      // the same class again on the split pieces, plus the backslash
      // parser-disagreement check — 400 for a malformed/escaping path.
      const slash = importPath.lastIndexOf('/')
      const subfolder = slash >= 0 ? importPath.slice(0, slash) : ''
      const basename = slash >= 0 ? importPath.slice(slash + 1) : importPath
      if (unsafeUploadTarget(subfolder, basename)) {
        throw createError({ statusCode: 400, message: 'Asset import path is not addressable' })
      }
      // Well-formed but must be the caller's OWN input file. 404 (no existence
      // disclosure) when it is not theirs — the same discipline as the other
      // data routes. canonicalUploadKey names the identical key the upload gate
      // recorded, so a top-level or a nested owned file both resolve here.
      const importOwner = await uploadOwner(canonicalUploadKey('input', subfolder, basename))
      if (importOwner !== userId) throw notFound()

      // A NEW asset has no owner to check — this write is how one is born.
      // Record what the engine ACTUALLY stored (its `asset.id`) on a 2xx; a
      // duplicate import returns the existing record, and recordOwner's
      // first-owner-wins leaves that asset with its original owner.
      const { status, body } = await serve()
      if (status >= 200 && status < 300) {
        const id = (body as { asset?: { id?: unknown } })?.asset?.id
        if (typeof id === 'string' && id) {
          try {
            await recordOwner(SAILOR_ASSET_KIND, id, userId)
          }
          catch (e) {
            console.error('[engineGate] failed to record asset ownership', { id, error: e })
          }
        }
      }
      return body
    }
    case 'assetDelete': {
      const owner = await ownerOf(SAILOR_ASSET_KIND, route.assetId)
      if (owner !== userId) throw notFound()
      const { status, body } = await serve()
      if (status >= 200 && status < 300) {
        try {
          await releaseOwner(SAILOR_ASSET_KIND, route.assetId)
        }
        catch (e) {
          console.error('[engineGate] failed to release asset ownership', { id: route.assetId, error: e })
        }
      }
      return body
    }
    case 'assetThumbnails':
    case 'assetWaveform': {
      if (!route.assetId) throw createError({ statusCode: 400, message: 'missing asset_id' })
      const owner = await ownerOf(SAILOR_ASSET_KIND, route.assetId)
      if (owner !== userId) throw notFound()
      const { status, body } = await serve()
      return body
    }
    case 'inputThumbnail': {
      if (!route.filename) throw notFound()
      const owned = await ownedInputFilenames(userId)
      if (!owned.has(route.filename)) throw notFound()
      return (await serve()).body
    }
    case 'inputFileDelete': {
      if (!route.filename) throw createError({ statusCode: 400, message: 'invalid filename' })
      const fileKey = canonicalUploadKey('input', '', route.filename)
      const owner = await uploadOwner(fileKey)
      if (owner !== userId) throw notFound()
      const { status, body } = await serve()
      if (status >= 200 && status < 300) {
        try {
          await releaseUpload(fileKey)
        }
        catch (e) {
          console.error('[engineGate] failed to release input upload ownership', { filename: route.filename, error: e })
        }
      }
      return body
    }
    case 'outputFileDelete': {
      if (!route.filename) throw createError({ statusCode: 400, message: 'invalid filename' })
      const owned = await ownedOutputKeys(userId)
      if (!owned.has(outputKey({ filename: route.filename, subfolder: route.subfolder, type: 'output' }))) throw notFound()
      const { status, body } = await serve()
      return body
    }
  }
  // Unreachable — sailorDataRoute returns a reject for everything else.
  throw notFound()
}

// ---------------------------------------------------------------------------
// Stage 6 Task 8 — per-user engine settings + userdata (ComfyUI --multi-user).
// ---------------------------------------------------------------------------

/**
 * The buffer ceiling for a settings/userdata write. Same reasoning as the
 * upload and sailor gates: the body is held to forward the identical bytes, so
 * it needs an explicit cap (proxyRequest streamed and never had one).
 */
export const MAX_USERSCOPED_BYTES = 100 * 1024 * 1024

/** The verbs that carry a body onto these routes (POST /userdata/{file}, its /move, POST /settings). */
const USERSCOPED_BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

/**
 * Forward a settings/userdata request to the engine with a SERVER-SET
 * `comfy-user` header — the authenticated caller's id — and NOTHING
 * client-supplied. The middleware has already stripped any inbound
 * `comfy-user` (the spoof rule), and this is the ONE place the real one is
 * set, so a client can never inject another tenant's id.
 *
 * The response is returned byte-verbatim (a Buffer + the engine's
 * content-type), not round-tripped through JSON: userdata GET serves a raw
 * FileResponse that JSON.parse would mangle, and settings GET is already JSON
 * that survives as bytes. The `/comfyui`-prefixed path is normalized the way
 * the raw proxy would.
 *
 * NOTE this only yields per-user isolation when the engine runs `--multi-user`
 * AND the caller's id is a registered engine user (users.json). Without that,
 * ComfyUI returns "default" (single-user) or 401s (multi-user, unregistered).
 * The middleware gates activation on engineMultiUser(); registration is a
 * documented follow-up (see the Task 8 report).
 */
export async function handleHostedUserScoped(event: H3Event): Promise<unknown> {
  const userId = event.context.userId
  if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })

  const target = `http://127.0.0.1:${ENGINE_MAIN_PORT}`
  const enginePath = normalizeEnginePath(event.path)
  const method = (event.method || 'GET').toUpperCase()

  // origin override for the engine's origin-check middleware; comfy-user is the
  // authenticated caller, NEVER anything from the inbound request.
  const headers: Record<string, string> = { origin: target, 'comfy-user': userId }
  let body: Buffer | undefined

  if (USERSCOPED_BODY_METHODS.has(method)) {
    const declared = Number(getRequestHeader(event, 'content-length'))
    if (Number.isFinite(declared) && declared > MAX_USERSCOPED_BYTES) {
      throw createError({ statusCode: 413, message: 'Request body exceeds the 100 MB limit' })
    }
    const raw = await readRawBody(event, false)
    if (raw && raw.length > MAX_USERSCOPED_BYTES) {
      throw createError({ statusCode: 413, message: 'Request body exceeds the 100 MB limit' })
    }
    body = raw ?? undefined
    const contentType = getRequestHeader(event, 'content-type')
    if (contentType) headers['content-type'] = contentType
  }

  const res = await fetch(`${target}${enginePath}`, { method, headers, body: body as any })
  setResponseStatus(event, res.status)
  const ct = res.headers?.get?.('content-type')
  if (ct) setResponseHeader(event, 'content-type', ct)
  return Buffer.from(await res.arrayBuffer())
}
