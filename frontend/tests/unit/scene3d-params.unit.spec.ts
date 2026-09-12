import { describe, it, expect } from 'vitest'
import { PRIMITIVE_PARAMS, paramValue, sanitizeParams, MODIFIER_SPECS, modifierValue, resolveParam, sanitizeBag, sanitizeModifiers } from '~/lib/scene3d/primParams'
import { PRIMITIVE_KINDS } from '~/lib/scene3d/config'

describe('scene3d primitive params', () => {
  it('has a spec list for every primitive kind', () => {
    expect(Object.keys(PRIMITIVE_PARAMS).sort()).toEqual([...PRIMITIVE_KINDS].sort())
  })

  it('gives every spec a default inside its own range and a unique key', () => {
    for (const kind of PRIMITIVE_KINDS) {
      const specs = PRIMITIVE_PARAMS[kind]
      // 'mesh' is content-only — a stored vertex buffer has nothing parametric
      // left to expose, so its spec list is deliberately empty (config.ts).
      if (kind !== 'mesh') expect(specs.length, `${kind} has no params`).toBeGreaterThan(0)
      const keys = specs.map((s) => s.key)
      expect(new Set(keys).size, `${kind} has duplicate keys`).toBe(keys.length)
      for (const s of specs) {
        expect(s.default, `${kind}.${s.key} default below min`).toBeGreaterThanOrEqual(s.min)
        expect(s.default, `${kind}.${s.key} default above max`).toBeLessThanOrEqual(s.max)
        expect(s.min).toBeLessThan(s.max)
        expect(s.step).toBeGreaterThan(0)
        expect(s.hint.length, `${kind}.${s.key} needs a tooltip hint`).toBeGreaterThan(0)
      }
    }
  })

  it('resolves a stored value, falls back to the default, and clamps', () => {
    expect(paramValue('sphere', { detail: 12 }, 'detail')).toBe(12)
    expect(paramValue('sphere', undefined, 'detail')).toBe(48)
    expect(paramValue('sphere', {}, 'arc')).toBe(360)
    expect(paramValue('sphere', { detail: 9999 }, 'detail')).toBe(64)
    expect(paramValue('sphere', { detail: -5 }, 'detail')).toBe(4)
    expect(paramValue('sphere', { detail: Number.NaN }, 'detail')).toBe(48)
  })

  it('throws on a param key the kind does not have', () => {
    expect(() => paramValue('sphere', undefined, 'cornerRadius')).toThrow()
  })

  it('sanitizes: drops unknown and non-finite keys, clamps, keeps absent absent', () => {
    expect(sanitizeParams('sphere', undefined)).toBeUndefined()
    expect(sanitizeParams('sphere', {})).toBeUndefined()
    expect(sanitizeParams('sphere', { nope: 3 })).toBeUndefined()
    expect(sanitizeParams('sphere', { detail: 'big' })).toBeUndefined()
    expect(sanitizeParams('sphere', { detail: Number.POSITIVE_INFINITY })).toBeUndefined()
    expect(sanitizeParams('sphere', { detail: 16, nope: 3 })).toEqual({ detail: 16 })
    expect(sanitizeParams('sphere', { detail: 9999 })).toEqual({ detail: 64 })
  })

  it('gives the box a corner radius and the polyhedra a subdivision detail', () => {
    expect(PRIMITIVE_PARAMS.box.map((s) => s.key)).toEqual(['cornerRadius', 'cornerSides'])
    expect(paramValue('box', undefined, 'cornerRadius')).toBe(0)
    expect(paramValue('icosahedron', undefined, 'detail')).toBe(0)
    expect(paramValue('icosahedron', { detail: 2 }, 'detail')).toBe(2)
  })

  it('models the open-ended flag as a 0/1 toggle so params stay numeric', () => {
    const spec = PRIMITIVE_PARAMS.cylinder.find((s) => s.key === 'openEnded')!
    expect(spec.control).toBe('toggle')
    expect(spec.min).toBe(0)
    expect(spec.max).toBe(1)
    expect(spec.default).toBe(0)
  })

  it('gives cylinder, cone, prism and pyramid a corner radius', () => {
    for (const kind of ['cylinder', 'cone', 'prism', 'pyramid'] as const) {
      const keys = PRIMITIVE_PARAMS[kind].map((s) => s.key)
      expect(keys, `${kind} missing cornerRadius`).toContain('cornerRadius')
      expect(keys, `${kind} missing cornerSides`).toContain('cornerSides')
      expect(paramValue(kind, undefined, 'cornerRadius')).toBe(0)
      expect(paramValue(kind, undefined, 'cornerSides')).toBe(2)
    }
  })

  it('gives the convex polyhedra a corner radius', () => {
    for (const kind of ['icosahedron', 'octahedron', 'dodecahedron'] as const) {
      const keys = PRIMITIVE_PARAMS[kind].map((s) => s.key)
      expect(keys, `${kind} missing cornerRadius`).toContain('cornerRadius')
      expect(keys, `${kind} missing cornerSides`).toContain('cornerSides')
      expect(paramValue(kind, undefined, 'cornerRadius')).toBe(0)
      expect(paramValue(kind, undefined, 'cornerSides')).toBe(2)
    }
  })
})

