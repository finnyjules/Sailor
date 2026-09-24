// @vitest-environment happy-dom
//
// Unit coverage for the three correctness gaps closed in
// ~/lib/embed/surfaces/spacetype.ts (font resolution, gradient passthrough,
// post-processing passthrough). buildTexOpts is pure (no DOM, no THREE, no
// engine instance) so the font/gradient gaps are asserted directly against
// it, at plain 'node' semantics. The post gap needs mount() itself (it calls
// engine.setPost()), which needs `document` — hence the happy-dom pragma —
// but SpaceTypeEngine is mocked out entirely so no real WebGL context is
// ever requested; happy-dom does not implement one.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildTexOpts } from '~/lib/embed/surfaces/spacetype'
import { SPACE_TYPE_EFFECTS } from '~/lib/spacetype/effects/index'
import { resolveFontFamily } from '~/lib/font/resolveFamily'
import { DEFAULT_POST } from '~/lib/spacetype/postSettings'
import type { Params } from '~/lib/spacetype/effect'

const ribbon = SPACE_TYPE_EFFECTS.find(e => e.id === 'ribbon')!

describe('buildTexOpts — font resolution (Gap 1)', () => {
  // The exact scenario the report describes: a legacy id stored in
  // params.font, no pre-resolved `font` from the export pipeline. 12 of the
  // 25 effects (cascade.ts, cylinder.ts, spiral.ts, ...) independently call
  // resolveFontFamily(String(params.font)) to build their own glyph
  // textures — the adapter must resolve the SAME family for the SAME config,
  // or the exported text renders in a silently-substituted fallback font
  // that doesn't match what the effect's own texture used.
  it('resolves a legacy font id the same way the font-aware effects do, when font is null', () => {
    const params: Params = { text: 'HELLO', font: 'inter', typeWeight: 700 }
    const texOpts = buildTexOpts(ribbon, params, null, [])
    // Assert against the real resolver, not a hardcoded 'Inter' literal, so
    // this test tracks the resolver's actual behaviour rather than duplicating it.
    expect(texOpts.fontFamily).toBe(resolveFontFamily('inter'))
    expect(texOpts.fontFamily).toBe('Inter')
    // The old behaviour ('inter' passed straight through) is not a real CSS
    // family name — pin that it's gone.
    expect(texOpts.fontFamily).not.toBe('inter')
  })

  it('still trusts a pre-resolved font from the export pipeline over params.font', () => {
    const params: Params = { text: 'HELLO', font: 'inter', typeWeight: 700 }
    const texOpts = buildTexOpts(ribbon, params, { family: 'Custom Uploaded Font', weight: 550 }, [])
    expect(texOpts.fontFamily).toBe('Custom Uploaded Font')
    expect(texOpts.fontWeight).toBe(550)
  })

  it('a family name already matching a real family passes through unchanged', () => {
    const params: Params = { text: 'HELLO', font: 'Fraunces', typeWeight: 600 }
    const texOpts = buildTexOpts(ribbon, params, null, [])
    expect(texOpts.fontFamily).toBe('Fraunces')
  })
})

