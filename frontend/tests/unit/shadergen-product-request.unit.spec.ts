// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { baseFromEffect, imageForModel, placeholderSource, PRODUCT_IMAGE_EDGE, productEngineInput, productExamples } from '~/lib/shadergen/productRequest'
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

describe('the picture the model sees (imageForModel) and the neutral stand-in (placeholderSource)', () => {
  afterEach(() => { vi.restoreAllMocks() })
  /** A 2D canvas stand-in: happy-dom has no 2D context of its own. */
  function fakeCanvases(o: { toDataURL?: () => string; ctx?: boolean } = {}) {
    const made: any[] = []
    const real = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return real(tag)
      const ctx = { drawImage: vi.fn(), createLinearGradient: () => ({ addColorStop: vi.fn() }), fillRect: vi.fn(), fillStyle: '' }
      const c = { width: 0, height: 0, getContext: () => (o.ctx === false ? null : ctx), toDataURL: o.toDataURL ?? (() => 'data:image/jpeg;base64,X'), ctx }
      made.push(c)
      return c
    }) as any)
    return made
  }

  it('no picture, or one with no size, sends none', () => {
    expect(imageForModel(null)).toBeNull()
    expect(imageForModel({ width: 0, height: 0 } as any)).toBeNull()
  })

  it('scales the long edge down to the product size, keeping the aspect, as a JPEG', () => {
    const made = fakeCanvases()
    expect(imageForModel({ naturalWidth: 2048, naturalHeight: 1024 } as any)).toBe('data:image/jpeg;base64,X')
    expect([made[0].width, made[0].height]).toEqual([PRODUCT_IMAGE_EDGE, PRODUCT_IMAGE_EDGE / 2])
    expect(made[0].ctx.drawImage).toHaveBeenCalledTimes(1)
  })

  it('never scales a small picture up', () => {
    const made = fakeCanvases()
    imageForModel({ width: 200, height: 100 } as any)
    expect([made[0].width, made[0].height]).toEqual([200, 100])
  })

  it('a tainted canvas (or no 2D context) sends no picture rather than failing the set', () => {
    fakeCanvases({ toDataURL: () => { throw new Error('SecurityError') } })
    expect(imageForModel({ width: 100, height: 100 } as any)).toBeNull()
    vi.restoreAllMocks()
    fakeCanvases({ ctx: false })
    expect(imageForModel({ width: 100, height: 100 } as any)).toBeNull()
  })

  it('the placeholder is one 256×256 canvas, made once', () => {
    fakeCanvases()
    const a = placeholderSource()
    expect([a.width, a.height]).toEqual([256, 256])
    expect(placeholderSource()).toBe(a)
  })
})
