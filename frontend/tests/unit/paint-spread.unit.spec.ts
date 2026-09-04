/**
 * `PaintSpread` — what a `Fill` does OUTSIDE its own paint box.
 *
 * The bug this spec pins: `resolveFill` handed back
 * `createPattern(tile, 'no-repeat')`, and a `no-repeat` pattern paints NOTHING
 * outside its tile — which is the paint box. Any layer whose ink reaches past
 * that box therefore lost the reaching part: measured live at 68 % of a
 * glyph-anchored extrude's ink and 47 % of a 20 px stroke's, while the SVG export
 * of the same config painted all of it. Solid paints and the `frame` anchor were
 * unaffected, which is why it survived to a user report ("the extrude only looks
 * right when the fill is solid").
 *
 * Three things are asserted here, and the FIRST is the one that makes the change
 * safe rather than merely correct:
 *
 *  1. **The default is byte-identical.** `resolveFill(ctx, fill, box, field)` with
 *     no fifth argument, and with an explicit `'box'`, must issue exactly the same
 *     `createPattern` + `setTransform` calls it always has — for every fill type.
 *     The Compositor and Space Type's frame modal call it with four arguments and
 *     must not move a pixel.
 *  2. **The tile-vs-pad rule is DERIVED from the SVG export**, which is the oracle:
 *     a `<linearGradient>` pads, a `<pattern>` tiles. So `gradient` pads and every
 *     patterned fill tiles — including `ombre`/`noise`/`shader`, whose export is a
 *     `<pattern>` holding one box-sized `<image>` and therefore tiles too.
 *  3. **Vector Type asks for it on exactly the layers with reach** — `extrude`
 *     (offset copies) and `stroke` (a centred pen's outer half), never a plain
 *     `fill`. Asserted through the REAL `drawVectorType`, by reading back which
 *     style each layer painted with.
 *
 * `fillTileBox` is stubbed to a marker object: this suite runs in node, the tile's
 * PIXELS are not what is under test, and the stub makes "which tile, at what size,
 * with what repetition" readable rather than inferred.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/spacetype/fillTile', async (orig) => {
  const m = await orig<typeof import('~/lib/spacetype/fillTile')>()
  return {
    ...m,
    // Marker, not a canvas: node has no `document`. Everything downstream only
    // reads `.width`/`.height` (the pattern matrix) or passes it to
    // `createPattern`, which this suite records.
    fillTileBox: (f: import('~/lib/spacetype/fillTile').Fill, w: number, h: number) =>
      ({ tileOf: f.type, shapeId: (f as { shapeId?: string }).shapeId, width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) }),
  }
})

// Static, not dynamic: `vi.mock` is hoisted above these by vitest, so the tile
// stub is in place before `lib/paint/resolve` binds `fillTileBox`.
import { DEFAULT_FILL, FILL_TYPES, type Fill } from '~/lib/spacetype/fillTile'
import { resolveFill, resolvePaint, fillSpreadKind, type ShaderFieldFrameCtx } from '~/lib/paint/resolve'
import { exportTier } from '~/lib/paint/toVector'
import { drawVectorType } from '~/lib/vectortype/canvas'
import { DEFAULT_CONFIG, mergeConfig, vtLayer, type VectorTypeConfig } from '~/lib/vectortype/config'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'

// ── node stubs ──────────────────────────────────────────────────────────────

type Mat = [number, number, number, number, number, number]

class FakeMatrix {
  constructor(public a = 1, public b = 0, public c = 0, public d = 1, public e = 0, public f = 0) {}
  static from(m: Mat): FakeMatrix { return new FakeMatrix(...m) }
  get mat(): Mat { return [this.a, this.b, this.c, this.d, this.e, this.f] }
  multiply(o: FakeMatrix): FakeMatrix {
    return new FakeMatrix(
      this.a * o.a + this.c * o.b,
      this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d,
      this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e,
      this.b * o.e + this.d * o.f + this.f,
    )
  }
  translate(x: number, y: number): FakeMatrix { return this.multiply(new FakeMatrix(1, 0, 0, 1, x, y)) }
  scale(x: number, y = x): FakeMatrix { return this.multiply(new FakeMatrix(x, 0, 0, y, 0, 0)) }
  // The MUTATING spellings `resolveFill` actually uses for the pattern matrix.
  translateSelf(x: number, y: number): FakeMatrix {
    const m = this.translate(x, y)
    Object.assign(this, { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f })
    return this
  }
  scaleSelf(x: number, y = x): FakeMatrix {
    const m = this.scale(x, y)
    Object.assign(this, { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f })
    return this
  }
  inverse(): FakeMatrix {
    const det = this.a * this.d - this.b * this.c
    if (!det) return new FakeMatrix(NaN, NaN, NaN, NaN, NaN, NaN)
    return new FakeMatrix(
      this.d / det, -this.b / det, -this.c / det, this.a / det,
      (this.c * this.f - this.d * this.e) / det,
      (this.b * this.e - this.a * this.f) / det,
    )
  }
}

class FakeGradient {
  stops: Array<{ offset: number; color: string }> = []
  constructor(public coords: number[]) {}
  addColorStop(offset: number, color: string) { this.stops.push({ offset, color }) }
}

class FakePath2D { addPath() {} moveTo() {} lineTo() {} quadraticCurveTo() {} bezierCurveTo() {} closePath() {} }

interface PatternCall { image: unknown; repetition: string | null | undefined; matrix: Mat | null }

/** A recorder with a real CTM. `createPattern` returns a live object so the
 *  pattern MATRIX is recorded too — the half of the change that must NOT move. */
