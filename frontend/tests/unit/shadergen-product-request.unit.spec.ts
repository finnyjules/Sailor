// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { baseFromEffect, productEngineInput, productExamples } from '~/lib/shadergen/productRequest'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'
import type { EffectDef } from '~/lib/shaderfx/types'

const def = (over: Partial<EffectDef> = {}): EffectDef => ({
  id: 'water_ripple', name: 'Water ripple', category: 'distortion', animated: true, passes: 1, centerParam: null, textures: [],
  source: '#version 300 es\nvoid main(){}', params: [
    { uniform: 'u_amount', label: 'Amount', type: 'float', min: 0, max: 1, default: 0.5 },
    { uniform: 'u_ramp', label: 'Ramp', type: 'gradient', default: [] as any },
  ], ...over,
})

describe('product request (spec §7.2 decision)', () => {
  it('three takes, the picture, two fixed examples, no review lever', async () => {
    const input = await productEngineInput({ request: 'rain', base: null, image: 'data:image/jpeg;base64,AAA' })
    expect(input.count).toBe(3)
    expect(input.images).toEqual(['data:image/jpeg;base64,AAA'])
    expect(input.examples).toHaveLength(2)
    expect(input.revise).toBeFalsy()
    expect(input.references).toBeUndefined()
  })
  it('no picture → no images', async () => {
    expect((await productEngineInput({ request: 'rain', base: null, image: null })).images).toBeUndefined()
  })
  it('examples are rain take 3 and ink take 4', async () => {
    const ex = await productExamples()
    expect(ex.map(e => e.take)).toEqual([SPIKE_TAKES.rain![2], SPIKE_TAKES.ink![3]])
  })
  it('a remix base keeps only the dial types the contract knows', () => {
    const b = baseFromEffect(def())!
    expect(b.name).toBe('Water ripple')
    expect(b.params.map(p => p.uniform)).toEqual(['u_amount'])
  })
  it('a draft or no effect is no base', () => {
    expect(baseFromEffect(null)).toBeNull()
    expect(baseFromEffect(def({ draft: true } as any))).toBeNull()
  })
})
