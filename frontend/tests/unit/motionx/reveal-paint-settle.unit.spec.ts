/**
 * DRAW-REVEAL-SETTLE — the canvas half of the Settle family (Addendum 3). The layer is drawn
 * alone onto a frame-sized side canvas (the shared `soloPass`), then its transparency is
 * recovered EXACTLY through three GPU passes: the same shader, same clock, same uniforms, run
 * once over the layer PREMULTIPLIED ONTO BLACK and once over its COVERAGE, divided by a tiny
 * combine pass.
 *
 * Mirrors `reveal-paint-assemble.unit.spec.ts`'s recorder idiom (a `Proxy`-based fake 2D context
 * tagged by WHICH canvas each call landed on) and its `globalThis` `DOMMatrix` stand-in. The one
 * addition: the two shader calls and the combine call are recorded into the SAME ordered list as
 * the canvas calls, so "every render result is copied BEFORE the next render" is testable.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { drawRevealSettle, SETTLE_COMBINE_ID, SETTLE_COMBINE_FRAG } from '~/lib/motionx/reveal/paintSettle'
import {
  drawRevealShaderStyle, revealShaderReady, ensureRevealShadersReady, setRevealPixelsDeps,
} from '~/lib/motionx/reveal/paintPixels'
import {
  revealParams, isShaderRevealStyle,
  settleEffectOf, settleSpec, settleStrength, settleUniforms, settleFade,
} from '~/lib/motionx/reveal'
import type { MotionReveal } from '~/lib/motionx/reveal'
import type { renderFieldWithBase } from '~/lib/shaderfill/field'

// ── minimal DOMMatrix stand-in (this file only) ────────────────────────────────────────────

class FakeMatrix {
  a: number; b: number; c: number; d: number; e: number; f: number
  constructor(m: Partial<FakeMatrix> = {}) {
    this.a = m.a ?? 1; this.b = m.b ?? 0; this.c = m.c ?? 0
    this.d = m.d ?? 1; this.e = m.e ?? 0; this.f = m.f ?? 0
  }
  translate(tx = 0, ty = 0): FakeMatrix {
    return new FakeMatrix({ ...this, e: this.e + tx * this.a + ty * this.c, f: this.f + tx * this.b + ty * this.d })
  }
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

// ── recording fakes ────────────────────────────────────────────────────────────────────────

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

interface FakeCanvas {
  width: number; height: number
  getContext: (t: string, o?: unknown) => CanvasRenderingContext2D | null
  __scratchId: string; __ctxOpts?: unknown
}

function makeScratchCanvas(calls: Call[], id: string): FakeCanvas {
  const canvas = { width: 0, height: 0, __scratchId: id } as FakeCanvas
  const ctx = makeCtx(id, canvas, calls)
  canvas.getContext = (_t: string, o?: unknown) => { canvas.__ctxOpts = o; return ctx }
  return canvas
}

let scratchSeq = 0
beforeEach(() => { scratchSeq = 0 })

type RenderFn = typeof renderFieldWithBase
type RenderArgs = Parameters<RenderFn>
type CombineArgs = [unknown[], unknown, number, number, Record<string, unknown> | undefined]

const RENDER_RESULTS = [{ __scratchId: 'shaderA' }, { __scratchId: 'shaderK' }]
const COMBINE_RESULT = { __scratchId: 'combined' }

interface HarnessOpts {
  renderThrows?: 0 | 1 | false
  combineThrows?: boolean
  ready?: (id: string) => boolean
}

function harness(opts: HarnessOpts = {}) {
  const calls: Call[] = []
  const factoryCanvases: FakeCanvas[] = []
  const renderCalls: RenderArgs[] = []
  const combineCalls: CombineArgs[] = []
  const readyFx = vi.fn(opts.ready ?? (() => true))
  setRevealPixelsDeps({
    makeCanvas: () => {
      const c = makeScratchCanvas(calls, `s${scratchSeq++}`)
      factoryCanvases.push(c)
      return c as unknown as HTMLCanvasElement
    },
    render: ((...args: RenderArgs) => {
      const nth = renderCalls.length
      renderCalls.push(args)
      calls.push({ target: 'gl', name: 'render', args: [] })
      if (opts.renderThrows === nth) throw new Error('shaderfx: catalog cold')
      return RENDER_RESULTS[nth] as unknown as HTMLCanvasElement
    }) as RenderFn,
    combine: ((...args: CombineArgs) => {
      combineCalls.push(args)
      calls.push({ target: 'gl', name: 'combine', args: [] })
      if (opts.combineThrows) throw new Error('shaderfx: combine failed')
      return COMBINE_RESULT as unknown as HTMLCanvasElement
    }) as never,
    readyFx,
  })
  const dev: FakeCanvas = { width: 100, height: 100, __scratchId: 'dev', getContext: () => null }
  const ctx = makeCtx('ctx', dev, calls)
  return { calls, ctx, dev, factoryCanvases, renderCalls, combineCalls, readyFx }
}

const seqOf = (calls: Call[], target: string) =>
  calls.filter(c => c.target === target).map(c => `${c.name}(${c.args.map(describeArg).join(',')})`)
const callsOf = (calls: Call[], target: string, name: string) =>
  calls.filter(c => c.target === target && c.name === name)
/** The value a property held at the moment the `index`-th call on `target` was recorded. */
const propAt = (calls: Call[], target: string, prop: string, index: number) => {
  let v: unknown
  for (let i = 0; i < index; i++) {
    const c = calls[i]!
    if (c.target === target && c.name === `set:${prop}`) v = c.args[0]
  }
  return v
}
const indexOfCall = (calls: Call[], target: string, name: string, nth = 0) => {
  let seen = 0
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!
    if (c.target === target && c.name === name) { if (seen === nth) return i; seen++ }
  }
  return -1
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────

