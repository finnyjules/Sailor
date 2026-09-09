import { beforeEach, describe, expect, it, vi } from 'vitest'

// The font bridge's only side effect is fetching bytes through `loadVectorFont`.
// Mock it so the cache/subscribe/async-load logic is tested with no network and
// deterministic timing. `vi.hoisted` so the spy exists before `vi.mock`'s hoist.
const { loadVectorFont } = vi.hoisted(() => ({ loadVectorFont: vi.fn() }))
vi.mock('~/lib/vectortype/font', () => ({ loadVectorFont }))

import {
  __resetCompositorFontCacheForTest,
  compositorFontToken,
  getCompositorFont,
  onCompositorFontReady,
} from '~/lib/compositor/textOutline'
import type { VtFont } from '~/lib/vectortype/font'

const fakeFont = (id: string): VtFont => ({ id, axes: [], unitsPerEm: 1000, raw: {} })
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

beforeEach(() => {
  __resetCompositorFontCacheForTest()
  loadVectorFont.mockReset()
})

describe('compositorFontToken', () => {
  it('resolves a curated variable family to its bare catalog id', () => {
    expect(compositorFontToken({ fontFamily: 'Inter', fontWeight: 700 })).toBe('inter')
    expect(compositorFontToken({ fontFamily: 'Roboto Flex', fontWeight: 400 })).toBe('roboto-flex')
  })

  it('resolves a library-manifest family to a local token', () => {
    expect(compositorFontToken({ fontFamily: 'OT 2049', fontWeight: 700 })).toBe('local:OT 2049@700')
  })

  it('falls back to a google token for an unknown, non-system family', () => {
    expect(compositorFontToken({ fontFamily: 'Roboto', fontWeight: 400 })).toBe('google:Roboto@400')
    expect(compositorFontToken({ fontFamily: 'Poppins', fontWeight: 600 })).toBe('google:Poppins@600')
  })

  it('returns null for system / generic families (no byte source)', () => {
    for (const f of ['Arial', 'Helvetica', 'sans-serif', 'serif', 'monospace', 'Times New Roman', 'Georgia'])
      expect(compositorFontToken({ fontFamily: f, fontWeight: 400 })).toBeNull()
  })

  it('is case-insensitive about system families and tolerant of whitespace', () => {
    expect(compositorFontToken({ fontFamily: '  arial ', fontWeight: 400 })).toBeNull()
    expect(compositorFontToken({ fontFamily: 'HELVETICA', fontWeight: 400 })).toBeNull()
  })

  it('returns null for an empty family and defaults a missing weight to 400', () => {
    expect(compositorFontToken({ fontFamily: '', fontWeight: 400 })).toBeNull()
    expect(compositorFontToken({ fontFamily: 'Roboto' })).toBe('google:Roboto@400')
  })
})

describe('getCompositorFont', () => {
  it('never fetches for a null-token family and returns null', () => {
    expect(getCompositorFont({ fontFamily: 'Arial', fontWeight: 400 })).toBeNull()
    expect(loadVectorFont).not.toHaveBeenCalled()
  })

  it('returns null on the first call, loads once, then serves the cached font and fires ready', async () => {
    loadVectorFont.mockResolvedValue(fakeFont('inter'))
    const ready = vi.fn()
    onCompositorFontReady(ready)
    const layer = { fontFamily: 'Inter', fontWeight: 700 }

    expect(getCompositorFont(layer)).toBeNull()
    expect(loadVectorFont).toHaveBeenCalledTimes(1)
    expect(loadVectorFont).toHaveBeenCalledWith('inter')
    expect(ready).not.toHaveBeenCalled()

    await flush()

    expect(ready).toHaveBeenCalledTimes(1)
    const f = getCompositorFont(layer)
    expect(f?.id).toBe('inter')
    // Cached: a second synchronous call is the same font, no new load.
    expect(getCompositorFont(layer)).toBe(f)
    expect(loadVectorFont).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight load between two layers of the same family', async () => {
    loadVectorFont.mockResolvedValue(fakeFont('inter'))
    getCompositorFont({ fontFamily: 'Inter', fontWeight: 700 })
    getCompositorFont({ fontFamily: 'Inter', fontWeight: 400 })
    expect(loadVectorFont).toHaveBeenCalledTimes(1)
    await flush()
  })

  it('marks a failed load and returns null steadily without refetching or throwing', async () => {
    loadVectorFont.mockRejectedValue(new Error('HTTP 404'))
    const layer = { fontFamily: 'Not A Real Family', fontWeight: 400 }
    expect(() => getCompositorFont(layer)).not.toThrow()
    expect(getCompositorFont(layer)).toBeNull()
    await flush()
    expect(getCompositorFont(layer)).toBeNull()
    expect(loadVectorFont).toHaveBeenCalledTimes(1)
  })
})

describe('onCompositorFontReady', () => {
  it('returns an unsubscribe that stops future notifications', async () => {
    loadVectorFont.mockResolvedValue(fakeFont('inter'))
    const ready = vi.fn()
    const off = onCompositorFontReady(ready)
    off()
    getCompositorFont({ fontFamily: 'Inter', fontWeight: 700 })
    await flush()
    expect(ready).not.toHaveBeenCalled()
  })
})
