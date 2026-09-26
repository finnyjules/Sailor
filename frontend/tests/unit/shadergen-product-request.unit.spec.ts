// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { baseFromEffect, imageForModel, placeholderSource, PRODUCT_IMAGE_EDGE, productEngineInput, productExamples, targetContext } from '~/lib/shadergen/productRequest'
import { FOGGED_GLASS, SUMINAGASHI } from '~/lib/shadergen/productExamples'
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
  it('a reference picture goes second, after the picture the effect runs over, and the prompt is told so', async () => {
    const input = await productEngineInput({ request: 'rain', base: null, image: 'data:image/jpeg;base64,SRC', reference: 'data:image/jpeg;base64,REF' })
    expect(input.images).toEqual(['data:image/jpeg;base64,SRC', 'data:image/jpeg;base64,REF'])
    expect(input.referencePicture).toBe(2)
  })
  it('a reference with no source picture is the only picture', async () => {
    const input = await productEngineInput({ request: 'rain', base: null, image: null, reference: 'data:image/jpeg;base64,REF' })
    expect(input.images).toEqual(['data:image/jpeg;base64,REF'])
    expect(input.referencePicture).toBe(1)
  })
  it('no reference: no reference picture', async () => {
    expect((await productEngineInput({ request: 'rain', base: null, image: 'data:image/jpeg;base64,SRC' })).referencePicture).toBeUndefined()
  })
  it('no source picture → the prompt is told so (a standalone effect); a source picture → not', async () => {
    expect((await productEngineInput({ request: 'rain', base: null, image: null })).noSourcePicture).toBe(true)
    expect((await productEngineInput({ request: 'rain', base: null, image: null, reference: 'data:image/jpeg;base64,REF' })).noSourcePicture).toBe(true)
    expect((await productEngineInput({ request: 'rain', base: null, image: 'data:image/jpeg;base64,SRC' })).noSourcePicture).toBeUndefined()
    expect((await productEngineInput({ request: 'rain', base: null, image: 'data:image/jpeg;base64,SRC', reference: 'data:image/jpeg;base64,REF' })).noSourcePicture).toBeUndefined()
  })
  it('examples are rain take 3 and ink take 4, rewritten to loop: same names and dials, motion on the loop helpers', async () => {
    const ex = await productExamples()
    expect(ex.map(e => e.take)).toEqual([FOGGED_GLASS, SUMINAGASHI])
    expect(ex.map(e => e.request)).toEqual(['Turn this into rain on a window', 'Ink bleeding into wet paper'])
    const spike = [SPIKE_TAKES.rain![2]!, SPIKE_TAKES.ink![3]!]
    ex.forEach((e, i) => {
      expect(e.take.name).toBe(spike[i]!.name)
      expect(e.take.generative).toBe(spike[i]!.generative)
      expect(e.take.params.map(p => [p.uniform, p.label, p.type])).toEqual(spike[i]!.params.map(p => [p.uniform, p.label, p.type]))
    })
    // One reads the picture, one stands alone: both kinds are shown.
    expect(ex.map(e => e.take.generative)).toEqual([false, true])
  })
  it('the spike fixture is left as it was (raw u_time)', () => {
    expect(SPIKE_TAKES.rain![2]!.body).toMatch(/\bu_time\b/)
  })
  it('a My effect base brings the request that first made it and the effect it was made from', () => {
    const b = baseFromEffect(def({ id: 'mine_abcdefabcdef~v2', name: 'Prism drift', mine: true, from: 'Prism', versions: [
      { label: 'v1', note: '  thin prism light beams  ', effectId: 'mine_abcdefabcdef~v1', values: {} },
      { label: 'v2', note: 'slower', effectId: 'mine_abcdefabcdef~v2', values: {} },
    ] }))!
    expect(b.request).toBe('thin prism light beams')
    expect(b.from).toBe('Prism')
    // A built-in effect has neither.
    const builtIn = baseFromEffect(def())!
    expect(builtIn.request).toBeUndefined()
    expect(builtIn.from).toBeUndefined()
  })
  it('the target: where the takes will live and the picture’s aspect go to the engine', async () => {
    const input = await productEngineInput({ request: 'rain', base: null, image: 'data:image/jpeg;base64,AAA', target: { place: 'frame-background', aspect: 0.8 } })
    expect(input.target).toEqual({ place: 'frame-background', aspect: 0.8 })
    expect((await productEngineInput({ request: 'rain', base: null, image: null })).target).toBeUndefined()
  })
  it('targetContext: a studio or Frame key names its place, anything else is a canvas node; the aspect comes from the picture', () => {
    expect(targetContext('shader-studio', { width: 1600, height: 900 } as any)).toEqual({ place: 'shader-studio', aspect: 1600 / 900 })
    expect(targetContext('frame-background', { naturalWidth: 1080, naturalHeight: 1350, width: 10, height: 10 } as any)).toEqual({ place: 'frame-background', aspect: 0.8 })
    expect(targetContext('node_42', null)).toEqual({ place: 'canvas-node' })
    expect(targetContext('node_42', { width: 0, height: 0 } as any)).toEqual({ place: 'canvas-node' })
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
