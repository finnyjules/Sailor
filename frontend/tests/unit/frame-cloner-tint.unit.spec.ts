/**
 * Cloner Vary — Frame rendering. Proves the three places a cloned copy is drawn
 * paint the copy's resolved tint, and — the headline requirement — that a copy
 * WITHOUT a tint still takes exactly the pre-Vary code path.
 *
 * The zero-change goldens below are not hand-written: they were captured by
 * running this file's recorder against `useCompositorLayers.ts` at the commit
 * BEFORE the tint landed. A regression that adds a scratch detour, an extra
 * canvas, or so much as a reordered state assignment to the untinted path
 * changes the log and fails here.
 *
 * Node environment on purpose: happy-dom's `<canvas>.getContext('2d')` returns
 * null, so there is no real rasterizer in this suite either way. The recorder
 * below is a faithful 2D-context stand-in (it keeps a real transform stack and
 * a real save/restore of the drawing state), which is what makes op-log
 * equality a meaningful statement about the pixels.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  tintScratch, paintLayerStack, drawWiredImageLayer, type LocalLayer,
} from '~/composables/useCompositorLayers'
import { DEFAULT_CLONER, type Cloner } from '~/composables/useCloner'

const num = (n: number) => (Object.is(n, -0) ? 0 : Math.round(n * 1e6) / 1e6)

/** A recording 2D context: real transform + state stack, every draw logged. */
function makeCtx(width = 100, height = 100) {
  const ops: string[] = []
  const canvas: { width: number; height: number } = { width, height }
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const saves: Record<string, unknown>[] = []
  const mat = () => `[${num(m.a)},${num(m.b)},${num(m.c)},${num(m.d)},${num(m.e)},${num(m.f)}]`
  const st = () => `a=${num(ctx.globalAlpha)} op=${ctx.globalCompositeOperation} fill=${String(ctx.fillStyle)} filter=${ctx.filter}`
    + ` shadow=${ctx.shadowColor}/${num(ctx.shadowBlur)}/${num(ctx.shadowOffsetX)},${num(ctx.shadowOffsetY)}`
  const ctx: any = {
    canvas,
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    font: '', textAlign: 'start', textBaseline: 'alphabetic',
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
    save() {
      saves.push({
        m: { ...m }, a: ctx.globalAlpha, g: ctx.globalCompositeOperation, f: ctx.fillStyle,
        fi: ctx.filter, sc: ctx.shadowColor, sb: ctx.shadowBlur, sx: ctx.shadowOffsetX, sy: ctx.shadowOffsetY,
      })
      ops.push('save')
    },
    restore() {
      const p = saves.pop() as any
      if (p) {
        m = p.m; ctx.globalAlpha = p.a; ctx.globalCompositeOperation = p.g; ctx.fillStyle = p.f
        ctx.filter = p.fi; ctx.shadowColor = p.sc; ctx.shadowBlur = p.sb
        ctx.shadowOffsetX = p.sx; ctx.shadowOffsetY = p.sy
      }
      ops.push('restore')
    },
    translate(tx: number, ty: number) { m.e += m.a * tx + m.c * ty; m.f += m.b * tx + m.d * ty; ops.push(`translate ${num(tx)},${num(ty)}`) },
    scale(sx: number, sy: number) { m.a *= sx; m.b *= sx; m.c *= sy; m.d *= sy; ops.push(`scale ${num(sx)},${num(sy)}`) },
    rotate(r: number) {
      const cos = Math.cos(r), sin = Math.sin(r)
      const a = m.a * cos + m.c * sin, b = m.b * cos + m.d * sin
      const c = m.a * -sin + m.c * cos, d = m.b * -sin + m.d * cos
      m.a = a; m.b = b; m.c = c; m.d = d
      ops.push(`rotate ${num(r)}`)
    },
    transform() { ops.push('transform') },
    setTransform(a: any, b?: number, c?: number, d?: number, e?: number, f?: number) {
      m = typeof a === 'object' ? { a: a.a, b: a.b, c: a.c, d: a.d, e: a.e, f: a.f } : { a, b: b!, c: c!, d: d!, e: e!, f: f! }
      ops.push(`setTransform ${mat()}`)
    },
    getTransform() { return { ...m } },
    beginPath() { ops.push('beginPath') },
    closePath() { ops.push('closePath') },
    moveTo() {}, lineTo() {}, arc() {}, bezierCurveTo() {}, quadraticCurveTo() {},
    rect(x: number, y: number, w: number, h: number) { ops.push(`rect ${num(x)},${num(y)},${num(w)},${num(h)}`) },
    roundRect(x: number, y: number, w: number, h: number) { ops.push(`roundRect ${num(x)},${num(y)},${num(w)},${num(h)}`) },
    ellipse() { ops.push('ellipse') },
    clip() { ops.push('clip') },
    fill() { ops.push(`fill ${mat()} ${st()}`) },
    stroke() { ops.push(`stroke ${mat()} ${st()}`) },
    fillRect(x: number, y: number, w: number, h: number) { ops.push(`fillRect ${num(x)},${num(y)},${num(w)},${num(h)} ${mat()} ${st()}`) },
    clearRect() {},
    drawImage(_src: unknown, ...a: number[]) { ops.push(`drawImage ${a.map(num).join(',')} ${mat()} ${st()}`) },
    measureText() { return { width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0 } },
    createLinearGradient() { return { addColorStop() {} } },
    createRadialGradient() { return { addColorStop() {} } },
    createConicGradient() { return { addColorStop() {} } },
    createPattern() { return null },
    setLineDash() {}, getLineDash() { return [] },
    fillText() {}, strokeText() {},
  }
  return { ctx: ctx as CanvasRenderingContext2D, ops, canvas }
}

