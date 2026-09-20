import { describe, it, expect } from 'vitest'
import { getShaderFillControls, derivedShaderFillControls } from '../../app/lib/shaderfill/controls'
import { getByPath } from '../../app/lib/studio/path'
import { DEFAULT_SHADER_SPEC } from '../../app/lib/spacetype/fillTile'
import { resolveEffectParams } from '../../app/lib/shaderfill/descriptor'

// EffectParamDef exposes `.uniform` (already `u_`-prefixed, e.g. "u_segments"), not
// `.key` — see EffectParamDef in ~/lib/shaderfx/types. derivedShaderFillControls strips
// the prefix, so `uniform: 'u_segments'` must produce the control key `...params.segments`.
const effect = { id: 'kaleidoscope', name: 'Kaleidoscope', params: [
  { uniform: 'u_segments', label: 'Segments', type: 'float', min: 2, max: 24, default: 6 },
] } as any

// The brief's own mock only ever exercised the `float` branch — the `enum` branch had
// ZERO coverage. `u_shape`'s numeric default (0) intentionally is NOT the only valid
// option, so a test can tell "the written value survived" apart from "it silently fell
// back to p.default" — those two would read identically if default were the only case
// exercised.
const enumEffect = { id: 'facet-shape', name: 'Facet Shape', params: [
  { uniform: 'u_shape', label: 'Shape', type: 'enum', default: 0, options: [
    { label: 'Square', value: 0 },
    { label: 'Hex', value: 1 },
  ] },
] } as any

describe('shader fill controls', () => {
  it('declares exactly the four frozen keys', () => {
    // `seed` joined on 09-03 (5fa4c1c4d — a required ShaderSpec field); controls.ts documents
    // all four as frozen. This expectation was left at three and has been red since.
    expect(getShaderFillControls().map(c => c.key))
      .toEqual(['fill.shader.effectId', 'fill.shader.anchor', 'fill.shader.speed', 'fill.shader.seed'])
  })
  it('derives one spec per effect param addressed at the real ShaderSpec.params path', () => {
    const d = derivedShaderFillControls(effect, 'fill.shader')
    expect(d.map(c => c.key)).toEqual(['fill.shader.params.segments'])
    expect(d[0]).toMatchObject({ kind: 'slider', min: 2, max: 24, default: 6 })
  })
  it('derived params are animatable, so motion tracks come free', () => {
    expect(derivedShaderFillControls(effect, 'fill.shader')[0]!.animatable).not.toBe(false)
  })
  it('speed is animatable and anchor is not — anchor is a mode, not a value', () => {
    const byKey = Object.fromEntries(getShaderFillControls().map(c => [c.key, c]))
    expect(byKey['fill.shader.speed']!.animatable).not.toBe(false)
    expect(byKey['fill.shader.anchor']!.animatable).toBe(false)
  })

  // Pins the PROPERTY, not just the string: a key that merely equals
  // 'fill.shader.params.segments' would still pass if storage moved out from under it.
  // Walking the dotted path against a real Fill/ShaderSpec object (the same naive
  // traversal makeConfigParams/getByPath use everywhere else) and landing on the
  // actual param value — not undefined — proves the derived key addresses REAL
  // storage, not a schema-only namespace one segment removed from it.
  it('derived keys resolve against real ShaderSpec storage, not a phantom namespace', () => {
    const d = derivedShaderFillControls(effect, 'fill.shader')
    const root = {
      fill: {
        type: 'shader',
        shader: { ...DEFAULT_SHADER_SPEC, params: { segments: 8 } },
      },
    }
    const params: Record<string, number> = root.fill.shader.params
    for (const c of d) {
      const paramId = c.key.split('.').pop()!
      expect(getByPath(root, c.key), c.key).toBe(params[paramId])
      expect(getByPath(root, c.key), c.key).not.toBeUndefined()
    }
    expect(getByPath(root, d[0]!.key)).toBe(8)
  })
})

describe('enum-typed effect params', () => {
  it('derives a select whose options/default are the numeric values themselves, not labels', () => {
    const d = derivedShaderFillControls(enumEffect, 'fill.shader')
    expect(d).toEqual([{
      key: 'fill.shader.params.shape', label: 'Shape', kind: 'select',
      options: ['0', '1'], default: '0', group: 'Effect',
    }])
  })

  // The assertion that actually proves the two domains agree: write the derived
  // control's value into a REAL ShaderSpec.params bag and run it through
  // resolveEffectParams — the same function the renderer uses to read params back.
  // A test that only checks the control's shape (the one above) would still pass
  // today even if this were still storing labels; this one would not, because
  // resolveEffectParams's enum branch silently discards a non-number and returns
  // p.default instead — the exact failure this fix closes.
  it('round-trips through resolveEffectParams: a written value SURVIVES, it is not silently replaced by p.default', () => {
    const d = derivedShaderFillControls(enumEffect, 'fill.shader')
    const control = d[0]!
    const paramId = control.key.split('.').pop()! // 'shape'

    // The control's own default reproduces the effect's declared default (0).
    const atDefault = resolveEffectParams(enumEffect, { [paramId]: Number(control.default) })
    expect(atDefault[paramId]).toBe(0)

    // A DIFFERENT valid option (1, "Hex") must survive as 1 — not fall back to the
    // default 0. Under the old label-storing implementation, the value written here
    // would have been the string "Hex", which fails resolveEffectParams's
    // `typeof raw === 'number'` check and silently returns 0 (the default) instead —
    // this assertion is the one that would have caught that bug.
    const nonDefaultOption = (control as any).options[1] // '1'
    const nonDefault = resolveEffectParams(enumEffect, { [paramId]: Number(nonDefaultOption) })
    expect(nonDefault[paramId]).toBe(1)
  })
})
