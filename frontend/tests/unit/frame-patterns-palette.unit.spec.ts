import { describe, it, expect } from 'vitest'
import { contrastRatio, autoInk, roleToPaint, rolesFromFamily } from '~/lib/frame/patterns/palette'

describe('contrastRatio', () => {
  it('is ~21 for black on white and 1 for equal colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5)
  })
})

describe('autoInk', () => {
  it('rescues a clashing field by picking a high-contrast ink (>= 4.5)', () => {
    // vivid purple field; candidates include a low-contrast magenta
    const r = autoInk('#6d1fb0', ['#b0308a', '#3a2f8f'])
    expect(r.ratio).toBeGreaterThanOrEqual(4.5)      // white/black fallback guarantees it
  })
  it('always beats a naive mid-tone pick', () => {
    const naive = contrastRatio('#6d1fb0', '#b0308a')
    expect(autoInk('#6d1fb0', ['#b0308a']).ratio).toBeGreaterThan(naive)
  })
  it('guarantees >= 4.5:1 even on a stubborn mid-grey field', () => {
    expect(autoInk('#787878', []).ratio).toBeGreaterThanOrEqual(4.5)
  })
})

describe('rolesFromFamily', () => {
  it('picks a field, a contrasting ink, and a distinct accent', () => {
    const roles = rolesFromFamily({ hexes: ['#f2f0ef', '#121212', '#dd2200', '#3a2f8f'] })
    expect(contrastRatio(roles.field, roles.ink)).toBeGreaterThanOrEqual(4.5)
    expect(roles.accent).not.toBe(roles.field)
    expect(roles.accent).not.toBe(roles.ink)
  })
  it('roleToPaint maps a role to its hex', () => {
    const p = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
    expect(roleToPaint('ink', p)).toBe('#121212')
    expect(roleToPaint('accent', p)).toBe('#dd2200')
    expect(roleToPaint('field', p)).toBe('#f2f0ef')
  })
})
