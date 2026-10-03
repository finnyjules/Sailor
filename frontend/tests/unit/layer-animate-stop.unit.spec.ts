// @vitest-environment happy-dom
// Step 3, LC10: useLayerAnimate in hosted (no more LC7 refusal) and its Stop:
// the request is aborted (the route then stops the model's call, the keying and
// leaves no folder), and a stopped attempt shows no error.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnimateCancelled, useLayerAnimate } from '~/composables/useLayerAnimate'
import { createImageLayer } from '~/composables/useCompositorLayers'

const calls: Array<{ url: string; opts: { signal?: AbortSignal; body?: unknown } }> = []
let answer: 'wait' | 'ok' = 'wait'

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { hostedMode: true } }))
  vi.stubGlobal('fetch', async () => new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })))
  vi.stubGlobal('$fetch', (url: string, opts: { signal?: AbortSignal }) => {
    calls.push({ url, opts })
    if (answer === 'ok') return Promise.resolve({ dir: 'sailor_clips/c', frames: 5, fps: 24, model: 'seedance-2.0', prompt: 'p' })
    return new Promise((_, reject) => opts.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  })
})
afterEach(() => { vi.unstubAllGlobals(); answer = 'wait' })

const opts = { prompt: 'p', model: 'seedance-2.0', seconds: 5 }

describe('useLayerAnimate', () => {
  it('runs in hosted', async () => {
    answer = 'ok'
    const a = useLayerAnimate()
    const clip = await a.animate(createImageLayer('rose.png', 1), opts)
    expect(clip).toMatchObject({ dir: 'sailor_clips/c', frames: 5, speed: 1 })
    expect(calls[0]!.url).toBe('/api/frame/animate')
    expect('available' in a).toBe(false)
  })

  it('Stop aborts the request and shows no error; the attempt was handed over first', async () => {
    const a = useLayerAnimate()
    const sent: any[] = []
    const run = a.animate(createImageLayer('rose.png', 1), opts, p => sent.push(p))
    while (!calls.length) await new Promise(r => setTimeout(r, 1))
    expect(a.busy.value).toBe(true)
    a.stop()
    await expect(run).rejects.toBeInstanceOf(AnimateCancelled)
    expect(calls[0]!.opts.signal!.aborted).toBe(true)
    expect(a.error.value).toBe('')
    expect(a.busy.value).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0].attempt).toMatch(/^[0-9a-f-]{36}$/)
    expect((calls[0]!.opts as any).body.attempt).toBe(sent[0].attempt)
  })

  it('resume picks up a finished attempt as a clip, and drops a stopped or unknown one', async () => {
    const answers: Record<string, any> = {
      a1: { state: 'keying', paid: true },
      a2: { state: 'stopped', paid: false },
    }
    let looks = 0
    vi.stubGlobal('$fetch', async (url: string) => {
      const id = url.split('/').pop()!
      looks++
      if (id === 'a1' && looks > 3) return { state: 'done', paid: true, clip: { dir: 'sailor_clips/c1', frames: 5, fps: 24, model: 'm', prompt: 'p' } }
      if (answers[id]) return answers[id]
      throw Object.assign(new Error('nf'), { statusCode: 404 })
    })
    vi.useFakeTimers()
    const a = useLayerAnimate()
    const got: Array<[string, string, unknown]> = []
    const layers = [
      { id: 'L1', pendingAnimate: { attempt: 'a1', model: 'm', prompt: 'p', at: 0 } },
      { id: 'L2', pendingAnimate: { attempt: 'a2', model: 'm', prompt: 'p', at: 0 } },
      { id: 'L3', pendingAnimate: { attempt: 'a3', model: 'm', prompt: 'p', at: 0 } },
      { id: 'L4' },
    ]
    a.resume(layers, (id, at, clip) => got.push([id, at, clip]))
    a.resume(layers, (id, at, clip) => got.push([id, at, clip])) // a second call adds no second look
    await vi.advanceTimersByTimeAsync(0)
    expect(got.map(g => g[0]).sort()).toEqual(['L2', 'L3'])
    expect(got.every(g => g[2] === null)).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(got.find(g => g[0] === 'L1')).toEqual(['L1', 'a1', { dir: 'sailor_clips/c1', frames: 5, fps: 24, model: 'm', prompt: 'p', speed: 1 }])
    a.dispose()
    vi.useRealTimers()
  })
})
