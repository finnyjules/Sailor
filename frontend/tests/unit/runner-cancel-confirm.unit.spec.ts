/**
 * A cancel is only a cancel once the provider confirms it.
 *
 * 24 Sep 2026: a Nano Banana 2 prediction on Replicate (g4thb6k4…) ran past
 * the 5-minute limit; the runner asked Replicate to cancel it, swallowed
 * whatever came back, told the user "so it was cancelled" and released the
 * hold — and the prediction was still "starting" at Replicate 20 hours later.
 *
 * These tests drive the REAL Replicate and fal clients against a fake
 * provider behind a stubbed fetch (nothing here can reach api.replicate.com
 * or fal), on a fake clock. The fake can accept a cancel without applying it
 * (a 200 whose prediction still reads "starting"), refuse it (a 5xx), or drop
 * it (no answer), as a degraded provider does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeLedger, makeKit } from './__runner__/kit'
import { createReplicateClient } from '~~/server/runner/replicateQueue'
import { realFalClient } from '~~/server/runner/falQueue'
import { cancelAndConfirm } from '~~/server/runner/cancelCheck'
import { CANCEL_WATCH_GIVE_UP_MS } from '~~/server/runner/engine'
import type { RunRecord } from '~~/server/runner/types'
import type { ApiPrompt } from '#shared/runner/graph'

vi.mock('~~/server/runner/executors', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/executors')>()
  return {
    ...real,
    planNode: async (ctx: Parameters<typeof real.planNode>[0]) => {
      const plan = await real.planNode(ctx)
      const inputs = ctx.prompt[ctx.nodeId]!.inputs
      if (plan.kind === 'provider' && inputs.test_provider === 'replicate') {
        return { ...plan, provider: 'replicate' as const, endpoint: 'google/nano-banana-2', backup: null }
      }
      if (plan.kind === 'provider') return { ...plan, backup: null }
      return plan
    },
  }
})

// ── A fake provider behind fetch ───────────────────────────────────────────
type CancelAnswer = 'apply' | 'ignore' | 'http-500' | 'http-402' | 'network'
interface Pred { id: string; status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled'; output: string[] | null }

function fakeReplicateHttp() {
  const preds = new Map<string, Pred>()
  /** How the next cancels are answered, in order (then `cancelDefault`). */
  const cancels: CancelAnswer[] = []
  const state = { cancelDefault: 'apply' as CancelAnswer, cancelPosts: 0, gets: 0, seq: 0 }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const view = (p: Pred) => ({ id: p.id, status: p.status, output: p.output, error: p.status === 'canceled' ? null : null, logs: '' })
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const m = /^https:\/\/api\.replicate\.com\/v1\/(.*)$/.exec(url)
    if (!m) throw new Error(`unexpected fetch ${url}`)
    const path = m[1]!
    if (init?.method === 'POST' && path.startsWith('models/') && path.endsWith('/predictions')) {
      const p: Pred = { id: `g4thb${++state.seq}`, status: 'starting', output: null }
      preds.set(p.id, p)
      return json(view(p), 201)
    }
    const cancel = /^predictions\/([^/]+)\/cancel$/.exec(path)
    if (cancel && init?.method === 'POST') {
      state.cancelPosts++
      const p = preds.get(cancel[1]!)
      if (!p) return json({ detail: 'Not found.' }, 404)
      const answer = cancels.shift() ?? state.cancelDefault
      if (answer === 'network') throw new TypeError('fetch failed')
      if (answer === 'http-500') return json({ detail: 'Internal server error' }, 500)
      if (answer === 'http-402') return json({ detail: 'You have insufficient credit' }, 402)
      // 'ignore': accepted, not applied — the prediction still reads "starting".
      if (answer === 'apply' && (p.status === 'starting' || p.status === 'processing')) p.status = 'canceled'
      return json(view(p))
    }
    const get = /^predictions\/([^/]+)$/.exec(path)
    if (get && (!init?.method || init.method === 'GET')) {
      state.gets++
      const p = preds.get(get[1]!)
      return p ? json(view(p)) : json({ detail: 'Not found.' }, 404)
    }
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
  })
  return { fetch, preds, cancels, state }
}

const START = 1_000_000
const POLL_MS = 5_000