/** A `document` whose canvases are recorders, so every offscreen is observable
 *  AND countable — "allocated no canvas" is `made.length === 0`. */
function installDoc() {
  const made: { canvas: any; ops: string[] }[] = []
  ;(globalThis as any).document = {
    createElement(tag: string) {
      const rec = makeCtx(1, 1)
      const canvas: any = {
        tagName: tag, width: 1, height: 1,
        getContext: () => { (rec.ctx as any).canvas = canvas; return rec.ctx },
      }
      made.push({ canvas, ops: rec.ops })
      return canvas
    },
  }
  return made
}

const CLONER: Cloner = {
  ...DEFAULT_CLONER,
  enabled: true, mode: 'linear', countX: 3, countY: 1, spacingX: 0.2,
  stepOpacity: 0.9, stepScale: 0.95, stepRotation: 7,
}

/** Colour variation on: sequence + cycle over three primaries, so the copies
 *  are drawn (back to front, original last) blue, green, red. */
const TINTED: Cloner = {
  ...CLONER,
  varyColor: true,
  varyPalette: ['#ff0000', '#00ff00', '#0000ff'],
  varyColorSpread: 'cycle',
  varyColorStrength: 1,
}

const rect = (cloner: Cloner = CLONER, extra: Record<string, unknown> = {}): LocalLayer => ({
  id: 'r1', kind: 'rect', name: 'Rect', visible: true,
  x: 0.5, y: 0.5, rotation: 0, opacity: 0.8, blend: 'multiply',
  w: 0.2, h: 0.1, radius: 0, fill: '#112233', stroke: '', strokeWidth: 0,
  cloner, ...extra,
} as unknown as LocalLayer)

const SHADOW = { type: 'drop_shadow', visible: true, color: '#000000', blur: 0.02, x: 0.01, y: 0.01 }

const paint = (layer: LocalLayer, ctx: CanvasRenderingContext2D) =>
  paintLayerStack(ctx, 100, 100, [{ type: 'local', key: `l:${(layer as any).id}`, layer } as any], [layer])

const wired = (cloner: Cloner) => ({
  x: 0.1, y: -0.05, scale: 1.2, rotation: 10, opacity: 0.7, blend: 'multiply', cloner,
})

// ── Zero-change goldens, captured at the commit before the tint landed ────────

