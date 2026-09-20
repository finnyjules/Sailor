import { describe, it, expect } from 'vitest'
import { tunnelLayout, TUNNEL_NEAR_Z } from '~/lib/spacetype/layouts/tunnel'
const P = { tunnelDepth: 20, tunnelSpread: 1.5, cardSize: 1, speed: 1, direction: 'cw' }
describe('tunnel layout', () => {
  it('z stays within [near - depth, near]', () => {
    for (let i = 0; i < 10; i++) for (const t of [0, 0.3, 0.7]) {
      const z = tunnelLayout.place(i, 10, P as any, t).z
      expect(z).toBeLessThanOrEqual(TUNNEL_NEAR_Z + 1e-9); expect(z).toBeGreaterThanOrEqual(TUNNEL_NEAR_Z - 20 - 1e-6)
    }
  })
  it('fades out at both ends, where a card wraps from the near mouth to the far end', () => {
    // card 0 of 10 at t=0 sits exactly on the wrap (frac 0)
    expect(tunnelLayout.place(0, 10, P as any, 0).opacity).toBe(0)
    expect(tunnelLayout.place(3, 10, P as any, 0).opacity).toBeCloseTo(1, 6)   // frac 0.3, mid-run
  })
  it('seam: t01=0 equals t01=1', () => {
    for (let i = 0; i < 6; i++) {
      const a = tunnelLayout.place(i, 6, P as any, 0), b = tunnelLayout.place(i, 6, P as any, 1)
      expect(b.z).toBeCloseTo(a.z, 5); expect(b.x).toBeCloseTo(a.x, 6)
    }
  })
})