function setup(o: { dir?: string; ledger?: ReturnType<typeof createFakeLedger> } = {}) {
  const clock = { t: START }
  // The background cancel checks wait 30 s or more: those waits hold here until `resume()`.
  let open!: () => void
  const background = new Promise<void>((r) => { open = r })
  const http = fakeReplicateHttp()
  vi.stubGlobal('fetch', http.fetch)
  const replicate = createReplicateClient({ token: () => 'r8_test', sleep: async () => {} })
  const k = makeKit({
    hosted: true, dir: o.dir, ledger: o.ledger,
    deps: {
      providers: { fal: realFalClient, replicate },
      now: () => clock.t,
      // Every wait moves the fake clock on; nothing waits for real.
      sleep: async (ms, _signal) => {
        if (ms >= 30_000) await background
        clock.t += ms
        await new Promise(r => setTimeout(r, 0))
      },
      pollDelayMs: () => POLL_MS,
    },
  })
  return { ...k, clock, http, resume: () => open() }
}

const flow = (provider: 'replicate' | 'fal' = 'replicate'): ApiPrompt => ({
  '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'the dog', aspect_ratio: '1:1', seed: 0, model_options: '{}', test_provider: provider } },
  '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})
const start = (k: ReturnType<typeof setup>, provider: 'replicate' | 'fal' = 'replicate') =>
  k.engine.startRun({ userId: k.userId, takes: [flow(provider)], workflow: null, canvasId: null, projectUuid: null, projectName: null })
const holds = (ledger: ReturnType<typeof createFakeLedger>) => [...ledger.holds.values()].map(h => [h.state, h.actual])
const sites = (k: ReturnType<typeof setup>) => (k.deps.reportError as any).mock.calls.map((c: unknown[]) => (c[1] as { site: string }).site)

beforeEach(() => { process.env.FAL_KEY = 'fal_test' })
afterEach(() => { vi.unstubAllGlobals(); delete process.env.FAL_KEY })

describe('the Replicate client never reads an accepted cancel as a cancel', () => {
  it('a 200 whose prediction still reads "starting" is a request, not a cancel', async () => {
    const http = fakeReplicateHttp()
    vi.stubGlobal('fetch', http.fetch)
    const client = createReplicateClient({ token: () => 'r8_test' })
    const sub = await client.submit('google/nano-banana-2', { prompt: 'x' })
    http.cancels.push('ignore')
    expect(await client.cancel(sub.cancelUrl)).toBe('requested')
    expect(await client.cancel(sub.cancelUrl)).toBe('cancelled')
  })
})

describe('cancelAndConfirm', () => {
  const opts = { tries: 3, waitMs: () => 1, sleep: async () => {} }
  async function submitted() {
    const http = fakeReplicateHttp()
    vi.stubGlobal('fetch', http.fetch)
    const client = createReplicateClient({ token: () => 'r8_test' })
    const sub = await client.submit('google/nano-banana-2', { prompt: 'x' })
    return { http, client, sub, pred: () => http.preds.get(sub.requestId)! }
  }

  it('a Replicate that ignores the first cancel is asked again, and only believed once the prediction reads canceled', async () => {
    const { http, client, sub, pred } = await submitted()
    http.cancels.push('ignore')
    const check = await cancelAndConfirm(client, sub, opts)
    expect(check).toMatchObject({ confirmed: true, ended: 'ended' })
    expect(http.state.cancelPosts).toBe(2)
    expect(pred().status).toBe('canceled')
  })

  it('a cancel refused (5xx, 402) or dropped (no answer) is tried again', async () => {
    for (const first of ['http-500', 'http-402', 'network'] as const) {
      const { http, client, sub, pred } = await submitted()
      http.cancels.push(first)
      expect(await cancelAndConfirm(client, sub, opts)).toMatchObject({ confirmed: true, ended: 'ended' })
      expect(http.state.cancelPosts).toBe(2)
      expect(pred().status).toBe('canceled')
    }
  })

  it('never applied: unconfirmed, with the last status and error', async () => {
    const { http, client, sub } = await submitted()
    http.state.cancelDefault = 'ignore'
    http.cancels.push('http-500', 'ignore', 'ignore')
    const check = await cancelAndConfirm(client, sub, opts)
    expect(check).toEqual({ confirmed: false, lastStatus: 'IN_QUEUE', lastError: expect.stringContaining('Replicate cancel 500') })
    expect(http.state.cancelPosts).toBe(3)
  })

  it('a prediction that finished before the cancel is confirmed as finished (it is billed)', async () => {
    const { client, sub, pred } = await submitted()
    Object.assign(pred(), { status: 'succeeded', output: ['https://replicate.delivery/x.png'] })
    expect(await cancelAndConfirm(client, sub, opts)).toMatchObject({ confirmed: true, ended: 'finished' })
  })

  it('a prediction Replicate no longer knows is gone', async () => {
    const { http, client, sub } = await submitted()
    http.preds.delete(sub.requestId)
    expect(await cancelAndConfirm(client, sub, opts)).toMatchObject({ confirmed: true, ended: 'gone' })
  })
})

describe('the time limit on Replicate (the 24 Sep prediction)', () => {
  it('a Replicate that ignores the first cancel: asked again, confirmed, and only then "cancelled"', async () => {
    const k = setup()
    k.http.cancels.push('ignore')
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    const rec = run.takes[0]!.nodes['1']!
    expect(rec.status).toBe('error')
    expect(rec.error).toBe('The service took more than 5 minutes to make this image, so it was cancelled')
    expect(k.http.state.cancelPosts).toBe(2)
    expect([...k.http.preds.values()][0]!.status).toBe('canceled')
    expect(run.unconfirmedCancels).toBeUndefined()
    expect(holds(k.ledger)).toEqual([['released', null]])
  })

  it('a cancel not confirmed while the node waits: never called cancelled; kept on the run and asked about in the background until canceled', async () => {
    const k = setup()
    // The three tries while the node waits all fail in different ways; the fourth (background) works.
    k.http.cancels.push('ignore', 'http-500', 'network')
    const { runId } = await start(k)
    await k.engine.settled(runId)

    const run = (await k.store.get(runId))! as RunRecord
    const rec = run.takes[0]!.nodes['1']!
    expect(rec.status).toBe('error')
    expect(rec.error).toBe('The service took more than 5 minutes to make this image. Sailor asked the service to stop it and is checking that it has')
    expect(rec.error).not.toMatch(/cancelled/)
    // Written down, so a restart would pick it up.
    expect(run.unconfirmedCancels).toEqual([expect.objectContaining({
      provider: 'replicate', requestId: rec.request!.requestId, cancelUrl: rec.request!.cancelUrl, statusUrl: rec.request!.statusUrl,
      tries: 3, lastStatus: 'IN_QUEUE',
    })])
    expect(sites(k)).toContain('runner.cancel.unconfirmed')

    k.resume()
    await k.engine.cancelChecksSettled()
    expect(k.http.state.cancelPosts).toBe(4)
    expect([...k.http.preds.values()][0]!.status).toBe('canceled')
    expect((await k.store.get(runId))!.unconfirmedCancels).toBeUndefined()
    expect(sites(k)).not.toContain('runner.cancel.gave-up')
  })

  it('a cancel that is never confirmed is asked about for 48 hours, then given up on and reported', async () => {
    const k = setup()
    k.http.state.cancelDefault = 'ignore'
    const { runId } = await start(k)
    await k.engine.settled(runId)
    k.resume()
    await k.engine.cancelChecksSettled()
    const c = (await k.store.get(runId))!.unconfirmedCancels![0]!
    expect(c.gaveUpAt).toBeGreaterThanOrEqual(c.since + CANCEL_WATCH_GIVE_UP_MS)
    expect(c.tries).toBeGreaterThan(100)
    expect(sites(k)).toContain('runner.cancel.gave-up')
    expect([...k.http.preds.values()][0]!.status).toBe('starting')
  })

  it('a prediction that finished just as the limit hit keeps its result (it is billed), not an error', async () => {
    const k = setup()
    const { runId } = await start(k)
    // Finish it the moment the first cancel is posted.
    const real = k.http.fetch.getMockImplementation()!
    k.http.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.endsWith('/cancel')) {
        const p = [...k.http.preds.values()][0]!
        Object.assign(p, { status: 'succeeded', output: ['https://replicate.delivery/late.png'] })
      }
      return real(url, init)
    })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(rec.status).toBe('done')
    expect(rec.outputs).toHaveLength(1)
    expect(holds(k.ledger)).toEqual([['settled', expect.any(Number)]])
  })

  it('after a restart, an unconfirmed cancel written on a finished run is asked about again', async () => {
    const first = setup()
    first.http.state.cancelDefault = 'ignore'
    const { runId } = await start(first)
    await first.engine.settled(runId)
    const saved = (await first.store.get(runId))!
    expect(saved.unconfirmedCancels).toHaveLength(1)
    const pred = [...first.http.preds.values()][0]!
    // The server stops here. A new one starts on the same store, and Replicate works again.
    const second = setup({ dir: first.dir })
    second.http.preds.set(pred.id, { ...pred })
    await second.engine.reattach()
    second.resume()
    await second.engine.cancelChecksSettled()
    expect(second.http.preds.get(pred.id)!.status).toBe('canceled')
    expect((await second.store.get(runId))!.unconfirmedCancels).toBeUndefined()
    // The first server's background checks were still going; drain them too.
    first.http.state.cancelDefault = 'apply'
    first.resume()
    await first.engine.cancelChecksSettled()
  })
})

