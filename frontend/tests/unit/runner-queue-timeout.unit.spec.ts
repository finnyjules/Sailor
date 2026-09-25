/**
 * Task C fix (2026-09-25): a Wan 3.0 job sat ~25 minutes in fal's queue
 * (position 138 at submit) and finished at ~28 of the runner's 30-minute video
 * limit. A job the service hasn't started yet now gets a separate, longer
 * queue allowance (RUNNER_TIMEOUTS.videoQueueMs, 2 hours from the send); once
 * it starts, the 30 minutes run from the start. Pictures keep 5 minutes.
 *
 * Fake time: every status check moves the clock on by STEP.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RunnerFamily } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_TIMEOUTS, type RunnerTimeouts } from '~~/server/runner/engine'
import { createFakeFal, createFakeLedger, makeKit } from './__runner__/kit'

const MIN = 60_000
const STEP = 4 * MIN
const T0 = 1_000_000
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['wan-3'])

type Phase = 'queue' | 'run' | 'done'

const video: ApiPrompt = {
  1: { class_type: 'GenerateVideoNode', inputs: { model: 'wan-3.0', prompt: 'a red fox trots through snow', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{"resolution":"480p"}' } },
  2: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['1', 0] } },
}
const image: ApiPrompt = {
  1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
  2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
}

/**
 * A kit whose fal answers by the clock: `phase(elapsed)` says whether the job
 * is still queued (its position falling), running or done. `transient`: the
 * status URL never gives a real answer.
 */
function kitWith(phase: (elapsed: number) => Phase, o: { timeouts?: RunnerTimeouts, transient?: boolean, onCheck?: (elapsed: number) => void } = {}) {
  const clock = { now: T0 }
  const fal = createFakeFal()
  const ledger = createFakeLedger(5000)
  vi.mocked(fal.client.status).mockImplementation((async (url: string) => {
    clock.now += STEP
    const elapsed = clock.now - T0
    o.onCheck?.(elapsed)
    const r = fal.reqs.get(/^fal:\/\/(req\d+)/.exec(url)![1]!)!
    const base = { queuePosition: null, logs: [], error: null, transient: false, raw: {} }
    if (r.cancelled) return { ...base, status: 'COMPLETED', error: 'Request was cancelled' }
    if (o.transient) return { ...base, status: 'UNKNOWN', transient: true, raw: null }
    const p = phase(elapsed)
    if (p === 'queue') return { ...base, status: 'IN_QUEUE', queuePosition: Math.max(1, 200 - Math.floor(elapsed / MIN)) }
    if (p === 'run') return { ...base, status: 'IN_PROGRESS' }
    return { ...base, status: 'COMPLETED' }
  }) as never)
  const k = makeKit({
    hosted: true, fal, ledger,
    deps: { families: () => ON, now: () => clock.now, ...(o.timeouts ? { timeouts: o.timeouts } : { timeouts: RUNNER_TIMEOUTS }) },
  })
  return { k, clock }
}

async function run(k: ReturnType<typeof makeKit>, take: ApiPrompt) {
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })
  await k.engine.settled(runId)
  const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
  const holds = [...k.ledger.holds.values()]
  return { rec, holds }
}

describe('the runner\'s limits', () => {
  it('pictures 5 minutes; videos 30 minutes once started, up to 2 hours waiting to start', () => {
    expect(RUNNER_TIMEOUTS).toEqual({ imageMs: 5 * MIN, videoMs: 30 * MIN, videoQueueMs: 120 * MIN })
  })
})

