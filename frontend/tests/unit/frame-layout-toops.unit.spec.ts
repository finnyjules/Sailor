import { describe, it, expect } from 'vitest'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { boxOf } from '~/lib/frame/patterns/kit/check'
import { elementsToOps } from '~/lib/frame/patterns/kit/toOps'
import { applyPlacement } from '~/lib/frame/patterns/apply'
import { __drawTextForTest } from '~/composables/useCompositorLayers'
import type { El, TextEl } from '~/lib/frame/patterns/kit/types'
import type { FrameElements } from '~/lib/frame/patterns/types'
import { mergeOwned } from '~/lib/frame/patterns/kit/owned'
import { nextOrderFor } from '~/lib/frame/patterns/order'
import { localStackKey } from '~/lib/compositor/frameStack'
import { paintToVectorPaint } from '~/lib/paint/toVector'

// Layout elements → layer ops. Kit units are percent of frame width; Sailor layers take x/100,
// y/S.H and sizes/100. The stub measure: 0.55 em per character, cap metrics 0.35 / 0.35.

const measure = makeStubMeasure()
const frame = { w: 1000, h: 1250 }
const S = makeSheet({ frameW: frame.w, frameH: frame.h, measure })
const targets = { title: 't', details: 'd', date: 'dt', caption: 'c', image: 'img' }

const disp = (s: string, o: Partial<TextEl>): TextEl =>
  ({ k: 't', s, x: 10, size: 10, wt: 600, ls: -0.05, lh: 0.9, role: 'title', pre: true, ...o } as TextEl)

/** Width in kit units of a line at `size` in the stub measure. */
const lw = (s: string, size: number, ls: number) => measure.w100(s, 'title', ls) * size / 100

describe('elementsToOps — display text', () => {
  it('(a) a two-element title becomes ONE op whose runs union is centred on the op origin', () => {
    const els: El[] = [
      disp('BIG', { x: 8, top: 10, size: 20 }),
      disp('small\nwords', { role: 'title1', x: 12, top: 40, size: 10, align: 'right', w: 50 }),
    ]
    const { ops, owned } = elementsToOps(els, S, targets, frame)
    expect(owned).toEqual([])
    expect(ops).toHaveLength(1)
    const op = ops[0]!
    expect(op.target).toBe('t')
    expect(op.kind).toBe('text')
    expect(op.fontSize).toBeCloseTo(0.2)
    expect(op.lineHeight).toBe(0.9)
    expect(op.letterSpacing).toBe(-0.05)
    const runs = op.runs!
    expect(runs.map(r => r.text)).toEqual(['BIG', 'small', 'words'])
    expect(runs[0]!.s).toBeUndefined()
    expect(runs[1]!.s).toBeCloseTo(0.5)
    // Union of run boxes in em of the layer's font size: centred on (0, 0) (Ruling R2).
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const r of runs) {
      const s = r.s ?? 1
      const w = measure.w100(r.text, 'title', -0.05) * s / 100
      x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x + w)
      y0 = Math.min(y0, r.y - s / 2); y1 = Math.max(y1, r.y + s / 2)
    }
    expect(x0 + x1).toBeCloseTo(0, 9)
    expect(y0 + y1).toBeCloseTo(0, 9)
    // The first run's cap top (kit units) sits at `top`: mid = top + capAbove·size.
    const fs = 20
    const oy = op.y * S.H
    expect(oy + runs[0]!.y * fs).toBeCloseTo(10 + 0.35 * 20, 9)
    // Right-aligned second element: its lines end at x + w.
    const ox = op.x * 100
    expect(ox + runs[1]!.x * fs + lw('small', 10, -0.05)).toBeCloseTo(62, 9)
    expect(ox + runs[2]!.x * fs + lw('words', 10, -0.05)).toBeCloseTo(62, 9)
    // Line 2 of the second element is one line (lh·size) below line 1.
    expect((runs[2]!.y - runs[1]!.y) * fs).toBeCloseTo(0.9 * 10, 9)
  })

  it('a centred display element agrees with the checker\'s box horizontally (Ruling R6)', () => {
    const e = disp('HELLO', { x: 10, w: 80, top: 20, size: 12, align: 'center' })
    const { ops } = elementsToOps([e], S, targets, frame)
    const op = ops[0]!
    const r = op.runs![0]!
    const left = op.x * 100 + r.x * 12
    const right = left + lw('HELLO', 12, -0.05)
    const b = boxOf(e, S)!
    expect(left).toBeCloseTo(b.x0, 9)
    expect(right).toBeCloseTo(b.x1, 9)
    // …and vertically, cap top of the line = the checker's y0.
    expect(op.y * S.H + r.y * 12 - 0.35 * 12).toBeCloseTo(b.y0, 9)
  })

  it('grouped title lines are measured with the first element\'s letter spacing (what the layer draws with)', () => {
    const els: El[] = [
      disp('AAAA', { x: 10, top: 10, size: 10, ls: -0.05 }),
      disp('BBBB', { role: 'title1', x: 10, w: 60, top: 30, size: 10, ls: 0.2, align: 'right' }),
    ]
    const op = elementsToOps(els, S, targets, frame).ops[0]!
    const r = op.runs![1]!
    expect(op.x * 100 + r.x * 10 + lw('BBBB', 10, -0.05)).toBeCloseTo(70, 9)
  })

  it('a base-anchored display element puts its last baseline on `base`', () => {
    const e = disp('ONE\nTWO', { x: 10, base: 90, size: 10 })
    const op = elementsToOps([e], S, targets, frame).ops[0]!
    const last = op.runs![1]!
    expect(op.y * S.H + last.y * 10 + 0.35 * 10).toBeCloseTo(90, 9)
  })

  it('opacity and blend ride along; a role with no layer is skipped', () => {
    const els: El[] = [disp('A', { top: 10, opacity: 0.4, blend: true }), disp('B', { role: 'tagB', top: 30 })]
    const { ops } = elementsToOps(els, S, targets, frame)
    expect(ops).toHaveLength(1)
    expect(ops[0]!.opacity).toBe(0.4)
    expect(ops[0]!.blendMode).toBe('multiply')
  })
})

