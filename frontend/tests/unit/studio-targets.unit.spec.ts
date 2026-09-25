// frontend/tests/unit/studio-targets.unit.spec.ts
// @vitest-environment happy-dom
// The two studio effect targets (stage 5 Task 9): restore and Keep, on the Shader studio's
// layer and on Frame's background, including the `u_` ↔ unprefixed round-trip (preflight C2).
import { describe, it, expect, vi } from 'vitest'
import { backgroundShaderPaint, makeBackgroundTarget, makeLayerTarget, recordTuneVersion, specParamsFromValues } from '~/lib/shadergen/studioTargets'
import { MY_EFFECTS_ERRORS } from '~/lib/myEffects/client'
import { resolveEffectParams, unprefixedKey } from '~/lib/shaderfill/descriptor'
import { DEFAULT_SHADER_SPEC } from '~/lib/spacetype/fillTile'
import type { StudioEffect } from '~/lib/shaderstudio/types'
import type { EffectDef } from '~/lib/shaderfx/types'

const shaderBg = (over: object = {}) => ({
  type: 'shader', a: '#fff', b: '#000', textColor: '#fff', angle: 45, density: 8,
  shader: { effectId: 'aurora', params: { speed: 2 }, anchor: 'frame', speed: 0.5, seed: 7, input: '#123456', ...over },
}) as any

describe('Frame background paint', () => {
  it('a shader background keeps its input, anchor, speed and seed; only the effect and dials change', () => {
    const p = backgroundShaderPaint(shaderBg(), 'rain', { u_density: 12 }) as any
    expect(p.shader).toEqual({ effectId: 'rain', params: { density: 12 }, anchor: 'frame', speed: 0.5, seed: 7, input: '#123456' })
  })
  it('a plain background becomes the input; none starts from the default input', () => {
    expect((backgroundShaderPaint('#ff0000', 'rain', {}) as any).shader.input).toBe('#ff0000')
    const grad = { type: 'linear', stops: [{ color: '#000', pos: 0 }, { color: '#fff', pos: 1 }], angle: 90 } as any
    const withGrad = backgroundShaderPaint(grad, 'rain', {}) as any
    expect(withGrad.shader.input).toEqual(grad)
    expect(withGrad.shader.input).not.toBe(grad) // a copy, never shared
    for (const none of [undefined, 'none', '']) expect((backgroundShaderPaint(none as any, 'rain', {}) as any).shader.input).toEqual(DEFAULT_SHADER_SPEC.input)
    expect((backgroundShaderPaint('#ff0000', 'rain', {}) as any).type).toBe('shader')
  })
  it('My-effect values (u_ keys) land unprefixed in ShaderSpec.params and read back as the same values', () => {
    const values = { u_density: 12, u_tint: '#88ccff', u_ramp: [{ color: '#000', pos: 0 }, { color: '#fff', pos: 1 }] } as any
    const params = specParamsFromValues(values)
    expect(Object.keys(params)).toEqual(['density', 'tint', 'ramp'])
    // Round trip: re-prefixing gives the uniform keys back, value for value.
    const back = Object.fromEntries(Object.entries(params).map(([k, v]) => [`u_${k}`, v]))
    expect(back).toEqual(values)
    // …and the fill renderer's own reader resolves them against the effect's declared uniforms.
    const def = { id: 'rain', params: [
      { uniform: 'u_density', type: 'float', min: 1, max: 20, default: 8, label: 'D' },
      { uniform: 'u_tint', type: 'color', default: '#ffffff', label: 'T' },
    ] } as unknown as EffectDef
    const resolved = resolveEffectParams(def, params) as any
    expect(resolved[unprefixedKey('u_density')]).toBe(12)
    expect(resolved.tint).toBe('#88ccff')
    // Prefixed keys would be ignored (the dials would silently reset to their defaults).
    expect((resolveEffectParams(def, values) as any).density).toBe(8)
  })
})

describe('Frame background target', () => {
  function setup(original: any = '#ff0000') {
    const shown: any[] = []
    const commit = vi.fn()
    const snapshot = vi.fn(() => ({ id: 'artboard' }) as any)
    const t = makeBackgroundTarget({ read: () => original, show: p => shown.push(p), commit, snapshot, base: null })
    return { t, shown, commit, snapshot }
  }
  it('previews show a local overlay only; × clears it and commits nothing', () => {
    const { t, shown, commit } = setup()
    t.preview('draft_1_0'); t.preview('draft_1_1'); t.preview(null)
    expect(shown.map(s => s?.paint.shader.effectId ?? null)).toEqual(['draft_1_0', 'draft_1_1', null])
    expect(commit).not.toHaveBeenCalled()
  })
  it('Keep clears the overlay and commits once, with the kept effect and unprefixed dials', () => {
    const { t, shown, commit } = setup(shaderBg())
    t.preview('draft_1_0')
    t.apply('mine_abcdefabcdef', { u_density: 3 })
    expect(shown.at(-1)).toBeNull()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]![0].shader).toMatchObject({ effectId: 'mine_abcdefabcdef', params: { density: 3 }, seed: 7 })
  })
  it('the picture is taken once, so "Three more" after × never captures a take on screen', () => {
    const { t, snapshot } = setup()
    const a = t.image(); t.preview('draft_1_0'); const b = t.image()
    expect(b).toBe(a)
    expect(snapshot).toHaveBeenCalledTimes(1)
  })
})

