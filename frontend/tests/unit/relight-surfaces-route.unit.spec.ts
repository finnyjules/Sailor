/**
 * Task 1 (Relight stage 2, spec 2026-09-30): POST /api/depth/surfaces, the
 * priced, metered, cached MoGe-2 route that replaced the dev-only
 * `depth/moge-normals.post.ts` prototype.
 *
 * Mocked like chokepoint-meter.unit.spec.ts: `fetch` is a global stub
 * serving queue.fal.run/fal-ai/moge-2's submit/status/result shape, plus the
 * PNG download from the result's `normal_map.url`. No real network call, no
 * real fal spend. The engine root is pointed at a scratch temp dir via the
 * route's own `__setSurfacesRootForTests` seam so the test never touches the
 * real ComfyUI checkout.
 */
import { mkdtemp, writeFile, rm, mkdir, access, readdir } from 'node:fs/promises'
import sharp from 'sharp'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetRateLimits } from '../../server/lib/rateLimit'
import { costForModel } from '../../server/utils/priceBook'
import { __setInputUploadsDbForTests, canonicalUploadKey } from '../../server/utils/inputUploads'
import {
  __resetMeterContextForTests,
  __setLedgerForTests,
  __setSpendGuardForTests,
  bindMeterContext,
} from '../../server/utils/requestMeter'
import { __setModerationFetchForTests } from '../../server/utils/moderation'
import { depthCacheKey } from '../../server/utils/depthCache'

// The route is a plain Nuxt/Nitro auto-imported handler (defineEventHandler,
// readBody, createError, setResponseStatus are globals at runtime, not local
// imports) — stub them BEFORE the route module is first imported, then load
// it dynamically so the stubs are already in place.
const g = globalThis as any
g.createError = (opts: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(opts.message ?? opts.statusMessage) as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
}
g.defineEventHandler = (fn: any) => fn
g.readBody = async (event: any) => event.__body
g.setResponseStatus = (event: any, code: number) => { event.node.res.statusCode = code }

let handler: typeof import('../../server/api/depth/surfaces.post').default
let __setSurfacesRootForTests: typeof import('../../server/api/depth/surfaces.post').__setSurfacesRootForTests

beforeAll(async () => {
  const mod = await import('../../server/api/depth/surfaces.post')
  handler = mod.default
  __setSurfacesRootForTests = mod.__setSurfacesRootForTests
})

const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
const savedClerkKey = process.env[CLERK_KEY]
const savedFalKey = process.env.FAL_KEY
const savedOpenAiKey = process.env.OPENAI_API_KEY
const savedSwitch = process.env.NUXT_RELIGHT_SURFACES

function setHosted(): void { process.env[CLERK_KEY] = 'sk_test_hosted' }
function setLocal(): void { delete process.env[CLERK_KEY] }

function jsonResponse(body: unknown, ok = true, status = 200): any {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body), statusText: ok ? 'OK' : 'Error' }
}

const FAL_APP = 'fal-ai/moge-2'
const NORMAL_MAP_URL = 'https://fal.media/files/normal.png'
const PNG_BYTES = new Uint8Array([1, 2, 3, 4])
const OVERSIZED_CONTENT_LENGTH = 70 * 1024 * 1024 // over the route's 64 MB cap

function fakeHeaders(entries: Record<string, string | null>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null }
}

type FalScenario = 'ok' | 'no-normal-map' | 'result-fetch-fails' | 'oversized' | 'never-finishes'

