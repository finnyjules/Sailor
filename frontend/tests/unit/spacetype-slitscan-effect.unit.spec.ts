import { describe, it, expect } from 'vitest'
import { slitScanEffect } from '../../app/lib/spacetype/effects/slitScan'
import { getEffect, SPACE_TYPE_EFFECTS } from '../../app/lib/spacetype/effects'
import { SPACE_TYPE_SECTIONS } from '../../app/lib/spacetype/sections'

describe('slitScanEffect contract', () => {
  it('declares id, label, controls', () => {
    expect(slitScanEffect.id).toBe('slitscan')
    expect(slitScanEffect.label).toBe('Slit Scan')
    expect(slitScanEffect.controls.length).toBeGreaterThan(0)
  })

  it('every control has a default and a unique key', () => {
    const keys = slitScanEffect.controls.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of slitScanEffect.controls) expect(c.default).toBeDefined()
  })

  it('exposes the signature controls', () => {
    const keys = slitScanEffect.controls.map(c => c.key)
    for (const k of ['text', 'font', 'ssDelay', 'ssMapDir', 'ssBump', 'ssBumpFreq', 'speed', 'textColor', 'bgColor', 'scale']) {
      expect(keys).toContain(k)
    }
  })

  it('only uses sections from the allow-list (so no control is silently hidden)', () => {
    const allowed = new Set<string>(SPACE_TYPE_SECTIONS)
    for (const c of slitScanEffect.controls) expect(allowed.has(String(c.group))).toBe(true)
  })

  it('is registered and resolvable by id', () => {
    expect(SPACE_TYPE_EFFECTS.map(e => e.id)).toContain('slitscan')
    expect(getEffect('slitscan').id).toBe(slitScanEffect.id)
  })

  it('Gradient selector is the FIRST control in the Warp section', () => {
    const warp = slitScanEffect.controls.filter(c => c.group === 'Warp')
    expect(warp[0]?.key).toBe('ssMapDir')
  })

  it('crosshatch exposes a full cross-axis control set, gated to crosshatch via showIf', () => {
    const byKey = Object.fromEntries(slitScanEffect.controls.map(c => [c.key, c]))
    for (const k of ['ssDelay2', 'ssBands2', 'ssBandSpeed2', 'ssSpeedMode2', 'ssEase2']) {
      expect(byKey[k], `missing cross control ${k}`).toBeDefined()
      expect(byKey[k]!.showIf).toEqual({ key: 'ssMapDir', equals: 'crosshatch' })
    }
    // crosshatch must be a Gradient option for the gate to ever open
    const grad = byKey['ssMapDir'] as { options?: string[] }
    expect(grad.options).toContain('crosshatch')
  })
})
