import { describe, it, expect } from 'vitest'
import { bakeFrameSequence, frameCountFor } from '~/lib/scene3d/bakeFrames'

const fakeCanvas = (tag: string) => ({ tag }) as unknown as HTMLCanvasElement

describe('frameCountFor', () => {
  it('an animated loop is duration × fps frames', () => { expect(frameCountFor({ animated: true, duration: 4 }, 30)).toBe(120) })
  it('rounds, and never goes below one', () => { expect(frameCountFor({ animated: true, duration: 0.01 }, 30)).toBe(1) })
  it('a still scene is one frame', () => { expect(frameCountFor({ animated: false, duration: 0 }, 30)).toBe(1) })
})

describe('bakeFrameSequence', () => {
  it('renders t = i / count for each frame, in order, and encodes each', async () => {
    const seen: number[] = []
    const frames = await bakeFrameSequence({
      count: 4,
      renderAt: (t) => { seen.push(t); return fakeCanvas(String(t)) },
      encode: async (c) => `data:image/webp;base64,${(c as any).tag}`,
    })
    expect(seen).toEqual([0, 0.25, 0.5, 0.75])
    expect(frames).toEqual(['data:image/webp;base64,0', 'data:image/webp;base64,0.25', 'data:image/webp;base64,0.5', 'data:image/webp;base64,0.75'])
  })
  it('reports progress after each frame', async () => {
    const progress: string[] = []
    await bakeFrameSequence({ count: 2, renderAt: () => fakeCanvas('x'), encode: async () => 'd', onProgress: (d, t) => progress.push(`${d}/${t}`) })
    expect(progress).toEqual(['1/2', '2/2'])
  })
  it('stops between frames when aborted', async () => {
    const ac = new AbortController()
    let rendered = 0
    const p = bakeFrameSequence({ count: 10, renderAt: () => { rendered++; if (rendered === 2) ac.abort(); return fakeCanvas('x') }, encode: async () => 'd', signal: ac.signal })
    await expect(p).rejects.toThrow(/abort/i)
    expect(rendered).toBe(2)
  })
  it('encodes each frame before rendering the next (the canvas is reused)', async () => {
    const order: string[] = []
    await bakeFrameSequence({ count: 2, renderAt: (t) => { order.push(`r${t}`); return fakeCanvas('x') }, encode: async () => { order.push('e'); return 'd' } })
    expect(order).toEqual(['r0', 'e', 'r0.5', 'e'])
  })
})
