import { describe, it, expect } from 'vitest'
import { spiralEffect } from '../../app/lib/spacetype/effects/spiral'
import { getEffect, SPACE_TYPE_EFFECTS } from '../../app/lib/spacetype/effects'

describe('spiralEffect contract', () => {
  it('declares id, label, controls', () => {
    expect(spiralEffect.id).toBe('spiral')
    expect(spiralEffect.label.length).toBeGreaterThan(0)
    expect(spiralEffect.controls.length).toBeGreaterThan(0)
  })
  it('every control has a default and a unique key', () => {
    const keys = spiralEffect.controls.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of spiralEffect.controls) expect(c.default).toBeDefined()
  })
  it('exposes the signature controls', () => {
    const keys = spiralEffect.controls.map(c => c.key)
    for (const k of ['text', 'font', 'radius', 'turns', 'coilPitch', 'ribbonHeight', 'fills', 'gradRepeats', 'speed', 'spinDir', 'bandColor', 'spacingTop', 'spacingMid', 'spacingBottom', 'reverse', 'scale', 'rotateX']) {
      expect(keys).toContain(k)
    }
  })
  it('groups controls under the reserved Spiral section', () => {
    const groups = new Set(spiralEffect.controls.map(c => c.group))
    expect(groups.has('Spiral')).toBe(true)
  })
  it('is registered and resolvable by id', () => {
    expect(SPACE_TYPE_EFFECTS.map(e => e.id)).toContain('spiral')
    expect(getEffect('spiral').id).toBe(spiralEffect.id)
  })
})
