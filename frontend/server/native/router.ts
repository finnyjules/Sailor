/**
 * The native engine dispatcher: the one list of `/sailor/*` paths Sailor now
 * serves itself instead of proxying to ComfyUI.
 *
 * `nativeEngineRoute(event)` answers a request it owns and returns undefined
 * for everything else, so the proxy middleware can call it first and fall
 * through. It serves the route table ComfyUI's aiohttp served — same paths
 * (under every engine spelling: `/x`, `/api/x`, `/comfyui/x`,
 * `/comfyui/api/x`), same verbs, same bodies and status codes, including
 * aiohttp's own plain-text 404 and 405 inside the owned namespaces.
 *
 * It does NO ownership checking. Local mode is single-user and calls it
 * directly; hosted mode reaches it only through `handleHostedSailor`
 * (server/utils/engineGate.ts), after the tenant gate has decided.
 */
import { createError, getRequestHeader, readRawBody, setResponseHeader, setResponseStatus, type H3Event } from 'h3'
import { userDir } from './paths'
import {
  generationsListRoute,
  generationsPostRoute,
  projectDeleteRoute,
  projectGetRoute,
  projectPutRoute,
  projectsListRoute,
  spendSummaryRoute,
  versionGetRoute,
  versionsPostRoute,
  type ProjectsContext,
  type RouteResult,
} from './projects'

/** Namespaces served natively, boundary-matched. Everything else is proxied. */
export const NATIVE_ENGINE_PREFIXES = ['/sailor/projects', '/sailor/spend']

/** Request bodies are whole workflow graphs; ComfyUI's aiohttp cap was 100 MB. */
export const NATIVE_MAX_BODY_BYTES = 100 * 1024 * 1024

export interface NativeResult extends RouteResult {
  /** A plain-text body (aiohttp's own 404/405/500 pages). */
  text?: boolean
}

function isNative(p: string): boolean {
  return NATIVE_ENGINE_PREFIXES.some(pre => p === pre || p.startsWith(`${pre}/`))
}

/**
 * The canonical native path for a request path, or null when the path is not
 * native. Dot segments are folded first (as the hosted gate's
 * normalizeEnginePath does), then one leading `/comfyui` and one leading
 * `/api` are removed — ComfyUI served every route under `/api` as well, and
 * the proxy strips `/comfyui`. The query string is dropped.
 */
export function nativeEnginePath(rawPath: string): string | null {
  const q = rawPath.indexOf('?')
  let p = q === -1 ? rawPath : rawPath.slice(0, q)
  try { p = new URL(p, 'http://x').pathname }
  catch { return null }
  if (p === '/comfyui' || p.startsWith('/comfyui/')) p = p.slice('/comfyui'.length) || '/'
  if (p.startsWith('/api/') && isNative(p.slice('/api'.length))) p = p.slice('/api'.length)
  return isNative(p) ? p : null
}

/**
 * Decode one path segment the way aiohttp fills `match_info`: percent escapes
 * are decoded, except an encoded `/` (yarl keeps `%2F` as-is), and a malformed
 * escape stays literal.
 */
function decodeSegment(seg: string): string {
  try { return decodeURIComponent(seg.replace(/%2f/gi, '%252F')) }
  catch { return seg }
}

type Handler =
  | { name: 'list' | 'spend' }
  | { name: 'projectGet' | 'projectPut' | 'projectDelete' | 'versionsPost' | 'generationsPost' | 'generationsList', uuid: string }
  | { name: 'versionGet', uuid: string, vid: string }

type Match = { kind: 'route', handler: Handler } | { kind: 'notFound' } | { kind: 'badMethod' }

/** The aiohttp route table from nodes_sailor_projects.py. HEAD is served as GET, like aiohttp's add_get. */
function matchRoute(p: string, method: string): Match {
  const verb = method === 'HEAD' ? 'GET' : method
  const byVerb = (table: Record<string, Handler>): Match => {
    const h = table[verb]
    return h ? { kind: 'route', handler: h } : { kind: 'badMethod' }
  }
  if (p === '/sailor/spend/summary') return byVerb({ GET: { name: 'spend' } })
  if (p === '/sailor/projects') return byVerb({ GET: { name: 'list' } })
  if (!p.startsWith('/sailor/projects/')) return { kind: 'notFound' }

  const segs = p.slice('/sailor/projects/'.length).split('/')
  if (segs.some(s => s === '')) return { kind: 'notFound' }
  const [uuid, sub, vid] = segs.map(decodeSegment) as [string, string?, string?]
  if (segs.length === 1) {
    return byVerb({
      GET: { name: 'projectGet', uuid },
      PUT: { name: 'projectPut', uuid },
      DELETE: { name: 'projectDelete', uuid },
    })
  }
  if (segs.length === 2 && sub === 'versions') return byVerb({ POST: { name: 'versionsPost', uuid } })
  if (segs.length === 2 && sub === 'generations') {
    return byVerb({ POST: { name: 'generationsPost', uuid }, GET: { name: 'generationsList', uuid } })
  }
  if (segs.length === 3 && sub === 'versions') return byVerb({ GET: { name: 'versionGet', uuid, vid: vid! } })
  return { kind: 'notFound' }
}

