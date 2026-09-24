/**
 * Stage 6 Task 8 — per-user engine settings + userdata behind the authed proxy.
 *
 * ComfyUI's /settings and /userdata routes are per-user ONLY when the engine
 * runs `--multi-user`: UserManager.get_request_user_id reads the `comfy-user`
 * header and files everything under user/<id>/. Two things have to be true for
 * that to be safe, and these tests pin both:
 *
 *   1. HEADER SPOOF RULE. A client must never supply its own `comfy-user` — the
 *      engine would treat it as identity. The middleware strips any inbound one
 *      in EVERY mode, before any branch, and the ONE legitimate value is set
 *      server-side from the authenticated caller in handleHostedUserScoped.
 *
 *   2. The routes are gated on engineMultiUser(). With the switch OFF (the
 *      default) they stay 403 in hosted — byte-identical to today, and no
 *      shared-dir leak (single-user /userdata would be one shared directory).
 *      With it ON they forward with the server-set header.
 *
 * These drive the REAL middleware (default export) and the REAL
 * handleHostedUserScoped with a faked engine fetch, so they fail against the
 * pre-Task-8 tree rather than describing a new helper.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The cached engine-health check (server/native/engineHealth.ts) is stubbed:
// its 3 s process-wide cache would otherwise carry one test's engine state
// into the next, and a real probe would reach whatever is on :8188. 'up'
// (the default) defers to each test's own fetch stub, as before the check.
const engineHealthState = vi.hoisted(() => ({ value: 'up' as 'up' | 'down' }))
vi.mock('../../server/native/engineHealth', async orig => ({
  ...(await orig() as object),
  engineHealth: async () => engineHealthState.value,
}))
beforeEach(() => { engineHealthState.value = 'up' })

const rawBody = vi.fn(async () => undefined as Buffer | undefined)
const requestHeader = vi.fn((_e: any, _n: string) => undefined as string | undefined)
let lastStatus = 0
const responseHeaders: Record<string, string> = {}
vi.mock('h3', async (orig) => {
  const actual = await orig() as any
  return {
    ...actual,
    readRawBody: (...a: any[]) => rawBody(...(a as [])),
    getRequestHeader: (...a: any[]) => requestHeader(...(a as [any, string])),
    setResponseStatus: (_e: any, s: number) => { lastStatus = s },
    setResponseHeader: (_e: any, k: string, v: string) => { responseHeaders[k] = v },
  }
})

let mode: 'local' | 'hosted' = 'hosted'
let multiUser = true
vi.mock('../../server/utils/deployMode', () => ({
  deployMode: () => mode,
  isHosted: () => mode === 'hosted',
  engineMultiUser: () => multiUser,
}))

const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.createError = (o: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(o.message ?? o.statusMessage) as Error & { statusCode: number }
  err.statusCode = o.statusCode
  return err
}
const proxyRequest = vi.fn(async (_e: any, url: string, _o?: any) => ({ proxiedTo: url }))
g.proxyRequest = proxyRequest

const { handleHostedUserScoped } = await import('../../server/utils/engineGate')
const { hostedEngineDecision, normalizeEnginePath } = await import('../../server/utils/enginePath')
const middleware = (await import('../../server/middleware/comfyui-proxy')).default as any

// A faked engine: any fetch resolves to this settings JSON as bytes.
const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock
function engineReplies(body: unknown, status = 200, contentType = 'application/json') {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  fetchMock.mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => bytes.toString('utf8'),
  })
}

beforeEach(() => {
  mode = 'hosted'
  multiUser = true
  lastStatus = 0
  for (const k of Object.keys(responseHeaders)) delete responseHeaders[k]
  fetchMock.mockReset()
  engineReplies({ 'Comfy.Locale': 'en' })
  proxyRequest.mockClear()
  rawBody.mockReset(); rawBody.mockResolvedValue(undefined)
  requestHeader.mockReset(); requestHeader.mockReturnValue(undefined)
})

/** Build an event; headers is the raw node.req.headers a client sent. */
function ev(path: string, method = 'GET', userId: string | null = 'u1', headers: Record<string, string> = {}) {
  return { path, method, context: userId ? { userId } : {}, node: { req: { headers }, res: {} } }
}

