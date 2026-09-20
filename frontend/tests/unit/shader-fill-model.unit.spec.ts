import { describe, it, expect } from 'vitest'
import {
  type Fill, type ShaderSpec, FILL_TYPES, DEFAULT_FILL, DEFAULT_SHADER_SPEC,
  normalizeFill, normalizeShaderSpec, parseFills, serializeFills, fillIsShader,
  effectiveTileFill, effectiveTilePaint, normalizePaint,
} from '~/lib/spacetype/fillTile'
import { isFill, isGradient, type Gradient } from '~/lib/compositor/paint'

const shaderFill = (over: Partial<Fill> = {}): Fill => ({
  ...DEFAULT_FILL, type: 'shader', shader: { ...DEFAULT_SHADER_SPEC }, ...over,
})

describe('shader fill model', () => {
  it('shader is the ninth fill type, appended so picker order is stable', () => {
    expect(FILL_TYPES).toEqual(['solid','gradient','ombre','grid','noise','checkerboard','stripes','qr','shader','shapes','paper'])
  })

  it('fillIsShader narrows only a shader fill carrying a spec', () => {
    expect(fillIsShader(shaderFill())).toBe(true)
    expect(fillIsShader({ ...DEFAULT_FILL })).toBe(false)
    expect(fillIsShader({ ...DEFAULT_FILL, type: 'shader' })).toBe(false) // type without spec
  })

  it('normalizeFill fills a default spec when type is shader but spec is missing', () => {
    const n = normalizeFill({ type: 'shader' })
    expect(n.type).toBe('shader')
    expect(n.shader).toEqual(DEFAULT_SHADER_SPEC)
  })

  it('normalizeFill drops a spec when the type is not shader', () => {
    const n = normalizeFill({ type: 'grid', shader: { ...DEFAULT_SHADER_SPEC } })
    expect(n.shader).toBeUndefined()
  })

  it('enforces depth-1: a nested shader input collapses to its own input', () => {
    const nested = normalizeFill({
      type: 'shader',
      shader: { ...DEFAULT_SHADER_SPEC, input: { ...DEFAULT_FILL, type: 'shader', shader: { ...DEFAULT_SHADER_SPEC } } },
    })
    const input = nested.shader!.input // Paint — narrow before reading Fill-only fields
    expect(isFill(input)).toBe(true)
    if (!isFill(input)) throw new Error('unreachable')
    expect(input.type).not.toBe('shader')
    expect(input.shader).toBeUndefined()
  })

  it('coerces a junk spec rather than throwing', () => {
    const n = normalizeFill({ type: 'shader', shader: { effectId: 42, anchor: 'sideways', speed: 'fast', params: null } })
    expect(n.shader!.effectId).toBe(DEFAULT_SHADER_SPEC.effectId)
    expect(n.shader!.anchor).toBe('object')
    expect(typeof n.shader!.speed).toBe('number')
    expect(n.shader!.params).toEqual({})
  })

  it('coerces a non-finite speed (NaN/Infinity) to the default rather than letting it through', () => {
    expect(normalizeFill({ type: 'shader', shader: { ...DEFAULT_SHADER_SPEC, speed: NaN } }).shader!.speed).toBe(1)
    expect(normalizeFill({ type: 'shader', shader: { ...DEFAULT_SHADER_SPEC, speed: Infinity } }).shader!.speed).toBe(1)
  })

  it('round-trips through serializeFills/parseFills (the save/reload path)', () => {
    const original = shaderFill({
      // `seed` is a required ShaderSpec field since 09-03 (5fa4c1c4d); a non-default value here
      // proves the save/reload path carries the AUTHORED seed rather than re-defaulting it.
      shader: { effectId: 'kaleidoscope', params: { segments: 6 }, anchor: 'frame', speed: 0.5, seed: 7,
                input: { ...DEFAULT_FILL, type: 'gradient', a: '#ff0000' } },
    })
    const [back] = parseFills(serializeFills([original]))
    expect(back).toEqual(original)
  })
})

