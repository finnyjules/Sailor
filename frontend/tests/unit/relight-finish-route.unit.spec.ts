/**
 * Task 1 (Relight stage 3, spec 2026-09-30-relight-stage3-finish): POST
 * /api/inpaint/relight-finish — Nano Banana 2 turns the (original, guide)
 * pair into a realistic photo, with a fixed server-side prompt.
 *
 * Modelled on relight-surfaces-route.unit.spec.ts: `fetch` is a global stub
 * serving queue.fal.run/fal-ai/nano-banana-2/edit's submit/status/result
 * shape, plus the image download. No real network call, no real fal spend.
 */
import { describe, expect, it, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { _resetRateLimits } from '../../server/lib/rateLimit'
import { costForModel } from '../../server/utils/priceBook'
import {
  __resetMeterContextForTests,
  __setLedgerForTests,
  __setSpendGuardForTests,
  bindMeterContext,
} from '../../server/utils/requestMeter'
import { __setModerationFetchForTests } from '../../server/utils/moderation'
import { FINISH_APP, FINISH_USD, finishCredits, RELIGHT_FINISH_PROMPT } from '../../shared/pricing/relightFinish'

// The route is a plain Nuxt/Nitro auto-imported handler — stub the globals it
// relies on BEFORE the route module is first imported, then load it dynamically.
const g = globalThis as any
g.createError = (opts: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(opts.message ?? opts.statusMessage) as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
}
g.defineEventHandler = (fn: any) => fn
g.readBody = async (event: any) => event.__body
g.setResponseStatus = (event: any, code: number) => { event.node.res.statusCode = code }

let handler: typeof import('../../server/api/inpaint/relight-finish.post').default

beforeAll(async () => {
  const mod = await import('../../server/api/inpaint/relight-finish.post')
  handler = mod.default
})

const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
const savedClerkKey = process.env[CLERK_KEY]
const savedFalKey = process.env.FAL_KEY
const savedOpenAiKey = process.env.OPENAI_API_KEY
const savedSwitch = process.env.NUXT_RELIGHT_FINISH

function setHosted(): void { process.env[CLERK_KEY] = 'sk_test_hosted' }
function setLocal(): void { delete process.env[CLERK_KEY] }

function jsonResponse(body: unknown, ok = true, status = 200): any {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body), statusText: ok ? 'OK' : 'Error' }
}

const RESULT_IMAGE_URL = 'https://fal.media/files/result.png'
const ORIGINAL = 'data:image/png;base64,AAAA'
const GUIDE = 'data:image/png;base64,BBBB'
const RESULT_BYTES = new Uint8Array([9, 9, 9, 9])
const RESULT_DATA_URL = `data:image/png;base64,${Buffer.from(RESULT_BYTES).toString('base64')}`

function fakeHeaders(entries: Record<string, string | null>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null }
}

type FalScenario = 'ok' | 'no-image' | 'result-fetch-fails'

