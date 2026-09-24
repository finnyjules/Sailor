/**
 * A6: GET /api/engine/health — whether the local engine answers, checked
 * with a short timeout and cached for a few seconds so every open tab can
 * poll it without each poll reaching the engine.
 */
import { describe, expect, it, vi } from 'vitest'
import { createEngineHealth, ENGINE_HEALTH_CACHE_MS, ENGINE_HEALTH_TIMEOUT_MS, probeEngine } from '../../server/native/engineHealth'

describe('createEngineHealth', () => {
  it('caches the answer for 3 s, then asks again', async () => {
    let t = 0
    const probe = vi.fn(async () => true)
    const health = createEngineHealth({ probe, now: () => t })
    expect(await health()).toBe('up')
    t = 2_999
    expect(await health()).toBe('up')
    expect(probe).toHaveBeenCalledTimes(1)
    t = 3_000
    probe.mockResolvedValueOnce(false)
    expect(await health()).toBe('down')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('shares one check between callers that arrive together', async () => {
    let release!: (v: boolean) => void
    const probe = vi.fn(() => new Promise<boolean>((r) => { release = r }))
    const health = createEngineHealth({ probe, now: () => 0 })
    const a = health()
    const b = health()
    release(true)
    expect(await a).toBe('up')
    expect(await b).toBe('up')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('reads a probe that throws as down', async () => {
    const health = createEngineHealth({ probe: async () => { throw new Error('boom') }, now: () => 0 })
    expect(await health()).toBe('down')
  })

  it('uses the 3 s cache and 1.5 s timeout the brief sets', () => {
    expect(ENGINE_HEALTH_CACHE_MS).toBe(3_000)
    expect(ENGINE_HEALTH_TIMEOUT_MS).toBe(1_500)
  })
})

describe('probeEngine', () => {
  it('asks /system_stats on the engine and reads any answer as up', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }))
    expect(await probeEngine(fetchFn as unknown as typeof fetch)).toBe(true)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8188/system_stats')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('reads a refused connection or a timeout as down', async () => {
    expect(await probeEngine((async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch)).toBe(false)
  })
})

describe('GET /api/engine/health is reachable', () => {
  it('belongs to Nitro, not the engine proxy, and is never rewritten into an engine path', async () => {
    const { isNitroApiPath } = await import('../../server/lib/nitroApiPaths')
    const { normalizeEnginePath } = await import('../../server/utils/enginePath')
    expect(isNitroApiPath('/api/engine/health')).toBe(true)
    expect(normalizeEnginePath('/api/engine/health')).toBe('/api/engine/health')
  })

  it('in hosted mode passes the sign-in guard for a signed-in user', async () => {
    const { guardDecision } = await import('../../server/utils/authGuard')
    expect(guardDecision('/api/engine/health', 'hosted', 'user_1')).toEqual({ kind: 'attach', userId: 'user_1' })
    expect(guardDecision('/api/engine/health', 'local', null)).toEqual({ kind: 'pass' })
  })
})
