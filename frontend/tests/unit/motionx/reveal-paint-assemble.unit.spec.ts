/**
 * DRAW-REVEAL-ASSEMBLE — the canvas half of the Assemble style. Like Pixels it TRANSFORMS the
 * layer (drawn alone onto a frame-sized side canvas, run through a Shader Studio effect,
 * stamped back); unlike Pixels the blocks never refine — a look picture and the sharp layer are
 * each cut by a per-cell mask built on the SHADER'S OWN grid, which is anchored at the canvas's
 * BOTTOM-left (the WebGL texcoord origin), and composed.
 *
 * Mirrors `reveal-paint-pixels.unit.spec.ts`'s recorder idiom (a `Proxy`-based fake 2D context
 * tagged by WHICH canvas each call landed on) and its `globalThis` `DOMMatrix` stand-in, plus
 * an `ImageData` stand-in and a `getImageData` hook this module needs and Pixels does not.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drawRevealAssemble } from '~/lib/motionx/reveal/paintAssemble'
import {
  drawRevealShaderStyle, revealShaderReady, ensureRevealShadersReady, setRevealPixelsDeps,
} from '~/lib/motionx/reveal/paintPixels'
import {
  revealParams, assembleShaderParams, assembleShaderExtras, assembleGrid, buildAssembleMasks,
  isShaderRevealStyle, driftCells,
} from '~/lib/motionx/reveal'
import type { MotionReveal } from '~/lib/motionx/reveal'
import type { renderFieldWithBase } from '~/lib/shaderfill/field'

// ── minimal DOMMatrix / ImageData stand-ins (this file only) ───────────────────────────────

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

class FakeImageData {
  data: Uint8ClampedArray; width: number; height: number
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data; this.width = width; this.height = height
  }
}

let savedDOMMatrix: unknown
let savedImageData: unknown
beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  savedDOMMatrix = g.DOMMatrix; savedImageData = g.ImageData
  g.DOMMatrix = FakeMatrix; g.ImageData = FakeImageData
})
afterAll(() => {
  const g = globalThis as Record<string, unknown>
  g.DOMMatrix = savedDOMMatrix; g.ImageData = savedImageData
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

/** What the fake `getImageData` hands back for the coverage read. Default: every cell opaque.
 *  Reset per test so one test's sparse coverage can never leak into the next. */
const OPAQUE = (w: number, h: number) => { const d = new Uint8ClampedArray(w * h * 4); d.fill(255); return d }
let coverAlphaFor: (w: number, h: number) => Uint8ClampedArray = OPAQUE
beforeEach(() => { coverAlphaFor = OPAQUE })

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
      if (key === 'getImageData') return (...args: unknown[]) => {
        calls.push({ target, name: 'getImageData', args })
        const w = args[2] as number, h = args[3] as number
        return new FakeImageData(coverAlphaFor(w, h), w, h)
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

function makeScratchCanvas(calls: Call[], id: string, hasCtx: boolean): FakeCanvas {
  const canvas = { width: 0, height: 0, __scratchId: id } as FakeCanvas
  const ctx = hasCtx ? makeCtx(id, canvas, calls) : null
  canvas.getContext = (_t: string, o?: unknown) => { canvas.__ctxOpts = o; return ctx }
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
    readyFx: () => true,
  })
  const dev: FakeCanvas = { width: 100, height: 100, __scratchId: 'dev', getContext: () => null }
  const ctx = makeCtx('ctx', dev, calls)
  return { calls, ctx, dev, factoryCanvases }
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
const assemble = (over: Partial<MotionReveal> = {}): MotionReveal =>
  ({ ...revealParams({ style: 'assemble' }), amount: 0.5, elapsed: 0, ...over })
// scale 2, translate (10, 20) — the same frame Pixels' spec uses: fw = 200, fh = 100.
const base = () => new FakeMatrix({ a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 }) as unknown as DOMMatrix
const CURRENT = { a: 3, b: 0, c: 0, d: 3, e: 10, f: 20 }
const MOVED = { a: 3, b: 0, c: 0, d: 3, e: 0, f: 0 }
const stamp = { alpha: 0.7, blend: 'multiply' as GlobalCompositeOperation }
const FW = 200, FH = 100