class RecCtx {
  patterns: PatternCall[] = []
  gradients: FakeGradient[] = []
  paints: Array<{ op: 'fill' | 'stroke'; style: unknown }> = []
  saves = 0
  restores = 0
  private stack: Array<{ alpha: number; gco: string; filter: string; m: Mat }> = []
  private m: Mat = [1, 0, 0, 1, 0, 0]
  globalAlpha = 1
  globalCompositeOperation = 'source-over'
  filter = 'none'
  fillStyle: unknown = ''
  strokeStyle: unknown = ''
  lineWidth = 0
  lineJoin = ''

  getTransform(): FakeMatrix { return FakeMatrix.from(this.m) }
  setTransform(...a: unknown[]) {
    if (a.length === 1 && a[0] instanceof FakeMatrix) this.m = (a[0] as FakeMatrix).mat
    else this.m = (a as number[]).slice(0, 6) as Mat
  }
  save() { this.saves++; this.stack.push({ alpha: this.globalAlpha, gco: this.globalCompositeOperation, filter: this.filter, m: [...this.m] as Mat }) }
  restore() {
    this.restores++
    const s = this.stack.pop()
    if (s) { this.globalAlpha = s.alpha; this.globalCompositeOperation = s.gco; this.filter = s.filter; this.m = s.m }
  }
  translate(x: number, y: number) { this.m = FakeMatrix.from(this.m).translate(x, y).mat }
  rotate(r: number) { this.m = FakeMatrix.from(this.m).multiply(new FakeMatrix(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0)).mat }
  scale(x: number, y: number) { this.m = FakeMatrix.from(this.m).multiply(new FakeMatrix(x, 0, 0, y, 0, 0)).mat }
  clearRect() {} fillRect() {} beginPath() {} rect() {} clip() {}
  createLinearGradient(...coords: number[]) { const g = new FakeGradient(coords); this.gradients.push(g); return g }
  createRadialGradient(...coords: number[]) { return this.createLinearGradient(...coords) }
  createPattern(image: unknown, repetition?: string | null) {
    const call: PatternCall = { image, repetition, matrix: null }
    this.patterns.push(call)
    return { setTransform: (m: FakeMatrix) => { call.matrix = m.mat } }
  }
  fill() { this.paints.push({ op: 'fill', style: this.fillStyle }) }
  stroke() { this.paints.push({ op: 'stroke', style: this.strokeStyle }) }
}

let hadPath2D: unknown, hadDOMMatrix: unknown
beforeAll(() => {
  hadPath2D = (globalThis as any).Path2D
  hadDOMMatrix = (globalThis as any).DOMMatrix
  ;(globalThis as any).Path2D = FakePath2D
  ;(globalThis as any).DOMMatrix = FakeMatrix
})
afterAll(() => {
  ;(globalThis as any).Path2D = hadPath2D
  ;(globalThis as any).DOMMatrix = hadDOMMatrix
})

