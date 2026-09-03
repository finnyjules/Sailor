import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The pool constructs a real SpaceTypeEngine — fake its WebGLRenderer dependency (mirrors
// spacetype-root-cache.unit.spec.ts) so engine construction/dispose run headless, and so a
// transient construction failure (Finding 4) can be simulated deterministically via
// __setConstructShouldThrow rather than needing an actual exhausted WebGL context budget.
vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three')
  let shouldThrow = false
  let constructAttempts = 0
  class FakeRenderer {
    domElement = { width: 0, height: 0 } as unknown as HTMLCanvasElement
    shadowMap = { enabled: false, type: 0 }
    constructor() {
      constructAttempts += 1
      if (shouldThrow) throw new Error('too many WebGL contexts')
    }
    setSize(w: number, h: number) { this.domElement.width = w; this.domElement.height = h }
    setPixelRatio() {}
    setClearColor() {}
    render() {}
    dispose() {}
    forceContextLoss() {}
    getContext() { return {} }
  }
  return {
    ...actual,
    WebGLRenderer: FakeRenderer,
    __setConstructShouldThrow: (v: boolean) => { shouldThrow = v },
    __getConstructAttempts: () => constructAttempts,
  }
})

// makeTextTexture() draws to a `document.createElement('canvas')` — irrelevant to every
// invariant under test here, so stub it out (mirrors spacetype-root-cache.unit.spec.ts).
vi.mock('../../app/lib/spacetype/textTexture', () => ({
  makeTextTexture: () => ({ dispose: () => {}, userData: {} }),
}))

// Real ribbon/etc. effects pull in canvas-based fill/gradient generation that needs a real
// 2D context this node-env suite doesn't have. structuralKey and the engine-pool tests only
// care about effect identity and liveKeys, so replace getEffect with a controllable fake:
// unregistered ids fall back to a trivial effect (keeps the pre-existing 'ribbon'/'tunnel'
// identity tests working unchanged); __registerEffect lets a test pin exact liveKeys so the
// "ignores live params" case asserts against real logic instead of an early-return.
// 'ribbon' is special-cased to its real `controls` array (plain data — no canvas/DOM touched
// at import time) run through withSeparatorControls, matching production's getEffect('ribbon')
// exactly: defaultSpaceTypeState() (unmocked, called by several tests below) reads
// getEffect('ribbon').controls to build its defaults, so a trivial [] here would silently
// starve it of params instead of exercising real behaviour.
vi.mock('../../app/lib/spacetype/effects/index', async () => {
  const { ribbonEffect } = await import('../../app/lib/spacetype/effects/ribbon')
  const { withSeparatorControls } = await import('../../app/lib/spacetype/separator')
  // Mirrors effects/index.ts, which registers every effect through
  // withSeparatorControls — this mock must be updated in step with that
  // wrapper, or the effect under test here stops matching the real registry.
  const realRibbon = withSeparatorControls(ribbonEffect)
  const registry = new Map<string, any>()
  function getEffect(id: string) {
    const key = String(id).toLowerCase()
    if (registry.has(key)) return registry.get(key)
    if (key === 'ribbon') return realRibbon
    return { id, label: id, controls: [], buildScene: (three: any) => new three.Object3D(), update: () => {} }
  }
  return {
    getEffect,
    __registerEffect: (effect: any) => registry.set(String(effect.id).toLowerCase(), effect),
    __clearEffects: () => registry.clear(),
  }
})

import { structuralKey, acquireSpaceTypeEngine, getSpaceTypeEngine, releaseSpaceTypeEngine, resetSpaceTypeEnginePool, spaceTypeEngineAvailable, isSpaceTypeEngineHandleLive } from '../../app/lib/engine/spaceTypeEnginePool'
import { SpaceTypeEngine } from '../../app/lib/spacetype/engine'
import { defaultSpaceTypeState } from '../../app/lib/spacetype/state'
import { createSpaceTypeClip } from '../../app/composables/timelineSpaceTypeClip'
import { sourceT01, drawSpaceTypeClip, renderSpaceTypeClipToCanvas } from '../../app/lib/engine/spaceTypeClipRenderer'
import { getEffect, __registerEffect, __clearEffects } from '../../app/lib/spacetype/effects/index'
import { SpaceTypeSource } from '../../app/lib/engine/sources/spaceTypeSource'
import { buildDrawList } from '../../app/lib/engine/compositor'
import { EDIT_STATE_VERSION, type EditState, type SpaceTypeClip } from '../../shared/timeline/types'

