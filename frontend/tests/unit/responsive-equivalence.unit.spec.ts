import { describe, it, expect } from 'vitest'
import { createRectLayer, paintLayerStack, type LocalLayer } from '~/composables/useCompositorLayers'
import { resolveLayout } from '~/lib/frame/responsive'
import type { FrameDoc, PinH, PinV, StackKey } from '~/lib/frame/responsive/types'

type M = { a: number; b: number; c: number; d: number; e: number; f: number }
type Rec = { x: number; y: number; w: number; h: number; m: M }
type Box = { x: number; y: number; w: number; h: number }

/** A recording context that tracks the CTM and logs every roundRect with the CTM at that
 *  moment. A private copy of Task 9's harness on purpose: the two specs must not share
 *  mutable state. The one addition is the six-number `setTransform(a,b,c,d,e,f)` form —
 *  the painter calls `ctx.setTransform(1, 0, 0, 1, 0, 0)` before a stamp, and swallowing
 *  that call would leave a stale CTM on every rect recorded afterwards. */
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

/** Device-space box of a recorded rect: apply its CTM to the local rect. */
const deviceBox = (r: Rec): Box => {
  const { a, d, e, f } = r.m
  return { x: e + a * r.x, y: f + d * r.y, w: a * r.w, h: d * r.h }
}

const W0 = 1000, H0 = 500
// Three plain rects, none of them spanning enough to read as a stretch. Every size is a
// fraction of frame WIDTH (the painter width-normalizes h too), so `h: 0.1` is 100 px here.
const design: LocalLayer[] = [
  createRectLayer({ id: 'a', x: 0.15, y: 0.2, w: 0.2, h: 0.1 }),
  createRectLayer({ id: 'b', x: 0.5, y: 0.5, w: 0.3, h: 0.3 }),
  createRectLayer({ id: 'c', x: 0.85, y: 0.85, w: 0.1, h: 0.1 }),
]

const doc = (layers: LocalLayer[]): FrameDoc => ({
  responsive: true, designW: W0, designH: H0, layers,
  stackOrder: layers.map(l => `l:${l.id}`) as StackKey[],
  groups: [], grid: null, motion: null,
})

const paintAll = (layers: LocalLayer[], W: number, H: number): Box[] => {
  const { ctx, rects } = recorder(W, H)
  paintLayerStack(ctx, W, H, layers.map(l => ({ type: 'local' as const, key: `l:${l.id}`, layer: l })), layers)
  return rects.map(deviceBox)
}

/** The design painted at scale s and offset (ox, oy) — the export's fit-and-bleed transform. */
const fitted = (s: number, ox: number, oy: number): Box[] =>
  paintAll(design, W0, H0).map(r => ({ x: ox + s * r.x, y: oy + s * r.y, w: s * r.w, h: s * r.h }))

const near = (a: Box[], b: Box[]) => {
  expect(a.length).toBe(b.length)
  expect(a.length).toBeGreaterThan(0)
  a.forEach((r, i) => { for (const key of ['x', 'y', 'w', 'h'] as const) expect(r[key]).toBeCloseTo(b[i]![key], 6) })
}

describe('equivalence with fit-and-bleed and with top-left', () => {
  const pinned = (h: PinH, v: PinV): LocalLayer[] => design.map(l => ({ ...l, pins: { h, v } }))

  it('every layer Center/Middle == the design fitted and centred (wider box)', () => {
    const W = 3000, H = 500   // fit s = min(3, 1) = 1; spare x 2000 → u 1000, o 500 → p + 1000
    const r = resolveLayout(doc(pinned('center', 'middle')), W, H)
    near(paintAll(r.layers, W, H), fitted(1, (W - W0) / 2, 0))
  })

  it('every layer Center/Middle == the design fitted and centred (taller box)', () => {
    const W = 1000, H = 2000  // s = 1, spare y 1500 → guard u 500, o 500 → p + 750 = (H − H0) / 2
    const r = resolveLayout(doc(pinned('center', 'middle')), W, H)
    near(paintAll(r.layers, W, H), fitted(1, 0, (H - H0) / 2))
  })

  it('every layer Center/Middle == fitted and centred when the box is smaller', () => {
    const W = 500, H = 500    // s = 0.5, spare y 250 → u 250, o 0 → 0.5·p + 125
    const r = resolveLayout(doc(pinned('center', 'middle')), W, H)
    near(paintAll(r.layers, W, H), fitted(0.5, 0, 125))
  })

  it('every layer Left/Top == the design fitted at the top-left (within the guard)', () => {
    const W = 1800, H = 500   // s = 1, spare x 800 ≤ 1000 → u 800, o 0 → p
    const r = resolveLayout(doc(pinned('left', 'top')), W, H)
    near(paintAll(r.layers, W, H), fitted(1, 0, 0))
  })

  it('every layer Left/Top beyond the guard sits at the guard offset', () => {
    const W = 4000, H = 500   // spare x 3000 → u 1000, o 1000 → p + 1000
    const r = resolveLayout(doc(pinned('left', 'top')), W, H)
    near(paintAll(r.layers, W, H), fitted(1, 1000, 0))
  })
})
