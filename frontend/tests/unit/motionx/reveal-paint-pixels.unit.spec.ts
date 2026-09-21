/**
 * DRAW-REVEAL-PIXELS — the canvas half of the Pixels style. Unlike the three MASK styles
 * (`reveal-paint.unit.spec.ts`), Pixels TRANSFORMS the layer: it is drawn alone onto a
 * frame-sized side canvas, run through the Shader Studio `ascii_dither` effect, optionally
 * cross-faded to the sharp layer, and stamped back. This file mirrors that spec's recorder
 * idiom (a `Proxy`-based fake 2D context tagged by WHICH canvas each call landed on) and its
 * `globalThis` `DOMMatrix` stand-in — extended with `multiply()`, which `paint.ts` doesn't
 * need but `paintPixels.ts` does (see step 2 of the recipe).
 *
 * This unit environment (`environment: 'node'`) has no `DOMMatrix`; `paintPixels.ts` is
 * written against the real DOM type, so this file supplies a minimal stand-in on
 * `globalThis` for the duration of the suite only — never as an environment guard inside
 * `paintPixels.ts` itself.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  drawRevealPixels, revealPixelsReady, setRevealPixelsDeps,
} from '~/lib/motionx/reveal/paintPixels'
import { pixelShaderParams, pixelSharp } from '~/lib/motionx/reveal'
import type { MotionReveal } from '~/lib/motionx/reveal'
import type { renderFieldWithBase } from '~/lib/shaderfill/field'

// ── minimal DOMMatrix stand-in (this file only; paintPixels.ts never guards on its absence,
//    and never assumes anything beyond the real DOMMatrix contract) ─────────────────────────

class FakeMatrix {
  a: number; b: number; c: number; d: number; e: number; f: number
  constructor(m: Partial<FakeMatrix> = {}) {
    this.a = m.a ?? 1; this.b = m.b ?? 0; this.c = m.c ?? 0
    this.d = m.d ?? 1; this.e = m.e ?? 0; this.f = m.f ?? 0
  }
  translate(tx = 0, ty = 0): FakeMatrix {
    return new FakeMatrix({ ...this, e: this.e + tx * this.a + ty * this.c, f: this.f + tx * this.b + ty * this.d })
  }
  scale(sx = 1, sy = sx): FakeMatrix {
    return new FakeMatrix({ a: this.a * sx, b: this.b * sx, c: this.c * sy, d: this.d * sy, e: this.e, f: this.f })
  }
  /** `this.multiply(other)` = `this ⋅ other` (matrix product; `other` applied FIRST, `this`
   *  applied after — the same convention the real DOMMatrix uses, and the one step 2 of the
   *  recipe relies on: `Translation(-e,-f).multiply(currentTransform)` must apply the
   *  current transform, THEN subtract the frame's own offset from the result). */
  multiply(o: FakeMatrix): FakeMatrix {
    return new FakeMatrix({
      a: this.a * o.a + this.c * o.b,
      b: this.b * o.a + this.d * o.b,
      c: this.a * o.c + this.c * o.d,
      d: this.b * o.c + this.d * o.d,
      e: this.a * o.e + this.c * o.f + this.e,
      f: this.b * o.e + this.d * o.f + this.f,
    })
  }
  inverse(): FakeMatrix {
    const { a, b, c, d, e, f } = this
    const det = a * d - b * c
    return new FakeMatrix({ a: d / det, b: -b / det, c: -c / det, d: a / det, e: (c * f - d * e) / det, f: (b * e - a * f) / det })
  }
}

let savedDOMMatrix: unknown
beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  savedDOMMatrix = g.DOMMatrix
  g.DOMMatrix = FakeMatrix
})
afterAll(() => {
  const g = globalThis as Record<string, unknown>
  g.DOMMatrix = savedDOMMatrix
})

// ── recording fakes (same idiom as reveal-paint.unit.spec.ts) ───────────────────────────────

interface Call { target: string; name: string; args: unknown[] }

function describeArg(v: unknown): string {
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    if (typeof rec.__scratchId === 'string') return `canvas(${rec.__scratchId})`
    if (rec instanceof FakeMatrix) return `matrix(${rec.a},${rec.b},${rec.c},${rec.d},${rec.e},${rec.f})`
  }
  return String(v)
}

