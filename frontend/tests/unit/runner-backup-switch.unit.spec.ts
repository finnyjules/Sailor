/**
 * The backup service (model line-up Task S2): a job that never started at its
 * first service is moved to the backup, once, and charged once. Fake services
 * on a fake clock: nothing here reaches fal or Replicate. S3 fills in real
 * backups; here a node whose inputs carry `test_plan` gets one of the plans
 * below (each request checked against its service's saved schema).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeLedger, makeKit, ofType, until } from './__runner__/kit'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { FalError, falOutputUrls, type ProviderClient } from '~~/server/runner/falQueue'
import { ReplicateError, replicateOutputUrls } from '~~/server/runner/replicateQueue'
import { DEFAULT_BACKUP_STALL_MS, runnerBackup } from '~~/server/runner/config'
import { isSubmitOutage } from '~~/server/runner/engine'
import { requestFingerprint } from '~~/server/runner/fingerprint'
import { toGenerationRecord } from '~~/server/runner/records'
import { userKeyOf } from '~~/server/runner/store'
import type { EngineDeps } from '~~/server/runner/engine'
import type { RunnerProvider } from '~~/server/runner/types'
import type { ApiPrompt } from '#shared/runner/graph'

type Req = { provider: RunnerProvider; endpoint: string; payload: Record<string, unknown> }
const PLANS = vi.hoisted(() => {
  const nb2Replicate = { provider: 'replicate' as const, endpoint: 'google/nano-banana-2', payload: { prompt: 'a red fox', aspect_ratio: '1:1', resolution: '1K', output_format: 'png' } }
  const nb2Fal = { provider: 'fal' as const, endpoint: 'fal-ai/nano-banana-2', payload: { prompt: 'a red fox', aspect_ratio: '1:1', resolution: '1K', output_format: 'png', num_images: 1 } }
  const fluxProReplicate = { provider: 'replicate' as const, endpoint: 'black-forest-labs/flux-pro', payload: { prompt: 'a red fox', seed: 7, aspect_ratio: '1:1', output_format: 'png' } }
  const fluxProFal = { provider: 'fal' as const, endpoint: 'fal-ai/flux-pro/v1.1', payload: { prompt: 'a red fox', seed: 7, output_format: 'png', num_images: 1 } }
  return {
    /** Nano Banana 2 on Replicate first, fal as its backup (the 24 Sep outage). */
    nb2: { first: nb2Replicate, backup: nb2Fal },
    /** The other way round: fal first, Replicate as the backup. */
    nb2FalFirst: { first: nb2Fal, backup: nb2Replicate },
    /** Seeded, so its result is filed for reuse. */
    fluxPro: { first: fluxProReplicate, backup: fluxProFal },
  } satisfies Record<string, { first: Req; backup: Req }>
})

vi.mock('~~/server/runner/executors', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/executors')>()
  return {
    ...real,
    planNode: async (ctx: Parameters<typeof real.planNode>[0]) => {
      const plan = await real.planNode(ctx)
      const key = ctx.prompt[ctx.nodeId]!.inputs.test_plan
      if (plan.kind !== 'provider' || typeof key !== 'string') return plan
      const p = PLANS[key as keyof typeof PLANS]
      return {
        ...plan, provider: p.first.provider, endpoint: p.first.endpoint, payload: { ...p.first.payload },
        backup: { provider: p.backup.provider, endpoint: p.backup.endpoint, payload: { ...p.backup.payload } },
      }
    },
  }
})

// ── A fake service on a fake clock ─────────────────────────────────────────
interface JobScript {
  /** ms after the send when the job starts (Infinity: never). */
  startsAt?: number
  /** ms it runs for once started. */
  runsFor?: number
  /** Replicate: finishes with a platform hiccup (worth sending again). */
  hiccup?: boolean
}
interface Job {
  id: string; endpoint: string; payload: Record<string, unknown>; submittedAt: number
  startsAt: number; runsFor: number; hiccup: boolean; cancelled: boolean; finishedEarly: boolean; polls: number
}
type CancelOutcome = 'cancelled' | 'already-done' | 'not-found' | 'throw' | 'throw-started'