describe('effectiveTileFill (graceful degradation for the CPU tile builders)', () => {
  it('passes a non-shader fill through unchanged', () => {
    const f: Fill = { ...DEFAULT_FILL, type: 'grid' }
    expect(effectiveTileFill(f)).toBe(f)
  })

  it('resolves a shader fill to its input fill', () => {
    const input: Fill = { ...DEFAULT_FILL, type: 'gradient', a: '#ff0000', b: '#00ff00' }
    const f = shaderFill({ shader: { ...DEFAULT_SHADER_SPEC, input } })
    expect(effectiveTileFill(f)).toEqual(input)
  })

  it('falls back to the default shader input when `shader` is absent, rather than throwing', () => {
    const f: Fill = { ...DEFAULT_FILL, type: 'shader' } // shader missing
    expect(() => effectiveTileFill(f)).not.toThrow()
    expect(effectiveTileFill(f)).toEqual(DEFAULT_SHADER_SPEC.input)
  })

  it('never returns a shader-typed fill, even if a malformed input slipped past normalizeFill', () => {
    const malformed = { ...DEFAULT_FILL, type: 'shader', shader: { ...DEFAULT_SHADER_SPEC } } as Fill
    // simulate a bypass of the depth-1 guard: input is itself (bogusly) typed 'shader'
    ;(malformed.shader as any).input = { ...DEFAULT_FILL, type: 'shader', shader: { ...DEFAULT_SHADER_SPEC } }
    expect(effectiveTileFill(malformed).type).not.toBe('shader')
  })

  it('degrades a shader-typed Fill whose (widened) input is a Gradient/string to the default shader Fill — there is no Fill representation of a Gradient', () => {
    const gradientInput: Gradient = { type: 'radial', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }
    const f = shaderFill({ shader: { ...DEFAULT_SHADER_SPEC, input: gradientInput } })
    expect(effectiveTileFill(f)).toEqual(DEFAULT_SHADER_SPEC.input)

    const stringInput = '#ff00ff'
    const f2 = shaderFill({ shader: { ...DEFAULT_SHADER_SPEC, input: stringInput } })
    expect(effectiveTileFill(f2)).toEqual(DEFAULT_SHADER_SPEC.input)
  })
})

describe('effectiveTilePaint (the Paint-general sibling used on the live-field path)', () => {
  it('passes a string paint through unchanged', () => {
    expect(effectiveTilePaint('#123456')).toBe('#123456')
  })

  it('passes a Gradient paint through unchanged (same reference)', () => {
    const g: Gradient = { type: 'linear', angle: 30, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }
    expect(effectiveTilePaint(g)).toBe(g)
  })

  it('unwraps a shader-typed Fill to its actual (Gradient) input, unlike effectiveTileFill', () => {
    const g: Gradient = { type: 'radial', stops: [{ offset: 0, color: '#111' }, { offset: 1, color: '#222' }] }
    const f = shaderFill({ shader: { ...DEFAULT_SHADER_SPEC, input: g } })
    expect(effectiveTilePaint(f)).toEqual(g)
  })

  it('never returns a shader-typed value', () => {
    const malformed = { ...DEFAULT_FILL, type: 'shader', shader: { ...DEFAULT_SHADER_SPEC } } as Fill
    ;(malformed.shader as any).input = { ...DEFAULT_FILL, type: 'shader', shader: { ...DEFAULT_SHADER_SPEC } }
    const out = effectiveTilePaint(malformed)
    expect(isFill(out) && out.type === 'shader').toBe(false)
  })
})

