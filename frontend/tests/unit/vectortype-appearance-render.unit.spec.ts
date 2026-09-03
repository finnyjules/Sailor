/**
 * Vector Type — drawing the APPEARANCE STACK (`drawVectorType`'s layer loop).
 *
 * Task 2 shipped the model and left `canvas.ts` collapsing it to the bottom-most
 * fill plus the bottom-most stroke. This spec is about the loop that replaced
 * that collapse, and every case in it is one the collapsed renderer could not
 * express or could not be caught getting wrong from a picture:
 *
 *  1. **Order.** Array order is paint order, back to front. The old renderer drew
 *     fill-then-stroke unconditionally, so a **stroke BELOW a fill** was not
 *     expressible at all. A screenshot of the two orderings differs only in a few
 *     pixels along each letter's inner edge; the OP ORDER is unambiguous.
 *  2. **Per-layer anchors.** A word-anchored gradient and a glyph-anchored one
 *     are two paint spaces alive in the same glyph span. The old code hoisted ONE
 *     `runPm`/`runStyle` pair for the whole run, which is correct for one paint
 *     and silently gives layer 2 layer 0's ramp with a stack. Both the count of
 *     paint servers built (once per RUN, not once per letter) and the transform
 *     each layer paints under are read back here.
 *  3. **Opacity × blend × motion opacity, COMPOSED.** Two features that are each
 *     right alone and wrong together is this codebase's most expensive recurring
 *     bug; a test that only checks them separately would not have caught it.
 *  4. **The layers that must NOT paint** — disabled, zero-opacity, zero-width
 *     stroke, and `extrude` (Tasks 4-5, skipped whole rather than half-drawn).
 *
 * The context is a recorder with a real CTM, a real `getTransform`/`setTransform`
 * and real save/restore semantics for the state the loop mutates, so "which
 * transform was in force when layer 2 painted glyph 3" is a fact the test reads
 * rather than infers.
 *
 * NO NETWORK, NO DOM: the same eight-character Inter variable subset every other
 * Vector Type spec uses, plus `Path2D`/`DOMMatrix` stubs (this suite runs in node).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import { DEFAULT_CONFIG, mergeConfig, vtLayer, type VectorTypeConfig, type VtAppearanceLayer } from '~/lib/vectortype/config'
import { drawVectorType, vtDrawLayers } from '~/lib/vectortype/canvas'
import type { BlendKind } from '~/lib/studio/blend'

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))

function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return {
    id: 'inter-subset',
    axes: normaliseAxes(raw?.variationAxes),
    unitsPerEm: Number(raw?.unitsPerEm) || 1000,
    raw,
  }
}
const font = loadFixtureFont()
const WORD = 'Sail'
const N = WORD.length
const BOX = { width: 400, height: 200 }

function cfg(patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig {
  return mergeConfig({ ...DEFAULT_CONFIG, text: WORD, size: 100, ...patch })
}

/** A config whose stack is exactly these layers, in this order (back to front). */
function stack(...layers: Partial<VtAppearanceLayer>[]): VectorTypeConfig {
  return cfg({ appearance: layers.map((l, i) => vtLayer({ id: `L${i}`, ...l })) })
}

/** A preset move in one phase with `ease: 'none'`, so progress is linear and
 *  the motion opacity below is an exact number — the moves-shaped equivalent
 *  of the old `motion[slot] = { presetId, duration, ease: 'none' }`. */
function withPreset(c: VectorTypeConfig, slot: 'in' | 'out' | 'loop', presetId: string): VectorTypeConfig {
  return mergeConfig({
    ...c,
    motion: {
      ...c.motion,
      moves: [{
        id: `move-${slot}`, phase: slot, kind: 'preset', presetId, duration: 1,
        ease: { kind: 'named', name: 'none' },
        play: slot === 'loop' ? { mode: 'repeat', times: 1 } : { mode: 'once', times: 1 },
      }],
    },
  })
}

const RED = '#ff0000'
const BLUE = '#0000ff'
const GREEN = '#00ff00'
const grad = (a: string, b: string) => ({ type: 'linear' as const, angle: 0, stops: [{ offset: 0, color: a }, { offset: 1, color: b }] })

// ── the recording context ───────────────────────────────────────────────────