const W = 100, H = 50
const FW = 200, FH = 100
const settle = (over: Partial<MotionReveal> = {}, note?: Partial<{ effect: string; strength: number; fade: boolean }>): MotionReveal => ({
  ...revealParams({}),
  style: 'settle',
  amount: 0.5,
  elapsed: 0,
  settle: { effect: 'slice', strength: 0.7, fade: true, ...note },
  ...over,
})
// scale 2, translate (10, 20) — the same frame the Pixels / Assemble specs use: fw 200, fh 100.
const base = () => new FakeMatrix({ a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 }) as unknown as DOMMatrix
const CURRENT = { a: 3, b: 0, c: 0, d: 3, e: 10, f: 20 }
const MOVED = { a: 3, b: 0, c: 0, d: 3, e: 0, f: 0 }
const stamp = { alpha: 0.7, blend: 'multiply' as GlobalCompositeOperation }

function setCurrentTransform(ctx: CanvasRenderingContext2D) {
  ctx.setTransform(CURRENT.a, CURRENT.b, CURRENT.c, CURRENT.d, CURRENT.e, CURRENT.f)
}

// ── step 1: the gate and the solo pass are SHARED with Pixels / Assemble ───────────────────

describe('drawRevealSettle — the gate and the solo pass (step 1)', () => {
  it('a rotated base returns false and touches nothing — no canvas is even acquired', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    calls.length = 0
    const rotated = new FakeMatrix({ a: 2, b: 0.5, c: 0, d: 2, e: 10, f: 20 }) as unknown as DOMMatrix
    expect(drawRevealSettle(ctx, settle(), W, H, rotated, () => { throw new Error('must not draw') }, stamp)).toBe(false)
    expect(factoryCanvases).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('a side over 8192px returns false untouched', () => {
    const identity = new FakeMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as unknown as DOMMatrix
    const { calls, ctx, factoryCanvases } = harness()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    calls.length = 0
    expect(drawRevealSettle(ctx, settle(), 8193, 100, identity, () => { throw new Error('must not draw') }, stamp)).toBe(false)
    expect(factoryCanvases).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('draws the layer alone onto a fw×fh canvas under Translation(-base.e,-base.f)⋅currentTransform', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    calls.length = 0
    let sawTransform: FakeMatrix | null = null
    expect(drawRevealSettle(ctx, settle(), W, H, base(), (t) => { sawTransform = t.getTransform() as unknown as FakeMatrix }, stamp)).toBe(true)
    const solo = factoryCanvases[0]!
    expect(solo.width).toBe(FW)
    expect(solo.height).toBe(FH)
    const methods = seqOf(calls, solo.__scratchId).filter((c) => !c.startsWith('set:'))
    expect(methods[0]).toBe('setTransform(1,0,0,1,0,0)')
    expect(methods[1]).toBe(`clearRect(0,0,${FW},${FH})`)
    expect(methods[2]).toBe(`setTransform(matrix(${MOVED.a},${MOVED.b},${MOVED.c},${MOVED.d},${MOVED.e},${MOVED.f}))`)
    const m = sawTransform! as unknown as FakeMatrix
    expect([m.a, m.b, m.c, m.d, m.e, m.f]).toEqual([MOVED.a, MOVED.b, MOVED.c, MOVED.d, MOVED.e, MOVED.f])
  })

  it('a throwing drawLayer propagates, and releases the solo canvas for the NEXT call to reuse', () => {
    const { ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    expect(() => drawRevealSettle(ctx, settle(), W, H, base(), () => { throw new Error('boom') }, stamp)).toThrow('boom')
    expect(factoryCanvases).toHaveLength(1)
    expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(true)
    // the solo canvas was REUSED, not re-manufactured: 1 + the FIVE others, not 1 + six.
    expect(factoryCanvases).toHaveLength(6)
  })
})

// ── step 2: the two input canvases ─────────────────────────────────────────────────────────

describe('drawRevealSettle — the colour and coverage inputs (step 2)', () => {
  it('colourIn is the layer PREMULTIPLIED ONTO BLACK: opaque black, then the layer source-over', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(true)

    const solo = factoryCanvases[0]!
    const colourIn = factoryCanvases[1]!
    expect(colourIn.width).toBe(FW)
    expect(colourIn.height).toBe(FH)
    const methods = seqOf(calls, colourIn.__scratchId).filter((c) => !c.startsWith('set:'))
    expect(methods).toEqual([
      'setTransform(1,0,0,1,0,0)',
      `fillRect(0,0,${FW},${FH})`,
      `drawImage(canvas(${solo.__scratchId}),0,0)`,
    ])
    const fillIdx = indexOfCall(calls, colourIn.__scratchId, 'fillRect')
    expect(propAt(calls, colourIn.__scratchId, 'globalCompositeOperation', fillIdx)).toBe('copy')
    expect(propAt(calls, colourIn.__scratchId, 'fillStyle', fillIdx)).toBe('#000000')
    expect(propAt(calls, colourIn.__scratchId, 'globalAlpha', fillIdx)).toBe(1)
    const drawIdx = indexOfCall(calls, colourIn.__scratchId, 'drawImage')
    expect(propAt(calls, colourIn.__scratchId, 'globalCompositeOperation', drawIdx)).toBe('source-over')
  })

  it('coverIn is WHITE where the layer is, on BLACK: the layer, source-in white, destination-over black', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(true)

    const solo = factoryCanvases[0]!
    const coverIn = factoryCanvases[2]!
    expect(coverIn.width).toBe(FW)
    expect(coverIn.height).toBe(FH)
    const methods = seqOf(calls, coverIn.__scratchId).filter((c) => !c.startsWith('set:'))
    expect(methods).toEqual([
      'setTransform(1,0,0,1,0,0)',
      `drawImage(canvas(${solo.__scratchId}),0,0)`,
      `fillRect(0,0,${FW},${FH})`,
      `fillRect(0,0,${FW},${FH})`,
    ])
    const drawIdx = indexOfCall(calls, coverIn.__scratchId, 'drawImage')
    expect(propAt(calls, coverIn.__scratchId, 'globalCompositeOperation', drawIdx)).toBe('copy')
    const whiteIdx = indexOfCall(calls, coverIn.__scratchId, 'fillRect', 0)
    expect(propAt(calls, coverIn.__scratchId, 'globalCompositeOperation', whiteIdx)).toBe('source-in')
    expect(propAt(calls, coverIn.__scratchId, 'fillStyle', whiteIdx)).toBe('#ffffff')
    const blackIdx = indexOfCall(calls, coverIn.__scratchId, 'fillRect', 1)
    expect(propAt(calls, coverIn.__scratchId, 'globalCompositeOperation', blackIdx)).toBe('destination-over')
    expect(propAt(calls, coverIn.__scratchId, 'fillStyle', blackIdx)).toBe('#000000')
  })

  it('the solo canvas itself is only READ — it is never drawn into or masked', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(true)
    const solo = factoryCanvases[0]!
    expect(callsOf(calls, solo.__scratchId, 'drawImage')).toHaveLength(0)
    expect(callsOf(calls, solo.__scratchId, 'fillRect')).toHaveLength(0)
  })
})

