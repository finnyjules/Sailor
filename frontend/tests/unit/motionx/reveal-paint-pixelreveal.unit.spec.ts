/**
 * DRAW-REVEAL-PIXELREVEAL — the canvas half of Pixel reveal. The layer is drawn alone onto a
 * frame-sized side canvas (the shared `soloPass`), its pieces are copied into grid-aligned slots
 * of a power-of-two atlas, a WebGL2 program draws them, and the result is stamped with the
 * layer's own opacity and blend.
 *
 * WebGL never runs here: `setPixelRevealDeps` swaps availability, the texture cap and the GL
 * draw; `setRevealPixelsDeps({ makeCanvas })` swaps the scratch canvases for recording fakes
 * (the `Proxy` idiom of `reveal-paint-settle.unit.spec.ts`).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import {
  drawRevealPixelReveal, inkBoxOf, packPixelRevealAtlas, pieceToDevice, pixelRevealAvailable, pixelRevealTextPieces,
  planPixelReveal, setPixelRevealDeps, setPixelRevealGlDeps, PIXEL_REVEAL_FS, PIXEL_REVEAL_VS,
} from '~/lib/motionx/reveal/paintPixelReveal'
import type { PixelRevealGlJob, PixelRevealPiece } from '~/lib/motionx/reveal/paintPixelReveal'
import { drawRevealShaderStyle, revealShaderReady, setRevealPixelsDeps } from '~/lib/motionx/reveal/paintPixels'
import { revealParams, pixelRevealParams, pickGrid } from '~/lib/motionx/reveal'
import type { MotionReveal } from '~/lib/motionx/reveal'
import type { TextCell } from '~/lib/motionx/text/units'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRectLayer, createTextLayer, pixelRevealCanSplit } from '~/composables/useCompositorLayers'
import { createEffect } from '~/lib/compositor/effectStack'

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
  setPixelRevealDeps()
})

// ── recording fakes ────────────────────────────────────────────────────────────────────────

interface Call { target: string; name: string; args: unknown[] }

function describeArg(v: unknown): string {
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    if (typeof rec.__scratchId === 'string') return `canvas(${rec.__scratchId})`
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
      return (...args: unknown[]) => { calls.push({ target, name: key, args }) }
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

const GL_OUT = { __scratchId: 'gl', width: 200, height: 100 }

function harness(opts: { available?: boolean; maxTexture?: number; glNull?: boolean } = {}) {
  const calls: Call[] = []
  const factoryCanvases: FakeCanvas[] = []
  const jobs: PixelRevealGlJob[] = []
  let seq = 0
  setRevealPixelsDeps({
    makeCanvas: () => {
      const c = makeScratchCanvas(calls, `s${seq++}`)
      factoryCanvases.push(c)
      return c as unknown as HTMLCanvasElement
    },
  })
  setPixelRevealDeps({
    available: () => opts.available ?? true,
    maxTexture: () => opts.maxTexture ?? 4096,
    renderGl: (job) => {
      jobs.push(job)
      calls.push({ target: 'gl', name: 'render', args: [] })
      return opts.glNull ? null : GL_OUT as unknown as HTMLCanvasElement
    },
  })
  const dev: FakeCanvas = { width: 100, height: 100, __scratchId: 'dev', getContext: () => null }
  const ctx = makeCtx('ctx', dev, calls)
  return { calls, ctx, factoryCanvases, jobs }
}

afterEach(() => setPixelRevealDeps())

const seqOf = (calls: Call[], target: string) =>
  calls.filter(c => c.target === target).map(c => `${c.name}(${c.args.map(describeArg).join(',')})`)
const propAt = (calls: Call[], target: string, prop: string, index: number) => {
  let v: unknown
  for (let i = 0; i < index; i++) {
    const c = calls[i]!
    if (c.target === target && c.name === `set:${prop}`) v = c.args[0]
  }
  return v
}
const indexOfCall = (calls: Call[], target: string, name: string) =>
  calls.findIndex(c => c.target === target && c.name === name)

// ── fixtures ───────────────────────────────────────────────────────────────────────────────

const W = 100, H = 50
const FW = 200, FH = 100
const pr = (over: Partial<MotionReveal> = {}, params: Record<string, unknown> = {}): MotionReveal => ({
  ...revealParams({}),
  style: 'pixelreveal',
  amount: 0.5,
  elapsed: 0.25,
  pixel: pixelRevealParams({ look: 'materialize', ...params }),
  ...over,
})
// scale 2, translate (10, 20): fw 200, fh 100 — the frame the other shader-style specs use.
const base = () => new FakeMatrix({ a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 }) as unknown as DOMMatrix
const stamp = { alpha: 0.7, blend: 'multiply' as GlobalCompositeOperation }
const setCurrentTransform = (ctx: CanvasRenderingContext2D) => ctx.setTransform(2, 0, 0, 2, 10, 20)

const PIECES: PixelRevealPiece[] = [
  { box: { x: 10, y: 10, w: 20, h: 15 }, line: { top: 10, bottom: 25 }, lineIdx: 0, lineX: { l: 10, w: 40 } },
  { box: { x: 30, y: 10, w: 20, h: 15 }, line: { top: 10, bottom: 25 }, lineIdx: 0, lineX: { l: 10, w: 40 } },
]

// ── availability ───────────────────────────────────────────────────────────────────────────

describe('drawRevealPixelReveal — without WebGL2', () => {
  it('the real availability check answers false where there is no document (no WebGL2)', () => {
    setPixelRevealDeps()
    expect(pixelRevealAvailable()).toBe(false)
  })

  it('returns false and touches nothing — not ctx, not a single scratch canvas', () => {
    const { calls, ctx, factoryCanvases } = harness({ available: false })
    setCurrentTransform(ctx)
    calls.length = 0
    expect(drawRevealPixelReveal(ctx, pr(), W, H, base(), () => { throw new Error('must not draw') }, stamp, PIECES)).toBe(false)
    expect(calls).toHaveLength(0)
    expect(factoryCanvases).toHaveLength(0)
  })

  it('a rotated frame returns false untouched (the shared solo-pass gate)', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    calls.length = 0
    const rotated = new FakeMatrix({ a: 2, b: 0.5, c: 0, d: 2, e: 10, f: 20 }) as unknown as DOMMatrix
    expect(drawRevealPixelReveal(ctx, pr(), W, H, rotated, () => { throw new Error('must not draw') }, stamp)).toBe(false)
    expect(calls).toHaveLength(0)
    expect(factoryCanvases).toHaveLength(0)
  })

  it('a GL draw that yields nothing (lost context) returns false with ctx untouched, and every canvas goes back', () => {
    const { calls, ctx, factoryCanvases } = harness({ glNull: true })
    setCurrentTransform(ctx)
    calls.length = 0
    expect(drawRevealPixelReveal(ctx, pr(), W, H, base(), () => {}, stamp, PIECES)).toBe(false)
    expect(calls.filter(c => c.target === 'ctx' && c.name !== 'getTransform')).toHaveLength(0)
    const made = factoryCanvases.length
    // A second call reuses every pooled canvas instead of making new ones.
    expect(drawRevealPixelReveal(ctx, pr(), W, H, base(), () => {}, stamp, PIECES)).toBe(false)
    expect(factoryCanvases).toHaveLength(made)
  })
})

// ── the atlas packer ───────────────────────────────────────────────────────────────────────

describe('packPixelRevealAtlas', () => {
  const G = 12
  const sizes = [
    { w: 48, h: 36 }, { w: 120, h: 72 }, { w: 12, h: 12 }, { w: 240, h: 36 }, { w: 36, h: 96 },
    { w: 600, h: 24 }, { w: 72, h: 72 }, { w: 24, h: 48 },
  ]
  const packed = packPixelRevealAtlas(sizes, G, 4096)!

  it('power-of-two sides, at least 64', () => {
    const pow2 = (n: number) => n >= 64 && (n & (n - 1)) === 0
    expect(pow2(packed.width)).toBe(true)
    expect(pow2(packed.height)).toBe(true)
  })

  it('every slot is grid-aligned and inside the atlas', () => {
    sizes.forEach((s, i) => {
      const a = packed.at[i]!
      expect(a.x % G).toBe(0)
      expect(a.y % G).toBe(0)
      expect(a.x + s.w).toBeLessThanOrEqual(packed.width)
      expect(a.y + s.h).toBeLessThanOrEqual(packed.height)
    })
  })

  it('no two slots overlap', () => {
    for (let i = 0; i < sizes.length; i++) {
      for (let j = i + 1; j < sizes.length; j++) {
        const a = { ...packed.at[i]!, ...sizes[i]! }, b = { ...packed.at[j]!, ...sizes[j]! }
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlap, `slots ${i} and ${j}`).toBe(false)
      }
    }
  })

  it('null when the cells cannot fit under the texture cap', () => {
    expect(packPixelRevealAtlas([{ w: 1200, h: 12 }], 12, 1024)).toBeNull()
    expect(packPixelRevealAtlas([], 12, 4096)).toBeNull()
  })
})

// ── pieces: frame px → device px ───────────────────────────────────────────────────────────

describe('pieceToDevice / planPixelReveal', () => {
  it('a scale + translate base maps a frame-px piece by its scale alone (the solo canvas starts at the frame origin)', () => {
    const d = pieceToDevice(PIECES[0]!, { a: 2, d: 3 })
    expect(d.rect).toEqual({ x: 20, y: 30, w: 40, h: 45 })
    expect(d.line).toEqual({ top: 30, bottom: 75 })
    expect(d.lineX).toEqual({ l: 20, w: 80 })
    expect(d.lineH).toBe(45)
    expect(d.lineIdx).toBe(0)
  })

  it('cells are grid-aligned and cover each piece; copy rects are integer, clipped, and tile', () => {
    const pieces = PIECES.map(p => pieceToDevice(p, { a: 2, d: 2 }))
    const plan = planPixelReveal({ pieces, fw: FW, fh: FH, pixel: 24, levels: 3, maxTexture: 4096 })!
    // pixel 24 at 1080 wide → 24 × 200/1080 ≈ 4.4 device px → the 4 px rung.
    expect(plan.grid).toEqual(pickGrid(24 * FW / 1080, 3))
    const G = plan.grid.s
    for (const s of plan.slots) {
      expect(s.cell.x % G).toBe(0)
      expect(s.cell.y % G).toBe(0)
      expect(s.cell.w % G).toBe(0)
      expect(s.cell.h % G).toBe(0)
      expect(s.cell.x).toBeLessThanOrEqual(s.copy.x)
      expect(s.cell.x + s.cell.w).toBeGreaterThanOrEqual(s.copy.x + s.copy.w)
      expect(s.at.x % G).toBe(0)
      expect(s.at.y % G).toBe(0)
    }
    expect(plan.slots[0]!.copy).toEqual({ x: 20, y: 20, w: 40, h: 30 })
    expect(plan.slots[1]!.copy).toEqual({ x: 60, y: 20, w: 40, h: 30 })
    expect(plan.whole).toEqual({ x: 20, y: 20, w: 80, h: 30 })
    expect(plan.lines).toBe(1)
  })

  it('an atlas too big for the cap falls back to ONE piece (their union); too big even then → null', () => {
    const many = Array.from({ length: 40 }, (_, i) => pieceToDevice({
      box: { x: i * 5, y: 0, w: 5, h: 100 }, line: { top: 0, bottom: 100 }, lineIdx: 0, lineX: { l: 0, w: 200 },
    }, { a: 1, d: 1 }))
    const plan = planPixelReveal({ pieces: many, fw: 200, fh: 100, pixel: 64, levels: 3, maxTexture: 256 })!
    expect(plan.slots).toHaveLength(1)
    expect(plan.slots[0]!.rect).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    expect(planPixelReveal({ pieces: many, fw: 200, fh: 100, pixel: 64, levels: 3, maxTexture: 128 })).toBeNull()
  })
})

// ── text pieces ────────────────────────────────────────────────────────────────────────────

describe('pixelRevealTextPieces', () => {
  // Two lines, font px 20, line height 1.2 (pitch 24): "ab cd" / "ef".
  const cell = (char: string, x: number, w: number, y: number, word: number, line: number): TextCell =>
    ({ char, x, y, w, h: 20, angle: 0, word, line })
  const cells: TextCell[] = [
    cell('a', -25, 10, -12, 0, 0), cell('b', -15, 10, -12, 0, 0),
    cell('c', 5, 10, -12, 1, 0), cell('d', 15, 10, -12, 1, 0),
    cell('e', -5, 10, 12, 2, 1), cell('f', 5, 10, 12, 2, 1),
  ]
  const place = { x: 500, y: 300, scale: 2 }

  it('words: advance boxes meet halfway across the gap; line ends reach out half a band', () => {
    const p = pixelRevealTextPieces(cells, 'words', 1.2, place)
    expect(p).toHaveLength(3)
    // "ab" spans -30..-10, "cd" spans 0..20: they meet at -5. Band = 24, reach 12.
    expect(p[0]!.box.x).toBeCloseTo(500 + (-30 - 12) * 2)
    expect(p[0]!.box.x + p[0]!.box.w).toBeCloseTo(500 + -5 * 2)
    expect(p[1]!.box.x).toBeCloseTo(500 + -5 * 2)
    expect(p[1]!.box.x + p[1]!.box.w).toBeCloseTo(500 + (20 + 12) * 2)
    // Lines meet halfway between their centres (0); the outer edges reach out a full band.
    expect(p[0]!.box.y + p[0]!.box.h).toBeCloseTo(300)
    expect(p[2]!.box.y).toBeCloseTo(300)
    expect(p[0]!.box.y).toBeCloseTo(300 + (-12 - 24) * 2)
    // The clip band is the piece's own vertical tile; the rise distance is the line's pitch.
    expect(p[0]!.line).toEqual({ top: p[0]!.box.y, bottom: p[0]!.box.y + p[0]!.box.h })
    expect(p[0]!.lineH).toBeCloseTo(24 * 2)
    expect(p[2]!.lineIdx).toBe(1)
    expect(p[0]!.lineX).toEqual({ l: 500 - 60, w: 100 })
  })

  it('letters tile each line with no gaps or overlaps', () => {
    const p = pixelRevealTextPieces(cells, 'letters', 1.2, place)
    expect(p).toHaveLength(6)
    const line0 = p.filter(q => q.lineIdx === 0).sort((a, b) => a.box.x - b.box.x)
    for (let i = 1; i < line0.length; i++) {
      expect(line0[i]!.box.x).toBeCloseTo(line0[i - 1]!.box.x + line0[i - 1]!.box.w)
    }
  })

  it('a piece taller than its line pitch keeps its full vertical extent in the clip band the painter passes', () => {
    // One line, font px 20 at line height 0.8: the pitch (16) is shorter than the glyph box.
    const one = [cell('A', 0, 12, 0, 0, 0)]
    const [piece] = pixelRevealTextPieces(one, 'letters', 0.8, { x: 0, y: 0, scale: 1 })
    expect(piece!.box.h).toBeGreaterThan(16)
    const dev = pieceToDevice(piece!, { a: 2, d: 2 })
    expect(dev.line.top).toBeLessThanOrEqual(dev.rect.y)
    expect(dev.line.bottom).toBeGreaterThanOrEqual(dev.rect.y + dev.rect.h)
    // Even a piece handed a band tighter than its box is widened to the box.
    const tight = pieceToDevice({ box: { x: 0, y: -20, w: 10, h: 40 }, line: { top: -8, bottom: 8 }, lineIdx: 0, lineX: { l: 0, w: 10 } }, { a: 1, d: 1 })
    expect(tight.line).toEqual({ top: -20, bottom: 20 })
    expect(tight.lineH).toBe(16)
    // And through the plan: the band a slot carries (the shader's uLine) spans its copy rect.
    const plan = planPixelReveal({ pieces: [dev], fw: 400, fh: 400, pixel: 24, levels: 3, maxTexture: 4096 })!
    const slot = plan.slots[0]!
    expect(slot.line.top).toBeLessThanOrEqual(dev.rect.y)
    expect(slot.line.bottom).toBeGreaterThanOrEqual(dev.rect.y + dev.rect.h)
  })

  it('lines: one piece per line', () => {
    const p = pixelRevealTextPieces(cells, 'lines', 1.2, place)
    expect(p.map(q => q.lineIdx)).toEqual([0, 1])
  })
})

// ── the atlas copy, the GL job and the stamp ───────────────────────────────────────────────

describe('drawRevealPixelReveal — atlas, job, stamp', () => {
  it('copies each piece from the solo canvas into its atlas slot, then hands the job to GL', () => {
    const { calls, ctx, factoryCanvases, jobs } = harness()
    setCurrentTransform(ctx)
    const r = pr({ amount: 0.4, elapsed: 1.5 })
    expect(drawRevealPixelReveal(ctx, r, W, H, base(), () => {}, stamp, PIECES)).toBe(true)
    const solo = factoryCanvases[0]!
    const atlas = factoryCanvases[1]!
    expect(jobs).toHaveLength(1)
    const job = jobs[0]!
    expect(job.fw).toBe(FW)
    expect(job.fh).toBe(FH)
    expect(job.time).toBe(1.5)
    expect(job.atlas).toBe(atlas)
    expect(atlas.width).toBe(job.plan.atlasW)
    expect(atlas.height).toBe(job.plan.atlasH)
    expect(job.states).toHaveLength(2)
    const draws = seqOf(calls, atlas.__scratchId).filter(c => c.startsWith('drawImage'))
    expect(draws).toEqual(job.plan.slots.map(s =>
      `drawImage(canvas(${solo.__scratchId}),${s.copy.x},${s.copy.y},${s.copy.w},${s.copy.h},${s.at.x + s.copy.x - s.cell.x},${s.at.y + s.copy.y - s.cell.y},${s.copy.w},${s.copy.h})`))
    // Never `copy` onto the atlas — that would wipe the earlier slots.
    const firstDraw = indexOfCall(calls, atlas.__scratchId, 'drawImage')
    expect(propAt(calls, atlas.__scratchId, 'globalCompositeOperation', firstDraw)).toBe('source-over')
  })

  it('stamps the GL result with the layer alpha and blend, identity transform, at base.e/base.f', () => {
    const { calls, ctx, factoryCanvases } = harness()
    setCurrentTransform(ctx)
    calls.length = 0
    expect(drawRevealPixelReveal(ctx, pr(), W, H, base(), () => {}, stamp, PIECES)).toBe(true)
    const out = factoryCanvases[2]!
    expect(seqOf(calls, out.__scratchId).filter(c => c.startsWith('drawImage'))).toEqual(['drawImage(canvas(gl),0,0)'])
    const ctxCalls = seqOf(calls, 'ctx')
    expect(ctxCalls).toEqual([
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

  it('no pieces → ONE piece, the whole layer', () => {
    const { ctx, jobs } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealPixelReveal(ctx, pr(), W, H, base(), () => {}, stamp)).toBe(true)
    expect(jobs[0]!.plan.slots).toHaveLength(1)
    expect(jobs[0]!.states).toHaveLength(1)
  })
})

describe('inkBoxOf', () => {
  it('bounds the pixels with alpha over 8, padded by 2', () => {
    const w = 10, h = 10
    const data = new Uint8ClampedArray(w * h * 4)
    data[(4 * w + 2) * 4 + 3] = 255
    data[(6 * w + 6) * 4 + 3] = 255
    expect(inkBoxOf(data, w, h)).toEqual({ x: 0, y: 2, w: 8, h: 6 })
    expect(inkBoxOf(new Uint8ClampedArray(w * h * 4), w, h)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(inkBoxOf(undefined, w, h)).toEqual({ x: 0, y: 0, w, h })
  })
})

// ── the router ─────────────────────────────────────────────────────────────────────────────

describe('drawRevealShaderStyle / revealShaderReady — a pixel-reveal bar', () => {
  it('routes style pixelreveal to the Pixel reveal painter, pieces and all', () => {
    const { ctx, jobs } = harness()
    setCurrentTransform(ctx)
    expect(drawRevealShaderStyle(ctx, pr(), W, H, base(), () => {}, stamp, PIECES)).toBe(true)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.plan.slots).toHaveLength(2)
  })

  it('ready = WebGL2 available', () => {
    harness({ available: true })
    expect(revealShaderReady(pr())).toBe(true)
    harness({ available: false })
    expect(revealShaderReady(pr())).toBe(false)
  })
})

describe('the shaders', () => {
  it('are GLSL ES 3.00 and carry the prototype uniforms the draw loop sets', () => {
    expect(PIXEL_REVEAL_VS.startsWith('#version 300 es')).toBe(true)
    expect(PIXEL_REVEAL_FS.startsWith('#version 300 es')).toBe(true)
    for (const u of ['uCell', 'uAtlasAt', 'uProgress', 'uRect', 'uLine', 'uClip', 'uLineIdx', 'uLines', 'uLineX', 'uWhole',
      'uG', 'uM', 'uK', 'uLevels', 'uDir', 'uPat', 'uHot', 'uHot2', 'uTear', 'uTime']) {
      expect(PIXEL_REVEAL_FS).toContain(u)
    }
  })
})

// ── the WebGL2 context's lifecycle ──────────────────────────────────────────────────────────
// A fake WebGL2 context: every GL call is a no-op that hands back an object, except the ones a
// test pins. `buffer` is the drawing buffer the browser hands out (default: the canvas size).

interface FakeGlOpts {
  compileOk?: boolean
  linkOk?: boolean
  lost?: () => boolean
  nullTexture?: boolean
  buffer?: { w: number; h: number }
}

function makeGlCanvas(opts: FakeGlOpts = {}) {
  const canvas = { width: 300, height: 150, __scratchId: 'glc', addEventListener: vi.fn() } as Record<string, unknown>
  const gl = new Proxy({}, {
    get(_t, key: string) {
      if (key === 'canvas') return canvas
      if (key === 'drawingBufferWidth') return opts.buffer?.w ?? canvas.width
      if (key === 'drawingBufferHeight') return opts.buffer?.h ?? canvas.height
      if (key === 'isContextLost') return () => opts.lost?.() ?? false
      if (key === 'getShaderParameter') return () => opts.compileOk ?? true
      if (key === 'getProgramParameter') return () => opts.linkOk ?? true
      if (key === 'getParameter') return () => 4096
      if (key === 'getAttribLocation') return () => 0
      if (key === 'getShaderInfoLog' || key === 'getProgramInfoLog') return () => 'bad'
      if (key === 'createTexture') return () => (opts.nullTexture ? null : {})
      if (/^[A-Z_0-9]+$/.test(key)) return 1
      return () => ({})
    },
  })
  canvas.getContext = vi.fn((type: string) => (type === 'webgl2' ? gl : null))
  return canvas
}

describe('the WebGL2 context', () => {
  let clock = 0
  afterEach(() => { setPixelRevealGlDeps(); vi.restoreAllMocks() })
  const useGl = (make: () => unknown) => {
    clock = 1000
    const createCanvas = vi.fn(make as () => HTMLCanvasElement | null)
    setPixelRevealGlDeps({ createCanvas, now: () => clock })
    setPixelRevealDeps()
    return createCanvas
  }

  it('a context the browser refuses once is asked for again later — and the painter then works', () => {
    const refusing = { ...makeGlCanvas(), getContext: () => null }
    let n = 0
    const createCanvas = useGl(() => (n++ === 0 ? refusing : makeGlCanvas()))
    expect(pixelRevealAvailable()).toBe(false)
    // Not on every frame: the next asks inside the wait make no new canvas.
    clock += 16
    expect(pixelRevealAvailable()).toBe(false)
    expect(createCanvas).toHaveBeenCalledTimes(1)
    clock += 60_000
    expect(pixelRevealAvailable()).toBe(true)
    expect(createCanvas).toHaveBeenCalledTimes(2)
    // …and it is kept: no third canvas.
    expect(pixelRevealAvailable()).toBe(true)
    expect(createCanvas).toHaveBeenCalledTimes(2)
  })

  it('the wait grows with each refusal in a row, so a browser that keeps refusing is rarely asked', () => {
    const createCanvas = useGl(() => ({ ...makeGlCanvas(), getContext: () => null }))
    const attemptsOver = (ms: number) => {
      const before = createCanvas.mock.calls.length
      for (let t = 0; t < ms; t += 16) { clock += 16; pixelRevealAvailable() }
      return createCanvas.mock.calls.length - before
    }
    pixelRevealAvailable()
    const firstMinute = attemptsOver(60_000)
    const secondMinute = attemptsOver(60_000)
    expect(firstMinute).toBeLessThan(10)
    expect(secondMinute).toBeLessThanOrEqual(2)
    expect(secondMinute).toBeGreaterThanOrEqual(1)
  })

  it('a shader that will not compile is latched: no second context, however long it waits', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const createCanvas = useGl(() => makeGlCanvas({ compileOk: false }))
    expect(pixelRevealAvailable()).toBe(false)
    clock += 3_600_000
    expect(pixelRevealAvailable()).toBe(false)
    expect(createCanvas).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('a program that will not link is latched the same way', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const createCanvas = useGl(() => makeGlCanvas({ linkOk: false }))
    expect(pixelRevealAvailable()).toBe(false)
    clock += 3_600_000
    expect(pixelRevealAvailable()).toBe(false)
    expect(createCanvas).toHaveBeenCalledTimes(1)
  })

  it('a compile failure on a LOST context is not latched — it is retried after the wait', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let n = 0
    const createCanvas = useGl(() => (n++ === 0 ? makeGlCanvas({ compileOk: false, lost: () => true }) : makeGlCanvas()))
    expect(pixelRevealAvailable()).toBe(false)
    clock += 16
    expect(pixelRevealAvailable()).toBe(false)
    expect(createCanvas).toHaveBeenCalledTimes(1)
    clock += 60_000
    expect(pixelRevealAvailable()).toBe(true)
    expect(error).not.toHaveBeenCalled()
  })

  it('a GL object that cannot be made does not build a new context on every frame', () => {
    let n = 0
    const createCanvas = useGl(() => (n++ === 0 ? makeGlCanvas({ nullTexture: true }) : makeGlCanvas()))
    expect(pixelRevealAvailable()).toBe(false)
    for (let i = 0; i < 10; i++) { clock += 16; pixelRevealAvailable() }
    expect(createCanvas).toHaveBeenCalledTimes(1)
    clock += 60_000
    expect(pixelRevealAvailable()).toBe(true)
  })

  it('a context lost after it was built is dropped, and rebuilt only on a later frame', () => {
    const first = { lost: false }
    let n = 0
    const createCanvas = useGl(() => (n++ === 0 ? makeGlCanvas({ lost: () => first.lost }) : makeGlCanvas()))
    expect(pixelRevealAvailable()).toBe(true)
    first.lost = true
    expect(pixelRevealAvailable()).toBe(false)
    expect(createCanvas).toHaveBeenCalledTimes(1)
    clock += 60_000
    expect(pixelRevealAvailable()).toBe(true)
    expect(createCanvas).toHaveBeenCalledTimes(2)
  })

  it('a drawing buffer smaller than the frame is not drawn: false, ctx untouched', () => {
    const { calls, ctx } = harness()
    setPixelRevealDeps({ available: () => true, maxTexture: () => 4096 })
    setPixelRevealGlDeps({ createCanvas: () => makeGlCanvas({ buffer: { w: FW / 2, h: FH / 2 } }) as unknown as HTMLCanvasElement })
    setCurrentTransform(ctx)
    calls.length = 0
    expect(drawRevealPixelReveal(ctx, pr(), W, H, base(), () => {}, stamp, PIECES)).toBe(false)
    expect(calls.filter(c => c.target === 'ctx' && c.name !== 'getTransform')).toHaveLength(0)
  })

  it('…and with the full drawing buffer the same frame is drawn and stamped', () => {
    const { calls, ctx } = harness()
    setPixelRevealDeps({ available: () => true, maxTexture: () => 4096 })
    setPixelRevealGlDeps({ createCanvas: () => makeGlCanvas() as unknown as HTMLCanvasElement })
    setCurrentTransform(ctx)
    calls.length = 0
    expect(drawRevealPixelReveal(ctx, pr(), W, H, base(), () => {}, stamp, PIECES)).toBe(true)
    expect(calls.some(c => c.target === 'ctx' && c.name === 'drawImage')).toBe(true)
  })
})

// ── which layers split into pieces ─────────────────────────────────────────────────────────
// Each piece copies only its own tile, so a layer effect reaching past it (a shadow, glow, blur,
// wide stroke) would be cut for the whole bar and pop back in at its end: such text stays whole.

describe('pixelRevealCanSplit', () => {
  const text = (over: Record<string, unknown> = {}) => ({ ...createTextLayer({ text: 'Two words' }), ...over }) as any

  it('plain text splits; a shape never does', () => {
    expect(pixelRevealCanSplit(text())).toBe(true)
    expect(pixelRevealCanSplit(createRectLayer({}) as any)).toBe(false)
  })

  it('text with a visible layer effect stays whole', () => {
    expect(pixelRevealCanSplit(text({ effects: [{ ...createEffect('drop_shadow'), visible: true }] }))).toBe(false)
    // an entry with no `visible` field reads as visible
    const { visible: _v, ...noFlag } = createEffect('drop_shadow') as Record<string, unknown>
    expect(pixelRevealCanSplit(text({ effects: [noFlag] }))).toBe(false)
  })

  it('a hidden effect does not stop the split', () => {
    expect(pixelRevealCanSplit(text({ effects: [{ ...createEffect('drop_shadow'), visible: false }] }))).toBe(true)
  })

  it('rotated text stays whole, as before', () => {
    expect(pixelRevealCanSplit(text({ rotation: 12 }))).toBe(false)
  })

  it('the pieces builder asks it before reading any text cells', () => {
    const SRC = readFileSync(fileURLToPath(new URL('../../../app/composables/useCompositorLayers.ts', import.meta.url)), 'utf8')
    const at = SRC.indexOf('function pixelRevealPiecesFor(')
    expect(at).toBeGreaterThan(-1)
    const body = SRC.slice(at, SRC.indexOf('\n}\n', at))
    const gate = body.indexOf('if (!pixelRevealCanSplit(layer)) return undefined')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(body.indexOf('textMotionCells('))
  })
})

describe('the modal warms the outline font of text a bar splits', () => {
  it('watches motionBehaviours immediately and warms each split text layer\'s token', () => {
    const MODAL = readFileSync(fileURLToPath(new URL('../../../app/components/vue-canvas/CompositorModal.vue', import.meta.url)), 'utf8')
    const at = MODAL.indexOf('pixelRevealSplitLayerIds(list)')
    expect(at).toBeGreaterThan(-1)
    const block = MODAL.slice(Math.max(0, at - 200), at + 400)
    expect(block).toMatch(/watch\(motionBehaviours/)
    expect(block).toMatch(/immediate:\s*true/)
    expect(block).toMatch(/warmCompositorFont\(token\)/)
  })
})
