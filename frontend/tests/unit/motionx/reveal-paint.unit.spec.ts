/**
 * DITHER PAINT — the canvas half of a reveal transition.
 *
 * `beginReveal` / `finishReveal` do their work entirely through canvas-context calls, so the
 * only way to pin them down is to record every call and property set against a fake 2D
 * context — the recorder idiom `text-draw.unit.spec.ts` uses for the letter-behaviour draw
 * seam, extended to track WHICH context (the main `ctx`, the `snap` backdrop copy, or the
 * small mask/tile canvas) each call landed on, and to preserve real object identity so
 * "the same mask canvas passed to both draws" can be checked with `toBe`, not string equality.
 *
 * This unit environment (`environment: 'node'`) has neither `ImageData` nor `DOMMatrix`;
 * `paint.ts` is written against the real DOM types, so this file supplies minimal stand-ins
 * on `globalThis` for the duration of the suite only — never as an environment guard inside
 * `paint.ts` itself.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  beginReveal, finishReveal, setRevealCanvasFactory, type RevealPass,
} from '~/lib/motionx/reveal/paint'
import { cellRange, buildHiddenMask, dotRadius, DOT_PITCH_CELLS } from '~/lib/motionx/reveal'
import type { MotionReveal } from '~/lib/motionx/reveal'

// ── minimal DOM stand-ins (this file only; paint.ts never guards on their absence) ──────────

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
  inverse(): FakeMatrix {
    const { a, b, c, d, e, f } = this
    const det = a * d - b * c
    return new FakeMatrix({ a: d / det, b: -b / det, c: -c / det, d: a / det, e: (c * f - d * e) / det, f: (b * e - a * f) / det })
  }
}

class FakeImageData {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(data: Uint8ClampedArray, width: number, height: number) { this.data = data; this.width = width; this.height = height }
}

let savedDOMMatrix: unknown, savedImageData: unknown
beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  savedDOMMatrix = g.DOMMatrix
  savedImageData = g.ImageData
  g.DOMMatrix = FakeMatrix
  g.ImageData = FakeImageData
})
afterAll(() => {
  const g = globalThis as Record<string, unknown>
  g.DOMMatrix = savedDOMMatrix
  g.ImageData = savedImageData
})

// ── recording fakes ──────────────────────────────────────────────────────────────────────

interface Call { target: string; name: string; args: unknown[]; result?: unknown }

function describeArg(v: unknown): string {
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    if (typeof rec.__scratchId === 'string') return `canvas(${rec.__scratchId})`
    if (rec instanceof FakeMatrix) return `matrix(${rec.a},${rec.b},${rec.c},${rec.d},${rec.e},${rec.f})`
    if (rec instanceof FakeImageData) return `imagedata(${rec.width}x${rec.height})`
    if (typeof rec.__pattern === 'string') return `pattern(${rec.__pattern})`
  }
  return String(v)
}

/** A recording 2D-context fake. Property reads come back off `state` (so a later read sees
 *  what an earlier set wrote); everything else is logged as a call into the shared `calls`
 *  array, tagged with `target` so a test can pull out just the ops on `ctx`, `snap` or the
 *  mask/tile canvas. */
