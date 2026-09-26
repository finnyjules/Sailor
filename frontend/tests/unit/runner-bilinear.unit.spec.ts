/**
 * R1.4: `bilinearResize` (server/runner/pixels/resize.ts) is torch's
 * F.interpolate(mode='bilinear', align_corners=False) bit for bit, against
 * scripts/runner_values_fixtures.py → fixtures/runner-values.json `bilinear`.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bilinearResize } from '~~/server/runner/pixels/resize'

interface BilinearCase { name: string; sw: number; sh: number; dw: number; dh: number; channels: number; src: string; out: string }
const FX = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-values.json'), 'utf8')) as { bilinear: BilinearCase[] }

const f32 = (s: string) => {
  const b = Buffer.from(s, 'base64')
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
const bytes = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)

describe('bilinearResize (torch F.interpolate, bilinear, align_corners=False)', () => {
  it('has the fixture cases', () => {
    expect(FX.bilinear).toHaveLength(8)
    expect(new Set(FX.bilinear.map(c => c.channels))).toEqual(new Set([1, 4]))
  })

  for (const c of FX.bilinear) {
    it(`equals torch bit for bit: ${c.name}`, () => {
      const src = f32(c.src)
      expect(src.length).toBe(c.sw * c.sh * c.channels)
      const got = bilinearResize(src, c.sw, c.sh, c.channels, c.dw, c.dh)
      expect(got.length).toBe(c.dw * c.dh * c.channels)
      expect(bytes(got).equals(bytes(f32(c.out)))).toBe(true)
    })
  }

  it('the same size gives the same values back', () => {
    const src = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])
    expect([...bilinearResize(src, 3, 2, 1, 3, 2)]).toEqual([...src])
  })

  it('refuses five channels and a wrongly sized picture', () => {
    expect(() => bilinearResize(new Float32Array(5), 1, 1, 5, 2, 2)).toThrow()
    expect(() => bilinearResize(new Float32Array(3), 2, 2, 1, 2, 2)).toThrow()
  })
})
