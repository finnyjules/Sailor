import { describe, it, expect } from 'vitest'
import { ballEffect } from '../../app/lib/spacetype/effects/ball'
import { getEffect, SPACE_TYPE_EFFECTS } from '../../app/lib/spacetype/effects'
import { SPACE_TYPE_SECTIONS } from '../../app/lib/spacetype/sections'

describe('ballEffect contract', () => {
  it('declares id, label, controls', () => {
    expect(ballEffect.id).toBe('ball')
    expect(ballEffect.label).toBe('Ball')
    expect(ballEffect.controls.length).toBeGreaterThan(0)
  })

  it('every control has a default and a unique key', () => {
    const keys = ballEffect.controls.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of ballEffect.controls) expect(c.default).toBeDefined()
  })

  it('exposes the signature controls', () => {
    const keys = ballEffect.controls.map(c => c.key)
    for (const k of ['text', 'font', 'radius', 'segments', 'panelMode', 'around', 'rows', 'axisTilt', 'spinSpeed', 'fills', 'shading', 'scale', 'rotateX']) {
      expect(keys).toContain(k)
    }
  })

  it('only uses sections from the allow-list (so no control is silently hidden)', () => {
    const allowed = new Set<string>(SPACE_TYPE_SECTIONS)
    for (const c of ballEffect.controls) expect(allowed.has(String(c.group))).toBe(true)
  })

  it('is registered and resolvable by id', () => {
    expect(SPACE_TYPE_EFFECTS.map(e => e.id)).toContain('ball')
    expect(getEffect('ball').id).toBe(ballEffect.id)
  })
})