const GOLDEN_FAST = [
  'save',
  'translate 90,50',
  'rotate 0.244346',
  'scale 0.9025,0.9025',
  'beginPath',
  'roundRect -10,-5,20,10',
  'fill [0.875692,0.218335,-0.218335,0.875692,90,50] a=0.648 op=multiply fill=#112233 filter=none shadow=transparent/0/0,0',
  'restore',
  'save',
  'translate 70,50',
  'rotate 0.122173',
  'scale 0.95,0.95',
  'beginPath',
  'roundRect -10,-5,20,10',
  'fill [0.942919,0.115776,-0.115776,0.942919,70,50] a=0.72 op=multiply fill=#112233 filter=none shadow=transparent/0/0,0',
  'restore',
  'save',
  'translate 50,50',
  'beginPath',
  'roundRect -10,-5,20,10',
  'fill [1,0,0,1,50,50] a=0.8 op=multiply fill=#112233 filter=none shadow=transparent/0/0,0',
  'restore',
]

const GOLDEN_EFFECTED_MAIN = [
  'save',
  'setTransform [1,0,0,1,0,0]',
  'drawImage 0,0 [1,0,0,1,0,0] a=0.648 op=multiply fill=#000 filter=none shadow=#000000/2/1,1',
  'restore',
  'save',
  'setTransform [1,0,0,1,0,0]',
  'drawImage 0,0 [1,0,0,1,0,0] a=0.72 op=multiply fill=#000 filter=none shadow=#000000/2/1,1',
  'restore',
  'save',
  'setTransform [1,0,0,1,0,0]',
  'drawImage 0,0 [1,0,0,1,0,0] a=0.8 op=multiply fill=#000 filter=none shadow=#000000/2/1,1',
  'restore',
]

const GOLDEN_EFFECTED_OFFSCREENS = [
  [
    'setTransform [1,0,0,1,0,0]',
    'translate 90,50',
    'rotate 0.244346',
    'scale 0.9025,0.9025',
    'beginPath',
    'roundRect -10,-5,20,10',
    'fill [0.875692,0.218335,-0.218335,0.875692,90,50] a=1 op=source-over fill=#112233 filter=none shadow=transparent/0/0,0',
  ],
  [
    'setTransform [1,0,0,1,0,0]',
    'translate 70,50',
    'rotate 0.122173',
    'scale 0.95,0.95',
    'beginPath',
    'roundRect -10,-5,20,10',
    'fill [0.942919,0.115776,-0.115776,0.942919,70,50] a=1 op=source-over fill=#112233 filter=none shadow=transparent/0/0,0',
  ],
  [
    'setTransform [1,0,0,1,0,0]',
    'translate 50,50',
    'beginPath',
    'roundRect -10,-5,20,10',
    'fill [1,0,0,1,50,50] a=1 op=source-over fill=#112233 filter=none shadow=transparent/0/0,0',
  ],
]

const GOLDEN_WIRED = [
  'save',
  'translate 100,45',
  'rotate 0.418879',
  'scale 1.083,1.083',
  'drawImage -50,-25,100,50 [0.98937,0.440496,-0.440496,0.98937,100,45] a=0.567 op=multiply fill=#000 filter=none shadow=transparent/0/0,0',
  'restore',
  'save',
  'translate 80,45',
  'rotate 0.296706',
  'scale 1.14,1.14',
  'drawImage -50,-25,100,50 [1.090187,0.333304,-0.333304,1.090187,80,45] a=0.63 op=multiply fill=#000 filter=none shadow=transparent/0/0,0',
  'restore',
  'save',
  'translate 60,45',
  'rotate 0.174533',
  'scale 1.2,1.2',
  'drawImage -50,-25,100,50 [1.181769,0.208378,-0.208378,1.181769,60,45] a=0.7 op=multiply fill=#000 filter=none shadow=transparent/0/0,0',
  'restore',
]

afterEach(() => { delete (globalThis as any).document })

