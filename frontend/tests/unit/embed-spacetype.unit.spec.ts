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