// A recording 2D context, enough for the real text renderer.
function makeCtx() {
  const calls: { t: string; x: number; y: number }[] = []
  const ctx: any = {
    canvas: { width: 1000, height: 1000 },
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '', textAlign: 'start', textBaseline: 'alphabetic',
    save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, transform() {}, setTransform() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, rect() {}, fill() {}, stroke() {}, fillRect() {},
    setLineDash() {}, strokeText() {},
    fillText(t: string, x: number, y: number) { calls.push({ t, x, y }) },
    measureText(t: string) { return { width: t.length * 5, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 } },
    createLinearGradient() { return { addColorStop() {} } },
    createRadialGradient() { return { addColorStop() {} } },
    createPattern() { return null },
  }
  return { ctx, calls }
}

describe('elementsToOps — flow text', () => {
  it('(b) a base-anchored info element is top-anchored, and the renderer\'s first line middle lands on cap top + capAbove·size', () => {
    const size = S.INFO.size, lh = S.INFO.lh
    const e: TextEl = { k: 't', s: 'Line one\nLine two', x: 20, w: 60, base: 100, size, wt: 400, ls: 0, lh, role: 'date', align: 'left' }
    const op = elementsToOps([e], S, targets, frame).ops[0]!
    expect(op.target).toBe('dt')
    expect(op.valign).toBe('top')
    expect(op.runs).toBeUndefined()
    expect(op.w).toBeCloseTo(0.6)
    expect(op.x).toBeCloseTo((20 + 30) / 100)
    expect(op.lineHeight).toBe(lh)
    const capTop = 100 - (2 - 1) * lh * size - 0.7 * size
    // Draw it with the real renderer at W = 1000 px (1 kit unit = 10 px): fillText y is
    // relative to the layer origin (op.y · H).
    const W = 1000
    const { ctx, calls } = makeCtx()
    const layer: any = {
      id: 'dt', kind: 'text', x: op.x, y: op.y, rotation: 0, opacity: 1, text: e.s,
      fontFamily: 'Inter', fontWeight: 400, fontSize: op.fontSize, color: '#111', align: op.align,
      valign: op.valign, lineHeight: op.lineHeight, letterSpacing: op.letterSpacing, boxW: op.w,
      strokeColor: '#000', strokeWidth: 0,
    }
    __drawTextForTest(ctx, layer, W)
    expect(calls.length).toBe(2)
    const firstMidKit = op.y * S.H + calls[0]!.y / 10
    expect(firstMidKit).toBeCloseTo(capTop + 0.35 * size, 6)
    // And the last baseline sits on `base`.
    const lastMidKit = op.y * S.H + calls[1]!.y / 10
    expect(lastMidKit + 0.35 * size).toBeCloseTo(100, 6)
  })
})

describe('elementsToOps — pieces and photos', () => {
  it('(c) rules and a band become owned rects with stable keys', () => {
    const els: El[] = [
      { k: 'l', x: 5, y: 20, w: 90 },
      { k: 'r', x: 0, y: 50, w: 100, h: 10, color: 'accent', role: 'band' },
      { k: 'l', x: 5, y: 80, w: 90 },
    ]
    const { ops, owned } = elementsToOps(els, S, targets, frame, { field: '#fff', ink: '#000', accent: '#f00' })
    // Each owned piece also gets an insert op carrying its stacking, aimed at its own id.
    expect(ops.map(o => [o.target, o.insert?.key, o.z])).toEqual([
      ['layout-rule-0', 'rule-0', 0], ['layout-band-0', 'band-0', 1], ['layout-rule-1', 'rule-1', 2],
    ])
    expect(owned.map(l => (l as any).owner.key)).toEqual(['rule-0', 'band-0', 'rule-1'])
    expect(owned.map(l => l.id)).toEqual(['layout-rule-0', 'layout-band-0', 'layout-rule-1'])
    for (const l of owned) {
      expect(l.kind).toBe('rect')
      expect((l as any).owner.by).toBe('layout')
    }
    const band = owned[1] as any
    expect(band.fill).toBe('#f00')
    expect([band.x, band.y, band.w, band.h]).toEqual([0.5, 55 / S.H, 1, 0.1])
    const rule = owned[0] as any
    expect(rule.fill).toBe('#000')
    expect(rule.h).toBeCloseTo(0.0016)
    expect(rule.w).toBeCloseTo(0.9)
  })

  it('(d) a photo becomes an image op that covers its box', () => {
    const { ops } = elementsToOps([{ k: 'p', x: 10, y: 20, w: 40, h: 50, role: 'photo' }], S, targets, frame)
    const op = ops[0]!
    expect(op.target).toBe('img')
    expect(op.kind).toBe('image')
    expect(op.crop?.fit).toBe('cover')
    expect([op.x, op.y, op.w, op.h]).toEqual([0.3, 45 / S.H, 0.4, 0.5])
  })

  it('a photo with no image layer targets the stand-in sentinel', () => {
    const { ops } = elementsToOps([S.cover(false)], S, { title: 't' }, frame)
    expect(ops[0]!.target).toBe('image')
  })

  it('a photo circle masks the image to an ellipse; a plain circle is an owned ellipse', () => {
    const { ops, owned } = elementsToOps([
      { k: 'c', cx: 50, cy: 60, r: 20, photo: true, role: 'photo' },
      { k: 'c', cx: 20, cy: 20, r: 5, color: 'accent', role: 'sticker' },
    ], S, targets, frame)
    const img = ops[0]!
    expect([img.w, img.h]).toEqual([0.4, 0.4])
    expect(img.mask).toEqual({ kind: 'ellipse', x: 0.5, y: 60 / S.H, w: 0.4, h: 0.4 })
    expect(owned).toHaveLength(1)
    expect(owned[0]!.kind).toBe('ellipse')
    expect((owned[0] as any).owner).toEqual({ by: 'layout', key: 'sticker-0' })
  })

  it('a shape circle moves the real shape layer when there is one', () => {
    const { ops, owned } = elementsToOps([{ k: 'c', cx: 50, cy: 50, r: 10, role: 'shape', color: 'ink' }], S, { ...targets, shape: 'sh' }, frame)
    expect(owned).toEqual([])
    expect(ops[0]).toMatchObject({ target: 'sh', kind: 'shape', w: 0.2, colorRole: 'ink' })
  })

  it('a shape rect (Knockout\'s band) moves the real shape layer to its box, centre-anchored', () => {
    const band: El = { k: 'r', x: 0, y: 40, w: 100, h: 30, role: 'shape', color: 'ink', ok: true, bleed: true }
    const { ops, owned } = elementsToOps([band], S, { ...targets, shape: 'sh', shapeKind: 'ellipse' }, frame)
    expect(owned).toEqual([])
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ target: 'sh', kind: 'shape', x: 0.5, w: 1, h: 0.3, colorRole: 'ink' })
    expect(ops[0]!.y).toBeCloseTo(55 / S.H, 9)
    expect(ops[0]!.insert).toBeUndefined()
  })

  it('a shape rect on a path layer (no stretch) gets the largest centred square', () => {
    const band: El = { k: 'r', x: 0, y: 40, w: 100, h: 30, role: 'shape', color: 'ink' }
    const { ops } = elementsToOps([band], S, { ...targets, shape: 'sh', shapeKind: 'path' }, frame)
    expect(ops[0]).toMatchObject({ target: 'sh', kind: 'shape', x: 0.5, w: 0.3, h: 0.3 })
    expect(ops[0]!.y).toBeCloseTo(55 / S.H, 9)
  })

  it('a shape rect with no shape layer stays an owned piece', () => {
    const band: El = { k: 'r', x: 0, y: 40, w: 100, h: 30, role: 'shape', color: 'ink' }
    const { ops, owned } = elementsToOps([band], S, targets, frame)
    expect(owned).toHaveLength(1)
    expect(owned[0]!.kind).toBe('rect')
    expect((owned[0] as any).owner).toEqual({ by: 'layout', key: 'shape-0' })
    expect(ops[0]!.insert).toEqual({ kind: 'rect', key: 'shape-0' })
  })

  it('a ring sets the title on a circle', () => {
    const { ops } = elementsToOps([{ k: 'ring', cx: 50, cy: 60, R: 30, size: 6, s: 'RING' }], S, targets, frame)
    expect(ops[0]).toMatchObject({ target: 't', fontSize: 0.06, path: { follow: 'circle', radius: 0.3, start: 0.5, fit: true } })
  })

  it('a ring repeats the word three times (the layout sized it for three)', () => {
    const { ops } = elementsToOps([{ k: 'ring', cx: 50, cy: 60, R: 30, size: 6, s: 'RING' }], S, targets, frame)
    expect(ops[0]!.path?.repeat).toBe(3)
  })

  it('opts.hide emits one hidden op per role that has a target layer, with no geometry', () => {
    const els: El[] = [disp('TITLE', { top: 10, size: 12 })]
    const { ops } = elementsToOps(els, S, targets, frame, undefined, { hide: ['caption'] })
    expect(ops).toHaveLength(2)
    const hide = ops[1]!
    expect(hide.target).toBe('c')
    expect(hide.hidden).toBe(true)
    expect(hide.x).toBeUndefined()
    expect(hide.y).toBeUndefined()
  })

  it('opts.hide skips a role with no target layer', () => {
    const els: El[] = [disp('TITLE', { top: 10, size: 12 })]
    const { ops } = elementsToOps(els, S, { title: 't' }, frame, undefined, { hide: ['caption'] })
    expect(ops).toHaveLength(1)
  })

  it('z follows element order', () => {
    const { ops } = elementsToOps([
      { k: 'p', x: 0, y: 0, w: 10, h: 10, role: 'photo' },
      disp('A', { top: 10 }),
    ], S, targets, frame)
    expect(ops.map(o => o.z)).toEqual([0, 1])
  })
})