describe('Stop on Replicate', () => {
  it('a cancel not applied on Stop is asked about again in the background', async () => {
    const k = setup()
    k.http.cancels.push('ignore', 'ignore')
    const { runId } = await start(k)
    await vi.waitUntil(() => k.http.state.gets >= 2)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes['1']!.status).toBe('stopped')
    k.resume()
    await k.engine.cancelChecksSettled()
    expect([...k.http.preds.values()][0]!.status).toBe('canceled')
    expect((await k.store.get(runId))!.unconfirmedCancels).toBeUndefined()
  })
})

// ── fal: a 202 is CANCELLATION_REQUESTED, never a confirmation ─────────────
function fakeFalHttp() {
  const reqs = new Map<string, { status: 'IN_QUEUE' | 'COMPLETED'; cancelled: boolean }>()
  const cancels: ('apply' | 'ignore')[] = []
  const state = { cancelPuts: 0, seq: 0 }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const m = /^https:\/\/queue\.fal\.run\/(.+?)(?:\/requests\/([^/]+)(\/status|\/cancel)?)?(?:\?.*)?$/.exec(url)
    if (!m) throw new Error(`unexpected fetch ${url}`)
    const [, endpoint, id, tail] = m
    if (!id && init?.method === 'POST') {
      const rid = `fal${++state.seq}`
      reqs.set(rid, { status: 'IN_QUEUE', cancelled: false })
      const base = `https://queue.fal.run/${endpoint}/requests/${rid}`
      return json({ request_id: rid, status_url: `${base}/status`, response_url: base, cancel_url: `${base}/cancel`, queue_position: 3 })
    }
    const r = reqs.get(id!)
    if (!r) return json({ detail: 'not found' }, 404)
    if (tail === '/cancel' && init?.method === 'PUT') {
      state.cancelPuts++
      if (r.status === 'COMPLETED') return json({ status: 'ALREADY_COMPLETED' }, 400)
      if ((cancels.shift() ?? 'apply') === 'apply') { r.status = 'COMPLETED'; r.cancelled = true }
      return json({ status: 'CANCELLATION_REQUESTED' }, 202)
    }
    if (tail === '/status') return json({ status: r.status, queue_position: r.status === 'IN_QUEUE' ? 3 : null, ...(r.cancelled ? { error: 'Request was cancelled' } : {}) }, r.status === 'COMPLETED' ? 200 : 202)
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
  })
  return { fetch, reqs, cancels, state }
}