// ── step 3: the two shader passes ──────────────────────────────────────────────────────────

describe('drawRevealSettle — the colour and coverage renders (step 3)', () => {
  it('runs the SAME spec, clock and uniforms over both inputs, at the frame size, with no shape', () => {
    const { ctx, factoryCanvases, renderCalls } = harness()
    setCurrentTransform(ctx)
    const r = settle({ amount: 0.4, elapsed: 0.5 }, { effect: 'glitch', strength: 0.8 })
    expect(drawRevealSettle(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)

    expect(renderCalls).toHaveLength(2)
    const effect = settleEffectOf('glitch')
    const k = settleStrength(0.4, 0.8)
    const [specA, baseA, fwA, fhA, shapeA, tA, uA] = renderCalls[0]!
    const [specK, baseK, fwK, fhK, shapeK, tK, uK] = renderCalls[1]!
    expect(specA).toEqual(settleSpec(effect))
    expect(specA).toBe(specK)                  // the SAME object, not merely equal
    expect(uA).toEqual(settleUniforms(effect, k))
    expect(uA).toBe(uK)
    expect(tA).toBe(0.5)
    expect(tK).toBe(0.5)
    expect(shapeA).toBeUndefined()
    expect(shapeK).toBeUndefined()
    expect([fwA, fhA, fwK, fhK]).toEqual([FW, FH, FW, FH])
    expect(baseA).toBe(factoryCanvases[1])     // colourIn
    expect(baseK).toBe(factoryCanvases[2])     // coverIn
  })

  it('an unknown effect id falls back to Slice, and a missing note to the stored defaults', () => {
    const { ctx, renderCalls } = harness()
    setCurrentTransform(ctx)
    const r = settle({ amount: 0.25 }, { effect: 'no-such-tile' })
    expect(drawRevealSettle(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)
    expect((renderCalls[0]![0] as { effectId: string }).effectId).toBe('slice_shift')
    expect(renderCalls[0]![6]).toEqual(settleUniforms(settleEffectOf('slice'), settleStrength(0.25, 0.7)))
  })

  it('a non-finite or negative elapsed passes t = 0, not NaN', () => {
    for (const elapsed of [NaN, -4]) {
      const { ctx, renderCalls } = harness()
      setCurrentTransform(ctx)
      drawRevealSettle(ctx, settle({ elapsed }), W, H, base(), () => {}, stamp)
      expect(renderCalls[0]![5]).toBe(0)
    }
  })

  it('EACH render result is copied into its own pooled canvas BEFORE the next render runs', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(true)

    const colourOut = factoryCanvases[3]!
    const coverOut = factoryCanvases[4]!
    for (const [i, [out, result]] of ([[colourOut, RENDER_RESULTS[0]], [coverOut, RENDER_RESULTS[1]]] as const).entries()) {
      expect(out.width).toBe(FW)
      expect(out.height).toBe(FH)
      const draws = callsOf(calls, out.__scratchId, 'drawImage')
      expect(draws).toHaveLength(1)
      expect(draws[0]!.args).toEqual([result, 0, 0])
      const at = indexOfCall(calls, out.__scratchId, 'drawImage')
      expect(propAt(calls, out.__scratchId, 'globalCompositeOperation', at)).toBe('copy')
      expect(propAt(calls, out.__scratchId, 'globalAlpha', at)).toBe(1)
      // …and that copy happened before the NEXT GPU call (the second render, then the combine).
      const nextGpu = i === 0
        ? indexOfCall(calls, 'gl', 'render', 1)
        : indexOfCall(calls, 'gl', 'combine')
      expect(at).toBeLessThan(nextGpu)
    }
  })

  it('a throwing render returns false, leaves ctx untouched, and releases every canvas', () => {
    for (const which of [0, 1] as const) {
      const opts: HarnessOpts = { renderThrows: which }
      const { calls, ctx, factoryCanvases } = harness(opts)
      setCurrentTransform(ctx)
      calls.length = 0
      expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(false)
      expect(seqOf(calls, 'ctx')).toEqual([])
      // solo + the two inputs, plus the colour copy when it is the SECOND render that throws
      expect(factoryCanvases).toHaveLength(which === 0 ? 3 : 4)
      // …every one of them back in its pool: the next, successful call still ends at six.
      opts.renderThrows = false
      expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(true)
      expect(factoryCanvases).toHaveLength(6)
    }
  })
})

// ── step 4: the combine pass ───────────────────────────────────────────────────────────────

describe('drawRevealSettle — the combine pass (step 4)', () => {
  it('runs ONE pass of the combine shader over colourOut with coverOut as a LIVE texture', () => {
    const { ctx, factoryCanvases, combineCalls } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(true)

    expect(combineCalls).toHaveLength(1)
    const [passes, combineBase, cw, ch, live] = combineCalls[0]!
    expect(passes).toHaveLength(1)
    const pass = passes[0] as { id: string; source: string; textures?: unknown }
    expect(pass.id).toBe(SETTLE_COMBINE_ID)
    expect(pass.source).toBe(SETTLE_COMBINE_FRAG)
    // a per-frame canvas must NOT ride the identity-cached `textures` of the pass
    expect(pass.textures).toBeUndefined()
    expect(combineBase).toBe(factoryCanvases[3])          // colourOut
    expect([cw, ch]).toEqual([FW, FH])
    expect(live).toEqual({ u_cover: factoryCanvases[4] }) // coverOut
  })

  it('the combine frag keeps the catalogue header, divides colour by coverage and writes STRAIGHT alpha', () => {
    expect(SETTLE_COMBINE_FRAG.startsWith('#version 300 es\n')).toBe(true)
    expect(SETTLE_COMBINE_FRAG).toMatch(/precision highp float;/)
    expect(SETTLE_COMBINE_FRAG).toMatch(/uniform sampler2D u_image0;/)
    expect(SETTLE_COMBINE_FRAG).toMatch(/uniform sampler2D u_cover;/)
    expect(SETTLE_COMBINE_FRAG).toMatch(/in vec2 v_texCoord;/)
    expect(SETTLE_COMBINE_FRAG).toMatch(/layout\(location = 0\) out vec4 fragColor0;/)
    expect(SETTLE_COMBINE_FRAG).toMatch(/float alpha = max\(kc\.r, max\(kc\.g, kc\.b\)\);/)
    expect(SETTLE_COMBINE_FRAG).toMatch(/vec3 rgb = a \/ max\(alpha, 1e-4\);/)
    expect(SETTLE_COMBINE_FRAG).toMatch(/fragColor0 = vec4\(clamp\(rgb, 0\.0, 1\.0\), alpha\);/)
  })

  it('the combine result is copied AT ONCE into the stamped canvas', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(true)
    const out = factoryCanvases[5]!
    expect(out.width).toBe(FW)
    expect(out.height).toBe(FH)
    const draws = callsOf(calls, out.__scratchId, 'drawImage')
    expect(draws).toHaveLength(1)
    expect(draws[0]!.args).toEqual([COMBINE_RESULT, 0, 0])
    const at = indexOfCall(calls, out.__scratchId, 'drawImage')
    expect(propAt(calls, out.__scratchId, 'globalCompositeOperation', at)).toBe('copy')
    expect(at).toBeGreaterThan(indexOfCall(calls, 'gl', 'combine'))
  })

  it('a throwing combine returns false, leaves ctx untouched, and releases every canvas', () => {
    const opts: HarnessOpts = { combineThrows: true }
    const { calls, ctx, factoryCanvases } = harness(opts)
    setCurrentTransform(ctx)
    calls.length = 0
    expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(false)
    expect(seqOf(calls, 'ctx')).toEqual([])
    expect(factoryCanvases).toHaveLength(5)        // no stamped canvas was ever taken
    opts.combineThrows = false
    expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(true)
    expect(factoryCanvases).toHaveLength(6)
  })
})