describe('applyPlacement — layout fields', () => {
  const palette = { field: '#fff', ink: '#000', accent: '#f00' }
  const elements = { title: { role: 'title', id: 't', text: 'NOISE', words: ['NOISE'] }, images: [{ id: 'img' }], shapes: [], shapeMode: null } as unknown as FrameElements
  const text = (over: any = {}): any => ({ id: 't', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'NOISE',
    fontFamily: 'Inter', fontWeight: 700, fontSize: 0.08, color: '#000', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0, ...over })

  it('(e) letter spacing a layout set is restored to the layer\'s own when a later op omits it', () => {
    const start = [text({ letterSpacing: 0.02 })]
    const a = applyPlacement(start, { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.5, y: 0.5, letterSpacing: -0.05, lineHeight: 0.9 }] }, elements, palette)
    expect((a[0] as any).letterSpacing).toBe(-0.05)
    expect((a[0] as any).lineHeight).toBe(0.9)
    const b = applyPlacement(a, { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.4, y: 0.5 }] }, elements, palette)
    expect((b[0] as any).letterSpacing).toBe(0.02)
    expect((b[0] as any).lineHeight).toBe(1.2)
    expect('layoutPrev' in (b[0] as any)).toBe(false)
  })

  it('a second layout that sets spacing again still remembers the user\'s original', () => {
    const start = [text()]
    const a = applyPlacement(start, { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.5, y: 0.5, letterSpacing: -0.05 }] }, elements, palette)
    const b = applyPlacement(a, { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.5, y: 0.5, letterSpacing: -0.02 }] }, elements, palette)
    const c = applyPlacement(b, { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.5, y: 0.5 }] }, elements, palette)
    expect('letterSpacing' in (c[0] as any)).toBe(false)   // absent before any layout ⇒ absent again
  })

  it('runs, opacity and blend are written, then cleared when a later op omits them', () => {
    const runs = [{ text: 'NO', x: -1, y: 0 }]
    const a = applyPlacement([text({ opacity: 0.8 })], { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.5, y: 0.5, runs, opacity: 0.5, blendMode: 'screen' }] }, elements, palette)
    expect((a[0] as any).runs).toEqual(runs)
    expect((a[0] as any).opacity).toBe(0.5)
    expect((a[0] as any).blend).toBe('screen')
    const b = applyPlacement(a, { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.5, y: 0.5 }] }, elements, palette)
    expect('runs' in (b[0] as any)).toBe(false)
    expect((b[0] as any).opacity).toBe(0.8)
    expect('blend' in (b[0] as any)).toBe(false)
  })

  it('an image op writes crop and mask, and a later op without them clears both', () => {
    const img: any = { id: 'img', kind: 'image', filename: 'a.png', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1 }
    const mask = { kind: 'ellipse' as const, x: 0.5, y: 0.5, w: 0.4, h: 0.4 }
    const a = applyPlacement([img], { did: 'x', ops: [{ target: 'img', kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.4, crop: { fit: 'cover' }, mask }] }, elements, palette)
    expect((a[0] as any).crop).toEqual({ fit: 'cover' })
    expect((a[0] as any).mask).toEqual(mask)
    const b = applyPlacement(a, { did: 'x', ops: [{ target: 'img', kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.5 }] }, elements, palette)
    expect('crop' in (b[0] as any)).toBe(false)
    expect('mask' in (b[0] as any)).toBe(false)
  })

  it('an op without the new fields leaves an untouched layer free of them (byte-identical)', () => {
    const [out] = applyPlacement([text()], { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.3, y: 0.5 }] }, elements, palette)
    expect(out).toEqual({ ...text(), x: 0.3, y: 0.5 })
  })
})

