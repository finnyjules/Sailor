import { describe, expect, it } from 'vitest'
import { DEFAULT_FONT_ID } from '~/data/variable-fonts'
import { DEFAULT_CONFIG, mergeConfig, VT_HEIGHT_MAX, VT_HEIGHT_MIN, VT_STRETCH_MAX, VT_STRETCH_MIN } from '~/lib/vectortype/config'
import { VT_CONTROLS } from '~/lib/vectortype/controls'
import { animatableTargets } from '~/lib/vectortype/motion'

describe('smart stretch config + controls', () => {
  it('defaults to no stretch and fit off', () => {
    expect(DEFAULT_CONFIG.stretch).toBe(1)
    expect(DEFAULT_CONFIG.stretchY).toBe(1)
    expect(DEFAULT_CONFIG.fit).toBe('off')
  })

  it('parses and clamps persisted values; unknown fit falls back to off', () => {
    const c = mergeConfig({ stretch: 9, stretchY: 0.1, fit: 'height' } as any)
    expect(c.stretch).toBe(VT_STRETCH_MAX)
    expect(c.stretchY).toBe(VT_HEIGHT_MIN)
    expect(c.fit).toBe('off')
    const d = mergeConfig({ stretch: 1.6, fit: 'width' } as any)
    expect(d.stretch).toBeCloseTo(1.6, 9)
    expect(d.fit).toBe('width')
  })

  it('clamps stretch to its own bound and stretchY to the wider height bound', () => {
    expect(mergeConfig({ stretch: 2.4 } as any).stretch).toBe(1.8)
    expect(mergeConfig({ stretch: 0.4 } as any).stretch).toBe(0.6)
    expect(mergeConfig({ stretchY: 2.4 } as any).stretchY).toBe(2.0)
    expect(mergeConfig({ stretchY: 0.4 } as any).stretchY).toBe(0.6)
  })

  it('declares the two dials and the fit select in the Layout group, nothing lab-only', () => {
    const keys = VT_CONTROLS.map(c => c.key)
    expect(keys).toContain('stretch'); expect(keys).toContain('stretchY'); expect(keys).toContain('fit')
    for (const k of ['k', 'roundCoupling', 'shapeRules']) expect(keys).not.toContain(k)
    const s = VT_CONTROLS.find(c => c.key === 'stretch') as any
    expect(s.group).toBe('Layout'); expect(s.min).toBe(VT_STRETCH_MIN); expect(s.max).toBe(VT_STRETCH_MAX); expect(s.step).toBe(0.01)
    const sy = VT_CONTROLS.find(c => c.key === 'stretchY') as any
    expect(sy.min).toBe(VT_HEIGHT_MIN); expect(sy.max).toBe(VT_HEIGHT_MAX)
    const f = VT_CONTROLS.find(c => c.key === 'fit') as any
    expect(f.kind).toBe('select'); expect(f.options).toEqual(['off', 'width'])
  })

  it('the dials are motion targets; fit is not', () => {
    const paths = animatableTargets(DEFAULT_CONFIG, []).map(t => t.path)
    expect(paths).toContain('stretch'); expect(paths).toContain('stretchY')
    expect(paths).not.toContain('fit')
  })
})

describe('fontId is token-tolerant on parse', () => {
  it('keeps any valid font token on reload and resets junk to the default', () => {
    expect(mergeConfig({ fontId: 'google:Inter Tight@700' } as any).fontId).toBe('google:Inter Tight@700')
    expect(mergeConfig({ fontId: 'local:OT 2049@300i' } as any).fontId).toBe('local:OT 2049@300i')
    expect(mergeConfig({ fontId: 'roboto-flex' } as any).fontId).toBe('roboto-flex')
    expect(mergeConfig({ fontId: 'not-a-font' } as any).fontId).toBe(DEFAULT_FONT_ID)
  })
})