function makeFalFetchMock(scenario: FalScenario): ReturnType<typeof vi.fn> {
  const base = `https://queue.fal.run/${FAL_APP}`
  return vi.fn(async (url: string) => {
    if (url === base) {
      return jsonResponse({
        request_id: 'req1',
        status_url: `${base}/requests/req1/status`,
        response_url: `${base}/requests/req1`,
      })
    }
    if (url === `${base}/requests/req1/status`) {
      return jsonResponse({ status: scenario === 'never-finishes' ? 'IN_PROGRESS' : 'COMPLETED' })
    }
    if (url === `${base}/requests/req1`) {
      if (scenario === 'result-fetch-fails') return jsonResponse({ detail: 'boom' }, false, 500)
      if (scenario === 'no-normal-map') return jsonResponse({})
      return jsonResponse({ normal_map: { url: NORMAL_MAP_URL } })
    }
    if (url === NORMAL_MAP_URL) {
      if (scenario === 'oversized') {
        return {
          ok: true,
          status: 200,
          headers: fakeHeaders({ 'content-type': 'image/png', 'content-length': String(OVERSIZED_CONTENT_LENGTH) }),
          arrayBuffer: async () => { throw new Error('should never be read — the content-length check must refuse first') },
        }
      }
      return {
        ok: true,
        status: 200,
        headers: fakeHeaders({ 'content-type': 'image/png' }),
        arrayBuffer: async () => PNG_BYTES.buffer,
      }
    }
    throw new Error('unexpected fetch url: ' + url)
  })
}

type FakeLedger = {
  getAvailable: ReturnType<typeof vi.fn>
  hold: ReturnType<typeof vi.fn>
  settleHold: ReturnType<typeof vi.fn>
  releaseHold: ReturnType<typeof vi.fn>
  debit: ReturnType<typeof vi.fn>
  setAvailable(n: number): void
}
function makeFakeLedger(startingAvailable = 1000): FakeLedger {
  let available = startingAvailable
  let holdSeq = 0
  return {
    getAvailable: vi.fn(async () => available),
    hold: vi.fn(async (_userId: string, estimate: number) => {
      if (estimate > available) return { ok: false as const, reason: 'insufficient' as const }
      available -= estimate
      return { ok: true as const, holdId: ++holdSeq }
    }),
    settleHold: vi.fn(async () => ({ ok: true as const, balance: 0, settled: true })),
    releaseHold: vi.fn(async () => {}),
    debit: vi.fn(async () => ({ ok: true })),
    setAvailable(n: number) { available = n },
  }
}
let fakeLedger: FakeLedger

let root: string

function makeEvent(body: Record<string, unknown>, userId: string | null = null): any {
  return {
    __body: body,
    node: { req: { socket: { remoteAddress: '127.0.0.1' } }, res: { statusCode: 200 } },
    context: { userId },
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'relight-surfaces-'))
  await mkdir(join(root, 'input'), { recursive: true })
  __setSurfacesRootForTests(root)

  _resetRateLimits()
  __resetMeterContextForTests()
  fakeLedger = makeFakeLedger()
  __setLedgerForTests(fakeLedger as any)
  __setSpendGuardForTests(async () => {})
  __setInputUploadsDbForTests({ query: async () => ({ rows: [] }) })
  process.env.FAL_KEY = 'test-fal-key'
  process.env.OPENAI_API_KEY = 'sk-test'
  __setModerationFetchForTests(vi.fn(async () => jsonResponse({ results: [{ flagged: false, categories: {} }] })) as any)
  delete process.env.NUXT_RELIGHT_SURFACES
})

