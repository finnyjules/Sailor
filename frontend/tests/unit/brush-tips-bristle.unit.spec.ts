import { describe, it, expect } from 'vitest'
import { bristleRibbon, RIBBON_STRIDE } from '~/lib/brushTips/bristle'
import { defaultSettings, REF_W } from '~/lib/brushTips/tips'
import { encodePts, tipStrokePad, type TipStroke } from '~/lib/brushTips/record'

const zig = (): TipStroke => {
  const pts: { x: number; y: number; t: number }[] = []
  const corners = [[0.1, 0.4], [0.25, 0.2], [0.4, 0.4], [0.55, 0.2]]
  let t = 0
  for (let c = 1; c < corners.length; c++) for (let i = 1; i <= 20; i++) {
    const [x0, y0] = corners[c - 1]!, [x1, y1] = corners[c]!
    pts.push({ x: x0! + (x1! - x0!) * i / 20, y: y0! + (y1! - y0!) * i / 20, t: (t += 16) })
  }
  pts.unshift({ x: 0.1, y: 0.4, t: 0 })
  return { tip: 'bristle', v: 1, size: 44 / REF_W, settings: defaultSettings('bristle'), seed: 5, pts: encodePts(pts) }
}

describe('bristleRibbon', () => {
  it('is deterministic and a valid strip', () => {
    const a = bristleRibbon(zig(), true)!, b = bristleRibbon(zig(), true)!
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(a.length % (RIBBON_STRIDE * 2)).toBe(0)
  })
  it('tapers both ends to near zero width when done', () => {
    const d = bristleRibbon(zig(), true)!, n = d.length / RIBBON_STRIDE
    const halfW = (i: number) => Math.hypot(d[i * 7]! - d[(i + 1) * 7]!, d[i * 7 + 1]! - d[(i + 1) * 7 + 1]!) / 2
    expect(halfW(0)).toBeLessThan(44 * 0.1)
    expect(halfW(n - 2)).toBeLessThan(44 * 0.1)
    expect(halfW(Math.floor(n / 2) & ~1)).toBeGreaterThan(44 * 0.3)
  })
  it('stays inside the padded bounds', () => {
    const st = zig(), pad = tipStrokePad(st), d = bristleRibbon(st, true)!
    for (let i = 0; i < d.length; i += 7) {
      expect(d[i]!).toBeGreaterThanOrEqual((0.1 - pad.side) * REF_W)
      expect(d[i + 1]!).toBeLessThanOrEqual((0.4 + pad.down) * REF_W)
    }
  })
})
