import { beforeEach, describe, expect, it, vi } from 'vitest'

// C1: a Frame web export paints a still ONCE, so its outline fonts must be in the very cache
// `getCompositorFont` reads before that paint. `loadVectorFont` is mocked — the cache logic is
// what is under test, not the bytes.
const { loadVectorFont } = vi.hoisted(() => ({ loadVectorFont: vi.fn() }))
vi.mock('~/lib/vectortype/font', () => ({ loadVectorFont, defaultCoords: () => ({}), clampCoords: () => ({}) }))

import {
  __resetCompositorFontCacheForTest, compositorFontToken, getCompositorFont, onCompositorFontReady, warmCompositorFont,
} from '~/lib/compositor/textOutline'

const font = { id: 'f', axes: [], unitsPerEm: 1000, raw: {} }
const layer = { fontFamily: 'Inter', fontWeight: 700 }

beforeEach(() => {
  __resetCompositorFontCacheForTest()
  loadVectorFont.mockReset()
})

describe('warmCompositorFont', () => {
  it('fills the same entry getCompositorFont reads: warm, then the first sync call has the font', async () => {
    loadVectorFont.mockResolvedValue(font)
    const token = compositorFontToken(layer)!
    expect(await warmCompositorFont(token)).toBe(true)
    expect(getCompositorFont(layer)).toBe(font)
    expect(loadVectorFont).toHaveBeenCalledTimes(1)
  })

  it('awaits a load getCompositorFont already started, without a second fetch', async () => {
    let settle!: (f: unknown) => void
    loadVectorFont.mockReturnValue(new Promise(r => { settle = r }))
    expect(getCompositorFont(layer)).toBeNull()          // the editor's first miss starts the load
    const warm = warmCompositorFont(compositorFontToken(layer)!)
    settle(font)
    expect(await warm).toBe(true)
    expect(loadVectorFont).toHaveBeenCalledTimes(1)
    expect(getCompositorFont(layer)).toBe(font)
  })

  it('resolves false (never rejects) for a font that fails, and stays failed', async () => {
    loadVectorFont.mockRejectedValue(new Error('404'))
    const token = compositorFontToken(layer)!
    expect(await warmCompositorFont(token)).toBe(false)
    expect(await warmCompositorFont(token)).toBe(false)
    expect(getCompositorFont(layer)).toBeNull()
    expect(loadVectorFont).toHaveBeenCalledTimes(1)
  })

  it('still notifies ready subscribers, as the editor path does', async () => {
    loadVectorFont.mockResolvedValue(font)
    const cb = vi.fn()
    onCompositorFontReady(cb)
    await warmCompositorFont(compositorFontToken(layer)!)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('the lean bundle stand-in', () => {
  it('cannot warm a font: false, loudly', async () => {
    const lean = await import('~/lib/embed/frame/textOutline.embed')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await lean.warmCompositorFont('google:Inter@700')).toBe(false)
    expect(err).toHaveBeenCalledTimes(1)
    err.mockRestore()
  })
})