// ── step 5: the stamp ──────────────────────────────────────────────────────────────────────

describe('drawRevealSettle — the hand-off to the real layer (step 4b)', () => {
  it('lays the sharp layer over the effect near the end of the bar, at settleSharp(amount), before the stamp', async () => {
    const { settleSharp } = await import('~/lib/motionx/reveal')
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle({ amount: 0.95 }), W, H, base(), () => {}, stamp)).toBe(true)
    const solo = factoryCanvases[0]!, out = factoryCanvases[5]!
    const draws = callsOf(calls, out.__scratchId, 'drawImage')
    expect(draws).toHaveLength(2)                       // the combine result, then the sharp layer
    expect(draws[1]!.args).toEqual([solo, 0, 0])
    // A TRUE cross-fade, out × (1 − s) + solo × s: what is there is scaled DOWN first
    // (destination-out at alpha s), then the sharp layer is ADDED (lighter at alpha s).
    // `source-over` would stack the two coverages on every anti-aliased edge.
    const fill = indexOfCall(calls, out.__scratchId, 'fillRect')
    const at = indexOfCall(calls, out.__scratchId, 'drawImage', 1)
    expect(fill).toBeGreaterThan(-1); expect(fill).toBeLessThan(at)
    expect(propAt(calls, out.__scratchId, 'globalCompositeOperation', fill)).toBe('destination-out')
    expect(propAt(calls, out.__scratchId, 'globalAlpha', fill)).toBeCloseTo(settleSharp(0.95), 9)
    expect(callsOf(calls, out.__scratchId, 'fillRect')[0]!.args).toEqual([0, 0, FW, FH])
    expect(propAt(calls, out.__scratchId, 'globalCompositeOperation', at)).toBe('lighter')
    expect(propAt(calls, out.__scratchId, 'globalAlpha', at)).toBeCloseTo(settleSharp(0.95), 9)
    expect(at).toBeLessThan(indexOfCall(calls, 'ctx', 'drawImage'))
  })
  it('does nothing of the kind for the first 85% of the bar', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle({ amount: 0.6 }), W, H, base(), () => {}, stamp)).toBe(true)
    expect(callsOf(calls, factoryCanvases[5]!.__scratchId, 'drawImage')).toHaveLength(1)
  })
})

