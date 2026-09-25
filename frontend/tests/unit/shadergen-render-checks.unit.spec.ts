import { describe, expect, it } from 'vitest'
import { changeMass, frameStats, HARD_FLAGS, judgeFrames, loopsSeamlessly, meanAbsDiff } from '~/lib/shadergen/renderChecks'

const N = 24 * 24
function solid(r: number, g: number, b: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(N * 4)
  for (let i = 0; i < N; i++) px.set([r, g, b, 255], i * 4)
  return px
}
function stripes(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(N * 4)
  for (let i = 0; i < N; i++) { const v = i % 2 ? 220 : 40; px.set([v, v, v, 255], i * 4) }
  return px
}
const base = { generative: false, animated: false, extraMs: 1 }

describe('render checks', () => {
  it('frameStats measures luma mean and spread', () => {
    expect(frameStats(solid(0, 0, 0))).toEqual({ mean: 0, std: 0 })
    const s = frameStats(stripes())
    expect(s.mean).toBeCloseTo(130 / 255, 3)
    expect(s.std).toBeCloseTo(90 / 255, 3)
  })

  it('meanAbsDiff is 0 for equal frames and 1 for black vs white', () => {
    expect(meanAbsDiff(stripes(), stripes())).toBe(0)
    expect(meanAbsDiff(solid(0, 0, 0), solid(255, 255, 255))).toBe(1)
  })

  it('passes a textured frame that changed the source', () => {
    expect(judgeFrames({ ...base, a: stripes(), b: stripes(), source: solid(90, 90, 90) })).toEqual({ pass: true, flags: [] })
  })

  it('fails black, blown-out and flat frames', () => {
    expect(judgeFrames({ ...base, a: solid(2, 2, 2), b: solid(2, 2, 2), source: stripes() }).flags).toContain('black')
    expect(judgeFrames({ ...base, a: solid(254, 254, 254), b: solid(254, 254, 254), source: stripes() }).flags).toContain('blown out')
    const flat = judgeFrames({ ...base, a: solid(120, 120, 120), b: solid(120, 120, 120), source: stripes() })
    expect(flat).toEqual({ pass: false, flags: ['flat'] })
  })

  it('fails an image effect that leaves the image unchanged, but not a generative one', () => {
    expect(judgeFrames({ ...base, a: stripes(), b: stripes(), source: stripes() }).flags).toEqual(['no visible change'])
    expect(judgeFrames({ ...base, generative: true, a: stripes(), b: stripes(), source: stripes() }).pass).toBe(true)
  })

  it('warns, without failing, when an animated effect does not move', () => {
    expect(judgeFrames({ ...base, animated: true, a: stripes(), b: stripes(), source: solid(90, 90, 90) })).toEqual({ pass: true, flags: ['does not move'] })
  })

  describe('seamless loop (full-size frames a tiny step either side of the wrap)', () => {
    // 256×256 frames like the renderer's: a fixed "photo" with thin (≈3 px) bright beams over it.
    const S = 256, L = 4, D = L / 5000
    const photo = new Uint8ClampedArray(S * S * 4)
    for (let i = 0; i < S * S; i++) { const v = 60 + ((i * 2654435761) >>> 24) % 90; photo.set([v, v * 0.9, v * 0.8, 255], i * 4) }
    /** Beams at these x positions (px), each a 1.5 px half-width tent, rows 40..200 only (localized). */
    const beams = (xs: number[], glow = 1) => {
      const px = photo.slice()
      for (let y = 40; y < 200; y++) for (let x = 0; x < S; x++) {
        let k = 0
        for (const bx of xs) k = Math.max(k, 1 - Math.abs(x + 0.5 - bx) / 1.5)
        if (k <= 0) continue
        const i = (y * S + x) * 4
        for (let c = 0; c < 3; c++) px[i + c] = Math.min(255, px[i + c]! + k * glow * 180)
      }
      return px
    }
    const phase = (t: number) => ((t / L) % 1 + 1) % 1
    const TAU = Math.PI * 2
    type Body = (t: number) => Uint8ClampedArray
    const frames = (body: Body) => ({ start: body(0), again: body(0), step: body(D), beforeEnd: body(L - D), beforeEnd2: body(L - 2 * D) })
    const bases = [40, 90, 150, 210]
    /** Loop-correct beams: a fast whole-cycle wobble (≈300 px/s at the wrap) plus a drift that goes round. */
    const looping: Body = t => beams(bases.map(b => b + 25 * Math.sin(TAU * 3 * phase(t)) + 12 * Math.sin(TAU * phase(t))))
    /** "Prism drift": the same fast wobble, and a slow drift that grows with loopPhase() — it teleports back at the wrap. */
    const teleport: Body = t => beams(bases.map(b => b + 25 * Math.sin(TAU * 3 * phase(t)) + 10 * phase(t)))
    const saw: Body = t => beams([256 * phase(t)])
    const raw: Body = t => beams(bases.map(b => b + 7 * t))
    const still: Body = () => beams(bases)

    it('the old image-mean check could not see a thin beam teleport (why this check exists)', () => {
      const f = frames(teleport)
      const step = L / 60 // the old step
      expect(meanAbsDiff(f.start, teleport(L))).toBe(0) // the frame AT the loop's end proves nothing
      expect(meanAbsDiff(teleport(L - step), f.start)).toBeLessThanOrEqual(Math.max(0.01, 3 * meanAbsDiff(f.start, teleport(step))))
    })
    it('fails thin beams that teleport at the wrap', () => {
      expect(loopsSeamlessly(frames(teleport))).toBe(false)
      expect(changeMass(teleport(L - D), teleport(0))).toBeGreaterThan(10 * changeMass(teleport(0), teleport(D)))
    })
    it('passes thin beams that loop in whole cycles, fast motion included', () => {
      expect(loopsSeamlessly(frames(looping))).toBe(true)
      // Not by a whisker: across the wrap it moves like any other step.
      expect(changeMass(looping(L - D), looping(0))).toBeLessThan(1.5 * changeMass(looping(0), looping(D)))
    })
    it('fails a sawtooth (fract of time) and raw growing time', () => {
      expect(loopsSeamlessly(frames(saw))).toBe(false)
      expect(loopsSeamlessly(frames(raw))).toBe(false)
    })
    it('a still effect loops trivially; render noise raises the floor', () => {
      expect(loopsSeamlessly(frames(still))).toBe(true)
      // A jitter the size of the wrap between two renders of the SAME t is noise, not a jump.
      const f = frames(teleport)
      expect(loopsSeamlessly({ ...f, again: f.beforeEnd })).toBe(true)
    })
    it('is part of judgeFrames and a hard flag; no loop frames means no loop check', () => {
      const a = teleport(2), b = teleport(3.37)
      const src = solid(90, 90, 90)
      const s24 = (px: Uint8ClampedArray) => px.slice(0, 24 * 24 * 4)
      expect(judgeFrames({ ...base, animated: true, a: s24(a), b: s24(b), source: src, loop: frames(teleport) }).flags).toContain('does not loop')
      expect(judgeFrames({ ...base, animated: true, a: s24(a), b: s24(b), source: src, loop: frames(looping) }).flags).not.toContain('does not loop')
      expect(judgeFrames({ ...base, animated: true, a: s24(a), b: s24(b), source: src }).flags).not.toContain('does not loop')
      expect(HARD_FLAGS).toContain('does not loop')
    })
  })

  it('fails a heavy effect', () => {
    expect(judgeFrames({ ...base, extraMs: 9, a: stripes(), b: stripes(), source: solid(90, 90, 90) })).toEqual({ pass: false, flags: ['heavy'] })
  })
})