function makeFalFetchMock(scenario: FalScenario): ReturnType<typeof vi.fn> {
  const base = `https://queue.fal.run/${FINISH_APP}`
  return vi.fn(async (url: string, init?: { body?: string }) => {
    if (url === base) {
      return jsonResponse({
        request_id: 'req1',
        status_url: `${base}/requests/req1/status`,
        response_url: `${base}/requests/req1`,
      })
    }
    if (url === `${base}/requests/req1/status`) {
      return jsonResponse({ status: 'COMPLETED' })
    }
    if (url === `${base}/requests/req1`) {
      if (scenario === 'result-fetch-fails') return { ok: false, status: 500, headers: fakeHeaders({}), text: async () => 'boom' }
      if (scenario === 'no-image') return jsonResponse({ images: [] })
      return jsonResponse({ images: [{ url: RESULT_IMAGE_URL }] })
    }
    if (url === RESULT_IMAGE_URL) {
      return {
        ok: true,
        status: 200,
        headers: fakeHeaders({ 'content-type': 'image/png' }),
        arrayBuffer: async () => RESULT_BYTES.buffer,
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

function makeEvent(body: Record<string, unknown>, userId: string | null = null): any {
  return {
    __body: body,
    node: { req: { socket: { remoteAddress: '127.0.0.1' } }, res: { statusCode: 200 } },
    context: { userId },
  }
}

beforeEach(async () => {
  _resetRateLimits()
  __resetMeterContextForTests()
  fakeLedger = makeFakeLedger()
  __setLedgerForTests(fakeLedger as any)
  __setSpendGuardForTests(async () => {})
  process.env.FAL_KEY = 'test-fal-key'
  process.env.OPENAI_API_KEY = 'sk-test'
  __setModerationFetchForTests(vi.fn(async () => jsonResponse({ results: [{ flagged: false, categories: {} }] })) as any)
  delete process.env.NUXT_RELIGHT_FINISH
})

afterEach(async () => {
  if (savedClerkKey === undefined) delete process.env[CLERK_KEY]; else process.env[CLERK_KEY] = savedClerkKey
  if (savedFalKey === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = savedFalKey
  if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedOpenAiKey
  if (savedSwitch === undefined) delete process.env.NUXT_RELIGHT_FINISH; else process.env.NUXT_RELIGHT_FINISH = savedSwitch
  __setModerationFetchForTests(null)
  __setLedgerForTests(null)
  __setSpendGuardForTests(null)
  __resetMeterContextForTests()
  vi.unstubAllGlobals()
})

describe('POST /api/inpaint/relight-finish', () => {
  it('sends the exact relightFinishInput payload to fal and returns { images: [dataUrl] }', async () => {
    setLocal()
    const fetchMock = makeFalFetchMock('ok')
    vi.stubGlobal('fetch', fetchMock)

    const res = await handler(makeEvent({ original: ORIGINAL, guide: GUIDE }))

    expect(res).toEqual({ images: [RESULT_DATA_URL] })

    const submitCall = fetchMock.mock.calls.find(([url]: [string]) => url === `https://queue.fal.run/${FINISH_APP}`)
    expect(submitCall).toBeDefined()
    const [, init] = submitCall!
    expect(JSON.parse(init.body)).toEqual({
      prompt: RELIGHT_FINISH_PROMPT,
      image_urls: [ORIGINAL, GUIDE],
      num_images: 1,
      resolution: '1K',
      output_format: 'png',
    })
  })

  it('kill switch: NUXT_RELIGHT_FINISH=off returns 503 { off: true }, no fetch', async () => {
    setLocal()
    process.env.NUXT_RELIGHT_FINISH = 'off'
    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    const event = makeEvent({ original: ORIGINAL, guide: GUIDE })
    const res = await handler(event)

    expect(res).toEqual({ off: true })
    expect(event.node.res.statusCode).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('missing original → 400, no fetch', async () => {
    setLocal()
    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ guide: GUIDE }))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('missing guide → 400, no fetch', async () => {
    setLocal()
    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ original: ORIGINAL }))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a non-data-URL image (e.g. http URL) → 400, no fetch', async () => {
    setLocal()
    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ original: 'https://example.com/x.png', guide: GUIDE })))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an image over 20 MB of string length → 400, no fetch', async () => {
    setLocal()
    const huge = 'data:image/png;base64,' + 'A'.repeat(20 * 1024 * 1024 + 1)
    const fetchMock = vi.fn(async (url: string) => { throw new Error('unexpected fetch: ' + url) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ original: huge, guide: GUIDE })))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an image at exactly 20 MB of string length is accepted (boundary)', async () => {
    setLocal()
    const exact = 'data:image/png;base64,' + 'A'.repeat(20 * 1024 * 1024 - 'data:image/png;base64,'.length)
    expect(exact.length).toBe(20 * 1024 * 1024)
    const fetchMock = makeFalFetchMock('ok')
    vi.stubGlobal('fetch', fetchMock)

    const res = await handler(makeEvent({ original: exact, guide: GUIDE }))
    expect(res).toEqual({ images: [RESULT_DATA_URL] })
  })

  it('hosted with no balance → 402 { message }, the hold is never settled', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(0)
    const fetchMock = makeFalFetchMock('ok')
    vi.stubGlobal('fetch', fetchMock)

    const event = makeEvent({ original: ORIGINAL, guide: GUIDE }, 'u1')
    const res = await handler(event)

    expect(event.node.res.statusCode).toBe(402)
    expect(res).toMatchObject({ message: expect.any(String) })
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    const submits = fetchMock.mock.calls.filter(([url]: [string]) => url === `https://queue.fal.run/${FINISH_APP}`)
    expect(submits.length).toBe(0)
  })

  it('hosted, unmetered spend refused (no meter context bound) → 503 { off: true }, no fetch', async () => {
    setHosted()
    const fetchMock = makeFalFetchMock('ok')
    vi.stubGlobal('fetch', fetchMock)
    const event = makeEvent({ original: ORIGINAL, guide: GUIDE })
    const res = await handler(event)
    expect(event.node.res.statusCode).toBe(503)
    expect(res).toMatchObject({ off: true })
    const submits = fetchMock.mock.calls.filter(([url]: [string]) => url === `https://queue.fal.run/${FINISH_APP}`)
    expect(submits.length).toBe(0)
  })

  it('a malformed fal result (no image) → 502', async () => {
    setLocal()
    const fetchMock = makeFalFetchMock('no-image')
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ original: ORIGINAL, guide: GUIDE })))
      .rejects.toMatchObject({ statusCode: 502 })
  })

  it('fal result endpoint fails entirely → the provider error propagates, and (hosted) the meter hold is released', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    const fetchMock = makeFalFetchMock('result-fetch-fails')
    vi.stubGlobal('fetch', fetchMock)

    await expect(handler(makeEvent({ original: ORIGINAL, guide: GUIDE }, 'u1')))
      .rejects.toThrow()

    expect(fakeLedger.hold).toHaveBeenCalledTimes(1)
    expect(fakeLedger.releaseHold).toHaveBeenCalledTimes(1)
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
  })

  it('FINISH_USD and finishCredits() equal the price-book row for fal-ai/nano-banana-2/edit', () => {
    const row = costForModel('fal-ai/nano-banana-2/edit')
    expect(row).toBeDefined()
    expect(FINISH_USD).toBe(row!.usd)
    expect(finishCredits()).toBe(row!.credits)
  })
})