describe('tintScratch', () => {
  it('washes the whole scratch in DEVICE space, confined to existing ink', () => {
    const { ctx, ops } = makeCtx(64, 48)
    ctx.translate(5, 7)          // a caller transform it must ignore
    ops.length = 0
    tintScratch(ctx, '#ff0000', 1)
    expect(ops).toEqual([
      'save',
      'setTransform [1,0,0,1,0,0]',
      'fillRect 0,0,64,48 [1,0,0,1,0,0] a=1 op=source-atop fill=#ff0000 filter=none shadow=transparent/0/0,0',
      'restore',
    ])
  })

  it('is a no-op at strength 0 — not even a save', () => {
    const { ctx, ops } = makeCtx()
    tintScratch(ctx, '#ff0000', 0)
    expect(ops).toEqual([])
  })

  it('is a no-op at a negative or NaN strength', () => {
    const { ctx, ops } = makeCtx()
    tintScratch(ctx, '#ff0000', -0.5)
    tintScratch(ctx, '#ff0000', Number.NaN)
    expect(ops).toEqual([])
  })

  it('clamps strength above 1 to a full wash', () => {
    const { ctx, ops } = makeCtx(4, 4)
    tintScratch(ctx, '#ff0000', 5)
    expect(ops[2]).toContain('a=1 op=source-atop fill=#ff0000')
  })

  it('restores the transform, composite mode and alpha it found', () => {
    const { ctx } = makeCtx()
    ctx.translate(2, 3)
    ctx.globalAlpha = 0.4
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = '#123456'
    const before = ctx.getTransform()
    tintScratch(ctx, '#ff0000', 1)
    const after = ctx.getTransform()
    expect([after.a, after.d, after.e, after.f]).toEqual([before.a, before.d, before.e, before.f])
    expect(ctx.globalCompositeOperation).toBe('multiply')
    expect(ctx.globalAlpha).toBe(0.4)
    expect(ctx.fillStyle).toBe('#123456')
  })
})

describe('zero-change: a copy with no tint draws exactly as it did before Vary', () => {
  it('fast path: the pre-Vary op log, and no canvas allocated at all', () => {
    const made = installDoc()
    const { ctx, ops } = makeCtx()
    paint(rect(), ctx)
    expect(ops).toEqual(GOLDEN_FAST)
    expect(made).toHaveLength(0)
  })

  it('fast path: a tint at strength 0 is still the untinted path (no scratch detour)', () => {
    const made = installDoc()
    const { ctx, ops } = makeCtx()
    paint(rect({ ...TINTED, varyColorStrength: 0 }), ctx)
    expect(ops).toEqual(GOLDEN_FAST)
    expect(made).toHaveLength(0)
  })

  it('fast path: a layer with no cloner at all still draws inline, once', () => {
    const made = installDoc()
    const { ctx, ops } = makeCtx()
    paint(rect({ ...DEFAULT_CLONER }), ctx)
    // A disabled cloner is one identity copy — the last (k=0) entry of the golden.
    expect(ops).toEqual(GOLDEN_FAST.slice(-6))
    expect(made).toHaveLength(0)
  })

  it('effected path: the pre-Vary op log on the shared ctx AND on each offscreen', () => {
    const made = installDoc()
    const { ctx, ops } = makeCtx()
    paint(rect(CLONER, { effects: [SHADOW] }), ctx)
    expect(ops).toEqual(GOLDEN_EFFECTED_MAIN)
    expect(made.map(c => c.ops)).toEqual(GOLDEN_EFFECTED_OFFSCREENS)
  })

  it('wired image path: the pre-Vary op log, and no canvas allocated at all', () => {
    const made = installDoc()
    const { ctx, ops } = makeCtx()
    const img = { width: 200, height: 100 } as unknown as HTMLCanvasElement
    drawWiredImageLayer(ctx, img, wired(CLONER) as any, 100, 100)
    expect(ops).toEqual(GOLDEN_WIRED)
    expect(made).toHaveLength(0)
  })
})

