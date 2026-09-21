// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { EffectDef } from '~/lib/shaderfx/types'

/**
 * An effect's manifest can declare TEXTURES (the ASCII effect's glyph sheet, with
 * its companion `u_glyphCount`/`u_glyphRows`). The Shader Studio path loads them;
 * `field.ts` — the path every Frame layer effect, Space Type fill, Shape Studio and
 * Scene3D material goes through — passed `undefined` for textures and never emitted
 * the companion numbers, so the ASCII shapes that sample the atlas (Hash, Matrix,
 * Binary, Braille, Morse, Dots, Slashes) drew NOTHING there. This pins the fix.
 *
 * No GL: `shaderFx.render` is stubbed so the passes `buildPasses` produced can be
 * read straight off the spy, and the catalog store is mocked so `resolve()` finds an
 * effect def synchronously. `Image` is replaced with a fake whose load is driven by
 * hand, since happy-dom never actually fetches `/sailor/shader_effects/assets/...`.
 */

const { renderSpy, EFFECTS } = vi.hoisted(() => ({
  renderSpy: vi.fn(() => ({ tag: 'rendered-canvas' } as unknown as HTMLCanvasElement)),
  EFFECTS: {} as Record<string, EffectDef>,
}))

vi.mock('~/lib/shaderfx/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/shaderfx/renderer')>()
  return { ...actual, shaderFx: { render: renderSpy } }
})

// resolveField paints its input tile through a real 2D context, which this environment
// does not have; the cache behaviour under test does not depend on the tile's pixels.
vi.mock('~/lib/compositor/paint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/compositor/paint')>()
  return { ...actual, paintTileBox: () => {} }
})

vi.mock('~/lib/shaderfx/catalogStore', () => ({
  getEffectSync: (id: string) => EFFECTS[id] ?? null,
  refetchShaderFxCatalog: () => null,
}))

import { renderFieldWithBase, fieldEffectReady, whenFieldEffectReady, onFieldCatalogReady, resolveField, fieldStats, clearFieldCache } from '~/lib/shaderfill/field'

// --- the fake Image ---------------------------------------------------------

class FakeImage {
  static created: FakeImage[] = []
  crossOrigin = ''
  complete = false
  naturalWidth = 0
  naturalHeight = 0
  private _src = ''
  private handlers: Record<string, Array<() => void>> = {}
  constructor() { FakeImage.created.push(this) }
  get src(): string { return this._src }
  set src(v: string) { this._src = v }
  addEventListener(type: string, cb: () => void): void { (this.handlers[type] ??= []).push(cb) }
  /** Drive the load the way the browser would. */
  land(): void {
    this.complete = true
    this.naturalWidth = 128
    this.naturalHeight = 96
    for (const cb of this.handlers.load ?? []) cb()
  }
}

let realImage: unknown
beforeAll(() => {
  realImage = (globalThis as any).Image
  ;(globalThis as any).Image = FakeImage
})
afterAll(() => {
  ;(globalThis as any).Image = realImage
})

beforeEach(() => {
  renderSpy.mockClear()
  FakeImage.created.length = 0
})

// --- effect fixtures --------------------------------------------------------
// Each test uses its OWN texture file name: field.ts's image cache is module-level
// and keyed on file+v (that is the point — one Image, one GL texture, shared by
// every effect and every frame), so it deliberately survives between tests.

function defWith(id: string, textures: EffectDef['textures']): EffectDef {
  const d: EffectDef = {
    id, name: id, category: 'stylize', animated: true, passes: 1,
    centerParam: null, textures, params: [], source: '#version 300 es\nvoid main(){}',
  }
  EFFECTS[id] = d
  return d
}

const specFor = (id: string) => ({ effectId: id, params: {}, anchor: 'object', speed: 1, seed: 0, input: '#000000' } as any)

