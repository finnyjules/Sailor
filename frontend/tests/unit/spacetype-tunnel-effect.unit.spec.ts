import { describe, it, expect } from 'vitest'
import { tunnelEffect } from '../../app/lib/spacetype/effects/tunnel'
import { getEffect, SPACE_TYPE_EFFECTS } from '../../app/lib/spacetype/effects'

describe('tunnelEffect contract', () => {
  it('declares id, label, controls', () => {
    expect(tunnelEffect.id).toBe('tunnel')
    expect(tunnelEffect.label.length).toBeGreaterThan(0)
    expect(tunnelEffect.controls.length).toBeGreaterThan(0)
  })
  it('every control has a default and a unique key', () => {
    const keys = tunnelEffect.controls.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of tunnelEffect.controls) expect(c.default).toBeDefined()
  })
  it('exposes the signature controls', () => {
    const keys = tunnelEffect.controls.map(c => c.key)
    for (const k of ['text', 'font', 'typeSize', 'layers', 'innerWidth', 'innerHeight', 'rotate', 'view', 'colors', 'speed', 'direction']) {
      expect(keys).toContain(k)
    }
  })
  it('is registered and resolvable by id', () => {
    expect(SPACE_TYPE_EFFECTS.map(e => e.id)).toContain('tunnel')
    expect(getEffect('tunnel').id).toBe(tunnelEffect.id)
  })
})
