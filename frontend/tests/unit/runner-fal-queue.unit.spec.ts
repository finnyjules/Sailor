import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  falSubmit, falStatus, falResult, falCancel, percentFromLogs, falImageUrls, falVideoUrl, FalError,
  isFalNetworkError, downloadResult,
} from '~~/server/runner/falQueue'

const res = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, statusText: '',
  json: async () => body, text: async () => JSON.stringify(body),
})
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => { process.env.FAL_KEY = 'k1'; fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals(); delete process.env.FAL_KEY })

describe('falSubmit', () => {
  it('posts with the key and asks fal to call the webhook', async () => {
    fetchMock.mockResolvedValueOnce(res({ request_id: 'r1', status_url: 'S', response_url: 'R', cancel_url: 'C', queue_position: 2 }))
    const s = await falSubmit('fal-ai/flux/schnell', { prompt: 'x' }, { webhookUrl: 'https://app.test/api/webhooks/fal' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://queue.fal.run/fal-ai/flux/schnell?fal_webhook=https%3A%2F%2Fapp.test%2Fapi%2Fwebhooks%2Ffal')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Key k1')
    expect(JSON.parse(init.body)).toEqual({ prompt: 'x' })
    expect(s).toEqual({ requestId: 'r1', statusUrl: 'S', responseUrl: 'R', cancelUrl: 'C', queuePosition: 2 })
  })
  it('builds the request urls itself when fal leaves them out', async () => {
    fetchMock.mockResolvedValueOnce(res({ request_id: 'r2' }))
    const s = await falSubmit('minimax/h3/image-to-video', {})
    expect(fetchMock.mock.calls[0]![0]).toBe('https://queue.fal.run/minimax/h3/image-to-video')
    expect(s.statusUrl).toBe('https://queue.fal.run/minimax/h3/image-to-video/requests/r2/status')
    expect(s.responseUrl).toBe('https://queue.fal.run/minimax/h3/image-to-video/requests/r2')
    expect(s.cancelUrl).toBe('https://queue.fal.run/minimax/h3/image-to-video/requests/r2/cancel')
    expect(s.queuePosition).toBeNull()
  })
  it('refuses without a key and reports a rejected submit', async () => {
    delete process.env.FAL_KEY
    await expect(falSubmit('a/b', {})).rejects.toThrow('FAL_KEY is not set')
    process.env.FAL_KEY = 'k1'
    fetchMock.mockResolvedValueOnce(res({ detail: 'bad' }, 422))
    await expect(falSubmit('a/b', {})).rejects.toThrow(/^fal submit 422/)
  })
})

describe('falStatus', () => {
  it('reads queue position and asks for logs only when told to', async () => {
    fetchMock.mockResolvedValueOnce(res({ status: 'IN_QUEUE', queue_position: 3 }, 202))
    const s = await falStatus('https://q/requests/r1/status')
    expect(fetchMock.mock.calls[0]![0]).toBe('https://q/requests/r1/status')
    expect(s).toMatchObject({ status: 'IN_QUEUE', queuePosition: 3, transient: false, error: null })
    fetchMock.mockResolvedValueOnce(res({ status: 'IN_PROGRESS', logs: [{ message: 'step 40%' }] }, 202))
    const p = await falStatus('https://q/requests/r1/status', { logs: true })
    expect(fetchMock.mock.calls[1]![0]).toBe('https://q/requests/r1/status?logs=1')
    expect(p.logs).toEqual([{ message: 'step 40%' }])
  })
  it('treats a 5xx as a blip and a 4xx as final', async () => {
    fetchMock.mockResolvedValueOnce(res({}, 503))
    expect((await falStatus('S')).transient).toBe(true)
    fetchMock.mockResolvedValueOnce(res({ detail: 'gone' }, 404))
    await expect(falStatus('S')).rejects.toBeInstanceOf(FalError)
  })
  it('a network error (no answer at all) is a blip too, in the usual shape', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await falStatus('S')).toEqual({ status: 'UNKNOWN', queuePosition: null, logs: [], error: null, transient: true, raw: null })
  })
  it('passes through a completed-with-error answer', async () => {
    fetchMock.mockResolvedValueOnce(res({ status: 'COMPLETED', error: 'NSFW content detected' }))
    expect((await falStatus('S')).error).toBe('NSFW content detected')
  })
})

describe('falResult and falCancel', () => {
  it('returns the body, or throws on failure', async () => {
    fetchMock.mockResolvedValueOnce(res({ images: [{ url: 'u' }] }))
    expect(await falResult('R')).toEqual({ images: [{ url: 'u' }] })
    fetchMock.mockResolvedValueOnce(res({ detail: 'x' }, 500))
    await expect(falResult('R')).rejects.toThrow(/^fal result 500/)
  })
  it('maps cancel answers', async () => {
    fetchMock.mockResolvedValueOnce(res({ status: 'CANCELLATION_REQUESTED' }, 202))
    expect(await falCancel('C')).toBe('cancelled')
    expect(fetchMock.mock.calls[0]![1].method).toBe('PUT')
    fetchMock.mockResolvedValueOnce(res({ status: 'ALREADY_COMPLETED' }, 400))
    expect(await falCancel('C')).toBe('already-done')
    fetchMock.mockResolvedValueOnce(res({}, 404))
    expect(await falCancel('C')).toBe('not-found')
  })
})

describe('helpers', () => {
  it('percentFromLogs takes the last percentage it can find', () => {
    expect(percentFromLogs([])).toBeNull()
    expect(percentFromLogs([{ message: 'loading' }])).toBeNull()
    expect(percentFromLogs([{ message: '10%' }, { message: 'Generating 55% done' }])).toBe(55)
    expect(percentFromLogs([{ message: '250%' }])).toBeNull()
  })
  it('reads result urls', () => {
    expect(falImageUrls({ images: [{ url: 'a' }, { url: '' }, { url: 'b' }] })).toEqual(['a', 'b'])
    expect(falImageUrls({})).toEqual([])
    expect(falVideoUrl({ video: { url: 'v' } })).toBe('v')
    expect(falVideoUrl({ video: {} })).toBeNull()
  })
})

describe('network errors', () => {
  it('only a missing answer counts, never an HTTP status', () => {
    expect(isFalNetworkError(new TypeError('fetch failed'))).toBe(true)
    expect(isFalNetworkError(new FalError('fal result 500: x', 500))).toBe(false)
    expect(isFalNetworkError(new FalError('fal result 404: x', 404))).toBe(false)
    expect(isFalNetworkError(new SyntaxError('Unexpected token'))).toBe(false)
  })
})

describe('downloadResult', () => {
  const file = (status: number) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (h: string) => (h === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  })
  it('tries again after a network error and a 5xx, waiting 1s then 2s', async () => {
    const sleep = vi.fn(async () => {})
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(file(502))
      .mockResolvedValueOnce(file(200))
    const got = await downloadResult('https://fal.media/a.png', { sleep })
    expect(Array.from(got.bytes)).toEqual([1, 2, 3])
    expect(got.contentType).toBe('image/png')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map(c => (c as unknown[])[0])).toEqual([1000, 2000])
  })
  it('gives up after three tries', async () => {
    const sleep = vi.fn(async () => {})
    fetchMock.mockResolvedValue(file(503))
    await expect(downloadResult('https://fal.media/a.png', { sleep })).rejects.toThrow('Could not download the result (503)')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it('a 4xx fails at once', async () => {
    const sleep = vi.fn(async () => {})
    fetchMock.mockResolvedValueOnce(file(404))
    await expect(downloadResult('https://fal.media/a.png', { sleep })).rejects.toThrow('Could not download the result (404)')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})
