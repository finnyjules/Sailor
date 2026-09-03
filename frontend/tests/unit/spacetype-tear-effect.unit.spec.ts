import { describe, it, expect } from 'vitest'
import { tearEffect } from '../../app/lib/spacetype/effects/tear'
import { getEffect, SPACE_TYPE_EFFECTS } from '../../app/lib/spacetype/effects'
import { SPACE_TYPE_SECTIONS } from '../../app/lib/spacetype/sections'

describe('tearEffect contract', () => {
  it('declares id, label, controls', () => {
    expect(tearEffect.id).toBe('tear')
    expect(tearEffect.label).toBe('Tear')
    expect(tearEffect.controls.length).toBeGreaterThan(0)
  })

  it('every control has a default and a unique key', () => {
    const keys = tearEffect.controls.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of tearEffect.controls) expect(c.default).toBeDefined()
  })

  it('exposes the signature controls', () => {
    const keys = tearEffect.controls.map(c => c.key)
    for (const k of ['text', 'font', 'tearAmount', 'tearFreq', 'tearStyle', 'tearDir', 'tearEdge', 'tearOverlap', 'tearPhase', 'speed', 'textColor', 'bgColor', 'scale']) {
      expect(keys).toContain(k)
    }
  })

  it('only uses sections from the allow-list (so no control is silently hidden)', () => {
    const allowed = new Set<string>(SPACE_TYPE_SECTIONS)
    for (const c of tearEffect.controls) expect(allowed.has(String(c.group))).toBe(true)
  })

  it('is registered and resolvable by id', () => {
    expect(SPACE_TYPE_EFFECTS.map(e => e.id)).toContain('tear')
    expect(getEffect('tear').id).toBe(tearEffect.id)
  })
})