afterEach(async () => {
  if (savedClerkKey === undefined) delete process.env[CLERK_KEY]; else process.env[CLERK_KEY] = savedClerkKey
  if (savedFalKey === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = savedFalKey
  if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedOpenAiKey
  if (savedSwitch === undefined) delete process.env.NUXT_RELIGHT_SURFACES; else process.env.NUXT_RELIGHT_SURFACES = savedSwitch
  __setModerationFetchForTests(null)
  __setLedgerForTests(null)
  __setSpendGuardForTests(null)
  __setInputUploadsDbForTests(null)
  __resetMeterContextForTests()
  __setSurfacesRootForTests(undefined)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

describe('POST /api/depth/surfaces', () => {
  it('cache miss: calls fal exactly once with the fixed MoGe-2 input, writes the cache file, returns cached:false', async () => {
    setLocal()
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    const fetchMock = makeFalFetchMock('ok')
    vi.stubGlobal('fetch', fetchMock)

    const res = await handler(makeEvent({ filename: 'photo.png', type: 'input' }))

    expect(res.cached).toBe(false)
    expect(res.subfolder).toBe('sailor_depth')
    expect(res.normalsFilename).toMatch(/^moge_[0-9a-f]{16}\.png$/)

    const submitCall = fetchMock.mock.calls.find(([url]: [string]) => url === `https://queue.fal.run/${FAL_APP}`)
    expect(submitCall).toBeDefined()
    const [, init] = submitCall!
    const sentBody = JSON.parse(init.body)
    expect(sentBody).toEqual({
      image_url: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`,
      model: 'vitl-normal',
      apply_mask: false,
      export_glb: false,
      export_ply: false,
    })

    const submitCalls = fetchMock.mock.calls.filter(([url]: [string]) => url === `https://queue.fal.run/${FAL_APP}`)
    expect(submitCalls.length).toBe(1)
  })

  it('cache hit: no fetch at all, returns cached:true', async () => {
    setLocal()
    const bytes = PNG_BYTES
    await writeFile(join(root, 'input', 'photo.png'), bytes)
    // Pre-populate the cache with the same content hash the route will compute.
    const name = `moge_${depthCacheKey(bytes)}.png`
    await mkdir(join(root, 'input', 'sailor_depth'), { recursive: true })
    await writeFile(join(root, 'input', 'sailor_depth', name), new Uint8Array([9]))

    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    const res = await handler(makeEvent({ filename: 'photo.png', type: 'input' }))

    expect(res).toEqual({ normalsFilename: name, subfolder: 'sailor_depth', cached: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('kill switch: NUXT_RELIGHT_SURFACES=off returns 503 { off: true }, no fetch', async () => {
    setLocal()
    process.env.NUXT_RELIGHT_SURFACES = 'off'
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    const event = makeEvent({ filename: 'photo.png', type: 'input' })
    const res = await handler(event)

    expect(res).toEqual({ off: true })
    expect(event.node.res.statusCode).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('unsafe filename (../x.png) → 400, no fetch', async () => {
    setLocal()
    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ filename: '../x.png', type: 'input' })))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hosted: file owned by another user → 404, no fetch', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    __setInputUploadsDbForTests({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT user_id FROM input_uploads')) {
          expect(params?.[0]).toBe(canonicalUploadKey('input', '', 'photo.png'))
          return { rows: [{ user_id: 'u2' }] }
        }
        return { rows: [] }
      },
    })
    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ filename: 'photo.png', type: 'input' }, 'u1')))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fal result endpoint fails entirely → 502, and (hosted) the meter hold is released', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    const fetchMock = makeFalFetchMock('result-fetch-fails')
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ filename: 'photo.png', type: 'input' }, 'u1')))
      .rejects.toMatchObject({ statusCode: 502 })

    expect(fakeLedger.hold).toHaveBeenCalledTimes(1)
    expect(fakeLedger.releaseHold).toHaveBeenCalledTimes(1)
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
  })

  it('fal completes but the body carries no normal_map → 502 (the call still settles — fal did the compute)', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    const fetchMock = makeFalFetchMock('no-normal-map')
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ filename: 'photo.png', type: 'input' }, 'u1')))
      .rejects.toMatchObject({ statusCode: 502 })

    expect(fakeLedger.settleHold).toHaveBeenCalledTimes(1)
    expect(fakeLedger.releaseHold).not.toHaveBeenCalled()
  })

  it('fix round 1: an oversized normal-map body → 502, and nothing is written to the cache', async () => {
    setLocal()
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    const fetchMock = makeFalFetchMock('oversized')
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ filename: 'photo.png', type: 'input' })))
      .rejects.toMatchObject({ statusCode: 502 })

    const name = `moge_${depthCacheKey(PNG_BYTES)}.png`
    await expect(access(join(root, 'input', 'sailor_depth', name))).rejects.toThrow()
  })

  it('price: costForModel(fal-ai/moge-2) is $0.0125 at 3 credits', () => {
    expect(costForModel('fal-ai/moge-2')).toMatchObject({ usd: 0.0125, credits: 3 })
  })
})