/** A fake canvas good enough for document.createElement('canvas'): tracks width/height
 *  (so the pool's resize-detection works), answers getContext('webgl2') truthily so
 *  spaceTypeEngineAvailable() reports WebGL2 as supported, and supports
 *  addEventListener/__dispatch so context-loss recovery tests can register the pool's
 *  real 'webglcontextlost' listener and fire it, like a real lost-context event would. */
function fakeCanvas() {
  const listeners = new Map<string, Array<() => void>>()
  return {
    width: 0,
    height: 0,
    getContext: () => ({}),
    addEventListener: (type: string, cb: () => void) => {
      const arr = listeners.get(type) ?? []
      arr.push(cb)
      listeners.set(type, arr)
    },
    removeEventListener: () => {},
    __dispatch: (type: string) => { (listeners.get(type) ?? []).forEach(cb => cb()) },
  } as unknown as HTMLCanvasElement & { __dispatch: (type: string) => void }
}

describe('structuralKey', () => {
  it('changes when the effect changes', () => {
    const a = defaultSpaceTypeState()
    const b = { ...a, effectId: 'tunnel' }
    expect(structuralKey(a)).not.toBe(structuralKey(b))
  })

  it('is stable for the same state', () => {
    const a = defaultSpaceTypeState()
    expect(structuralKey(a)).toBe(structuralKey(JSON.parse(JSON.stringify(a))))
  })

  // Regression: JSON.parse(JSON.stringify(a)) above preserves key order, so it never
  // exercises structuralKey's `.sort()` over Object.keys(state.params) — deleting that
  // .sort() would not fail the test above. Build the same logical params in a different
  // insertion order and confirm the key is still identical.
  it('is stable regardless of param property insertion order', () => {
    const a = defaultSpaceTypeState()
    const keys = Object.keys(a.params)
    expect(keys.length).toBeGreaterThan(1) // otherwise reversing proves nothing
    const reversedParams = Object.fromEntries([...keys].reverse().map(k => [k, a.params[k]]))
    const b = { ...a, params: reversedParams }
    // Sanity: same logical content, different declaration order.
    expect(Object.keys(b.params)).toEqual([...keys].reverse())
    expect(structuralKey(a)).toBe(structuralKey(b))
  })

  // Regression: previously this test declared `if (!live) return`, so it silently asserted
  // nothing whenever the real 'ribbon' effect's liveKeys happened to be empty. Assert against
  // an effect this test fully controls so the behaviour is always actually exercised.
  it('ignores params the effect declares as live', () => {
    __registerEffect({
      id: 'structural-key-live-test',
      label: 'live-test',
      controls: [],
      liveKeys: ['wobble'],
      buildScene: (three: any) => new three.Object3D(),
      update: () => {},
    })
    const base = defaultSpaceTypeState()
    const a = { ...base, effectId: 'structural-key-live-test', params: { ...base.params, wobble: 1, stable: 1 } }
    const b = { ...a, params: { ...a.params, wobble: 2 } } // live key changes...
    const c = { ...a, params: { ...a.params, stable: 2 } } // ...a structural key does not
    expect(structuralKey(a)).toBe(structuralKey(b))
    expect(structuralKey(a)).not.toBe(structuralKey(c))
    __clearEffects()
  })
})

