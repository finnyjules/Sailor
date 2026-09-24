// frontend/tests/unit/texture-shader-frame-source.unit.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { makeTextureFrameSource } from '../../app/lib/texturefx/frameSource'
import { makeShaderFrameSource } from '../../app/lib/shaderstudio/frameSource'

describe('makeTextureFrameSource', () => {
  it('is a still at the sheet size and renders the current params', async () => {
    let params: any = { a: 1 }
    const canvas = { tag: 'sheet' } as any
    const render = vi.fn(() => canvas)
    const src = makeTextureFrameSource({ getParams: () => params, render, size: p => ({ w: p.a * 100, h: 50 }) })
    expect(src.duration).toBe(0)
    expect(src.width).toBe(100)
    params = { a: 3 }
    expect(src.width).toBe(300)       // live getter, not a snapshot
    expect(await src.getFrame(0.5, 10, 10)).toBe(canvas)
    expect(render).toHaveBeenCalledWith(params)
  })
})

describe('makeShaderFrameSource', () => {
  it('reports the node clock and size and forwards frames', async () => {
    const frame = { tag: 'f' } as any
    const render = vi.fn(async () => frame)
    const src = makeShaderFrameSource({ getSize: () => ({ w: 640, h: 480 }), getDuration: () => 4, render })
    expect([src.width, src.height, src.duration]).toEqual([640, 480, 4])
    expect(await src.getFrame(0.25, 320, 240)).toBe(frame)
    expect(render).toHaveBeenCalledWith(0.25, 320, 240)
  })

  it('rejects rather than returning nothing when the shader has no picture', async () => {
    const src = makeShaderFrameSource({ getSize: () => ({ w: 1, h: 1 }), getDuration: () => 0, render: async () => null })
    await expect(src.getFrame(0, 1, 1)).rejects.toThrow(/no picture/)
  })
})
