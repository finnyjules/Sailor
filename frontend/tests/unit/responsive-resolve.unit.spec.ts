import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer, paintLayerStack, type LocalLayer } from '~/composables/useCompositorLayers'
import { DEFAULT_CLONER } from '~/composables/useCloner'
import { defaultGrid } from '~/lib/frame/grid'
import { resolveLayout, layoutScaleOf } from '~/lib/frame/responsive'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const doc = (layers: FrameDoc['layers'], extra: Partial<FrameDoc> = {}): FrameDoc => ({
  responsive: true, designW: 1000, designH: 500, layers, stackOrder: layers.map(l => `l:${l.id}`),
  groups: [], grid: null, motion: null, ...extra,
})

type M = { a: number; b: number; c: number; d: number; e: number; f: number }
type Rec = { x: number; y: number; w: number; h: number; m: M }

/** A recording context that tracks the CTM and logs every roundRect with the CTM at that
 *  moment. A PRIVATE copy of the equivalence spec's harness — the two specs must not share
 *  mutable state. */
function recorder(W: number, H: number) {
  let m: M = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const stack: M[] = []
  const rects: Rec[] = []
  const ctx: any = {
    canvas: { width: W, height: H },
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    save() { stack.push({ ...m }) }, restore() { m = stack.pop() ?? m },
    translate(x: number, y: number) { m = { ...m, e: m.e + m.a * x + m.c * y, f: m.f + m.b * x + m.d * y } },
    scale(sx: number, sy: number) { m = { ...m, a: m.a * sx, b: m.b * sx, c: m.c * sy, d: m.d * sy } },
    rotate() {}, transform() {},
    setTransform(a: any, b?: number, c?: number, d?: number, e?: number, f?: number) {
      if (typeof a === 'object' && a !== null) m = { a: a.a, b: a.b, c: a.c, d: a.d, e: a.e, f: a.f }
      else if (typeof a === 'number') m = { a, b: b!, c: c!, d: d!, e: e!, f: f! }
    },
    getTransform() { return { ...m } },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, rect() {}, ellipse() {},
    clip() {}, fill() {}, stroke() {}, fillRect() {}, clearRect() {}, drawImage() {},
    setLineDash() {}, getLineDash() { return [] },
    roundRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, m: { ...m } }) },
  }
  return { ctx: ctx as CanvasRenderingContext2D, rects }
}

/** Device-space centre X of each recorded rect, in paint order. */
const paintedCentresX = (layers: LocalLayer[], W: number, H: number): number[] => {
  const { ctx, rects } = recorder(W, H)
  paintLayerStack(ctx, W, H, layers.map(l => ({ type: 'local' as const, key: `l:${l.id}`, layer: l })), layers)
  return rects.map(r => r.m.e + r.m.a * (r.x + r.w / 2))
}

describe('resolveLayout identity', () => {
  it('a fixed Frame comes back by reference', () => {
    const l = [createRectLayer()]
    const r = resolveLayout(doc(l, { responsive: false }), 3000, 500)
    expect(r.identity).toBe(true); expect(r.layers).toBe(l)
  })
  it('the design size comes back by reference', () => {
    const l = [createRectLayer(), createTextLayer()]
    const r = resolveLayout(doc(l), 1000, 500)
    expect(r.identity).toBe(true); expect(r.layers).toBe(l); expect(r.layers[0]).toBe(l[0])
  })
  it('the same shape at another size is identity too (k = 1) unless a layer keeps its size', () => {
    const l = [createRectLayer()]
    expect(resolveLayout(doc(l), 2000, 1000).identity).toBe(true)
    const keep = [createRectLayer({ pins: { keepSize: true } })]
    const r = resolveLayout(doc(keep), 2000, 1000)
    expect(r.identity).toBe(false)
    expect(layoutScaleOf(r.layers[0]!)).toBeCloseTo(0.5, 9)   // W0/W
  })
  it('a keep-size unit is never stretched, even when it spans the frame', () => {
    const bg = createRectLayer({ w: 1, pins: { keepSize: true } })   // design box 0..1000 — a 'both' span
    const r = resolveLayout(doc([bg]), 2000, 1000)
    expect(r.layers[0]!.w).toBe(1)                            // placed, not stretched
    expect(layoutScaleOf(r.layers[0]!)).toBeCloseTo(0.5, 9)
  })
})

