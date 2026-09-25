import { describe, it, expect, vi } from 'vitest'
import { resetRouteWarning, routeRequest, ROUTE_TIMEOUT_MS } from '~/lib/prompt/routeRequest'

const input = { request: 'what does this do?', host: 'canvas' as const, selection: [{ kind: 'artifact-image', name: 'Rainy shop' }], mode: null }

describe('routeRequest', () => {
  it('posts to /api/prompt-route and returns the kind and follow-ups', async () => {
    const fetcher = vi.fn(async () => ({ kind: 'answer', followUps: ['Lower glass blur'] }))
    const out = await routeRequest(input, { apiKey: 'k', fetcher })
    expect(out).toEqual({ kind: 'answer', followUps: ['Lower glass blur'], routed: true })
    expect(fetcher).toHaveBeenCalledWith('/api/prompt-route', expect.objectContaining({
      method: 'POST', timeout: ROUTE_TIMEOUT_MS, body: { apiKey: 'k', ...input },
    }))
  })

  it('a mode chip decides the kind without calling', async () => {
    const fetcher = vi.fn()
    expect(await routeRequest({ ...input, mode: 'Tune' }, { apiKey: '', fetcher })).toEqual({ kind: 'tweak', followUps: [], routed: false })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('any failure falls back to plan — today\'s behaviour', async () => {
    const fetcher = vi.fn(async () => { throw Object.assign(new Error('402'), { statusCode: 402 }) })
    expect(await routeRequest(input, { apiKey: '', fetcher })).toEqual({ kind: 'plan', followUps: [], routed: false })
  })

  it('an unknown kind from the server falls back to plan; follow-ups are dropped for other kinds', async () => {
    expect(await routeRequest(input, { apiKey: '', fetcher: async () => ({ kind: 'dance', followUps: ['x'] }) as any })).toEqual({ kind: 'plan', followUps: [], routed: true })
    expect(await routeRequest(input, { apiKey: '', fetcher: async () => ({ kind: 'plan', followUps: ['x'] }) })).toEqual({ kind: 'plan', followUps: [], routed: true })
  })

  it('an abort (Stop) rethrows instead of falling back', async () => {
    const ctrl = new AbortController()
    const fetcher = vi.fn(async () => { ctrl.abort(); throw new Error('aborted') })
    await expect(routeRequest(input, { apiKey: '', signal: ctrl.signal, fetcher })).rejects.toThrow('aborted')
  })

  it('the fallback warns once in the console, so a missing route is visible; an abort never warns', async () => {
    resetRouteWarning()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctrl = new AbortController()
      await routeRequest(input, { apiKey: '', signal: ctrl.signal, fetcher: async () => { ctrl.abort(); throw new Error('aborted') } }).catch(() => {})
      expect(warn).not.toHaveBeenCalled()
      const missing = async () => { throw Object.assign(new Error('405'), { statusCode: 405 }) }
      await routeRequest(input, { apiKey: '', fetcher: missing })
      await routeRequest(input, { apiKey: '', fetcher: missing })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('prompt-route')
      resetRouteWarning()
      await routeRequest(input, { apiKey: '', fetcher: async () => ({ kind: 'dance' }) as any })
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })
})