const FIELD: ShaderFieldFrameCtx = { frameW: 400, frameH: 200, t: 0, fps: 30, base: null, bake: false, token: 0 }
const BOX = { w: 120, h: 60 }
const fill = (type: Fill['type'], p: Partial<Fill> = {}): Fill =>
  ({ ...DEFAULT_FILL, type, a: '#ff0055', b: '#00c8ff', angle: 30, density: 8, ...p })

/** Every fill type that reaches the tile/pattern path — i.e. not `solid`, and not
 *  `shader` (which has no spec here, so it falls through to the tile path as a
 *  plain patterned fill; the shader ARM is exercised separately). */
const PATTERNED = FILL_TYPES.filter(t => t !== 'solid' && t !== 'shader')

// ── 1. the default is byte-identical ────────────────────────────────────────

describe('PaintSpread — the default is exactly today’s behaviour', () => {
  it('every fill type still resolves to ONE no-repeat tile, with the same matrix', () => {
    for (const type of PATTERNED) {
      const ctx = new RecCtx()
      resolveFill(ctx as unknown as CanvasRenderingContext2D, fill(type), BOX, FIELD)
      expect(ctx.patterns).toHaveLength(1)
      const p = ctx.patterns[0]!
      expect(p.repetition, type).toBe('no-repeat')
      expect(p.image, type).toMatchObject({ tileOf: type, width: 120, height: 60 })
      // translate(-w/2, -h/2) then scale(w/tw, h/th) — unchanged.
      expect(p.matrix, type).toEqual([1, 0, 0, 1, -60, -30])
      // and NOT a gradient: the padding arm must not be reachable by default.
      expect(ctx.gradients, type).toHaveLength(0)
    }
  })

  it('an explicit "box" is the same call log as omitting the argument', () => {
    for (const type of PATTERNED) {
      const a = new RecCtx(), b = new RecCtx()
      resolveFill(a as unknown as CanvasRenderingContext2D, fill(type), BOX, FIELD)
      resolveFill(b as unknown as CanvasRenderingContext2D, fill(type), BOX, FIELD, 'box')
      expect(b.patterns, type).toEqual(a.patterns)
      expect(b.gradients, type).toEqual(a.gradients)
    }
  })

  // Regression (final review, Major): the compositor tile cache (`_fillTileCache`) keyed without
  // shapeId, so changing ONLY the shape (same colours/angle/density/box) returned the stale tile.
  it('the compositor tile cache keys on shapeId — changing only the shape re-tiles', () => {
    const shp = (id: string): Fill => fill('shapes', { a: '#0b1d2e', b: '#e7c94a', angle: 0, density: 4, shapeId: id })
    const one = new RecCtx(), two = new RecCtx(), oneAgain = new RecCtx()
    resolveFill(one as unknown as CanvasRenderingContext2D, shp('sparkle'), BOX, FIELD)
    resolveFill(two as unknown as CanvasRenderingContext2D, shp('sun-rays'), BOX, FIELD)   // ONLY shapeId differs
    resolveFill(oneAgain as unknown as CanvasRenderingContext2D, shp('sparkle'), BOX, FIELD)
    expect(one.patterns[0]!.image).toMatchObject({ tileOf: 'shapes', shapeId: 'sparkle' })
    // Pre-fix this was 'sparkle' (a stale cache hit); post-fix it is the shape actually requested.
    expect(two.patterns[0]!.image).toMatchObject({ tileOf: 'shapes', shapeId: 'sun-rays' })
    expect(oneAgain.patterns[0]!.image).toMatchObject({ tileOf: 'shapes', shapeId: 'sparkle' })
  })

  it('resolvePaint’s four-argument form (the Compositor’s call) is unchanged', () => {
    const a = new RecCtx(), b = new RecCtx()
    resolvePaint(a as unknown as CanvasRenderingContext2D, fill('grid'), BOX, FIELD)
    resolvePaint(b as unknown as CanvasRenderingContext2D, fill('grid'), BOX, FIELD, 'box')
    expect(a.patterns).toEqual(b.patterns)
    expect(a.patterns[0]!.repetition).toBe('no-repeat')
  })

  it('solid ignores spread entirely — a flat colour has no box', () => {
    const ctx = new RecCtx()
    expect(resolveFill(ctx as unknown as CanvasRenderingContext2D, fill('solid'), BOX, FIELD, 'extend')).toBe('#ff0055')
    expect(ctx.patterns).toHaveLength(0)
    expect(ctx.gradients).toHaveLength(0)
  })

  it('a multi-stop Gradient never had the bug and is untouched by spread', () => {
    const g = { type: 'linear' as const, angle: 30, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }
    const a = new RecCtx(), b = new RecCtx()
    resolvePaint(a as unknown as CanvasRenderingContext2D, g, BOX, FIELD)
    resolvePaint(b as unknown as CanvasRenderingContext2D, g, BOX, FIELD, 'extend')
    expect(a.gradients[0]!.coords).toEqual(b.gradients[0]!.coords)
    expect(a.patterns).toHaveLength(0)
  })
})

