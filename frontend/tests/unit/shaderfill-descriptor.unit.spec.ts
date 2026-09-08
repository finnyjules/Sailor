import { describe, it, expect } from 'vitest'
import { DEFAULT_FILL, DEFAULT_SHADER_SPEC, type Fill, type ShaderSpec } from '~/lib/spacetype/fillTile'
import { quantizeTime, fieldKey, inputKey, planFields, resolveEffectParams, LIVE_FIELD_CEILING } from '~/lib/shaderfill/descriptor'
import type { EffectDef } from '~/lib/shaderfx/types'
import type { Gradient } from '~/lib/compositor/paint'

const spec = (o: Partial<ShaderSpec> = {}): ShaderSpec => ({ ...DEFAULT_SHADER_SPEC, ...o })

// Mirrors the real catalog's convention (shader_effects/manifest.json): `uniform`
// carries the `u_` prefix already; ShaderSpec.params does not.
const fakeEffect = (overrides: Partial<EffectDef> = {}): EffectDef => ({
  id: 'fbm_warp', name: 'FBM Warp', category: 'distortion', animated: true, passes: 1,
  centerParam: null, textures: [],
  params: [
    { uniform: 'u_amount', label: 'Amount', type: 'float', min: 0, max: 0.5, default: 0.12, step: 0.005 },
    { uniform: 'u_scale', label: 'Scale', type: 'float', min: 0.5, max: 8, default: 3, step: 0.25 },
    { uniform: 'u_mode', label: 'Mode', type: 'enum', default: 0, options: [{ label: 'A', value: 0 }, { label: 'B', value: 1 }] },
  ],
  source: '',
  ...overrides,
})

describe('quantizeTime', () => {
  it('snaps to the host frame interval', () => {
    expect(quantizeTime(0.51, 30)).toBeCloseTo(0.5)     // 15.3 -> 15 frames
    expect(quantizeTime(0.51, 60)).toBeCloseTo(0.5)     // 30.6 -> 30 frames
    expect(quantizeTime(0.52, 60)).toBeCloseTo(0.5167)  // 31.2 -> 31 frames
  })
  it('uses the host fps rather than a fixed 30 — a 60fps bake gets 60 distinct fields', () => {
    const at30 = new Set([0.50, 0.51, 0.52, 0.53].map(t => quantizeTime(t, 30)))
    const at60 = new Set([0.50, 0.51, 0.52, 0.53].map(t => quantizeTime(t, 60)))
    expect(at60.size).toBeGreaterThan(at30.size)
  })
})