const text = (status: number, body: string): NativeResult => ({ status, body, text: true })

function context(): ProjectsContext | null {
  const dir = userDir()
  return dir ? { userDir: dir, now: () => Date.now() } : null
}

const NO_DATA_FOLDER: NativeResult = {
  status: 503,
  body: { error: 'Sailor can\'t find its data folder. Set SAILOR_ENGINE_ROOT to the folder that holds input/, output/ and user/.' },
}

/** Read and parse a JSON request body the way aiohttp's `request.json()` does. */
async function readJsonBody(event: H3Event): Promise<{ ok: true, value: unknown } | { ok: false, result: NativeResult }> {
  const declared = Number(getRequestHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > NATIVE_MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, message: 'Request body exceeds the 100 MB limit' })
  }
  const raw = await readRawBody(event, false)
  if (raw && raw.length > NATIVE_MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, message: 'Request body exceeds the 100 MB limit' })
  }
  const source = raw ? Buffer.from(raw).toString('utf8') : ''
  try {
    return { ok: true, value: JSON.parse(source) }
  }
  catch (e) {
    const detail = source.trim() === '' ? 'Expecting value: line 1 column 1 (char 0)' : (e as Error).message
    return { ok: false, result: { status: 400, body: { error: `bad json: ${detail}` } } }
  }
}

function run(ctx: ProjectsContext, h: Handler, body: unknown): RouteResult {
  switch (h.name) {
    case 'list': return projectsListRoute(ctx)
    case 'spend': return spendSummaryRoute(ctx)
    case 'projectGet': return projectGetRoute(ctx, h.uuid)
    case 'projectPut': return projectPutRoute(ctx, h.uuid, body)
    case 'projectDelete': return projectDeleteRoute(ctx, h.uuid)
    case 'versionsPost': return versionsPostRoute(ctx, h.uuid, body)
    case 'versionGet': return versionGetRoute(ctx, h.uuid, h.vid)
    case 'generationsPost': return generationsPostRoute(ctx, h.uuid, body)
    case 'generationsList': return generationsListRoute(ctx, h.uuid)
  }
}

/** A handler failure answers what aiohttp answered for an unhandled exception. */
function guarded(fn: () => RouteResult, where: string): NativeResult {
  try {
    return fn()
  }
  catch (e) {
    console.error(`[native] ${where} failed`, e)
    return text(500, '500 Internal Server Error\n\nServer got itself in trouble')
  }
}

/**
 * Serve a native request and return `{ status, body }`, or undefined when the
 * path is not native. Used by the hosted gate, which sets the status itself.
 */
export async function dispatchNative(event: H3Event): Promise<NativeResult | undefined> {
  const p = nativeEnginePath(event.path)
  if (!p) return undefined
  const match = matchRoute(p, (event.method || 'GET').toUpperCase())
  if (match.kind === 'notFound') return text(404, '404: Not Found')
  if (match.kind === 'badMethod') return text(405, '405: Method Not Allowed')

  const ctx = context()
  if (!ctx) return NO_DATA_FOLDER

  const h = match.handler
  let body: unknown
  if (h.name === 'projectPut' || h.name === 'versionsPost' || h.name === 'generationsPost') {
    const parsed = await readJsonBody(event)
    if (!parsed.ok) return parsed.result
    body = parsed.value
  }
  return guarded(() => run(ctx, h, body), `${event.method} ${p}`)
}

/** The middleware entry: answer a native request (status + body), or undefined to fall through. */
export async function nativeEngineRoute(event: H3Event): Promise<unknown | undefined> {
  const r = await dispatchNative(event)
  if (!r) return undefined
  setResponseStatus(event, r.status)
  if (r.text) setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return r.body
}

/**
 * POST /sailor/projects/{uuid}/generations without HTTP — the runner's
 * generation records. The body goes through a JSON round trip first so it
 * holds exactly what the HTTP post used to send (undefined fields dropped).
 */
export async function nativeGenerationPost(uuid: string, body: unknown): Promise<RouteResult> {
  const ctx = context()
  if (!ctx) return NO_DATA_FOLDER
  const sent = JSON.parse(JSON.stringify(body ?? null))
  return guarded(() => generationsPostRoute(ctx, uuid, sent), 'generation record')
}
