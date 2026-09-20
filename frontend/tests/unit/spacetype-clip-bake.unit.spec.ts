import { describe, it, expect, vi } from 'vitest'

// getEffect pulls in canvas-based fill/gradient generation that needs a real 2D
// context this node-env suite lacks. A controllable fake lets a test pin exact
// loopRates so the k-loop maths is asserted against real logic.
vi.mock('../../app/lib/spacetype/effects/index', () => {
  const registry = new Map<string, any>()
  function getEffect(id: string) {
    const key = String(id).toLowerCase()
    if (registry.has(key)) return registry.get(key)
    return { id, label: id, controls: [], buildScene: () => ({}), update: () => {} }
  }
  return {
    getEffect,
    __registerEffect: (e: any) => registry.set(String(e.id).toLowerCase(), e),
    __clearEffects: () => registry.clear(),
  }
})

// spaceTypeClipRenderer.ts's renderSpaceTypeClipToCanvas touches a real WebGL
// engine, which this node-env suite has no way to construct. A spy replaces
// it so the bake-pipeline integration test below can capture what
// ensureSpaceTypeClipBake actually feeds the renderer, while sourceT01 and
// spaceTypeLoopMultiplier stay the REAL implementations (spread from
// importOriginal) — those are exactly the functions Critical 1 fixed.
//
// Field renamed from `localFrame` to `sourceFrame`: a bake index IS a source
// frame (0..k*T-1), and renderSpaceTypeClipToCanvas's 3rd parameter is named
// that post-fix too — sourceT01 (which this receives) no longer reads
// clip.in_frame, so `inFrame` is captured only for the "loop forced true"
// assertion below, not for any in_frame-offset math.
const capturedRenderCalls: Array<{ sourceFrame: number; inFrame: number; loop: boolean }> = []
vi.mock('../../app/lib/engine/spaceTypeClipRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../app/lib/engine/spaceTypeClipRenderer')>()
  return {
    ...actual,
    renderSpaceTypeClipToCanvas: (_handle: unknown, clip: any, sourceFrame: number) => {
      capturedRenderCalls.push({ sourceFrame, inFrame: clip.in_frame ?? 0, loop: clip.loop !== false })
      return { toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['x'])) } as unknown as HTMLCanvasElement
    },
  }
})

// No real WebGL context to acquire in node env — the bake only needs a truthy
// handle to proceed; it never dereferences it since renderSpaceTypeClipToCanvas
// is spied above.
vi.mock('../../app/lib/engine/spaceTypeEnginePool', () => ({
  acquireSpaceTypeEngine: () => ({ id: 1 }),
  releaseSpaceTypeEngine: () => {},
}))

// ensureSpaceTypeClipBake's upload step hits a real /upload/image endpoint by
// default — stub it so the bake completes offline.
vi.mock('../../app/lib/studio/frameUpload', () => ({
  uploadFrameBatch: async (blobs: Blob[]) => blobs.map((_, i) => `fake_${i}.png`),
}))

import { spaceTypeBakeFrameCount, spaceTypeLoopMultiplier, bakeCfg, ensureSpaceTypeClipBake } from '../../app/lib/engine/spaceTypeClipBake'
import { sourceT01 } from '../../app/lib/engine/spaceTypeClipRenderer'
import { createSpaceTypeClip, spaceTypeStateKey } from '../../app/composables/timelineSpaceTypeClip'
import { defaultSpaceTypeState } from '../../app/lib/spacetype/state'
import { spaceTypeSourceKey } from '../../app/lib/spacetype/sourceKey'
import { __registerEffect } from '../../app/lib/spacetype/effects/index'

const st = () => defaultSpaceTypeState() // 30fps, 6s loop => 180 source frames

