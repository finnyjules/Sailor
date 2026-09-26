// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { useBrushPaint } from '~/composables/useBrushPaint'
import { defaultSettings, REF_W } from '~/lib/brushTips/tips'
import { decodePts } from '~/lib/brushTips/record'

beforeEach(() => localStorage.clear())

describe('useBrushPaint tips', () => {
  it('starts on the spray can with the tuned defaults', () => {
    const b = useBrushPaint()
    expect(b.tip.value).toBe('spray')
    expect(b.tipSettings.round).toEqual(defaultSettings('round'))
    expect(b.tipSize.spray).toBe(110)
  })
  it('falls back to defaults on bad saved JSON', () => {
    localStorage.setItem('sailor.brushTips.v1', '{nope')
    expect(useBrushPaint().tipSettings.bristle).toEqual(defaultSettings('bristle'))
  })
  it('restores saved settings, dropping unknown keys', () => {
    localStorage.setItem('sailor.brushTips.v1', JSON.stringify({ tip: 'round', settings: { round: { grain: 3, bogus: 1 } }, size: { round: 50 } }))
    const b = useBrushPaint()
    expect(b.tip.value).toBe('round')
    expect(b.tipSettings.round).toEqual({ ...defaultSettings('round'), grain: 3 })
    expect(b.tipSize.round).toBe(50)
  })
  it('records a stroke with a settings snapshot', () => {
    const b = useBrushPaint()
    b.tip.value = 'round'
    b.beginTipStroke(0.1, 0.2, 1000)
    b.extendTipStroke(0.15, 0.2, 1016)
    b.holdTipStroke(1050)
    b.tipSettings.round.grain = 1   // after begin: must NOT leak into this stroke
    const s = b.endTipStroke()!
    expect(s.tip).toBe('round')
    expect(s.settings.grain).toBe(2)
    expect(s.size).toBeCloseTo(36 / REF_W)
    expect(decodePts(s.pts)).toEqual([{ x: 0.1, y: 0.2, t: 0 }, { x: 0.15, y: 0.2, t: 16 }, { x: 0.15, y: 0.2, t: 50 }])
    expect(Number.isInteger(s.seed)).toBe(true)
    expect('erase' in s).toBe(false)
  })
})