describe('owned pieces keep their place in the stack', () => {
  it('a band listed before the title ends up below the title in the final order', () => {
    const title: any = { id: 't', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'A', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.1, color: '#000', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 }
    const els: El[] = [
      { k: 'r', x: 0, y: 40, w: 100, h: 20, color: 'accent', role: 'band' },
      disp('A', { top: 45 }),
    ]
    const { ops, owned } = elementsToOps(els, S, targets, frame)
    const elements = { images: [], shapes: [], shapeMode: null } as unknown as FrameElements
    const placed = applyPlacement([title], { did: 'x', ops }, elements, { field: '#fff', ink: '#000', accent: '#f00' })
    const merged = mergeOwned(placed, owned)
    // mergeOwned appends the band on top; the saved order only knows the title.
    const present = merged.map(l => localStackKey(l.id))
    const order = nextOrderFor([localStackKey('t')], present, ops, elements, new Map())
    expect(order.indexOf(localStackKey('layout-band-0'))).toBeLessThan(order.indexOf(localStackKey('t')))
    // The insert op never patches the owned layer.
    expect(merged.find(l => l.id === 'layout-band-0')).toBe(owned[0])
  })
})

describe('applyPlacement — only clears what a layout set', () => {
  const palette = { field: '#fff', ink: '#000', accent: '#f00' }
  const elements = { title: { role: 'title', id: 't', text: 'NOISE', words: ['NOISE'] }, images: [{ id: 'img' }], shapes: [], shapeMode: null } as unknown as FrameElements
  const text = (over: any = {}): any => ({ id: 't', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'NOISE',
    fontFamily: 'Inter', fontWeight: 700, fontSize: 0.08, color: '#000', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0, ...over })
  const img = (over: any = {}): any => ({ id: 'img', kind: 'image', filename: 'a.png', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1, ...over })
  const userPath = { follow: 'curve' as const, bend: 0.4 }
  const oldOp = (target: string, kind: 'text' | 'image') => ({ did: 'x', ops: [{ target, kind, x: 0.3, y: 0.4, w: 0.5, h: 0.5 }] })

  it('a user path on a text layer survives an old-style op', () => {
    const [out] = applyPlacement([text({ path: userPath })], oldOp('t', 'text'), elements, palette)
    expect((out as any).path).toEqual(userPath)
  })

  it('a user mask on an image survives any op', () => {
    const mask = { kind: 'rect' as const, x: 0.5, y: 0.5, w: 0.2, h: 0.2 }
    const [out] = applyPlacement([img({ mask })], oldOp('img', 'image'), elements, palette)
    expect((out as any).mask).toEqual(mask)
  })

  it('a user crop focus survives an old-pattern image op', () => {
    const crop = { fit: 'cover' as const, fx: 0.2, fy: 0.8 }
    const [out] = applyPlacement([img({ crop })], oldOp('img', 'image'), elements, palette)
    expect((out as any).crop).toEqual(crop)
  })

  it('a ring sets path; a later op without it restores the user\'s path, or removes one there was not', () => {
    const { ops } = elementsToOps([{ k: 'ring', cx: 50, cy: 60, R: 30, size: 6, s: 'RING' }], S, { title: 't' }, frame)
    for (const start of [text({ path: userPath }), text()]) {
      const a = applyPlacement([start], { did: 'x', ops }, elements, palette)
      expect((a[0] as any).path.follow).toBe('circle')
      const [b] = applyPlacement(a, oldOp('t', 'text'), elements, palette)
      if (start.path) expect((b as any).path).toEqual(userPath)
      else expect('path' in (b as any)).toBe(false)
      expect('layoutPrev' in (b as any)).toBe(false)
    }
  })

  it('a value the user changed after a layout set it is kept when the next layout omits it', () => {
    const a = applyPlacement([text()], { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.5, y: 0.5, opacity: 0.4 }] }, elements, palette)
    expect((a[0] as any).opacity).toBe(0.4)
    const edited = [{ ...(a[0] as any), opacity: 0.6 }]
    const [b] = applyPlacement(edited, { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.5, y: 0.5 }] }, elements, palette)
    expect((b as any).opacity).toBe(0.6)
    expect('layoutPrev' in (b as any)).toBe(false)
  })

  it('a user change between two layouts becomes the value restored later', () => {
    const a = applyPlacement([text()], { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.5, y: 0.5, opacity: 0.4 }] }, elements, palette)
    const edited = [{ ...(a[0] as any), opacity: 0.6 }]
    const b = applyPlacement(edited, { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.5, y: 0.5, opacity: 0.3 }] }, elements, palette)
    const [c] = applyPlacement(b, { did: 'x', ops: [{ target: 't', kind: 'text', x: 0.5, y: 0.5 }] }, elements, palette)
    expect((c as any).opacity).toBe(0.6)
  })
})

describe('elementsToOps — text colour roles', () => {
  const flowEl = (o: Partial<TextEl>): TextEl =>
    ({ k: 't', s: 'Some details', x: 10, top: 60, w: 40, size: 3, ls: 0, lh: 1.3, role: 'details', ...o } as TextEl)

  it('a user text op with no colour on its element takes the ink role (display, flow and ring)', () => {
    const els: El[] = [
      disp('TITLE', { top: 10, size: 12 }),
      flowEl({}),
    ]
    const { ops } = elementsToOps(els, S, targets, frame)
    expect(ops.find(o => o.target === 't')!.colorRole).toBe('ink')
    expect(ops.find(o => o.target === 'd')!.colorRole).toBe('ink')
    const ring = elementsToOps([{ k: 'ring', cx: 50, cy: 50, R: 30, size: 8, s: 'WORD' } as El], S, targets, frame).ops[0]!
    expect(ring.colorRole).toBe('ink')
  })

  it('an element that names a colour keeps that role', () => {
    const els: El[] = [disp('TITLE', { top: 10, size: 12, color: 'field' }), flowEl({ color: 'accent' })]
    const { ops } = elementsToOps(els, S, targets, frame)
    expect(ops.find(o => o.target === 't')!.colorRole).toBe('field')
    expect(ops.find(o => o.target === 'd')!.colorRole).toBe('accent')
  })
})

