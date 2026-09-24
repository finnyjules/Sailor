/**
 * The engine on Replicate (Phase B, Task B3), with the fake Replicate from the
 * kit: no test here can reach api.replicate.com or fal. No real node plans a
 * Replicate request yet (the Replicate families come later), so a node whose
 * inputs carry `test_provider: 'replicate'` is turned into a Replicate plan
 * here, on a slug given by `test_slug` (default: the fal endpoint, unchanged).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  REPLICATE_HICCUP, REPLICATE_REFUSAL, createFakeFal, createFakeLedger, createFakeReplicate, makeKit, ofType, until,
} from './__runner__/kit'
import { createReplicateClient } from '~~/server/runner/replicateQueue'
import type { ApiPrompt } from '#shared/runner/graph'

vi.mock('~~/server/runner/executors', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/executors')>()
  return {
    ...real,
    planNode: async (ctx: Parameters<typeof real.planNode>[0]) => {
      const plan = await real.planNode(ctx)
      const inputs = ctx.prompt[ctx.nodeId]!.inputs
      if (plan.kind === 'provider' && inputs.test_provider === 'replicate') {
        return { ...plan, provider: 'replicate' as const, endpoint: typeof inputs.test_slug === 'string' ? inputs.test_slug : plan.endpoint }
      }
      return plan
    },
  }
})

const SLUG = 'black-forest-labs/flux-2-pro'
const onReplicate = (prompt = 'a red fox', o: { seed?: number; slug?: string | null } = {}): ApiPrompt => ({
  '1': {
    class_type: 'GenerateImageNode',
    inputs: {
      model: 'flux-schnell', prompt, aspect_ratio: '1:1', seed: o.seed ?? 0, model_options: '{}',
      test_provider: 'replicate', ...(o.slug === null ? {} : { test_slug: o.slug ?? SLUG }),
    },
  },
  '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})
const onFal = (prompt = 'a red fox', seed = 0): ApiPrompt => ({
  '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt, aspect_ratio: '1:1', seed, model_options: '{}' } },
  '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})
const start = (k: ReturnType<typeof makeKit>, takes: ApiPrompt[]) =>
  k.engine.startRun({ userId: k.userId, takes, workflow: null, canvasId: null, projectUuid: null, projectName: null })
const holds = (ledger: ReturnType<typeof createFakeLedger>) => [...ledger.holds.values()].map(h => [h.state, h.actual])

describe('a Replicate request', () => {
  it('runs on Replicate, is charged once, and is recorded', async () => {
    const k = makeKit({ hosted: true, deps: { webhookUrl: () => 'https://app.test/api/webhooks/fal' } })
    k.replicate.holdNext(1)
    const { runId } = await start(k, [onReplicate()])
    await until(() => (k.replicate.submitted()[0]?.polls ?? 0) >= 2)
    k.replicate.release()
    await k.engine.settled(runId)

    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).toHaveBeenCalledTimes(1)
    const [slug, payload, opts] = (k.replicate.client.submit as any).mock.calls[0]
    expect(slug).toBe(SLUG)
    expect(payload.prompt).toBe('a red fox')
    // No Replicate webhook route exists: the fal one is never handed to Replicate.
    expect(opts).toEqual({ webhookUrl: null })

    const run = (await k.store.get(runId))!
    const rec = run.takes[0]!.nodes['1']!
    expect(rec.status).toBe('done')
    expect(rec.endpoint).toBe(SLUG)
    expect(rec.request).toMatchObject({ provider: 'replicate', requestId: 'pred1', statusUrl: 'replicate://pred1', cancelUrl: 'replicate://pred1/cancel' })
    expect(rec.outputs).toHaveLength(1)
    expect(rec.outputs[0]).toMatchObject({ filename: 'generate_image_00001_.png', type: 'output' })
    expect(k.replicate.client.outputUrls).toHaveBeenCalledWith(expect.objectContaining({ output: ['https://replicate.delivery/pred1.png'] }), 'image')
    // The terminal status body already carried the output: no second GET.
    expect(k.replicate.client.result).not.toHaveBeenCalled()
    // flux-schnell (2: 1:1 is 2 MP under the megapixel ruling) + the render credit (1), held and settled once
    expect(k.ledger.hold).toHaveBeenCalledTimes(1)
    expect(k.ledger.settle).toHaveBeenCalledTimes(1)
    expect(holds(k.ledger)).toEqual([['settled', 3]])
    expect(k.records.write).toHaveBeenCalledTimes(1)
    expect(ofType(k.seen, 'progress').some(m => m.data.value === 50)).toBe(true)
  })

  it('falls back to a second GET when the terminal status body carries no raw output', async () => {
    const replicate = createFakeReplicate()
    // A status body with no usable `raw` (e.g. an older/odd Replicate
    // response): the engine must still fetch the result via a second GET.
    const original = (replicate.client.status as any).getMockImplementation()!
    ;(replicate.client.status as any).mockImplementation(async (url: string) => {
      const s = await original(url)
      return s.status === 'COMPLETED' && !s.error ? { ...s, raw: null } : s
    })
    const k = makeKit({ hosted: true, replicate })
    const { runId } = await start(k, [onReplicate()])
    await k.engine.settled(runId)

    expect(k.replicate.client.result).toHaveBeenCalledTimes(1)
    const run = (await k.store.get(runId))!
    const rec = run.takes[0]!.nodes['1']!
    expect(rec.status).toBe('done')
    expect(rec.outputs).toHaveLength(1)
  })

  it('a fal and a Replicate request with the same body never share a saved result', async () => {
    const k = makeKit()
    const falFirst = onFal('same', 5)
    await k.engine.settled((await start(k, [falFirst])).runId)
    expect(k.fal.submitted()).toHaveLength(1)
    // Same endpoint string, same payload: only the provider differs.
    const same = onReplicate('same', { seed: 5, slug: null })
    await k.engine.settled((await start(k, [same])).runId)
    expect(k.replicate.submitted()).toHaveLength(1)
    expect(k.replicate.submitted()[0]!.endpoint).toBe(k.fal.submitted()[0]!.endpoint)
    // Asked again on Replicate: now its own earlier result is handed back.
    const { runId } = await start(k, [same])
    await k.engine.settled(runId)
    expect(k.replicate.submitted()).toHaveLength(1)
    expect((await k.store.get(runId))!.takes[0]!.nodes['1']!.reused).toBe(true)
  })

  it('a restart mid-request asks Replicate again, not fal', async () => {
    const fal = createFakeFal()
    const replicate = createFakeReplicate()
    const ledger = createFakeLedger()
    const state = { crashed: false }
    const k1 = makeKit({
      hosted: true, fal, replicate, ledger,
      deps: { sleep: () => (state.crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))) },
    })
    replicate.holdNext(1)
    const { runId } = await start(k1, [onReplicate()])
    await until(() => (replicate.submitted()[0]?.polls ?? 0) >= 2)
    state.crashed = true
    await new Promise(r => setTimeout(r, 20))
    expect((await k1.store.get(runId))!.takes[0]!.nodes['1']!.request!.provider).toBe('replicate')

    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, fal, replicate, ledger })
    const pollsBefore = replicate.submitted()[0]!.polls
    expect(await k2.engine.reattach()).toBe(1)
    replicate.release()
    await k2.engine.settled(runId)
    expect(replicate.submitted()).toHaveLength(1) // polled again, not sent again
    expect(replicate.submitted()[0]!.polls).toBeGreaterThan(pollsBefore)
    expect(fal.client.submit).not.toHaveBeenCalled()
    expect(fal.client.status).not.toHaveBeenCalled()
    expect((await k2.store.get(runId))!.takes[0]!.nodes['1']!.status).toBe('done')
    expect(holds(ledger)).toEqual([['settled', 3]])
  })

  it('without a Replicate token the node fails plainly, sends nothing and charges nothing', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('no network in tests') })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const fal = createFakeFal()
      const k = makeKit({ hosted: true, fal, deps: { providers: { fal: fal.client, replicate: createReplicateClient({ token: () => null }) } } })
      const { runId } = await start(k, [onReplicate()])
      await k.engine.settled(runId)
      const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
      expect(rec.status).toBe('error')
      expect(rec.error).toBe('Replicate is not set up (add NUXT_REPLICATE_TOKEN)')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(fal.client.submit).not.toHaveBeenCalled()
      expect(holds(k.ledger)).toEqual([['released', null]])
    }
    finally { vi.unstubAllGlobals() }
  })

  it('Stop cancels on Replicate', async () => {
    const k = makeKit({ hosted: true })
    k.replicate.holdNext(1)
    const { runId } = await start(k, [onReplicate()])
    await until(() => (k.replicate.submitted()[0]?.polls ?? 0) >= 2)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    expect(k.replicate.client.cancel).toHaveBeenCalledWith('replicate://pred1/cancel')
    expect(k.fal.client.cancel).not.toHaveBeenCalled()
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('stopped')
    expect(run.takes[0]!.nodes['1']!.status).toBe('stopped')
    expect(holds(k.ledger)).toEqual([['released', null]])
  })
})

describe('a Replicate hiccup is sent again', () => {
  it('two hiccups, then success: three predictions, charged once', async () => {
    const sleeps: number[] = []
    const k = makeKit({
      hosted: true,
      deps: { sleep: (ms, signal) => { sleeps.push(ms); return new Promise<void>((r) => { const t = setTimeout(r, 1); signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) }) } },
    })
    k.replicate.hiccupNext(2)
    const { runId } = await start(k, [onReplicate()])
    await k.engine.settled(runId)

    expect(k.replicate.submitted().map(r => [r.endpoint, r.payload.prompt])).toEqual([[SLUG, 'a red fox'], [SLUG, 'a red fox'], [SLUG, 'a red fox']])
    // Python's backoff: 2 s, then 4 s, before each new prediction.
    expect(sleeps.filter(ms => ms >= 2000)).toEqual([2000, 4000])
    const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(rec.status).toBe('done')
    expect(rec.request).toMatchObject({ provider: 'replicate', requestId: 'pred3', retries: 2 })
    expect(k.ledger.hold).toHaveBeenCalledTimes(1)
    expect(k.ledger.settle).toHaveBeenCalledTimes(1)
    expect(holds(k.ledger)).toEqual([['settled', 3]])
    expect(k.records.write).toHaveBeenCalledTimes(1)
  })

  it('a third hiccup is an error, and the hold is dropped', async () => {
    const k = makeKit({ hosted: true })
    k.replicate.hiccupNext(3)
    const { runId } = await start(k, [onReplicate()])
    await k.engine.settled(runId)
    expect(k.replicate.submitted()).toHaveLength(3)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(rec.status).toBe('error')
    expect(rec.error).toBe(`Replicate: ${REPLICATE_HICCUP}`)
    expect(holds(k.ledger)).toEqual([['released', null]])
    expect(k.records.write).not.toHaveBeenCalled()
  })

  it('any other failure is final at once', async () => {
    const k = makeKit({ hosted: true })
    k.replicate.failNext(1)
    const { runId } = await start(k, [onReplicate()])
    await k.engine.settled(runId)
    expect(k.replicate.submitted()).toHaveLength(1)
    expect((await k.store.get(runId))!.takes[0]!.nodes['1']!.error).toBe(`Replicate: ${REPLICATE_REFUSAL}`)
    expect(holds(k.ledger)).toEqual([['released', null]])
  })

  it('a fal failure is never sent again', async () => {
    const k = makeKit({ hosted: true })
    k.fal.failNext(1)
    const { runId } = await start(k, [onFal()])
    await k.engine.settled(runId)
    expect(k.fal.submitted()).toHaveLength(1)
    expect((await k.store.get(runId))!.takes[0]!.nodes['1']!.status).toBe('error')
  })

  it('the re-run is sent inside the node’s per-user slot: another node never slips in during the backoff', async () => {
    // One slot per user, two versions. The first prediction hiccups; its
    // re-run must go out before the second version gets the slot.
    const k = makeKit({ hosted: true, deps: { perUserLimit: 1 } })
    let inFlight = 0
    let most = 0
    const submit = (k.replicate.client.submit as any).getMockImplementation()!
    ;(k.replicate.client.submit as any).mockImplementation(async (...a: unknown[]) => {
      most = Math.max(most, ++inFlight)
      return submit(...a)
    })
    const status = (k.replicate.client.status as any).getMockImplementation()!
    ;(k.replicate.client.status as any).mockImplementation(async (url: string) => {
      const s = await status(url)
      if (s.status === 'COMPLETED') inFlight--
      return s
    })
    k.replicate.hiccupNext(1)
    const { runId } = await start(k, [onReplicate('first'), onReplicate('second')])
    await k.engine.settled(runId)

    // Whichever version got the slot first, its re-run follows it directly.
    const sent = k.replicate.submitted().map(r => r.payload.prompt)
    expect(sent).toHaveLength(3)
    expect(sent[1]).toBe(sent[0])
    expect(sent[2]).not.toBe(sent[0])
    expect(most).toBe(1)
    const run = (await k.store.get(runId))!
    expect(run.takes.map(t => t.nodes['1']!.status)).toEqual(['done', 'done'])
    expect(run.takes.map(t => t.nodes['1']!.request!.retries ?? 0).sort()).toEqual([0, 1])
  })

  it('Stop during the backoff sends nothing more, and the version waiting for the slot never goes out', async () => {
    let backingOff = false
    const k = makeKit({
      hosted: true,
      deps: {
        perUserLimit: 1,
        // The 2 s backoff waits until Stop; every other wait is short.
        sleep: (ms, signal) => new Promise<void>((resolve) => {
          if (ms >= 2000) backingOff = true
          const t = ms >= 2000 ? null : setTimeout(resolve, 1)
          signal.addEventListener('abort', () => { if (t) clearTimeout(t); resolve() }, { once: true })
        }),
      },
    })
    k.replicate.hiccupNext(1)
    const { runId } = await start(k, [onReplicate('first'), onReplicate('second')])
    await until(() => backingOff)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)

    expect(k.replicate.submitted()).toHaveLength(1)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('stopped')
    expect(run.takes.map(t => t.nodes['1']!.status)).toEqual(['stopped', 'stopped'])
    expect(holds(k.ledger).every(([state]) => state === 'released')).toBe(true)
  })

  it('a restart during a re-run carries on with the new prediction and its count', async () => {
    const fal = createFakeFal()
    const replicate = createFakeReplicate()
    const ledger = createFakeLedger()
    const state = { crashed: false }
    const k1 = makeKit({
      hosted: true, fal, replicate, ledger,
      deps: { sleep: () => (state.crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))) },
    })
    replicate.hiccupNext(1)
    replicate.holdNext(2)
    const { runId } = await start(k1, [onReplicate()])
    await until(() => (replicate.submitted()[0]?.polls ?? 0) >= 2)
    replicate.release('pred1') // it now fails with the hiccup; pred2 stays processing
    await until(() => (replicate.submitted()[1]?.polls ?? 0) >= 2)
    state.crashed = true
    await new Promise(r => setTimeout(r, 20))
    expect((await k1.store.get(runId))!.takes[0]!.nodes['1']!.request).toMatchObject({ requestId: 'pred2', retries: 1 })

    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, fal, replicate, ledger })
    expect(await k2.engine.reattach()).toBe(1)
    replicate.release()
    await k2.engine.settled(runId)
    expect(replicate.submitted()).toHaveLength(2)
    expect((await k2.store.get(runId))!.takes[0]!.nodes['1']!.status).toBe('done')
    expect(holds(ledger)).toEqual([['settled', 3]])
  })
})

describe('fal and Replicate in one workflow', () => {
  it('a Replicate picture through a Gate into a fal video', async () => {
    const k = makeKit({ hosted: true })
    const flow: ApiPrompt = {
      '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', test_provider: 'replicate', test_slug: SLUG } },
      '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: false } },
      '3': { class_type: 'GenerateVideoNode', inputs: { model: 'hailuo-h3', prompt: 'the fox runs', image: ['2', 0], aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}' } },
      '4': { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['3', 0] } },
      '5': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
    }
    const { runId } = await start(k, [flow])
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('paused')
    expect(k.replicate.submitted()).toHaveLength(1)
    expect(k.fal.client.submit).not.toHaveBeenCalled()

    await k.engine.gateAction({ userId: k.userId, runId, gateId: '2', action: 'continue' })
    await k.engine.settled(runId)
    expect(k.replicate.submitted()).toHaveLength(1)
    const video = k.fal.submitted()[0]!
    expect(video.endpoint).toBe('minimax/h3/image-to-video')
    expect(video.payload.image_url).toBe('https://fal.storage/generate_image_00001_.png')
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    expect(run.takes[0]!.nodes['1']!.request!.provider).toBe('replicate')
    expect(run.takes[0]!.nodes['3']!.request!.provider).toBe('fal')
    expect(run.takes[0]!.nodes['3']!.outputs[0]!.filename).toMatch(/\.mp4$/)
    // image once on Replicate, video once on fal
    expect(holds(k.ledger)).toEqual([['settled', 3], ['settled', 45]])
    expect(k.records.write).toHaveBeenCalledTimes(2)
  })
})
