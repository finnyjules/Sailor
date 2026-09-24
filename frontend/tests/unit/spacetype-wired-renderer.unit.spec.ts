// @vitest-environment happy-dom
//
// ~/lib/spacetype/wiredRenderer is a MOVE of SpaceTypeNode.vue's headless frame-source engine.
// These pin the behaviour it must keep: lazy creation at the requested size, the rebuild
// setters in their original order (size before build), rebuilds only when dirty, the
// seamless wiredLoopFrameArg timing, a getter state read fresh after the image-card await,
// and dispose. SpaceTypeEngine is mocked — happy-dom has no WebGL.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defaultSpaceTypeState, type SpaceTypeState } from '~/lib/spacetype/state'
import { wiredLoopFrameArg, loopMultiplier } from '~/lib/spacetype/loop'
import { getEffect } from '~/lib/spacetype/effects'

const calls: string[] = []
const renderArgs: number[] = []
const ctorOpts: Record<string, unknown>[] = []
const disposeSpy = vi.fn()

vi.mock('~/lib/spacetype/engine', () => {
  class FakeSpaceTypeEngine {
    constructor(_canvas: unknown, opts: Record<string, unknown>) { ctorOpts.push(opts) }
    setSize() { calls.push('setSize') }
    setBackground() { calls.push('setBackground') }
    setProjection() { calls.push('setProjection') }
    setPost() { calls.push('setPost') }
    setPan() { calls.push('setPan') }
    setFps() { calls.push('setFps') }
    setLoopDuration() { calls.push('setLoopDuration') }
    setEffect() { calls.push('setEffect') }
    build() { calls.push('build') }
    setImageTextures() { calls.push('setImageTextures') }
    renderFrameAt(t: number) { calls.push('renderFrameAt'); renderArgs.push(t) }
    dispose() { disposeSpy() }
  }
  return { SpaceTypeEngine: FakeSpaceTypeEngine }
})
vi.mock('~/lib/spacetype/webgl', () => ({ detectWebGL: () => true }))
// The font priming would inject a Google Fonts <link> that happy-dom tries to fetch.
const ensureFontSpy = vi.fn(async () => {})
vi.mock('~/lib/spacetype/state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/spacetype/state')>()),
  ensureSpaceTypeFont: (...a: unknown[]) => ensureFontSpy(...(a as [])),
}))

const { createWiredSpaceTypeRenderer } = await import('~/lib/spacetype/wiredRenderer')

function state(extra: Partial<SpaceTypeState> = {}): SpaceTypeState {
  return { ...defaultSpaceTypeState(), ...extra }
}

beforeEach(() => { calls.length = 0; renderArgs.length = 0; ctorOpts.length = 0; disposeSpy.mockClear(); ensureFontSpy.mockClear() })

describe('createWiredSpaceTypeRenderer', () => {
  it('creates its engine lazily at the requested size and rebuilds with the original setter order', async () => {
    let fontLanded!: () => void
    ensureFontSpy.mockImplementationOnce(() => new Promise<void>(res => { fontLanded = res }))
    const r = createWiredSpaceTypeRenderer()
    expect(ctorOpts).toHaveLength(0)
    const canvas = await r.render(state(), 0.25, 640, 360)
    expect(canvas).toBeInstanceOf(HTMLCanvasElement)
    expect(ctorOpts).toHaveLength(1)
    expect(ctorOpts[0]).toMatchObject({ width: 640, height: 360, fps: 30, loopDuration: 6, projection: 'perspective' })
    expect(calls).toEqual([
      'setSize', 'setBackground', 'setProjection', 'setPost', 'setPan', 'setFps', 'setLoopDuration', 'setEffect', 'build',
      'setSize', 'renderFrameAt',
    ])
    // The font is primed once, at creation, and its landing forces one rebuild.
    expect(ensureFontSpy).toHaveBeenCalledTimes(1)
    calls.length = 0
    await r.render(state(), 0.25, 640, 360)
    expect(calls).toEqual(['setSize', 'renderFrameAt'])   // font not landed yet: no rebuild
    fontLanded()
    await Promise.resolve(); await Promise.resolve()
    calls.length = 0
    await r.render(state(), 0.25, 640, 360)
    expect(calls).toContain('build')
    expect(ensureFontSpy).toHaveBeenCalledTimes(1)
  })

  it('does not rebuild until marked dirty', async () => {
    const r = createWiredSpaceTypeRenderer()
    await r.render(state(), 0, 320, 180)
    calls.length = 0
    await r.render(state(), 0.5, 640, 360)
    expect(calls).toEqual(['setSize', 'renderFrameAt'])
    calls.length = 0
    r.markDirty()
    await r.render(state(), 0.5, 640, 360)
    expect(calls).toContain('build')
    expect(ctorOpts).toHaveLength(1)   // one engine for the renderer's life
  })

  it('spans the full seamless k-loop with wiredLoopFrameArg', async () => {
    const s = state({ effectId: 'cylinder', seamless: true, fps: 30, loopDuration: 4 })
    s.params = { ...s.params, waveSpeed: 0.5, spinSpeed: 0, count: 1 }
    const k = loopMultiplier(getEffect('cylinder').loopRates!(s.params))
    expect(k).toBe(2)
    const r = createWiredSpaceTypeRenderer()
    await r.render(s, 0.75, 100, 100)
    expect(renderArgs).toEqual([wiredLoopFrameArg(0.75, 30, 4, k)])
    expect(renderArgs[0]).toBe(1.5)
  })

  it('reads a getter state at render time', async () => {
    let current = state({ fps: 30, loopDuration: 2 })
    const r = createWiredSpaceTypeRenderer()
    await r.render(() => current, 0.5, 100, 100)
    current = state({ fps: 10, loopDuration: 1 })
    await r.render(() => current, 0.55, 100, 100)
    expect(renderArgs).toEqual([wiredLoopFrameArg(0.5, 30, 2, 1), wiredLoopFrameArg(0.55, 10, 1, 1)])
  })

  it('dispose frees the engine and later renders return null', async () => {
    const r = createWiredSpaceTypeRenderer()
    await r.render(state(), 0, 100, 100)
    r.dispose()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(await r.render(state(), 0, 100, 100)).toBeNull()
    expect(ctorOpts).toHaveLength(1)
  })
})
