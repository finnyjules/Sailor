import { describe, it, expect, vi } from 'vitest'
import {
  applyPasses, isChainEffect, defaultPostEffect,
  POST_EFFECT_DEFAULTS, POST_FX_PARAM_CLAMP,
  OVERLAY_BLENDS, overlayBlendOf, gradientOverlayAxis,
  type ColorOverlayEffect, type GradientOverlayEffect,
} from '~/lib/compositor/postEffects'

/** A canvas stub. Scratch canvases (built by the passes via document.createElement) all push
 *  into a SHARED `scratch` log so a test can see the alpha-clip (destination-in) and the
 *  gradient axis/stops; the offscreen we pass to applyPasses has its OWN log, where only the
 *  FINAL composite lands — its op is the overlay's blend, and its globalAlpha the opacity. */
function makeStub(log: string[], grad: { ends: number[][]; stops: string[] }, w = 8, h = 8) {
  const ctx: any = {
    canvas: null as unknown as HTMLCanvasElement,
    filter: 'none', globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '' as unknown,
    save: () => log.push('save'),
    restore: () => log.push('restore'),
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => log.push('fillRect'),
    drawImage: () => log.push(`draw:${ctx.globalCompositeOperation}@${Math.round(ctx.globalAlpha * 100)}`),
    getImageData: () => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => log.push('putImageData'),
    createImageData: (iw: number, ih: number) => ({ data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => {
      grad.ends.push([x0, y0, x1, y1])
      return { addColorStop: (_p: number, c: string) => grad.stops.push(c) }
    },
    createPattern: () => ({}),
    scale: () => {},
  }
  const canvas = { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement
  ctx.canvas = canvas
  return { canvas, ctx }
}

/** Install a document whose createElement hands back fresh scratch canvases that all log into
 *  `scratch`/`grad`. Returns the offscreen (own log) to pass to applyPasses. */
function harness() {
  const scratch: string[] = []
  const grad = { ends: [] as number[][], stops: [] as string[] }
  vi.stubGlobal('document', { createElement: () => makeStub(scratch, grad).canvas })
  const off = makeStub([], grad) // off's gradient calls (none) share grad harmlessly
  return { off, scratch, grad }
}

const colour = (over: Partial<ColorOverlayEffect> = {}): ColorOverlayEffect =>
  ({ type: 'color_overlay', color: '#808080', blend: 'multiply', opacity: 1, visible: true, ...over })
const gradient = (over: Partial<GradientOverlayEffect> = {}): GradientOverlayEffect =>
  ({ type: 'gradient_overlay', from: '#ff0000', to: '#0000ff', angle: 0, blend: 'normal', opacity: 1, visible: true, ...over })

describe('overlay registration + coercion', () => {
  it('both kinds are chain effects with defaults inside their clamp ranges', () => {
    expect(isChainEffect(colour())).toBe(true)
    expect(isChainEffect(gradient())).toBe(true)
    for (const t of ['color_overlay', 'gradient_overlay'] as const) {
      const d = defaultPostEffect(t) as unknown as Record<string, number>
      expect(POST_EFFECT_DEFAULTS[t].type).toBe(t)
      for (const [k, [lo, hi]] of Object.entries(POST_FX_PARAM_CLAMP[t]!)) {
        expect(d[k]!).toBeGreaterThanOrEqual(lo)
        expect(d[k]!).toBeLessThanOrEqual(hi)
      }
    }
    // Colours + blend are non-numeric, deliberately absent from the clamp tables.
    expect('color' in POST_FX_PARAM_CLAMP.color_overlay!).toBe(false)
    expect('from' in POST_FX_PARAM_CLAMP.gradient_overlay!).toBe(false)
    expect('to' in POST_FX_PARAM_CLAMP.gradient_overlay!).toBe(false)
    expect('blend' in POST_FX_PARAM_CLAMP.color_overlay!).toBe(false)
  })

  it('overlayBlendOf keeps a known blend and coerces anything else to normal', () => {
    for (const b of OVERLAY_BLENDS) expect(overlayBlendOf(b)).toBe(b)
    expect(overlayBlendOf('color-dodge')).toBe('normal')
    expect(overlayBlendOf('')).toBe('normal')
    expect(overlayBlendOf(undefined)).toBe('normal')
    expect(overlayBlendOf(42)).toBe('normal')
  })
})

describe('gradientOverlayAxis', () => {
  it('runs horizontally at 0deg and vertically at 90deg, spanning the box', () => {
    const a = gradientOverlayAxis(100, 40, 0)
    expect(a.y0).toBeCloseTo(20); expect(a.y1).toBeCloseTo(20) // flat — horizontal
    expect(a.x0).toBeCloseTo(0); expect(a.x1).toBeCloseTo(100)
    const b = gradientOverlayAxis(100, 40, 90)
    expect(b.x0).toBeCloseTo(50); expect(b.x1).toBeCloseTo(50)  // flat — vertical
    expect(b.y0).toBeCloseTo(0); expect(b.y1).toBeCloseTo(40)
  })
  it('two different angles give different axes (the direction is consumed)', () => {
    const a = gradientOverlayAxis(64, 64, 30)
    const b = gradientOverlayAxis(64, 64, 120)
    expect([a.x0, a.y0, a.x1, a.y1]).not.toEqual([b.x0, b.y0, b.x1, b.y1])
  })
})

describe('passColorOverlay', () => {
  it('clips to the layer alpha (destination-in) and composites at the blend + opacity', () => {
    const { off, scratch } = harness()
    applyPasses(off.canvas, [colour({ blend: 'multiply', opacity: 0.5 })], { W: 100, scale: 1 })
    expect(scratch).toContain('fillRect')             // the flat colour fill
    expect(scratch).toContain('draw:destination-in@100') // clip to the layer's own alpha
    vi.unstubAllGlobals()
  })
  it('composites at the chosen blend, scaled by opacity, onto the offscreen', () => {
    const scratch: string[] = []
    const grad = { ends: [] as number[][], stops: [] as string[] }
    vi.stubGlobal('document', { createElement: () => makeStub(scratch, grad).canvas })
    const offLog: string[] = []
    const off = makeStub(offLog, grad)
    applyPasses(off.canvas, [colour({ blend: 'screen', opacity: 0.5 })], { W: 100, scale: 1 })
    expect(offLog).toContain('draw:screen@50')
    vi.unstubAllGlobals()
  })
  it('coerces an invalid blend to normal (source-over)', () => {
    const scratch: string[] = []
    const grad = { ends: [] as number[][], stops: [] as string[] }
    vi.stubGlobal('document', { createElement: () => makeStub(scratch, grad).canvas })
    const offLog: string[] = []
    const off = makeStub(offLog, grad)
    applyPasses(off.canvas, [colour({ blend: 'nonsense' as any, opacity: 1 })], { W: 100, scale: 1 })
    expect(offLog).toContain('draw:source-over@100')
    vi.unstubAllGlobals()
  })
  it('is a no-op at opacity 0 (nothing composites on the offscreen)', () => {
    const offLog: string[] = []
    const grad = { ends: [] as number[][], stops: [] as string[] }
    vi.stubGlobal('document', { createElement: () => makeStub([], grad).canvas })
    const off = makeStub(offLog, grad)
    applyPasses(off.canvas, [colour({ opacity: 0 })], { W: 100, scale: 1 })
    expect(offLog.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    vi.unstubAllGlobals()
  })
  it('is deterministic across two runs', () => {
    const a: string[] = []; const b: string[] = []
    const g = { ends: [] as number[][], stops: [] as string[] }
    vi.stubGlobal('document', { createElement: () => makeStub([], g).canvas })
    applyPasses(makeStub(a, g).canvas, [colour()], { W: 100, scale: 1 })
    applyPasses(makeStub(b, g).canvas, [colour()], { W: 100, scale: 1 })
    expect(a).toEqual(b)
    vi.unstubAllGlobals()
  })
})

describe('passGradientOverlay', () => {
  it('paints a from→to gradient, clips to the layer alpha, composites at blend + opacity', () => {
    const scratch: string[] = []
    const grad = { ends: [] as number[][], stops: [] as string[] }
    vi.stubGlobal('document', { createElement: () => makeStub(scratch, grad).canvas })
    const offLog: string[] = []
    const off = makeStub(offLog, grad)
    applyPasses(off.canvas, [gradient({ from: '#ff0000', to: '#0000ff', blend: 'overlay', opacity: 0.8 })], { W: 100, scale: 1 })
    expect(grad.stops).toEqual(['#ff0000', '#0000ff']) // both stops consumed, in order
    expect(scratch).toContain('draw:destination-in@100') // clipped to alpha
    expect(offLog).toContain('draw:overlay@80')
    vi.unstubAllGlobals()
  })
  it('the gradient axis follows the angle (two angles differ)', () => {
    const g0 = { ends: [] as number[][], stops: [] as string[] }
    vi.stubGlobal('document', { createElement: () => makeStub([], g0).canvas })
    applyPasses(makeStub([], g0).canvas, [gradient({ angle: 0 })], { W: 100, scale: 1 })
    const g90 = { ends: [] as number[][], stops: [] as string[] }
    vi.stubGlobal('document', { createElement: () => makeStub([], g90).canvas })
    applyPasses(makeStub([], g90).canvas, [gradient({ angle: 90 })], { W: 100, scale: 1 })
    expect(g0.ends[0]).not.toEqual(g90.ends[0])
    vi.unstubAllGlobals()
  })
  it('is a no-op at opacity 0', () => {
    const offLog: string[] = []
    const grad = { ends: [] as number[][], stops: [] as string[] }
    vi.stubGlobal('document', { createElement: () => makeStub([], grad).canvas })
    const off = makeStub(offLog, grad)
    applyPasses(off.canvas, [gradient({ opacity: 0 })], { W: 100, scale: 1 })
    expect(offLog.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    vi.unstubAllGlobals()
  })
  it('is deterministic across two runs', () => {
    const a: string[] = []; const b: string[] = []
    const g = { ends: [] as number[][], stops: [] as string[] }
    vi.stubGlobal('document', { createElement: () => makeStub([], g).canvas })
    applyPasses(makeStub(a, g).canvas, [gradient()], { W: 100, scale: 1 })
    applyPasses(makeStub(b, g).canvas, [gradient()], { W: 100, scale: 1 })
    expect(a).toEqual(b)
    vi.unstubAllGlobals()
  })
})

describe('byte-identity: no overlay leaves the offscreen untouched', () => {
  it('an empty pass list and an invisible overlay both composite nothing', () => {
    const grad = { ends: [] as number[][], stops: [] as string[] }
    vi.stubGlobal('document', { createElement: () => makeStub([], grad).canvas })
    const empty: string[] = []
    applyPasses(makeStub(empty, grad).canvas, [], { W: 100, scale: 1 })
    expect(empty.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    const hidden: string[] = []
    applyPasses(makeStub(hidden, grad).canvas, [colour({ visible: false }), gradient({ visible: false })], { W: 100, scale: 1 })
    expect(hidden.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    vi.unstubAllGlobals()
  })
})