describe('buildTexOpts — gradient stops passthrough (Gap 2)', () => {
  it('folds the config gradientStops into the texture options when gradientMode is on', () => {
    const stops = [{ color: '#ff0000', on: true }, { color: '#00ff00', on: false }]
    const params: Params = { text: 'HELLO', font: 'Inter', gradientMode: 'on' }
    const texOpts = buildTexOpts(ribbon, params, null, stops)
    expect(texOpts.gradientStops).toEqual(stops)
    expect(texOpts.gradientOn).toBe(true)
  })

  it('is a copy, not the same array reference (matches texOptsFromState`s .map(g => ({...g}))', () => {
    const stops = [{ color: '#ff0000', on: true }]
    const params: Params = { text: 'HELLO', font: 'Inter', gradientMode: 'on' }
    const texOpts = buildTexOpts(ribbon, params, null, stops)
    expect(texOpts.gradientStops).not.toBe(stops)
    expect(texOpts.gradientStops![0]).not.toBe(stops[0])
  })

  it('is off when gradientMode is not "on", even if stops are present', () => {
    const stops = [{ color: '#ff0000', on: true }]
    const params: Params = { text: 'HELLO', font: 'Inter', gradientMode: 'off' }
    const texOpts = buildTexOpts(ribbon, params, null, stops)
    expect(texOpts.gradientOn).toBe(false)
  })

  it('defaults to empty/off when the config carries no gradientStops (older configs)', () => {
    const params: Params = { text: 'HELLO', font: 'Inter' }
    const texOpts = buildTexOpts(ribbon, params, null, [])
    expect(texOpts.gradientStops).toEqual([])
    expect(texOpts.gradientOn).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Gap 3 — post-processing passthrough. Needs mount() itself, which needs
// `document`; SpaceTypeEngine is mocked so no real WebGL context is ever
// requested.
const setPostSpy = vi.fn()
const buildSpy = vi.fn()
const renderFrameAtSpy = vi.fn()

vi.mock('~/lib/spacetype/engine', () => {
  class FakeSpaceTypeEngine {
    setPost = setPostSpy
    build = buildSpy
    renderFrameAt = renderFrameAtSpy
    setSize = vi.fn()
    dispose = vi.fn()
    constructor(_canvas: unknown, _opts: unknown) {}
  }
  return { SpaceTypeEngine: FakeSpaceTypeEngine }
})

function baseConfig(extra: Record<string, unknown> = {}) {
  return {
    effectId: 'ribbon',
    params: { text: 'HELLO', font: 'Inter' },
    opts: { width: 100, height: 100, fps: 30, loopDuration: 4, alpha: false, bgColor: '#000000' },
    duration: 4,
    font: null,
    ...extra,
  }
}

describe('spacetype embed adapter mount() — post-processing passthrough (Gap 3)', () => {
  beforeEach(() => {
    setPostSpy.mockClear()
    buildSpy.mockClear()
    renderFrameAtSpy.mockClear()
  })

  it('calls engine.setPost with the config-supplied post settings', async () => {
    const { default: spaceTypeEmbedSurface } = await import('~/lib/embed/surfaces/spacetype')
    const post = { ...DEFAULT_POST, bloom: true, bloomStrength: 1.2 }
    const container = document.createElement('div')
    await spaceTypeEmbedSurface.mount(container, baseConfig({ post }))
    expect(setPostSpy).toHaveBeenCalledTimes(1)
    expect(setPostSpy).toHaveBeenCalledWith(post)
  })

  it('defaults to DEFAULT_POST (all off) when the config carries no post field, preserving old behaviour', async () => {
    const { default: spaceTypeEmbedSurface } = await import('~/lib/embed/surfaces/spacetype')
    const container = document.createElement('div')
    await spaceTypeEmbedSurface.mount(container, baseConfig())
    expect(setPostSpy).toHaveBeenCalledTimes(1)
    expect(setPostSpy).toHaveBeenCalledWith(DEFAULT_POST)
  })

  it('calls setPost before the first build/render so the initial frame reflects it', async () => {
    const { default: spaceTypeEmbedSurface } = await import('~/lib/embed/surfaces/spacetype')
    const container = document.createElement('div')
    await spaceTypeEmbedSurface.mount(container, baseConfig({ post: { ...DEFAULT_POST, bloom: true } }))
    const setPostOrder = setPostSpy.mock.invocationCallOrder[0]!
    const buildOrder = buildSpy.mock.invocationCallOrder[0]!
    const renderOrder = renderFrameAtSpy.mock.invocationCallOrder[0]!
    expect(setPostOrder).toBeLessThan(buildOrder)
    expect(setPostOrder).toBeLessThan(renderOrder)
  })
})

// ---------------------------------------------------------------------------
// Seamless loops: a config's `loops` (the studio's seamless k) stretches one embed pass
// over k base loops — setTime(t01) draws renderFrameAt(t01 * loops). Absent = 1, so every
// config saved before the field (and every non-seamless piece) plays exactly as before.
describe('spacetype embed adapter setTime() — seamless loops', () => {
  beforeEach(() => renderFrameAtSpy.mockClear())

  it('with loops: 3, setTime(0.5) draws base-loop position 1.5', async () => {
    const { default: spaceTypeEmbedSurface } = await import('~/lib/embed/surfaces/spacetype')
    const cfg = baseConfig({ loops: 3 })
    const handle = await spaceTypeEmbedSurface.mount(document.createElement('div'), cfg)
    renderFrameAtSpy.mockClear()
    handle.setTime(0.5)
    expect(renderFrameAtSpy).toHaveBeenCalledTimes(1)
    expect(renderFrameAtSpy).toHaveBeenCalledWith(1.5, cfg.params)
  })

  it('without loops, setTime(0.5) draws 0.5 (unchanged)', async () => {
    const { default: spaceTypeEmbedSurface } = await import('~/lib/embed/surfaces/spacetype')
    const cfg = baseConfig()
    const handle = await spaceTypeEmbedSurface.mount(document.createElement('div'), cfg)
    renderFrameAtSpy.mockClear()
    handle.setTime(0.5)
    expect(renderFrameAtSpy).toHaveBeenCalledWith(0.5, cfg.params)
  })

  it('the mount frame is still base position 0', async () => {
    const { default: spaceTypeEmbedSurface } = await import('~/lib/embed/surfaces/spacetype')
    renderFrameAtSpy.mockClear()
    await spaceTypeEmbedSurface.mount(document.createElement('div'), baseConfig({ loops: 3 }))
    expect(renderFrameAtSpy).toHaveBeenCalledWith(0, expect.anything())
  })
})

// ---------------------------------------------------------------------------
// Faces in one document (final review C-1 and I-1). In a Frame export several players — and the
// Frame's own text — share one document; during the in-app poster bake that document is the app.
// Each inlined face is declared under its private name (privateFontFamily), held by every mount
// that uses it, and removed when the last one is destroyed.
describe('spacetype embed adapter — faces in a shared document', () => {
  const FACE_A = { family: 'Work Sans', weight: 700, dataUrl: 'data:font/ttf;base64,Q0FGRQ==' }      // "CAFE" subset
  const FACE_B = { family: 'Work Sans', weight: 700, dataUrl: 'data:font/ttf;base64,Q0FGw4k=' }      // "CAFÉ" subset
  const faceStyles = () => [...document.head.querySelectorAll('style[data-sailor-embed-font]')] as HTMLStyleElement[]

  beforeEach(() => {
    buildSpy.mockClear()
    for (const el of faceStyles()) el.remove()
    // happy-dom has no FontFaceSet; the adapter only awaits it.
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: vi.fn(async () => []), ready: Promise.resolve() },
    })
  })

  async function mountWith(face: typeof FACE_A, text: string) {
    const { default: surface } = await import('~/lib/embed/surfaces/spacetype')
    const { spaceTypeEmbedConfig } = await import('~/lib/spacetype/embedConfig')
    const { defaultSpaceTypeState } = await import('~/lib/spacetype/state')
    const s = defaultSpaceTypeState()
    s.effectId = 'ribbon'
    s.params = { ...s.params, text, font: 'Work Sans', typeWeight: 700 }
    const cfg = spaceTypeEmbedConfig(s, face)
    const handle = await surface.mount(document.createElement('div'), cfg)
    return { cfg, handle, texOpts: buildSpy.mock.calls.at(-1)![1] as { fontFamily: string } }
  }

  it('two mounts on the same family and weight with different subsets each keep — and draw with — their own face', async () => {
    const one = await mountWith(FACE_A, 'Cafe')
    const two = await mountWith(FACE_B, 'Café')
    expect(one.cfg.font!.family).not.toBe(two.cfg.font!.family)
    expect(faceStyles()).toHaveLength(2)
    const ruleFor = (family: string) => faceStyles().find(el => el.textContent!.includes(`'${family}'`))!.textContent!
    expect(ruleFor(one.cfg.font!.family)).toContain(FACE_A.dataUrl)
    expect(ruleFor(two.cfg.font!.family)).toContain(FACE_B.dataUrl)
    // Each atlas, and every effect reading params.font, names its own face.
    expect(one.texOpts.fontFamily).toBe(one.cfg.font!.family)
    expect(two.texOpts.fontFamily).toBe(two.cfg.font!.family)
    expect(buildSpy.mock.calls.at(-1)![0].font).toBe(two.cfg.font!.family)
    // Neither is the Frame's own family name, so the Frame's faces cannot stand in for it.
    expect(faceStyles().some(el => el.getAttribute('data-sailor-embed-font') === 'Work Sans__700')).toBe(false)
    one.handle.destroy()
    two.handle.destroy()
  })

  it('destroy removes the face it injected, and only its own', async () => {
    const one = await mountWith(FACE_A, 'Cafe')
    const two = await mountWith(FACE_B, 'Café')
    one.handle.destroy()
    expect(faceStyles()).toHaveLength(1)
    expect(faceStyles()[0]!.textContent).toContain(FACE_B.dataUrl)
    two.handle.destroy()
    expect(faceStyles()).toHaveLength(0)
  })

  it('two mounts of the very same face share one style, which outlives the first destroy (a second destroy is a no-op)', async () => {
    const one = await mountWith(FACE_A, 'Cafe')
    const two = await mountWith(FACE_A, 'Cafe')
    expect(faceStyles()).toHaveLength(1)
    one.handle.destroy()
    one.handle.destroy()
    expect(faceStyles()).toHaveLength(1)
    two.handle.destroy()
    expect(faceStyles()).toHaveLength(0)
  })

  it('a mount that fails releases its face', async () => {
    buildSpy.mockImplementationOnce(() => { throw new Error('no GL') })
    await expect(mountWith(FACE_A, 'Cafe')).rejects.toThrow('no GL')
    expect(faceStyles()).toHaveLength(0)
  })

  it('a face someone else put under the same id (another player copy in the document) is counted, not replaced', async () => {
    const { holdFontFace } = await import('~/lib/embed/surfaces/spacetype')
    const releaseOther = holdFontFace({ ...FACE_A, family: 'Work Sans sailor-000000000000' })
    const one = await mountWith(FACE_A, 'Cafe')
    const releaseSame = holdFontFace(one.cfg.font!)
    expect(faceStyles()).toHaveLength(2)
    one.handle.destroy()
    expect(faceStyles()).toHaveLength(2)
    releaseSame()
    releaseOther()
    expect(faceStyles()).toHaveLength(0)
  })
})

describe('holdFontFace — a face someone else injected', () => {
  it('is used as it is and never removed by a player (the Frame surface removes its own faces)', async () => {
    const { holdFontFace } = await import('~/lib/embed/surfaces/spacetype')
    const frameOwn = document.createElement('style')
    frameOwn.setAttribute('data-sailor-embed-font', 'Work Sans__700')
    document.head.appendChild(frameOwn)
    const release = holdFontFace({ family: 'Work Sans', weight: 700, dataUrl: 'data:font/ttf;base64,QQ==' })
    expect(document.head.querySelectorAll('style[data-sailor-embed-font]')).toHaveLength(1)
    release()
    expect(frameOwn.isConnected).toBe(true)
    frameOwn.remove()
  })
})
