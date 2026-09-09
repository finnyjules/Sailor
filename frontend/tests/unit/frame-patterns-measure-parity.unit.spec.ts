import { describe, it, expect } from 'vitest'
import { fontStack, titleMeasureFrom, makeFrameMeasure } from '~/lib/frame/patterns/frameMeasure'
import { cssFontStack } from '~/composables/useCompositorLayers'

function fakeCtx() {
  return { font: '', measureText(t: string) { const m = /(\d+(?:\.\d+)?)px/.exec(this.font); const px = m ? parseFloat(m[1]!) : 10; return { width: t.length * 0.5 * px } as any } } as unknown as CanvasRenderingContext2D
}

describe('measure parity', () => {
  it('fontStack is the renderer stack, not a private variant', () => {
    expect(fontStack('Inter Tight')).toBe(cssFontStack('Inter Tight'))
  })
  it('titleMeasureFrom prefers axes.wght over fontWeight and applies textTransform', () => {
    const m = titleMeasureFrom({ fontFamily: 'Inter', fontWeight: 400, axes: { wght: 812.4 }, textTransform: 'uppercase' })
    expect(m.family).toBe('Inter')
    expect(m.weight).toBe(812)
    expect(m.transform('noise')).toBe('NOISE')
  })
  it('falls back to fontWeight and identity transform', () => {
    const m = titleMeasureFrom({ fontFamily: 'Inter', fontWeight: 700 })
    expect(m.weight).toBe(700)
    expect(m.transform('Noise')).toBe('Noise')
  })
  it('makeFrameMeasure measures the transformed string', () => {
    const upper = (t: string) => t.toUpperCase()
    const m = makeFrameMeasure('Inter', 700, fakeCtx(), upper)
    // width depends on length only in the fake, so prove the transform is applied via a capturing ctx
    const seen: string[] = []
    const ctx = { font: '', measureText(t: string) { seen.push(t); return { width: 1 } as any } } as unknown as CanvasRenderingContext2D
    makeFrameMeasure('Inter', 700, ctx, upper)('ab')
    expect(seen).toEqual(['AB'])
    expect(m('ab')).toBeGreaterThan(0)
  })
})