describe('sourceT01', () => {
  const state = defaultSpaceTypeState() // 30fps, 6s => 180 source frames

  it('maps clip-local frames onto normalized loop time', () => {
    const clip = createSpaceTypeClip({ startFrame: 0, state })
    expect(sourceT01(clip, 0)).toBeCloseTo(0)
    expect(sourceT01(clip, 90)).toBeCloseTo(0.5)
  })

  it('tiles past the source end when loop is true', () => {
    const clip = createSpaceTypeClip({ startFrame: 0, state, length: 600 })
    expect(sourceT01(clip, 180)).toBeCloseTo(sourceT01(clip, 0))
    expect(sourceT01(clip, 270)).toBeCloseTo(sourceT01(clip, 90))
  })

  it('holds the last frame when loop is false', () => {
    const clip = { ...createSpaceTypeClip({ startFrame: 0, state, length: 600 }), loop: false }
    const last = sourceT01(clip, 179)
    expect(sourceT01(clip, 400)).toBeCloseTo(last)
  })

  // Was 'respects in_frame as an offset into the source', asserting
  // sourceT01(clip, 0) === 0.5 for an in_frame:90 clip — i.e. that sourceT01
  // itself adds clip.in_frame to its argument. That is Critical 1's bug: the
  // WebGL path's argument is ALREADY source-mapped (sourceFrameAt has already
  // added in_frame) by the time it reaches here, so sourceT01 adding it again
  // double-counted the trim. The corrected contract: sourceT01 takes a source
  // frame and must NOT read clip.in_frame at all — the caller (sourceFrameAt)
  // is solely responsible for folding it in, once.
  it('does not read clip.in_frame — the caller must pre-fold it into the source frame it passes in', () => {
    const clip = { ...createSpaceTypeClip({ startFrame: 0, state }), in_frame: 90 }
    expect(sourceT01(clip, 0)).toBeCloseTo(0) // in_frame ignored, not added
    expect(sourceT01(clip, 90)).toBeCloseTo(0.5) // caller pre-added in_frame itself
  })

  it('is pure — the same frame yields the same t01 regardless of call order', () => {
    const clip = createSpaceTypeClip({ startFrame: 0, state, length: 600 })
    const forward = [0, 50, 100, 200, 300].map(f => sourceT01(clip, f))
    const backward = [300, 200, 100, 50, 0].map(f => sourceT01(clip, f)).reverse()
    expect(forward).toEqual(backward)
  })
})