function render(id: string, extra?: Record<string, number>, variant?: string) {
  const base = document.createElement('canvas')
  base.width = 8; base.height = 8
  return renderFieldWithBase(specFor(id), base, 8, 8, undefined, 0, extra, variant)
}

const lastPass = () => renderSpy.mock.calls.at(-1)![0][0]

describe('buildPasses — declared textures on the field path', () => {
  it('binds nothing and emits no companion uniforms before the image has loaded', () => {
    defWith('atlas_pending', [{ uniform: 'u_glyphs', file: 'pending_atlas.png', v: '1', extraUniforms: { u_glyphCount: 10, u_glyphRows: 7 } }])

    render('atlas_pending')

    expect(lastPass().textures).toBeUndefined()
    expect(lastPass().uniforms.u_glyphCount).toBeUndefined()
    expect(lastPass().uniforms.u_glyphRows).toBeUndefined()
    // …but the load was kicked, so the very next frames can bind it.
    expect(FakeImage.created).toHaveLength(1)
    expect(FakeImage.created[0]!.src).toBe('/sailor/shader_effects/assets/pending_atlas.png?v=1')
    expect(FakeImage.created[0]!.crossOrigin).toBe('anonymous')
  })

  it('binds the SAME image object on consecutive calls once it has loaded, with the manifest numbers', () => {
    defWith('atlas_loaded', [{ uniform: 'u_glyphs', file: 'loaded_atlas.png', v: '2', extraUniforms: { u_glyphCount: 10, u_glyphRows: 7 } }])

    render('atlas_loaded')
    expect(FakeImage.created).toHaveLength(1)
    FakeImage.created[0]!.land()

    render('atlas_loaded')
    const first = lastPass()
    render('atlas_loaded')
    const second = lastPass()

    expect(first.textures!.u_glyphs).toBeInstanceOf(FakeImage)
    // Identity, not equality: the renderer's extra-texture cache is keyed on the
    // source object (renderer.ts, `extraTexCache`), so a fresh Image per frame would
    // re-upload the atlas every frame and churn a bounded GL cache.
    expect(second.textures!.u_glyphs).toBe(first.textures!.u_glyphs)
    expect(first.uniforms.u_glyphCount).toBe(10)
    expect(first.uniforms.u_glyphRows).toBe(7)
    // Only ever one Image for this file.
    expect(FakeImage.created).toHaveLength(1)
  })

  it('leaves an effect with no declared textures exactly as it was', () => {
    defWith('no_textures', [])
    render('no_textures')
    expect(lastPass().textures).toBeUndefined()
    expect(FakeImage.created).toHaveLength(0)
  })
})

describe('fieldEffectReady', () => {
  it('is false (and kicks nothing but the catalogue) for an effect that is not in the catalogue', () => {
    expect(fieldEffectReady('never_heard_of_it')).toBe(false)
    expect(FakeImage.created).toHaveLength(0)
  })

  it('is true immediately for an effect with no textures', () => {
    defWith('ready_no_tex', [])
    expect(fieldEffectReady('ready_no_tex')).toBe(true)
  })

  it('is false until the texture lands, and starts exactly ONE load however often it is called', () => {
    defWith('ready_atlas', [{ uniform: 'u_glyphs', file: 'ready_atlas.png', v: '3', extraUniforms: { u_glyphCount: 10 } }])

    for (let i = 0; i < 20; i++) expect(fieldEffectReady('ready_atlas')).toBe(false)
    expect(FakeImage.created).toHaveLength(1)

    FakeImage.created[0]!.land()
    expect(fieldEffectReady('ready_atlas')).toBe(true)
    expect(FakeImage.created).toHaveLength(1)
  })

  it('notifies the catalogue-ready subscribers when a texture lands', () => {
    defWith('notify_atlas', [{ uniform: 'u_glyphs', file: 'notify_atlas.png', v: '4' }])
    const cb = vi.fn()
    const unsub = onFieldCatalogReady(cb)

    expect(fieldEffectReady('notify_atlas')).toBe(false)
    expect(cb).not.toHaveBeenCalled()

    FakeImage.created[0]!.land()
    expect(cb).toHaveBeenCalledTimes(1)

    unsub()
  })

  it('does not throw where there is no Image constructor at all', () => {
    defWith('no_dom_atlas', [{ uniform: 'u_glyphs', file: 'no_dom_atlas.png', v: '5' }])
    const saved = (globalThis as any).Image
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).Image
    try {
      expect(fieldEffectReady('no_dom_atlas')).toBe(false)
      expect(() => render('no_dom_atlas')).not.toThrow()
      expect(lastPass().textures).toBeUndefined()
    } finally {
      ;(globalThis as any).Image = saved
    }
  })
})

