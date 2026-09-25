import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deleteMyEffect, listMyEffects, MY_EFFECTS_ERRORS, myEffectsError, putMyEffect, renameMyEffect } from '~/lib/myEffects/client'

const fetchErr = (status?: number) => Object.assign(
  new Error(`[PUT] "/api/my-effects/mine_abc123def456": ${status ?? '<no response>'} Invalid id`),
  status ? { statusCode: status, status, response: { status } } : {},
)

describe('My effects errors are plain sentences, never a URL, id or status', () => {
  beforeEach(() => { (globalThis as any).$fetch = vi.fn() })

  it('maps each kind of failure', () => {
    expect(myEffectsError(fetchErr(404), 'save').message).toBe('That effect isn’t in My effects any more.')
    expect(myEffectsError(fetchErr(413), 'save').message).toBe('That effect is too large to save.')
    expect(myEffectsError(fetchErr(), 'save').message).toBe('My effects couldn’t be reached. Try again in a moment.')
    expect(myEffectsError(new DOMException('aborted', 'AbortError'), 'load').message).toBe('My effects couldn’t be reached. Try again in a moment.')
    expect(myEffectsError(fetchErr(400), 'save').message).toBe('Couldn’t save to My effects.')
    expect(myEffectsError(fetchErr(500), 'load').message).toBe('Couldn’t load My effects.')
    expect(myEffectsError(fetchErr(409), 'remove').message).toBe('Couldn’t remove that effect from My effects.')
  })

  it('every call rethrows the plain sentence', async () => {
    const $f = (globalThis as any).$fetch
    for (const [run, status, want] of [
      [() => listMyEffects(), 500, 'Couldn’t load My effects.'],
      [() => putMyEffect({ id: 'mine_abc123def456' } as any), 400, 'Couldn’t save to My effects.'],
      [() => renameMyEffect('mine_abc123def456', 'x'), 404, 'That effect isn’t in My effects any more.'],
      [() => deleteMyEffect('mine_abc123def456'), 413, 'That effect is too large to save.'],
    ] as const) {
      $f.mockRejectedValueOnce(fetchErr(status))
      const err = await run().then(() => null, (e: Error) => e)
      expect(err?.message).toBe(want)
      expect(err?.message).not.toMatch(/mine_|\/api|\d{3}/)
    }
  })

  it('sends the right requests', async () => {
    const $f = (globalThis as any).$fetch
    $f.mockResolvedValue({ effects: [{ id: 'mine_abc123def456' }] })
    expect(await listMyEffects()).toEqual([{ id: 'mine_abc123def456' }])
    expect($f).toHaveBeenLastCalledWith('/api/my-effects')
    await putMyEffect({ id: 'mine_abc123def456' } as any)
    expect($f).toHaveBeenLastCalledWith('/api/my-effects/mine_abc123def456', { method: 'PUT', body: { id: 'mine_abc123def456' }, signal: expect.any(AbortSignal) })
    await renameMyEffect('mine_abc123def456', 'Rain')
    expect($f).toHaveBeenLastCalledWith('/api/my-effects/mine_abc123def456', { method: 'PATCH', body: { name: 'Rain' }, signal: expect.any(AbortSignal) })
    await deleteMyEffect('mine_abc123def456')
    expect($f).toHaveBeenLastCalledWith('/api/my-effects/mine_abc123def456', { method: 'DELETE', signal: expect.any(AbortSignal) })
  })

  it('a save that never answers gives up after its timeout with the plain sentence, and is cancelled (final review #11)', async () => {
    const $f = (globalThis as any).$fetch
    let signal: AbortSignal | undefined
    $f.mockImplementation((_u: string, o: { signal: AbortSignal }) => { signal = o.signal; return new Promise(() => {}) })
    for (const run of [
      () => putMyEffect({ id: 'mine_abc123def456' } as any, 20),
      () => renameMyEffect('mine_abc123def456', 'x', 20),
    ]) {
      const err = await run().then(() => null, (e: Error) => e)
      expect(err?.message).toBe(MY_EFFECTS_ERRORS.unreachable)
      expect(signal?.aborted).toBe(true)
    }
    const err = await deleteMyEffect('mine_abc123def456', 20).then(() => null, (e: Error) => e)
    expect(err?.message).toBe(MY_EFFECTS_ERRORS.unreachable)
  })
})