function fakeService(name: RunnerProvider, clock: { t: number }) {
  const jobs: Job[] = []
  const script = { jobs: [] as JobScript[], cancel: 'cancelled' as CancelOutcome, submitErrors: [] as unknown[], hangSubmits: 0 }
  const byUrl = (url: string) => jobs.find(j => url.startsWith(`${name}://${j.id}`))!
  const client: ProviderClient = {
    submit: vi.fn(async (endpoint: string, payload: Record<string, unknown>) => {
      if (script.submitErrors.length) throw script.submitErrors.shift()
      if (script.hangSubmits > 0) { script.hangSubmits--; return new Promise(() => {}) }
      const s = script.jobs.shift() ?? {}
      const id = `${name}${jobs.length + 1}`
      jobs.push({ id, endpoint, payload, submittedAt: clock.t, startsAt: s.startsAt ?? 0, runsFor: s.runsFor ?? 5_000, hiccup: !!s.hiccup, cancelled: false, finishedEarly: false, polls: 0 })
      return { requestId: id, statusUrl: `${name}://${id}/status`, responseUrl: `${name}://${id}`, cancelUrl: `${name}://${id}/cancel`, queuePosition: null }
    }) as any,
    status: vi.fn(async (url: string) => {
      const j = byUrl(url)
      j.polls++
      const base = { queuePosition: null, logs: [], error: null, transient: false, retryable: false, raw: null }
      if (j.cancelled) return { ...base, status: 'COMPLETED', error: 'The request was cancelled' }
      const el = clock.t - j.submittedAt
      if (!j.finishedEarly && el < j.startsAt) return { ...base, status: 'IN_QUEUE' }
      if (!j.finishedEarly && el < j.startsAt + j.runsFor) return { ...base, status: 'IN_PROGRESS' }
      if (j.hiccup) return { ...base, status: 'COMPLETED', error: 'Replicate: Prediction interrupted; please retry (code: PA)', retryable: true }
      return { ...base, status: 'COMPLETED', raw: name === 'replicate' ? { id: j.id, status: 'succeeded', output: [`https://replicate.delivery/${j.id}.png`] } : null }
    }) as any,
    result: vi.fn(async (url: string) => ({ images: [{ url: `https://fal.media/${byUrl(url).id}.png` }] })) as any,
    cancel: vi.fn(async (url: string) => {
      const j = byUrl(url)
      const o = script.cancel
      if (o === 'throw') throw new Error('cancel failed')
      if (o === 'throw-started') { j.startsAt = 0; throw new Error('cancel failed') }
      if (o === 'already-done') { j.finishedEarly = true; return 'already-done' }
      if (o === 'not-found') return 'not-found'
      j.cancelled = true
      return 'cancelled'
    }) as any,
    outputUrls: vi.fn(name === 'fal' ? falOutputUrls : replicateOutputUrls),
  }
  return { client, jobs, script }
}

const START = 1_000_000
const POLL_MS = 5_000

function setup(o: {
  hosted?: boolean; backup?: EngineDeps['backup'] | null; clock?: { t: number }
  fal?: ReturnType<typeof fakeService>; replicate?: ReturnType<typeof fakeService>
  ledger?: ReturnType<typeof createFakeLedger>; dir?: string; root?: string
  /** The engine's waits hang (until Stop) once this is true: a crash, or a pause for the test. */
  hangWhen?: () => boolean
} = {}) {
  const clock = o.clock ?? { t: START }
  const fal = o.fal ?? fakeService('fal', clock)
  const replicate = o.replicate ?? fakeService('replicate', clock)
  const k = makeKit({
    hosted: o.hosted ?? true, ledger: o.ledger, dir: o.dir, root: o.root,
    deps: {
      providers: { fal: fal.client, replicate: replicate.client },
      now: () => clock.t,
      // Each wait moves the fake clock on; nothing waits for real.
      sleep: (ms, signal) => new Promise<void>((resolve) => {
        if (o.hangWhen?.()) { signal.addEventListener('abort', () => resolve(), { once: true }); return }
        clock.t += ms
        setTimeout(resolve, 0)
      }),
      pollDelayMs: () => POLL_MS,
      ...(o.backup === null ? {} : { backup: o.backup ?? (() => ({ enabled: true, stallMs: DEFAULT_BACKUP_STALL_MS })) }),
    },
  })
  return { ...k, clock, falSvc: fal, repSvc: replicate }
}

const flow = (plan: keyof typeof PLANS): ApiPrompt => ({
  '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', test_plan: plan } },
  '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})