function makeCtx(target: string, canvasRef: unknown, calls: Call[]): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {}
  const stack: Array<Record<string, unknown>> = []
  let patternSeq = 0
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
      if (key === 'createPattern') return (img: unknown, rep: unknown) => {
        const pattern = {
          __pattern: `${target}#${patternSeq++}`,
          setTransform: (m: unknown) => { calls.push({ target, name: 'pattern.setTransform', args: [m] }) },
        }
        calls.push({ target, name: 'createPattern', args: [img, rep], result: pattern })
        return pattern
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

/** `devSize` is both the frame (W,H passed to begin/finishReveal) and the device canvas size
 *  in most tests below, so the painter's transform is the identity and cell maths stay exact
 *  round numbers — the tests are about the CALL SEQUENCE, not about verifying `cellRange`
 *  again (that is `reveal-dither.unit.spec.ts`'s job). */
function harness(hasCtx = true, devSize = 100) {
  const calls: Call[] = []
  const factoryCanvases: FakeCanvas[] = []
  setRevealCanvasFactory(() => {
    const id = `s${scratchSeq++}`
    const c = makeScratchCanvas(calls, id, hasCtx)
    factoryCanvases.push(c)
    return c as unknown as HTMLCanvasElement
  })
  const dev: FakeCanvas = { width: devSize, height: devSize, __scratchId: 'dev', getContext: () => null }
  const ctx = makeCtx('ctx', dev, calls)
  return { calls, ctx, dev, factoryCanvases }
}

const seqOf = (calls: Call[], target: string) =>
  calls.filter(c => c.target === target).map(c => `${c.name}(${c.args.map(describeArg).join(',')})`)
const callsOf = (calls: Call[], target: string, name: string) =>
  calls.filter(c => c.target === target && c.name === name)

// ── fixtures ─────────────────────────────────────────────────────────────────────────────

const W = 100, H = 100
const dissolve = (over: Partial<MotionReveal> = {}): MotionReveal =>
  ({ style: 'dissolve', out: false, cell: 0.1, drift: 0, angle: 0, softness: 0.35, amount: 0.5, elapsed: 0, ...over })
const dots = (over: Partial<MotionReveal> = {}): MotionReveal =>
  ({ style: 'dots', out: false, cell: 0.1, drift: 0, angle: 0, softness: 0.35, amount: 0.5, elapsed: 0, ...over })

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
// The frame/device geometry every dissolve/wipe test below shares: identity base, canvas
// pixels == frame pixels, so the visible bounds are exactly the frame's own grid.
const geom = (reveal: MotionReveal) => {
  const range = cellRange(IDENTITY, W, H, W, H, reveal.cell)
  const cellPx = reveal.cell * W
  return { range, cellPx, x: range.c0 * cellPx, y: range.r0 * cellPx, w: range.cols * cellPx, h: range.rows * cellPx }
}

// ── 1. begin ─────────────────────────────────────────────────────────────────────────────

describe('beginReveal', () => {
  it('copies ctx.canvas into a scratch canvas with composite \'copy\' at the identity transform, and returns the ctx transform at that moment', () => {
    const { calls, ctx, dev, factoryCanvases } = harness()
    ctx.setTransform(2, 0, 0, 1, 0, 5)   // a distinctive non-identity base
    calls.length = 0                     // isolate begin's own calls
    const pass = beginReveal(ctx, dissolve(), W, H)
    expect(pass).not.toBeNull()
    const snap = factoryCanvases[0]!
    expect(pass!.snap).toBe(snap)
    expect(snap.width).toBe(dev.width)
    expect(snap.height).toBe(dev.height)
    expect(seqOf(calls, snap.__scratchId)).toEqual([
      'setTransform(1,0,0,1,0,0)',
      'set:globalCompositeOperation(copy)',
      'drawImage(canvas(dev),0,0)',
    ])
    // The transform is remembered as-is: a later read of the SAME live context returns
    // the identical object the pass captured.
    expect(pass!.base).toBe(ctx.getTransform())
    expect(pass!.base).toEqual({ a: 2, b: 0, c: 0, d: 1, e: 0, f: 5 })
  })

  it('returns null when the factory canvas has no 2D context (draw the layer unmasked)', () => {
    const { ctx, factoryCanvases } = harness(false)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    expect(beginReveal(ctx, dissolve(), W, H)).toBeNull()
    expect(factoryCanvases).toHaveLength(1)
  })

  it('uses a given 5th `base` argument instead of reading ctx.getTransform() (the Pixels fallback, whose frame transform predates a draw-time scale already on ctx)', () => {
    const { ctx } = harness()
    ctx.setTransform(2, 0, 0, 1, 0, 5)   // whatever ctx's CURRENT transform happens to be…
    const given = new FakeMatrix({ a: 9, b: 0, c: 0, d: 9, e: 100, f: 200 })
    const pass = beginReveal(ctx, dissolve(), W, H, given as unknown as DOMMatrix)
    expect(pass!.base).toBe(given)   // …is ignored in favour of the one passed in
  })
})

// ── 2+3+5. finish — dissolve/wipe: op order, mask content, balanced ctx state ───────────────

describe('finishReveal — dissolve', () => {
  function run(revealOver: Partial<MotionReveal> = {}) {
    const { calls, ctx, factoryCanvases } = harness()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const reveal = dissolve(revealOver)
    const pass = beginReveal(ctx, reveal, W, H)!
    calls.length = 0   // isolate finish's own calls
    finishReveal(ctx, pass)
    const maskCanvas = factoryCanvases[1]!   // acquired inside finishReveal, after the snap
    return { calls, pass, maskCanvas, reveal }
  }

  it('the recorded op order on snap and on ctx matches the recipe, with imageSmoothingEnabled off for both mask draws', () => {
    const { calls, pass, maskCanvas } = run()
    const g = geom(dissolve())
    expect(seqOf(calls, pass.snap.__scratchId as unknown as string)).toEqual([
      'setTransform(matrix(1,0,0,1,0,0))',
      'set:globalCompositeOperation(destination-in)',
      'set:imageSmoothingEnabled(false)',
      `drawImage(canvas(${maskCanvas.__scratchId}),${g.x},${g.y},${g.w},${g.h})`,
    ])
    expect(seqOf(calls, 'ctx')).toEqual([
      'save()',
      'set:filter(none)',
      'set:shadowColor(transparent)',
      'set:globalAlpha(1)',
      'setTransform(matrix(1,0,0,1,0,0))',
      'set:globalCompositeOperation(destination-out)',
      'set:imageSmoothingEnabled(false)',
      `drawImage(canvas(${maskCanvas.__scratchId}),${g.x},${g.y},${g.w},${g.h})`,
      'setTransform(1,0,0,1,0,0)',
      'set:globalCompositeOperation(lighter)',
      `drawImage(canvas(${pass.snap.__scratchId as unknown as string}),0,0)`,
      'restore()',
    ])
  })

  it('the SAME mask canvas object is drawn on both snap (destination-in) and ctx (destination-out)', () => {
    const { calls, pass } = run()
    const onSnap = callsOf(calls, pass.snap.__scratchId as unknown as string, 'drawImage')
    const onCtx = callsOf(calls, 'ctx', 'drawImage').filter(c => c.args.length === 5)   // (image, x, y, w, h)
    expect(onSnap).toHaveLength(1)
    expect(onCtx).toHaveLength(1)
    expect(onCtx[0]!.args[0]).toBe(onSnap[0]!.args[0])
  })

  it('the mask canvas got putImageData with exactly buildHiddenMask(reveal, range, grid) bytes, sized range.cols x range.rows', () => {
    const { calls, maskCanvas, reveal } = run()
    const g = geom(reveal)
    const grid = cellRange(IDENTITY, W, H, W, H, reveal.cell)
    const expectedMask = buildHiddenMask(reveal, g.range, grid)
    const put = callsOf(calls, maskCanvas.__scratchId, 'putImageData')
    expect(put).toHaveLength(1)
    const imageData = put[0]!.args[0] as FakeImageData
    expect(imageData.width).toBe(g.range.cols)
    expect(imageData.height).toBe(g.range.rows)
    expect(Array.from(imageData.data)).toEqual(Array.from(expectedMask))
    expect(put[0]!.args.slice(1)).toEqual([0, 0])
  })

  it('ctx state is restored: save/restore are balanced, exactly one pair', () => {
    const { calls } = run()
    expect(callsOf(calls, 'ctx', 'save')).toHaveLength(1)
    expect(callsOf(calls, 'ctx', 'restore')).toHaveLength(1)
  })
})

// ── 4. finish — dots ─────────────────────────────────────────────────────────────────────

describe('finishReveal — dots', () => {
  it('a pattern is created from a 64x64 tile, its setTransform scale is pitchPx/64, and both hidden-side paints are fillRect with that pattern as fillStyle', () => {
    const { calls, ctx, factoryCanvases } = harness()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const reveal = dots()
    const pass = beginReveal(ctx, reveal, W, H)!
    calls.length = 0
    finishReveal(ctx, pass)

    const tile = factoryCanvases[1]!
    expect(tile.width).toBe(64)
    expect(tile.height).toBe(64)

    const g = geom(reveal)
    const pitchPx = g.cellPx * DOT_PITCH_CELLS
    for (const target of [pass.snap.__scratchId as unknown as string, 'ctx']) {
      const created = callsOf(calls, target, 'createPattern')
      expect(created).toHaveLength(1)
      expect(created[0]!.args[0]).toBe(tile)
      expect(created[0]!.args[1]).toBe('repeat')
      const pattern = created[0]!.result as { __pattern: string }

      const transformed = callsOf(calls, target, 'pattern.setTransform')
      expect(transformed).toHaveLength(1)
      const m = transformed[0]!.args[0] as FakeMatrix
      expect(m.a).toBeCloseTo(pitchPx / 64, 9)
      expect(m.d).toBeCloseTo(pitchPx / 64, 9)

      const fillStyleSets = calls.filter(c => c.target === target && c.name === 'set:fillStyle')
      expect(fillStyleSets).toHaveLength(1)
      expect(fillStyleSets[0]!.args[0]).toBe(pattern)

      const fillRects = callsOf(calls, target, 'fillRect')
      expect(fillRects).toHaveLength(1)
      expect(fillRects[0]!.args).toEqual([g.x, g.y, g.w, g.h])

      const smoothing = calls.filter(c => c.target === target && c.name === 'set:imageSmoothingEnabled')
      expect(smoothing.some(c => c.args[0] === true)).toBe(true)
    }

    // The tile itself: opaque fill then a destination-out circle of radius dotRadius(amount)*64.
    const arcs = callsOf(calls, tile.__scratchId, 'arc')
    expect(arcs).toHaveLength(1)
    expect(arcs[0]!.args[2]).toBeCloseTo(dotRadius(reveal.amount) * 64, 9)
  })
})

// ── 6. the scratch-canvas pool is a STACK, reused across passes ─────────────────────────────

describe('the scratch-canvas pool', () => {
  it('begin, begin, finish, finish uses two different scratch canvases; a following begin reuses one of them', () => {
    const { ctx, factoryCanvases } = harness()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const reveal = dissolve()
    const pass1 = beginReveal(ctx, reveal, W, H)!
    const pass2 = beginReveal(ctx, reveal, W, H)!
    expect(pass1.snap).not.toBe(pass2.snap)
    finishReveal(ctx, pass1)
    finishReveal(ctx, pass2)
    const countAfterFinishes = factoryCanvases.length
    const pass3 = beginReveal(ctx, reveal, W, H)!
    // No new snap canvas was manufactured for this third begin — it popped one already made.
    expect(factoryCanvases).toHaveLength(countAfterFinishes)
    expect([pass1.snap, pass2.snap]).toContainEqual(pass3.snap)
  })
})

// ── 7. wiring: the three hunks landed in useCompositorLayers.ts, in the right place ─────────

describe('paintLayerStack wiring (source-level guard)', () => {
  const SRC = readFileSync(
    fileURLToPath(new URL('../../../app/composables/useCompositorLayers.ts', import.meta.url)),
    'utf8',
  )

  it('the reveal fold wraps the existing letter-behaviours fold', () => {
    expect(SRC).toContain('applyRevealBehaviours(applyTextBehaviours(')
  })

  it('finishReveal(ctx, revealOpen) is called exactly twice: once per loop turn, once after the loop', () => {
    const count = SRC.split('finishReveal(ctx, revealOpen)').length - 1
    expect(count).toBe(2)
  })

  it('beginReveal( is called before the first motionScale property read inside paintLayerStack', () => {
    const fnStart = SRC.indexOf('export function paintLayerStack')
    expect(fnStart).toBeGreaterThanOrEqual(0)
    const beginIdx = SRC.indexOf('beginReveal(', fnStart)
    const readIdx = SRC.indexOf('.motionScale', fnStart)   // the property READ, not `motionScaleOpen`
    expect(beginIdx).toBeGreaterThan(fnStart)
    expect(readIdx).toBeGreaterThan(fnStart)
    expect(beginIdx).toBeLessThan(readIdx)
  })
})

// ── review follow-up: fail SAFE ──────────────────────────────────────────────────────────
describe('finishReveal — when the mask cannot be drawn', () => {
  it('dots with no pattern: not a pixel of the canvas is touched, and the scratch canvases go back to the pool', () => {
    const { calls, ctx, factoryCanvases } = harness()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const pass = beginReveal(ctx, dots(), W, H)!
    // The main context refuses the pattern (the snapshot's own context would have accepted it):
    // running only the snapshot half would then ADD the whole backdrop over the drawn layer.
    const noPattern = new Proxy(ctx, {
      get: (t, k, r) => (k === 'createPattern' ? () => null : Reflect.get(t, k, r)),
    }) as CanvasRenderingContext2D
    calls.length = 0
    finishReveal(noPattern, pass)

    const onCtx = calls.filter((c) => c.target === 'ctx').map((c) => c.name)
    for (const forbidden of ['drawImage', 'fillRect', 'save', 'set:globalCompositeOperation']) expect(onCtx).not.toContain(forbidden)
    const snapId = pass.snap.__scratchId as unknown as string
    expect(callsOf(calls, snapId, 'fillRect')).toHaveLength(0)
    expect(calls.filter((c) => c.target === snapId && c.name === 'set:globalCompositeOperation')).toHaveLength(0)

    const made = factoryCanvases.length
    const again = beginReveal(ctx, dots(), W, H)!
    finishReveal(ctx, again)
    expect(factoryCanvases.length).toBe(made)       // both scratch canvases were reused, none leaked
  })
  it('a non-finite elapsed draws a still pattern rather than a NaN transform', () => {
    const { calls, ctx } = harness()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const pass = beginReveal(ctx, dots({ elapsed: NaN, drift: 6 }), W, H)!
    calls.length = 0
    finishReveal(ctx, pass)
    const m = callsOf(calls, 'ctx', 'pattern.setTransform')[0]!.args[0] as FakeMatrix
    expect(Number.isFinite(m.e)).toBe(true); expect(Number.isFinite(m.f)).toBe(true)
  })
})