describe('fast path: a tinted copy detours through a scratch canvas', () => {
  it('tints each copy on its own scratch and never washes the shared ctx', () => {
    const made = installDoc()
    const { ctx, ops } = makeCtx()
    paint(rect(TINTED), ctx)

    // One scratch per copy — and nothing else allocated.
    expect(made).toHaveLength(3)
    // Back-to-front, original last: cycle walks the palette by step index k=2,1,0.
    expect(made.map(c => c.ops.find(o => o.startsWith('fillRect'))))
      .toEqual([
        expect.stringContaining('op=source-atop fill=#0000ff'),
        expect.stringContaining('op=source-atop fill=#00ff00'),
        expect.stringContaining('op=source-atop fill=#ff0000'),
      ])

    // The wash happens AFTER the copy's own content is drawn on that scratch.
    for (const c of made) {
      const drew = c.ops.findIndex(o => o.startsWith('fill ['))
      const washed = c.ops.findIndex(o => o.startsWith('fillRect'))
      expect(drew).toBeGreaterThanOrEqual(0)
      expect(washed).toBeGreaterThan(drew)
    }

    // The shared ctx never sees source-atop; it only stamps, carrying the copy's
    // own opacity and the layer's blend — same alphas the untinted golden used.
    expect(ops.some(o => o.includes('source-atop'))).toBe(false)
    expect(ops.filter(o => o.startsWith('drawImage'))).toEqual([
      expect.stringContaining('a=0.648 op=multiply'),
      expect.stringContaining('a=0.72 op=multiply'),
      expect.stringContaining('a=0.8 op=multiply'),
    ])
  })

  it('draws the copy onto the scratch at exactly the geometry the inline draw used', () => {
    const made = installDoc()
    const { ctx } = makeCtx()
    paint(rect(TINTED), ctx)
    // Everything before the wash is the copy's own content, at the copy's own
    // transform — byte-for-byte the sequence the offscreen path already produced
    // for these same three copies (see GOLDEN_EFFECTED_OFFSCREENS), which was
    // itself captured before Vary existed.
    const content = made.map(c => c.ops.slice(0, c.ops.findIndex(o => o === 'save')))
    expect(content).toEqual(GOLDEN_EFFECTED_OFFSCREENS)
    // …and the wash covers the whole device-sized scratch.
    for (const c of made) expect(c.ops.some(o => o.startsWith('fillRect 0,0,100,100'))).toBe(true)
  })
})

describe('effected path: the tint lands before the effect chain', () => {
  it('washes the copy offscreen after the content and before the stamp', () => {
    const made = installDoc()
    const { ctx, ops } = makeCtx()
    paint(rect(TINTED, { effects: [SHADOW] }), ctx)

    expect(made).toHaveLength(3)
    for (const c of made) {
      const drew = c.ops.findIndex(o => o.startsWith('fill ['))
      const washed = c.ops.findIndex(o => o.includes('op=source-atop'))
      expect(washed).toBeGreaterThan(drew)
    }
    expect(made.map(c => c.ops.find(o => o.includes('source-atop'))))
      .toEqual([
        expect.stringContaining('fill=#0000ff'),
        expect.stringContaining('fill=#00ff00'),
        expect.stringContaining('fill=#ff0000'),
      ])

    // The stamp — where the drop shadow is applied — is untouched, so the shadow
    // is cast by the TINTED pixels, at the same alpha/blend as before.
    expect(ops).toEqual(GOLDEN_EFFECTED_MAIN)
  })
})

describe('wired image path: a tinted copy is stamped from a tinted scratch', () => {
  it('tints a per-copy scratch at the source resolution and draws that', () => {
    const made = installDoc()
    const { ctx, ops } = makeCtx()
    const img = { width: 200, height: 100 } as unknown as HTMLCanvasElement
    drawWiredImageLayer(ctx, img, wired(TINTED) as any, 100, 100)

    expect(made).toHaveLength(3)
    for (const c of made) expect(c.canvas.width).toBe(200)
    for (const c of made) expect(c.canvas.height).toBe(100)
    expect(made.map(c => c.ops.find(o => o.includes('source-atop'))))
      .toEqual([
        expect.stringContaining('fill=#0000ff'),
        expect.stringContaining('fill=#00ff00'),
        expect.stringContaining('fill=#ff0000'),
      ])
    // The source is copied in before the wash, or `source-atop` would find no ink.
    for (const c of made) {
      expect(c.ops.findIndex(o => o.includes('source-atop')))
        .toBeGreaterThan(c.ops.findIndex(o => o.startsWith('drawImage')))
    }
    // Geometry, opacity and blend of each stamp are the untinted golden's.
    expect(ops).toEqual(GOLDEN_WIRED)
  })
})