/** `[a, b, c, d, e, f]`, exactly as canvas means it. */
type Mat = [number, number, number, number, number, number]

/** Enough `DOMMatrix` for the three operations the paint step performs:
 *  `translate` (immutable), `inverse` and `multiply`. Node has no DOMMatrix. */
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
  stops: string[] = []
  constructor(public coords: number[]) {}
  addColorStop(_o: number, c: string) { this.stops.push(c) }
}

class FakePath2D {
  addPath() {}
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  closePath() {}
}

/** One recorded paint: WHAT was drawn, with WHICH style, under WHICH state. */
interface Paint {
  op: 'fill' | 'stroke'
  style: unknown
  alpha: number
  gco: string
  lineWidth: number
  m: Mat
  /** Save depth, so a paint that escaped its glyph span is visible. */
  depth: number
}

class RecCtx {
  paints: Paint[] = []
  gradients: FakeGradient[] = []
  /** Every `save`, so the balance can be asserted. */
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
  save() {
    this.saves++
    this.stack.push({ alpha: this.globalAlpha, gco: this.globalCompositeOperation, filter: this.filter, m: [...this.m] as Mat })
  }
  restore() {
    this.restores++
    const s = this.stack.pop()
    if (s) {
      this.globalAlpha = s.alpha; this.globalCompositeOperation = s.gco
      this.filter = s.filter; this.m = s.m
    }
  }
  translate(x: number, y: number) { this.m = FakeMatrix.from(this.m).translate(x, y).mat }
  rotate(r: number) { this.m = FakeMatrix.from(this.m).multiply(new FakeMatrix(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0)).mat }
  scale(x: number, y: number) { this.m = FakeMatrix.from(this.m).multiply(new FakeMatrix(x, 0, 0, y, 0, 0)).mat }
  clearRect() {}
  fillRect() {}
  beginPath() {}
  rect() {}
  clip() {}
  createLinearGradient(...coords: number[]) {
    const g = new FakeGradient(coords)
    this.gradients.push(g)
    return g
  }
  createRadialGradient(...coords: number[]) { return this.createLinearGradient(...coords) }
  createPattern() { return null }
  private record(op: 'fill' | 'stroke') {
    this.paints.push({
      op,
      style: op === 'fill' ? this.fillStyle : this.strokeStyle,
      alpha: this.globalAlpha,
      gco: this.globalCompositeOperation,
      lineWidth: this.lineWidth,
      m: [...this.m] as Mat,
      depth: this.stack.length,
    })
  }
  fill() { this.record('fill') }
  stroke() { this.record('stroke') }
}

let hadPath2D: unknown
let hadDOMMatrix: unknown
beforeAll(() => {
  hadPath2D = (globalThis as any).Path2D
  hadDOMMatrix = (globalThis as any).DOMMatrix
  ;(globalThis as any).Path2D = FakePath2D
  // `resolveFill`/`resolveShaderFill` guard on `typeof DOMMatrix !== 'undefined'`
  // before touching a pattern; the gradient arm this spec uses never constructs
  // one, but leaving the global absent would make that guard the reason a test
  // passed rather than the code under test.
  ;(globalThis as any).DOMMatrix = FakeMatrix
})
afterAll(() => {
  ;(globalThis as any).Path2D = hadPath2D
  ;(globalThis as any).DOMMatrix = hadDOMMatrix
})

function draw(c: VectorTypeConfig, t = 0, opts: Record<string, unknown> = {}) {
  const ctx = new RecCtx()
  const frame = drawVectorType(ctx as unknown as CanvasRenderingContext2D, font, c, t, { ...BOX, ...opts })
  return { ctx, frame }
}

/**
 * The paints belonging to glyph `i`, in stack order.
 *
 * **LAYER-MAJOR** (changed by Task 4): the loop finishes every glyph of layer 0
 * before it starts layer 1, so layer `l`'s ink on glyph `i` is at `l·n + i`.
 * Task 3 shipped this glyph-major, which is the same picture for as long as no
 * layer's ink leaves its own glyph cell — extrude is the first kind with reach,
 * and glyph-major drew letter 2's block shadow over letter 1's face. Every
 * assertion below is unchanged; only where the paints are found moved.
 */
