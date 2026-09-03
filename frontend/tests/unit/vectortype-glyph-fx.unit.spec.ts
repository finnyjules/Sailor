/**
 * Vector Type — per-glyph BLUR and CLIP in the canvas renderer.
 *
 * `vectorTypeFrame` is pure and already pinned elsewhere; this spec is about the
 * other half — what `drawVectorType` actually does to the context, which is
 * where the two failure modes of this feature live and where neither is visible
 * in a picture:
 *
 *  1. **A leaked `ctx.filter`.** Nothing looks wrong until a glyph that should
 *     be sharp is blurred, and by then the cause is two glyphs away.
 *  2. **A clip applied AFTER the unit transform.** The mask then travels with
 *     the letter instead of being a fixed window it slides through. Every single
 *     frame still shows a plausibly masked glyph, so a thumbnail — or a
 *     screenshot — cannot tell the two apart. Only the ORDER of the operations
 *     can, which is exactly what a recording context can assert.
 *
 * The context is a recorder with real `save`/`restore` semantics for the two
 * pieces of state that matter (`filter`, `globalAlpha`), so "the filter in force
 * when glyph *i* was filled" is a fact the test can read rather than infer.
 *
 * NO NETWORK, NO DOM: the same eight-character Inter variable subset the other
 * Vector Type specs use, plus a `Path2D` stub (this suite runs in node, and
 * `outlinesToPath2D` refuses to guess).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import { DEFAULT_CONFIG, mergeConfig, type VectorTypeConfig } from '~/lib/vectortype/config'
import { drawVectorType, vectorTypeFrame, vectorTypeSVG, vtPlacement } from '~/lib/vectortype/canvas'
import { glyphTransform as glyphPlacement } from '~/lib/vectortype/render'
import type { GlyphOutline } from '~/lib/vectortype/outline'

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

function cfg(patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig {
  return mergeConfig({ ...DEFAULT_CONFIG, text: WORD, size: 100, ...patch })
}

/** A preset move in one phase, with `ease: 'none'` so progress is linear and
 *  every expected number below is exact — the moves-shaped equivalent of the
 *  old `motion[slot] = { presetId, duration, ease: 'none' }`. */
function withPreset(slot: 'in' | 'out' | 'loop', presetId: string, patch: Partial<VectorTypeConfig> = {}) {
  const c = cfg(patch)
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

// ── the recording context ───────────────────────────────────────────────────

interface Op { op: string; [k: string]: unknown }

/** A 2D affine matrix, `[a, b, c, d, e, f]`, exactly as canvas means it. */
type Mat = [number, number, number, number, number, number]
const IDENT: Mat = [1, 0, 0, 1, 0, 0]
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
]
const apply = (m: Mat, x: number, y: number) => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
})

class RecCtx {
  ops: Op[] = []
  private stack: Array<{ filter: string; alpha: number; m: Mat }> = []
  private _filter = 'none'
  /** The real CTM. Without it a `rect` recorded AFTER a `translate` would read
   *  back the same numbers as one recorded before, and the whole point of this
   *  spec — telling a fixed window from one that travels with the letter —
   *  would be untestable. */
  private m: Mat = [...IDENT] as Mat
  globalAlpha = 1
  fillStyle: unknown = ''
  strokeStyle: unknown = ''
  lineWidth = 0
  lineJoin = ''

  get filter(): string { return this._filter }
  set filter(v: string) { this._filter = v; this.ops.push({ op: 'filter', value: v }) }

