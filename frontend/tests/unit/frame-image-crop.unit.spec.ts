// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest'
import {
  coverSourceRect, paintLayerStack, createImageLayer, __setImageForTest, __clearImageCacheForTest,
  type LocalLayer,
} from '~/composables/useCompositorLayers'

describe('coverSourceRect', () => {
  it('crops the sides of a wide source into a square box, centred', () => {
    expect(coverSourceRect(200, 100, 50, 50)).toEqual({ sx: 50, sy: 0, sw: 100, sh: 100 })
  })
  it('crops top and bottom of a tall source into a wide box, honouring focus', () => {
    const r = coverSourceRect(100, 400, 100, 50, 0.5, 0)
    expect(r).toEqual({ sx: 0, sy: 0, sw: 100, sh: 50 })
  })
  it('same aspect is the whole source', () => {
    expect(coverSourceRect(400, 500, 80, 100)).toEqual({ sx: 0, sy: 0, sw: 400, sh: 500 })
  })
})

/** A recording 2D context: real transform + state stack, `drawImage` keeps the args. */
function makeCtx(width = 100, height = 100) {
  const drawn: unknown[][] = []
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
    drawImage(...args: unknown[]) { drawn.push(args) },
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

describe('image layer paint — crop to cover', () => {
  beforeEach(() => {
    __clearImageCacheForTest()
  })

  it('without crop, drawImage is called with the plain 5-argument form (unchanged)', () => {
    __setImageForTest('rose.png', { complete: true, naturalWidth: 200, naturalHeight: 100 } as any)
    const layer = createImageLayer('rose.png', 2, { w: 0.5, h: 0.5 }) as LocalLayer
    const { ctx, drawn } = makeCtx()
    paintLayerStack(ctx, 100, 100, [{ type: 'local', key: `l:${(layer as any).id}`, layer } as any], [layer],
      undefined, 0, { fps: 24, duration: 1 })
    expect(drawn.length).toBe(1)
    expect(drawn[0].length).toBe(5)
  })

  it('with crop: cover, drawImage is called with the 9-argument form and the coverSourceRect source rect', () => {
    __setImageForTest('rose.png', { complete: true, naturalWidth: 200, naturalHeight: 100 } as any)
    const layer = createImageLayer('rose.png', 2, {
      w: 0.5, h: 0.5, crop: { fit: 'cover' },
    } as any) as LocalLayer
    const { ctx, drawn } = makeCtx()
    paintLayerStack(ctx, 100, 100, [{ type: 'local', key: `l:${(layer as any).id}`, layer } as any], [layer],
      undefined, 0, { fps: 24, duration: 1 })
    expect(drawn.length).toBe(1)
    expect(drawn[0].length).toBe(9)
    const w = (layer as any).w * 100, h = (layer as any).h * 100
    const expected = coverSourceRect(200, 100, w, h)
    // args: [img, sx, sy, sw, sh, dx, dy, dw, dh]
    expect(drawn[0].slice(1, 5)).toEqual([expected.sx, expected.sy, expected.sw, expected.sh])
    expect(drawn[0].slice(5, 9)).toEqual([-w / 2, -h / 2, w, h])
  })
})
