import { describe, expect, it } from 'vitest'
import { frameStats, judgeFrames, meanAbsDiff } from '~/lib/shadergen/renderChecks'

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

  it('fails a heavy effect', () => {
    expect(judgeFrames({ ...base, extraMs: 9, a: stripes(), b: stripes(), source: solid(90, 90, 90) })).toEqual({ pass: false, flags: ['heavy'] })
  })
})
