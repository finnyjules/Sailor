import { describe, it, expect } from 'vitest'
import { fontStack, makeFrameMeasure, capMetrics } from '~/lib/frame/patterns/frameMeasure'

// a fake 2D context: width = chars * 0.5 * fontSizePx (parsed from ctx.font)
function fakeCtx() {
  return {
    font: '',
    measureText(t: string) {
      const m = /(\d+(?:\.\d+)?)px/.exec(this.font)
      const px = m ? parseFloat(m[1]!) : 10
      return { width: t.length * 0.5 * px, actualBoundingBoxAscent: px * 0.7, fontBoundingBoxAscent: px * 0.8, fontBoundingBoxDescent: px * 0.2 } as any
    },
  } as unknown as CanvasRenderingContext2D
}

describe('fontStack', () => {
  it('quotes a multi-word family and appends a generic fallback', () => {
    expect(fontStack('Inter Tight')).toMatch(/"Inter Tight".*sans-serif/)
  })
})

describe('makeFrameMeasure', () => {
  it('returns width at size 100 using the injected ctx', () => {
    const m = makeFrameMeasure('Inter', 700, fakeCtx())
    expect(m('AB')).toBeCloseTo(2 * 0.5 * 100, 5)   // 2 chars * 0.5 * 100px
  })
  it('falls back to length*60 with no ctx', () => {
    const m = makeFrameMeasure('Inter', 700, null)
    expect(m('ABC')).toBe(180)
  })
})

describe('capMetrics', () => {
  it('reads TextMetrics from the ctx', () => {
    const cm = capMetrics('Inter', 700, 100, fakeCtx())
    expect(cm.cap).toBeCloseTo(70, 5)
    expect(cm.ascent).toBeCloseTo(80, 5)
  })
  it('falls back to size-proportional metrics with no ctx', () => {
    const cm = capMetrics('Inter', 700, 100, null)
    expect(cm.cap).toBeCloseTo(72, 5)
  })
})