function perGlyph(ctx: RecCtx, layersPerGlyph: number): Paint[][] {
  const n = ctx.paints.length / layersPerGlyph
  const out: Paint[][] = []
  for (let i = 0; i < n; i++) {
    const g: Paint[] = []
    for (let l = 0; l < layersPerGlyph; l++) g.push(ctx.paints[l * n + i] as Paint)
    out.push(g)
  }
  return out
}

/** √|det| — the uniform scale a matrix applies, i.e. what turns a `lineWidth`
 *  into device pixels. Mirrors `matScale` in canvas.ts. */
const scaleOf = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))

// ── order ───────────────────────────────────────────────────────────────────

describe('the layer loop — array order is PAINT order, back to front', () => {
  it('draws every enabled layer of every glyph, in array order', () => {
    const { ctx } = draw(stack(
      { kind: 'fill', paint: RED },
      { kind: 'stroke', paint: BLUE, width: 6 },
      { kind: 'fill', paint: GREEN },
    ))
    expect(ctx.paints.length).toBe(3 * N)
    for (const g of perGlyph(ctx, 3)) {
      expect(g.map(p => p.op)).toEqual(['fill', 'stroke', 'fill'])
      expect(g.map(p => p.style)).toEqual([RED, BLUE, GREEN])
    }
    // No layer escaped its glyph's own save span.
    expect(ctx.paints.every(p => p.depth === 1)).toBe(true)
    expect(ctx.saves).toBe(ctx.restores)
  })

  it('renders a STROKE BELOW A FILL — the ordering the fixed pair could not express', () => {
    // The pre-stack renderer drew `fill` then `stroke` unconditionally. Both
    // orderings are now expressible, and they are DIFFERENT pictures: below, the
    // fill covers the stroke's inner half; above, the stroke covers the fill's
    // outer edge.
    const below = draw(stack({ kind: 'stroke', paint: BLUE, width: 8 }, { kind: 'fill', paint: RED }))
    const above = draw(stack({ kind: 'fill', paint: RED }, { kind: 'stroke', paint: BLUE, width: 8 }))
    expect(perGlyph(below.ctx, 2)[0]!.map(p => p.op)).toEqual(['stroke', 'fill'])
    expect(perGlyph(above.ctx, 2)[0]!.map(p => p.op)).toEqual(['fill', 'stroke'])
    // Same ink, opposite order — for every glyph, not just the first.
    expect(below.ctx.paints.map(p => p.op)).toEqual(above.ctx.paints.map(p => p.op).map(o => (o === 'fill' ? 'stroke' : 'fill')))
  })

  it('paints a six-layer stack in one pass per layer per glyph', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ kind: 'fill' as const, paint: `#0000${(i + 1).toString(16)}${(i + 1).toString(16)}` }))
    const { ctx } = draw(stack(...six))
    expect(ctx.paints.length).toBe(6 * N)
    expect(perGlyph(ctx, 6)[0]!.map(p => p.style)).toEqual(six.map(l => l.paint))
  })
})

// ── the layers that must not paint ──────────────────────────────────────────