describe('spaceTypeBakeFrameCount', () => {
  it('bakes one cycle, not the clip length', () => {
    const clip = createSpaceTypeClip({ startFrame: 0, state: st(), length: 1800 }) // 60s clip
    expect(spaceTypeBakeFrameCount(clip)).toBe(180)
    expect(spaceTypeBakeFrameCount(clip)).toBeLessThan(1800)
  })

  it('is always a whole multiple of one loop', () => {
    const clip = createSpaceTypeClip({ startFrame: 0, state: st(), length: 900 })
    expect(spaceTypeBakeFrameCount(clip) % 180).toBe(0)
  })

  it('does not depend on clip length, placement, opacity or trim', () => {
    const a = createSpaceTypeClip({ startFrame: 0, state: st(), length: 180 })
    const b = { ...createSpaceTypeClip({ startFrame: 500, state: st(), length: 1800 }), opacity: 0.3, in_frame: 40 }
    expect(spaceTypeBakeFrameCount(a)).toBe(spaceTypeBakeFrameCount(b as any))
  })

  it('extends to k whole loops when the effect has an off-grid motion rate', () => {
    // 0.5 cycles per loop needs k=2 for the motion to close seamlessly.
    __registerEffect({ id: 'halfrate', label: 'halfrate', controls: [], buildScene: () => ({}), update: () => {}, loopRates: () => [0.5] })
    const clip = createSpaceTypeClip({ startFrame: 0, state: { ...st(), effectId: 'halfrate' }, length: 90 })
    expect(spaceTypeLoopMultiplier(clip)).toBe(2)
    expect(spaceTypeBakeFrameCount(clip)).toBe(360) // 2 x 180
  })
})

/** These pin the bug promoted from Task 1's review: the bake is CACHED and
 *  skipped on a key match, so anything that changes the rendered pixels must
 *  change the key — otherwise export silently reuses stale frames. */
describe('bakeCfg hashes everything that changes the pixels', () => {
  const keyFor = (clip: any) => spaceTypeSourceKey(bakeCfg(clip) as any)

  function withState(patch: Record<string, unknown>) {
    return createSpaceTypeClip({ startFrame: 0, state: { ...st(), ...patch } as any })
  }

  it('changes when post-processing changes', () => {
    const off = withState({ post: { bloom: false, bloomStrength: 0.6, bloomRadius: 0.4, bloomThreshold: 0.8, color: false, exposure: 1, contrast: 1, saturation: 1, hue: 0, chroma: false, chromaAmount: 0.25, blur: false, blurAmount: 0.01 } })
    const on = withState({ post: { bloom: true, bloomStrength: 0.6, bloomRadius: 0.4, bloomThreshold: 0.8, color: false, exposure: 1, contrast: 1, saturation: 1, hue: 0, chroma: false, chromaAmount: 0.25, blur: false, blurAmount: 0.01 } })
    expect(keyFor(off)).not.toBe(keyFor(on))
  })

  it('changes when projection changes', () => {
    expect(keyFor(withState({ projection: 'perspective' }))).not.toBe(keyFor(withState({ projection: 'isometric' })))
  })

  it('changes when pan changes', () => {
    expect(keyFor(withState({ panX: 0 }))).not.toBe(keyFor(withState({ panX: 0.4 })))
    expect(keyFor(withState({ panY: 0 }))).not.toBe(keyFor(withState({ panY: 0.4 })))
  })

  it('changes when the gradient changes', () => {
    const a = withState({ gradientStops: [{ color: '#ff0000', on: true }] })
    const b = withState({ gradientStops: [{ color: '#00ff00', on: true }] })
    expect(keyFor(a)).not.toBe(keyFor(b))
  })

  it('changes when the effect or its params change', () => {
    expect(keyFor(withState({ effectId: 'ribbon' }))).not.toBe(keyFor(withState({ effectId: 'tunnel' })))
    const base = st()
    expect(keyFor(withState({ params: { ...base.params, rows: 3 } }))).not.toBe(keyFor(withState({ params: { ...base.params, rows: 9 } })))
  })

  it('bakes a Custom size at its saved width and height, not the 960×540 fallback', () => {
    // 'Custom' is in no preset table — the saved W/H are the only record of the real size.
    const custom = withState({ dimsKey: 'Custom', W: 1234, H: 567 })
    expect([bakeCfg(custom).W, bakeCfg(custom).H]).toEqual([1234, 567])
    expect(keyFor(custom)).not.toBe(keyFor(withState({ dimsKey: 'Custom', W: 800, H: 800 })))
    // The staleness key must see it too, or resizing the node never marks its clip stale.
    expect(spaceTypeStateKey(custom.state)).not.toBe(spaceTypeStateKey(withState({ dimsKey: 'Custom', W: 800, H: 800 }).state))
  })

  it('does NOT change when only placement, trim or opacity change', () => {
    const a = createSpaceTypeClip({ startFrame: 0, state: st(), length: 180 })
    const b = { ...createSpaceTypeClip({ startFrame: 900, state: st(), length: 1800 }), in_frame: 40, opacity: 0.25, fade_in: 12 }
    expect(keyFor(a)).toBe(keyFor(b))
  })

  it('covers k loops in the hashed duration, so a rate change re-bakes', () => {
    __registerEffect({ id: 'r1', label: 'r1', controls: [], buildScene: () => ({}), update: () => {}, loopRates: () => [1] })
    __registerEffect({ id: 'r2', label: 'r2', controls: [], buildScene: () => ({}), update: () => {}, loopRates: () => [0.5] })
    const one = createSpaceTypeClip({ startFrame: 0, state: { ...st(), effectId: 'r1' } as any })
    const half = createSpaceTypeClip({ startFrame: 0, state: { ...st(), effectId: 'r2' } as any })
    expect(bakeCfg(one).loopDuration).toBe(6)
    expect(bakeCfg(half).loopDuration).toBe(12)
  })
})

