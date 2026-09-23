import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('~/lib/compositor/depthRequest', () => ({
  requestDepthEstimate: vi.fn(async () => ({ ok: false, message: 'depth estimation is not available here' })),
}))

import {
  requestDepth, depthStatusFor, depthMessageFor, depthImageFor, seedDepthImage, onDepthChange, __resetDepthRegistry,
} from '~/lib/compositor/depthRegistry'
import { setShaderFxCatalog, addShaderFxEffects, getEffectSync } from '~/lib/shaderfx/catalogStore'
import { fontFaceRule, fontFaceId } from '~/lib/embed/fontFace'

describe('depth registry', () => {
  beforeEach(() => __resetDepthRegistry())

  it('a seeded depth map is ready synchronously and notifies', () => {
    const img = {} as HTMLImageElement
    const seen = vi.fn()
    onDepthChange(seen)
    seedDepthImage({ filename: 'a.png', type: 'input' }, img)
    expect(depthImageFor('a.png')).toBe(img)
    expect(depthStatusFor('a.png')).toBe('ready')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('a failed estimate lands as a retryable error with its message', async () => {
    requestDepth('b.png')
    await vi.waitFor(() => expect(depthStatusFor('b.png')).toBe('error'))
    expect(depthMessageFor('b.png')).toBe('depth estimation is not available here')
  })
})

describe('shader catalog merge', () => {
  it('adds effects the catalog lacks and never replaces one it has', () => {
    setShaderFxCatalog({ version: 3, effects: [{ id: 'keep', source: 'A' } as any] })
    addShaderFxEffects([{ id: 'keep', source: 'B' } as any, { id: 'new', source: 'C' } as any])
    expect((getEffectSync('keep') as any).source).toBe('A')
    expect((getEffectSync('new') as any).source).toBe('C')
  })

  it('works from an empty store', () => {
    setShaderFxCatalog(null)
    addShaderFxEffects([{ id: 'solo', source: 'S' } as any])
    expect((getEffectSync('solo') as any).source).toBe('S')
  })
})

describe('font faces with a weight range', () => {
  it('a single weight is unchanged', () => {
    expect(fontFaceRule({ family: 'A', weight: 700, dataUrl: 'data:font/ttf;base64,AA' }))
      .toBe("@font-face{font-family:'A';font-weight:700;font-style:normal;font-display:swap;src:url('data:font/ttf;base64,AA')}")
    expect(fontFaceId('A', 700)).toBe('A__700')
  })

  it('a variable file declares its whole weight range', () => {
    expect(fontFaceRule({ family: 'Inter', weight: [100, 900], dataUrl: 'data:font/ttf;base64,AA' }))
      .toContain('font-weight:100 900;')
    expect(fontFaceId('Inter', [100, 900])).toBe('Inter__100-900')
  })
})
