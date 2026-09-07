import { describe, it, expect, vi } from 'vitest'
import { applyPasses, applyEffectChain } from '~/lib/compositor/postEffects'

/** A canvas stub that records the order of operations we can observe. `filter` writes and
 *  `putImageData` calls are enough to tell adjust (a filter draw) from duotone/gradientMap
 *  (putImageData) and from bloom (a 'lighter' composite). */
function stubCanvas(w = 8, h = 8) {
  const log: string[] = []
  const data = new Uint8ClampedArray(w * h * 4).fill(128)
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
    getImageData: () => ({ data, width: w, height: h }),
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

const adjust = (over = {}) => ({ type: 'adjust', brightness: 1.5, contrast: 1, saturation: 1, hue: 0, visible: true, ...over })
const duotone = (over = {}) => ({ type: 'duotone', shadows: '#000000', highlights: '#ffffff', mix: 1, visible: true, ...over })
const grain = (over = {}) => ({ type: 'grain', amount: 0.5, size: 2, visible: true, ...over })

describe('applyPasses', () => {
  it('applies in array order, not canonical order', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const a = stubCanvas()
    applyPasses(a.canvas, [duotone(), adjust()], { W: 100, scale: 1 })
    const b = stubCanvas()
    applyPasses(b.canvas, [adjust(), duotone()], { W: 100, scale: 1 })
    // adjust draws through `filter`; duotone writes pixels back. The two orders therefore
    // produce different operation sequences.
    expect(a.log.indexOf('putImageData')).toBeLessThan(a.log.lastIndexOf('draw:source-over'))
    expect(b.log.indexOf('putImageData')).toBeGreaterThan(b.log.indexOf('draw:source-over'))
    vi.unstubAllGlobals()
  })
  it('applies the same kind more than once', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const { canvas, log } = stubCanvas()
    applyPasses(canvas, [duotone(), duotone()], { W: 100, scale: 1 })
    expect(log.filter(l => l === 'putImageData')).toHaveLength(2)
    vi.unstubAllGlobals()
  })
  it('skips invisible entries and kinds it does not own', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const { canvas, log } = stubCanvas()
    applyPasses(canvas, [
      duotone({ visible: false }),
      { type: 'torn_edge', visible: true } as any,
      { type: 'drop_shadow', visible: true } as any,
    ], { W: 100, scale: 1 })
    expect(log.filter(l => l === 'putImageData')).toHaveLength(0)
    vi.unstubAllGlobals()
  })
  it('does nothing for an empty list', () => {
    const { canvas, log } = stubCanvas()
    applyPasses(canvas, [], { W: 100, scale: 1 })
    expect(log).toEqual([])
  })
})

describe('applyEffectChain keeps canonical order regardless of array order', () => {
  it('runs adjust before grain even when grain is listed first', () => {
    vi.stubGlobal('document', { createElement: () => stubCanvas().canvas })
    const { canvas, log } = stubCanvas()
    applyEffectChain(canvas, [grain(), adjust()] as any, { W: 100, scale: 1 })
    // adjust's filtered draw (source-over) must precede grain's 'overlay' composite
    expect(log.indexOf('draw:source-over')).toBeLessThan(log.indexOf('draw:overlay'))
    vi.unstubAllGlobals()
  })
})
