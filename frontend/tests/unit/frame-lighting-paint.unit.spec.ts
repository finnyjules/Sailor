import { describe, it, expect, vi, beforeEach } from 'vitest'
import { paintLayerStack, type LocalLayer, type StackItem } from '~/composables/useCompositorLayers'
import { newLightLayer, DEFAULT_LIGHTING } from '~/lib/frame/lighting/settings'
import { lightingAvailable } from '~/lib/frame/lighting/lightingPass'

// Same stub context as frame-light-paint.unit.spec.ts, recording every drawing call in order.
function stubCtx(tag = 'ctx') {
  const calls: string[] = []
  const rec = (name: string) => vi.fn((...args: unknown[]) => { calls.push(`${name}(${args.filter(a => typeof a === 'number').join(',')})`) })
  const ctx: any = {
    _tag: tag,
    _calls: calls,
    canvas: { width: 20, height: 20 },
    save: rec('save'), restore: rec('restore'),
    drawImage: rec('drawImage'), clearRect: rec('clearRect'), fillRect: rec('fillRect'),
    setTransform: rec('setTransform'), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    translate: rec('translate'), rotate: rec('rotate'), scale: rec('scale'), transform: rec('transform'),
    beginPath: rec('beginPath'), rect: rec('rect'), ellipse: rec('ellipse'), clip: rec('clip'),
    roundRect: rec('roundRect'), fill: rec('fill'), stroke: rec('stroke'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), closePath: rec('closePath'), arc: rec('arc'),
    quadraticCurveTo: rec('quadraticCurveTo'), bezierCurveTo: rec('bezierCurveTo'),
    setLineDash: rec('setLineDash'),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createPattern: vi.fn(() => ({})),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) =>
      ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })),
    putImageData: rec('putImageData'),
    createImageData: vi.fn((w: number, h: number) =>
      ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })),
    measureText: vi.fn(() => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })),
    fillText: rec('fillText'), strokeText: rec('strokeText'),
    globalCompositeOperation: 'source-over', globalAlpha: 1,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    imageSmoothingEnabled: true, filter: 'none',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
  }
  return ctx
}

let webgl2Asked = 0
function mkStubCanvas() {
  const c: any = { width: 0, height: 0, addEventListener: vi.fn() }
  const ctx = stubCtx('offscreen')
  ctx.canvas = c
  // No WebGL2 here: the lighting pass must find itself unavailable and draw nothing.
  c.getContext = (kind: string) => {
    if (kind === 'webgl2') { webgl2Asked++; return null }
    return ctx
  }
  return c
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => (tag === 'canvas' ? mkStubCanvas() : ({} as any)),
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const rect = (id: string): LocalLayer => ({
  id, kind: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1, fill: '#ff0000',
} as unknown as LocalLayer)
const itemsOf = (ls: LocalLayer[]): StackItem[] => ls.map(l => ({ type: 'local' as const, key: `l:${l.id}`, layer: l }))
function paint(ls: LocalLayer[], withLighting: boolean) {
  const ctx = stubCtx()
  paintLayerStack(ctx, 20, 20, itemsOf(ls), ls, undefined, undefined, undefined, undefined, '#ffffff' as any, undefined, undefined, false, undefined,
    withLighting ? DEFAULT_LIGHTING : undefined)
  return ctx._calls as string[]
}

describe('paintLayerStack lighting — no light ⇒ byte-identical', () => {
  it('a Frame with no light layer makes no extra draw, with or without a lighting record', () => {
    const before = webgl2Asked
    const a = paint([rect('a'), rect('b')], false)
    const b = paint([rect('a'), rect('b')], true)
    expect(b).toEqual(a)
    expect(a.length).toBeGreaterThan(0)
    // No light ⇒ the pass is never even asked whether it can run.
    expect(webgl2Asked).toBe(before)
  })

  it('a light layer with no WebGL2 paints the same draws as without it', () => {
    const lamp = newLightLayer('lamp') as unknown as LocalLayer
    const without = paint([rect('a'), rect('b')], true)
    const withLight = paint([rect('a'), lamp, rect('b')], true)
    expect(withLight).toEqual(without)
    expect(lightingAvailable()).toBe(false)
  })

  it('the light layer itself draws nothing', () => {
    const lamp = newLightLayer('spot') as unknown as LocalLayer
    const calls = paint([lamp], true)
    const bgOnly = paint([], true)
    expect(calls).toEqual(bgOnly)
  })
})