const start = (k: ReturnType<typeof setup>, plan: keyof typeof PLANS = 'nb2') =>
  k.engine.startRun({ userId: k.userId, takes: [flow(plan)], workflow: null, canvasId: null, projectUuid: null, projectName: null })
const holds = (ledger: ReturnType<typeof createFakeLedger>) => [...ledger.holds.values()].map(h => [h.state, h.actual])
const node = async (k: ReturnType<typeof setup>, runId: string) => (await k.store.get(runId))!.takes[0]!.nodes['1']!
const switches = (k: ReturnType<typeof setup>) => ofType(k.seen, 'provider-switch')
const NEVER = Number.POSITIVE_INFINITY

afterEach(() => {
  delete process.env.NUXT_RUNNER_BACKUP
  delete process.env.NUXT_RUNNER_BACKUP_STALL_MS
})

describe('the test plans', () => {
  it('every first and backup request passes its own service’s saved schema', () => {
    for (const p of Object.values(PLANS)) {
      for (const r of [p.first, p.backup]) {
        expect(checkPayload(loadProviderSchema(r.provider, r.endpoint), r.payload), `${r.provider} ${r.endpoint}`).toEqual([])
      }
    }
  })
})

describe('a job that has not started is moved to the backup', () => {
  it('switches after the stall: cancelled first, then sent to the backup, charged once', async () => {
    const k = setup()
    k.repSvc.script.jobs.push({ startsAt: NEVER })
    let switchedAt = -1
    k.deps.events.subscribe(userKeyOf(k.userId), (m) => { if (m.type === 'provider-switch') switchedAt = k.clock.t })
    const { runId } = await start(k)
    await k.engine.settled(runId)

    const rec = await node(k, runId)
    expect(rec.status).toBe('done')
    expect(k.repSvc.jobs).toHaveLength(1)
    expect(k.repSvc.client.cancel).toHaveBeenCalledTimes(1)
    expect(k.repSvc.client.cancel).toHaveBeenCalledWith('replicate://replicate1/cancel')
    // The cancel was confirmed before the backup went out.
    expect((k.repSvc.client.cancel as any).mock.invocationCallOrder[0]).toBeLessThan((k.falSvc.client.submit as any).mock.invocationCallOrder[0])
    expect(k.falSvc.jobs.map(j => [j.endpoint, j.payload])).toEqual([[PLANS.nb2.backup.endpoint, PLANS.nb2.backup.payload]])
    // Moved at the first look on or after 120 s from the send.
    const sentAt = k.repSvc.jobs[0]!.submittedAt
    expect(switchedAt - sentAt).toBeGreaterThanOrEqual(120_000)
    expect(switchedAt - sentAt).toBeLessThan(120_000 + POLL_MS)
    expect(rec.switchedFrom).toEqual({ provider: 'replicate', requestId: 'replicate1' })
    expect(rec.request).toMatchObject({ provider: 'fal', requestId: 'fal1' })
    expect(rec.endpoint).toBe(PLANS.nb2.backup.endpoint)
    expect(rec.payload).toEqual(PLANS.nb2.backup.payload)
    expect(rec.servedBy).toBe('fal')
    expect(rec.outputs).toHaveLength(1)
    expect(switches(k).map(m => m.data)).toEqual([expect.objectContaining({ node: '1', from: 'replicate', to: 'fal', message: 'Slow to start on Replicate, trying fal.' })])
    // flux-schnell's 2 credits + the render credit, held and settled once.
    expect(k.ledger.hold).toHaveBeenCalledTimes(1)
    expect(holds(k.ledger)).toEqual([['settled', 3]])
    // The run record says which service made it.
    expect(k.records.write).toHaveBeenCalledTimes(1)
    const summary = (k.records.write as any).mock.calls[0][0]
    expect(summary.servedBy).toEqual({ 1: 'fal' })
    expect(toGenerationRecord(summary, true).servedBy).toEqual({ 1: 'fal' })
  })

  it('does not switch a job that starts at 119 s', async () => {
    const k = setup()
    k.repSvc.script.jobs.push({ startsAt: 119_000, runsFor: 10_000 })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const rec = await node(k, runId)
    expect(rec.status).toBe('done')
    expect(k.repSvc.client.cancel).not.toHaveBeenCalled()
    expect(k.falSvc.client.submit).not.toHaveBeenCalled()
    expect(rec.switchedFrom).toBeUndefined()
    expect(rec.servedBy).toBe('replicate')
    expect(switches(k)).toEqual([])
    expect(holds(k.ledger)).toEqual([['settled', 3]])
  })

  it('keeps the first result when the cancel finds it already done', async () => {
    const k = setup()
    k.repSvc.script.jobs.push({ startsAt: NEVER })
    k.repSvc.script.cancel = 'already-done'
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const rec = await node(k, runId)
    expect(rec.status).toBe('done')
    expect(k.repSvc.client.cancel).toHaveBeenCalledTimes(1)
    expect(k.falSvc.client.submit).not.toHaveBeenCalled()
    expect(rec.request).toMatchObject({ provider: 'replicate', requestId: 'replicate1' })
    expect(rec.servedBy).toBe('replicate')
    expect(k.repSvc.client.outputUrls).toHaveBeenCalledWith(expect.objectContaining({ output: ['https://replicate.delivery/replicate1.png'] }), 'image')
    expect(switches(k)).toEqual([])
    expect(holds(k.ledger)).toEqual([['settled', 3]])
  })

  it('a cancel that fails switches only when one more look still finds the job waiting', async () => {
    const waiting = setup()
    waiting.repSvc.script.jobs.push({ startsAt: NEVER })
    waiting.repSvc.script.cancel = 'throw'
    const a = await start(waiting)
    await waiting.engine.settled(a.runId)
    expect((await node(waiting, a.runId)).servedBy).toBe('fal')
    expect(waiting.falSvc.jobs).toHaveLength(1)

    const started = setup()
    started.repSvc.script.jobs.push({ startsAt: NEVER, runsFor: 10_000 })
    started.repSvc.script.cancel = 'throw-started'
    const b = await start(started)
    await started.engine.settled(b.runId)
    const rec = await node(started, b.runId)
    expect(rec.status).toBe('done')
    expect(rec.servedBy).toBe('replicate')
    expect(started.falSvc.client.submit).not.toHaveBeenCalled()
    expect(started.repSvc.client.cancel).toHaveBeenCalledTimes(1) // no second try
  })

  it('a send that fails with no job created goes straight to the backup', async () => {
    for (const err of [new ReplicateError('Replicate predictions API HTTP 503: down', 503), new ReplicateError('rate-limited', 429), new TypeError('fetch failed')]) {
      const k = setup()
      k.repSvc.script.submitErrors.push(err)
      const { runId } = await start(k)
      await k.engine.settled(runId)
      const rec = await node(k, runId)
      expect(rec.status).toBe('done')
      expect(rec.switchedFrom).toEqual({ provider: 'replicate', requestId: null })
      expect(rec.servedBy).toBe('fal')
      expect(k.falSvc.jobs.map(j => j.payload)).toEqual([PLANS.nb2.backup.payload])
      expect(switches(k).map(m => m.data.message)).toEqual(['Couldn’t reach Replicate, trying fal.'])
      expect(holds(k.ledger)).toEqual([['settled', 3]])
    }
  })

  it('a refused send (a 4xx) is not switched', async () => {
    const k = setup()
    k.repSvc.script.submitErrors.push(new ReplicateError('Replicate predictions API HTTP 422: bad input', 422))
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const rec = await node(k, runId)
    expect(rec.status).toBe('error')
    expect(k.falSvc.client.submit).not.toHaveBeenCalled()
    expect(holds(k.ledger)).toEqual([['released', null]])
  })

  it('switches at most once: a backup that stalls too runs out the normal time limit', async () => {
    const k = setup()
    k.repSvc.script.jobs.push({ startsAt: NEVER })
    k.falSvc.script.jobs.push({ startsAt: NEVER })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const rec = await node(k, runId)
    expect(rec.status).toBe('error')
    expect(rec.error).toBe('The image took longer than 5 minutes, so it was cancelled')
    expect(k.repSvc.client.submit).toHaveBeenCalledTimes(1)
    expect(k.falSvc.client.submit).toHaveBeenCalledTimes(1)
    expect(k.falSvc.client.cancel).toHaveBeenCalledWith('fal://fal1/cancel')
    // The backup's own time limit, from its own send.
    expect(k.clock.t - k.falSvc.jobs[0]!.submittedAt).toBeGreaterThan(300_000)
    expect(switches(k)).toHaveLength(1)
    expect(holds(k.ledger)).toEqual([['released', null]])
  })

  it('charges exactly the same with and without a switch', async () => {
    const plain = setup()
    const a = await start(plain)
    await plain.engine.settled(a.runId)

    const switched = setup()
    switched.repSvc.script.jobs.push({ startsAt: NEVER })
    const b = await start(switched)
    await switched.engine.settled(b.runId)
    expect((await node(switched, b.runId)).servedBy).toBe('fal')

    expect(holds(switched.ledger)).toEqual(holds(plain.ledger))
    expect(switched.ledger.hold.mock.calls.map(c => c[1])).toEqual(plain.ledger.hold.mock.calls.map(c => c[1]))
    const [ra, rb] = [(await plain.store.get(a.runId))!, (await switched.store.get(b.runId))!]
    expect(rb.charges.map(c => [c.estimate, c.actual])).toEqual(ra.charges.map(c => [c.estimate, c.actual]))
    expect(rb.takes[0]!.nodes['1']!.credits).toBe(ra.takes[0]!.nodes['1']!.credits)
  })

  it('files the backup’s result under both services’ requests, so the same settings reuse it', async () => {
    const k = setup({ hosted: false })
    k.repSvc.script.jobs.push({ startsAt: NEVER })
    const first = await start(k, 'fluxPro')
    await k.engine.settled(first.runId)
    const made = await node(k, first.runId)
    expect(made.servedBy).toBe('fal')
    const none = () => undefined
    const firstFp = requestFingerprint(`replicate:${PLANS.fluxPro.first.endpoint}`, PLANS.fluxPro.first.payload, none)
    const backupFp = requestFingerprint(PLANS.fluxPro.backup.endpoint, PLANS.fluxPro.backup.payload, none)
    expect(made.fingerprint).toBe(firstFp)
    expect(await k.store.getResult(userKeyOf(null), firstFp)).toEqual(made.outputs)
    expect(await k.store.getResult(userKeyOf(null), backupFp)).toEqual(made.outputs)

    const again = await start(k, 'fluxPro')
    await k.engine.settled(again.runId)
    const rec = await node(k, again.runId)
    expect(rec.reused).toBe(true)
    expect(rec.outputs).toEqual(made.outputs)
    expect(k.repSvc.client.submit).toHaveBeenCalledTimes(1)
    expect(k.falSvc.client.submit).toHaveBeenCalledTimes(1)
  })
})

