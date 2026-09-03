import { describe, it, expect } from 'vitest'
import { sliceGlitchEffect } from '../../app/lib/spacetype/effects/sliceGlitch'
import { getEffect, SPACE_TYPE_EFFECTS } from '../../app/lib/spacetype/effects'

describe('sliceGlitchEffect contract', () => {
  it('declares id, label, controls', () => {
    expect(sliceGlitchEffect.id).toBe('sliceglitch')
    expect(sliceGlitchEffect.label.length).toBeGreaterThan(0)
    expect(sliceGlitchEffect.controls.length).toBeGreaterThan(0)
  })
  it('every control has a default and a unique key', () => {
    const keys = sliceGlitchEffect.controls.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of sliceGlitchEffect.controls) expect(c.default).toBeDefined()
  })
  it('exposes the signature controls', () => {
    const keys = sliceGlitchEffect.controls.map(c => c.key)
    for (const k of ['text', 'font', 'palette', 'revealMode', 'glitchAmount', 'bandShift', 'doodlesOn', 'speed']) {
      expect(keys).toContain(k)
    }
  })
  it('is registered and resolvable by id', () => {
    expect(SPACE_TYPE_EFFECTS.map(e => e.id)).toContain('sliceglitch')
    expect(getEffect('sliceglitch').id).toBe(sliceGlitchEffect.id)
  })
})