describe('fieldKey', () => {
  it('is stable for identical descriptors — this is what makes batching work', () => {
    expect(fieldKey(spec(), 512, 512, 0.5)).toBe(fieldKey(spec(), 512, 512, 0.5))
  })
  it('separates on effect, params, anchor, size and time', () => {
    const base = fieldKey(spec(), 512, 512, 0.5)
    expect(fieldKey(spec({ effectId: 'droste' }), 512, 512, 0.5)).not.toBe(base)
    expect(fieldKey(spec({ params: { segments: 6 } }), 512, 512, 0.5)).not.toBe(base)
    expect(fieldKey(spec({ anchor: 'frame' }), 512, 512, 0.5)).not.toBe(base)
    expect(fieldKey(spec(), 256, 512, 0.5)).not.toBe(base)
    expect(fieldKey(spec(), 512, 512, 0.6)).not.toBe(base)
  })
  it('includes the input fill — gradient-in differs from grid-in', () => {
    const a = fieldKey(spec({ input: { ...DEFAULT_FILL, type: 'gradient' } }), 512, 512, 0)
    const b = fieldKey(spec({ input: { ...DEFAULT_FILL, type: 'grid' } }), 512, 512, 0)
    expect(a).not.toBe(b)
  })
  it('ignores param key ORDER so two equal descriptors share one field', () => {
    const a = fieldKey(spec({ params: { a: 1, b: 2 } }), 512, 512, 0)
    const b = fieldKey(spec({ params: { b: 2, a: 1 } }), 512, 512, 0)
    expect(a).toBe(b)
  })
  it('drops time entirely when speed is 0, so a frozen field caches once', () => {
    const frozen = spec({ speed: 0 })
    expect(fieldKey(frozen, 512, 512, 0)).toBe(fieldKey(frozen, 512, 512, 99))
  })

  it('does not collide on unescaped separators in param keys — "x=1,y":2 vs x:1,y:2', () => {
    const a = fieldKey(spec({ params: { 'x=1,y': 2 } }), 512, 512, 0)
    const b = fieldKey(spec({ params: { x: 1, y: 2 } }), 512, 512, 0)
    expect(a).not.toBe(b)
  })

  it('does not let a "|" in effectId masquerade as the effectId/params boundary', () => {
    // Under a naive `[effectId, paramsKey, ...].join('|')`, effectId 'a' with params
    // {'b|c': 5} previously produced the SAME string ("a|b|c=5|...") as effectId 'a|b'
    // with params {c: 5} — the '|' inside the param KEY shifted the boundary to land
    // exactly where the effectId/paramsKey split would otherwise be.
    const a = fieldKey(spec({ effectId: 'a', params: { 'b|c': 5 } }), 512, 512, 0.5)
    const b = fieldKey(spec({ effectId: 'a|b', params: { c: 5 } }), 512, 512, 0.5)
    expect(a).not.toBe(b)
  })

  it('does not let a "|" in Fill.a/b masquerade as the input-field boundary', () => {
    // Under a naive `${type}|${a}|${b}|...` join, a='foo|bar',b='baz' previously
    // produced the SAME string as a='foo', b='bar|baz'.
    const fillA = { ...DEFAULT_FILL, type: 'gradient' as const, a: 'foo|bar', b: 'baz' }
    const fillB = { ...DEFAULT_FILL, type: 'gradient' as const, a: 'foo', b: 'bar|baz' }
    const a = fieldKey(spec({ input: fillA }), 512, 512, 0)
    const b = fieldKey(spec({ input: fillB }), 512, 512, 0)
    expect(a).not.toBe(b)
  })

  it('keeps non-finite speeds distinct from each other and from a null param — plain JSON.stringify collapses NaN/Infinity/-Infinity to null', () => {
    const nanSpeed = fieldKey(spec({ speed: NaN }), 512, 512, 0)
    const posInfSpeed = fieldKey(spec({ speed: Infinity }), 512, 512, 0)
    const negInfSpeed = fieldKey(spec({ speed: -Infinity }), 512, 512, 0)
    const nullParam = fieldKey(spec({ params: { p: null as unknown as number } }), 512, 512, 0)
    expect(new Set([nanSpeed, posInfSpeed, negInfSpeed, nullParam]).size).toBe(4)
  })

  it('keeps a NaN param value distinct from an explicit null param value', () => {
    const withNaN = fieldKey(spec({ params: { p: NaN } }), 512, 512, 0)
    const withNull = fieldKey(spec({ params: { p: null as unknown as number } }), 512, 512, 0)
    expect(withNaN).not.toBe(withNull)
  })

  // Depth-1 nesting (a shader fill's `input` is never itself a shader fill) is
  // enforced only at the normalizeFill/parseFills parse boundary, not in the type
  // system — a hand-constructed ShaderSpec can still carry a shader-typed `input`.
  // field.ts defends against that via `effectiveTileFill` before rasterising; the
  // key must defend against the exact same thing, or two specs that render
  // differently can key identically (silent wrong pixels via cache collision).
  it('keys a shader-typed input by what effectiveTileFill actually unwraps it to — different nested content must key differently', () => {
    const shaderInputA: Fill = {
      ...DEFAULT_FILL, type: 'shader',
      shader: { ...DEFAULT_SHADER_SPEC, input: { ...DEFAULT_FILL, type: 'gradient', a: '#111111', b: '#222222' } },
    }
    const shaderInputB: Fill = {
      ...DEFAULT_FILL, type: 'shader',
      shader: { ...DEFAULT_SHADER_SPEC, input: { ...DEFAULT_FILL, type: 'gradient', a: '#333333', b: '#444444' } },
    }
    const a = fieldKey(spec({ input: shaderInputA }), 512, 512, 0)
    const b = fieldKey(spec({ input: shaderInputB }), 512, 512, 0)
    expect(a).not.toBe(b)
  })

  it('keys a shader-typed input identically to the unwrapped equivalent, since that is what actually gets rendered', () => {
    const unwrapped: Fill = { ...DEFAULT_FILL, type: 'grid', a: '#123456', b: '#654321', density: 5 }
    const shaderTyped: Fill = { ...DEFAULT_FILL, type: 'shader', shader: { ...DEFAULT_SHADER_SPEC, input: unwrapped } }
    const a = fieldKey(spec({ input: unwrapped }), 512, 512, 0)
    const b = fieldKey(spec({ input: shaderTyped }), 512, 512, 0)
    expect(a).toBe(b)
  })
})

describe('resolveEffectParams', () => {
  it('applies defaults for every declared param when overrides is empty', () => {
    expect(resolveEffectParams(fakeEffect(), {})).toEqual({ amount: 0.12, scale: 3, mode: 0 })
  })

  it('lets a valid override win over the default', () => {
    expect(resolveEffectParams(fakeEffect(), { amount: 0.4 })).toEqual({ amount: 0.4, scale: 3, mode: 0 })
  })

  it('drops keys the effect does not declare', () => {
    expect(resolveEffectParams(fakeEffect(), { amount: 0.4, notAParam: 999 })).toEqual({ amount: 0.4, scale: 3, mode: 0 })
  })

  it('clamps an out-of-range float override to min/max', () => {
    expect(resolveEffectParams(fakeEffect(), { amount: 99 }).amount).toBe(0.5)
    expect(resolveEffectParams(fakeEffect(), { amount: -99 }).amount).toBe(0)
  })

  it('falls back to default for an enum override that is not a declared option value', () => {
    expect(resolveEffectParams(fakeEffect(), { mode: 7 }).mode).toBe(0)
    expect(resolveEffectParams(fakeEffect(), { mode: 1 }).mode).toBe(1)
  })

  it('falls back to default for a non-finite override — Infinity is not clamped, it is rejected', () => {
    expect(resolveEffectParams(fakeEffect(), { amount: NaN }).amount).toBe(0.12)
    expect(resolveEffectParams(fakeEffect(), { amount: Infinity }).amount).toBe(0.12)
  })

  it('the whole point: an empty params object and one that repeats the defaults must key identically', () => {
    const effect = fakeEffect()
    const empty = resolveEffectParams(effect, {})
    const explicit = resolveEffectParams(effect, { amount: 0.12, scale: 3, mode: 0 })
    expect(explicit).toEqual(empty)
    const keyA = fieldKey(spec({ params: empty }), 512, 512, 0.5)
    const keyB = fieldKey(spec({ params: explicit }), 512, 512, 0.5)
    expect(keyA).toBe(keyB)
  })
})