  save() {
    this.stack.push({ filter: this._filter, alpha: this.globalAlpha, m: [...this.m] as Mat })
    this.ops.push({ op: 'save' })
  }
  restore() {
    const s = this.stack.pop()
    if (s) { this._filter = s.filter; this.globalAlpha = s.alpha; this.m = s.m }
    this.ops.push({ op: 'restore' })
  }
  setTransform(...a: number[]) { this.m = a.slice(0, 6) as Mat; this.ops.push({ op: 'setTransform', a }) }
  clearRect(...a: number[]) { this.ops.push({ op: 'clearRect', a }) }
  fillRect(...a: number[]) { this.ops.push({ op: 'fillRect', a }) }
  translate(x: number, y: number) { this.m = mul(this.m, [1, 0, 0, 1, x, y]); this.ops.push({ op: 'translate', x, y }) }
  rotate(r: number) {
    this.m = mul(this.m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0])
    this.ops.push({ op: 'rotate', r })
  }
  scale(x: number, y: number) { this.m = mul(this.m, [x, 0, 0, y, 0, 0]); this.ops.push({ op: 'scale', x, y }) }
  beginPath() { this.ops.push({ op: 'beginPath' }) }
  rect(x: number, y: number, w: number, h: number) {
    // Both the raw arguments and where they actually LAND, so a clip applied
    // under a translate is visibly a different window.
    const tl = apply(this.m, x, y)
    const br = apply(this.m, x + w, y + h)
    this.ops.push({ op: 'rect', x, y, w, h, left: tl.x, top: tl.y, right: br.x, bottom: br.y })
  }
  clip() { this.ops.push({ op: 'clip' }) }
  fill(..._a: unknown[]) {
    // The CTM in force at the fill IS the glyph's transform — the pivot tests
    // read it back and push points through it, which is the only way to tell
    // "scaled about the left edge" from "scaled about the cell centre".
    this.ops.push({ op: 'fill', filter: this._filter, alpha: this.globalAlpha, depth: this.stack.length, m: [...this.m] as Mat })
  }
  stroke(..._a: unknown[]) { this.ops.push({ op: 'stroke', filter: this._filter }) }
}

class FakePath2D {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  closePath() {}
}

let hadPath2D: unknown
beforeAll(() => {
  hadPath2D = (globalThis as any).Path2D
  ;(globalThis as any).Path2D = FakePath2D
})
afterAll(() => { (globalThis as any).Path2D = hadPath2D })

const BOX = { width: 400, height: 200 }

function draw(c: VectorTypeConfig, t: number, opts: Partial<{ pixelRatio: number }> = {}) {
  const ctx = new RecCtx()
  const frame = drawVectorType(ctx as unknown as CanvasRenderingContext2D, font, c, t, { ...BOX, ...opts })
  return { ctx, frame }
}

/** The ops belonging to each glyph: one `save`…`restore` span per glyph, in
 *  draw order. The setup ops before the first `save` are dropped. */
function spans(ctx: RecCtx): Op[][] {
  const out: Op[][] = []
  let cur: Op[] | null = null
  let depth = 0
  for (const op of ctx.ops) {
    if (op.op === 'save') { depth++; if (depth === 1) { cur = []; continue } }
    if (op.op === 'restore') { depth--; if (depth === 0 && cur) { out.push(cur); cur = null; continue } }
    if (cur) cur.push(op)
  }
  return out
}

const first = (ops: Op[], name: string) => ops.findIndex(o => o.op === name)

// ── blur ────────────────────────────────────────────────────────────────────

