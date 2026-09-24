/**
 * The Frame web export sheet's wired-clip cache: toggling Fit or Transparent (anything a clip does
 * not depend on) rebuilds the file without re-rendering a wired clip; a changed slot, frame count,
 * size or source content does re-render it; a failed or short pull is never kept.
 */
import { describe, it, expect, vi } from 'vitest'
import { createWiredClipCache, type WiredClipKey } from '~/lib/embed/frame/clipCache'

const source = {}
const key = (over: Partial<WiredClipKey> = {}): WiredClipKey => ({ slot: 0, count: 2, maxPx: 800, source, signal: 'v1', ...over })
const ok = () => vi.fn(async () => ({ frames: ['data:a', 'data:b'], failures: [] }))

describe('createWiredClipCache', () => {
  it('a rebuild with the same clip reuses the frames — the source is pulled once', async () => {
    const cache = createWiredClipCache()
    const pull = ok()
    const a = await cache.get(key(), pull)
    const b = await cache.get(key(), pull)
    expect(pull).toHaveBeenCalledTimes(1)
    expect(b).toEqual(a)
    expect(b.failures).toEqual([])
  })

  it('misses when the frame count, the size, the source or what it draws changed', async () => {
    for (const changed of [{ count: 3 }, { maxPx: 900 }, { source: {} }, { signal: 'v2' }] as Partial<WiredClipKey>[]) {
      const cache = createWiredClipCache()
      const pull = ok()
      await cache.get(key(), pull)
      const other = vi.fn(async () => ({ frames: Array<string>(changed.count ?? 2).fill('x'), failures: [] }))
      await cache.get(key(changed), other)
      expect(other).toHaveBeenCalledTimes(1)
      await cache.get(key(), pull)
      // The changed key replaced the slot's entry, so going back pulls again.
      expect(pull, JSON.stringify(Object.keys(changed))).toHaveBeenCalledTimes(2)
    }
  })

  it('keeps one clip per slot', async () => {
    const cache = createWiredClipCache()
    const p0 = ok(), p1 = ok()
    await cache.get(key({ slot: 0 }), p0)
    await cache.get(key({ slot: 1 }), p1)
    await cache.get(key({ slot: 0 }), p0)
    await cache.get(key({ slot: 1 }), p1)
    expect(p0).toHaveBeenCalledTimes(1)
    expect(p1).toHaveBeenCalledTimes(1)
    expect(cache.size).toBe(2)
  })

  it('never keeps a pull that named failures, came back short or threw', async () => {
    const cache = createWiredClipCache()
    const failed = vi.fn(async () => ({ frames: [], failures: [{ name: 'model "a"', reason: '404' }] }))
    await cache.get(key(), failed); await cache.get(key(), failed)
    expect(failed).toHaveBeenCalledTimes(2)
    const short = vi.fn(async () => ({ frames: ['only one'], failures: [] }))
    await cache.get(key(), short); await cache.get(key(), short)
    expect(short).toHaveBeenCalledTimes(2)
    const threw = vi.fn(async () => { throw new Error('superseded') })
    await expect(cache.get(key(), threw)).rejects.toThrow('superseded')
    await expect(cache.get(key(), threw)).rejects.toThrow('superseded')
    expect(threw).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(0)
  })

  it('clear() drops everything (the sheet closed)', async () => {
    const cache = createWiredClipCache()
    const pull = ok()
    await cache.get(key(), pull)
    cache.clear()
    await cache.get(key(), pull)
    expect(pull).toHaveBeenCalledTimes(2)
  })
})