describe('a video still waiting in the service\'s queue is not cancelled by the 30-minute limit', () => {
  it('Task C\'s Wan 3.0, but busier: 40 minutes in the queue, 20 to make — finished, kept and charged once', async () => {
    const { k, clock } = kitWith(e => (e < 40 * MIN ? 'queue' : e < 60 * MIN ? 'run' : 'done'))
    const { rec, holds } = await run(k, video)
    expect(rec).toMatchObject({ status: 'done', error: null })
    expect(k.fal.client.cancel).not.toHaveBeenCalled()
    expect(k.fal.client.submit).toHaveBeenCalledTimes(1)
    expect(holds.map(h => h.state)).toEqual(['settled'])
    expect(holds[0]!.actual).toBe(holds[0]!.credits)
    expect(clock.now - T0).toBeGreaterThanOrEqual(60 * MIN)
  })

  it('without the queue allowance (the old limits) the same job was cancelled at 30 minutes, uncharged', async () => {
    const { k } = kitWith(e => (e < 40 * MIN ? 'queue' : e < 60 * MIN ? 'run' : 'done'), { timeouts: { imageMs: 5 * MIN, videoMs: 30 * MIN } })
    const { rec, holds } = await run(k, video)
    expect(rec).toMatchObject({ status: 'error', error: 'The service took more than 30 minutes to make this video, so it was cancelled' })
    expect(k.fal.client.cancel).toHaveBeenCalledTimes(1)
    expect(holds.map(h => h.state)).toEqual(['released'])
  })

  it('never started after 2 hours in the queue: cancelled then, in plain words, and nothing charged', async () => {
    const { k, clock } = kitWith(() => 'queue')
    const { rec, holds } = await run(k, video)
    expect(rec).toMatchObject({ status: 'error', error: 'The service hadn’t started this video after 2 hours in its queue, so it was cancelled' })
    expect(k.fal.client.cancel).toHaveBeenCalledTimes(1)
    expect(holds.map(h => h.state)).toEqual(['released'])
    // Cancelled at the allowance (a check or two past it), not before and not long after.
    expect(clock.now - T0).toBeGreaterThan(120 * MIN)
    expect(clock.now - T0).toBeLessThanOrEqual(120 * MIN + 3 * STEP)
  })

  it('started after 100 minutes in the queue: the 30 minutes run from the start, so it is cancelled at ~130, not at 120', async () => {
    const cancelAt: number[] = []
    const { k, clock } = kitWith(e => (e < 100 * MIN ? 'queue' : 'run'))
    vi.mocked(k.fal.client.cancel).mockImplementation((async (url: string) => {
      cancelAt.push(clock.now - T0)
      k.fal.reqs.get(/^fal:\/\/(req\d+)/.exec(url)![1]!)!.cancelled = true
      return 'cancelled'
    }) as never)
    const { rec, holds } = await run(k, video)
    expect(rec).toMatchObject({ status: 'error', error: 'The service took more than 30 minutes to make this video, so it was cancelled' })
    expect(cancelAt).toHaveLength(1)
    expect(cancelAt[0]).toBeGreaterThan(130 * MIN)
    expect(cancelAt[0]).toBeLessThanOrEqual(130 * MIN + 2 * STEP)
    expect(holds.map(h => h.state)).toEqual(['released'])
  })

  it('started straight away and never finishing: cancelled 30 minutes after the start, not after the queue allowance', async () => {
    const cancelAt: number[] = []
    const { k, clock } = kitWith(e => (e < STEP + 1 ? 'queue' : 'run'))
    vi.mocked(k.fal.client.cancel).mockImplementation((async (url: string) => {
      cancelAt.push(clock.now - T0)
      k.fal.reqs.get(/^fal:\/\/(req\d+)/.exec(url)![1]!)!.cancelled = true
      return 'cancelled'
    }) as never)
    const { rec } = await run(k, video)
    expect(rec).toMatchObject({ status: 'error', error: 'The service took more than 30 minutes to make this video, so it was cancelled' })
    expect(cancelAt[0]).toBeGreaterThan(30 * MIN)
    expect(cancelAt[0]).toBeLessThanOrEqual(40 * MIN)
  })

  it('a service that never gives a real answer: the queue allowance never applies (cancelled at 30 minutes + the grace)', async () => {
    const cancelAt: number[] = []
    const { k, clock } = kitWith(() => 'queue', { transient: true })
    vi.mocked(k.fal.client.cancel).mockImplementation((async (url: string) => {
      cancelAt.push(clock.now - T0)
      k.fal.reqs.get(/^fal:\/\/(req\d+)/.exec(url)![1]!)!.cancelled = true
      return 'cancelled'
    }) as never)
    const { rec, holds } = await run(k, video)
    expect(rec).toMatchObject({ status: 'error' })
    expect(rec.error).toMatch(/^The provider did not answer/)
    expect(cancelAt[0]).toBeGreaterThan(35 * MIN)
    expect(cancelAt[0]).toBeLessThanOrEqual(35 * MIN + 2 * STEP)
    expect(holds.map(h => h.state)).toEqual(['released'])
  })

  it('Stop while it waits in the queue past 30 minutes: stopped at once, the job cancelled, nothing charged', async () => {
    let k!: ReturnType<typeof makeKit>
    let stopped = false
    const made = kitWith(() => 'queue', {
      onCheck: (e) => {
        if (!stopped && e >= 44 * MIN) { stopped = true; void k.engine.stop(k.userId) }
      },
    })
    k = made.k
    const { rec, holds } = await run(k, video)
    expect(stopped).toBe(true)
    expect(rec).toMatchObject({ status: 'stopped', error: null })
    expect(k.fal.client.cancel).toHaveBeenCalled()
    expect(holds.map(h => h.state)).toEqual(['released'])
    expect(made.clock.now - T0).toBeLessThan(60 * MIN)
  })

  it('pictures get no queue allowance: a picture still queued is cancelled at 5 minutes', async () => {
    const { k, clock } = kitWith(() => 'queue')
    const { rec } = await run(k, image)
    expect(rec).toMatchObject({ status: 'error', error: 'The service took more than 5 minutes to make this image, so it was cancelled' })
    expect(clock.now - T0).toBeLessThanOrEqual(5 * MIN + 3 * STEP)
  })
})
