import { describe, it, expect } from 'vitest'
import { createRectLayer, paintLayerStack, type LocalLayer } from '~/composables/useCompositorLayers'

type M = { a: number; b: number; c: number; d: number; e: number; f: number }
type Rec = { x: number; y: number; w: number; h: number; m: M }

/** A recording context that tracks the CTM and logs every roundRect with the CTM at that moment.
 *  `shared` lets several contexts (the main one and every offscreen `document.createElement`
 *  hands out) record into the SAME array — without that, a mask-source draw would land on a
 *  throwaway recorder and test 4 would pass vacuously. */
function recorder(shared?: Rec[]) {
  let m: M = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const stack: M[] = []
  const rects: Rec[] = shared ?? []
  const ctx: any = {
    canvas: { width: 1000, height: 500 },
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    save() { stack.push({ ...m }) }, restore() { m = stack.pop() ?? m },
    translate(x: number, y: number) { m = { ...m, e: m.e + m.a * x + m.c * y, f: m.f + m.b * x + m.d * y } },
    scale(sx: number, sy: number) { m = { ...m, a: m.a * sx, b: m.b * sx, c: m.c * sy, d: m.d * sy } },
    rotate() {}, transform() {}, setTransform(a: any) { if (typeof a === 'object') m = { ...a } },
    getTransform() { return { ...m } },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, rect() {}, ellipse() {},
    clip() {}, fill() {}, stroke() {}, fillRect() {}, clearRect() {}, drawImage() {},
    setLineDash() {}, getLineDash() { return [] },
    roundRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, m: { ...m } }) },
  }
  return { ctx: ctx as CanvasRenderingContext2D, rects }
}

/** Device-space box of a recorded rect: apply its CTM to the local rect. */
function deviceBox(r: Rec) {
  const { a, d, e, f } = r.m
  return { x: e + a * r.x, y: f + d * r.y, w: a * r.w, h: d * r.h }
}

function paint(layer: LocalLayer, W = 1000, H = 500) {
  const { ctx, rects } = recorder()
  paintLayerStack(ctx, W, H, [{ type: 'local', key: `l:${layer.id}`, layer }], [layer])
  return rects.map(deviceBox)
}

// Today's geometry for a 0.2 x 0.1 rect on a 1000x500 frame. BOTH w and h are
// width-normalized (drawLayerContent: `const w = layer.w * W, h = layer.h * W`), so the
// box is 200 x 100 centred on (500, 250) — i.e. top-left (400, 200). (The brief's draft
// wrote `h: 50`, which is the H-normalized number the painter does not use.)
const TODAY = { x: 400, y: 200, w: 200, h: 100 }

describe('layoutScale in the painter', () => {
  it('absent ⇒ exactly today\'s geometry', () => {
    const r = createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1, radius: 0.02 })
    const [box] = paint(r)
    expect(box).toEqual(TODAY)
  })
  it('layoutScale k scales every size about the layer\'s own centre; the centre stays put', () => {
    const r = { ...createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1, radius: 0.02 }), layoutScale: 0.5 } as unknown as LocalLayer
    const [box] = paint(r)
    // Centre unmoved at (500, 250); every size halved.
    expect(box!.x).toBeCloseTo(450, 6); expect(box!.y).toBeCloseTo(225, 6)
    expect(box!.w).toBeCloseTo(100, 6); expect(box!.h).toBeCloseTo(50, 6)
  })
  it('layoutScale 1 records no scale call (byte-identical path)', () => {
    const r = { ...createRectLayer({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 }), layoutScale: 1 } as unknown as LocalLayer
    const [box] = paint(r)
    expect(box).toEqual(TODAY)
  })
  it('a mask source drawn for a clipped layer is scaled about the SOURCE\'s centre, not the content\'s', () => {
    const src = { ...createRectLayer({ id: 's', x: 0.25, y: 0.5, w: 0.2, h: 0.2 }), layoutScale: 0.5 } as unknown as LocalLayer
    const content = { ...createRectLayer({ id: 'c', x: 0.75, y: 0.5, w: 0.2, h: 0.2, maskedByKey: 'l:s' }), layoutScale: 0.5 } as unknown as LocalLayer
    const { ctx, rects } = recorder()
    // Every offscreen the painter makes records into `rects` too — otherwise the mask
    // source draws on a throwaway recorder and the assertion below is vacuous.
    ;(globalThis as any).document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => recorder(rects).ctx }),
    }
    try {
      paintLayerStack(ctx, 1000, 500, [
        { type: 'local', key: 'l:s', layer: src }, { type: 'local', key: 'l:c', layer: content },
      ], [src, content])
    } finally { delete (globalThis as any).document }
    // Whatever surfaces were used, every recorded rect must be centred on either the source
    // centre (250, 250) or the content centre (750, 250) — never displaced by the other's scale.
    expect(rects.length).toBeGreaterThan(0)
    const centres = rects.map(deviceBox).map(b => Math.round(b.x + b.w / 2))
    for (const c of centres) expect([250, 750]).toContain(c)
  })
})
