/**
 * The Replicate queue client (Phase B, Task B3), against a stubbed fetch: no
 * test here can reach api.replicate.com. Ports nodes_replicate.py
 * `_run_prediction` (create, 404 → version route, 429 retries),
 * `_is_transient_replicate_error`, and replicate_refs.py's output readers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REPLICATE_API_BASE, ReplicateError, TRANSIENT_REPLICATE_ERROR_MARKERS, allOutputUrls, createReplicateClient,
  firstOutputUrl, isTransientReplicateError, logLines, retryAfterSeconds,
} from '~~/server/runner/replicateQueue'
import { isProviderNetworkError, percentFromLogs } from '~~/server/runner/falQueue'

const res = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, statusText: '',
  json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})
let fetchMock: ReturnType<typeof vi.fn>
let sleep: ReturnType<typeof vi.fn>
const client = (token: string | null = 'r8_test') => createReplicateClient({ token: () => token, sleep: sleep as any })

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => { throw new Error(`unexpected fetch ${url}`) })
  vi.stubGlobal('fetch', fetchMock)
  sleep = vi.fn(async () => {})
})
afterEach(() => { vi.unstubAllGlobals() })

const pred = (o: Record<string, unknown> = {}) => ({
  id: 'p1', status: 'starting',
  urls: { get: 'https://api.replicate.com/v1/predictions/p1', cancel: 'https://api.replicate.com/v1/predictions/p1/cancel' },
  ...o,
})

describe('submit', () => {
  it('posts to the official model route with the token and the input', async () => {
    fetchMock.mockResolvedValueOnce(res(pred(), 201))
    const s = await client().submit('black-forest-labs/flux-2-pro', { prompt: 'a fox' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Token r8_test')
    expect(JSON.parse(init.body)).toEqual({ input: { prompt: 'a fox' } })
    expect(s).toEqual({
      requestId: 'p1',
      statusUrl: 'https://api.replicate.com/v1/predictions/p1',
      responseUrl: 'https://api.replicate.com/v1/predictions/p1',
      cancelUrl: 'https://api.replicate.com/v1/predictions/p1/cancel',
      queuePosition: null,
    })
  })

  it('asks Replicate to call the webhook when completed, only when there is one', async () => {
    fetchMock.mockResolvedValueOnce(res(pred(), 201))
    await client().submit('a/b', { prompt: 'x' }, { webhookUrl: 'https://app.test/hook' })
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      input: { prompt: 'x' }, webhook: 'https://app.test/hook', webhook_events_filter: ['completed'],
    })
    fetchMock.mockResolvedValueOnce(res(pred(), 200))
    await client().submit('a/b', { prompt: 'x' }, { webhookUrl: null })
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ input: { prompt: 'x' } })
  })

  it('builds the urls itself when Replicate leaves them out', async () => {
    fetchMock.mockResolvedValueOnce(res({ id: 'p9', status: 'starting' }, 201))
    const s = await client().submit('a/b', {})
    expect(s.statusUrl).toBe(`${REPLICATE_API_BASE}/predictions/p9`)
    expect(s.responseUrl).toBe(`${REPLICATE_API_BASE}/predictions/p9`)
    expect(s.cancelUrl).toBe(`${REPLICATE_API_BASE}/predictions/p9/cancel`)
  })

  it('never trusts urls.get/urls.cancel from the response: the token always goes back to api.replicate.com', async () => {
    fetchMock.mockResolvedValueOnce(res(pred({
      id: 'p9',
      urls: { get: 'https://evil.example/steal?token=', cancel: 'https://evil.example/steal-cancel?token=' },
    }), 201))
    const s = await client().submit('a/b', {})
    expect(s.statusUrl).toBe(`${REPLICATE_API_BASE}/predictions/p9`)
    expect(s.responseUrl).toBe(`${REPLICATE_API_BASE}/predictions/p9`)
    expect(s.cancelUrl).toBe(`${REPLICATE_API_BASE}/predictions/p9/cancel`)
  })

  it('a 404 on the official route looks up the latest version and posts to /v1/predictions', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ detail: 'not found' }, 404))
      .mockResolvedValueOnce(res({ latest_version: { id: 'v123' } }))
      .mockResolvedValueOnce(res(pred({ id: 'p2', urls: {} }), 201))
    const s = await client().submit('catacolabs/sdxl-ad-inpaint', { prompt: 'x' }, { webhookUrl: 'https://app.test/hook' })
    expect(fetchMock.mock.calls.map(c => [c[0], c[1]?.method ?? 'GET'])).toEqual([
      ['https://api.replicate.com/v1/models/catacolabs/sdxl-ad-inpaint/predictions', 'POST'],
      ['https://api.replicate.com/v1/models/catacolabs/sdxl-ad-inpaint', 'GET'],
      ['https://api.replicate.com/v1/predictions', 'POST'],
    ])
    expect(fetchMock.mock.calls[1]![1].headers.Authorization).toBe('Token r8_test')
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual({
      version: 'v123', input: { prompt: 'x' }, webhook: 'https://app.test/hook', webhook_events_filter: ['completed'],
    })
    expect(s.requestId).toBe('p2')
    expect(s.statusUrl).toBe(`${REPLICATE_API_BASE}/predictions/p2`)
  })

  it('the version route fails plainly when the model cannot be looked up or has no version', async () => {
    fetchMock.mockResolvedValueOnce(res('nope', 404)).mockResolvedValueOnce(res('missing', 404))
    await expect(client().submit('a/b', {})).rejects.toThrow('Could not look up a/b: HTTP 404 — missing')
    fetchMock.mockResolvedValueOnce(res('nope', 404)).mockResolvedValueOnce(res({ latest_version: null }))
    await expect(client().submit('a/b', {})).rejects.toThrow('No latest_version for a/b')
  })

  it('a 429 waits retry_after + 0.5 s and tries again', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ detail: 'slow down', retry_after: 3 }, 429))
      .mockResolvedValueOnce(res(pred(), 201))
    const s = await client().submit('a/b', { prompt: 'x' })
    expect(s.requestId).toBe('p1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![0]).toBe(fetchMock.mock.calls[0]![0])
    expect(sleep.mock.calls).toEqual([[3500]])
  })

  it('caps the 429 wait at 30 s + 0.5 s, however large retry_after is', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ detail: 'slow down', retry_after: 9999 }, 429))
      .mockResolvedValueOnce(res(pred(), 201))
    const s = await client().submit('a/b', { prompt: 'x' })
    expect(s.requestId).toBe('p1')
    expect(sleep.mock.calls).toEqual([[30_500]])
  })

  it('a 429 with no retry_after waits the default 5 s; three 429s in all fail', async () => {
    fetchMock
      .mockResolvedValueOnce(res('busy', 429))
      .mockResolvedValueOnce(res({ retry_after: null }, 429))
      .mockResolvedValueOnce(res({ detail: 'still busy' }, 429))
    await expect(client().submit('a/b', {})).rejects.toThrow('Replicate predictions API HTTP 429: {"detail":"still busy"}')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[5500], [5500]])
  })

  it('reads retry_after the way Python int() does', () => {
    expect(retryAfterSeconds('{"retry_after": 2}')).toBe(2)
    expect(retryAfterSeconds('{"retry_after": 2.9}')).toBe(2)
    expect(retryAfterSeconds('{"retry_after": "7"}')).toBe(7)
    expect(retryAfterSeconds('{"retry_after": "7.5"}')).toBe(5)
    expect(retryAfterSeconds('{"retry_after": 0}')).toBe(5)
    expect(retryAfterSeconds('{}')).toBe(5)
    expect(retryAfterSeconds('[1]')).toBe(5)
    expect(retryAfterSeconds('not json')).toBe(5)
  })

  it('any other create error is final and names the status', async () => {
    fetchMock.mockResolvedValueOnce(res({ detail: 'bad input' }, 422))
    const e = await client().submit('a/b', {}).catch(x => x)
    expect(e).toBeInstanceOf(ReplicateError)
    expect(e.message).toBe('Replicate predictions API HTTP 422: {"detail":"bad input"}')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('without a token it fails plainly and sends nothing', async () => {
    await expect(client(null).submit('a/b', {})).rejects.toThrow('Replicate is not set up (add NUXT_REPLICATE_TOKEN)')
    await expect(client(null).status('S')).rejects.toThrow('Replicate is not set up (add NUXT_REPLICATE_TOKEN)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to REPLICATE_API_TOKEN when getReplicateToken() (settings/NUXT_REPLICATE_TOKEN) gives nothing', async () => {
    const prev = process.env.REPLICATE_API_TOKEN
    process.env.REPLICATE_API_TOKEN = 'r8_env_fallback'
    try {
      fetchMock.mockResolvedValueOnce(res(pred(), 201))
      await client(null).submit('a/b', { prompt: 'x' })
      expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Token r8_env_fallback')
    }
    finally {
      if (prev === undefined) delete process.env.REPLICATE_API_TOKEN
      else process.env.REPLICATE_API_TOKEN = prev
    }
  })
})

describe('status', () => {
  it('maps Replicate states onto the queue states', async () => {
    const c = client()
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'starting' })))
    expect(await c.status('S')).toMatchObject({ status: 'IN_QUEUE', queuePosition: null, error: null, transient: false })
    expect(fetchMock.mock.calls[0]![0]).toBe('S')
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Token r8_test')
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'processing', logs: 'loading\n 10%|█ | 1/10\r 40%|████ | 4/10' })))
    const p = await c.status('S', { logs: true })
    expect(p.status).toBe('IN_PROGRESS')
    expect(p.logs).toEqual([{ message: 'loading' }, { message: ' 10%|█ | 1/10' }, { message: ' 40%|████ | 4/10' }])
    expect(percentFromLogs(p.logs)).toBe(40)
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'succeeded', output: ['u'] })))
    expect(await c.status('S')).toMatchObject({ status: 'COMPLETED', error: null, retryable: false })
  })

  it('a failed or canceled prediction is completed with an error', async () => {
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'failed', error: 'NSFW content detected' })))
    expect(await client().status('S')).toMatchObject({ status: 'COMPLETED', error: 'Replicate: NSFW content detected', retryable: false })
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'canceled', error: null })))
    expect(await client().status('S')).toMatchObject({ status: 'COMPLETED', error: 'Replicate: prediction canceled', retryable: false })
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'failed' })))
    expect(await client().status('S')).toMatchObject({ error: 'Replicate: prediction failed', retryable: false })
  })

  it('a platform hiccup is flagged retryable; a model error is not', async () => {
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'failed', error: 'Unexpected error handling prediction (E9828)' })))
    expect(await client().status('S')).toMatchObject({ status: 'COMPLETED', retryable: true, error: 'Replicate: Unexpected error handling prediction (E9828)' })
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'failed', error: 'ValueError: width must be a multiple of 8' })))
    expect(await client().status('S')).toMatchObject({ retryable: false })
  })

  it('the transient markers match Python, case-insensitively', () => {
    expect([...TRANSIENT_REPLICATE_ERROR_MARKERS]).toEqual([
      'unexpected error handling prediction', 'e9828', 'prediction interrupted', 'internal error', 'please try again',
    ])
    expect(isTransientReplicateError('Prediction interrupted; please retry (code: PA)')).toBe(true)
    expect(isTransientReplicateError('INTERNAL ERROR')).toBe(true)
    expect(isTransientReplicateError('Something failed, Please try again later')).toBe(true)
    expect(isTransientReplicateError('E9828')).toBe(true)
    expect(isTransientReplicateError('input image is too large')).toBe(false)
    expect(isTransientReplicateError('')).toBe(false)
    expect(isTransientReplicateError(null)).toBe(false)
  })

  it('a 5xx or no answer is a blip; a 4xx is final', async () => {
    fetchMock.mockResolvedValueOnce(res({}, 503))
    expect((await client().status('S')).transient).toBe(true)
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect((await client().status('S')).transient).toBe(true)
    fetchMock.mockResolvedValueOnce(res({ detail: 'gone' }, 404))
    const e = await client().status('S').catch(x => x)
    expect(e).toBeInstanceOf(ReplicateError)
    expect(e.message).toMatch(/^Replicate status 404 \(not retryable\)/)
    expect(isProviderNetworkError(e)).toBe(false)
  })

  it('a 429 while polling is a blip, not the end of a paid prediction', async () => {
    fetchMock.mockResolvedValueOnce(res({ detail: 'slow down' }, 429))
    expect((await client().status('S')).transient).toBe(true)
  })

  it('a 200 with a missing or non-string status is a blip too, not a raw pass-through', async () => {
    fetchMock.mockResolvedValueOnce(res({ id: 'p1' }))
    expect(await client().status('S')).toEqual(expect.objectContaining({ status: 'UNKNOWN', transient: true }))
    fetchMock.mockResolvedValueOnce(res({ id: 'p1', status: 7 }))
    expect(await client().status('S')).toEqual(expect.objectContaining({ status: 'UNKNOWN', transient: true }))
    fetchMock.mockResolvedValueOnce(res({ id: 'p1', status: '' }))
    expect(await client().status('S')).toEqual(expect.objectContaining({ status: 'UNKNOWN', transient: true }))
  })
})

describe('result and output', () => {
  it('result is the prediction body', async () => {
    const body = pred({ status: 'succeeded', output: ['https://replicate.delivery/a.png'] })
    fetchMock.mockResolvedValueOnce(res(body))
    expect(await client().result('https://api.replicate.com/v1/predictions/p1')).toEqual(body)
    // A 4xx is final straight away, no retry.
    fetchMock.mockResolvedValueOnce(res('boom', 404))
    await expect(client().result('R')).rejects.toBeInstanceOf(ReplicateError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a 5xx fetching the result is retried up to twice, then given up on', async () => {
    fetchMock.mockResolvedValueOnce(res('boom', 502)).mockResolvedValueOnce(res(pred({ status: 'succeeded' })))
    expect(await client().result('R')).toMatchObject({ status: 'succeeded' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(res('still down', 503))
    const e = await client().result('R').catch(x => x)
    expect(e).toBeInstanceOf(ReplicateError)
    expect(e.message).toBe('Replicate result 503: still down')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('images: every string output; video: the first', () => {
    const c = client()
    expect(c.outputUrls({ output: ['a.png', 7, 'b.png'] }, 'image')).toEqual(['a.png', 'b.png'])
    expect(c.outputUrls({ output: 'a.png' }, 'image')).toEqual(['a.png'])
    expect(c.outputUrls({ output: null }, 'image')).toEqual([])
    expect(c.outputUrls({ output: { url: 'x' } }, 'image')).toEqual([])
    expect(c.outputUrls({ output: ['v.mp4', 'w.mp4'] }, 'video')).toEqual(['v.mp4'])
    expect(c.outputUrls({ output: 'v.mp4' }, 'video')).toEqual(['v.mp4'])
    expect(c.outputUrls({ output: [] }, 'video')).toEqual([])
    expect(allOutputUrls(null)).toEqual([])
    expect(firstOutputUrl({})).toBeNull()
  })

  it('log lines drop blanks', () => {
    expect(logLines('a\r\n\nb\r')).toEqual([{ message: 'a' }, { message: 'b' }])
    expect(logLines(null)).toEqual([])
  })
})

describe('cancel', () => {
  it('posts to the cancel url', async () => {
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'canceled' })))
    expect(await client().cancel('https://api.replicate.com/v1/predictions/p1/cancel')).toBe('cancelled')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.replicate.com/v1/predictions/p1/cancel')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Token r8_test')
  })

  it('a prediction that had already finished is already done; an unknown one is not found', async () => {
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'succeeded' })))
    expect(await client().cancel('C')).toBe('already-done')
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'failed' })))
    expect(await client().cancel('C')).toBe('already-done')
    fetchMock.mockResolvedValueOnce(res({ detail: 'Not found.' }, 404))
    expect(await client().cancel('C')).toBe('not-found')
    fetchMock.mockResolvedValueOnce(res('boom', 500))
    await expect(client().cancel('C')).rejects.toBeInstanceOf(ReplicateError)
  })

  it('a prediction that had just started (started_at set) is cancelled all the same: the job moves to its backup, Sailor absorbs the partial run', async () => {
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'canceled', started_at: '2026-09-24T10:00:00Z' })))
    expect(await client().cancel('C')).toBe('cancelled')
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'canceled', started_at: null })))
    expect(await client().cancel('C')).toBe('cancelled')
  })

  it('a 200 whose prediction still reads starting or processing was accepted, not applied: requested (24 Sep 2026)', async () => {
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'starting' })))
    expect(await client().cancel('C')).toBe('requested')
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'processing' })))
    expect(await client().cancel('C')).toBe('requested')
    fetchMock.mockResolvedValueOnce(res('not json'))
    expect(await client().cancel('C')).toBe('requested')
  })

  it('a cancel that hangs is given up on (its fetch carries a time-out signal)', async () => {
    fetchMock.mockResolvedValueOnce(res(pred({ status: 'canceled' })))
    await client().cancel('C')
    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal)
  })
})