describe('spaceTypeEnginePool ownership (Finding 1)', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas() })
    resetSpaceTypeEnginePool()
  })
  afterEach(() => {
    resetSpaceTypeEnginePool()
    vi.unstubAllGlobals()
    vi.restoreAllMocks() // undo vi.spyOn(SpaceTypeEngine.prototype, 'dispose') so each test's spy starts at 0 calls
  })

  it('constructs once and disposes exactly once across many rendered frames and matching releases', () => {
    const disposeSpy = vi.spyOn(SpaceTypeEngine.prototype, 'dispose')
    const handle = acquireSpaceTypeEngine()
    expect(handle).toBeTruthy()

    let first: SpaceTypeEngine | null = null
    for (let i = 0; i < 50; i++) {
      const e = getSpaceTypeEngine(handle!, 100, 100) // one call per "rendered frame"
      expect(e).toBeTruthy()
      if (!first) first = e
      else expect(e).toBe(first) // same engine reused — constructed exactly once
    }
    expect(disposeSpy).not.toHaveBeenCalled()

    releaseSpaceTypeEngine(handle) // the single matching release
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('a release from a handle that never rendered does not dispose an engine another handle still holds', () => {
    const disposeSpy = vi.spyOn(SpaceTypeEngine.prototype, 'dispose')
    const h1 = acquireSpaceTypeEngine()!
    const h2 = acquireSpaceTypeEngine()! // e.g. a consumer disposed before its first frame

    const engine1 = getSpaceTypeEngine(h1, 100, 100) // only h1 ever renders
    expect(engine1).toBeTruthy()

    releaseSpaceTypeEngine(h2) // h2 never called getSpaceTypeEngine
    expect(disposeSpy).not.toHaveBeenCalled()

    const engine2 = getSpaceTypeEngine(h1, 100, 100)
    expect(engine2).toBe(engine1) // still alive, still the same instance — not rebuilt

    releaseSpaceTypeEngine(h1)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('releasing the same handle twice is safe and does not double-dispose', () => {
    const disposeSpy = vi.spyOn(SpaceTypeEngine.prototype, 'dispose')
    const handle = acquireSpaceTypeEngine()!
    getSpaceTypeEngine(handle, 100, 100)
    releaseSpaceTypeEngine(handle)
    releaseSpaceTypeEngine(handle)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })
})

describe('spaceTypeEnginePool failure classification (Finding 4)', () => {
  beforeEach(() => {
    resetSpaceTypeEnginePool()
  })
  afterEach(() => {
    resetSpaceTypeEnginePool()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('permanently latches when WebGL2 is not supported at all, and refuses further acquires', () => {
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) })
    const h = acquireSpaceTypeEngine()
    expect(h).toBeTruthy() // unavailability is discovered lazily, on first real use
    expect(getSpaceTypeEngine(h!, 100, 100)).toBeNull()
    expect(spaceTypeEngineAvailable()).toBe(false)
    expect(acquireSpaceTypeEngine()).toBeNull() // now known-permanent: no point issuing more handles
  })

  it('does not permanently latch on a transient construction failure, and retries after a bounded cooldown', async () => {
    const three = await import('three') as any
    vi.stubGlobal('document', { createElement: () => fakeCanvas() }) // WebGL2 "supported"
    vi.useFakeTimers()
    three.__setConstructShouldThrow(true)
    const attemptsBefore = three.__getConstructAttempts()

    const handle = acquireSpaceTypeEngine()!
    expect(getSpaceTypeEngine(handle, 100, 100)).toBeNull() // transient failure this frame
    expect(spaceTypeEngineAvailable()).toBe(true) // crucially NOT permanently latched
    expect(three.__getConstructAttempts()).toBe(attemptsBefore + 1)

    // Hammering it again immediately (as a 60fps render loop would) must not retry
    // construction on every call — that would just spam failed context creation.
    expect(getSpaceTypeEngine(handle, 100, 100)).toBeNull()
    expect(three.__getConstructAttempts()).toBe(attemptsBefore + 1) // no new attempt yet

    three.__setConstructShouldThrow(false)
    vi.advanceTimersByTime(5000) // past the bounded cooldown
    const engine = getSpaceTypeEngine(handle, 100, 100)
    expect(engine).toBeTruthy() // succeeds once the transient pressure has eased
    expect(three.__getConstructAttempts()).toBe(attemptsBefore + 2)
  })
})

// Critical 1 regression, driven through the REAL compositor path rather than
// sourceT01 in isolation — the isolated unit tests above (and the old
// "respects in_frame" test they replaced) are exactly what let the double-
// apply bug ship. This exercises the actual production chain: buildDrawList
// (sourceFrameAt) -> SpaceTypeSource.getFrame -> renderSpaceTypeClipToCanvas
// -> sourceT01 -> engine.renderFrameAt(t01, ...). Only SpaceTypeEngine's WebGL
// renderer is faked (via the module-level 'three' mock at the top of this
// file, reused from the pool-ownership tests above) — nothing in the chain
// under test is mocked, so a regression here would reproduce the bug end to
// end, not just at the sourceT01 call site.
describe('Space Type in_frame: compositor path (Critical 1 — was double-applied in WebGL, dropped in Canvas2D)', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas() })
    resetSpaceTypeEnginePool()
  })
  afterEach(() => {
    resetSpaceTypeEnginePool()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function editStateFor(clip: SpaceTypeClip): EditState {
    return {
      version: EDIT_STATE_VERSION,
      canvas: { width: 100, height: 100, fps: 30, bg_color: '#000000' },
      tracks: [{ id: 't1', kind: 'video', name: 'V1', muted: false, locked: false, clips: [clip] }],
      transitions: [],
      total_frames: 9999,
    }
  }

  it('buildDrawList -> SpaceTypeSource.getFrame -> sourceT01: a trimmed clip at local frame 0 renders the same t01 as an untrimmed clip at local frame N — not 2N', async () => {
    const renderFrameAtSpy = vi.spyOn(SpaceTypeEngine.prototype, 'renderFrameAt')
    const state = defaultSpaceTypeState() // 30fps, 6s loop => T = 180 source frames
    const T = 180
    const N = 40

    // Trimmed clip: in_frame N, evaluated at its own local frame 0.
    const trimmed = { ...createSpaceTypeClip({ startFrame: 0, state, length: 9999 }), in_frame: N } as SpaceTypeClip
    const dims = new Map([[trimmed.id, { w: 100, h: 100 }]])
    const entries = buildDrawList(editStateFor(trimmed), 0, dims)
    expect(entries).toHaveLength(1)
    // buildDrawList already source-maps via sourceFrameAt — the FrameSource contract.
    expect(entries[0]!.sourceFrame).toBe(N)

    const trimmedSource = new SpaceTypeSource(trimmed, 30)
    await trimmedSource.getFrame(entries[0]!.sourceFrame)
    expect(renderFrameAtSpy).toHaveBeenCalledTimes(1)
    const trimmedT01 = renderFrameAtSpy.mock.calls[0]![0]
    trimmedSource.dispose()

    // Untrimmed clip (in_frame 0), evaluated directly at source frame N — the
    // "same content" comparison point per the bug report.
    renderFrameAtSpy.mockClear()
    const untrimmed = createSpaceTypeClip({ startFrame: 0, state, length: 9999 })
    const untrimmedSource = new SpaceTypeSource(untrimmed, 30)
    await untrimmedSource.getFrame(N)
    expect(renderFrameAtSpy).toHaveBeenCalledTimes(1)
    const untrimmedT01 = renderFrameAtSpy.mock.calls[0]![0]
    untrimmedSource.dispose()

    expect(trimmedT01).toBeCloseTo(N / T, 10)
    expect(trimmedT01).toBeCloseTo(untrimmedT01, 10)
    // The regression this guards against: double-applying in_frame would feed
    // the engine source frame 2N (80) instead of N (40) — a materially
    // different, and wrong, t01.
    expect(trimmedT01).not.toBeCloseTo((2 * N) / T, 5)
  })
})