describe('per-glyph blur', () => {
  it('reaches the context as a filter, at the em-scaled radius', () => {
    // blur-in at linear progress 0.5 → BLUR_MAX (0.12) × 0.5 × em(100) = 6px.
    const { ctx } = draw(withPreset('in', 'blur-in'), 0.5)
    const filters = ctx.ops.filter(o => o.op === 'filter').map(o => o.value)
    expect(filters.length).toBe(WORD.length)
    expect(new Set(filters)).toEqual(new Set(['blur(6px)']))
    // and every glyph was actually FILLED with it in force
    const fills = ctx.ops.filter(o => o.op === 'fill')
    expect(fills.length).toBe(WORD.length)
    expect(fills.every(f => f.filter === 'blur(6px)')).toBe(true)
  })

  it('scales the radius by pixelRatio — a canvas filter ignores the CTM', () => {
    // The node card draws the same config at a fraction of the bake's size. A
    // canvas filter's blur is in DEVICE pixels and is NOT transformed by the
    // context's scale, so the radius has to be pre-multiplied or the card blurs
    // 1/k times too hard. Measured in Chrome; pinned here.
    const c = withPreset('in', 'blur-in')
    const at = (k: number) =>
      draw(c, 0.5, { pixelRatio: k }).ctx.ops.find(o => o.op === 'filter')?.value
    expect(at(1)).toBe('blur(6px)')
    expect(at(0.5)).toBe('blur(3px)')
    expect(at(2)).toBe('blur(12px)')
  })

  it('scales the radius with the type SIZE too — two sizes, not one', () => {
    const at = (size: number) =>
      draw(withPreset('in', 'blur-in', { size }), 0.5).ctx.ops.find(o => o.op === 'filter')?.value
    expect(at(100)).toBe('blur(6px)')
    expect(at(200)).toBe('blur(12px)')
  })

  it('sets NO filter when nothing is blurred', () => {
    const { ctx } = draw(cfg(), 0)
    expect(ctx.ops.some(o => o.op === 'filter')).toBe(false)
    expect(ctx.ops.filter(o => o.op === 'fill').every(f => f.filter === 'none')).toBe(true)
  })

  it('CANNOT leak the filter to the next glyph — a sharp glyph beside a blurred one', () => {
    // A stagger makes the run blur unevenly at one instant: glyph 0's entrance
    // is over (sharp), the tail has not started (fully blurred). If the filter
    // leaked, glyph 0 — drawn first — could not be sharp while a later one is
    // blurred, so this is the arrangement that can actually catch it.
    const c = cfg()
    const staggered = mergeConfig({
      ...c,
      motion: {
        ...c.motion,
        moves: [{
          id: 'move-in', phase: 'in', kind: 'preset', presetId: 'blur-in', duration: 1,
          ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: 1 },
        }],
        stagger: { ...c.motion.stagger, delay: 0.3, order: 'forward' },
      },
    })
    const { ctx } = draw(staggered, 1.0)
    const fills = ctx.ops.filter(o => o.op === 'fill')
    expect(fills.length).toBe(WORD.length)
    expect(fills[0]!.filter).toBe('none')                       // done: sharp
    expect(fills[fills.length - 1]!.filter).not.toBe('none')    // waiting: blurred
    // Every glyph is filled exactly one save deep — no state is shared sideways.
    expect(fills.every(f => f.depth === 1)).toBe(true)
    // …and the context is handed back clean.
    expect(ctx.filter).toBe('none')
    expect(ctx.ops.filter(o => o.op === 'save').length)
      .toBe(ctx.ops.filter(o => o.op === 'restore').length)
  })

  it('sets the filter INSIDE the glyph span, never between them', () => {
    const { ctx } = draw(withPreset('in', 'blur-in'), 0.5)
    // Walk the whole op list: `filter` may only appear at save-depth ≥ 1.
    let depth = 0
    for (const op of ctx.ops) {
      if (op.op === 'save') depth++
      else if (op.op === 'restore') depth--
      else if (op.op === 'filter') expect(depth).toBeGreaterThan(0)
    }
    expect(depth).toBe(0)
  })
})

// ── clip ────────────────────────────────────────────────────────────────────