describe('the layers that must NOT paint', () => {
  it('removes exactly the DISABLED layer’s ink, and nothing else', () => {
    const on = draw(stack(
      { kind: 'fill', paint: RED },
      { kind: 'stroke', paint: BLUE, width: 6 },
      { kind: 'fill', paint: GREEN },
    ))
    const off = draw(stack(
      { kind: 'fill', paint: RED },
      { kind: 'stroke', paint: BLUE, width: 6, enabled: false },
      { kind: 'fill', paint: GREEN },
    ))
    expect(on.ctx.paints.length).toBe(3 * N)
    expect(off.ctx.paints.length).toBe(2 * N)
    expect(off.ctx.paints.some(p => p.style === BLUE)).toBe(false)
    // The survivors are untouched: same ops, same styles, same order.
    expect(off.ctx.paints.map(p => `${p.op}:${p.style}`))
      .toEqual(on.ctx.paints.filter(p => p.style !== BLUE).map(p => `${p.op}:${p.style}`))
  })

  it('draws an EXTRUDE as depth COPIES, in stack position — Task 4', () => {
    // ── UPDATED BY TASK 4 ──────────────────────────────────────────────────
    // This test used to assert an extrude contributed NOTHING (2×N paints), and
    // that was the correct assertion while `vtPaintLayers` skipped the kind
    // whole. Task 4 is the reader: an extrude is now `depth` filled copies of
    // the glyph path, drawn in the layer's own slot in the stack. The geometry
    // itself is pinned in `vectortype-extrude.unit.spec.ts`; what this file
    // still owns is that the extrude takes part in the LAYER LOOP like any
    // other layer — right position, right paint, one alpha, no leakage.
    const { ctx } = draw(stack(
      { kind: 'fill', paint: RED },
      { kind: 'extrude', paint: BLUE, depth: 8, distance: 4 },
      { kind: 'fill', paint: GREEN },
    ))
    expect(ctx.paints.length).toBe((1 + 8 + 1) * N)
    // Layer-major, and the middle layer contributes EIGHT paints per glyph:
    // N reds, then N×8 blues, then N greens.
    expect(ctx.paints.slice(0, N).map(p => p.style)).toEqual(Array(N).fill(RED))
    expect(ctx.paints.slice(N, N + 8 * N).every(p => p.style === BLUE)).toBe(true)
    expect(ctx.paints.slice(N + 8 * N).map(p => p.style)).toEqual(Array(N).fill(GREEN))
    // Filled, never stroked — `width` is as inert on an extrude as on a fill.
    expect(ctx.paints.every(p => p.op === 'fill')).toBe(true)
    // A `depth: 0` extrude is still skipped whole, and does not become a fill.
    const zero = draw(stack(
      { kind: 'fill', paint: RED },
      { kind: 'extrude', paint: BLUE, depth: 0, distance: 4 },
      { kind: 'fill', paint: GREEN },
    ))
    expect(zero.ctx.paints.length).toBe(2 * N)
    expect(zero.ctx.paints.some(p => p.style === BLUE)).toBe(false)
  })

  it('drops a zero-width stroke and a zero-opacity layer', () => {
    const { ctx } = draw(stack(
      { kind: 'stroke', paint: BLUE, width: 0 },
      { kind: 'fill', paint: GREEN, opacity: 0 },
      { kind: 'fill', paint: RED },
    ))
    expect(ctx.paints.length).toBe(N)
    expect(ctx.paints.every(p => p.style === RED)).toBe(true)
  })

  it('drops a non-painting colour on a HAND-WRITTEN stack', () => {
    // `mergeConfig` lifts every string paint to a solid `Fill`, and a `Fill`
    // always paints — so this guard is for a raw blob or a config assembled in
    // code, never for something the merge produced. Stated as such rather than
    // asserted through the merge, which would quietly test nothing.
    const raw = {
      ...cfg(),
      appearance: [
        { ...vtLayer({ id: 'La' }), paint: 'none' },
        { ...vtLayer({ id: 'Lb' }), paint: 'transparent' },
        { ...vtLayer({ id: 'Lc' }), paint: RED },
      ],
    }
    const { ctx } = draw(raw as VectorTypeConfig)
    expect(ctx.paints.length).toBe(N)
    expect(ctx.paints.every(p => p.style === RED)).toBe(true)
  })

  it('an EMPTY stack paints nothing — and still leaves the context balanced', () => {
    const { ctx, frame } = draw(cfg({ appearance: [] }))
    expect(frame.outlines.glyphs.length).toBe(N)
    expect(ctx.paints.length).toBe(0)
    expect(ctx.saves).toBe(ctx.restores)
  })
})

// ── trap 4, at the renderer ─────────────────────────────────────────────────

