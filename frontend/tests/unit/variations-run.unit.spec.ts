import { describe, it, expect, vi } from 'vitest'
import { runVariationsLoop } from '~/lib/canvas/variationsRun'

const sleep = async () => {}

describe('runVariationsLoop', () => {
  it('queues count runs, pausing between them', async () => {
    const runOne = vi.fn(async () => true)
    const pause = vi.fn(sleep)
    expect(await runVariationsLoop({ count: 3, runOne, cancelled: () => false, sleep: pause })).toEqual({ queued: 3, cancelled: false })
    expect(runOne.mock.calls.map(c => c[0])).toEqual([0, 1, 2])
    expect(pause).toHaveBeenCalledTimes(2)
  })
  it('stops when the user declines the cost confirm', async () => {
    const runOne = vi.fn(async (i: number) => i === 0)
    expect(await runVariationsLoop({ count: 3, runOne, cancelled: () => false, sleep })).toEqual({ queued: 1, cancelled: false })
  })
  it('stops before the next run once cancelled', async () => {
    let stop = false
    const runOne = vi.fn(async () => { stop = true; return true })
    expect(await runVariationsLoop({ count: 3, runOne, cancelled: () => stop, sleep })).toEqual({ queued: 1, cancelled: true })
    expect(runOne).toHaveBeenCalledTimes(1)
  })
  it('a run that throws ends the loop with what was queued, and logs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runOne = vi.fn(async (i: number) => { if (i === 1) throw new Error('boom'); return true })
    expect(await runVariationsLoop({ count: 3, runOne, cancelled: () => false, sleep })).toEqual({ queued: 1, cancelled: false })
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