describe('elementsToOps — Stage 3 pieces: band, button, logo', () => {
  const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
  const P = makeSheet({ frameW: frame.w, frameH: frame.h, measure, style: 'performance' })
  const E = makeSheet({ frameW: frame.w, frameH: frame.h, measure, style: 'editorial' })
  const withAction = { ...targets, action: 'a' }

  it('a band becomes one owned rect across the page with a 3-stop gradient of the page colour', () => {
    const band = P.band('bottom', 80, P.H)
    const { ops, owned } = elementsToOps([band], P, targets, frame, palette)
    expect(owned).toHaveLength(1)
    const r = owned[0] as any
    expect(r.kind).toBe('rect')
    expect(r.owner).toEqual({ by: 'layout', key: 'band-0' })
    expect(r.id).toBe('layout-band-0')
    expect(r.x).toBe(0.5)
    expect(r.w).toBe(1)
    expect(r.y).toBeCloseTo((band.y + band.h / 2) / P.H, 9)
    expect(r.h).toBeCloseTo(band.h / 100, 9)
    expect(r.radius).toBe(0)
    expect(r.fill).toEqual({
      type: 'linear', angle: 270,
      stops: [
        { offset: 0, color: 'rgba(242, 240, 239, 0.94)' },
        { offset: band.solid, color: 'rgba(242, 240, 239, 0.94)' },
        { offset: 1, color: 'rgba(242, 240, 239, 0)' },
      ],
    })
    expect(ops).toEqual([{ target: 'layout-band-0', kind: 'shape', x: r.x, y: r.y, z: 0, insert: { kind: 'rect', key: 'band-0' } }])
    // A top band runs top → bottom.
    expect((elementsToOps([P.band('top', 0, 20)], P, targets, frame, palette).owned[0] as any).fill.angle).toBe(90)
  })

  it('a button on black action text takes the most-contrast role that stands out from the page (ruling R6)', () => {
    const { btn, text } = P.button('Shop now', 10, 50)
    const { ops, owned } = elementsToOps([btn, text], P, withAction, frame, palette, { actionColor: '#000000' })
    expect(owned).toHaveLength(1)
    const r = owned[0] as any
    expect(r.owner).toEqual({ by: 'layout', key: 'button-0' })
    // The page colour has the most contrast (19.3:1) but is the page itself (1:1 against it): the
    // accent is next (4.3:1 with the label, 4.3:1 against the page).
    expect(r.fill).toBe(palette.accent)
    expect(r.radius).toBeCloseTo(btn.h / 2 / 100, 9)
    expect(r.w).toBeCloseTo(btn.w / 100, 9)
    expect(r.h).toBeCloseTo(btn.h / 100, 9)
    expect(ops[0]!.insert).toEqual({ kind: 'rect', key: 'button-0', radius: r.radius })
    const act = ops.find(o => o.target === 'a')!
    expect(act.kind).toBe('text')
    expect(act.underline).toBeUndefined()
    // The label keeps its own colour unless recolour is on (colorRole is only a request).
    expect(act.colorRole).toBe('field')
  })

  it('white action text takes the ink; a box has square corners', () => {
    const St = makeSheet({ frameW: frame.w, frameH: frame.h, measure, style: 'street' })
    const { btn, text } = St.button('Shop now', 10, 50)
    const { owned } = elementsToOps([btn, text], St, withAction, frame, palette, { actionColor: '#ffffff' })
    expect((owned[0] as any).fill).toBe(palette.ink)
    expect((owned[0] as any).radius).toBe(0)
  })

  it('action text no role carries: plain paper (R12), else an outlined button (R8); an unknown colour a link', () => {
    const grey = { field: '#777777', ink: '#808080', accent: '#707070' }
    const { btn, text } = P.button('Shop now', 10, 50)
    // Grey page: plain white reads with the label (4.3:1) and stands out from the page (4.5:1).
    const plain = elementsToOps([btn, text], P, withAction, frame, grey, { actionColor: '#7a7a7a' })
    expect((plain.owned[0] as any).fill).toBe('#ffffff')
    // Paper page, near-black label: white is the page (1.1:1), near-black the label — an outline.
    const paper = { field: '#f2f0ef', ink: '#111111', accent: '#111111' }
    const { ops, owned } = elementsToOps([btn, text], P, withAction, frame, paper, { actionColor: '#111111' })
    expect(owned).toHaveLength(1)
    const r = owned[0] as any
    expect(r.fill).toBe('none')
    expect(r.stroke).toBe('#111111')
    expect(r.strokeWidth).toBeCloseTo(0.08 * btn.size / 100, 9)
    expect(ops.find(o => o.target === 'a')!.underline).toBeUndefined()
    // An unknown colour (a gradient) is a link too.
    const g = elementsToOps([btn, text], P, withAction, frame, palette, { actionColor: { type: 'linear', angle: 0, stops: [] } })
    expect(g.owned).toEqual([])
    expect(g.ops[0]!.underline).toBe(true)
  })

  it('with recolour on the button takes the prototype’s colours (ink behind, page-colour text)', () => {
    const { btn, text } = P.button('Shop now', 10, 50)
    const { ops, owned } = elementsToOps([btn, text], P, withAction, frame, palette, { actionColor: '#777777', recolour: true })
    expect((owned[0] as any).fill).toBe(palette.ink)
    expect(ops.find(o => o.target === 'a')!.colorRole).toBe('field')
  })

  it('Editorial’s link style never draws a rect and underlines the action', () => {
    const { btn, text } = E.button('Shop now', 10, 50)
    const { ops, owned } = elementsToOps([btn, text], E, withAction, frame, palette, { actionColor: '#000000' })
    expect(owned).toEqual([])
    expect(ops[0]!.underline).toBe(true)
    expect(ops[0]!.textTransform).toBe('uppercase')
  })

  it('no action layer: no button', () => {
    const { btn, text } = P.button('Shop now', 10, 50)
    expect(elementsToOps([btn, text], P, targets, frame, palette, { actionColor: '#000000' })).toEqual({ ops: [], owned: [] })
  })

  it('a logo becomes an owned image with the kit url, aspect-true and uncropped', () => {
    const lg = P.logo(10, 5, 6, { aspect: 0.3 })
    const logo = { url: 'brand/logo.png', aspect: 0.3, onDarkUrl: 'brand/logo-dark.png' }
    const { ops, owned } = elementsToOps([lg], P, targets, frame, palette, { logo })
    const l = owned[0] as any
    expect(l.kind).toBe('image')
    expect(l.filename).toBe('brand/logo.png')
    expect(l.owner).toEqual({ by: 'layout', key: 'logo-0' })
    expect(l.id).toBe('layout-logo-0')
    expect(l.w).toBeCloseTo(0.2, 9)
    expect(l.h).toBeCloseTo(l.w * 0.3, 9)
    expect(l.crop).toBeUndefined()
    expect(l.x).toBeCloseTo(0.2, 9)
    expect(l.y).toBeCloseTo(8 / P.H, 9)
    expect(ops[0]).toMatchObject({ target: 'layout-logo-0', kind: 'image', insert: { kind: 'image', key: 'logo-0' } })
    // A dark page takes the on-dark version.
    const dark = elementsToOps([lg], P, targets, frame, { ...palette, field: '#101010' }, { logo })
    expect((dark.owned[0] as any).filename).toBe('brand/logo-dark.png')
    // No kit logo: nothing drawn.
    expect(elementsToOps([lg], P, targets, frame, palette)).toEqual({ ops: [], owned: [] })
  })

  it('the on-dark logo keeps its own aspect, fitted inside the layout\'s box and centred on it', () => {
    const lg = P.logo(10, 5, 6, { aspect: 0.3 })                // box 20 × 6 (kit units)
    const logo = { url: 'brand/logo.png', aspect: 0.3, onDarkUrl: 'brand/logo-dark.png', onDarkAspect: 0.5 }
    const dark = elementsToOps([lg], P, targets, frame, { ...palette, field: '#101010' }, { logo })
    const l = dark.owned[0] as any
    expect(l.filename).toBe('brand/logo-dark.png')
    expect(l.h).toBeCloseTo(0.06, 9)                             // the box's height binds
    expect(l.w).toBeCloseTo(0.12, 9)                             // h / 0.5
    expect(l.x).toBeCloseTo(0.2, 9)                              // same centre as the box
    expect(l.y).toBeCloseTo(8 / P.H, 9)
    // A light page places the main file in the full box, as before.
    const light = elementsToOps([lg], P, targets, frame, palette, { logo }).owned[0] as any
    expect(light.w).toBeCloseTo(0.2, 9)
    expect(light.h).toBeCloseTo(0.06, 9)
    // No onDarkAspect: the on-dark file fills the box like the main one.
    const same = elementsToOps([lg], P, targets, frame, { ...palette, field: '#101010' }, { logo: { ...logo, onDarkAspect: undefined } }).owned[0] as any
    expect(same.w).toBeCloseTo(0.2, 9)
  })

  it('the link underline is tracked: a later op without it gives the user’s own back', () => {
    const { btn, text } = E.button('Shop now', 10, 50)
    const { ops } = elementsToOps([btn, text], E, withAction, frame, palette)
    const layer = { id: 'a', kind: 'text', text: 'Shop now', x: 0.5, y: 0.5, fontSize: 0.03, color: '#000000' } as any
    const elements = { action: { role: 'action', id: 'a', text: 'Shop now', words: ['Shop', 'now'] }, images: [], shapes: [] } as unknown as FrameElements
    const once = applyPlacement([layer], { ops, did: '' }, elements, palette, { recolour: false })
    expect((once[0] as any).underline).toBe(true)
    const again = applyPlacement(once, { ops: [{ ...ops[0]!, underline: undefined }], did: '' }, elements, palette, { recolour: false })
    expect((again[0] as any).underline).toBeUndefined()
  })
})