describe('a RAW pre-stack blob still paints its fill AND its stroke (trap 4)', () => {
  it('migrates a config with no `appearance` array on the spot', () => {
    // `applyMotion`/`cloneConfig` clone whatever blob they are handed, and the
    // node card, the bake and the frame source can each read stored JSON
    // directly — so the renderer must absorb this, exactly as the Task 2 bridge
    // it replaced did.
    const raw = { text: WORD, fontId: DEFAULT_CONFIG.fontId, size: 100, fill: '#ff2200', stroke: '#00c8ff', strokeWidth: 8 }
    const { ctx } = draw(raw as unknown as VectorTypeConfig)
    expect(ctx.paints.length).toBe(2 * N)
    expect(perGlyph(ctx, 2)[0]!.map(p => p.op)).toEqual(['fill', 'stroke'])
    expect((perGlyph(ctx, 2)[0]![0]!.style as string).toLowerCase()).toBe('#ff2200')
    expect(perGlyph(ctx, 2)[0]![1]!.lineWidth).toBe(8)
  })

  it('draws no stroke for a legacy `strokeWidth: 0` — that stroke was never visible', () => {
    const raw = { text: WORD, fontId: DEFAULT_CONFIG.fontId, size: 100, fill: '#ff2200', stroke: '#00c8ff', strokeWidth: 0 }
    const { ctx } = draw(raw as unknown as VectorTypeConfig)
    expect(ctx.paints.length).toBe(N)
    expect(ctx.paints.every(p => p.op === 'fill')).toBe(true)
  })

  it('`vtDrawLayers` distinguishes an EMPTY stack from an ABSENT one', () => {
    // Present-but-empty is the user having removed every layer; absent is a
    // pre-stack blob. Collapsing the two either resurrects deleted layers or
    // blanks every legacy node.
    expect(vtDrawLayers(cfg({ appearance: [] }))).toEqual([])
    expect(vtDrawLayers({ fill: '#123456', strokeWidth: 4, stroke: '#654321' } as any).map(l => l.kind))
      .toEqual(['fill', 'stroke'])
    expect(vtDrawLayers(null)).toHaveLength(1)
  })
})

// ── opacity, blend, and the two of them composed with motion ────────────────

describe('per-layer opacity and blend, COMPOSED with the glyph’s motion opacity', () => {
  it('multiplies the layer opacity into the motion opacity — neither replaces the other', () => {
    const layers = stack({ kind: 'fill', paint: RED, opacity: 0.4 }, { kind: 'fill', paint: GREEN, opacity: 1 })
    // 1. Layer opacity alone: no motion, so alpha IS the layer's.
    const still = draw(layers)
    expect(perGlyph(still.ctx, 2)[0]!.map(p => p.alpha)).toEqual([0.4, 1])

    // 2. Motion opacity alone: a fade with every layer at 1.
    const opaque = withPreset(stack({ kind: 'fill', paint: RED }, { kind: 'fill', paint: GREEN }), 'in', 'fade-in')
    const fading = draw(opaque, 0.5)
    const mo = fading.frame.transforms[0]!.opacity
    // The test is only worth anything if the glyph really is mid-fade.
    expect(mo).toBeGreaterThan(0.05)
    expect(mo).toBeLessThan(0.95)
    expect(fading.ctx.paints[0]!.alpha).toBeCloseTo(mo, 9)

    // 3. BOTH — the case a "each is right alone" test cannot see. It must be the
    //    product, and in particular NOT either input on its own.
    const both = draw(withPreset(layers, 'in', 'fade-in'), 0.5)
    const g0 = perGlyph(both.ctx, 2)[0]!
    expect(g0[0]!.alpha).toBeCloseTo(mo * 0.4, 9)
    expect(g0[1]!.alpha).toBeCloseTo(mo, 9)
    expect(g0[0]!.alpha).not.toBeCloseTo(0.4, 6)   // the layer's value did not survive alone
    expect(g0[0]!.alpha).not.toBeCloseTo(mo, 6)    // nor did the motion's
  })

  it('composes opacity AND blend AND motion on the same paint, per layer', () => {
    const c = withPreset(stack(
      { kind: 'fill', paint: RED, opacity: 0.5, blend: 'multiply' },
      { kind: 'stroke', paint: BLUE, width: 5, opacity: 0.25, blend: 'screen' },
      { kind: 'fill', paint: GREEN, opacity: 1, blend: 'normal' },
    ), 'in', 'fade-in')
    const { ctx, frame } = draw(c, 0.5)
    const mo = frame.transforms[0]!.opacity
    expect(mo).toBeGreaterThan(0.05)
    expect(mo).toBeLessThan(0.95)
    const g0 = perGlyph(ctx, 3)[0]!
    expect(g0.map(p => p.gco)).toEqual(['multiply', 'screen', 'source-over'])
    expect(g0[0]!.alpha).toBeCloseTo(mo * 0.5, 9)
    expect(g0[1]!.alpha).toBeCloseTo(mo * 0.25, 9)
    expect(g0[2]!.alpha).toBeCloseTo(mo * 1, 9)
    // …and the blend did not follow the alpha: the strongest layer is `normal`,
    // the weakest is `screen`, so neither could be standing in for the other.
    expect(g0[2]!.gco).toBe('source-over')
  })

  it('maps every blend kind to a canvas composite op, and `add` to `lighter`', () => {
    // Two draws, because all seven kinds do not fit in one stack — `VT_LAYER_MAX`
    // is 6 and `mergeConfig` caps it. (Slicing a capped stack as if it were
    // seven-wide is how the first version of this test read glyph 1's ops as
    // glyph 0's and "found" a wrong blend.)
    const gcos = (...kinds: BlendKind[]) => {
      const { ctx } = draw(stack(...kinds.map(b => ({ kind: 'fill' as const, paint: RED, blend: b }))))
      return perGlyph(ctx, kinds.length)[0]!.map(p => p.gco)
    }
    expect(gcos('normal', 'lighten', 'screen', 'add')).toEqual(['source-over', 'lighten', 'screen', 'lighter'])
    expect(gcos('multiply', 'darken', 'overlay')).toEqual(['multiply', 'darken', 'overlay'])
  })

  it('cannot leak a blend into the next layer or the next glyph', () => {
    const { ctx } = draw(stack(
      { kind: 'fill', paint: RED, blend: 'multiply' },
      { kind: 'fill', paint: GREEN, blend: 'normal' },
    ))
    // Every glyph's FIRST paint is `multiply` (the previous glyph's `normal` did
    // not persist) and every SECOND is `source-over` (the multiply did not).
    for (const g of perGlyph(ctx, 2)) expect(g.map(p => p.gco)).toEqual(['multiply', 'source-over'])
    // …and the context is handed back on the default.
    expect(ctx.globalCompositeOperation).toBe('source-over')
    expect(ctx.globalAlpha).toBe(1)
  })
})

