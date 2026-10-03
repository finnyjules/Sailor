/**
 * Stage 6 Task 8 — engine settings + userdata behind the authed proxy, as
 * changed by step 3, R10.9 (hosted never reaches the engine).
 *
 *   1. HEADER SPOOF RULE. A client must never supply its own `comfy-user` — the
 *      engine would treat it as identity. The middleware strips any inbound one
 *      in EVERY mode, before any branch.
 *
 *   2. Hosted: /settings, /userdata and /v2/userdata are engine-only routes and
 *      answer a plain 404 in every spelling and verb, whatever the multi-user
 *      switch says — the engine is never asked (the old per-user forward,
 *      handleHostedUserScoped, is deleted).
 *
 *   3. Local: step 4, C5 — there is no engine; a plain 404, as hosted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('hostedEngineDecision: settings + userdata are engine-only (R10.9)', () => {
  it('answers 404 on every prefix and verb', () => {
    for (const [p, m] of [
      ['/settings', 'GET'], ['/settings', 'POST'],
      ['/settings/Comfy.Locale', 'GET'], ['/settings/Comfy.Locale', 'POST'],
      ['/userdata', 'GET'],
      ['/userdata/workflows%2Fa.json', 'GET'], ['/userdata/a.json', 'POST'], ['/userdata/a.json', 'DELETE'],
      ['/userdata/a.json/move/b.json', 'POST'],
      ['/v2/userdata', 'GET'], ['/v2/userdata?path=x', 'GET'],
      ['/settings', 'PUT'], ['/userdata/a.json', 'PUT'], ['/v2/userdata', 'PUT'],
    ] as const) {
      expect(hostedEngineDecision(p, m).kind, `${m} ${p}`).toBe('notFound')
    }
  })

  it('decides on the NORMALIZED path so /api + /comfyui aliases cannot walk past it', () => {
    for (const p of [
      '/api/settings', '/comfyui/settings', '/comfyui/api/settings',
      '/api/userdata', '/comfyui/userdata/a.json', '/comfyui/api/v2/userdata',
      '/api/v2/userdata',
    ]) {
      expect(hostedEngineDecision(normalizeEnginePath(p), 'GET').kind, p).toBe('notFound')
    }
    expect(hostedEngineDecision(normalizeEnginePath('/extensions/../settings'), 'GET').kind).toBe('notFound')
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
  it('drops a client-supplied comfy-user in HOSTED, and nothing is forwarded', async () => {
    const r = await via('/comfyui/settings', 'GET', 'u1', { 'comfy-user': 'victim' })
    expect('comfy-user' in (r.event.node.req.headers as any), 'inbound header must be gone').toBe(false)
    expect(r.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('drops it in LOCAL too, even though it is inert there (single-user engine)', async () => {
    mode = 'local'
    const r = await via('/comfyui/settings', 'GET', 'u1', { 'comfy-user': 'victim', 'x-keep': '1' })
    expect('comfy-user' in (r.event.node.req.headers as any)).toBe(false)
    // every OTHER header survives — the strip is surgical
    expect((r.event.node.req.headers as any)['x-keep']).toBe('1')
  })
})

// ------------------------------------------------------------------ hosted 404

describe('hosted: settings + userdata answer 404 and never reach the engine', () => {
  it('every alias and verb, multi-user switch on or off, signed in or not', async () => {
    for (const on of [true, false]) {
      multiUser = on
      for (const [p, m, u] of [
        ['/comfyui/settings', 'GET', 'u1'], ['/comfyui/settings/Comfy.Locale', 'POST', 'u1'],
        ['/api/userdata?dir=w', 'GET', 'u2'], ['/comfyui/userdata/a.json', 'POST', 'u1'],
        ['/comfyui/userdata/a.json', 'DELETE', 'u1'], ['/api/v2/userdata', 'GET', 'u1'], ['/comfyui/settings', 'GET', null],
      ] as const) {
        const r = await via(p, m, u)
        expect(r.status, `${on} ${m} ${p}`).toBe(404)
      }
      // The bare spellings are not proxy paths at all: this middleware leaves them to Nitro.
      for (const p of ['/settings', '/userdata/a.json']) {
        const r = await via(p, 'GET', 'u1')
        expect(r.res, p).toBeUndefined()
      }
    }
    expect(fetchMock, 'the engine is never asked').not.toHaveBeenCalled()
    expect(proxyRequest, 'nothing is proxied').not.toHaveBeenCalled()
  })

  it('handleHostedUserScoped is gone', async () => {
    expect((await import('../../server/utils/engineGate') as Record<string, unknown>).handleHostedUserScoped).toBeUndefined()
  })
})

// -------------------------------------------------------- local byte-identity

describe('LOCAL: settings + userdata are a plain 404 too (step 4, C5: no engine)', () => {
  it('/comfyui/settings, /userdata and /v2/userdata: 404, never proxied or forwarded', async () => {
    mode = 'local'
    for (const p of ['/comfyui/settings', '/comfyui/userdata/a.json', '/comfyui/api/v2/userdata']) {
      proxyRequest.mockClear()
      const r = await via(p, 'GET', 'u1')
      expect(r.status, p).toBe(404)
      expect(r.proxied, p).toBeUndefined()
    }
    expect(fetchMock, 'nothing is forwarded').not.toHaveBeenCalled()
  })
})