describe('restart and Stop mid-switch', () => {
  it('a restart inside the stall window switches 120 s after the original send, not after the restart', async () => {
    const clock = { t: START }
    const fal = fakeService('fal', clock)
    const replicate = fakeService('replicate', clock)
    const ledger = createFakeLedger()
    replicate.script.jobs.push({ startsAt: NEVER })
    // The first server "dies" 60 s in: its waits never return.
    const k1 = setup({ clock, fal, replicate, ledger, hangWhen: () => clock.t - START >= 60_000 })
    const { runId } = await start(k1)
    await until(() => clock.t - START >= 60_000 && (replicate.client.status as any).mock.calls.length >= 13)
    await new Promise(r => setTimeout(r, 10))
    expect(fal.client.submit).not.toHaveBeenCalled()

    // Later: the second server picks the run up from the store.
    clock.t = START + 90_000
    const k2 = setup({ clock, fal, replicate, ledger, dir: k1.dir, root: k1.root })
    let switchedAt = -1
    k2.deps.events.subscribe(userKeyOf(k2.userId), (m) => { if (m.type === 'provider-switch') switchedAt = clock.t })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    expect(switchedAt - START).toBeGreaterThanOrEqual(120_000)
    expect(switchedAt - START).toBeLessThan(120_000 + POLL_MS)
    expect(replicate.client.submit).toHaveBeenCalledTimes(1)
    expect(fal.client.submit).toHaveBeenCalledTimes(1)
    const rec = await node(k2, runId)
    expect(rec.status).toBe('done')
    expect(rec.servedBy).toBe('fal')
    expect(holds(ledger)).toEqual([['settled', 3]])
  })

  it('a restart after the switch is written down but before the backup answered sends the backup, not the first service', async () => {
    const clock = { t: START }
    const fal = fakeService('fal', clock)
    const replicate = fakeService('replicate', clock)
    const ledger = createFakeLedger()
    replicate.script.jobs.push({ startsAt: NEVER })
    fal.script.hangSubmits = 1 // the first server dies while sending to the backup
    const k1 = setup({ clock, fal, replicate, ledger })
    const { runId } = await start(k1)
    await until(() => (fal.client.submit as any).mock.calls.length === 1)
    await new Promise(r => setTimeout(r, 10))
    const saved = (await k1.store.get(runId))!.takes[0]!.nodes['1']!
    expect(saved.switchedFrom).toEqual({ provider: 'replicate', requestId: 'replicate1' })
    expect(saved.request).toBeNull()

    const k2 = setup({ clock, fal, replicate, ledger, dir: k1.dir, root: k1.root })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    expect(replicate.client.submit).toHaveBeenCalledTimes(1)
    expect(fal.client.submit).toHaveBeenCalledTimes(2)
    const rec = await node(k2, runId)
    expect(rec.status).toBe('done')
    expect(rec.request).toMatchObject({ provider: 'fal' })
    expect(rec.servedBy).toBe('fal')
    expect(holds(ledger)).toEqual([['settled', 3]])
  })

  it('a restart after the switch keeps waiting on the backup', async () => {
    const clock = { t: START }
    const fal = fakeService('fal', clock)
    const replicate = fakeService('replicate', clock)
    const ledger = createFakeLedger()
    replicate.script.jobs.push({ startsAt: NEVER })
    fal.script.jobs.push({ startsAt: 0, runsFor: 60_000 })
    const k1 = setup({ clock, fal, replicate, ledger, hangWhen: () => fal.jobs.length > 0 && fal.jobs[0]!.polls >= 2 })
    const { runId } = await start(k1)
    await until(() => fal.jobs.length > 0 && fal.jobs[0]!.polls >= 2)
    await new Promise(r => setTimeout(r, 10))

    const k2 = setup({ clock, fal, replicate, ledger, dir: k1.dir, root: k1.root })
    expect(await k2.engine.reattach()).toBe(1)
    // A tab that connects now still sees the node's note.
    expect(k2.engine.snapshot(k2.userId).filter(m => m.type === 'provider-switch').map(m => m.data.message)).toEqual(['Slow to start on Replicate, trying fal.'])
    await k2.engine.settled(runId)
    expect(replicate.client.status).toHaveBeenCalled()
    expect(fal.client.submit).toHaveBeenCalledTimes(1)
    expect(replicate.client.submit).toHaveBeenCalledTimes(1)
    const rec = await node(k2, runId)
    expect(rec.status).toBe('done')
    expect(rec.servedBy).toBe('fal')
    expect(holds(ledger)).toEqual([['settled', 3]])
  })

  it('Stop after a switch cancels the backup', async () => {
    const clock = { t: START }
    const fal = fakeService('fal', clock)
    fal.script.jobs.push({ startsAt: 0, runsFor: NEVER })
    const k = setup({ clock, fal, hangWhen: () => fal.jobs.length > 0 && fal.jobs[0]!.polls >= 2 })
    k.repSvc.script.jobs.push({ startsAt: NEVER })
    const { runId } = await start(k)
    await until(() => fal.jobs.length > 0 && fal.jobs[0]!.polls >= 2)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    expect(fal.client.cancel).toHaveBeenCalledWith('fal://fal1/cancel')
    expect(k.repSvc.client.cancel).toHaveBeenCalledTimes(1) // only the switch's own cancel
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('stopped')
    expect(run.takes[0]!.nodes['1']!.status).toBe('stopped')
    expect(holds(k.ledger)).toEqual([['released', null]])
  })
})