// ── per-layer anchors ───────────────────────────────────────────────────────

describe('per-layer anchors — two paint spaces alive in one glyph span', () => {
  it('builds a WORD-anchored paint server once for the RUN, not once per letter', () => {
    const word = draw(stack({ kind: 'fill', paint: grad(RED, BLUE), anchor: 'word' }))
    expect(word.ctx.gradients.length).toBe(1)
    // Every glyph painted with that ONE object — a per-glyph rebuild would be
    // the same picture at N times the cost, and invisible in a screenshot.
    expect(word.ctx.paints.length).toBe(N)
    expect(new Set(word.ctx.paints.map(p => p.style)).size).toBe(1)
    expect(word.ctx.paints[0]!.style).toBe(word.ctx.gradients[0])

    const glyph = draw(stack({ kind: 'fill', paint: grad(RED, BLUE), anchor: 'glyph' }))
    expect(glyph.ctx.gradients.length).toBe(N)
    expect(new Set(glyph.ctx.paints.map(p => p.style)).size).toBe(N)
  })

  it('gives a WORD-anchored fill and a GLYPH-anchored stroke their OWN spaces, at once', () => {
    const { ctx } = draw(stack(
      { kind: 'fill', paint: grad(RED, BLUE), anchor: 'word' },
      { kind: 'stroke', paint: grad(GREEN, RED), anchor: 'glyph', width: 4 },
    ))
    expect(ctx.paints.length).toBe(2 * N)
    // 1 run-anchored server + one per glyph for the glyph-anchored stroke.
    expect(ctx.gradients.length).toBe(1 + N)

    const g = perGlyph(ctx, 2)
    const fillM = g.map(p => p[0]!.m.join(','))
    const strokeM = g.map(p => p[1]!.m.join(','))
    // The word-anchored fill paints under the SAME matrix for every letter…
    expect(new Set(fillM).size).toBe(1)
    // …while the glyph-anchored stroke moves with each one.
    expect(new Set(strokeM).size).toBe(N)
    // …and the two are not the same space, which is the whole claim.
    expect(fillM[0]).not.toBe(strokeM[0])
    // Each layer kept its own paint server, too: the fill is the run gradient on
    // every glyph, the stroke never is.
    expect(new Set(g.map(p => p[0]!.style)).size).toBe(1)
    expect(g.every(p => p[1]!.style !== p[0]!.style)).toBe(true)
  })

  it('keeps two WORD-anchored layers apart — one hoisted pair would merge them', () => {
    // The bug this replaces: `runPm`/`runStyle` were two locals for the whole
    // run, so a second run-anchored layer would have painted with the first
    // one's ramp. Two gradients built, two distinct styles used.
    const { ctx } = draw(stack(
      { kind: 'fill', paint: grad(RED, BLUE), anchor: 'word' },
      { kind: 'fill', paint: grad(GREEN, RED), anchor: 'frame' },
    ))
    expect(ctx.gradients.length).toBe(2)
    expect(ctx.gradients[0]!.stops).toEqual([RED, BLUE])
    expect(ctx.gradients[1]!.stops).toEqual([GREEN, RED])
    const g0 = perGlyph(ctx, 2)[0]!
    expect(g0[0]!.style).toBe(ctx.gradients[0])
    expect(g0[1]!.style).toBe(ctx.gradients[1])
    // `word` is the run's INK box, `frame` is the whole output box — different
    // extents, so the two servers span different geometry as well as being two
    // distinct objects.
    expect(ctx.gradients[0]!.coords).not.toEqual(ctx.gradients[1]!.coords)
  })

  it('anchors a WORD layer to the run and a FRAME layer to the canvas — different spaces', () => {
    const left = cfg({
      align: 'left',
      appearance: [
        vtLayer({ id: 'L0', paint: grad(RED, BLUE), anchor: 'word' }),
        vtLayer({ id: 'L1', paint: grad(GREEN, RED), anchor: 'frame' }),
      ],
    })
    const g0 = perGlyph(draw(left).ctx, 2)[0]!
    // Left-aligned, so the run's ink centre is NOT the frame's centre and the
    // two paint spaces are visibly different matrices.
    expect(g0[0]!.m.join(',')).not.toBe(g0[1]!.m.join(','))
  })
})