describe('renderFieldWithBase — extraUniforms', () => {
  it('reach every pass and override a same-named effect uniform', () => {
    const d = defWith('extra_uniforms', [])
    d.passes = 2

    // u_seed is written by buildPasses from spec.seed (0) — the override has to win,
    // the way shape.uniforms does, or the compositor cannot set a switch the effect
    // itself also writes.
    render('extra_uniforms', { u_matte: 1, u_seed: 42 })

    const passes = renderSpy.mock.calls.at(-1)![0]
    expect(passes).toHaveLength(2)
    for (const p of passes) {
      expect(p.uniforms.u_matte).toBe(1)
      expect(p.uniforms.u_seed).toBe(42)
    }
  })

  it('omitted, leaves the passes exactly as they were', () => {
    defWith('extra_none', [])
    render('extra_none')
    const without = JSON.stringify(renderSpy.mock.calls.at(-1)![0])
    render('extra_none', {})
    expect(JSON.stringify(renderSpy.mock.calls.at(-1)![0])).toBe(without)
  })
})

/**
 * `fieldEffectReady` is the per-frame poll; this is the one-shot AWAIT a host with no frame
 * loop needs — an export, which must not start painting in one look and finish in another
 * because the glyph atlas landed half way through.
 */
describe('whenFieldEffectReady', () => {
  it('resolves true immediately when the effect is already ready', async () => {
    defWith('when_ready', [])
    await expect(whenFieldEffectReady('when_ready', 1000)).resolves.toBe(true)
  })

  it('resolves true as soon as the texture lands, and leaves no timer behind', async () => {
    vi.useFakeTimers()
    try {
      defWith('when_atlas', [{ uniform: 'u_glyphs', file: 'when_atlas.png', v: '11' }])
      const p = whenFieldEffectReady('when_atlas', 5000)
      expect(FakeImage.created).toHaveLength(1)   // the wait KICKED the load
      expect(vi.getTimerCount()).toBe(1)
      FakeImage.created[0]!.land()
      await expect(p).resolves.toBe(true)
      expect(vi.getTimerCount()).toBe(0)          // the timeout was cleared
    } finally { vi.useRealTimers() }
  })

  it('resolves false on timeout — never rejects — and unsubscribes', async () => {
    vi.useFakeTimers()
    try {
      defWith('when_never', [{ uniform: 'u_glyphs', file: 'when_never.png', v: '12' }])
      const p = whenFieldEffectReady('when_never', 1000)
      let settled: unknown = 'pending'
      p.then((v) => { settled = v }, () => { settled = 'rejected' })
      vi.advanceTimersByTime(999)
      await Promise.resolve()
      expect(settled).toBe('pending')
      vi.advanceTimersByTime(1)
      await expect(p).resolves.toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      // The subscription is gone with it: a late landing neither throws nor re-resolves.
      expect(() => FakeImage.created.at(-1)!.land()).not.toThrow()
      expect(settled).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('one waiter landing does not disturb another still waiting', async () => {
    vi.useFakeTimers()
    try {
      defWith('when_a', [{ uniform: 'u_glyphs', file: 'when_a.png', v: '13' }])
      defWith('when_b', [{ uniform: 'u_glyphs', file: 'when_b.png', v: '14' }])
      const a = whenFieldEffectReady('when_a', 5000)
      const b = whenFieldEffectReady('when_b', 5000)
      const imgA = FakeImage.created.find(i => i.src.includes('when_a.png'))!
      imgA.land()
      await expect(a).resolves.toBe(true)
      let bSettled: unknown = 'pending'
      b.then((v) => { bSettled = v })
      await Promise.resolve()
      expect(bSettled).toBe('pending')
      FakeImage.created.find(i => i.src.includes('when_b.png'))!.land()
      await expect(b).resolves.toBe(true)
    } finally { vi.useRealTimers() }
  })
})

/**
 * A build VARIANT: the same .frag compiled with a preprocessor macro defined, cached as its
 * own program. This is what keeps the ASCII shader's classic program byte-identical to the
 * pre-matte one (see ascii-dither-matte.unit.spec.ts) while the compositor's dither
 * transition gets its matte path.
 */
describe('renderFieldWithBase — a build variant', () => {
  it('injects the #define on the line AFTER #version and caches under its own pass id', () => {
    defWith('variant_effect', [])
    render('variant_effect', { u_matte: 1 }, 'MATTE')
    const pass = lastPass()
    // #version MUST stay the very first line of a GLSL ES 3.00 shader.
    expect(pass.source.split('\n')[0]).toBe('#version 300 es')
    expect(pass.source.split('\n')[1]).toBe('#define SAILOR_MATTE 1')
    expect(pass.source).toContain('void main(){}')
    expect(pass.id).toBe('variant_effect#MATTE')
  })

  it('every pass of a multi-pass effect carries it', () => {
    const d = defWith('variant_multi', [])
    d.passes = 3
    render('variant_multi', undefined, 'MATTE')
    const passes = renderSpy.mock.calls.at(-1)![0]
    expect(passes).toHaveLength(3)
    for (const p of passes) {
      expect(p.id).toBe('variant_multi#MATTE')
      expect(p.source).toContain('#define SAILOR_MATTE 1')
    }
  })

  it('omitted, the passes are exactly what they were — same id, same source', () => {
    defWith('variant_none', [])
    render('variant_none')
    const pass = lastPass()
    expect(pass.id).toBe('variant_none')
    expect(pass.source).toBe('#version 300 es\nvoid main(){}')
  })

  it('a source with no #version line gets the define first rather than losing it', () => {
    const d = defWith('variant_noversion', [])
    d.source = 'void main(){}'
    render('variant_noversion', undefined, 'MATTE')
    expect(lastPass().source).toBe('#define SAILOR_MATTE 1\nvoid main(){}')
  })
})

describe('a cached field does not outlive the texture it was rendered without', () => {
  it('resolveField re-renders after the atlas lands instead of serving the blank from cache', () => {
    defWith('cache_atlas', [{ uniform: 'u_glyphs', file: 'cache_atlas.png', v: '9', extraUniforms: { u_glyphCount: 10 } }])
    clearFieldCache()
    // resolveField copies the render into its own cache canvas; give canvases a do-nothing
    // 2D context for the length of this test (the environment has none).
    const noop2d = new Proxy({}, { get: () => () => {}, set: () => true })
    const proto = (document.createElement('canvas') as any).constructor.prototype
    const realGetContext = proto.getContext
    proto.getContext = () => noop2d
    try {
    const req = { spec: specFor('cache_atlas'), w: 32, h: 32, t: 0, fps: 30 }
    resolveField(req)
    resolveField(req)
    const before = fieldStats().renders
    expect(before).toBe(1)                          // second call was a cache hit
    FakeImage.created.at(-1)!.land()
    resolveField(req)
    expect(fieldStats().renders).toBe(before + 1)   // the blank was dropped, not served
    } finally { proto.getContext = realGetContext }
  })
})