describe('elementsToOps — Stage 3 fix round 1', () => {
  const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
  const P = makeSheet({ frameW: frame.w, frameH: frame.h, measure, style: 'performance' })

  it('a label pushed before its button still draws above it', () => {
    const { btn, text } = P.button('Shop now', 10, 50)
    const withAction = { ...targets, action: 'a' }
    const { ops, owned } = elementsToOps([text, btn], P, withAction, frame, palette, { actionColor: '#000000' })
    const act = ops.find(o => o.target === 'a')!
    const ins = ops.find(o => o.insert)!
    expect(act.z!).toBeGreaterThan(ins.z!)
    // Through the real order: the rect lands below the label.
    const merged = mergeOwned([{ id: 'a', kind: 'text' } as any], owned)
    const inserted = new Map<number, string>([[ops.indexOf(ins), owned[0]!.id]])
    const elements = { images: [], shapes: [] } as unknown as FrameElements
    const saved = [localStackKey('a'), localStackKey(owned[0]!.id)]   // the label saved BELOW the rect
    const order = nextOrderFor(saved, merged.map(l => localStackKey(l.id)), ops, elements, inserted)
    expect(order.indexOf(localStackKey('a'))).toBeGreaterThan(order.indexOf(localStackKey(owned[0]!.id)))
    // Already above: left alone.
    const inOrder = elementsToOps([btn, text], P, withAction, frame, palette, { actionColor: '#000000' })
    expect(inOrder.ops.find(o => o.target === 'a')!.z).toBe(1)
  })

  it('a band’s rgba stops export to SVG as colour plus stop-opacity', () => {
    const { owned } = elementsToOps([P.band('bottom', 80, P.H)], P, targets, frame, palette)
    const v = paintToVectorPaint((owned[0] as any).fill, { units: 'objectBoundingBox' }) as any
    expect(v.stops.map((s: any) => [s.color, s.opacity])).toEqual([
      ['#f2f0ef', 0.94], ['#f2f0ef', 0.94], ['#f2f0ef', 0],
    ])
  })
})

// ═══════════════════════ Stage 4 Task 2: owned words, stars, leader lines, the second image, lists ═══════════════════════