/** Critical 1 regression: every frame used to render through sourceT01(), which
 *  wrapped into [0,1) using T (one loop) as the modulus — so any effect needing
 *  k > 1 whole loops (loopMultiplier > 1) baked k*T frames of which only the
 *  first T were ever distinct; the rest were byte-identical copies of loop 1.
 *  These assert on the actual t01 VALUES handed to the renderer, not just frame
 *  counts — counts alone passed even with the bug (spaceTypeBakeFrameCount was
 *  already correct; only the content driving each frame was wrong). */
describe('sourceT01 multi-loop content advance (Critical 1)', () => {
  it('produces monotonically increasing, unwrapped t01 across a full k>1 cycle', () => {
    __registerEffect({ id: 'thirdrate', label: 'thirdrate', controls: [], buildScene: () => ({}), update: () => {}, loopRates: () => [1 / 3] })
    const clip = { ...createSpaceTypeClip({ startFrame: 0, state: { ...st(), effectId: 'thirdrate' } as any, length: 9999 }), in_frame: 0, loop: true }
    const k = spaceTypeLoopMultiplier(clip)
    const T = 180
    expect(k).toBe(3) // smallest k with (1/3)*k a whole number
    const bakeFrames = spaceTypeBakeFrameCount(clip)
    expect(bakeFrames).toBe(T * k)

    const values = Array.from({ length: bakeFrames }, (_, i) => sourceT01(clip, i))

    // Strictly increasing within the cycle. Under the bug, values[T..2T-1]
    // would equal values[0..T-1] exactly (loop 1 repeating) — not increasing.
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1])

    // Content genuinely advances past loop 1 instead of wrapping back to it.
    expect(values[T]).toBeCloseTo(1, 10)
    expect(values[2 * T]).toBeCloseTo(2, 10)
    expect(values[bakeFrames - 1]).toBeCloseTo((bakeFrames - 1) / T, 10)
    expect(Math.max(...values)).toBeGreaterThan(1)

    // Wraps cleanly to 0 at the START of the next cycle, not before.
    expect(sourceT01(clip, bakeFrames)).toBeCloseTo(0, 10)
  })

  it('k=1 is byte-identical to wrapping at one loop (today\'s behaviour, unchanged)', () => {
    // The default fake effect registered by getEffect() has no loopRates -> k=1.
    const clip = { ...createSpaceTypeClip({ startFrame: 0, state: st(), length: 9999 }), in_frame: 0, loop: true }
    expect(spaceTypeLoopMultiplier(clip)).toBe(1)
    expect(sourceT01(clip, 0)).toBe(0)
    expect(sourceT01(clip, 90)).toBeCloseTo(0.5, 10)
    expect(sourceT01(clip, 179)).toBeCloseTo(179 / 180, 10)
    expect(sourceT01(clip, 180)).toBe(0) // wraps at T, same as before the fix
    expect(sourceT01(clip, 359)).toBeCloseTo(179 / 180, 10)
  })

  // Was 'honours in_frame before wrapping...', asserting sourceT01(looping, 100)
  // (with clip.in_frame:40) === 140/T — i.e. that sourceT01 itself adds
  // clip.in_frame to its argument. That IS Critical 1's bug: the WebGL path's
  // argument is already source-mapped (sourceFrameAt already added in_frame)
  // by the time it reaches sourceT01, so adding it again here double-counted
  // the trim. Corrected contract: sourceT01 must NOT read clip.in_frame at
  // all — the caller folds it in exactly once, before calling here.
  it('does not honour clip.in_frame — the caller pre-folds it into the source frame — and (loop:false) clamps to the last frame of k·T, not of T', () => {
    __registerEffect({ id: 'thirdrate2', label: 'thirdrate2', controls: [], buildScene: () => ({}), update: () => {}, loopRates: () => [1 / 3] })
    const base = createSpaceTypeClip({ startFrame: 0, state: { ...st(), effectId: 'thirdrate2' } as any, length: 9999 })
    const T = 180
    const k = 3

    const looping = { ...base, in_frame: 40, loop: true }
    expect(sourceT01(looping, 100)).toBeCloseTo(100 / T, 10) // in_frame ignored, NOT added
    expect(sourceT01(looping, 100)).toBe(sourceT01({ ...looping, in_frame: 0 }, 100)) // truly inert

    // Given a pre-folded source frame (in_frame 40 + local 100 = 140), wraps as before.
    expect(sourceT01(looping, 140)).toBeCloseTo(140 / T, 10)
    expect(sourceT01(looping, 540)).toBeCloseTo(0, 10) // 40 + 500 = 540 = k*T, wraps exactly

    const held = { ...base, in_frame: 0, loop: false }
    // A clamp to T-1 (the old, wrong modulus) would freeze this effect mid-cycle
    // for any local frame past one loop. The correct clamp target is k*T - 1.
    expect(sourceT01(held, 10000)).toBeCloseTo((k * T - 1) / T, 10)
  })
})

