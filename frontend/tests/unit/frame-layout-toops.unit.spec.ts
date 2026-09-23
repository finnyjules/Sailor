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
