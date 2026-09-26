import { describe, it, expect } from 'vitest'
import { SpraySim, simulateSpray, LiveSpray } from '~/lib/brushTips/spray'
import { replayStroke } from '~/lib/brushTips/replay'
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
  const extremes = (fn: (st: TipStroke, box: { minX: number; maxX: number; minY: number; maxY: number }, d: Float32Array, size: number) => void, extra: Record<string, number>) => {
    for (const seed of [1, 2, 3, 4, 5, 6]) for (const size of [4, 40, 320]) for (const over of [{ drips: 2, overspray: 0 }, { drips: 2, overspray: 2 }, { drips: 0.3, overspray: 2 }]) {
      const st: TipStroke = { ...stroke(), seed, size: size / REF_W, settings: { ...defaultSettings('spray'), ...over, ...extra } }
      const pad = tipStrokePad(st)
      const xs = path().map(p => p.x), ys = path().map(p => p.y)
      fn(st, { minX: (Math.min(...xs) - pad.side) * REF_W, maxX: (Math.max(...xs) + pad.side) * REF_W, minY: (Math.min(...ys) - pad.up) * REF_W, maxY: (Math.max(...ys) + pad.down) * REF_W }, simulateSpray(st).dabs.view(), size)
    }
  }
  it('mist and drips stay inside the padded bounds at the extremes (hard bound)', () => {
    // No specks: what is left (mist, drips) is bounded exactly by the pad (drips from their physics).
    extremes((_st, b, d) => {
      for (let i = 0; i < d.length; i += 5) {
        expect(d[i]! - d[i + 2]!).toBeGreaterThanOrEqual(b.minX); expect(d[i]! + d[i + 2]!).toBeLessThanOrEqual(b.maxX)
        expect(d[i + 1]! - d[i + 2]!).toBeGreaterThanOrEqual(b.minY); expect(d[i + 1]! + d[i + 2]!).toBeLessThanOrEqual(b.maxY)
      }
    }, { speckle: 0 })
  })
  it('specks reach at most a stray one past the 4σ pad', () => {
    // Gaussian specks have no hard edge: of the tens of thousands sprayed here, at most a lone
    // speck or two may land past the 4σ reach.
    extremes((_st, b, d, size) => {
      let stray = 0
      for (let i = 0; i < d.length; i += 5) {
        if (d[i]! - d[i + 2]! < b.minX || d[i]! + d[i + 2]! > b.maxX || d[i + 1]! - d[i + 2]! < b.minY || d[i + 1]! + d[i + 2]! > b.maxY) {
          stray++
          expect(d[i + 2]!).toBeLessThanOrEqual(Math.max(1, size / 140))   // a speck, not a mist dab or drip
        }
      }
      expect(stray).toBeLessThanOrEqual(Math.max(2, d.length / 5 * 1e-4))
    }, {})
  })
  it('size 0 cannot hang the simulation', () => {
    const st: TipStroke = { ...stroke(), size: 0 }
    expect(simulateSpray(st).dabs.count).toBeGreaterThan(0)
  })
})

describe('LiveSpray (the live stroke\'s one incremental sim)', () => {
  // Samples arrive a few per frame, as useBrushPaint appends them to the record's pts in place.
  // Every 400 ms (where a 1/120 s step lands exactly on a whole ms) a second sample with the
  // SAME rounded t arrives one frame late, like a coalesced pointer event: the live sim must
  // not have stepped past that time on the first sample alone.
  function feed(frameMs: number, tailMs: number) {
    const samples: (Sample & { late?: boolean })[] = []
    for (const p of path()) { samples.push(p); if (p.t % 400 === 0) samples.push({ x: p.x + 0.004, y: p.y - 0.003, t: p.t, late: true }) }
    const st: TipStroke = { ...stroke(), pts: [] }
    const live = new LiveSpray(st)
    let i = 0
    const end = samples[samples.length - 1]!.t
    for (let now = 0; now <= end + 2 * frameMs; now += frameMs) {
      while (i < samples.length && samples[i]!.t <= now - (samples[i]!.late ? frameMs : 0)) st.pts.push(...encodePts([samples[i++]!]))
      live.sync(0)
    }
    for (let tail = frameMs; tail < tailMs; tail += frameMs) live.sync(tail)
    live.sync(tailMs)
    const ref = simulateSpray({ ...st, pts: st.pts.slice() }, tailMs)
    return { live, ref }
  }
  it('matches simulateSpray(s, tail) for the same tail, at any frame rate', () => {
    for (const frameMs of [7, 16, 33]) for (const tail of [1, 250, 900, 2000]) {
      const { live, ref } = feed(frameMs, tail)
      expect(Array.from(live.sim.dabs.view())).toEqual(Array.from(ref.dabs.view()))
      expect(live.sim.settled).toBe(ref.settled)
    }
  })
  it('replayStroke reads the same live sim, and the committed replay continues it', () => {
    const st = stroke()
    const a = replayStroke(st, false, 300)
    const b = replayStroke(st, false, 300)   // same tail: no further steps
    expect(b.dabs).toEqual(a.dabs)
    const ref = simulateSpray(st, 300)
    expect(Array.from((a as { dabs: Float32Array }).dabs)).toEqual(Array.from(ref.dabs.view()))
    const done = replayStroke(st) as { dabs: Float32Array }
    expect(Array.from(done.dabs.slice(0, ref.dabs.view().length))).toEqual(Array.from(ref.dabs.view()))
  })
})
