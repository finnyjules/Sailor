import { describe, it, expect, vi, beforeEach } from 'vitest'
import { paintLayerStack, currentFrameLight } from '~/composables/useCompositorLayers'
import { DEFAULT_FRAME_LIGHT } from '~/lib/compositor/frameLight'

function stubCtx(tag = 'ctx') {
  const ctx: any = {
    _tag: tag,
    _filters: [] as string[],
    _ops: [] as string[],
    canvas: { width: 20, height: 20 },
    save: vi.fn(), restore: vi.fn(),
    drawImage: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(),
    setTransform: vi.fn(), getTransform: () => ({ a: 1 }),
    translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), transform: vi.fn(),
    beginPath: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), clip: vi.fn(),
    roundRect: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createPattern: vi.fn(() => ({})),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) =>
      ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })),
    putImageData: vi.fn(),
    createImageData: vi.fn((w: number, h: number) =>
      ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })),
    measureText: vi.fn(() => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })),
    fillText: vi.fn(), strokeText: vi.fn(),
    globalCompositeOperation: 'source-over', globalAlpha: 1,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    imageSmoothingEnabled: true,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
  }
  // Record filter assignments so tests can assert which filters were applied.
  let _filter = 'none'
  Object.defineProperty(ctx, 'filter', {
    get: () => _filter,
    set: (v: string) => { _filter = v; ctx._filters.push(v) },
  })
  return ctx
}

function mkStubCanvas() {
  const c: any = { width: 0, height: 0 }
  const ctx = stubCtx('offscreen')
  ctx.canvas = c
  c.getContext = () => ctx
  return c
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => (tag === 'canvas' ? mkStubCanvas() : ({} as any)),
  })
})

describe('paintLayerStack light', () => {
  it('uses the light it is given for the paint in progress', () => {
    const ctx = stubCtx()
    const l = { x: 0.7, y: 0.2, height: 0.4 }
    paintLayerStack(ctx, 20, 20, [], [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, false, l)
    expect(currentFrameLight()).toEqual(l)
  })
  it('falls back to the default light when a caller passes none (every existing call site)', () => {
    const ctx = stubCtx()
    paintLayerStack(ctx, 20, 20, [], [])
    expect(currentFrameLight()).toEqual(DEFAULT_FRAME_LIGHT)
  })
})
