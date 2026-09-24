import { describe, it, expect } from 'vitest'
import { bakeFrameSequence, frameCountFor, finishCinematicSample, TILE_CALL_CEILING } from '~/lib/scene3d/bakeFrames'
import type { SceneEngine } from '~/lib/scene3d/engine'

/** A fake path tracer: `render()` counts calls; `cinematicStatus().samples` derives from that count
 *  via `callsPerSample` (9 = the real tracer's 3x3 tiling — see PathTracer.ts's `tiles.set(3, 3)`;
 *  0 = a tracer that never converges, samples stuck at 0 forever). `hardCap` guards the TEST itself:
 *  if `finishCinematicSample` ever lost its own ceiling, render() throws well before the runner
 *  would hang, so the regression fails fast instead of timing out. */
function fakeEngine(callsPerSample: number, hardCap: number): { engine: Pick<SceneEngine, 'render' | 'cinematicStatus'>; callCount: () => number } {
  let calls = 0
  const engine: Pick<SceneEngine, 'render' | 'cinematicStatus'> = {
    render: () => {
      calls++
      if (calls > hardCap) throw new Error('render() called past the test hard cap — finishCinematicSample did not stop')
    },
    cinematicStatus: () => ({ samples: callsPerSample > 0 ? Math.floor(calls / callsPerSample) : 0, compiling: false }),
  } as Pick<SceneEngine, 'render' | 'cinematicStatus'>
  return { engine, callCount: () => calls }
}

/** A fake engine whose reported sample count never changes, regardless of render() calls — used to
 *  assert the "target already met" case makes no render call. Guarded the same way. */
function fixedSampleEngine(samples: number, hardCap: number): { engine: Pick<SceneEngine, 'render' | 'cinematicStatus'>; callCount: () => number } {
  let calls = 0
  const engine: Pick<SceneEngine, 'render' | 'cinematicStatus'> = {
    render: () => {
      calls++
      if (calls > hardCap) throw new Error('render() called past the test hard cap — finishCinematicSample did not stop')
    },
    cinematicStatus: () => ({ samples, compiling: false }),
  } as Pick<SceneEngine, 'render' | 'cinematicStatus'>
  return { engine, callCount: () => calls }
}

const fakeCanvas = (tag: string) => ({ tag }) as unknown as HTMLCanvasElement

describe('frameCountFor', () => {
  it('an animated loop is duration × fps frames', () => { expect(frameCountFor({ animated: true, duration: 4 }, 30)).toBe(120) })
  it('rounds, and never goes below one', () => { expect(frameCountFor({ animated: true, duration: 0.01 }, 30)).toBe(1) })
  it('a still scene is one frame', () => { expect(frameCountFor({ animated: false, duration: 0 }, 30)).toBe(1) })
})

describe('bakeFrameSequence', () => {
  it('renders t = i / count for each frame, in order, and encodes each', async () => {
    const seen: number[] = []
    const frames = await bakeFrameSequence({
      count: 4,
      renderAt: (t) => { seen.push(t); return fakeCanvas(String(t)) },
      encode: async (c) => `data:image/webp;base64,${(c as any).tag}`,
    })
    expect(seen).toEqual([0, 0.25, 0.5, 0.75])
    expect(frames).toEqual(['data:image/webp;base64,0', 'data:image/webp;base64,0.25', 'data:image/webp;base64,0.5', 'data:image/webp;base64,0.75'])
  })
  it('reports progress after each frame', async () => {
    const progress: string[] = []
    await bakeFrameSequence({ count: 2, renderAt: () => fakeCanvas('x'), encode: async () => 'd', onProgress: (d, t) => progress.push(`${d}/${t}`) })
    expect(progress).toEqual(['1/2', '2/2'])
  })
  it('stops between frames when aborted', async () => {
    const ac = new AbortController()
    let rendered = 0
    const p = bakeFrameSequence({ count: 10, renderAt: () => { rendered++; if (rendered === 2) ac.abort(); return fakeCanvas('x') }, encode: async () => 'd', signal: ac.signal })
    await expect(p).rejects.toThrow(/abort/i)
    expect(rendered).toBe(2)
  })
  it('encodes each frame before rendering the next (the canvas is reused)', async () => {
    const order: string[] = []
    await bakeFrameSequence({ count: 2, renderAt: (t) => { order.push(`r${t}`); return fakeCanvas('x') }, encode: async () => { order.push('e'); return 'd' } })
    expect(order).toEqual(['r0', 'e', 'r0.5', 'e'])
  })
})

describe('finishCinematicSample', () => {
  it('stops the instant the reported sample count reaches target — no calls beyond that', () => {
    const target = 3
    const { engine, callCount } = fakeEngine(9, target * TILE_CALL_CEILING)
    finishCinematicSample(engine, target)
    // 9 render() calls per reported sample (the tracer's 3x3 tiling): reaching 3 samples takes
    // exactly 27 calls, and the loop must not call render() once more after that.
    expect(callCount()).toBe(target * 9)
  })

  it('a tracer whose sample count never rises stops after exactly the cap — it cannot hang', () => {
    const target = 5
    const cap = target * TILE_CALL_CEILING
    // hardCap is one above the real cap: if the source's own ceiling were ever removed, this fake
    // throws instead of looping forever, so the regression fails the test rather than hanging it.
    const { engine, callCount } = fakeEngine(0, cap + 1)
    finishCinematicSample(engine, target)
    expect(callCount()).toBe(cap)
  })

  it('a target already met makes no render call', () => {
    const target = 5
    const { engine, callCount } = fixedSampleEngine(target, target * TILE_CALL_CEILING)
    finishCinematicSample(engine, target)
    expect(callCount()).toBe(0)
  })
})