// ── 2. the rule, and where it comes from ────────────────────────────────────

describe('fillSpreadKind is DERIVED from what the SVG export does', () => {
  it('pads exactly the fills the export writes as a paint server, tiles the rest', () => {
    for (const type of FILL_TYPES) {
      const f = fill(type)
      expect(fillSpreadKind(f), type).toBe(exportTier(f) === 'vector' ? 'pad' : 'repeat')
    }
  })

  it('the four procedural fills TILE — their export is a <pattern> of real rects', () => {
    for (const type of ['grid', 'checkerboard', 'stripes', 'qr'] as const) {
      expect(exportTier(fill(type)), type).toBe('pattern')
      expect(fillSpreadKind(fill(type)), type).toBe('repeat')
    }
  })

  it('gradient PADS — its export is a <linearGradient>, and SVG paint servers pad', () => {
    expect(exportTier(fill('gradient'))).toBe('vector')
    expect(fillSpreadKind(fill('gradient'))).toBe('pad')
  })

  it('ombre / noise / shader tile too: their export is a <pattern> holding an <image>', () => {
    for (const type of ['ombre', 'noise', 'shader'] as const) {
      expect(exportTier(fill(type)), type).toBe('raster')
      expect(fillSpreadKind(fill(type)), type).toBe('repeat')
    }
  })
})

// ── 3. what "extend" actually produces ──────────────────────────────────────

describe('spread: "extend"', () => {
  it('tiles every patterned fill, with the SAME matrix the box form used', () => {
    for (const type of PATTERNED.filter(t => t !== 'gradient')) {
      const box = new RecCtx(), ext = new RecCtx()
      resolveFill(box as unknown as CanvasRenderingContext2D, fill(type), BOX, FIELD, 'box')
      resolveFill(ext as unknown as CanvasRenderingContext2D, fill(type), BOX, FIELD, 'extend')
      expect(ext.patterns[0]!.repetition, type).toBe('repeat')
      // Only the repetition changes. Same tile, same size, same placement — so
      // the picture INSIDE the box is identical and only the outside is new.
      expect(ext.patterns[0]!.image, type).toEqual(box.patterns[0]!.image)
      expect(ext.patterns[0]!.matrix, type).toEqual(box.patterns[0]!.matrix)
    }
  })

  it('a gradient becomes a real CanvasGradient — which pads — and builds no tile', () => {
    const ctx = new RecCtx()
    const style = resolveFill(ctx as unknown as CanvasRenderingContext2D, fill('gradient'), BOX, FIELD, 'extend')
    expect(ctx.patterns).toHaveLength(0)
    expect(style).toBeInstanceOf(FakeGradient)
    expect((style as unknown as FakeGradient).stops).toEqual([
      { offset: 0, color: '#ff0055' },
      { offset: 1, color: '#00c8ff' },
    ])
  })

  it('…over the SAME segment resolvePaint maps an equivalent multi-stop Gradient onto', () => {
    // The one thing a "fix" here could get wrong without changing coverage: the
    // ramp must still be mapped onto the BOX, so canvas and SVG agree about
    // COLOUR and not merely about which pixels are inked.
    const a = new RecCtx(), b = new RecCtx()
    resolveFill(a as unknown as CanvasRenderingContext2D, fill('gradient', { angle: 30 }), BOX, FIELD, 'extend')
    resolvePaint(
      b as unknown as CanvasRenderingContext2D,
      { type: 'linear', angle: 30, stops: [{ offset: 0, color: '#ff0055' }, { offset: 1, color: '#00c8ff' }] },
      BOX, FIELD,
    )
    expect(a.gradients[0]!.coords).toEqual(b.gradients[0]!.coords)
  })
})

