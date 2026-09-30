import { describe, it, expect } from 'vitest'
import { depthToFloat, bilateralSmooth, jointUpsample, toGlRows, buildDepthField } from '~/lib/relight/depthField'

const rgba = (w: number, h: number, f: (x: number, y: number) => number) => {
  const a = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = f(x, y); const i = (y * w + x) * 4; a[i] = v; a[i + 1] = v; a[i + 2] = v; a[i + 3] = 255 }
  return a
}

describe('relight depth field', () => {
  it('reads the red channel as 0..1, top row first', () => {
    const d = depthToFloat(rgba(2, 2, (x, y) => (y === 0 ? 255 : 0)), 2, 2)
    expect([...d]).toEqual([1, 1, 0, 0])
  })

  it('melts 8-bit steps on a gentle ramp into a smooth slope', () => {
    // A ramp that rises one 8-bit level every 8 px: raw neighbours differ by 0 or 1/255 (stripes).
    const w = 64, h = 8
    const raw = depthToFloat(rgba(w, h, x => 100 + Math.floor(x / 8)), w, h)
    const s = bilateralSmooth(raw, w, h, 5, 0.035)
    const steps = new Set<number>()
    for (let x = 8; x < w - 9; x++) steps.add(Math.round((s[4 * w + x + 1]! - s[4 * w + x]!) * 1e5))
    expect(steps.size).toBeGreaterThan(3)      // many different small slopes, not just 0 and one jump
    expect(Math.max(...steps)).toBeLessThan(Math.round(1e5 / 255))
  })

  it('keeps a real depth edge sharp (no halo)', () => {
    const w = 32, h = 4
    const raw = depthToFloat(rgba(w, h, x => (x < 16 ? 40 : 220)), w, h)
    const s = bilateralSmooth(raw, w, h, 4, 0.035)
    expect(s[2 * w + 13]!).toBeCloseTo(40 / 255, 2)
    expect(s[2 * w + 18]!).toBeCloseTo(220 / 255, 2)
  })

  it('pulls the upsampled edge toward the photo edge, off the coarse grid', () => {
    // Coarse depth 8 wide: edge between texels 3 and 4 (u=0.5). Photo 32 wide: edge at x=18 (u=0.5625).
    // Pixel 16 lies between the two edges: the photo is still dark (far) there.
    const depth = depthToFloat(rgba(8, 2, x => (x < 4 ? 30 : 220)), 8, 2)
    const photo = rgba(32, 8, x => (x < 18 ? 20 : 240))
    const flat = rgba(32, 8, () => 128)            // a uniform guide = plain smoothing, no photo edge
    const joint = jointUpsample(depth, 8, 2, photo, 32, 8)
    const plain = jointUpsample(depth, 8, 2, flat, 32, 8)
    const row = 4 * 32
    // Worked by hand: plain ≈ 0.51 at pixel 16, joint ≈ 0.28 (bright-side taps drop out).
    expect(joint[row + 16]!).toBeLessThan(plain[row + 16]! - 0.15)
    expect(joint[row + 20]!).toBeGreaterThan(0.7)   // past the photo edge: near
  })

  it('flips rows into GL order', () => {
    expect([...toGlRows(new Float32Array([1, 2, 3, 4, 5, 6]), 2, 3)]).toEqual([5, 6, 3, 4, 1, 2])
  })

  it('builds a field at the guide size, in GL order', () => {
    const f = buildDepthField(rgba(4, 4, (_, y) => (y < 2 ? 255 : 0)), 4, 4, rgba(8, 8, (_, y) => (y < 4 ? 255 : 0)), 8, 8)
    expect(f).toMatchObject({ kind: 'float', width: 8, height: 8 })
    expect(f.data[0]!).toBeLessThan(0.2)            // GL row 0 = the image's bottom = far
    expect(f.data[7 * 8]!).toBeGreaterThan(0.8)     // GL last row = the image's top = near
  })
})