describe('elementsToOps — Stage 4 kit pieces', () => {
  const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
  const P = makeSheet({ frameW: frame.w, frameH: frame.h, measure, style: 'performance' })
  const all = { ...targets, list: 'li', image2: 'img2' }

  it('an `own` element becomes an owned text layer in the caption layer\'s family, its colour role applied', () => {
    const e = P.own('✓', { x: 20, top: 30, size: 4, wt: 700, color: 'accent', role: 'us0' })
    const { ops, owned } = elementsToOps([e], P, all, frame, palette, { ownFamily: 'Caption Serif' })
    expect(owned).toHaveLength(1)
    const l = owned[0] as any
    expect(l.kind).toBe('text')
    expect(l.owner).toEqual({ by: 'layout', key: 'own-0' })
    expect(l.id).toBe('layout-own-0')
    expect(l.text).toBe('✓')
    expect(l.fontFamily).toBe('Caption Serif')
    expect(l.fontWeight).toBe(700)
    expect(l.color).toBe('#dd2200')
    expect(l.fontSize).toBeCloseTo(0.04, 9)
    // Placed where the checker measures it: the run's cap top at `top`, its left edge at `x`.
    const b = boxOf(e, P)!
    const r = l.runs[0]
    expect(l.x * 100 + r.x * 4).toBeCloseTo(b.x0, 9)
    expect(l.y * P.H + r.y * 4 - 0.35 * 4).toBeCloseTo(b.y0, 9)
    expect(r.x * 2 + measure.w100('✓', 'caption', 0) / 100).toBeCloseTo(0, 9)    // centred on the origin (R2)
    // One insert op carrying its stacking; no op touches a user's layer.
    expect(ops).toEqual([{ target: 'layout-own-0', kind: 'text', x: l.x, y: l.y, z: 0, insert: { kind: 'text', key: 'own-0' } }])
  })

  it('ruling R10: owned text takes the caption layer\'s weight when given; the kit\'s `wt` only without one', () => {
    const e = P.own('✓', { x: 20, top: 30, size: 4, wt: 300 })
    expect((elementsToOps([e], P, all, frame, palette, { ownFamily: 'Caption Serif', ownWeight: 700 }).owned[0] as any).fontWeight).toBe(700)
    expect((elementsToOps([e], P, all, frame, palette).owned[0] as any).fontWeight).toBe(300)
  })

  it('an `own` element with a fixed `hex` is drawn in it (ruling R6); keys count up', () => {
    const els: El[] = [
      P.own('‹ Notes', { x: 5, top: 5, hex: '#d49a1a', role: 'ui' }),
      P.own('Done', { x: 70, top: 5, hex: '#d49a1a', role: 'ui2' }),
      P.own('1', { x: 5, top: 40 }),
    ]
    const { owned } = elementsToOps(els, P, all, frame, palette, { ownFamily: 'Caption Serif' })
    expect(owned.map(l => (l as any).owner.key)).toEqual(['own-0', 'own-1', 'own-2'])
    expect(owned.map(l => (l as any).color)).toEqual(['#d49a1a', '#d49a1a', '#121212'])
  })

  it('negative control: the layout\'s own words never become an op on a user\'s text layer', () => {
    const e = P.own('Before', { x: 5, top: 5, role: 'caption' })   // even named like a user role
    const { ops } = elementsToOps([e], P, all, frame, palette)
    expect(ops.every(o => o.insert)).toBe(true)
    expect(ops.some(o => o.target === 'c')).toBe(false)
  })

  it('stars 4.7 → five owned star layers, each a hard-stop accent → ink at 22%; the fifth stops at 70%', () => {
    const st = P.stars(4.7, 10, 20, 5)
    const { ops, owned } = elementsToOps([st], P, all, frame, palette)
    expect(owned).toHaveLength(5)
    expect(owned.map(l => l.kind)).toEqual(['star', 'star', 'star', 'star', 'star'])
    expect(owned.map(l => (l as any).owner.key)).toEqual(['stars-0', 'stars-1', 'stars-2', 'stars-3', 'stars-4'])
    const stops = owned.map(l => (l as any).fill.stops as { offset: number; color: string }[])
    for (const s of stops.slice(0, 4)) expect(s[1]!.offset).toBe(1)
    expect(stops[4]!.map(s => s.offset)).toEqual([0, 0.7, 0.7, 1])
    expect(stops[4]!.map(s => s.color)).toEqual(['#dd2200', '#dd2200', 'rgba(18, 18, 18, 0.22)', 'rgba(18, 18, 18, 0.22)'])
    expect((owned[0] as any).fill.angle).toBe(0)                 // left → right
    // Each `size` square, 0.08 × size apart, in the checker's box.
    const l0 = owned[0] as any, l4 = owned[4] as any
    expect(l0.w).toBeCloseTo(0.05, 9)
    expect(l0.x * 100).toBeCloseTo(12.5, 9)
    expect(l4.x * 100).toBeCloseTo(12.5 + 4 * 5.4, 9)
    expect(l0.y * P.H).toBeCloseTo(22.5, 9)
    const b = boxOf(st, P)!
    expect(l4.x * 100 + 2.5).toBeCloseTo(b.x1, 9)
    expect(ops.map(o => o.insert?.kind)).toEqual(['star', 'star', 'star', 'star', 'star'])
    // A whole rating: nothing left unfilled on the fifth; zero fills none.
    expect(((elementsToOps([P.stars(5, 10, 20, 5)], P, all, frame, palette).owned[4] as any).fill.stops[1].offset)).toBe(1)
    expect(((elementsToOps([P.stars(4, 10, 20, 5)], P, all, frame, palette).owned[4] as any).fill.stops[1].offset)).toBe(0)
  })

  it('a leader line → an owned line layer centred between its ends, turned to their angle, in ink', () => {
    const ln = P.leader(10, 40, 40, 70)
    const { ops, owned } = elementsToOps([ln], P, all, frame, palette)
    expect(owned).toHaveLength(1)
    const l = owned[0] as any
    expect(l.kind).toBe('line')
    expect(l.owner).toEqual({ by: 'layout', key: 'leader-0' })
    expect(l.x).toBeCloseTo(0.25, 9)
    expect(l.y * P.H).toBeCloseTo(55, 9)
    expect(l.w).toBeCloseTo(Math.hypot(30, 30) / 100, 9)
    expect(l.rotation).toBeCloseTo(45, 9)
    expect(l.stroke).toBe('#121212')
    expect(l.strokeWidth).toBeCloseTo(0.002, 9)
    expect(ops[0]!.insert).toEqual({ kind: 'line', key: 'leader-0' })
  })

  it('an image2 photo → an op on the second image with a cover crop; the first image is untouched', () => {
    const els: El[] = [
      { k: 'p', x: 0, y: 0, w: 50, h: 60, role: 'photo' },
      { k: 'p', x: 50, y: 0, w: 50, h: 60, role: 'photo2' },
    ]
    const { ops } = elementsToOps(els, P, all, frame, palette)
    expect(ops.map(o => o.target)).toEqual(['img', 'img2'])
    expect(ops[1]).toMatchObject({ kind: 'image', x: 0.75, w: 0.5, h: 0.6, crop: { fit: 'cover' }, z: 1 })
    expect(ops[1]!.y! * P.H).toBeCloseTo(30, 9)
    // Only `photo2` (the one role a layout emits — Before / after) names it; the dead `image2`
    // alias was removed in the Stage 4 final fix wave.
    expect(elementsToOps([{ ...els[1]!, role: 'image2' } as El], P, all, frame, palette).ops[0]!.target).toBe('img')
    // Negative control: no second image layer, no op (never the first image's).
    expect(elementsToOps([els[1]!], P, targets, frame, palette).ops).toEqual([])
  })

  it('three list items → ONE op on the list layer, the items as its runs, union centred (ruling R5 + R2)', () => {
    const it = (s: string, role: string, top: number): TextEl =>
      ({ k: 't', s, x: 10, w: 60, top, size: 3, wt: 500, ls: 0, lh: 1.2, role } as TextEl)
    const els: El[] = [it('Light', 'list', 20), it('Warm\nand dry', 'list1', 30), it('Grippy', 'list2', 45)]
    const { ops, owned } = elementsToOps(els, P, all, frame, palette)
    expect(owned).toEqual([])
    expect(ops).toHaveLength(1)
    const op = ops[0]!
    expect(op.target).toBe('li')
    expect(op.runs!.map(r => r.text)).toEqual(['Light', 'Warm', 'and dry', 'Grippy'])
    expect(op.w).toBeUndefined()                                  // placed lines, not a flow box
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const r of op.runs!) {
      const w = measure.w100(r.text, 'caption', 0) / 100
      x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x + w)
      y0 = Math.min(y0, r.y - 0.5); y1 = Math.max(y1, r.y + 0.5)
    }
    expect(x0 + x1).toBeCloseTo(0, 9)
    expect(y0 + y1).toBeCloseTo(0, 9)
    // Each item's first line has its cap top at the item's `top`; the checker agrees.
    expect(op.y! * P.H + op.runs![3]!.y * 3 - 0.35 * 3).toBeCloseTo(45, 9)
    expect(boxOf(els[2]!, P)!.y0).toBeCloseTo(45, 9)
    // Negative control: without a list layer the items are skipped.
    expect(elementsToOps(els, P, targets, frame, palette).ops).toEqual([])
  })
})