describe('drawSpaceTypeClip aspect-fit (Finding 2)', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas() })
    resetSpaceTypeEnginePool()
  })
  afterEach(() => {
    resetSpaceTypeEnginePool()
    vi.unstubAllGlobals()
  })

  it('letterboxes into the target canvas instead of stretching to fill it', () => {
    const state = defaultSpaceTypeState() // dimsKey '960 × 540 (16:9)' => clip is 960×540
    const clip = createSpaceTypeClip({ startFrame: 0, state })
    const handle = acquireSpaceTypeEngine()!
    const drawImage = vi.fn()
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D

    // Target canvas is square (1:1); the clip is 16:9, so a correct aspect-fit must be
    // narrower than the full canvas height and centered — not a 800x800 full-rect stretch.
    drawSpaceTypeClip(handle, ctx, clip, 0, 800, 800, 30)

    expect(drawImage).toHaveBeenCalledTimes(1)
    const [, dx, dy, dw, dh] = drawImage.mock.calls[0]!
    expect(dw).toBeCloseTo(800) // fills the wider axis
    expect(dh).toBeCloseTo(800 * (540 / 960)) // shorter axis derived from clip aspect, not stretched to 800
    expect(dh).toBeLessThan(800)
    expect(dx).toBeCloseTo(0)
    expect(dy).toBeCloseTo((800 - dh) / 2) // vertically centered (letterboxed), not pinned to 0
    expect(dy).toBeGreaterThan(0)

    releaseSpaceTypeEngine(handle)
  })
})

describe('spaceTypeEnginePool context-loss recovery (item 1)', () => {
  let lastCanvas: ReturnType<typeof fakeCanvas> | null = null

  beforeEach(() => {
    lastCanvas = null
    vi.stubGlobal('document', {
      createElement: () => {
        lastCanvas = fakeCanvas()
        return lastCanvas
      },
    })
    resetSpaceTypeEnginePool()
  })
  afterEach(() => {
    resetSpaceTypeEnginePool()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a webglcontextlost event fired on the pooled canvas resets the pool', () => {
    const handle = acquireSpaceTypeEngine()!
    expect(getSpaceTypeEngine(handle, 100, 100)).toBeTruthy() // constructs the engine + its canvas
    expect(lastCanvas).toBeTruthy()
    expect(isSpaceTypeEngineHandleLive(handle)).toBe(true)

    // Simulate the browser firing a real context-loss event on the canvas the
    // pool is using — not calling resetSpaceTypeEnginePool() directly, so this
    // test actually exercises the addEventListener wiring, not just the reset
    // function in isolation.
    lastCanvas!.__dispatch('webglcontextlost')

    // The reset invalidated the pre-loss handle — see ownership contract item 4.
    expect(isSpaceTypeEngineHandleLive(handle)).toBe(false)
    expect(getSpaceTypeEngine(handle, 100, 100)).toBeNull()
  })

  it('a consumer holding a handle across a context loss can render again afterwards', async () => {
    const clip = createSpaceTypeClip({ startFrame: 0, state: defaultSpaceTypeState() })
    const source = new SpaceTypeSource(clip, 30)

    const frame1 = await source.getFrame(0)
    expect(frame1).toBeTruthy()
    // SpaceTypeSource only ever falls back to its transparent placeholder canvas
    // when rendering fails; it stays null once a real render has succeeded, so
    // this is a strong sentinel that frame1 came from the actual engine.
    expect((source as any).fallback).toBeNull()

    // A context loss the consumer did not initiate (independent of the wiring
    // covered by the previous test — this one isolates consumer-side self-healing).
    resetSpaceTypeEnginePool()
    expect(isSpaceTypeEngineHandleLive((source as any).handle)).toBe(false) // dead, per the contract

    // The meaningful assertion: rendering resumes on the very next frame, not
    // merely that resetSpaceTypeEnginePool() ran.
    const frame2 = await source.getFrame(1)
    expect(frame2).toBeTruthy()
    expect((source as any).fallback).toBeNull() // still never fell back — recovery worked
    expect(isSpaceTypeEngineHandleLive((source as any).handle)).toBe(true) // holds a fresh, live handle

    source.dispose()
  })
})