/** Integration check: drives the REAL ensureSpaceTypeClipBake / bakeCfg /
 *  spaceTypeLoopMultiplier orchestration (only the WebGL render call and the
 *  network upload are stubbed — see the vi.mock calls above) and captures
 *  every (sourceFrame) the pipeline hands to the renderer, reconstructing the
 *  t01 each one implies via the real sourceT01. This is the "spy across a
 *  k>1 bake" the review asked for: it proves the ACTUAL bake loop — not just
 *  sourceT01 in isolation — walks the full unwrapped k*T range. */
describe('ensureSpaceTypeClipBake drives the renderer across the full k*T range (Critical 1, integration)', () => {
  it('renders every source-domain frame exactly once, on a looping view, with advancing t01', async () => {
    capturedRenderCalls.length = 0
    __registerEffect({ id: 'bakerate', label: 'bakerate', controls: [], buildScene: () => ({}), update: () => {}, loopRates: () => [1 / 3] })
    const clip = createSpaceTypeClip({ startFrame: 0, state: { ...st(), effectId: 'bakerate' } as any, length: 9999 })
    const k = spaceTypeLoopMultiplier(clip)
    const T = 180
    expect(k).toBe(3)

    await ensureSpaceTypeClipBake(clip)

    expect(capturedRenderCalls.length).toBe(k * T)
    expect(capturedRenderCalls.map(c => c.sourceFrame)).toEqual(Array.from({ length: k * T }, (_, i) => i))
    // The bake always forces loop:true (a clip authored with loop:false must not
    // clamp mid-cycle while baking the one full seamless cycle export tiles
    // from). It no longer needs to force in_frame:0 — sourceT01 doesn't read
    // clip.in_frame at all post-fix, so it's inert either way; this clip's
    // in_frame is 0 only because createSpaceTypeClip defaults it to 0.
    expect(capturedRenderCalls.every(c => c.inFrame === 0 && c.loop === true)).toBe(true)

    const src = { ...clip, loop: true }
    const t01s = capturedRenderCalls.map(c => sourceT01(src, c.sourceFrame))
    for (let i = 1; i < t01s.length; i++) expect(t01s[i]).toBeGreaterThan(t01s[i - 1])
    expect(t01s[T]).toBeCloseTo(1, 10)
    expect(Math.max(...t01s)).toBeGreaterThan(1)
  })
})

