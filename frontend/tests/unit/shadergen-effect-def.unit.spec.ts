import { describe, expect, it } from 'vitest'
import { assembleSource } from '~~/shared/shadergen/contract'
import { resolveUniforms } from '~/lib/shaderfx/params'
import { toEffectDef } from '~/lib/shadergen/effectDef'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

describe('toEffectDef', () => {
  it('turns a take into an EffectDef the existing renderer and params code accept', () => {
    const take = SPIKE_TAKES.lava![0]!
    const def = toEffectDef(take, 'gen_1')
    expect(def).toMatchObject({ id: 'gen_1', name: take.name, category: 'mine', passes: 1, centerParam: null, textures: [], animated: take.animated, generative: take.generative })
    expect(def.source).toBe(assembleSource(take.body))
    const u = resolveUniforms(def, {})
    expect(u.u_blob).toEqual([1, 90 / 255, 31 / 255])
    expect(typeof u.u_speed).toBe('number')
  })
})
