import { describe, it, expect } from 'vitest'
import { turntableEffect } from '../../app/lib/spacetype/effects/turntable'
import { getEffect, SPACE_TYPE_EFFECTS } from '../../app/lib/spacetype/effects'
import { SPACE_TYPE_SECTIONS } from '../../app/lib/spacetype/sections'

describe('turntableEffect contract', () => {
  it('declares id, label, controls', () => {
    expect(turntableEffect.id).toBe('turntable')
    expect(turntableEffect.label).toBe('Turntable')
    expect(turntableEffect.controls.length).toBeGreaterThan(0)
  })

  it('every control has a default and a unique key', () => {
    const keys = turntableEffect.controls.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of turntableEffect.controls) expect(c.default).toBeDefined()
  })

  it('exposes the signature controls', () => {
    const keys = turntableEffect.controls.map(c => c.key)
    for (const k of ['text', 'font', 'radius', 'ttRings', 'ttCols', 'ttRows', 'speed', 'ttGradient', 'ttTwist', 'direction', 'fills', 'scale']) {
      expect(keys).toContain(k)
    }
  })

  it('only uses sections from the allow-list (so no control is silently hidden)', () => {
    const allowed = new Set<string>(SPACE_TYPE_SECTIONS)
    for (const c of turntableEffect.controls) expect(allowed.has(String(c.group))).toBe(true)
  })

  it('is registered and resolvable by id', () => {
    expect(SPACE_TYPE_EFFECTS.map(e => e.id)).toContain('turntable')
    expect(getEffect('turntable').id).toBe(turntableEffect.id)
  })
})
