// frontend/tests/unit/shaderstudio-presets.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { ADJUST_PRESETS, DUOTONE_PRESETS, EFFECT_LOOKS, applyAdjustPreset } from '~/lib/shaderstudio/presets'
import catalogJson from '../../../shader_effects/manifest.json'
import { defaultConfig } from '~/lib/shaderstudio/types'

describe('shaderstudio presets', () => {
  it('duotone presets are hex pairs', () => {
    expect(DUOTONE_PRESETS.length).toBeGreaterThanOrEqual(6)
    for (const p of DUOTONE_PRESETS) {
      expect(p.ink).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(p.paper).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('applyAdjustPreset writes the preset values into adjust', () => {
    const c = defaultConfig()
    const punchy = ADJUST_PRESETS.find(p => p.name === 'Punchy')!
    applyAdjustPreset(c.adjust, punchy)
    expect(c.adjust.contrast).toBe(punchy.values.contrast)
    expect(c.adjust.saturation).toBe(punchy.values.saturation)
  })
})

/**
 * A Look is applied by `setParam(uniform, value)`. A uniform the effect does not
 * declare writes a key nothing reads: the Look row would show "Custom" for ever
 * and the click would do nothing visible — the dead-control failure, one layer up.
 */
describe('effect Looks name only params their effect declares', () => {
  const CATALOG = (catalogJson as { effects: { id: string; params: { uniform: string; type?: string; default: unknown }[] }[] }).effects
  const byId = new Map(CATALOG.map(e => [e.id, e]))

  for (const [effectId, looks] of Object.entries(EFFECT_LOOKS)) {
    it(`${effectId}: is a real effect and every look param is one of its uniforms`, () => {
      const def = byId.get(effectId)
      expect(def, `${effectId} is not in the shader catalog`).toBeTruthy()
      const declared = new Set(def!.params.map(p => p.uniform))
      for (const look of looks) {
        expect(look.name.length).toBeGreaterThan(0)
        for (const k of Object.keys(look.params)) {
          expect(declared.has(k), `${effectId} look "${look.name}" sets ${k}, which it does not declare`).toBe(true)
        }
      }
    })

    it(`${effectId}: look names are unique`, () => {
      expect(new Set(looks.map(l => l.name)).size).toBe(looks.length)
    })
  }

  // Culture's Looks ARE its palette — the tool's five plates, as ordered ink roles
  // (plate first, then one ring each). A look that dropped to two stops would drop
  // a role, so the shape is pinned, not just the keys.
  it('culture: every look is a full ordered ink list, sorted, 3–8 roles', () => {
    for (const look of EFFECT_LOOKS.culture!) {
      const stops = look.params.u_ramp as { pos: number; color: string }[]
      expect(Array.isArray(stops), `${look.name} must set u_ramp`).toBe(true)
      expect(stops.length).toBeGreaterThanOrEqual(3)
      expect(stops.length).toBeLessThanOrEqual(8)
      for (const s of stops) expect(s.color).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect([...stops].sort((a, b) => a.pos - b.pos)).toEqual(stops)
      expect(stops[0]!.pos).toBe(0)
      expect(stops[stops.length - 1]!.pos).toBe(1)
    }
  })

  // The generative's defaults ARE the tool's own starting settings; a drifted
  // default silently ships a different picture from the one that was reviewed.
  it('culture: the manifest defaults are the tool’s own', () => {
    const def = byId.get('culture')!
    const d = Object.fromEntries(def.params.map(p => [p.uniform, p.default]))
    expect(d.u_count).toBe(36)
    expect(d.u_size).toBe(0.4)
    expect(d.u_fuse).toBe(0.62)
    expect(d.u_cover).toBe(0.72)
    expect(d.u_spread).toBe(1.7)
    expect(d.u_soft).toBe(0.3)
    expect(d.u_grain).toBe(0.62)
    expect(d.u_dot).toBe(2)
    expect(d.u_tex).toBe(0)      // fine
    expect(d.u_motion).toBe(0)   // still: the tool's motion is off by default
    expect(d.u_amount).toBe(0.6)
    // and the default inks are the tool's reference plate, in role order
    expect(d.u_ramp).toEqual(EFFECT_LOOKS.culture![0]!.params.u_ramp)
  })
})