function setCurrentTransform(ctx: CanvasRenderingContext2D) {
  ctx.setTransform(CURRENT.a, CURRENT.b, CURRENT.c, CURRENT.d, CURRENT.e, CURRENT.f)
}

/** The shader's own grid for this fixture, and the bottom-left anchored rect it lives in. */
function gridOf(r: MotionReveal) {
  const g = assembleGrid(r, W, H, FW, FH)
  return { ...g, gw: g.cols * g.cellW, gh: g.rows * g.cellH, gy: FH - g.rows * g.cellH }
}

// ── step 1–2: the gate and the solo pass are SHARED with Pixels ────────────────────────────

describe('drawRevealAssemble — the gate and the solo pass (shared with Pixels)', () => {
  it('a rotated base returns false and touches nothing — no canvas is even acquired', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    calls.length = 0
    const rotated = new FakeMatrix({ a: 2, b: 0.5, c: 0, d: 2, e: 10, f: 20 }) as unknown as DOMMatrix
    expect(drawRevealAssemble(ctx, assemble(), W, H, rotated, () => { throw new Error('must not draw') }, stamp)).toBe(false)
    expect(factoryCanvases).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('a frame rounding to fewer than 2px on either side returns false untouched', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    calls.length = 0
    const tiny = new FakeMatrix({ a: 0.001, b: 0, c: 0, d: 0.001, e: 0, f: 0 }) as unknown as DOMMatrix
    expect(drawRevealAssemble(ctx, assemble(), 100, 100, tiny, () => { throw new Error('must not draw') }, stamp)).toBe(false)
    expect(factoryCanvases).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('a side over 8192px returns false untouched', () => {
    const identity = new FakeMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as unknown as DOMMatrix
    const { calls, ctx, factoryCanvases } = harness()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    calls.length = 0
    expect(drawRevealAssemble(ctx, assemble(), 8193, 100, identity, () => { throw new Error('must not draw') }, stamp)).toBe(false)
    expect(factoryCanvases).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('draws the layer alone onto a fw×fh canvas under Translation(-base.e,-base.f)⋅currentTransform, and hands THAT canvas to the shader', () => {
    const { render, calls: renderCalls } = fakeRender({ __scratchId: 'result' })
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    calls.length = 0
    let sawTransform: FakeMatrix | null = null
    const ok = drawRevealAssemble(ctx, assemble(), W, H, base(), (t) => { sawTransform = t.getTransform() as unknown as FakeMatrix }, stamp)
    expect(ok).toBe(true)

    const solo = factoryCanvases[0]!
    expect(solo.width).toBe(FW)
    expect(solo.height).toBe(FH)
    const methods = seqOf(calls, solo.__scratchId).filter((c) => !c.startsWith('set:'))
    expect(methods[0]).toBe('setTransform(1,0,0,1,0,0)')
    expect(methods[1]).toBe(`clearRect(0,0,${FW},${FH})`)
    expect(methods[2]).toBe(`setTransform(matrix(${MOVED.a},${MOVED.b},${MOVED.c},${MOVED.d},${MOVED.e},${MOVED.f}))`)
    const m = sawTransform! as unknown as FakeMatrix
    expect([m.a, m.b, m.c, m.d, m.e, m.f]).toEqual([MOVED.a, MOVED.b, MOVED.c, MOVED.d, MOVED.e, MOVED.f])
    expect(renderCalls[0]![1]).toBe(solo)
  })

  it('a throwing drawLayer propagates, and releases the solo canvas for the NEXT call to reuse', () => {
    const { ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    expect(() => drawRevealAssemble(ctx, assemble(), W, H, base(), () => { throw new Error('boom') }, stamp)).toThrow('boom')
    expect(factoryCanvases).toHaveLength(1)
    const { render } = fakeRender({ __scratchId: 'result' })
    setRevealPixelsDeps({ render })
    expect(drawRevealAssemble(ctx, assemble(), W, H, base(), () => {}, stamp)).toBe(true)
    // the solo canvas was REUSED, not re-manufactured: 1 + the SIX others, not 1 + seven.
    expect(factoryCanvases).toHaveLength(7)
  })
})

// ── step 3: the look picture ───────────────────────────────────────────────────────────────

describe('drawRevealAssemble — the look picture (step 3)', () => {
  it('Dither look: the bayer_dither spec, its params, speed 1, seed 42, fw/fh, t, the SHIMMER build and its whole-cell offsets', () => {
    const result = { __scratchId: 'result' }
    const { render, calls: renderCalls } = fakeRender(result)
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    const r = assemble({ elapsed: 0.5, amount: 0.3 })
    expect(drawRevealAssemble(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)

    expect(renderCalls).toHaveLength(1)
    const [spec, soloArg, fw, fh, shape, t, extra, variant] = renderCalls[0]!
    expect((spec as { effectId: string }).effectId).toBe('bayer_dither')
    expect((spec as { params: unknown }).params).toEqual(assembleShaderParams(r, W, H).params)
    expect((spec as { speed: number }).speed).toBe(1)
    expect((spec as { seed: number }).seed).toBe(42)
    expect(soloArg).toBe(factoryCanvases[0])
    expect(fw).toBe(FW)
    expect(fh).toBe(FH)
    expect(shape).toBeUndefined()
    expect(t).toBe(0.5)
    // drift 6 at 0.5s, angle 0 → 3 whole cells: the threshold pattern slides, the picture does not.
    expect(driftCells(r)).toEqual({ dx: 3, dy: 0 })
    expect(extra).toMatchObject({ u_shimmerX: -3, u_shimmerY: 0 })
    // …plus the EXACT cell size as a uniform override (the manifest's clamp must not reach this dial)
    expect(extra).toEqual(assembleShaderExtras(r, W, H).uniforms)
    expect((extra as Record<string, number>).u_scale).toBeCloseTo((r.cell * W) / H, 9)
    expect(variant).toBe('SHIMMER')

    // …and the result is copied AT ONCE (it is only valid until the next render call).
    const look = factoryCanvases[1]!
    expect(look.width).toBe(FW)
    expect(look.height).toBe(FH)
    const firstDraw = indexOfCall(calls, look.__scratchId, 'drawImage')
    expect(firstDraw).toBeGreaterThan(-1)
    expect(calls[firstDraw]!.args).toEqual([result, 0, 0])
    expect(propAt(calls, look.__scratchId, 'globalCompositeOperation', firstDraw)).toBe('copy')
  })

  it('Characters look: the ascii_dither spec, the MATTE build and u_matte', () => {
    const { render, calls: renderCalls } = fakeRender({ __scratchId: 'result' })
    const { ctx } = harness(render)
    setCurrentTransform(ctx)
    const r = assemble({ look: 'characters' })
    expect(drawRevealAssemble(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)
    const [spec, , , , , , extra, variant] = renderCalls[0]!
    expect((spec as { effectId: string }).effectId).toBe('ascii_dither')
    expect((spec as { params: unknown }).params).toEqual(assembleShaderParams(r, W, H).params)
    expect(extra).toEqual({ u_matte: 1, u_cell: (r.cell * W) / H })
    expect(variant).toBe('MATTE')
  })

  it('a non-finite or negative elapsed passes t = 0, not NaN', () => {
    for (const elapsed of [NaN, -4]) {
      const { render, calls: renderCalls } = fakeRender({ __scratchId: 'result' })
      const { ctx } = harness(render)
      setCurrentTransform(ctx)
      drawRevealAssemble(ctx, assemble({ elapsed }), W, H, base(), () => {}, stamp)
      expect(renderCalls[0]![5]).toBe(0)
    }
  })

  it('a throwing render returns false, leaves ctx untouched, and releases the solo canvas', () => {
    const { render } = fakeRender(null, 'throw')
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    calls.length = 0
    expect(drawRevealAssemble(ctx, assemble(), W, H, base(), () => {}, stamp)).toBe(false)
    expect(seqOf(calls, 'ctx')).toEqual([])
    expect(factoryCanvases).toHaveLength(1)
  })
})

// ── Custom characters (Task 15): the Characters look only ──────────────────────────────────

describe('drawRevealAssemble — Custom characters (chars: 14)', () => {
  it('Characters look: customAtlas is called with reveal.customChars, and its result becomes textures.u_customGlyphs', () => {
    const { render, calls: renderCalls } = fakeRender({ __scratchId: 'result' })
    const { ctx } = harness(render)
    setCurrentTransform(ctx)
    const atlas = { __scratchId: 'atlas' } as unknown as HTMLCanvasElement
    const customAtlas = vi.fn(() => atlas)
    setRevealPixelsDeps({ customAtlas })
    const r = assemble({ look: 'characters', chars: 14, customChars: 'AB09' })
    expect(drawRevealAssemble(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)
    expect(customAtlas).toHaveBeenCalledTimes(1)
    expect(customAtlas).toHaveBeenCalledWith('AB09')
    expect(renderCalls[0]![8]).toEqual({ u_customGlyphs: atlas })
  })

  it('Characters look with any other set: textures is undefined and customAtlas is never called', () => {
    const { render, calls: renderCalls } = fakeRender({ __scratchId: 'result' })
    const { ctx } = harness(render)
    setCurrentTransform(ctx)
    const customAtlas = vi.fn(() => ({}) as unknown as HTMLCanvasElement)
    setRevealPixelsDeps({ customAtlas })
    const r = assemble({ look: 'characters', chars: 7 })
    expect(drawRevealAssemble(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)
    expect(customAtlas).not.toHaveBeenCalled()
    expect(renderCalls[0]![8]).toBeUndefined()
  })

  it('Dither look never passes it, even when chars happens to be 14 — bayer_dither has no u_shape at all', () => {
    const { render, calls: renderCalls } = fakeRender({ __scratchId: 'result' })
    const { ctx } = harness(render)
    setCurrentTransform(ctx)
    const customAtlas = vi.fn(() => ({}) as unknown as HTMLCanvasElement)
    setRevealPixelsDeps({ customAtlas })
    const r = assemble({ look: 'dither', chars: 14, customChars: 'AB09' })
    expect(drawRevealAssemble(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)
    expect(customAtlas).not.toHaveBeenCalled()
    expect(renderCalls[0]![8]).toBeUndefined()
  })
})

// ── step 4: the coverage read ──────────────────────────────────────────────────────────────

describe('drawRevealAssemble — the coverage read (step 4)', () => {
  it('Dither look: a cols×rows canvas asked for with willReadFrequently, the layer squeezed into it from the BOTTOM-left anchored grid rect, smoothing ON', () => {
    const { render } = fakeRender({ __scratchId: 'result' })
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    const r = assemble()
    expect(drawRevealAssemble(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)

    const g = gridOf(r)
    expect(g.cols).toBe(63)            // ceil(200 / 3.2) — fh is NOT a multiple of cellH
    expect(g.rows).toBe(32)            // ceil(100 / 3.2)
    expect(g.gy).toBeLessThan(0)       // the grid starts ABOVE the canvas's top edge

    const solo = factoryCanvases[0]!
    const cover = factoryCanvases[2]!
    expect(cover.width).toBe(g.cols)
    expect(cover.height).toBe(g.rows)
    expect(cover.__ctxOpts).toEqual({ willReadFrequently: true })
    const draws = callsOf(calls, cover.__scratchId, 'drawImage')
    expect(draws).toHaveLength(1)
    expect(draws[0]!.args).toEqual([solo, 0, g.gy, g.gw, g.gh, 0, 0, g.cols, g.rows])
    const drawIdx = indexOfCall(calls, cover.__scratchId, 'drawImage')
    expect(propAt(calls, cover.__scratchId, 'imageSmoothingEnabled', drawIdx)).toBe(true)
    const reads = callsOf(calls, cover.__scratchId, 'getImageData')
    expect(reads).toHaveLength(1)
    expect(reads[0]!.args).toEqual([0, 0, g.cols, g.rows])
  })

  it('Characters look: no coverage canvas at all — the ASCII matte carries its own alpha', () => {
    const { render } = fakeRender({ __scratchId: 'result' })
    const { calls, ctx } = harness(render)
    setCurrentTransform(ctx)
    expect(drawRevealAssemble(ctx, assemble({ look: 'characters' }), W, H, base(), () => {}, stamp)).toBe(true)
    expect(callsOf(calls, 's2', 'getImageData')).toHaveLength(0)
    expect(calls.filter(c => c.name === 'getImageData')).toHaveLength(0)
  })
})

// ── step 5: the two masks ──────────────────────────────────────────────────────────────────

describe('drawRevealAssemble — the two masks (step 5)', () => {
  it('Dither look: the look mask is buildAssembleMasks fed the COVERAGE of each cell (0–255), drawn destination-in over the look picture at the anchored rect with smoothing OFF', () => {
    // A sparse coverage pattern: every third cell is empty, plus one half-transparent cell
    // whose block must come out HALF-transparent (not dropped, not made opaque).
    coverAlphaFor = (w, h) => {
      const d = new Uint8ClampedArray(w * h * 4)
      for (let k = 0; k < w * h; k++) d[k * 4 + 3] = k % 3 === 0 ? 0 : (k === 1 ? 127 : 255)
      return d
    }
    const { render } = fakeRender({ __scratchId: 'result' })
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    const r = assemble()
    expect(drawRevealAssemble(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)

    const g = gridOf(r)
    const covered = new Uint8Array(g.cols * g.rows)
    for (let k = 0; k < covered.length; k++) covered[k] = k % 3 === 0 ? 0 : (k === 1 ? 127 : 255)
    const expected = buildAssembleMasks(r, { cols: g.cols, rows: g.rows }, covered)

    const look = factoryCanvases[1]!
    const maskLook = factoryCanvases[3]!
    expect(maskLook.width).toBe(g.cols)
    expect(maskLook.height).toBe(g.rows)
    const put = callsOf(calls, maskLook.__scratchId, 'putImageData')
    expect(put).toHaveLength(1)
    const img = put[0]!.args[0] as FakeImageData
    expect(img.width).toBe(g.cols)
    expect(img.height).toBe(g.rows)
    expect(Array.from(img.data)).toEqual(Array.from(expected.look))
    expect(put[0]!.args.slice(1)).toEqual([0, 0])

    // …cut into the look picture, destination-in, at the bottom-left anchored rect.
    const lookDraws = callsOf(calls, look.__scratchId, 'drawImage')
    expect(lookDraws).toHaveLength(2)                      // the copy, then the mask
    expect(lookDraws[1]!.args).toEqual([maskLook, 0, g.gy, g.gw, g.gh])
    const at = indexOfCall(calls, look.__scratchId, 'drawImage', 1)
    expect(propAt(calls, look.__scratchId, 'globalCompositeOperation', at)).toBe('destination-in')
    expect(propAt(calls, look.__scratchId, 'imageSmoothingEnabled', at)).toBe(false)
  })

  it('the sharp mask is cut into a COPY of the solo canvas, never into the solo canvas itself', () => {
    const { render } = fakeRender({ __scratchId: 'result' })
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    const r = assemble()
    expect(drawRevealAssemble(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)

    const g = gridOf(r)
    const covered = new Uint8Array(g.cols * g.rows).fill(1)
    const expected = buildAssembleMasks(r, { cols: g.cols, rows: g.rows }, covered)

    const solo = factoryCanvases[0]!
    const sharp = factoryCanvases[4]!
    const maskSharp = factoryCanvases[5]!
    expect(sharp.width).toBe(FW)
    expect(sharp.height).toBe(FH)
    const sharpDraws = callsOf(calls, sharp.__scratchId, 'drawImage')
    expect(sharpDraws).toHaveLength(2)
    expect(sharpDraws[0]!.args).toEqual([solo, 0, 0])      // the copy…
    expect(propAt(calls, sharp.__scratchId, 'globalCompositeOperation', indexOfCall(calls, sharp.__scratchId, 'drawImage'))).toBe('copy')
    expect(sharpDraws[1]!.args).toEqual([maskSharp, 0, g.gy, g.gw, g.gh])   // …then the mask
    const at = indexOfCall(calls, sharp.__scratchId, 'drawImage', 1)
    expect(propAt(calls, sharp.__scratchId, 'globalCompositeOperation', at)).toBe('destination-in')
    expect(propAt(calls, sharp.__scratchId, 'imageSmoothingEnabled', at)).toBe(false)

    const put = callsOf(calls, maskSharp.__scratchId, 'putImageData')
    expect(Array.from((put[0]!.args[0] as FakeImageData).data)).toEqual(Array.from(expected.sharp))
    // the solo canvas itself is never masked — it is only read
    expect(callsOf(calls, solo.__scratchId, 'drawImage')).toHaveLength(0)
  })

  it('Characters look: no coverage array is applied — the look mask is the unfiltered one', () => {
    const { render } = fakeRender({ __scratchId: 'result' })
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    const r = assemble({ look: 'characters' })
    expect(drawRevealAssemble(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)
    const g = gridOf(r)
    const expected = buildAssembleMasks(r, { cols: g.cols, rows: g.rows })
    const maskLook = factoryCanvases[2]!      // no coverage canvas, so the mask is one earlier
    const put = callsOf(calls, maskLook.__scratchId, 'putImageData')
    expect(Array.from((put[0]!.args[0] as FakeImageData).data)).toEqual(Array.from(expected.look))
  })
})

// ── step 6: compose and stamp ──────────────────────────────────────────────────────────────

describe('drawRevealAssemble — compose and stamp (step 6)', () => {
  it('copies the look picture into out, draws the masked sharp copy over it source-over, and stamps out at the frame origin', () => {
    const { render } = fakeRender({ __scratchId: 'result' })
    const { calls, ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    calls.length = 0
    expect(drawRevealAssemble(ctx, assemble(), W, H, base(), () => {}, stamp)).toBe(true)

    const look = factoryCanvases[1]!
    const sharp = factoryCanvases[4]!
    const out = factoryCanvases[6]!
    expect(out.width).toBe(FW)
    expect(out.height).toBe(FH)
    const draws = callsOf(calls, out.__scratchId, 'drawImage')
    expect(draws).toHaveLength(2)
    expect(draws[0]!.args).toEqual([look, 0, 0])
    expect(propAt(calls, out.__scratchId, 'globalCompositeOperation', indexOfCall(calls, out.__scratchId, 'drawImage'))).toBe('copy')
    expect(draws[1]!.args).toEqual([sharp, 0, 0])
    expect(propAt(calls, out.__scratchId, 'globalCompositeOperation', indexOfCall(calls, out.__scratchId, 'drawImage', 1))).toBe('source-over')

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
    const { render } = fakeRender({ __scratchId: 'result' })
    const { calls, ctx } = harness(render)
    setCurrentTransform(ctx)
    drawRevealAssemble(ctx, assemble(), W, H, base(), () => {}, { alpha: 1.5, blend: 'source-over' })
    expect(callsOf(calls, 'ctx', 'set:globalAlpha').map(c => c.args[0])).toEqual([1])
  })
})

// ── the scratch-canvas pools ───────────────────────────────────────────────────────────────

describe('drawRevealAssemble — the scratch-canvas pools', () => {
  it('a successful call releases every canvas; the next call reuses them rather than making new ones', () => {
    const { render } = fakeRender({ __scratchId: 'result' })
    const { ctx, factoryCanvases } = harness(render)
    setCurrentTransform(ctx)
    expect(drawRevealAssemble(ctx, assemble(), W, H, base(), () => {}, stamp)).toBe(true)
    expect(factoryCanvases).toHaveLength(7)   // solo, look, cover, look mask, sharp, sharp mask, out
    expect(drawRevealAssemble(ctx, assemble(), W, H, base(), () => {}, stamp)).toBe(true)
    expect(factoryCanvases).toHaveLength(7)   // all seven reused, none leaked
  })
})

// ── the dispatcher ─────────────────────────────────────────────────────────────────────────

describe('drawRevealShaderStyle — routing', () => {
  it('an assemble bar runs the Assemble recipe; a pixels bar runs the Pixels one', () => {
    for (const [style, effectId] of [['assemble', 'bayer_dither'], ['pixels', 'ascii_dither']] as const) {
      const { render, calls: renderCalls } = fakeRender({ __scratchId: 'result' })
      const { ctx } = harness(render)
      setCurrentTransform(ctx)
      const r = { ...assemble(), style } as MotionReveal
      expect(drawRevealShaderStyle(ctx, r, W, H, base(), () => {}, stamp)).toBe(true)
      expect((renderCalls[0]![0] as { effectId: string }).effectId).toBe(effectId)
    }
  })
})

describe('revealShaderReady — readiness per style and look', () => {
  it('asks the field module for the effect THAT bar needs', () => {
    const readyFx = vi.fn((id: string) => id === 'bayer_dither')
    setRevealPixelsDeps({ readyFx })
    expect(revealShaderReady(assemble())).toBe(true)
    expect(readyFx).toHaveBeenLastCalledWith('bayer_dither')
    expect(revealShaderReady(assemble({ look: 'characters' }))).toBe(false)
    expect(readyFx).toHaveBeenLastCalledWith('ascii_dither')
    expect(revealShaderReady({ ...assemble(), style: 'pixels' })).toBe(false)
    expect(readyFx).toHaveBeenLastCalledWith('ascii_dither')
  })

  it('a MASK style needs no shader at all — false, and nothing is asked', () => {
    const readyFx = vi.fn(() => true)
    setRevealPixelsDeps({ readyFx })
    expect(revealShaderReady({ ...assemble(), style: 'dissolve' })).toBe(false)
    expect(readyFx).not.toHaveBeenCalled()
  })
})

describe('ensureRevealShadersReady — the export\'s wait, per bar', () => {
  it('awaits exactly the effects the bars need, once each, timeout and all', async () => {
    const whenReadyFx = vi.fn(async () => true)
    setRevealPixelsDeps({ whenReadyFx })
    const ok = await ensureRevealShadersReady([
      { kind: 'dither', params: { style: 'assemble' } },                        // Dither look
      { kind: 'dither', params: { style: 'assemble', look: 'characters' } },    // ASCII
      { kind: 'dither', params: { style: 'pixels' } },                          // ASCII again
      { kind: 'dither', params: { style: 'wipe' } },                            // no shader
      { kind: 'move' },                                                         // not a dither bar
    ], 1234)
    expect(ok).toBe(true)
    expect(whenReadyFx.mock.calls.map(c => (c as unknown as [string, number])[0]).sort())
      .toEqual(['ascii_dither', 'bayer_dither'])
    expect(whenReadyFx).toHaveBeenCalledWith('bayer_dither', 1234)
  })

  it('no dither bar (or no behaviours at all) resolves true without asking anything', async () => {
    const whenReadyFx = vi.fn(async () => true)
    setRevealPixelsDeps({ whenReadyFx })
    await expect(ensureRevealShadersReady(undefined)).resolves.toBe(true)
    await expect(ensureRevealShadersReady([{ kind: 'dither', params: { style: 'dots' } }])).resolves.toBe(true)
    expect(whenReadyFx).not.toHaveBeenCalled()
  })

  it('a timed-out wait is REPORTED, not thrown — the export goes ahead in the fallback look', async () => {
    setRevealPixelsDeps({ whenReadyFx: async () => false })
    await expect(ensureRevealShadersReady([{ kind: 'dither', params: { style: 'assemble' } }])).resolves.toBe(false)
  })

  it('by default asks the shaderfill field module, per effect id', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../app/lib/motionx/reveal/paintPixels.ts', import.meta.url)), 'utf8')
    expect(src).toMatch(/whenFieldEffectReady\(\s*id/)
    expect(src).toMatch(/fieldEffectReady\(\s*id/)
  })
})

describe('isShaderRevealStyle', () => {
  it('Pixels and Assemble transform the layer; the three mask styles do not', () => {
    expect(isShaderRevealStyle('pixels')).toBe(true)
    expect(isShaderRevealStyle('assemble')).toBe(true)
    expect(isShaderRevealStyle('dissolve')).toBe(false)
    expect(isShaderRevealStyle('wipe')).toBe(false)
    expect(isShaderRevealStyle('dots')).toBe(false)
  })
})