// ── stroke width in a foreign paint space ───────────────────────────────────

describe('a stroke keeps its OUTPUT width even when its paint is anchored elsewhere', () => {
  it('compensates lineWidth for the paint space, so a scaled glyph strokes the same', () => {
    // `lineWidth` is in the CURRENT transform's units. A flat stroke is drawn
    // under the glyph's own (scaled) CTM; a run-anchored one is drawn under the
    // run's paint space, which carries no motion. Without the compensation the
    // same stroke would be a different thickness on the two paths — visible only
    // as "my gradient stroke does not grow with the letter".
    const flat = draw(withPreset(stack({ kind: 'stroke', paint: BLUE, width: 10 }), 'in', 'grow-in'), 0.5)
    const anchored = draw(withPreset(stack({ kind: 'stroke', paint: grad(RED, BLUE), anchor: 'word', width: 10 }), 'in', 'grow-in'), 0.5)
    const s = flat.frame.transforms[0]!.scale
    expect(s).not.toBeCloseTo(1, 3)   // the glyph really is scaled

    const a = flat.ctx.paints[0]!
    const b = anchored.ctx.paints[0]!
    expect(a.lineWidth).toBe(10)                        // untouched: its space IS the glyph's
    expect(b.lineWidth).not.toBeCloseTo(10, 6)          // corrected: its space is the run's
    // The DEVICE width — the only thing a viewer sees — agrees to a pixel.
    expect(b.lineWidth * scaleOf(b.m)).toBeCloseTo(a.lineWidth * scaleOf(a.m), 6)
  })

  it('leaves a GLYPH-anchored stroke’s width exactly alone — its paint space is the glyph’s', () => {
    const { ctx } = draw(stack({ kind: 'stroke', paint: grad(RED, BLUE), anchor: 'glyph', width: 7 }))
    expect(ctx.paints.every(p => p.lineWidth === 7)).toBe(true)
  })

  it('scales a stroke by pixelRatio, exactly as a fill is scaled', () => {
    // `width` is OUTPUT pixels, so a 2× bake strokes 2× as many device pixels.
    const at = (k: number) => {
      const { ctx } = draw(stack({ kind: 'stroke', paint: BLUE, width: 6 }), 0, { pixelRatio: k })
      const p = ctx.paints[0]!
      return p.lineWidth * scaleOf(p.m)
    }
    expect(at(2) / at(1)).toBeCloseTo(2, 6)
  })
})