describe('drawRevealSettle — the stamp (step 5)', () => {
  it('stamps the combined canvas at the frame origin with the layer\'s blend and the FADED alpha', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    calls.length = 0
    expect(drawRevealSettle(ctx, settle({ amount: 0.1 }), W, H, base(), () => {}, stamp)).toBe(true)
    const out = factoryCanvases[5]!
    expect(seqOf(calls, 'ctx')).toEqual([
      'save()',
      'set:filter(none)',
      'set:shadowColor(transparent)',
      'setTransform(1,0,0,1,0,0)',
      `set:globalAlpha(${0.7 * settleFade(0.1, true)})`,
      'set:globalCompositeOperation(multiply)',
      `drawImage(canvas(${out.__scratchId}),10,20)`,
      'restore()',
    ])
  })

  it('fade off keeps the layer\'s own opacity from the first frame', () => {
    const { calls, ctx } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle({ amount: 0.02 }, { fade: false }), W, H, base(), () => {}, stamp)).toBe(true)
    expect(callsOf(calls, 'ctx', 'set:globalAlpha').map(c => c.args[0])).toEqual([0.7])
  })

  it('clamps an out-of-range stamp.alpha into [0, 1]', () => {
    const { calls, ctx } = harness()
    setCurrentTransform(ctx)
    drawRevealSettle(ctx, settle(), W, H, base(), () => {}, { alpha: 1.5, blend: 'source-over' })
    expect(callsOf(calls, 'ctx', 'set:globalAlpha').map(c => c.args[0])).toEqual([1])
  })
})

