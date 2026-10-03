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

  it('Stop aborts the request and shows no error', async () => {
    const a = useLayerAnimate()
    const run = a.animate(createImageLayer('rose.png', 1), opts)
    while (!calls.length) await new Promise(r => setTimeout(r, 1))
    expect(a.busy.value).toBe(true)
    a.stop()
    await expect(run).rejects.toBeInstanceOf(AnimateCancelled)
    expect(calls[0]!.opts.signal!.aborted).toBe(true)
    expect(a.error.value).toBe('')
    expect(a.busy.value).toBe(false)
  })
})
