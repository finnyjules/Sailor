import { describe, it, expect } from 'vitest'
import { SpraySim, simulateSpray } from '~/lib/brushTips/spray'
import { defaultSettings, REF_W } from '~/lib/brushTips/tips'
import { encodePts, tipStrokePad, type TipStroke, type Sample } from '~/lib/brushTips/record'

function path(): Sample[] {
  const out: Sample[] = []
  for (let i = 0; i <= 60; i++) out.push({ x: 0.2 + i * 0.004, y: 0.4 + Math.sin(i / 8) * 0.02, t: i * 16 })
  for (let j = 1; j <= 90; j++) out.push({ x: 0.44, y: 0.4 + Math.sin(60 / 8) * 0.02, t: 960 + j * 16 }) // hold still ~1.4 s
  return out
}
const stroke = (): TipStroke => ({ tip: 'spray', v: 1, size: 110 / REF_W, settings: defaultSettings('spray'), seed: 1234, pts: encodePts(path()) })

describe('SpraySim', () => {
  it('replays identically', () => {
    const a = simulateSpray(stroke()).dabs.view(), b = simulateSpray(stroke()).dabs.view()
    expect(a.length).toBeGreaterThan(1000)
    expect(Array.from(a)).toEqual(Array.from(b))
  })
  it('live feeding at any frame rate equals a one-shot replay', () => {
    const ref = Array.from(simulateSpray(stroke()).dabs.view())
    for (const frameMs of [33, 7]) {
      const st = stroke(), sim = new SpraySim({ size: st.size * REF_W, settings: st.settings, seed: st.seed })
      const samples = path()
      let i = 0
      for (let now = 0; now <= samples[samples.length - 1]!.t + frameMs; now += frameMs) {
        while (i < samples.length && samples[i]!.t <= now) sim.addSample(samples[i++]!)
        sim.advanceTo(now)
      }
      sim.release(); sim.settle()
      expect(Array.from(sim.dabs.view())).toEqual(ref)
    }
  })
  it('a partial drip tail is a prefix of the settled replay', () => {
    const full = Array.from(simulateSpray(stroke()).dabs.view())
    const part = simulateSpray(stroke(), 300)
    expect(part.settled).toBe(false)
    expect(Array.from(part.dabs.view())).toEqual(full.slice(0, part.dabs.view().length))
    expect(part.dabs.view().length).toBeLessThan(full.length)
  })
  it('holding still makes drips that run below the nozzle', () => {
    const d = simulateSpray(stroke()).dabs.view()
    let maxY = -Infinity
    for (let i = 1; i < d.length; i += 5) maxY = Math.max(maxY, d[i]!)
    const nozzleY = (0.4 + Math.sin(60 / 8) * 0.02) * REF_W
    expect(maxY).toBeGreaterThan(nozzleY + 110 * 0.4)
  })
  it('drips 0 makes no drips', () => {
    const st = stroke(); st.settings = { ...st.settings, drips: 0 }
    const d = simulateSpray(st).dabs.view()
    let maxY = -Infinity
    for (let i = 0; i < d.length; i += 5) maxY = Math.max(maxY, d[i + 1]!)   // dab centre y
    expect(maxY).toBeLessThan((0.4 + 0.03) * REF_W + 110 * 0.26 * (1 + 1.1 * 0.2) * 4.5) // path + ~4.5σ of overspray, no drip runs
  })
  it('every dab sits inside the padded bounds', () => {
    const st = stroke(), pad = tipStrokePad(st), d = simulateSpray(st).dabs.view()
    const xs = path().map(p => p.x), ys = path().map(p => p.y)
    const minX = (Math.min(...xs) - pad.side) * REF_W, maxX = (Math.max(...xs) + pad.side) * REF_W
    const minY = (Math.min(...ys) - pad.up) * REF_W, maxY = (Math.max(...ys) + pad.down) * REF_W
    for (let i = 0; i < d.length; i += 5) {
      expect(d[i]! - d[i + 2]!).toBeGreaterThanOrEqual(minX); expect(d[i]! + d[i + 2]!).toBeLessThanOrEqual(maxX)
      expect(d[i + 1]! - d[i + 2]!).toBeGreaterThanOrEqual(minY); expect(d[i + 1]! + d[i + 2]!).toBeLessThanOrEqual(maxY)
    }
  })
})