// ── the not-ready fallback: a PLAIN FADE, never the Dissolve mask ──────────────────────────

describe('drawRevealSettle — while the effect is still loading', () => {
  it('stamps the layer un-processed with the fade alpha, returns true, and runs no GPU pass at all', () => {
    const { calls, ctx, factoryCanvases, renderCalls, combineCalls, readyFx } = harness({ ready: () => false })
    setCurrentTransform(ctx)
    calls.length = 0
    expect(drawRevealSettle(ctx, settle({ amount: 0.1 }), W, H, base(), () => {}, stamp)).toBe(true)
    expect(renderCalls).toHaveLength(0)
    expect(combineCalls).toHaveLength(0)
    // the solo canvas is the only one taken, and it is stamped as it is
    expect(factoryCanvases).toHaveLength(1)
    const solo = factoryCanvases[0]!
    expect(seqOf(calls, 'ctx')).toEqual([
      'save()',
      'set:filter(none)',
      'set:shadowColor(transparent)',
      'setTransform(1,0,0,1,0,0)',
      `set:globalAlpha(${0.7 * settleFade(0.1, true)})`,
      'set:globalCompositeOperation(multiply)',
      `drawImage(canvas(${solo.__scratchId}),10,20)`,
      'restore()',
    ])
    // …and asking KICKS the load, for the effect THIS bar needs
    expect(readyFx).toHaveBeenCalledWith('slice_shift')
  })

  it('asks about the bar\'s OWN effect, and releases the solo canvas for the next frame', () => {
    const { ctx, factoryCanvases, readyFx } = harness({ ready: () => false })
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle({}, { effect: 'swirl' }), W, H, base(), () => {}, stamp)).toBe(true)
    expect(readyFx).toHaveBeenLastCalledWith('swirl')
    expect(drawRevealSettle(ctx, settle({}, { effect: 'swirl' }), W, H, base(), () => {}, stamp)).toBe(true)
    expect(factoryCanvases).toHaveLength(1)
  })
})