function makeCtx(target: string, canvasRef: unknown, calls: Call[]): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {}
  const stack: Array<Record<string, unknown>> = []
  return new Proxy({}, {
    get(_t, key: string) {
      if (key === 'canvas') return canvasRef
      if (key === 'save') return () => { stack.push({ ...state }); calls.push({ target, name: 'save', args: [] }) }
      if (key === 'restore') return () => { const s = stack.pop(); if (s) Object.assign(state, s); calls.push({ target, name: 'restore', args: [] }) }
      if (key === 'getTransform') return () => (state.__transform as unknown) ?? new FakeMatrix()
      if (key === 'setTransform') return (...args: unknown[]) => {
        state.__transform = args.length === 1
          ? args[0]
          : new FakeMatrix({ a: args[0] as number, b: args[1] as number, c: args[2] as number, d: args[3] as number, e: args[4] as number, f: args[5] as number })
        calls.push({ target, name: 'setTransform', args })
      }
      if (key in state) return state[key]
      return (...args: unknown[]) => calls.push({ target, name: key, args })
    },
    set(_t, key: string, value: unknown) { state[key] = value; calls.push({ target, name: `set:${key}`, args: [value] }); return true },
  }) as unknown as CanvasRenderingContext2D
}

interface FakeCanvas { width: number; height: number; getContext: (t: string) => CanvasRenderingContext2D | null; __scratchId: string }

function makeScratchCanvas(calls: Call[], id: string, hasCtx: boolean): FakeCanvas {
  const canvas = { width: 0, height: 0, __scratchId: id } as FakeCanvas
  const ctx = hasCtx ? makeCtx(id, canvas, calls) : null
  canvas.getContext = () => ctx
  return canvas
}

let scratchSeq = 0
beforeEach(() => { scratchSeq = 0 })

type RenderFn = typeof renderFieldWithBase
type RenderArgs = Parameters<RenderFn>

function fakeRender(result: unknown, mode: 'ok' | 'throw' = 'ok') {
  const calls: RenderArgs[] = []
  const render = ((...args: RenderArgs) => {
    calls.push(args)
    if (mode === 'throw') throw new Error('shaderfx: catalog cold')
    return result as HTMLCanvasElement
  }) as RenderFn
  return { render, calls }
}

/** `devSize` sizes the (unused, for this module) device canvas backing `ctx` — only its
 *  `getTransform`/state matter here, there is no `dev` blit like `beginReveal`'s. A harness
 *  that never overrides `render` gets one that fails loudly if reached, so a geometry-gate
 *  test that unexpectedly falls through to the shader step is caught rather than silently
 *  passing for the wrong reason. */
function harness(render?: RenderFn) {
  const calls: Call[] = []
  const factoryCanvases: FakeCanvas[] = []
  setRevealPixelsDeps({
    makeCanvas: () => {
      const id = `s${scratchSeq++}`
      const c = makeScratchCanvas(calls, id, true)
      factoryCanvases.push(c)
      return c as unknown as HTMLCanvasElement
    },
    render: render ?? ((() => { throw new Error('render should not have been called') }) as RenderFn),
    ready: () => true,
  })
  const dev: FakeCanvas = { width: 100, height: 100, __scratchId: 'dev', getContext: () => null }
  const ctx = makeCtx('ctx', dev, calls)
  return { calls, ctx, dev, factoryCanvases }
}

const seqOf = (calls: Call[], target: string) =>
  calls.filter(c => c.target === target).map(c => `${c.name}(${c.args.map(describeArg).join(',')})`)
const callsOf = (calls: Call[], target: string, name: string) =>
  calls.filter(c => c.target === target && c.name === name)

// ── fixtures ─────────────────────────────────────────────────────────────────────────────

const W = 100, H = 50
const pixels = (over: Partial<MotionReveal> = {}): MotionReveal =>
  ({ style: 'pixels', out: false, cell: 0.024, drift: 6, angle: 0, softness: 0.35, chars: 1, amount: 0.5, elapsed: 0, ...over })
