// @vitest-environment happy-dom
// frontend/tests/unit/embed-frames-surface.unit.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import surface, { frameIndexAt } from '~/lib/embed/surfaces/frames'

describe('frameIndexAt', () => {
  it('maps the loop position onto the frames, never past the last', () => {
    expect(frameIndexAt(0, 4)).toBe(0)
    expect(frameIndexAt(0.24, 4)).toBe(0)
    expect(frameIndexAt(0.25, 4)).toBe(1)
    expect(frameIndexAt(0.999, 4)).toBe(3)
    expect(frameIndexAt(1, 4)).toBe(0)          // the loop wraps
    expect(frameIndexAt(-0.1, 4)).toBe(0)
    expect(frameIndexAt(NaN, 4)).toBe(0)
  })
})

describe('the frames player', () => {
  let drawn: unknown[]
  beforeEach(() => {
    drawn = []
    vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror: (() => void) | null = null; naturalWidth = 8; naturalHeight = 8
      set src(v: string) { (this as any)._src = v; queueMicrotask(() => this.onload?.()) } get src() { return (this as any)._src } })
    HTMLCanvasElement.prototype.getContext = function () {
      return { clearRect() {}, drawImage: (img: any) => { drawn.push(img.src) }, setTransform() {} } as any
    } as any
  })
  const cfg = { frames: ['data:image/webp;base64,A', 'data:image/webp;base64,B', 'data:image/webp;base64,C'], fps: 30, width: 8, height: 8 }

  it('leaves a canvas in the container and draws frame 0 on mount', async () => {
    const box = document.createElement('div')
    await surface.mount(box, cfg)
    expect(box.querySelector('canvas')).toBeTruthy()
    expect(drawn.at(-1)).toBe('data:image/webp;base64,A')
  })
  it('setTime draws the right frame synchronously', async () => {
    const box = document.createElement('div')
    const h = await surface.mount(box, cfg)
    h.setTime(0.5)
    expect(drawn.at(-1)).toBe('data:image/webp;base64,B')
    h.setTime(0.9)
    expect(drawn.at(-1)).toBe('data:image/webp;base64,C')
  })
  it('setSize resizes the canvas to the device pixels it is given and redraws', async () => {
    const box = document.createElement('div')
    const h = await surface.mount(box, cfg)
    h.setTime(0.9); drawn.length = 0
    h.setSize(200, 100)
    const c = box.querySelector('canvas')!
    expect([c.width, c.height]).toEqual([200, 100])
    expect(drawn.at(-1)).toBe('data:image/webp;base64,C')
  })
  it('destroy removes the canvas', async () => {
    const box = document.createElement('div')
    const h = await surface.mount(box, cfg)
    h.destroy()
    expect(box.querySelector('canvas')).toBeNull()
  })
  it('refuses an empty or malformed config instead of drawing nothing', async () => {
    await expect(surface.mount(document.createElement('div'), { ...cfg, frames: [] })).rejects.toThrow()
    await expect(surface.mount(document.createElement('div'), { ...cfg, frames: ['https://x/y.webp'] })).rejects.toThrow()
  })
})
