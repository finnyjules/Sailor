import { describe, it, expect, vi } from 'vitest'
import { settleOnCompletion } from '~~/server/utils/settleWatcher'

const noSleep = () => Promise.resolve()

describe('settleOnCompletion', () => {
  it('settles on a success status after a couple of empty polls', async () => {
    const seq = [null, null, { status: { status_str: 'success' as const, completed: true } }]
    let i = 0
    const onSuccess = vi.fn(); const onError = vi.fn()
    const r = await settleOnCompletion({
      promptId: 'p1', pollHistory: async () => seq[i++] ?? null,
      onSuccess, onError, sleep: noSleep, intervalMs: 0,
    })
    expect(r).toBe('success')
    expect(onSuccess).toHaveBeenCalledWith('p1')
    expect(onError).not.toHaveBeenCalled()
  })

  it('calls onError with the failed run\'s history entry on an error status', async () => {
    const onSuccess = vi.fn(); const onError = vi.fn()
    const entry = { status: { status_str: 'error' as const, completed: false } } // real engine shape: errors keep completed:false
    const r = await settleOnCompletion({
      promptId: 'p1', pollHistory: async () => entry,
      onSuccess, onError, sleep: noSleep, intervalMs: 0,
    })
    expect(r).toBe('error')
    // Task G2: the entry lets the caller charge the paid nodes that finished.
    expect(onError).toHaveBeenCalledWith('p1', entry)
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('times out without charging when the run never completes', async () => {
    const onSuccess = vi.fn(); const onError = vi.fn()
    const r = await settleOnCompletion({
      promptId: 'p1', pollHistory: async () => null,
      onSuccess, onError, sleep: noSleep, intervalMs: 0, maxPolls: 3,
    })
    expect(r).toBe('timeout')
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('p1')
  })

  it('treats a throwing pollHistory as a transient failure and keeps polling', async () => {
    const seq = [
      () => Promise.reject(new Error('engine restarting')),
      () => Promise.resolve({ status: { status_str: 'success' as const, completed: true } }),
    ]
    let i = 0
    const onSuccess = vi.fn(); const onError = vi.fn()
    const r = await settleOnCompletion({
      promptId: 'p1', pollHistory: () => seq[Math.min(i++, seq.length - 1)]!(),
      onSuccess, onError, sleep: noSleep, intervalMs: 0,
    })
    expect(r).toBe('success')
    expect(onSuccess).toHaveBeenCalledWith('p1')
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not settle success until completed is true', async () => {
    const seq = [
      { status: { status_str: 'success' as const, completed: false } },
      { status: { status_str: 'success' as const, completed: true } },
    ]
    let i = 0
    const onSuccess = vi.fn(); const onError = vi.fn()
    const r = await settleOnCompletion({
      promptId: 'p1', pollHistory: async () => seq[Math.min(i++, seq.length - 1)]!,
      onSuccess, onError, sleep: noSleep, intervalMs: 0,
    })
    expect(r).toBe('success')
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })
})