describe('per-glyph clip — the mask is a FIXED window', () => {
  const masked = () => withPreset('in', 'mask-up')

  it('clips BEFORE the unit transform, for every glyph', () => {
    const { ctx } = draw(masked(), 0.4)
    const glyphs = spans(ctx)
    expect(glyphs.length).toBe(WORD.length)
    for (const ops of glyphs) {
      const r = first(ops, 'rect')
      const clip = first(ops, 'clip')
      const tr = first(ops, 'translate')
      expect(r).toBeGreaterThanOrEqual(0)
      expect(tr).toBeGreaterThanOrEqual(0)
      // The order IS the feature: rect → clip → translate.
      expect(r).toBeLessThan(clip)
      expect(clip).toBeLessThan(tr)
    }
  })

  it('holds the reveal edge STILL while the glyph slides under it', () => {
    // mask-up: the glyph starts a quarter-em low and rises; the window's bottom
    // edge is the em box's, and it must not move. If the clip were applied after
    // the transform, the whole window would travel with the letter and the
    // bottom edge would follow `dy` exactly.
    const c = masked()
    const sample = (t: number) => {
      const { ctx, frame } = draw(c, t)
      const g0 = spans(ctx)[0]!
      // `bottom`/`top` are where the window LANDS, through whatever CTM was in
      // force when the rect was declared — the number a post-transform clip
      // would move.
      const rect = g0.find(o => o.op === 'rect') as { top: number; bottom: number }
      const move = g0.find(o => o.op === 'translate') as { y: number }
      return {
        bottom: rect.bottom,
        height: rect.bottom - rect.top,
        ty: move.y,
        dy: frame.transforms[0]!.dy,
      }
    }
    const a = sample(0.25)
    const b = sample(0.5)
    const d = sample(0.75)

    // The glyph really is moving — otherwise this test proves nothing.
    expect(a.dy).toBeGreaterThan(b.dy)
    expect(b.dy).toBeGreaterThan(d.dy)
    expect(a.ty).not.toBeCloseTo(b.ty, 3)

    // …and the reveal edge is bit-identical across all three.
    expect(b.bottom).toBeCloseTo(a.bottom, 9)
    expect(d.bottom).toBeCloseTo(a.bottom, 9)
    // The window OPENS: it is a reveal, not a translation of a fixed slit.
    expect(b.height).toBeGreaterThan(a.height)
    expect(d.height).toBeGreaterThan(b.height)
  })

  it('puts that fixed edge exactly one descent below the placed baseline', () => {
    const c = masked()
    const frame = vectorTypeFrame(font, c, 0.4)
    const place = vtPlacement(frame, BOX)
    const origin = glyphPlacement(frame.outlines.glyphs[0] as GlyphOutline, place)
    const em = place.scale * frame.outlines.unitsPerEm
    const { ctx } = draw(c, 0.4)
    const rect = spans(ctx)[0]!.find(o => o.op === 'rect') as { x: number; y: number; w: number; h: number }
    expect(rect.y + rect.h).toBeCloseTo(origin.y + em * 0.2, 9)
    // Height is the revealed fraction of the em: amount = 1 - progress.
    expect(rect.h).toBeCloseTo(em * 0.4, 6)
  })

  it('shows NOTHING at amount 1 — a zero-height window, not a padded sliver', () => {
    const { ctx, frame } = draw(masked(), 0)
    expect(frame.transforms[0]!.clip).toEqual({ side: 'top', amount: 1 })
    const rect = spans(ctx)[0]!.find(o => o.op === 'rect') as { h: number }
    expect(rect.h).toBe(0)
  })

  it('pads the PERPENDICULAR axis, so a descender or an overhang is not sliced', () => {
    const frame = vectorTypeFrame(font, masked(), 0.4)
    const place = vtPlacement(frame, BOX)
    const glyph = frame.outlines.glyphs[0] as GlyphOutline
    const origin = glyphPlacement(glyph, place)
    const em = place.scale * frame.outlines.unitsPerEm
    const { ctx } = draw(masked(), 0.4)
    const rect = spans(ctx)[0]!.find(o => o.op === 'rect') as { x: number; w: number }
    expect(rect.x).toBeCloseTo(origin.x - em, 9)
    expect(rect.w).toBeCloseTo(glyph.advance * place.scale + em * 2, 9)
  })

  it('clips nothing when no preset masks', () => {
    const { ctx } = draw(cfg(), 0)
    expect(ctx.ops.some(o => o.op === 'clip')).toBe(false)
    expect(ctx.ops.some(o => o.op === 'rect')).toBe(false)
  })
})

// ── non-uniform scale ───────────────────────────────────────────────────────

