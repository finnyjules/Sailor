import { describe, it, expect } from 'vitest'
import { RoundSim, simulateRound } from '~/lib/brushTips/round'
import { defaultSettings, REF_W } from '~/lib/brushTips/tips'
import { encodePts, tipStrokePad, type TipStroke, type Sample } from '~/lib/brushTips/record'

const samples = (): Sample[] => Array.from({ length: 50 }, (_, i) => ({ x: 0.1 + i * 0.008, y: 0.5 + Math.sin(i / 6) * 0.03, t: i * 12 }))
const stroke = (): TipStroke => ({ tip: 'round', v: 1, size: 36 / REF_W, settings: defaultSettings('round'), seed: 99, pts: encodePts(samples()) })

describe('RoundSim', () => {
  it('replays identically and matches live feeding', () => {
    const a = Array.from(simulateRound(stroke()).dabs.view())
    const sim = new RoundSim({ size: 36, settings: defaultSettings('round'), seed: 99 })
    for (const s of samples()) sim.addSample(s)
    expect(Array.from(sim.dabs.view())).toEqual(a)
    expect(a.length / 5).toBeGreaterThan(50)
  })
  it('main dabs are evenly spaced at 8% of the size', () => {
    const d = simulateRound(stroke()).dabs.view(), mains: number[][] = []
    for (let i = 0; i < d.length; i += 5) if (d[i + 2] === 18) mains.push([d[i]!, d[i + 1]!])
    for (let i = 2; i < mains.length; i++) {
      const gap = Math.hypot(mains[i]![0]! - mains[i - 1]![0]!, mains[i]![1]! - mains[i - 1]![1]!)
      expect(gap).toBeCloseTo(36 * 0.08, 3)
    }
  })
  it('stays inside the padded bounds', () => {
    const st = stroke(), pad = tipStrokePad(st), d = simulateRound(st).dabs.view()
    const xs = samples().map(p => p.x), ys = samples().map(p => p.y)
    for (let i = 0; i < d.length; i += 5) {
      expect(d[i]! + d[i + 2]!).toBeLessThanOrEqual((Math.max(...xs) + pad.side) * REF_W)
      expect(d[i + 1]! - d[i + 2]!).toBeGreaterThanOrEqual((Math.min(...ys) - pad.up) * REF_W)
    }
  })
})
