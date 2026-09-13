import { describe, it, expect, vi } from 'vitest'
import {
  applyPasses, isChainEffect, defaultPostEffect,
  POST_EFFECT_DEFAULTS, POST_FX_PARAM_CLAMP,
  STROKE_ALPHA_ALIGNS, strokeAlphaAlignOf, strokeAlphaBand,
  type StrokeFromAlphaEffect,
} from '~/lib/compositor/postEffects'

/** A canvas stub that records the composite op + alpha of every drawImage on THIS context, plus
 *  fillRect calls. The stroke pass builds the band (and the eroded interior) on scratch canvases
 *  from document.createElement — those all push into a SHARED `scratch` log — and only the FINAL
 *  band composite lands on the offscreen we pass in (its own log), at source-over @100. */
function makeStub(log: string[], w = 8, h = 8) {
  const ctx: any = {
    canvas: null as unknown as HTMLCanvasElement,
    filter: 'none', globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '' as unknown,
    save: () => log.push('save'),
    restore: () => log.push('restore'),
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => log.push(`fillRect:${ctx.globalCompositeOperation}`),
    drawImage: () => log.push(`draw:${ctx.globalCompositeOperation}@${Math.round(ctx.globalAlpha * 100)}`),
    getImageData: () => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => log.push('putImageData'),
    createImageData: (iw: number, ih: number) => ({ data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createPattern: () => ({}),
    scale: () => {},
  }
  const canvas = { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement
  ctx.canvas = canvas
  return { canvas, ctx }
}

/** Install a document whose createElement hands back fresh scratch canvases that all log into
 *  `scratch`. Returns the offscreen (own log) to pass to applyPasses. */
function harness() {
  const scratch: string[] = []
  vi.stubGlobal('document', { createElement: () => makeStub(scratch).canvas })
  const offLog: string[] = []
  const off = makeStub(offLog)
  return { off, offLog, scratch }
}

const stroke = (over: Partial<StrokeFromAlphaEffect> = {}): StrokeFromAlphaEffect =>
  ({ type: 'stroke_from_alpha', width: 0.02, align: 'center', color: '#111111', visible: true, ...over })

describe('stroke_from_alpha registration + coercion', () => {
  it('is a chain effect with its default inside the clamp range', () => {
    expect(isChainEffect(stroke())).toBe(true)
    const d = defaultPostEffect('stroke_from_alpha') as unknown as Record<string, number>
    expect(POST_EFFECT_DEFAULTS.stroke_from_alpha.type).toBe('stroke_from_alpha')
    for (const [k, [lo, hi]] of Object.entries(POST_FX_PARAM_CLAMP.stroke_from_alpha!)) {
      expect(d[k]!).toBeGreaterThanOrEqual(lo)
      expect(d[k]!).toBeLessThanOrEqual(hi)
    }
    // color + align are non-numeric, deliberately absent from the clamp table.
    expect('color' in POST_FX_PARAM_CLAMP.stroke_from_alpha!).toBe(false)
    expect('align' in POST_FX_PARAM_CLAMP.stroke_from_alpha!).toBe(false)
  })

  it('strokeAlphaAlignOf keeps a known align and coerces anything else to centre', () => {
    for (const a of STROKE_ALPHA_ALIGNS) expect(strokeAlphaAlignOf(a)).toBe(a)
    expect(strokeAlphaAlignOf('middle')).toBe('center')
    expect(strokeAlphaAlignOf('')).toBe('center')
    expect(strokeAlphaAlignOf(undefined)).toBe('center')
    expect(strokeAlphaAlignOf(42)).toBe('center')
  })
})

describe('strokeAlphaBand (the align math)', () => {
  it('inside bands wholly WITHIN the alpha: [edge−width, edge]', () => {
    expect(strokeAlphaBand(10, 'inside')).toEqual({ outerPx: 0, innerPx: 10 })
  })
  it('outside bands wholly BEYOND the alpha: [edge, edge+width]', () => {
    expect(strokeAlphaBand(10, 'outside')).toEqual({ outerPx: 10, innerPx: 0 })
  })
  it('centre straddles the edge, half each side: [edge−width/2, edge+width/2]', () => {
    expect(strokeAlphaBand(10, 'center')).toEqual({ outerPx: 5, innerPx: 5 })
  })
  it('clamps a negative / NaN width to zero (no band)', () => {
    expect(strokeAlphaBand(-4, 'outside')).toEqual({ outerPx: 0, innerPx: 0 })
    expect(strokeAlphaBand(NaN, 'center')).toEqual({ outerPx: 0, innerPx: 0 })
  })
})

describe('passStrokeFromAlpha', () => {
  it('recolours a dilated silhouette, knocks out the eroded interior, composites the band', () => {
    const { off, offLog, scratch } = harness()
    applyPasses(off.canvas, [stroke({ width: 0.02, align: 'center', color: '#ff0000' })], { W: 100, scale: 1 })
    // The recolour: a fill under source-in on the band scratch.
    expect(scratch).toContain('fillRect:source-in')
    // The band knockout / erosion: at least one destination-out draw on a scratch.
    expect(scratch.some(l => l.startsWith('draw:destination-out'))).toBe(true)
    // The final composite lands on the offscreen at source-over, full alpha.
    expect(offLog).toContain('draw:source-over@100')
    vi.unstubAllGlobals()
  })

  it('an INSIDE stroke needs no outward dilation but still erodes and composites', () => {
    const { off, offLog, scratch } = harness()
    applyPasses(off.canvas, [stroke({ width: 0.03, align: 'inside' })], { W: 100, scale: 1 })
    expect(scratch).toContain('fillRect:source-in')
    expect(scratch.some(l => l.startsWith('draw:destination-out'))).toBe(true)
    expect(offLog).toContain('draw:source-over@100')
    vi.unstubAllGlobals()
  })

  it('is a no-op at width 0 (nothing composites on the offscreen)', () => {
    const { off, offLog } = harness()
    applyPasses(off.canvas, [stroke({ width: 0 })], { W: 100, scale: 1 })
    expect(offLog.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('an invalid align renders (coerced to centre), not a crash', () => {
    const { off, offLog } = harness()
    applyPasses(off.canvas, [stroke({ align: 'nonsense' as any })], { W: 100, scale: 1 })
    expect(offLog).toContain('draw:source-over@100')
    vi.unstubAllGlobals()
  })

  it('is deterministic across two runs', () => {
    const a: string[] = []
    vi.stubGlobal('document', { createElement: () => makeStub(a).canvas })
    applyPasses(makeStub(a).canvas, [stroke()], { W: 100, scale: 1 })
    const b: string[] = []
    vi.stubGlobal('document', { createElement: () => makeStub(b).canvas })
    applyPasses(makeStub(b).canvas, [stroke()], { W: 100, scale: 1 })
    expect(a).toEqual(b)
    vi.unstubAllGlobals()
  })
})

describe('byte-identity: no stroke leaves the offscreen untouched', () => {
  it('an empty pass list and an invisible stroke both composite nothing', () => {
    vi.stubGlobal('document', { createElement: () => makeStub([]).canvas })
    const empty: string[] = []
    applyPasses(makeStub(empty).canvas, [], { W: 100, scale: 1 })
    expect(empty.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    const hidden: string[] = []
    applyPasses(makeStub(hidden).canvas, [stroke({ visible: false })], { W: 100, scale: 1 })
    expect(hidden.filter(l => l.startsWith('draw:'))).toHaveLength(0)
    vi.unstubAllGlobals()
  })
})
