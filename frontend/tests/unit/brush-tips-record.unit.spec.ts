import { describe, it, expect } from 'vitest'
import { TIPS, TIP_IDS, defaultSettings, REF_W } from '~/lib/brushTips/tips'
import { makeRng } from '~/lib/brushTips/random'
import { encodePts, decodePts, isTipStroke, tipStrokePad, type TipStroke } from '~/lib/brushTips/record'
import { DabBuffer } from '~/lib/brushTips/dabs'

describe('brush tips catalogue', () => {
  it('has the three tips with the tuned defaults', () => {
    expect(TIP_IDS).toEqual(['spray', 'round', 'bristle'])
    expect(defaultSettings('spray')).toEqual({ speckle: 0.25, overspray: 0.2, drips: 1.75, build: 2, relief: 0 })
    expect(defaultSettings('round')).toEqual({ softness: 2, overspray: 2, grain: 2, smoothing: 2, relief: 0.05 })
    expect(defaultSettings('bristle')).toEqual({ thin: 0.15, taper: 0.2, dry: 0.65, load: 0, bristle: 0.5, relief: 0.35, smoothing: 0.6 })
    expect(TIPS.round.settings.every(s => s.max === 4)).toBe(true)
    expect(TIPS.spray.settings.every(s => s.max === 2)).toBe(true)
    expect(REF_W).toBe(1080)
  })
  it('defaultSettings returns a fresh copy', () => {
    const a = defaultSettings('spray'); a.speckle = 9
    expect(defaultSettings('spray').speckle).toBe(0.25)
  })
})

describe('seeded rng', () => {
  it('is repeatable per seed and differs across seeds', () => {
    const a = makeRng(42), b = makeRng(42), c = makeRng(43)
    const sa = [a.next(), a.next(), a.gauss()[0]], sb = [b.next(), b.next(), b.gauss()[0]]
    expect(sa).toEqual(sb)
    expect(c.next()).not.toBe(sa[0])
  })
  it('gauss has roughly unit spread', () => {
    const r = makeRng(7); let s = 0, s2 = 0; const n = 4000
    for (let i = 0; i < n; i++) { const g = r.gauss()[0]; s += g; s2 += g * g }
    expect(Math.abs(s / n)).toBeLessThan(0.08)
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.1)
  })
})

describe('stroke record', () => {
  it('round-trips samples with rounding', () => {
    const samples = [{ x: 0.123456789, y: 0.5, t: 0 }, { x: 0.2, y: 0.51234567, t: 16.6 }]
    const pts = encodePts(samples)
    expect(pts).toEqual([0.12346, 0.5, 0, 0.2, 0.51235, 17])
    expect(decodePts(pts)).toEqual([{ x: 0.12346, y: 0.5, t: 0 }, { x: 0.2, y: 0.51235, t: 17 }])
  })
  it('tells tip strokes from legacy strokes', () => {
    const tip: TipStroke = { tip: 'spray', v: 1, size: 0.1, settings: defaultSettings('spray'), seed: 1, pts: [0, 0, 0] }
    expect(isTipStroke(tip)).toBe(true)
    expect(isTipStroke({ points: [], radius: 0.01, hardness: 1, opacity: 1, erase: false })).toBe(false)
  })
  it('pads spray more downward (drips) than upward', () => {
    const tip: TipStroke = { tip: 'spray', v: 1, size: 0.1, settings: defaultSettings('spray'), seed: 1, pts: [0.5, 0.5, 0] }
    const p = tipStrokePad(tip)
    expect(p.down).toBeGreaterThan(p.up)
    expect(p.up).toBeGreaterThan(0.05)
  })
})

describe('DabBuffer', () => {
  it('stores 5 floats per dab and grows', () => {
    const d = new DabBuffer(2)
    for (let i = 0; i < 10; i++) d.push(i, i, 1, 0.5, 1)
    expect(d.count).toBe(10)
    expect(Array.from(d.view().slice(45, 50))).toEqual([9, 9, 1, 0.5, 1])
  })
})
