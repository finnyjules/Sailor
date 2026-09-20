import { describe, it, expect, vi } from 'vitest'
import { showcaseImageKey, syncImageTextures } from '~/lib/spacetype/imageTextures'

const content = (srcs: string[]) => JSON.stringify([
  { id: 'c0', kind: 'card', fillKind: 'solid' },
  ...srcs.map((src, i) => ({ id: `i${i}`, kind: 'card', fillKind: 'image', src })),
  { id: 'w', kind: 'word', text: 'HI', resolution: 'whole' },
])

describe('showcase image texture sync', () => {
  it('the key names only image cards, order-independent and de-duplicated', () => {
    expect(showcaseImageKey('ring', { content: content(['b.png', 'a.png', 'a.png']) })).toBe('["a.png","b.png"]')
    expect(showcaseImageKey('ring', { content: content(['a.png', 'b.png']) })).toBe('["a.png","b.png"]')
  })
  it('needs nothing for fill-only content, malformed content, or any other effect', () => {
    expect(showcaseImageKey('ring', { content: content([]) })).toBe('')
    expect(showcaseImageKey('ring', { content: '{nope' })).toBe('')
    expect(showcaseImageKey('ribbon', { content: content(['a.png']) })).toBe('')
  })
  it('is a no-op (no texture swap, no rebuild asked) when the engine needs no images', async () => {
    const host = { setImageTextures: vi.fn() }
    expect(await syncImageTextures(host, 'ribbon', { text: 'Sailor' })).toBe(false)
    expect(await syncImageTextures(host, 'ring', { content: content([]) })).toBe(false)
    expect(host.setImageTextures).not.toHaveBeenCalled()
  })
})