describe('the switch can be turned off', () => {
  it('settings: 120 s by default, NUXT_RUNNER_BACKUP_STALL_MS sets it, NUXT_RUNNER_BACKUP=off turns it off', () => {
    expect(runnerBackup()).toEqual({ enabled: true, stallMs: 120_000 })
    process.env.NUXT_RUNNER_BACKUP_STALL_MS = '45000'
    expect(runnerBackup()).toEqual({ enabled: true, stallMs: 45_000 })
    process.env.NUXT_RUNNER_BACKUP_STALL_MS = '0'
    expect(runnerBackup().stallMs).toBe(0)
    process.env.NUXT_RUNNER_BACKUP_STALL_MS = 'soon'
    expect(runnerBackup().stallMs).toBe(120_000)
    process.env.NUXT_RUNNER_BACKUP = 'off'
    expect(runnerBackup().enabled).toBe(false)
  })

  it('NUXT_RUNNER_BACKUP=off never switches, for a slow start or a failed send', async () => {
    process.env.NUXT_RUNNER_BACKUP = 'off'
    const slow = setup({ backup: runnerBackup })
    slow.repSvc.script.jobs.push({ startsAt: NEVER })
    const a = await start(slow)
    await slow.engine.settled(a.runId)
    expect((await node(slow, a.runId)).error).toBe('The image took longer than 5 minutes, so it was cancelled')
    expect(slow.falSvc.client.submit).not.toHaveBeenCalled()
    expect(switches(slow)).toEqual([])

    const down = setup({ backup: runnerBackup })
    down.repSvc.script.submitErrors.push(new ReplicateError('Replicate predictions API HTTP 503: down', 503))
    const b = await start(down)
    await down.engine.settled(b.runId)
    expect((await node(down, b.runId)).status).toBe('error')
    expect(down.falSvc.client.submit).not.toHaveBeenCalled()
  })

  it('a stall time of 0 never switches a slow start', async () => {
    process.env.NUXT_RUNNER_BACKUP_STALL_MS = '0'
    const k = setup({ backup: runnerBackup })
    k.repSvc.script.jobs.push({ startsAt: NEVER })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    expect((await node(k, runId)).status).toBe('error')
    expect(k.falSvc.client.submit).not.toHaveBeenCalled()
  })

  it('an engine with no backup setting never switches', async () => {
    const k = setup({ backup: null })
    k.repSvc.script.jobs.push({ startsAt: NEVER })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    expect((await node(k, runId)).status).toBe('error')
    expect(k.falSvc.client.submit).not.toHaveBeenCalled()
  })
})