describe('inputKey (Paint-widened: string | Gradient | Fill must never collide)', () => {
  const linear: Gradient = { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }
  const radial: Gradient = { type: 'radial', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }
  const fill: Fill = { ...DEFAULT_FILL, type: 'gradient', a: '#000000', b: '#ffffff' }

  it('ImageFill encodes deterministically — does not throw, and distinct images key distinctly', () => {
    const imageA = { type: 'image' as const, src: 'A', fit: 'cover' as const, scale: 1, offset: { x: 0, y: 0 } }
    const imageB = { type: 'image' as const, src: 'B', fit: 'cover' as const, scale: 1, offset: { x: 0, y: 0 } }
    const imageDiffFit = { type: 'image' as const, src: 'A', fit: 'tile' as const, scale: 1, offset: { x: 0, y: 0 } }
    const imageSame = { type: 'image' as const, src: 'A', fit: 'cover' as const, scale: 1, offset: { x: 0, y: 0 } }

    // Should not throw
    const keyA = inputKey(imageA)
    const keyB = inputKey(imageB)
    const keyDiffFit = inputKey(imageDiffFit)
    const keySame = inputKey(imageSame)

    // All should be strings
    expect(typeof keyA).toBe('string')
    expect(typeof keyB).toBe('string')
    expect(typeof keyDiffFit).toBe('string')
    expect(typeof keySame).toBe('string')

    // Different src should produce different keys
    expect(keyA).not.toBe(keyB)

    // Different fit should produce different keys
    expect(keyA).not.toBe(keyDiffFit)

    // Structurally equal image fills should produce the same key
    expect(keyA).toBe(keySame)
  })

  it('a string, a linear gradient, a radial gradient, and a Fill all key distinctly — the four-way collision proof', () => {
    const str = '#000000'
    const keys = new Set([inputKey(str), inputKey(linear), inputKey(radial), inputKey(fill)])
    expect(keys.size).toBe(4)
  })

  it('reordering a gradient\'s stops does not change the key — the renderer sorts before drawing, so the key must sort the same way', () => {
    const forward: Gradient = { type: 'linear', angle: 10, stops: [{ offset: 0, color: '#111111' }, { offset: 1, color: '#222222' }] }
    const reversed: Gradient = { type: 'linear', angle: 10, stops: [{ offset: 1, color: '#222222' }, { offset: 0, color: '#111111' }] }
    expect(inputKey(forward)).toBe(inputKey(reversed))
  })

  it('a linear and a radial gradient sharing identical stops still key distinctly (angle slot is null for radial, never omitted)', () => {
    const sameStops = [{ offset: 0, color: '#abcabc' }, { offset: 1, color: '#defdef' }]
    const l: Gradient = { type: 'linear', angle: 0, stops: sameStops }
    const r: Gradient = { type: 'radial', stops: sameStops }
    expect(inputKey(l)).not.toBe(inputKey(r))
  })

  it('two strings with different text key distinctly, and identical strings key identically', () => {
    expect(inputKey('#111111')).not.toBe(inputKey('#222222'))
    expect(inputKey('#111111')).toBe(inputKey('#111111'))
  })

  it('a shader-typed Fill input keys by what it actually unwraps to, even when that is a Gradient', () => {
    const shaderInput: Fill = { ...DEFAULT_FILL, type: 'shader', shader: { ...DEFAULT_SHADER_SPEC, input: radial } }
    expect(inputKey(shaderInput)).toBe(inputKey(radial))
  })
})

describe('planFields', () => {
  it('keeps the first N distinct keys live and freezes the rest', () => {
    const keys = Array.from({ length: LIVE_FIELD_CEILING + 3 }, (_, i) => `k${i}`)
    const { live, frozen } = planFields(keys)
    expect(live.length).toBe(LIVE_FIELD_CEILING)
    expect(frozen.length).toBe(3)
  })
  it('deduplicates — ten shapes sharing one descriptor cost one live field', () => {
    const { live, frozen } = planFields(['same','same','same','same','same','same'])
    expect(live).toEqual(['same'])
    expect(frozen).toEqual([])
  })
  it('never silently truncates — every key lands in exactly one bucket', () => {
    const keys = ['a','b','c','d','e','f','g']
    const { live, frozen } = planFields(keys)
    expect([...live, ...frozen].sort()).toEqual([...new Set(keys)].sort())
  })
})