// ── the scratch-canvas pools ───────────────────────────────────────────────────────────────

describe('drawRevealSettle — the scratch-canvas pools', () => {
  it('a successful call releases every canvas; the next call reuses them rather than making new ones', () => {
    const { ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(true)
    expect(factoryCanvases).toHaveLength(6)   // solo, colourIn, coverIn, colourOut, coverOut, out
    expect(drawRevealSettle(ctx, settle(), W, H, base(), () => {}, stamp)).toBe(true)
    expect(factoryCanvases).toHaveLength(6)   // all six reused, none leaked
  })
})

// ── the dispatcher ─────────────────────────────────────────────────────────────────────────

describe('drawRevealShaderStyle — routing a settle bar', () => {
  it('a settle bar runs the Settle recipe: two renders and a combine, not the Pixels one', () => {
    const { ctx, renderCalls, combineCalls } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealShaderStyle(ctx, settle({}, { effect: 'wave' }), W, H, base(), () => {}, stamp)).toBe(true)
    expect(renderCalls).toHaveLength(2)
    expect((renderCalls[0]![0] as { effectId: string }).effectId).toBe('wave')
    expect(combineCalls).toHaveLength(1)
  })

  it('a pixels bar still runs the Pixels recipe — one render, no combine', () => {
    const { ctx, renderCalls, combineCalls } = harness()
    setCurrentTransform(ctx)
    const r = { ...settle(), style: 'pixels' } as MotionReveal
    expect(drawRevealShaderStyle(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)
    expect(renderCalls).toHaveLength(1)
    expect((renderCalls[0]![0] as { effectId: string }).effectId).toBe('ascii_dither')
    expect(combineCalls).toHaveLength(0)
  })
})

describe('revealShaderReady — a settle bar is always ready to draw', () => {
  it('true even with a cold catalogue: the fallback is the painter\'s own plain fade, not the Dissolve mask', () => {
    const readyFx = vi.fn(() => false)
    setRevealPixelsDeps({ readyFx })
    expect(revealShaderReady(settle())).toBe(true)
    expect(readyFx).not.toHaveBeenCalled()
  })

  it('and the compositor treats settle as a TRANSFORMING style, so it takes the side-canvas route', () => {
    expect(isShaderRevealStyle('settle')).toBe(true)
  })
})

describe('ensureRevealShadersReady — settle bars are waited for too', () => {
  it('awaits each bar\'s own effect, dither and settle bars alike, once each', async () => {
    const whenReadyFx = vi.fn(async () => true)
    setRevealPixelsDeps({ whenReadyFx })
    const ok = await ensureRevealShadersReady([
      { kind: 'settle', params: { effect: 'swirl' } },
      { kind: 'settle', params: { effect: 'swirl' } },      // the same effect, once
      { kind: 'settle' },                                   // slice is the default
      { kind: 'dither', params: { style: 'pixels' } },
      { kind: 'dither', params: { style: 'wipe' } },        // no shader
      { kind: 'move' },
    ], 1234)
    expect(ok).toBe(true)
    expect(whenReadyFx.mock.calls.map(c => (c as unknown as [string, number])[0]).sort())
      .toEqual(['ascii_dither', 'slice_shift', 'swirl'])
    expect(whenReadyFx).toHaveBeenCalledWith('swirl', 1234)
  })

  it('a settle bar whose effect never arrives is REPORTED, not thrown', async () => {
    setRevealPixelsDeps({ whenReadyFx: async () => false })
    await expect(ensureRevealShadersReady([{ kind: 'settle' }])).resolves.toBe(false)
  })
})

// ── whole-slice review follow-ups ────────────────────────────────────────────────────────────
describe('the combine shader recovers colour with ONE alpha, not per channel', () => {
  it('divides by the pixel\'s alpha (the max channel coverage), so a weaker channel is not blown up to full strength', async () => {
    const { SETTLE_COMBINE_FRAG } = await import('~/lib/motionx/reveal/paintSettle')
    expect(SETTLE_COMBINE_FRAG).toContain('float alpha = max(kc.r, max(kc.g, kc.b));')
    expect(SETTLE_COMBINE_FRAG).toContain('vec3 rgb = a / max(alpha, 1e-4);')
    // the per-channel divide drew a colour split's fringes up to 5× too strong
    expect(SETTLE_COMBINE_FRAG).not.toContain('a / max(kc')
    expect(SETTLE_COMBINE_FRAG).not.toMatch(/mix\(a, rgb/)
    expect(SETTLE_COMBINE_FRAG).toContain('fragColor0 = vec4(clamp(rgb, 0.0, 1.0), alpha);')
  })
})

describe('the coverage render asks for the COVER build when the effect has one', () => {
  it('Glitch: its band darkening must stay in the COLOUR (dividing would cancel it there and land it on ALPHA as flicker)', () => {
    const { renderCalls, ctx } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle({}, { effect: 'glitch' }), W, H, base(), () => {}, stamp)).toBe(true)
    expect(renderCalls).toHaveLength(2)
    expect(renderCalls[0]![7]).toBeUndefined()           // colour: the classic program
    expect(renderCalls[1]![7]).toBe('COVER')             // coverage: no darkening
  })
  it('every other effect runs the SAME classic program for both renders', () => {
    const { renderCalls, ctx } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealSettle(ctx, settle({}, { effect: 'slice' }), W, H, base(), () => {}, stamp)).toBe(true)
    expect(renderCalls.map((c) => c[7])).toEqual([undefined, undefined])
  })
})