async function via(path: string, method = 'GET', userId: string | null = 'u1', headers: Record<string, string> = {}) {
  const event = ev(path, method, userId, headers)
  try {
    const res = await middleware(event)
    return { event, res, status: lastStatus, forwarded: fetchMock.mock.calls[0], proxied: proxyRequest.mock.calls[0] }
  }
  catch (e: any) {
    return { event, status: e?.statusCode ?? 'threw', message: e?.message }
  }
}

// -------------------------------------------------------------- the decision

describe('hostedEngineDecision: settings + userdata are userScoped', () => {
  it('routes GET/POST/DELETE on every prefix + verb the engine serves', () => {
    for (const [p, m] of [
      ['/settings', 'GET'], ['/settings', 'POST'],
      ['/settings/Comfy.Locale', 'GET'], ['/settings/Comfy.Locale', 'POST'],
      ['/userdata', 'GET'],
      ['/userdata/workflows%2Fa.json', 'GET'], ['/userdata/a.json', 'POST'], ['/userdata/a.json', 'DELETE'],
      ['/userdata/a.json/move/b.json', 'POST'],
      ['/v2/userdata', 'GET'], ['/v2/userdata?path=x', 'GET'],
    ] as const) {
      expect(hostedEngineDecision(p, m).kind, `${m} ${p}`).toBe('userScoped')
    }
  })

  it('refuses a verb the routes do not serve (e.g. PUT)', () => {
    for (const p of ['/settings', '/userdata/a.json', '/v2/userdata']) {
      expect(hostedEngineDecision(p, 'PUT').kind, p).toBe('forbid')
    }
  })

  it('decides on the NORMALIZED path so /api + /comfyui aliases cannot walk past it', () => {
    for (const p of [
      '/api/settings', '/comfyui/settings', '/comfyui/api/settings',
      '/api/userdata', '/comfyui/userdata/a.json', '/comfyui/api/v2/userdata',
      '/api/v2/userdata',
    ]) {
      expect(hostedEngineDecision(normalizeEnginePath(p), 'GET').kind, p).toBe('userScoped')
    }
    // a dot segment must not smuggle a userdata path elsewhere
    expect(hostedEngineDecision(normalizeEnginePath('/extensions/../settings'), 'GET').kind).toBe('userScoped')
  })

  it('normalizeEnginePath collapses each alias to the canonical prefix', () => {
    expect(normalizeEnginePath('/api/settings')).toBe('/settings')
    expect(normalizeEnginePath('/comfyui/settings/Comfy.Locale')).toBe('/settings/Comfy.Locale')
    expect(normalizeEnginePath('/api/userdata?dir=x')).toBe('/userdata?dir=x')
    expect(normalizeEnginePath('/comfyui/api/v2/userdata')).toBe('/v2/userdata')
    // a longer sibling is NOT the engine route
    expect(normalizeEnginePath('/api/settingsx')).toBe('/api/settingsx')
  })
})

// ---------------------------------------------------- header spoof, all modes

describe('HEADER SPOOF RULE: inbound comfy-user is stripped before any branch', () => {
  it('drops a client-supplied comfy-user in HOSTED before the forward', async () => {
    const r = await via('/comfyui/settings', 'GET', 'u1', { 'comfy-user': 'victim' })
    expect('comfy-user' in (r.event.node.req.headers as any), 'inbound header must be gone').toBe(false)
    // and the forward carries the SERVER value, not the spoof
    expect(r.forwarded?.[1]?.headers?.['comfy-user']).toBe('u1')
  })

  it('drops it in LOCAL too, even though it is inert there (single-user engine)', async () => {
    mode = 'local'
    const r = await via('/comfyui/settings', 'GET', 'u1', { 'comfy-user': 'victim', 'x-keep': '1' })
    expect('comfy-user' in (r.event.node.req.headers as any)).toBe(false)
    // every OTHER header survives — the strip is surgical
    expect((r.event.node.req.headers as any)['x-keep']).toBe('1')
  })

  it('never sends the client value even when NO authenticated user set it', async () => {
    // a spoof with a real caller must resolve to the CALLER, not the spoof
    const r = await via('/api/userdata?dir=w', 'GET', 'u2', { 'comfy-user': 'u1' })
    expect(r.forwarded?.[1]?.headers?.['comfy-user']).toBe('u2')
  })
})