describe('spaceTypeEnginePool permanent-unavailability diagnostic (item 2)', () => {
  beforeEach(() => {
    resetSpaceTypeEnginePool()
  })
  afterEach(() => {
    resetSpaceTypeEnginePool()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('warns once, naming Space Type and WebGL2, when the capability is permanently absent — not per frame', () => {
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = acquireSpaceTypeEngine()!

    // Three separate "rendered frames" against a browser with no WebGL2 at all —
    // the kind of hammering a 60fps render loop would do.
    expect(getSpaceTypeEngine(handle, 100, 100)).toBeNull()
    expect(getSpaceTypeEngine(handle, 100, 100)).toBeNull()
    expect(getSpaceTypeEngine(handle, 100, 100)).toBeNull()

    const diagnostic = warnSpy.mock.calls.filter(args => {
      const msg = String(args[0] ?? '')
      return msg.includes('Space Type') && msg.toLowerCase().includes('webgl2')
    })
    expect(diagnostic.length).toBe(1) // one-time, not once per frame
  })
})

/** A null handle is a legitimate state, not a caller error: acquireSpaceTypeEngine()
 *  returns null when WebGL2 is permanently unavailable. Both entry points must accept
 *  it and draw nothing.
 *
 *  These deliberately do NOT mock spaceTypeEnginePool — they exercise the real
 *  getSpaceTypeEngine path, which previously threw on `liveHandles.has(handle.id)`
 *  when handle was null. The mocked guard in spacetype-canvas2d-branch.unit.spec.ts
 *  could not have caught that. */
describe('null handle tolerance (unmocked pool)', () => {
  it('renderSpaceTypeClipToCanvas returns null instead of throwing', () => {
    const clip = createSpaceTypeClip({ startFrame: 0, state: defaultSpaceTypeState() })
    let out: HTMLCanvasElement | null | undefined
    expect(() => { out = renderSpaceTypeClipToCanvas(null, clip, 0, 30) }).not.toThrow()
    expect(out).toBeNull()
  })

  it('drawSpaceTypeClip draws nothing and does not throw', () => {
    const clip = createSpaceTypeClip({ startFrame: 0, state: defaultSpaceTypeState() })
    const drawImage = vi.fn()
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D
    expect(() => drawSpaceTypeClip(null, ctx, clip, 0, 1920, 1080, 30)).not.toThrow()
    expect(drawImage).not.toHaveBeenCalled()
  })

  it('tolerates a null handle on every frame of a scrub, not just frame 0', () => {
    const clip = createSpaceTypeClip({ startFrame: 0, state: defaultSpaceTypeState(), length: 600 })
    const drawImage = vi.fn()
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D
    expect(() => {
      for (const f of [0, 45, 179, 180, 300, 599]) drawSpaceTypeClip(null, ctx, clip, f, 1920, 1080, 30)
    }).not.toThrow()
    expect(drawImage).not.toHaveBeenCalled()
  })
})