describe('scene3d modifier specs', () => {
  it('describes every modifier with a hint, a sane range and a unique key', () => {
    const keys = MODIFIER_SPECS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of MODIFIER_SPECS) {
      expect(s.hint.length, `${s.key} needs a tooltip hint`).toBeGreaterThan(0)
      expect(s.min).toBeLessThan(s.max)
      expect(s.step).toBeGreaterThan(0)
      expect(s.default).toBeGreaterThanOrEqual(s.min)
      expect(s.default).toBeLessThanOrEqual(s.max)
      if (s.control === 'options') {
        expect(s.options, `${s.key} needs options`).toBeTruthy()
        expect(s.options!.length).toBeGreaterThan(1)
        // options are stored as an index, so the range must cover them exactly
        expect(s.min).toBe(0)
        expect(s.max).toBe(s.options!.length - 1)
      }
    }
  })

  it('defaults every modifier to its identity so a fresh object is undeformed', () => {
    for (const key of ['subdivide', 'taper', 'twist', 'bend', 'noise']) {
      expect(modifierValue(undefined, key), `${key} must default to 0`).toBe(0)
    }
    expect(modifierValue(undefined, 'cloneCount')).toBe(1)
  })

  it('covers the documented modifier set', () => {
    expect(MODIFIER_SPECS.map((s) => s.key)).toEqual([
      'subdivide',
      'taper', 'taperAxis',
      'twist', 'twistAxis',
      'bend', 'bendAxis',
      'noise', 'noiseScale', 'noiseSeed',
      'jitter', 'jitterMode', 'jitterSeed',
      'cloneCount', 'cloneMode', 'cloneOffsetX', 'cloneOffsetY', 'cloneOffsetZ', 'cloneRadius', 'cloneAxis',
      'cloneCountX', 'cloneCountY', 'cloneCountZ',
      'cloneSpacingX', 'cloneSpacingY', 'cloneSpacingZ',
      'cloneStepRotX', 'cloneStepRotY', 'cloneStepRotZ', 'cloneStepScale',
      'varyMode', 'varySeed', 'varyFalloffCenter', 'varyFalloffRadius',
      'varyColor', 'varyColorSpread', 'varyColorStrength',
    ])
  })

  it('adds a jitter modifier and a deeper subdivide cap', () => {
    const spec = (key: string) => MODIFIER_SPECS.find((s) => s.key === key)!
    expect(spec('jitter').default).toBe(0)
    expect(spec('jitter').max).toBe(0.5)
    expect(spec('jitterMode').control).toBe('options')
    expect(spec('jitterMode').options).toEqual(['random', 'normal'])
    expect(spec('jitterMode').min).toBe(0)
    expect(spec('jitterMode').max).toBe(1)
    expect(spec('jitterSeed').max).toBe(99)
    expect(spec('subdivide').max).toBe(8)
    expect(modifierValue(undefined, 'jitter')).toBe(0)
  })

  it('appends grid to cloneMode so saved linear/radial indices still resolve', () => {
    const spec = MODIFIER_SPECS.find((s) => s.key === 'cloneMode')!
    // The stored value is the option INDEX: linear and radial must keep 0 and 1.
    expect(spec.options).toEqual(['linear', 'radial', 'grid'])
    expect(spec.min).toBe(0)
    expect(spec.max).toBe(2)
    expect(spec.default).toBe(0)
    expect(modifierValue({ cloneMode: 0 }, 'cloneMode')).toBe(0)
    expect(modifierValue({ cloneMode: 1 }, 'cloneMode')).toBe(1)
    expect(modifierValue({ cloneMode: 2 }, 'cloneMode')).toBe(2)
  })

  it('gives the grid and step transforms the documented ranges and defaults', () => {
    const spec = (key: string) => MODIFIER_SPECS.find((s) => s.key === key)!
    for (const [key, def] of [['cloneCountX', 3], ['cloneCountY', 1], ['cloneCountZ', 3]] as const) {
      expect(spec(key).min).toBe(1)
      expect(spec(key).max).toBe(5)
      expect(spec(key).step).toBe(1)
      expect(spec(key).default).toBe(def)
    }
    for (const key of ['cloneSpacingX', 'cloneSpacingY', 'cloneSpacingZ']) {
      expect(spec(key).min).toBe(0)
      expect(spec(key).max).toBe(4)
      expect(spec(key).step).toBe(0.05)
      expect(spec(key).default).toBe(1.2)
    }
    // Step transforms default to identity so they never disturb an old scene.
    for (const key of ['cloneStepRotX', 'cloneStepRotY', 'cloneStepRotZ']) {
      expect(spec(key).min).toBe(-180)
      expect(spec(key).max).toBe(180)
      expect(spec(key).step).toBe(1)
      expect(spec(key).default).toBe(0)
    }
    expect(spec('cloneStepScale').min).toBe(0.5)
    expect(spec('cloneStepScale').max).toBe(1.5)
    expect(spec('cloneStepScale').step).toBe(0.01)
    expect(spec('cloneStepScale').default).toBe(1)
  })

  it('still loads scenes saved with the legacy array* modifier keys', () => {
    expect(sanitizeModifiers({ arrayCount: 4 })).toEqual({ cloneCount: 4 })
    expect(sanitizeModifiers({
      arrayCount: 6, arrayMode: 1, arrayOffsetX: 2, arrayOffsetY: 1, arrayOffsetZ: -1,
      arrayRadius: 3, arrayAxis: 2,
    })).toEqual({
      cloneCount: 6, cloneMode: 1, cloneOffsetX: 2, cloneOffsetY: 1, cloneOffsetZ: -1,
      cloneRadius: 3, cloneAxis: 2,
    })
    // Mixed bags keep the new key's value, and non-legacy keys are untouched.
    expect(sanitizeModifiers({ arrayCount: 4, cloneCount: 7, twist: 90 }))
      .toEqual({ twist: 90, cloneCount: 7 })
    // sanitizeBag itself stays schema-pure — it knows nothing about the remap.
    expect(sanitizeBag(MODIFIER_SPECS, { arrayCount: 4 })).toBeUndefined()
  })

  it('resolves and sanitizes modifier bags like param bags', () => {
    expect(modifierValue({ twist: 90 }, 'twist')).toBe(90)
    expect(modifierValue({ twist: 9999 }, 'twist')).toBe(360)
    expect(sanitizeBag(MODIFIER_SPECS, { twist: 90, nope: 1 })).toEqual({ twist: 90 })
    expect(sanitizeBag(MODIFIER_SPECS, {})).toBeUndefined()
  })

  it('keeps the generic resolver and the param-specific wrapper in agreement', () => {
    expect(resolveParam(PRIMITIVE_PARAMS.sphere, { detail: 12 }, 'detail'))
      .toBe(paramValue('sphere', { detail: 12 }, 'detail'))
    expect(sanitizeBag(PRIMITIVE_PARAMS.sphere, { detail: 12, nope: 1 }))
      .toEqual(sanitizeParams('sphere', { detail: 12, nope: 1 }))
  })
})
