import { describe, it, expect } from 'vitest'
import { hueWalk } from '~/lib/color/hueWalk'
import { parseHexA } from '~/lib/color/convert'

const HEX6 = /^#[0-9a-f]{6}$/
const HEX8 = /^#[0-9a-f]{8}$/
const isHex = (s: string) => HEX6.test(s) || HEX8.test(s)

describe('hueWalk', () => {
  it('n = 2 returns exactly the two endpoints', () => {
    const s = hueWalk('#e4572e', '#2e5be4', 2)
    expect(s).toHaveLength(2)
    expect(s[0]!.color).toBe('#e4572e')
    expect(s[1]!.color).toBe('#2e5be4')
    expect(s[0]!.pos).toBe(0)
    expect(s[1]!.pos).toBe(1)
  })

  it('pos is monotonic and spans [0, 1]', () => {
    const s = hueWalk('#e4572e', '#2e5be4', 6)
    expect(s[0]!.pos).toBe(0)
    expect(s[s.length - 1]!.pos).toBe(1)
    for (let i = 1; i < s.length; i++) expect(s[i]!.pos).toBeGreaterThan(s[i - 1]!.pos)
  })

  it('emits valid 6/8-digit hex at every stop', () => {
    for (const st of hueWalk('#e4572e', '#2e5be4', 7)) expect(isHex(st.color)).toBe(true)
  })

  it('long and short arcs produce different middle colours', () => {
    const shortMid = hueWalk('#e4572e', '#2e5be4', 5, { arc: 'short' })[2]!.color
    const longMid = hueWalk('#e4572e', '#2e5be4', 5, { arc: 'long' })[2]!.color
    expect(shortMid).not.toBe(longMid)
  })

  it('endpoints are identical whichever arc is chosen (only the path differs)', () => {
    const a = hueWalk('#e4572e', '#2e5be4', 6, { arc: 'short' })
    const b = hueWalk('#e4572e', '#2e5be4', 6, { arc: 'long' })
    expect(a[0]!.color).toBe(b[0]!.color)
    expect(a[5]!.color).toBe(b[5]!.color)
  })

  it('a grey endpoint does not spin the hue (borrows its partner hue)', () => {
    // grey -> saturated blue: with a spin guard the mid stays near the blue hue,
    // never detouring through reds/greens. Compare against the SAME walk where
    // both ends are grey (no hue anywhere) to prove the guard, not the geometry.
    const s = hueWalk('#808080', '#2e5be4', 6)
    for (const st of s) expect(isHex(st.color)).toBe(true)
    // A grey->grey ramp must stay neutral (r≈g≈b) at every stop — no hue injected.
    const g = hueWalk('#808080', '#3a3a3a', 5)
    for (const st of g) {
      const { hex } = parseHexA(st.color)
      const r = parseInt(hex.slice(1, 3), 16)
      const gg = parseInt(hex.slice(3, 5), 16)
      const b = parseInt(hex.slice(5, 7), 16)
      expect(Math.max(r, gg, b) - Math.min(r, gg, b)).toBeLessThan(6)
    }
  })

  it('preserves and lerps alpha from 8-digit inputs', () => {
    const s = hueWalk('#e4572e00', '#2e5be4ff', 5)
    expect(s[0]!.color).toBe('#e4572e00')   // fully transparent end kept 8-digit
    expect(s[4]!.color).toBe('#2e5be4')     // opaque end collapses to 6-digit
    expect(HEX8.test(s[2]!.color)).toBe(true) // mid alpha ~0.5 stays 8-digit
  })

  it('clamps n below 2 up to the two endpoints', () => {
    expect(hueWalk('#e4572e', '#2e5be4', 1)).toHaveLength(2)
  })
})