// ------------------------------------------------------ hosted forward + gate

describe('handleHostedUserScoped: forwards with the server-set comfy-user', () => {
  it('forwards GET /settings to the engine with comfy-user = the caller', async () => {
    const r = await via('/comfyui/settings', 'GET', 'u1')
    expect(r.forwarded?.[0]).toBe('http://127.0.0.1:8188/settings')
    expect(r.forwarded?.[1]?.headers?.['comfy-user']).toBe('u1')
    expect(r.forwarded?.[1]?.headers?.origin).toBe('http://127.0.0.1:8188')
    expect(r.status).toBe(200)
    expect(Buffer.isBuffer(r.res)).toBe(true)
    expect(JSON.parse((r.res as Buffer).toString('utf8'))).toEqual({ 'Comfy.Locale': 'en' })
  })

  it('forwards a POST body verbatim under the original content-type', async () => {
    rawBody.mockResolvedValue(Buffer.from('{"Comfy.Locale":"fr"}'))
    requestHeader.mockImplementation((_e: any, n: string) => (n === 'content-type' ? 'application/json' : undefined))
    engineReplies('', 200, 'text/plain')
    const r = await via('/comfyui/settings/Comfy.Locale', 'POST', 'u1')
    expect(r.forwarded?.[1]?.method).toBe('POST')
    expect(r.forwarded?.[1]?.headers?.['comfy-user']).toBe('u1')
    expect(r.forwarded?.[1]?.headers?.['content-type']).toBe('application/json')
    expect((r.forwarded?.[1]?.body as Buffer)?.toString('utf8')).toBe('{"Comfy.Locale":"fr"}')
  })

  it('keeps ?comfyWorker=N pointed at the pool worker', async () => {
    const r = await via('/comfyui/settings?comfyWorker=2', 'GET', 'u1')
    expect(r.forwarded?.[0]).toBe('http://127.0.0.1:8191/settings')
  })

  it('an unauthenticated caller is refused 401 before any engine contact', async () => {
    const r = await via('/comfyui/settings', 'GET', null)
    expect(r.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('with the multi-user switch OFF the routes stay 403 (no shared-dir leak)', async () => {
    multiUser = false
    for (const [p, m] of [['/comfyui/settings', 'GET'], ['/api/userdata?dir=w', 'GET'], ['/comfyui/userdata/a.json', 'POST']] as const) {
      const r = await via(p, m, 'u1')
      expect(r.status, `${m} ${p}`).toBe(403)
    }
    expect(fetchMock, 'engine never touched when disabled').not.toHaveBeenCalled()
  })
})

// -------------------------------------------------------- local byte-identity

describe('LOCAL: settings + userdata raw-proxy exactly as before', () => {
  it('proxies /comfyui/settings to the backend unchanged (never the hosted gate)', async () => {
    mode = 'local'
    const r = await via('/comfyui/settings', 'GET', 'u1')
    expect(r.proxied?.[1]).toBe('http://127.0.0.1:8188/settings')
    expect(fetchMock, 'the hosted userScoped forward must not run in local').not.toHaveBeenCalled()
  })

  it('proxies /userdata and /v2/userdata unchanged', async () => {
    mode = 'local'
    const a = await via('/comfyui/userdata/a.json', 'GET', 'u1')
    expect(a.proxied?.[1]).toBe('http://127.0.0.1:8188/userdata/a.json')
  })
})