// scale 2, translate (10, 20) — the brief's own example.
const base = () => new FakeMatrix({ a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 }) as unknown as DOMMatrix
// The CURRENT ctx transform once a draw-time scale (uniform ×1.5, centred so it adds no
// translation of its own) is layered on top of `base` — base ⋅ extraScale.
const CURRENT = { a: 3, b: 0, c: 0, d: 3, e: 10, f: 20 }
const MOVED = { a: 3, b: 0, c: 0, d: 3, e: 0, f: 0 }   // Translation(-10,-20).multiply(CURRENT)
const stamp = { alpha: 0.7, blend: 'multiply' as GlobalCompositeOperation }

function setCurrentTransform(ctx: CanvasRenderingContext2D) {
  ctx.setTransform(CURRENT.a, CURRENT.b, CURRENT.c, CURRENT.d, CURRENT.e, CURRENT.f)
}

// ── revealPixelsReady ────────────────────────────────────────────────────────────────────

describe('revealPixelsReady', () => {
  it('delegates to the injected ready() dependency', () => {
    setRevealPixelsDeps({ ready: () => true })
    expect(revealPixelsReady()).toBe(true)
    setRevealPixelsDeps({ ready: () => false })
    expect(revealPixelsReady()).toBe(false)
  })
})

// ── drawRevealPixels: the frame-transform gate (step 1) ─────────────────────────────────