describe('scaleX / scaleY — the card-flip presets are DRAWN, not silently dropped', () => {
  it('applies a non-uniform scale on the canvas', () => {
    const { ctx, frame } = draw(withPreset('in', 'card-flip-h'), 0.5)
    const tr = frame.transforms[0]!
    expect(tr.scaleX).not.toBe(1)
    expect(tr.scaleY).toBe(1)
    const s = spans(ctx)[0]!.find(o => o.op === 'scale') as { x: number; y: number }
    expect(s).toBeTruthy()
    expect(s.x).toBeCloseTo(tr.scale * tr.scaleX, 9)
    expect(s.y).toBeCloseTo(tr.scale * tr.scaleY, 9)
    expect(s.x).not.toBeCloseTo(s.y, 6)
  })

  it('applies the vertical flip too, and multiplies with the uniform scale', () => {
    const { ctx, frame } = draw(withPreset('in', 'card-flip-v'), 0.5)
    const tr = frame.transforms[0]!
    const s = spans(ctx)[0]!.find(o => o.op === 'scale') as { x: number; y: number }
    expect(s.x).toBeCloseTo(tr.scale, 9)
    expect(s.y).toBeCloseTo(tr.scale * tr.scaleY, 9)
    expect(s.y).toBeLessThan(s.x)
  })

  it('exports the SAME non-uniform scale to SVG — the two renderers cannot drift', () => {
    const { frame } = draw(withPreset('in', 'card-flip-h'), 0.5)
    const tr = frame.transforms[0]!
    const { svg } = vectorTypeSVG(font, withPreset('in', 'card-flip-h'), 0.5, BOX)
    const sx = (tr.scale * tr.scaleX).toFixed(3).replace(/\.?0+$/, '')
    expect(svg).toContain(`scale(${sx} 1)`)
  })

  it('still writes a UNIFORM scale as one argument', () => {
    const { svg } = vectorTypeSVG(font, withPreset('in', 'grow-in'), 0.5, BOX)
    expect(svg).toMatch(/scale\(-?[\d.]+\)/)
    expect(svg).not.toMatch(/scale\([\d.]+ [\d.]+\)/)
  })

  it('never emits a zero scale factor — a singular CTM drops the glyph', () => {
    // card-flip-h at progress 0 is the engine's own 0.001 floor; the renderer
    // has its own guard so a bare 0 from anywhere cannot reach `ctx.scale`.
    const { ctx } = draw(withPreset('in', 'card-flip-h'), 0)
    for (const s of ctx.ops.filter(o => o.op === 'scale') as Array<{ x: number; y: number }>) {
      expect(Math.abs(s.x)).toBeGreaterThanOrEqual(0.001)
      expect(Math.abs(s.y)).toBeGreaterThanOrEqual(0.001)
    }
  })
})

// ── the scale pivot ─────────────────────────────────────────────────────────
//
// A glyph's placed ORIGIN is its left edge, on the baseline. Scaling about it is
// right vertically — type scales about its baseline — and wrong horizontally: it
// pins each letter's LEFT edge, so a card flip at scaleX 0.43 reads as six thin
// letters with wide gaps rather than six cards turning in place. The horizontal
// pivot is the glyph CELL's centre (`origin.x + advance/2`); the vertical one
// stays on the baseline, and rotation stays on the origin.
//
// None of this is visible in a still: every frame shows plausibly narrow
// letters. Only pushing points through the composed CTM can tell them apart.

/** The affine matrix an SVG transform list composes to, so the exported
 *  transform can be compared with the canvas CTM as a MATRIX rather than as a
 *  string — the two renderers may legitimately spell it differently. */
function matFromSvgTransform(list: string): Mat {
  let m: Mat = [...IDENT] as Mat
  for (const [, fn, args] of list.matchAll(/(translate|rotate|scale)\(([^)]*)\)/g)) {
    const a = args!.trim().split(/[\s,]+/).map(Number)
    if (fn === 'translate') m = mul(m, [1, 0, 0, 1, a[0]!, a[1] ?? 0])
    else if (fn === 'scale') m = mul(m, [a[0]!, 0, 0, a[1] ?? a[0]!, 0, 0])
    else {
      const r = (a[0]! * Math.PI) / 180
      m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0])
    }
  }
  return m
}

/** Everything the pivot is measured against, for glyph `i` of one frame. */
function glyphGeom(c: VectorTypeConfig, t: number, i = 0) {
  const { ctx, frame } = draw(c, t)
  const place = vtPlacement(frame, BOX)
  const glyph = frame.outlines.glyphs[i] as GlyphOutline
  const origin = glyphPlacement(glyph, place)
  const advance = glyph.advance * place.scale
  const fill = ctx.ops.filter(o => o.op === 'fill')[i] as { m: Mat }
  return { frame, origin, advance, m: fill.m, ctx, place, glyph }
}

