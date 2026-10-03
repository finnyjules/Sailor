/**
 * Step 3, LC10: runFal's Stop (FalRunOptions.signal), used by Frame Animate.
 * Before the submit nothing is sent; while the job runs, fal is asked to
 * cancel and the hold is released (an unconfirmed cancel is Sailor's to
 * absorb); without a signal nothing changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const q = vi.hoisted(() => ({ submits: 0, statuses: 0, cancels: [] as string[], status: 'IN_PROGRESS' }))
vi.mock('../../server/runner/falQueue', () => ({
  falSubmit: async () => { q.submits++; return { requestId: 'r1', statusUrl: 'https://queue.fal.run/x/requests/r1/status', responseUrl: 'https://queue.fal.run/x/requests/r1', cancelUrl: 'https://queue.fal.run/x/requests/r1/cancel', queuePosition: null } },
  falStatus: async () => { q.statuses++; return { status: q.status, queuePosition: null, logs: [], error: null, transient: false } },
  falResult: async () => ({ video: { url: 'https://fal.media/v.mp4' } }),
  falCancel: async (url: string) => { q.cancels.push(url); return 'requested' },
}))
const meter = vi.hoisted(() => ({ released: 0, settled: 0 }))
vi.mock('../../server/utils/requestMeter', () => ({
  preflightMeter: async () => ({ holdId: 1, credits: 10, settle: async () => { meter.settled++ }, release: async () => { meter.released++ } }),
  currentMeterContext: () => null,
}))
vi.mock('../../server/utils/moderation', () => ({ moderatePrompt: async () => ({ ok: true }), moderationRefusal: () => new Error('no') }))
vi.mock('../../server/utils/spendLog', () => ({ logSpend: () => {} }))
vi.mock('../../server/utils/providerUsage', () => ({ recordProviderUsage: async () => {} }))

import { FAL_RUN_STOPPED, runFal } from '../../server/utils/falRun'

beforeEach(() => { q.submits = 0; q.statuses = 0; q.cancels.length = 0; q.status = 'IN_PROGRESS'; meter.released = 0; meter.settled = 0 })

describe('runFal Stop', () => {
  it('stopped before the submit: nothing is sent, the hold is released', async () => {
    const ac = new AbortController(); ac.abort()
    await expect(runFal('x', { prompt: 'p' }, { signal: ac.signal, pollIntervalMs: 5 })).rejects.toThrow(FAL_RUN_STOPPED)
    expect(q.submits).toBe(0)
    expect(meter.released).toBe(1)
    expect(meter.settled).toBe(0)
  })

  it('stopped while the job runs: fal is asked to cancel at once, the hold is released', async () => {
    const ac = new AbortController()
    const run = runFal('x', { prompt: 'p' }, { signal: ac.signal, pollIntervalMs: 60_000 })
    await new Promise(r => setTimeout(r, 5))
    const t0 = Date.now()
    ac.abort()
    await expect(run).rejects.toThrow(FAL_RUN_STOPPED)
    expect(Date.now() - t0).toBeLessThan(1000) // the poll wait wakes on Stop
    expect(q.submits).toBe(1)
    expect(q.cancels).toEqual(['https://queue.fal.run/x/requests/r1/cancel'])
    expect(meter.released).toBe(1)
    expect(meter.settled).toBe(0)
  })

  it('no signal: completes and settles as before', async () => {
    q.status = 'COMPLETED'
    await expect(runFal('x', { prompt: 'p' }, { pollIntervalMs: 1 })).resolves.toEqual({ video: { url: 'https://fal.media/v.mp4' } })
    expect(meter.settled).toBe(1)
    expect(q.cancels).toEqual([])
  })
})