describe('the Replicate hiccup re-run still works beside the switch', () => {
  it('a re-run is not a switch', async () => {
    const k = setup()
    k.repSvc.script.jobs.push({ hiccup: true })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const rec = await node(k, runId)
    expect(rec.status).toBe('done')
    expect(k.repSvc.jobs.map(j => j.payload)).toEqual([PLANS.nb2.first.payload, PLANS.nb2.first.payload])
    expect(k.falSvc.client.submit).not.toHaveBeenCalled()
    expect(rec.request).toMatchObject({ provider: 'replicate', requestId: 'replicate2', retries: 1 })
    expect(rec.switchedFrom).toBeUndefined()
    expect(rec.servedBy).toBe('replicate')
    expect(switches(k)).toEqual([])
    expect(holds(k.ledger)).toEqual([['settled', 3]])
  })

  it('a hiccup on a Replicate backup re-runs the backup’s own request', async () => {
    const k = setup()
    k.falSvc.script.jobs.push({ startsAt: NEVER })
    k.repSvc.script.jobs.push({ hiccup: true })
    const { runId } = await start(k, 'nb2FalFirst')
    await k.engine.settled(runId)
    const rec = await node(k, runId)
    expect(rec.status).toBe('done')
    expect(k.falSvc.jobs).toHaveLength(1)
    expect(k.repSvc.jobs.map(j => [j.endpoint, j.payload])).toEqual([
      [PLANS.nb2FalFirst.backup.endpoint, PLANS.nb2FalFirst.backup.payload],
      [PLANS.nb2FalFirst.backup.endpoint, PLANS.nb2FalFirst.backup.payload],
    ])
    expect(rec.switchedFrom).toEqual({ provider: 'fal', requestId: 'fal1' })
    expect(rec.request).toMatchObject({ provider: 'replicate', retries: 1 })
    expect(rec.servedBy).toBe('replicate')
    expect(switches(k).map(m => m.data.message)).toEqual(['Slow to start on fal, trying Replicate.'])
    expect(holds(k.ledger)).toEqual([['settled', 3]])
  })
})

describe('what counts as a failed send', () => {
  it('no answer, a 5xx or a 429 on submit; never a 4xx refusal or a plain error', () => {
    expect(isSubmitOutage(new TypeError('fetch failed'))).toBe(true)
    expect(isSubmitOutage(new FalError('fal submit 502: bad gateway', 502))).toBe(true)
    expect(isSubmitOutage(new ReplicateError('rate-limited', 429))).toBe(true)
    expect(isSubmitOutage(new FalError('fal submit 422: invalid', 422))).toBe(false)
    expect(isSubmitOutage(new FalError('fal submit returned no request id', null))).toBe(false)
    expect(isSubmitOutage(new Error('Replicate is not set up (add NUXT_REPLICATE_TOKEN)'))).toBe(false)
  })
})