describe('resolveLayout pins (wider box: 1000×500 design in 3000×500)', () => {
  // s = 1, spare x = 2000, guard: u = 1000, o = 500
  it('a left-hugging layer keeps its distance from the left edge (plus the guard offset)', () => {
    const l = createRectLayer({ x: 0.1, y: 0.5, w: 0.1, h: 0.1 })   // centre 100, box 50..150
    const r = resolveLayout(doc([l]), 3000, 500)
    expect(r.layers[0]!.x * 3000).toBeCloseTo(500 + 100, 6)
    expect(r.layers[0]!.y).toBeCloseTo(0.5, 9)
    expect(layoutScaleOf(r.layers[0]!)).toBeCloseTo(1000 / 3000, 9)   // s·W0/W
    // every size is a fraction of the frame WIDTH: h 0.1 ⇒ 100 design px, y 200..300
    expect(r.boxes.get(l.id)).toEqual({ x: 550, y: 200, w: 100, h: 100 })
  })
  it('a right-hugging layer keeps its distance from the right edge', () => {
    const l = createRectLayer({ x: 0.9, y: 0.5, w: 0.1, h: 0.1 })   // centre 900
    const r = resolveLayout(doc([l]), 3000, 500)
    expect(r.layers[0]!.x * 3000).toBeCloseTo(500 + 900 + 1000, 6)
  })
  it('a centred layer stays centred', () => {
    const l = createRectLayer({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 })
    const r = resolveLayout(doc([l]), 3000, 500)
    expect(r.layers[0]!.x).toBeCloseTo(0.5, 9)
  })
  it('a full-frame background stretches to the REAL box edges (bleed), ignoring the guard', () => {
    const bg = createRectLayer({ x: 0.5, y: 0.5, w: 1, h: 0.5 })
    const r = resolveLayout(doc([bg]), 3000, 500)
    expect(r.boxes.get(bg.id)).toEqual({ x: 0, y: 0, w: 3000, h: 500 })
  })
  it('an explicit relative pin slides proportionally', () => {
    const l = createRectLayer({ x: 0.25, y: 0.5, w: 0.1, h: 0.1, pins: { h: 'relative' } })
    const r = resolveLayout(doc([l]), 3000, 500)
    expect(r.layers[0]!.x * 3000).toBeCloseTo(500 + 250 + 1000 * 0.25, 6)
  })
  it('a wide boxed text stretches its box and, top-pinned, keeps its top edge', () => {
    // 10 px per char, fontSize 50 px, lineHeight 1. The text is 910 px wide, so it wraps to
    // TWO lines in the 900 px design box and to ONE in the 1900 px stretched box — which is
    // the whole point: the box height changes, so only a real top-anchor keeps the top edge.
    const t = createTextLayer({ x: 0.5, y: 0.1, boxW: 0.9, fontSize: 0.05, lineHeight: 1, text: 'a'.repeat(45) + ' ' + 'b'.repeat(45) })
    const measure = { measureText: (s: string) => ({ width: s.length * 10 }), set font(_v: string) {}, letterSpacing: '0px' } as unknown as CanvasRenderingContext2D
    const r = resolveLayout(doc([t]), 3000, 500, { measureCtx: measure })
    const out = r.layers[0]! as typeof t
    expect(out.boxW! * 3000 * layoutScaleOf(out)).toBeCloseTo(900 + 1000, 6)   // stretched by u
    // design: 2 lines → box h 100, centre 50 ⇒ top edge 0. After: 1 line → h 50, so a kept
    // top edge puts the centre at 25 (y = 0.05), NOT back at the mapped centre 50 (y = 0.1).
    expect(out.y).toBeCloseTo(0.05, 9)
    const box = r.boxes.get(t.id)!
    expect(box.y).toBeCloseTo(0, 6)
    expect(box.h).toBeCloseTo(50, 6)
  })
})

describe('resolveLayout narrower box (1000×500 design in 500×500)', () => {
  // s = 0.5, spare y = 250, guard u = 250, o = 0
  it('everything shrinks; a top layer keeps its top gap scaled, a bottom layer its bottom gap', () => {
    const top = createRectLayer({ id: 'top', x: 0.5, y: 0.15, w: 0.1, h: 0.1 })   // design box y 25..125
    const bot = createRectLayer({ id: 'bot', x: 0.5, y: 0.85, w: 0.1, h: 0.1 })   // design box y 375..475
    const r = resolveLayout(doc([top, bot]), 500, 500)
    expect(r.boxes.get('top')!.y).toBeCloseTo(12.5, 6)
    expect(r.boxes.get('bot')!.y + r.boxes.get('bot')!.h).toBeCloseTo(500 - 12.5, 6)
    expect(layoutScaleOf(r.layers[0]!)).toBeCloseTo(1, 9)   // s·W0/W = 0.5·1000/500
  })
})