// 2026-09-30 (Read shape button): `peek: true` asks for free whether a photo already has
// surfaces cached, and must never call fal.
describe('POST /api/depth/surfaces — peek', () => {
  it('peek on a cached file: returns the cached answer, no fetch', async () => {
    setLocal()
    const bytes = PNG_BYTES
    await writeFile(join(root, 'input', 'photo.png'), bytes)
    const name = `moge_${depthCacheKey(bytes)}.png`
    await mkdir(join(root, 'input', 'sailor_depth'), { recursive: true })
    await writeFile(join(root, 'input', 'sailor_depth', name), new Uint8Array([9]))

    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    const res = await handler(makeEvent({ filename: 'photo.png', type: 'input', peek: true }))

    expect(res).toEqual({ normalsFilename: name, subfolder: 'sailor_depth', cached: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('peek on an uncached file: { absent: true }, no fetch, no fal call', async () => {
    setLocal()
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    const res = await handler(makeEvent({ filename: 'photo.png', type: 'input', peek: true }))

    expect(res).toEqual({ absent: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('peek respects ownership: hosted, foreign file → 404, no fetch', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    __setInputUploadsDbForTests({
      query: async (sql: string) => {
        if (sql.includes('SELECT user_id FROM input_uploads')) return { rows: [{ user_id: 'u2' }] }
        return { rows: [] }
      },
    })
    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ filename: 'photo.png', type: 'input', peek: true }, 'u1')))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('peek respects the kill switch: 503 { off: true }, no fetch', async () => {
    setLocal()
    process.env.NUXT_RELIGHT_SURFACES = 'off'
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    const event = makeEvent({ filename: 'photo.png', type: 'input', peek: true })
    const res = await handler(event)

    expect(res).toEqual({ off: true })
    expect(event.node.res.statusCode).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/depth/surfaces — final-review fixes', () => {
  const submits = (f: ReturnType<typeof vi.fn>) =>
    f.mock.calls.filter(([url]: [string]) => url === `https://queue.fal.run/${FAL_APP}`).length
  const cacheDir = () => join(root, 'input', 'sailor_depth')

  // Fix 5: a second request for the same uncached photo waits for the first — one fal call.
  it('two concurrent requests for the same photo make ONE fal submit; the second answers cached:true', async () => {
    setLocal()
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    await writeFile(join(root, 'input', 'copy.png'), PNG_BYTES)      // same bytes, other name
    const fetchMock = makeFalFetchMock('ok')
    vi.stubGlobal('fetch', fetchMock)

    const [a, b] = await Promise.all([
      handler(makeEvent({ filename: 'photo.png', type: 'input' })),
      handler(makeEvent({ filename: 'copy.png', type: 'input' })),
    ])
    expect(submits(fetchMock)).toBe(1)
    expect([a.cached, b.cached].sort()).toEqual([false, true])
    expect(a.normalsFilename).toBe(b.normalsFilename)
  })

  it('a failed read clears the in-flight entry: the next request calls fal again', async () => {
    setLocal()
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    const failing = makeFalFetchMock('result-fetch-fails')
    vi.stubGlobal('fetch', failing)
    await expect(handler(makeEvent({ filename: 'photo.png', type: 'input' }))).rejects.toMatchObject({ statusCode: 502 })

    const ok = makeFalFetchMock('ok')
    vi.stubGlobal('fetch', ok)
    const res = await handler(makeEvent({ filename: 'photo.png', type: 'input' }))
    expect(res.cached).toBe(false)
    expect(submits(ok)).toBe(1)
  })

  it('writes the cache atomically: no temp file is left beside the map', async () => {
    setLocal()
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    vi.stubGlobal('fetch', makeFalFetchMock('ok'))
    const res = await handler(makeEvent({ filename: 'photo.png', type: 'input' }))
    expect(await readdir(cacheDir())).toEqual([res.normalsFilename])
  })

  // Fix 7: the poll waits up to 600 s; past that the answer is 503 { retryLater }.
  it('a read that outlasts the 600 s poll answers 503 { retryLater: true } (not before)', async () => {
    setLocal()
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    const fetchMock = makeFalFetchMock('never-finishes')
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      const event = makeEvent({ filename: 'photo.png', type: 'input' })
      let settled = false
      const p = handler(event).then((r: unknown) => { settled = true; return r })
      // The photo is read and probed (real I/O) before the submit; only then does the poll start.
      await vi.waitFor(() => expect(submits(fetchMock)).toBe(1))
      await vi.advanceTimersByTimeAsync(590_000)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(15_000)
      const res = await p
      expect(event.node.res.statusCode).toBe(503)
      expect(res).toMatchObject({ retryLater: true })
    } finally {
      vi.useRealTimers()
    }
  })

  // Fix 8: a hosted refusal passes through as itself, not as a provider failure (502).
  it('hosted, no balance: 402 passes through, fal never called', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(0)
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    const fetchMock = makeFalFetchMock('ok')
    vi.stubGlobal('fetch', fetchMock)
    const event = makeEvent({ filename: 'photo.png', type: 'input' }, 'u1')
    const res = await handler(event)
    expect(event.node.res.statusCode).toBe(402)
    expect(res).toMatchObject({ message: expect.any(String) })
    expect(submits(fetchMock)).toBe(0)
  })

  it('hosted, unmetered spend refused: 503 { off: true }, fal never called', async () => {
    setHosted()                                   // no bindMeterContext → no meter context
    await writeFile(join(root, 'input', 'photo.png'), PNG_BYTES)
    const fetchMock = makeFalFetchMock('ok')
    vi.stubGlobal('fetch', fetchMock)
    const event = makeEvent({ filename: 'photo.png', type: 'input' })
    const res = await handler(event)
    expect(event.node.res.statusCode).toBe(503)
    expect(res).toMatchObject({ off: true })
    expect(submits(fetchMock)).toBe(0)
  })

  // Fix 11: at most 1536 px on the long edge is sent, aspect kept; the cache key stays the
  // ORIGINAL file's content hash.
  it('downscales a large photo to 1536 px on the long edge before sending', async () => {
    setLocal()
    const big = await sharp({ create: { width: 3072, height: 1024, channels: 3, background: { r: 200, g: 100, b: 50 } } }).png().toBuffer()
    await writeFile(join(root, 'input', 'big.png'), big)
    const fetchMock = makeFalFetchMock('ok')
    vi.stubGlobal('fetch', fetchMock)
    const res = await handler(makeEvent({ filename: 'big.png', type: 'input' }))
    expect(res.normalsFilename).toBe(`moge_${depthCacheKey(new Uint8Array(big))}.png`)
    const [, init] = fetchMock.mock.calls.find(([url]: [string]) => url === `https://queue.fal.run/${FAL_APP}`)!
    const uri: string = JSON.parse(init.body).image_url
    const sent = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')
    const meta = await sharp(sent).metadata()
    expect([meta.width, meta.height]).toEqual([1536, 512])
  })

  it('a photo already within 1536 px is sent as is', async () => {
    setLocal()
    const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()
    await writeFile(join(root, 'input', 'small.png'), small)
    const fetchMock = makeFalFetchMock('ok')
    vi.stubGlobal('fetch', fetchMock)
    await handler(makeEvent({ filename: 'small.png', type: 'input' }))
    const [, init] = fetchMock.mock.calls.find(([url]: [string]) => url === `https://queue.fal.run/${FAL_APP}`)!
    expect(JSON.parse(init.body).image_url).toBe(`data:image/png;base64,${small.toString('base64')}`)
  })
})