describe('Shader studio layer target', () => {
  const layer = (id: string, effect = 'glow_soft'): StudioEffect => ({ layerId: id, id: effect, params: { u_amount: 0.4 }, enabled: true, blend: 'screen', opacity: 0.8 })
  function setup(o: { add?: boolean; active?: number } = {}) {
    const effects = [layer('L0'), layer('L1', 'water_ripple')]
    let active = o.active ?? 1
    const previewing: boolean[] = []
    const redraw = vi.fn()
    let n = 0
    const t = makeLayerTarget({
      effects: () => effects, active: () => active, setActive: (i) => { active = i }, add: !!o.add,
      label: 'Water ripple', base: null, newLayerId: () => `T${n++}`, previewing: on => previewing.push(on), redraw, snapshot: () => null,
    })
    return { t, effects, getActive: () => active, setActive: (i: number) => { active = i }, previewing, redraw }
  }
  it('previews on the active layer, keeping its blend, opacity and place; × restores it exactly', () => {
    const { t, effects, previewing } = setup()
    const before = JSON.parse(JSON.stringify(effects))
    t.preview('draft_1_0')
    expect(effects[1]).toMatchObject({ layerId: 'L1', id: 'draft_1_0', params: {}, blend: 'screen', opacity: 0.8 })
    t.preview(null)
    expect(effects).toEqual(before)
    expect(previewing).toEqual([true, false])
    expect(t.layerId).toBe('L1')
  })
  it('Keep writes the kept effect and its (uniform-keyed) dials onto the layer', () => {
    const { t, effects, previewing } = setup()
    t.preview('draft_1_0')
    t.apply('mine_abcdefabcdef', { u_density: 3 })
    expect(effects[1]).toMatchObject({ layerId: 'L1', id: 'mine_abcdefabcdef', params: { u_density: 3 }, blend: 'screen' })
    expect(effects).toHaveLength(2)
    expect(previewing.at(-1)).toBe(false)
  })
  it('New layer: a temporary layer at the END; × removes it; Keep keeps it and selects it', () => {
    const { t, effects, getActive } = setup({ add: true, active: 0 })
    t.preview('draft_1_0'); t.preview('draft_1_1')
    expect(effects).toHaveLength(3)
    expect(effects[2]).toMatchObject({ layerId: t.layerId, id: 'draft_1_1', enabled: true, blend: 'normal', opacity: 1 })
    t.preview(null)
    expect(effects.map(e => e.layerId)).toEqual(['L0', 'L1'])
    t.preview('draft_1_2'); t.apply('mine_abcdefabcdef', { u_density: 3 })
    expect(effects[2]).toMatchObject({ id: 'mine_abcdefabcdef', params: { u_density: 3 } })
    expect(getActive()).toBe(2)
  })
  it('New layer: × after selecting the temporary layer goes back to the layer that was active', () => {
    const { t, effects, getActive, setActive } = setup({ add: true, active: 0 })
    t.preview('draft_1_0')
    setActive(2)
    t.preview(null)
    expect(effects).toHaveLength(2)
    expect(getActive()).toBe(0)
  })
})

describe('a kept Tune take on a My effect', () => {
  const rec = (n: number) => ({ id: 'mine_abcdefabcdef', name: 'Rain', versions: Array.from({ length: n }, (_, i) => ({ label: `v${i + 1}` })) }) as any
  it('becomes a dial version, and says so plainly', async () => {
    const add = vi.fn(async () => rec(2)); const notify = vi.fn()
    await recordTuneVersion({ effectId: 'mine_abcdefabcdef~v1', params: { u_density: 3 }, request: 'denser', add, notify })
    // The target's own pinned id: My effects decides whether it is the newest code (use-my-effects spec).
    expect(add).toHaveBeenCalledWith('mine_abcdefabcdef~v1', { u_density: 3 }, 'denser')
    expect(notify).toHaveBeenCalledWith('notice', 'Saved as v2 of “Rain”. Earlier versions are kept.')
  })
  it('a take that changes no dial adds nothing and says nothing', async () => {
    const notify = vi.fn()
    await recordTuneVersion({ effectId: 'mine_abcdefabcdef', params: {}, request: 'x', add: vi.fn(async () => null), notify })
    expect(notify).not.toHaveBeenCalled()
  })
  it('a failed save says why in a plain sentence (never raw error text)', async () => {
    const notify = vi.fn()
    await recordTuneVersion({ effectId: 'mine_abcdefabcdef', params: {}, request: 'x', add: vi.fn(async () => { throw new Error(MY_EFFECTS_ERRORS.gone) }), notify })
    expect(notify).toHaveBeenCalledWith('error', MY_EFFECTS_ERRORS.gone)
    await recordTuneVersion({ effectId: 'mine_abcdefabcdef', params: {}, request: 'x', add: vi.fn(async () => { throw new Error('ECONNRESET 10.0.0.1') }), notify })
    expect(notify).toHaveBeenLastCalledWith('error', `${MY_EFFECTS_ERRORS.save} Try again in a moment.`)
  })
  it('built-in effects are left alone', async () => {
    const add = vi.fn(async () => rec(2))
    await recordTuneVersion({ effectId: 'glow_soft', params: {}, request: 'x', add, notify: vi.fn() })
    expect(add).not.toHaveBeenCalled()
  })
})
