import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  RelightFieldCache, fieldSizeFor, relightSourceReady, FIELD_MAX_EDGE, type FloatDepth,
} from '~/lib/relight/depthFieldCore'

const field = (bytes: number): FloatDepth => ({ kind: 'float', width: bytes / 4, height: 1, data: new Float32Array(bytes / 4) })

describe('fieldSizeFor', () => {
  it('keeps the source aspect and caps the long edge', () => {
    expect(fieldSizeFor(4000, 2000)).toEqual({ w: FIELD_MAX_EDGE, h: FIELD_MAX_EDGE / 2 })
    expect(fieldSizeFor(1000, 3072)).toEqual({ w: 500, h: FIELD_MAX_EDGE })
    expect(fieldSizeFor(800, 600)).toEqual({ w: 800, h: 600 })   // small sources stay native
  })
})

describe('relightSourceReady', () => {
  it('needs a decoded image or a sized canvas', () => {
    expect(relightSourceReady({ complete: false, naturalWidth: 0, naturalHeight: 0 })).toBe(false)
    expect(relightSourceReady({ complete: true, naturalWidth: 0, naturalHeight: 0 })).toBe(false)   // broken image
    expect(relightSourceReady({ complete: true, naturalWidth: 10, naturalHeight: 10 })).toBe(true)
    expect(relightSourceReady({ width: 0, height: 5 })).toBe(false)
    expect(relightSourceReady({ width: 5, height: 5 })).toBe(true)
    expect(relightSourceReady(null)).toBe(false)
  })
})

describe('RelightFieldCache', () => {
  it('evicts least recently used first once over the byte cap', () => {
    const c = new RelightFieldCache(100)
    c.set('a', field(40)); c.set('b', field(40))
    c.get('a')                                   // a is now the newest
    c.set('c', field(40))                        // 120 > 100: b goes, not a
    expect(c.keys().sort()).toEqual(['a', 'c'])
    expect(c.bytes).toBe(80)
  })
  it('never evicts a field pinned for the current paint (runs over the cap instead)', () => {
    const c = new RelightFieldCache(100)
    c.set('a', field(60)); c.pin('a')
    c.set('b', field(60))
    expect(c.keys().sort()).toEqual(['a', 'b'])
    c.unpinAll()
    c.set('c', field(12))                         // over cap, a unpinned now: oldest goes
    expect(c.has('a')).toBe(false)
    expect(c.bytes).toBe(72)
  })
  it('replacing a key does not double count', () => {
    const c = new RelightFieldCache(1000)
    c.set('a', field(40)); c.set('a', field(80))
    expect(c.bytes).toBe(80)
    expect(c.size).toBe(1)
  })
})

describe('relightDepthFieldFor (no Worker: synchronous fallback)', () => {
  const reads: { w: number; h: number }[] = []
  beforeEach(() => {
    reads.length = 0
    vi.resetModules()
    vi.stubGlobal('Worker', undefined)
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({
          drawImage() {},
          getImageData: (_x: number, _y: number, w: number, h: number) => { reads.push({ w, h }); return { data: new Uint8ClampedArray(w * h * 4).fill(128) } },
        }),
      }),
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const depth = { complete: true, naturalWidth: 8, naturalHeight: 4 } as unknown as HTMLImageElement

  it('builds from the source at its native aspect, caches by key, and returns the same object', async () => {
    const { relightDepthFieldFor } = await import('~/lib/relight/depthField')
    const src = { complete: true, naturalWidth: 60, naturalHeight: 30 } as unknown as HTMLImageElement
    const f = relightDepthFieldFor('k', depth, src)!
    expect(f).toMatchObject({ kind: 'float', width: 60, height: 30 })
    expect(reads).toEqual([{ w: 8, h: 4 }, { w: 60, h: 30 }])
    expect(relightDepthFieldFor('k', depth, { complete: true, naturalWidth: 10, naturalHeight: 10 } as unknown as HTMLImageElement)).toBe(f)
    expect(reads).toHaveLength(2)                 // a hit reads no pixels
  })

  it('does not build or cache from an undecoded source', async () => {
    const { relightDepthFieldFor, __relightFieldCacheKeys } = await import('~/lib/relight/depthField')
    const src = { complete: false, naturalWidth: 0, naturalHeight: 0 } as unknown as HTMLImageElement
    expect(relightDepthFieldFor('k2', depth, src)).toBeNull()
    expect(reads).toHaveLength(0)
    expect(__relightFieldCacheKeys()).not.toContain('k2')
    expect(relightDepthFieldFor('k2', depth, null)).toBeNull()
  })
})