describe('Stage 4 through the planner: the owned words take the caption layer\'s family', () => {
  it('a layout\'s own words are set in the caption layer\'s family; the second image is cropped to cover', async () => {
    const { vi } = await import('vitest')
    const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
    vi.resetModules()
    vi.doMock('~/lib/frame/patterns/layouts/catalog', async (orig) => {
      const m = await orig() as typeof import('~/lib/frame/patterns/layouts/catalog')
      const def = {
        id: 'testOwn', name: 'Test own', fits: ['word', 'phrase', 'sentence'], needsContent: ['image2'],
        fn: (S: any, { c }: any) => ({
          did: 'test',
          els: [
            { k: 'p', x: 0, y: 0, w: 50, h: 40, role: 'photo' },
            { k: 'p', x: 50, y: 0, w: 50, h: 40, role: 'photo2' },
            S.disp(c.title, { size: 8, x: S.M, top: 50 }),
            S.own('Before', { x: S.M, top: 95, wt: 300 }),
          ],
        }),
      }
      return { ...m, layoutEntry: (id: string) => (id === 'testOwn' ? { def, index: 0 } : m.layoutEntry(id)) }
    })
    try {
      const { planLayout } = await import('~/lib/frame/patterns/kit/plan')
      const { createImageLayer, createTextLayer } = await import('~/composables/useCompositorLayers')
      const t = (id: string, text: string, fontSize: number, fontFamily: string) =>
        createTextLayer({ id, text, fontSize, fontFamily, fontWeight: 600, color: '#111111' })
      const layers = [
        t('t', 'Run lighter.', 0.12, 'Title Sans'), t('d', 'Halden Trail 2', 0.04, 'Title Sans'),
        t('c', 'Offer ends 12 October.', 0.02, 'Caption Serif'),
        createImageLayer('a.png', 1.25, { id: 'img', w: 0.5, h: 0.625 }),
        createImageLayer('b.png', 1.25, { id: 'img2', w: 0.5, h: 0.625 }),
      ]
      const plan = planLayout({
        props: { sailor_localLayers: layers }, frameW: 1000, frameH: 1000, layoutId: 'testOwn',
        choice: { lines: 0, arr: 0, scale: 'full', side: 'right' } as any, palette, connectedSlots: [], measure,
      })!
      const own = plan.layers.find(l => (l as any).owner?.key === 'own-0') as any
      expect(own.fontFamily).toBe('Caption Serif')
      expect(own.fontWeight).toBe(600)                            // the caption layer's, not the kit's 300
      // The user's caption keeps its own face.
      expect((plan.layers.find(l => l.id === 'c') as any).fontFamily).toBe('Caption Serif')
      expect((plan.layers.find(l => l.id === 't') as any).fontFamily).toBe('Title Sans')
      // Ruling R10: a caption at 700 gives owned text at 700, whatever the kit's `wt` (300 here).
      const heavy = layers.map(l => (l.id === 'c' ? { ...l, fontWeight: 700 } : l))
      const plan700 = planLayout({
        props: { sailor_localLayers: heavy }, frameW: 1000, frameH: 1000, layoutId: 'testOwn',
        choice: { lines: 0, arr: 0, scale: 'full', side: 'right' }, palette, connectedSlots: [], measure,
      })!
      const own700 = plan700.layers.find(l => (l as any).owner?.key === 'own-0') as any
      expect(own700.fontWeight).toBe(700)
      expect(own700.fontFamily).toBe('Caption Serif')
      expect((plan700.layers.find(l => l.id === 'c') as any).fontWeight).toBe(700)   // the user's own, untouched
      const img2 = plan.layers.find(l => l.id === 'img2') as any
      expect(img2.crop).toEqual({ fit: 'cover' })
      expect(img2.x).toBeCloseTo(0.75, 9)
    } finally {
      vi.doUnmock('~/lib/frame/patterns/layouts/catalog')
      vi.resetModules()
    }
  })
})
