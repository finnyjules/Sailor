import { describe, it, expect, vi } from 'vitest'
import {
  applyPasses, isChainEffect, defaultPostEffect,
  POST_EFFECT_DEFAULTS, POST_FX_PARAM_CLAMP,
  type OuterGlowEffect, type InnerGlowEffect,
} from '~/lib/compositor/postEffects'

/** A canvas stub that records the composite op of every drawImage on THIS context. The glow
 *  passes build their halo on scratch canvases (fresh stubs from document.createElement) and
 *  only the FINAL composite lands on the offscreen we pass in, so the ops logged here are the
 *  glow's own composite: 'destination-over' (outer, behind) / 'source-atop' (inner, clipped). */
function stubCanvas(w = 8, h = 8) {
  const log: string[] = []
  const ctx = {
    canvas: null as unknown as HTMLCanvasElement,
    filter: 'none',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '' as unknown,
    save: () => log.push('save'),
    restore: () => log.push('restore'),
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => log.push('fillRect'),
    drawImage: () => log.push(`draw:${(ctx as any).globalCompositeOperation}`),
    getImageData: () => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => log.push('putImageData'),
    createImageData: (iw: number, ih: number) => ({ data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createPattern: () => ({}),
    scale: () => {},
  }
  const canvas = { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement
  ;(ctx as any).canvas = canvas
  return { canvas, ctx, log }
}

const outer = (over: Partial<OuterGlowEffect> = {}): OuterGlowEffect =>
  ({ type: 'outer_glow', color: '#ffd9a0', radius: 0.02, intensity: 0.8, visible: true, ...over })
const inner = (over: Partial<InnerGlowEffect> = {}): InnerGlowEffect =>
  ({ type: 'inner_glow', color: '#ffd9a0', radius: 0.02, intensity: 0.8, visible: true, ...over })

describe('glow chain/clamp registration', () => {
  it('both kinds are chain effects with defaults inside their clamp ranges', () => {
    expect(isChainEffect(outer())).toBe(true)
    expect(isChainEffect(inner())).toBe(true)
    for (const t of ['outer_glow', 'inner_glow'] as const) {
      const d = defaultPostEffect(t) as unknown as Record<string, number>
      expect(POST_EFFECT_DEFAULTS[t].type).toBe(t)
      for (const [k, [lo, hi]] of Object.entries(POST_FX_PARAM_CLAMP[t]!)) {
        expect(d[k]!).toBeGreaterThanOrEqual(lo)
        expect(d[k]!).toBeLessThanOrEqual(hi)
      }
    }
    // color is a non-numeric param, deliberately absent from the clamp table.
    expect('color' in POST_FX_PARAM_CLAMP.outer_glow!).toBe(false)
  })
})

describe('passOuterGlow', () => {
  it('composites the halo BEHIND the layer (destination-over)', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const { canvas, log } = stubCanvas()
    applyPasses(canvas, [outer()], { W: 100, scale: 1 })
    expect(log).toContain('draw:destination-over')
    vi.unstubAllGlobals()
  })
  it('is a no-op at intensity 0 or radius 0 (no composite on the offscreen)', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const a = stubCanvas()
    applyPasses(a.canvas, [outer({ intensity: 0 })], { W: 100, scale: 1 })
    expect(a.log.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    const b = stubCanvas()
    applyPasses(b.canvas, [outer({ radius: 0 })], { W: 100, scale: 1 })
    expect(b.log.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    vi.unstubAllGlobals()
  })
  it('is deterministic — identical op sequence across two runs', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const a = stubCanvas(); applyPasses(a.canvas, [outer()], { W: 100, scale: 1 })
    const b = stubCanvas(); applyPasses(b.canvas, [outer()], { W: 100, scale: 1 })
    expect(a.log).toEqual(b.log)
    vi.unstubAllGlobals()
  })
})

describe('passInnerGlow', () => {
  it('clips the halo to the layer alpha (source-atop)', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const { canvas, log } = stubCanvas()
    applyPasses(canvas, [inner()], { W: 100, scale: 1 })
    expect(log).toContain('draw:source-atop')
    // never composites behind — inner glow stays within the silhouette.
    expect(log).not.toContain('draw:destination-over')
    vi.unstubAllGlobals()
  })
  it('is a no-op at intensity 0 or radius 0', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const a = stubCanvas()
    applyPasses(a.canvas, [inner({ intensity: 0 })], { W: 100, scale: 1 })
    expect(a.log.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    const b = stubCanvas()
    applyPasses(b.canvas, [inner({ radius: 0 })], { W: 100, scale: 1 })
    expect(b.log.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    vi.unstubAllGlobals()
  })
  it('is deterministic across two runs', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const a = stubCanvas(); applyPasses(a.canvas, [inner()], { W: 100, scale: 1 })
    const b = stubCanvas(); applyPasses(b.canvas, [inner()], { W: 100, scale: 1 })
    expect(a.log).toEqual(b.log)
    vi.unstubAllGlobals()
  })
})
