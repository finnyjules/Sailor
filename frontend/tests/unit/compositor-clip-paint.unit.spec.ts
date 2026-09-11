// @vitest-environment happy-dom
/**
 * The living-image PAINT seam.
 *
 * `clipFrameIndex` is unit-tested on its own, and `clipFrameFor` is tested against a
 * seeded cache — but neither says the renderer actually reaches them. Between the maths
 * and the pixels sit two wires that only `paintLayer` owns: the clock it hands over
 * (`_fieldCtx.t`, set by `paintLayerStack` from its `t` argument) and the clone slot it
 * sets per copy (`_cloneSlot`, read by the image branch of `drawLayerContent`). Either
 * one silently defaulting — a lost `t`, a clone index that never moves off 0 — leaves
 * every unit test above green while the Frame paints a frozen image, or paints every
 * copy of a phased cloner on the same frame.
 *
 * So this drives the REAL `paintLayerStack` with a recording context and reads the
 * sentinel index straight off the images it was handed. The cloner loop is the real one
 * (never `clipFrameFor` called by hand), which is the whole point: it is the loop that
 * assigns the clone slot.
 *
 * The recorder below is the same stand-in `frame-cloner-tint.unit.spec.ts` uses —
 * trimmed to what an image layer touches, and with `drawImage` logging the SOURCE's
 * sentinel index instead of its geometry.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  paintLayerStack, createImageLayer, sweepClipCache,
  __setClipFramesForTest, type LocalLayer, type ImageLayer,
} from '~/composables/useCompositorLayers'
import { DEFAULT_CLONER } from '~/composables/useCloner'

const CLIP = { dir: 'sailor_clips/paint_seam', frames: 24, fps: 24, speed: 1, prompt: 'p', model: 'seedance-2.0' }

/** 24 stand-ins for decoded frames. `complete` + `naturalWidth` are what the image
 *  branch checks before drawing, so each must satisfy that or it paints the
 *  "not loaded" placeholder instead and the test would prove nothing. */
const sentinels = () => Array.from({ length: 24 }, (_, i) => ({ complete: true, naturalWidth: 1, naturalHeight: 1, i }))

/** A recording 2D context: real transform + state stack, `drawImage` keeps the frame. */
function makeCtx(width = 100, height = 100) {
  const drawn: number[] = []
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const saves: { m: typeof m; a: number; g: string }[] = []
  const ctx: any = {
    canvas: { width, height },
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    font: '', textAlign: 'start', textBaseline: 'alphabetic',
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
    save() { saves.push({ m: { ...m }, a: ctx.globalAlpha, g: ctx.globalCompositeOperation }) },
    restore() {
      const p = saves.pop()
      if (p) { m = p.m; ctx.globalAlpha = p.a; ctx.globalCompositeOperation = p.g }
    },
    translate(tx: number, ty: number) { m.e += m.a * tx + m.c * ty; m.f += m.b * tx + m.d * ty },
    scale(sx: number, sy: number) { m.a *= sx; m.b *= sx; m.c *= sy; m.d *= sy },
    rotate(r: number) {
      const cos = Math.cos(r), sin = Math.sin(r)
      const a = m.a * cos + m.c * sin, b = m.b * cos + m.d * sin
      const c = m.a * -sin + m.c * cos, d = m.b * -sin + m.d * cos
      m.a = a; m.b = b; m.c = c; m.d = d
    },
    transform() {},
    setTransform(a: any, b?: number, c?: number, d?: number, e?: number, f?: number) {
      m = typeof a === 'object' ? { a: a.a, b: a.b, c: a.c, d: a.d, e: a.e, f: a.f } : { a, b: b!, c: c!, d: d!, e: e!, f: f! }
    },
    getTransform() { return { ...m } },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, arcTo() {},
    bezierCurveTo() {}, quadraticCurveTo() {}, rect() {}, roundRect() {}, ellipse() {},
    clip() {}, clearRect() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {},
    getImageData(_x: number, _y: number, w: number, h: number) {
      return { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }
    },
    putImageData() {},
    // The one recorded op: WHICH frame the renderer chose for this copy.
    drawImage(src: any) { drawn.push(src?.i ?? -1) },
    measureText() { return { width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0 } },
    createLinearGradient() { return { addColorStop() {} } },
    createRadialGradient() { return { addColorStop() {} } },
    createConicGradient() { return { addColorStop() {} } },
    createPattern() { return null },
    setLineDash() {}, getLineDash() { return [] },
    fillText() {}, strokeText() {},
  }
  return { ctx: ctx as CanvasRenderingContext2D, drawn }
}

const livingLayer = (): ImageLayer => createImageLayer('rose.png', 1, {
  clip: { ...CLIP },
  // Two copies, phase 1 ⇒ copy 1 sits half a loop (12 of 24 frames) ahead of copy 0.
  cloner: { ...DEFAULT_CLONER, enabled: true, countX: 2, countY: 1, phase: 1 },
} as Partial<ImageLayer>)

/** Paint one stack at `t` and report the frames drawn, in the order they were drawn. */
function framesAt(t: number): number[] {
  const layer = livingLayer() as LocalLayer
  const { ctx, drawn } = makeCtx()
  paintLayerStack(ctx, 100, 100, [{ type: 'local', key: `l:${layer.id}`, layer } as any], [layer],
    undefined, t, { fps: 24, duration: 1 })
  return drawn
}

describe('living image — the paint seam', () => {
  beforeEach(() => {
    sweepClipCache([])
    __setClipFramesForTest(CLIP, sentinels())
  })

  it('draws the clock\'s frame, and each phased copy half a loop apart', () => {
    // t = 0: copy 0 on frame 0, copy 1 offset by 12. (Order is the cloner's own
    // back-to-front order — the CLAIM is the pair, not who paints first.)
    expect(framesAt(0).slice().sort((a, b) => a - b)).toEqual([0, 12])
    // t = 0.5 s at 24 fps = 12 frames on: the pair swaps places around the loop.
    expect(framesAt(0.5).slice().sort((a, b) => a - b)).toEqual([0, 12])
    // Both copies moved — a renderer that lost `t` would draw [0, 12] at BOTH times in
    // the same order. Pin the order too, so a frozen clock cannot pass.
    expect(framesAt(0)).not.toEqual(framesAt(0.5))
  })

  it('a still — no clip — draws no clip frame at all (the untouched path)', () => {
    const layer = createImageLayer('rose.png', 1) as LocalLayer
    const { ctx, drawn } = makeCtx()
    paintLayerStack(ctx, 100, 100, [{ type: 'local', key: `l:${(layer as any).id}`, layer } as any], [layer],
      undefined, 0.5, { fps: 24, duration: 1 })
    // Nothing in `_imageCache` for this filename, so the still paints its placeholder
    // rect: the point is that no SENTINEL reached drawImage.
    expect(drawn.filter(i => i >= 0)).toEqual([])
  })
})