describe('normalizePaint (routing order is a migration-safety condition)', () => {
  it('a string passes through as Paint arm 1', () => {
    expect(normalizePaint('#abcdef', 1)).toBe('#abcdef')
  })

  it('a Gradient-shaped object is normalised as Paint arm 2, not routed through normalizeFill', () => {
    const out = normalizePaint({ type: 'linear', angle: '30' as any, stops: [{ offset: 2, color: '#fff' }, { offset: -1, color: 7 as any }] }, 1)
    expect(isGradient(out)).toBe(true)
    if (!isGradient(out)) throw new Error('unreachable')
    expect(out.type).toBe('linear')
    expect((out as any).angle).toBe(0)              // non-number angle coerced to a finite default
    expect(out.stops.map(s => s.offset)).toEqual([1, 0].sort((a, b) => a - b)) // clamped + sorted
    expect(out.stops.every(s => typeof s.color === 'string')).toBe(true)      // non-string color coerced
  })

  it('drops stop entries that are not even shaped like a stop, and falls back to the default shader input if none survive', () => {
    const out = normalizePaint({ type: 'radial', stops: [null, 42, 'nope'] }, 1)
    expect(out).toEqual(DEFAULT_SHADER_SPEC.input)
  })

  it('everything else — null, undefined, and junk — falls through to normalizeFill, exactly as before', () => {
    expect(normalizePaint(null, 1)).toEqual(normalizeFill(null, 1))
    expect(normalizePaint(undefined, 1)).toEqual(normalizeFill(undefined, 1))
    expect(normalizePaint(42, 1)).toEqual(normalizeFill(42, 1))
    expect(normalizePaint({ type: 'grid', a: '#ff0000' }, 1)).toEqual(normalizeFill({ type: 'grid', a: '#ff0000' }, 1))
  })

  it('is NOT gated on isFill: a Fill missing `density` is repaired by normalizeFill, not dropped to the default', () => {
    const handEdited = { type: 'grid', a: '#ff0000', b: '#00ff00', textColor: '#ffffff', angle: 10 } // no `density`
    expect(isFill(handEdited as any)).toBe(false)   // confirms this is exactly the case isFill would mis-route
    const out = normalizePaint(handEdited, 1)
    expect(out).not.toEqual(DEFAULT_SHADER_SPEC.input)
    expect(out).toEqual(normalizeFill(handEdited, 1))
    expect((out as Fill).density).toBe(8) // repaired to the Fill default, not dropped
  })
})

describe('no migration: a persisted ShaderSpec is untouched by normalizeShaderSpec', () => {
  // "Untouched" has one deliberate exception: `seed` joined ShaderSpec on 09-03 as a required
  // field, so a spec saved BEFORE that gains the default seed on read — and nothing else. A spec
  // saved since carries its own seed and round-trips exactly.
  const withDefaultSeed = (spec: object) => ({ ...spec, seed: DEFAULT_SHADER_SPEC.seed })

  it('a Fill input round-trips unchanged; one saved before seeds existed gains only the default seed', () => {
    const preSeed = {
      effectId: 'kaleidoscope', params: { segments: 6 }, anchor: 'frame', speed: 0.5,
      input: { type: 'gradient', a: '#ff0000', b: '#00ff00', textColor: '#ffffff', angle: 12, density: 3 },
    }
    expect(normalizeShaderSpec(preSeed, 0)).toEqual(withDefaultSeed(preSeed))
    const today: ShaderSpec = { ...preSeed, seed: 7 } as ShaderSpec
    expect(normalizeShaderSpec(today, 0)).toEqual(today)
  })

  it('a Fill input missing `density` (the hand-edited case) is repaired exactly as before, not dropped to a fallback', () => {
    const handEdited = {
      effectId: 'kaleidoscope', params: {}, anchor: 'object', speed: 1,
      input: { type: 'grid', a: '#ff0000', b: '#00ff00', textColor: '#ffffff', angle: 10 }, // no density
    }
    const out = normalizeShaderSpec(handEdited, 0)
    expect(isFill(out.input)).toBe(true)
    expect(out.input).not.toEqual(DEFAULT_SHADER_SPEC.input)
    expect((out.input as Fill).type).toBe('grid')
    expect((out.input as Fill).density).toBe(8) // DEFAULT_FILL's density, filled in by normalizeFill
  })

  it('a Gradient input, as it would be freshly saved by step 3, round-trips unchanged too', () => {
    const persisted: ShaderSpec = {
      effectId: 'fbm_warp', params: {}, anchor: 'object', speed: 1, seed: 11,
      input: { type: 'radial', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] },
    }
    expect(normalizeShaderSpec(persisted, 0)).toEqual(persisted)
    const { seed: _seed, ...preSeed } = persisted
    expect(normalizeShaderSpec(preSeed, 0)).toEqual(withDefaultSeed(preSeed))
  })
})
