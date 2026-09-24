/**
 * A6 follow-up: GET /history skips the live ComfyUI fetch entirely when the
 * cached engine health (server/native/engineHealth.ts) already says 'down',
 * and bounds the fetch it does make with the same 1.5s timeout — instead of
 * waiting out a doomed round trip. Behaviour with the engine reported 'up'
 * is unchanged.
 *
 * fs is mocked throughout: the real .cache/history.json on disk is a live
 * dev cache and must never be touched by a test run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, eventHandler, toWebHandler } from 'h3'

const fsState = { existing: null as string | null }
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => fsState.existing !== null) }))
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => fsState.existing ?? '{}'),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
}))

const engineHealthMock = vi.fn(async () => 'up' as 'up' | 'down')
vi.mock('~~/server/native/engineHealth', () => ({
  engineHealth: () => engineHealthMock(),
  ENGINE_HEALTH_TIMEOUT_MS: 1500,
  ENGINE_MAIN_PORT: 8188,
}))

function handler(userId: string | null = null) {
  const app = createApp()
  if (userId) app.use(eventHandler((e) => { e.context.userId = userId }))
  return async () => {
    const route = (await import('~~/server/routes/history/index.get')).default
    app.use(route)
    return toWebHandler(app)(new Request('http://x/history'))
  }
}

describe('GET /history — engine-health gated', () => {
  beforeEach(() => {
    vi.resetModules()
    fsState.existing = null
    engineHealthMock.mockReset()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  })
  afterEach(() => {
    delete process.env.NUXT_CLERK_SECRET_KEY
    vi.unstubAllGlobals()
  })

  it('local mode: skips the ComfyUI fetch when engine health is down, returns the cache', async () => {
    fsState.existing = JSON.stringify({ a: 1 })
    engineHealthMock.mockResolvedValue('down')
    const res = await (await handler()())
    expect(await res.json()).toEqual({ a: 1 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('local mode: fetches (with a timeout signal) and merges when engine health is up', async () => {
    fsState.existing = JSON.stringify({ a: 1 })
    engineHealthMock.mockResolvedValue('up')
    ;(fetch as any).mockResolvedValue(new Response(JSON.stringify({ b: 2 }), { status: 200 }))
    const res = await (await handler()())
    expect(await res.json()).toEqual({ a: 1, b: 2 })
    expect(fetch).toHaveBeenCalledTimes(1)
    const init = (fetch as any).mock.calls[0][1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('hosted mode: skips the ComfyUI fetch when engine health is down, returns {}', async () => {
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_x'
    engineHealthMock.mockResolvedValue('down')
    const res = await (await handler('user_1')())
    expect(await res.json()).toEqual({})
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hosted mode: refuses with 401 before ever checking engine health when signed out', async () => {
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_x'
    engineHealthMock.mockResolvedValue('up')
    const res = await (await handler(null)())
    expect(res.status).toBe(401)
    expect(engineHealthMock).not.toHaveBeenCalled()
  })
})

/**
 * Final-review M4: GET /history/{promptId} follows the same rule — no live
 * fetch while engine health says 'down', a timeout-bounded fetch when 'up'.
 */
describe('GET /history/{promptId} — engine-health gated', () => {
  async function one(promptId: string) {
    const { createRouter } = await import('h3')
    const route = (await import('~~/server/routes/history/[promptId].get')).default
    const app = createApp()
    app.use(createRouter().get('/history/:promptId', route))
    return toWebHandler(app)(new Request(`http://x/history/${promptId}`))
  }

  beforeEach(() => {
    vi.resetModules()
    fsState.existing = null
    engineHealthMock.mockReset()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('local mode: skips the ComfyUI fetch when engine health is down and answers from the cache', async () => {
    fsState.existing = JSON.stringify({ p1: { outputs: {} } })
    engineHealthMock.mockResolvedValue('down')
    const res = await one('p1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ p1: { outputs: {} } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('local mode: engine down and nothing cached is a 404 without a fetch', async () => {
    engineHealthMock.mockResolvedValue('down')
    const res = await one('p1')
    expect(res.status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('local mode: fetches with a timeout signal when engine health is up', async () => {
    engineHealthMock.mockResolvedValue('up')
    ;(fetch as any).mockResolvedValue(new Response(JSON.stringify({ p1: { live: true } }), { status: 200 }))
    const res = await one('p1')
    expect(await res.json()).toEqual({ p1: { live: true } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((fetch as any).mock.calls[0][0]).toBe('http://127.0.0.1:8188/history/p1')
    expect((fetch as any).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
})