describe('resolveLayout units and sections', () => {
  it('a group moves as one rigid unit by the group\'s pins', () => {
    const a = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const b = createRectLayer({ id: 'b', x: 0.3, y: 0.5, w: 0.1, h: 0.1, groupId: 'g' })
    const r = resolveLayout(doc([a, b], { groups: [{ id: 'g', pins: { h: 'right' } }] }), 3000, 500)
    const ax = r.layers[0]!.x * 3000, bx = r.layers[1]!.x * 3000
    expect(bx - ax).toBeCloseTo(200, 6)                   // arrangement kept (s = 1)
    expect(ax).toBeCloseTo(500 + 100 + 1000, 6)           // right pin
  })
  it('a layer inside a grid section holds to that section', () => {
    const grid = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0, gutter: 0 }
    // section 0 spans 0..500 at the design; layer near its right edge
    const l = createRectLayer({ x: 0.45, y: 0.5, w: 0.05, h: 0.1 })   // box 425..475
    const r = resolveLayout(doc([l], { grid }), 3000, 500)
    // box grid: 2 columns of 1500 (s = 1, spare shared); section 0 = 0..1500, spare 1000 → u 500 o 250
    // right pin inside section 0: 250 + 450 + 500 = 1200
    expect(r.layers[0]!.x * 3000).toBeCloseTo(1200, 6)
    expect(r.grid!.regions[0]).toEqual({ x: 0, y: 0, w: 1500, h: 500 })
  })
  it('a layer in a section that does not start at the origin holds to THAT section\'s edge', () => {
    const grid = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0, gutter: 0 }
    // section 1 = design 500..1000, box 1500..3000; layer box 900..950 sits inside it
    const l = createRectLayer({ x: 0.925, y: 0.5, w: 0.05, h: 0.1 })
    const r = resolveLayout(doc([l], { grid }), 3000, 500)
    // o = 1500 (section box start) + 250 (guard) − 1·500 (fitted section design start) = 1250
    // right pin: 1250 + 925 + 500 = 2675 — inside the frame, not 3175
    expect(r.layers[0]!.x * 3000).toBeCloseTo(2675, 6)
  })
  it('holdTo: frame overrides the section', () => {
    const grid = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0, gutter: 0 }
    const l = createRectLayer({ x: 0.45, y: 0.5, w: 0.05, h: 0.1, pins: { holdTo: 'frame' } })
    const r = resolveLayout(doc([l], { grid }), 3000, 500)
    expect(r.layers[0]!.x * 3000).toBeCloseTo(500 + 450, 6)   // left of the frame centre → left pin
  })
  it('a cloner\'s stamps keep their design spacing in a wider box', () => {
    const cloner = { ...DEFAULT_CLONER, enabled: true, mode: 'linear' as const, countX: 2, countY: 1, spacingX: 0.2, spacingY: 0 }
    const l = createRectLayer({ id: 'r', x: 0.2, y: 0.5, w: 0.1, h: 0.1, cloner })
    const r = resolveLayout(doc([l]), 3000, 500)
    const out = r.layers[0]! as typeof l
    expect(out.cloner!.spacingX).toBeCloseTo(0.2 * (1000 / 3000), 12)   // × k
    // …and end to end: the second stamp lands 200 box px right of the first (s = 1), not 600.
    // Sorted by x, not taken in paint order: expandClones deliberately stamps the ORIGINAL
    // last so it sits on top, so the copies arrive right-to-left here.
    const cx = paintedCentresX([out], 3000, 500).sort((a, b) => a - b)
    expect(cx).toHaveLength(2)
    expect(cx[1]! - cx[0]!).toBeCloseTo(200, 6)
  })
  it('motion tracks are remapped and non-position tracks kept', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })
    const motion = { fps: 30, duration: 1, motionx: [{ path: 'layers.a.x', type: 'number', keyframes: [{ t: 0, value: 0.1, ease: { type: 'linear' } }, { t: 1, value: 0.2, ease: { type: 'linear' } }] }] } as unknown as FrameDoc['motion']
    const r = resolveLayout(doc([l], { motion }), 3000, 500)
    expect(r.motion!.motionx![0]!.keyframes[0]!.value).toBeCloseTo((500 + 100) / 3000, 9)
  })
})