/** KEEP IN SYNC with TWIN_CASES in tests/timeline_spacetype_test.py. Pins that
 *  sourceT01 (browser live preview) and spacetype_source_index (Python export,
 *  indexing the k*T baked PNGs) map the same (in_frame, local_frame) pair to
 *  the same phase — idx = round(t01 * T). Critical 1 (unwrap at k*T) and
 *  Critical 2 (apply in_frame) both feed this table; a drift in either would
 *  fail it.
 *
 *  Re-derived for Critical 1's fix (sourceT01 no longer reads clip.in_frame —
 *  see its doc comment): the (T, k, in_frame, local_frame, loop) -> expected_idx
 *  values are UNCHANGED from before, because Python's spacetype_source_index
 *  always computed `raw = in_frame + local_frame` itself, on a clip-local
 *  frame — it never had Critical 1's double-apply bug. Only the JS call
 *  convention changes: the test now performs that same single addition BEFORE
 *  calling sourceT01 (mirroring what sourceFrameAt does in production),
 *  instead of relying on sourceT01 to do it internally. */
const TWIN_CASES: Array<[string, number, number, number, number, boolean, number]> = [
  // label,               T,   k, in_frame, local_frame, loop,  expected_idx
  ['start',               180, 3, 0,        0,           true,  0],
  ['one_loop_in',         180, 3, 0,        180,         true,  180],
  ['last_frame',          180, 3, 0,        539,         true,  539],
  ['wraps_at_cycle',      180, 3, 0,        540,         true,  0],
  ['in_frame_offset',     180, 3, 40,       100,         true,  140],
  ['in_frame_at_edge',    180, 3, 40,       500,         true,  0],
  ['in_frame_past',       180, 3, 40,       1000,        true,  500],
  ['hold_last_no_loop',   180, 3, 0,        600,         false, 539],
  ['hold_with_in',        180, 3, 550,      0,            false, 539],
  ['negative_wraps',      180, 3, 0,        -5,          true,  535],
]

describe('sourceT01 / spacetype_source_index twin table (Critical 1 + 2)', () => {
  it('sourceT01(clip, in_frame + local) * T matches the Python baked-frame index for every case', () => {
    __registerEffect({ id: 'twintest', label: 'twintest', controls: [], buildScene: () => ({}), update: () => {}, loopRates: () => [1 / 3] })
    for (const [label, T, k, inFrame, localFrame, loop, expectedIdx] of TWIN_CASES) {
      const clip = {
        ...createSpaceTypeClip({ startFrame: 0, state: { ...st(), effectId: 'twintest' } as any, length: 9999 }),
        loop,
      }
      expect(spaceTypeLoopMultiplier(clip), label).toBe(k)
      // The single point where in_frame gets folded in — production does this
      // via sourceFrameAt (shared/timeline/sourceFrame.ts), not inside sourceT01.
      const sourceFrame = inFrame + localFrame
      const t01 = sourceT01(clip, sourceFrame)
      expect(Math.round(t01 * T), label).toBe(expectedIdx)
    }
  })
})