describe('drawRevealPixels — the frame-transform gate', () => {
  it('a rotated/skewed base returns false and touches nothing — no canvas is even acquired', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    calls.length = 0
    const rotated = new FakeMatrix({ a: 2, b: 0.5, c: 0, d: 2, e: 10, f: 20 }) as unknown as DOMMatrix
    const ok = drawRevealPixels(ctx, pixels(), W, H, rotated, () => { throw new Error('must not draw') }, stamp)
    expect(ok).toBe(false)
    expect(factoryCanvases).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('c non-zero (skew) also returns false untouched', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    calls.length = 0
    const skewed = new FakeMatrix({ a: 2, b: 0, c: 0.5, d: 2, e: 10, f: 20 }) as unknown as DOMMatrix
    expect(drawRevealPixels(ctx, pixels(), W, H, skewed, () => { throw new Error('must not draw') }, stamp)).toBe(false)
    expect(factoryCanvases).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('a frame rounding to fewer than 2px on either side returns false untouched', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    calls.length = 0
    const tiny = new FakeMatrix({ a: 0.001, b: 0, c: 0, d: 0.001, e: 0, f: 0 }) as unknown as DOMMatrix
    expect(drawRevealPixels(ctx, pixels(), 100, 100, tiny, () => { throw new Error('must not draw') }, stamp)).toBe(false)
    expect(factoryCanvases).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  // The gate used to be on AREA (16,000,000 px), which flipped a perfectly ordinary
  // 4096×4096 or 5334×3000 export to the Dissolve mask — a different look, silently. The
  // real limit is the browser's canvas SIDE, so the gate is per-side and says so in dev.
  const identity = () => new FakeMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as unknown as DOMMatrix

  it('a 8192×4608 frame — 37.7 megapixels — still runs', () => {
    const result = { __scratchId: 'result' }
    const { render } = fakeRender(result)
    const { ctx } = harness(render)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    expect(drawRevealPixels(ctx, pixels(), 8192, 4608, identity(), () => {}, stamp)).toBe(true)
  })

  it('a side over 8192px returns false untouched, either way round', () => {
    for (const [w, h] of [[8193, 100], [100, 8193]] as const) {
      const { calls, ctx, factoryCanvases } = harness()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      calls.length = 0
      expect(drawRevealPixels(ctx, pixels(), w, h, identity(), () => { throw new Error('must not draw') }, stamp)).toBe(false)
      expect(factoryCanvases).toHaveLength(0)
      expect(calls).toHaveLength(0)
    }
  })

  it('warns ONCE per session that the frame is too large and the Dissolve mask is used instead', () => {
    const warn = vi.fn()
    const { ctx } = harness()
    setRevealPixelsDeps({ warn })
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    for (let i = 0; i < 5; i++) drawRevealPixels(ctx, pixels(), 9000, 9000, identity(), () => {}, stamp)
    expect(warn).toHaveBeenCalledTimes(1)
    const said = String(warn.mock.calls[0]![0])
    expect(said).toMatch(/too large/i)
    expect(said).toMatch(/dissolve/i)
  })
})

// ── drawRevealPixels: the solo pass (step 2) ────────────────────────────────────────────

describe('drawRevealPixels — the solo pass', () => {
  it('acquires a fw×fh canvas, resets it (identity, clearRect), then moves the transform to Translation(-base.e,-base.f).multiply(currentTransform), and draws the layer under it', () => {
    const result = { __scratchId: 'result' }
    const { render, calls: renderCalls } = fakeRender(result)
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    calls.length = 0
    let sawTransform: FakeMatrix | null = null
    const drawLayer = (target: CanvasRenderingContext2D) => { sawTransform = target.getTransform() as unknown as FakeMatrix }
    const ok = drawRevealPixels(ctx, pixels(), W, H, base(), drawLayer, stamp)
    expect(ok).toBe(true)

    const solo = factoryCanvases[0]!
    expect(solo.width).toBe(200)   // fw = round(100 * 2)
    expect(solo.height).toBe(100)  // fh = round(50 * 2)

    const soloSeq = seqOf(calls, solo.__scratchId)
    // identity → the pooled context's leftover state is reset → clear → the moved transform.
    // (Property sets are recorded too; keep only the method calls for the order check.)
    const methods = soloSeq.filter((c) => !c.startsWith('set:'))
    expect(methods[0]).toBe('setTransform(1,0,0,1,0,0)')
    expect(methods[1]).toBe(`clearRect(0,0,200,100)`)
    expect(methods[2]).toBe(`setTransform(matrix(${MOVED.a},${MOVED.b},${MOVED.c},${MOVED.d},${MOVED.e},${MOVED.f}))`)
    const sets = calls.filter((c) => c.target === solo.__scratchId && c.name.startsWith('set:'))
    const firstClear = calls.findIndex((c) => c.target === solo.__scratchId && c.name === 'clearRect')
    for (const [prop, value] of [['globalAlpha', 1], ['globalCompositeOperation', 'source-over'], ['filter', 'none']] as const) {
      const at = calls.findIndex((c) => c.target === solo.__scratchId && c.name === `set:${prop}` && c.args[0] === value)
      expect(at, prop).toBeGreaterThan(-1)
      expect(at, prop).toBeLessThan(firstClear)      // reset BEFORE anything is drawn
    }
    expect(sets.length).toBeGreaterThanOrEqual(3)

    expect(sawTransform).not.toBeNull()
    const m = sawTransform! as FakeMatrix
    expect([m.a, m.b, m.c, m.d, m.e, m.f]).toEqual([MOVED.a, MOVED.b, MOVED.c, MOVED.d, MOVED.e, MOVED.f])

    // renderFieldWithBase was handed exactly this solo canvas as its base image.
    expect(renderCalls[0]![1]).toBe(solo)
  })

  it('a throwing drawLayer propagates, and releases the solo canvas for the NEXT call to reuse', () => {
    const { ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    expect(() => drawRevealPixels(ctx, pixels(), W, H, base(), () => { throw new Error('boom') }, stamp))
      .toThrow('boom')
    expect(factoryCanvases).toHaveLength(1)   // the solo canvas was acquired…

    const result = { __scratchId: 'result' }
    const { render } = fakeRender(result)
    setRevealPixelsDeps({ render })
    const ok = drawRevealPixels(ctx, pixels(), W, H, base(), () => {}, stamp)
    expect(ok).toBe(true)
    // …and reused, not re-manufactured: only ONE canvas was made for "solo" duty (a second,
    // distinct one is made for "out" this second call).
    expect(factoryCanvases).toHaveLength(2)
    expect(factoryCanvases[1]!.__scratchId).not.toBe(factoryCanvases[0]!.__scratchId)
  })
})

// ── drawRevealPixels: the shader call + immediate copy (step 3) ─────────────────────────

describe('drawRevealPixels — the shader call and immediate copy', () => {
  it('calls render with the ascii_dither spec, pixelShaderParams(reveal, W, H), speed 1, seed 42, fw/fh, t, and { u_matte: 1 }; then copies the result at once', () => {
    const result = { __scratchId: 'result' }
    const { render, calls: renderCalls } = fakeRender(result)
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    const reveal = pixels({ elapsed: 2.5, amount: 0.3 })
    const ok = drawRevealPixels(ctx, reveal, W, H, base(), () => {}, stamp)
    expect(ok).toBe(true)

    expect(renderCalls).toHaveLength(1)
    const [spec, soloArg, fw, fh, shape, t, extra, variant] = renderCalls[0]!
    expect((spec as { effectId: string }).effectId).toBe('ascii_dither')
    expect((spec as { params: unknown }).params).toEqual(pixelShaderParams(reveal, W, H))
    expect((spec as { speed: number }).speed).toBe(1)
    expect((spec as { seed: number }).seed).toBe(42)
    expect(soloArg).toBe(factoryCanvases[0])
    expect(fw).toBe(200)
    expect(fh).toBe(100)
    expect(shape).toBeUndefined()
    expect(t).toBe(2.5)
    expect(extra).toEqual({ u_matte: 1 })
    // The MATTE build variant: the matte path is compiled in, and the classic program
    // (Shader Studio, the server, the goldens) keeps its own, untouched token stream.
    expect(variant).toBe('MATTE')

    const out = factoryCanvases[1]!
    expect(out.width).toBe(200)
    expect(out.height).toBe(100)
    const copyOps = callsOf(calls, out.__scratchId, 'set:globalCompositeOperation')
    expect(copyOps.some(c => c.args[0] === 'copy')).toBe(true)
    const draws = callsOf(calls, out.__scratchId, 'drawImage')
    expect(draws[0]!.args).toEqual([result, 0, 0])
  })

  it('a non-finite elapsed passes t = 0, not NaN', () => {
    const result = { __scratchId: 'result' }
    const { render, calls: renderCalls } = fakeRender(result)
    const { ctx } = harness(render)
    setCurrentTransform(ctx)
    drawRevealPixels(ctx, pixels({ elapsed: NaN }), W, H, base(), () => {}, stamp)
    expect(renderCalls[0]![5]).toBe(0)
  })

  it('a negative elapsed clamps to 0', () => {
    const result = { __scratchId: 'result' }
    const { render, calls: renderCalls } = fakeRender(result)
    const { ctx } = harness(render)
    setCurrentTransform(ctx)
    drawRevealPixels(ctx, pixels({ elapsed: -4 }), W, H, base(), () => {}, stamp)
    expect(renderCalls[0]![5]).toBe(0)
  })

  it('a throwing render returns false, leaves ctx untouched, and releases the solo canvas', () => {
    const { render } = fakeRender(null, 'throw')
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    calls.length = 0
    const ok = drawRevealPixels(ctx, pixels(), W, H, base(), () => {}, stamp)
    expect(ok).toBe(false)
    expect(seqOf(calls, 'ctx')).toEqual([])   // step 5 (the stamp) never ran
    expect(factoryCanvases).toHaveLength(1)   // only "solo" was ever acquired
  })
})

// ── drawRevealPixels: sharp hand-off (step 4) ───────────────────────────────────────────

describe('drawRevealPixels — sharp hand-off', () => {
  it('amount 0.5 (pixelSharp === 0): no sharp draw at all', () => {
    expect(pixelSharp(0.5)).toBe(0)
    const result = { __scratchId: 'result' }
    const { render } = fakeRender(result)
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    drawRevealPixels(ctx, pixels({ amount: 0.5 }), W, H, base(), () => {}, stamp)
    const out = factoryCanvases[1]!
    expect(callsOf(calls, out.__scratchId, 'drawImage')).toHaveLength(1)   // just the initial copy
  })

  it('amount 0.9: a second draw of the solo canvas over out, source-over, at globalAlpha === pixelSharp(0.9)', () => {
    const result = { __scratchId: 'result' }
    const { render } = fakeRender(result)
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    drawRevealPixels(ctx, pixels({ amount: 0.9 }), W, H, base(), () => {}, stamp)
    const solo = factoryCanvases[0]!
    const out = factoryCanvases[1]!
    const draws = callsOf(calls, out.__scratchId, 'drawImage')
    expect(draws).toHaveLength(2)
    expect(draws[1]!.args[0]).toBe(solo)
    const alphaSets = callsOf(calls, out.__scratchId, 'set:globalAlpha').map(c => c.args[0])
    expect(alphaSets).toContain(pixelSharp(0.9))
    const blendSets = callsOf(calls, out.__scratchId, 'set:globalCompositeOperation').map(c => c.args[0])
    expect(blendSets[blendSets.length - 1]).toBe('source-over')
  })
})

// ── drawRevealPixels: the stamp (step 5) ────────────────────────────────────────────────

describe('drawRevealPixels — the stamp', () => {
  it('save(); filter=none; shadowColor=transparent; identity transform; globalAlpha=clamp01(stamp.alpha); compositeOperation=stamp.blend; drawImage(out, base.e, base.f); restore()', () => {
    const result = { __scratchId: 'result' }
    const { render } = fakeRender(result)
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    calls.length = 0
    const ok = drawRevealPixels(ctx, pixels(), W, H, base(), () => {}, stamp)
    expect(ok).toBe(true)
    const out = factoryCanvases[1]!
    expect(seqOf(calls, 'ctx')).toEqual([
      'save()',
      'set:filter(none)',
      'set:shadowColor(transparent)',
      'setTransform(1,0,0,1,0,0)',
      'set:globalAlpha(0.7)',
      'set:globalCompositeOperation(multiply)',
      `drawImage(canvas(${out.__scratchId}),10,20)`,
      'restore()',
    ])
  })

  it('clamps an out-of-range stamp.alpha into [0, 1]', () => {
    const result = { __scratchId: 'result' }
    const { render } = fakeRender(result)
    const { calls, ctx } = harness(render)
    setCurrentTransform(ctx)
    drawRevealPixels(ctx, pixels(), W, H, base(), () => {}, { alpha: 1.5, blend: 'source-over' })
    const alphaSets = callsOf(calls, 'ctx', 'set:globalAlpha').map(c => c.args[0])
    expect(alphaSets).toEqual([1])
  })
})

// ── drawRevealPixels: pool release (step 6) ─────────────────────────────────────────────

describe('drawRevealPixels — the scratch-canvas pools', () => {
  it('a successful call releases both canvases; the next call reuses them rather than making new ones', () => {
    const result = { __scratchId: 'result' }
    const { render } = fakeRender(result)
    const { ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    drawRevealPixels(ctx, pixels(), W, H, base(), () => {}, stamp)
    expect(factoryCanvases).toHaveLength(2)
    drawRevealPixels(ctx, pixels(), W, H, base(), () => {}, stamp)
    expect(factoryCanvases).toHaveLength(2)   // both reused, none leaked
  })
})

// ── wiring: the two hunks landed in useCompositorLayers.ts, in the right place ──────────

describe('paintLayerStack wiring for Pixels (source-level guard)', () => {
  const SRC = readFileSync(
    fileURLToPath(new URL('../../../app/composables/useCompositorLayers.ts', import.meta.url)),
    'utf8',
  )
  const fnStart = SRC.indexOf('export function paintLayerStack')

  it('paintLayerStack exists', () => {
    expect(fnStart).toBeGreaterThanOrEqual(0)
  })

  it('drawRevealPixels( is called exactly once, and before const motionActive', () => {
    const count = SRC.split('drawRevealPixels(').length - 1
    expect(count).toBe(1)
    const callIdx = SRC.indexOf('drawRevealPixels(', fnStart)
    const motionActiveIdx = SRC.indexOf('const motionActive', fnStart)
    expect(callIdx).toBeGreaterThan(fnStart)
    expect(motionActiveIdx).toBeGreaterThan(callIdx)
  })

  it('pixelsBase = ctx.getTransform() is captured before the first .motionScale read', () => {
    const captureIdx = SRC.indexOf('pixelsBase = ctx.getTransform()', fnStart)
    const readIdx = SRC.indexOf('.motionScale', fnStart)
    expect(captureIdx).toBeGreaterThan(fnStart)
    expect(readIdx).toBeGreaterThan(fnStart)
    expect(captureIdx).toBeLessThan(readIdx)
  })

  it('revealPixelsReady() gates the Pixels capture in the first hunk', () => {
    expect(SRC.indexOf('revealPixelsReady()', fnStart)).toBeGreaterThan(fnStart)
  })
})