describe('the scale pivot — cards flip in place, they do not slide left', () => {
  it('scales horizontally about the glyph CELL CENTRE, not the left edge', () => {
    const c = withPreset('in', 'card-flip-h')
    const { origin, advance, m, frame } = glyphGeom(c, 0.5)
    const sx = frame.transforms[0]!.scale * frame.transforms[0]!.scaleX
    expect(sx).toBeLessThan(0.9)                       // the flip really is narrow

    const cx = origin.x + advance / 2
    // The cell centre is a FIXED POINT: the letter narrows around itself.
    expect(apply(m, cx, origin.y).x).toBeCloseTo(cx, 6)
    // Both edges land the same distance from the centre, so both move inward by
    // the same amount — the artefact was all of the shortfall landing on the
    // right while the left edge stayed put.
    const left = apply(m, origin.x, origin.y).x
    const right = apply(m, origin.x + advance, origin.y).x
    expect(left).toBeCloseTo(cx - (advance / 2) * sx, 6)
    expect(right).toBeCloseTo(cx + (advance / 2) * sx, 6)
    expect(cx - left).toBeCloseTo(right - cx, 6)
    // …and, stated as the bug: the left edge is NOT pinned any more.
    expect(apply(m, origin.x, origin.y).x).toBeGreaterThan(origin.x + 1)
  })

  it('keeps the BASELINE as the vertical pivot — type scales off its baseline', () => {
    const { origin, m } = glyphGeom(withPreset('in', 'card-flip-v'), 0.5)
    expect(apply(m, origin.x, origin.y).y).toBeCloseTo(origin.y, 6)
  })

  it('applies the same centre pivot to the UNIFORM scale presets', () => {
    for (const id of ['grow-in', 'shrink-in']) {
      const { origin, advance, m, frame } = glyphGeom(withPreset('in', id), 0.5)
      const s = frame.transforms[0]!.scale
      expect(s).not.toBeCloseTo(1, 3)
      const cx = origin.x + advance / 2
      expect(apply(m, cx, origin.y).x, id).toBeCloseTo(cx, 6)
      expect(apply(m, origin.x, origin.y).y, id).toBeCloseTo(origin.y, 6)
    }
  })

  it('leaves ROTATION pivoting on the origin — the pivot translate comes after it', () => {
    const ops = spans(draw(withPreset('in', 'spin-in'), 0.5).ctx)[0]!
      .filter(o => ['translate', 'rotate', 'scale'].includes(o.op)).map(o => o.op)
    expect(ops).toEqual(['translate', 'rotate', 'translate', 'scale', 'translate', 'translate'])
  })

  it('does NOTHING when there is no scale — an unscaled glyph gains no ops', () => {
    const ops = spans(draw(withPreset('in', 'slide-up'), 0.5).ctx)[0]!
      .filter(o => ['translate', 'rotate', 'scale'].includes(o.op)).map(o => o.op)
    expect(ops).toEqual(['translate', 'translate'])
  })

  it('the SVG writer composes the IDENTICAL matrix — canvas and vector agree', () => {
    for (const id of ['card-flip-h', 'card-flip-v', 'grow-in', 'shrink-in', 'spin-in', 'slide-up']) {
      const c = withPreset('in', id)
      const { m } = glyphGeom(c, 0.5)
      const { svg } = vectorTypeSVG(font, c, 0.5, BOX)
      const attr = /transform="([^"]+)"/.exec(svg)?.[1] ?? ''
      const sm = matFromSvgTransform(attr)
      // Point-wise, at three corners of the em box — a matrix comparison that
      // cannot be satisfied by an accidental algebraic near-miss.
      for (const [px, py] of [[0, 0], [200, 100], [-50, 60]] as const) {
        expect(apply(sm, px, py).x, `${id} x`).toBeCloseTo(apply(m, px, py).x, 2)
        expect(apply(sm, px, py).y, `${id} y`).toBeCloseTo(apply(m, px, py).y, 2)
      }
    }
  })
})