// ── 4. Vector Type asks for it on exactly the layers with reach ─────────────

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return { id: 'inter-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}
const font = loadFixtureFont()

function cfg(layers: Array<Record<string, unknown>>): VectorTypeConfig {
  return mergeConfig({
    ...DEFAULT_CONFIG,
    text: 'Sail',
    size: 100,
    appearance: layers.map(l => vtLayer(l as any)),
  } as VectorTypeConfig)
}

/** The stack, through the REAL `drawVectorType`. */
function draw(layers: Array<Record<string, unknown>>): RecCtx {
  const ctx = new RecCtx()
  drawVectorType(ctx as unknown as CanvasRenderingContext2D, font, cfg(layers), 0, { width: 400, height: 200 })
  return ctx
}

describe('Vector Type asks for "extend" on the layers with reach', () => {
  const grad = fill('gradient')
  const grid = fill('grid')

  it('a plain FILL layer keeps the box form — one no-repeat tile, no gradient', () => {
    const ctx = draw([{ kind: 'fill', paint: grid, anchor: 'glyph' }])
    expect(ctx.patterns.length).toBeGreaterThan(0)
    expect(new Set(ctx.patterns.map(p => p.repetition))).toEqual(new Set(['no-repeat']))
  })

  it('an EXTRUDE layer tiles — the block shadow leaves the glyph’s box', () => {
    const ctx = draw([{ kind: 'extrude', paint: grid, anchor: 'glyph', depth: 10, distance: 6, angle: 135 }])
    expect(ctx.patterns.length).toBeGreaterThan(0)
    expect(new Set(ctx.patterns.map(p => p.repetition))).toEqual(new Set(['repeat']))
  })

  it('a STROKE layer tiles — half the pen width lies outside the contour', () => {
    const ctx = draw([{ kind: 'stroke', paint: grid, anchor: 'glyph', width: 20 }])
    expect(ctx.patterns.length).toBeGreaterThan(0)
    expect(new Set(ctx.patterns.map(p => p.repetition))).toEqual(new Set(['repeat']))
  })

  it('a gradient EXTRUDE paints with a padding gradient where a fill paints with a tile', () => {
    const ext = draw([{ kind: 'extrude', paint: grad, anchor: 'glyph', depth: 10, distance: 6, angle: 135 }])
    const fl = draw([{ kind: 'fill', paint: grad, anchor: 'glyph' }])
    // The user's exact case: every ink-laying call on the extrude uses a real
    // CanvasGradient, which pads past the glyph box the copies march out of.
    expect(ext.paints.length).toBeGreaterThan(0)
    expect(ext.paints.every(p => p.style instanceof FakeGradient)).toBe(true)
    expect(ext.patterns).toHaveLength(0)
    // The negative control, same paint, same anchor, no reach: still a tile.
    expect(fl.gradients).toHaveLength(0)
    expect(fl.patterns.length).toBeGreaterThan(0)
  })

  it('the reach is per LAYER — one stack, both answers alive at once', () => {
    const ctx = draw([
      { kind: 'fill', paint: grid, anchor: 'glyph' },
      { kind: 'stroke', paint: grid, anchor: 'glyph', width: 20 },
    ])
    const reps = new Set(ctx.patterns.map(p => p.repetition))
    expect(reps).toEqual(new Set(['no-repeat', 'repeat']))
  })

  it('the WORD anchor gets it too — a run-anchored extrude also overspills its run box', () => {
    const ctx = draw([{ kind: 'extrude', paint: grid, anchor: 'word', depth: 10, distance: 6, angle: 135 }])
    // Hoisted once for the whole run (that is the point of `runStyle`), and it
    // still asks for the reaching form.
    expect(ctx.patterns).toHaveLength(1)
    expect(ctx.patterns[0]!.repetition).toBe('repeat')
  })
})
