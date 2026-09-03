import { describe, it, expect } from 'vitest'
import { shutterPose, shutterEffect } from '../../app/lib/spacetype/effects/shutter'
import { getEffect, SPACE_TYPE_EFFECTS } from '../../app/lib/spacetype/effects'
import { defaultsFromControls } from '../../app/lib/spacetype/effect'

describe('shutter effect', () => {
  it('is registered and resolvable by id', () => {
    expect(SPACE_TYPE_EFFECTS.map(e => e.id)).toContain(shutterEffect.id)
    expect(getEffect('shutter').id).toBe(shutterEffect.id)
    expect(getEffect('SHUTTER').id).toBe(shutterEffect.id) // case-insensitive
  })

  it('has a backend-valid id and the speed-line + motion controls', () => {
    expect(/^[a-z0-9]+$/.test(shutterEffect.id)).toBe(true)
    const keys = shutterEffect.controls.map(c => c.key)
    expect(keys).toContain('progress')
    expect(keys).toContain('copies')
    expect(keys).toContain('spacing')
    expect(keys).toContain('stripes')
    expect(keys).toContain('thicknessBottom')
    expect(keys).toContain('thicknessTop')
    expect(keys).toContain('colorMode')
    expect(keys).toContain('fill')
    expect(keys).toContain('rowGap')
    // Scene-sequenced motion controls (same model as Corner Pin).
    for (const k of ['mode', 'scenes', 'variance', 'holdTime', 'transitionTime', 'ease', 'seed']) {
      expect(keys).toContain(k)
    }
  })

  it('defaults build without throwing and progress defaults to a full 1', () => {
    const d = defaultsFromControls(shutterEffect.controls)
    expect(d.progress).toBe(1)
  })

  it('loopRates: static has no motion, loop is one seamless cycle', () => {
    expect(shutterEffect.loopRates?.({ mode: 'static' })).toEqual([])
    expect(shutterEffect.loopRates?.({ mode: 'loop' })).toEqual([1])
  })

  describe('shutterPose', () => {
    it('scene 0 is the Progress pose (clamped, no spread)', () => {
      expect(shutterPose(0, 0.7, 0.6, 7)).toEqual({ amount: 0.7, spread: 1 })
      expect(shutterPose(0, 2, 0.6, 7).amount).toBe(1)   // clamp high
      expect(shutterPose(0, -1, 0.6, 7).amount).toBe(0)  // clamp low
    })
    it('variance 0 collapses every scene to the Progress pose (no motion)', () => {
      for (const sc of [1, 2, 3, 5]) {
        expect(shutterPose(sc, 0.8, 0, 7)).toEqual({ amount: 0.8, spread: 1 })
      }
    })
    it('later scenes deviate, are seed-deterministic, and stay in range', () => {
      const a = shutterPose(2, 0.5, 0.6, 7)
      expect(shutterPose(2, 0.5, 0.6, 7)).toEqual(a)               // deterministic
      expect(shutterPose(2, 0.5, 0.6, 8)).not.toEqual(a)           // seed changes the pose
      expect(a.amount).toBeGreaterThanOrEqual(0)
      expect(a.amount).toBeLessThanOrEqual(1)
      expect(a.spread).toBeGreaterThan(0)
    })
  })
})