describe('the time limit on fal', () => {
  it('a 202 that fal does not apply is asked again; "cancelled" only once the status reads COMPLETED', async () => {
    const k = setup()
    const fal = fakeFalHttp()
    vi.stubGlobal('fetch', fal.fetch)
    fal.cancels.push('ignore')
    const { runId } = await start(k, 'fal')
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(rec.error).toBe('The service took more than 5 minutes to make this image, so it was cancelled')
    expect(fal.state.cancelPuts).toBe(2)
    expect((await k.store.get(runId))!.unconfirmedCancels).toBeUndefined()
  })

  it('a fal job that never leaves the queue is not called cancelled', async () => {
    const k = setup()
    const fal = fakeFalHttp()
    vi.stubGlobal('fetch', fal.fetch)
    fal.cancels.push('ignore', 'ignore', 'ignore')
    const { runId } = await start(k, 'fal')
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes['1']!.error).toBe('The service took more than 5 minutes to make this image. Sailor asked the service to stop it and is checking that it has')
    expect(run.unconfirmedCancels).toEqual([expect.objectContaining({ provider: 'fal', lastStatus: 'IN_QUEUE', tries: 3 })])
    k.resume()
    await k.engine.cancelChecksSettled()
    expect((await k.store.get(runId))!.unconfirmedCancels).toBeUndefined()
    expect(fal.state.cancelPuts).toBe(4)
  })
})
