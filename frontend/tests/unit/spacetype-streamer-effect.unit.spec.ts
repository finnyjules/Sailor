import { describe, it, expect } from 'vitest'
import { streamerEffect } from '../../app/lib/spacetype/effects/streamer'
import { getEffect, SPACE_TYPE_EFFECTS } from '../../app/lib/spacetype/effects'

describe('streamerEffect contract', () => {
  it('declares id, label, controls', () => {
    expect(streamerEffect.id).toBe('streamer')
    expect(streamerEffect.label.length).toBeGreaterThan(0)
    expect(streamerEffect.controls.length).toBeGreaterThan(0)
  })
  it('every control has a default and a unique key', () => {
    const keys = streamerEffect.controls.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of streamerEffect.controls) expect(c.default).toBeDefined()
  })
  it('exposes the signature controls', () => {
    const keys = streamerEffect.controls.map(c => c.key)
    for (const k of ['text', 'font', 'segmentSpace', 'straightLength', 'ribbonHeight', 'rows', 'count', 'arcRadius', 'speed', 'fills', 'scale', 'rotateX']) {
      expect(keys).toContain(k)
    }
  })
  it('is registered and resolvable by id', () => {
    expect(SPACE_TYPE_EFFECTS.map(e => e.id)).toContain('streamer')
    expect(getEffect('streamer').id).toBe(streamerEffect.id)
  })
})
