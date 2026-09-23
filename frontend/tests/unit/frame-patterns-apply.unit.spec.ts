import { describe, it, expect } from 'vitest'
import { applyPlacement } from '~/lib/frame/patterns/apply'
import { inferElements } from '~/lib/frame/patterns/hierarchy'
import { planLayout } from '~/lib/frame/patterns/kit/plan'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { DEFAULT_CHOICE } from '~/lib/frame/patterns/kit/vary'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { PatternPlacement, FrameElements } from '~/lib/frame/patterns/types'
import type { ExpressiveParams } from '~~/shared/text-layout/expressive'

const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
function textLayer(id: string, over: Partial<any> = {}): any {
  return { id, kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'NOISE',
    fontFamily: 'Inter', fontWeight: 700, fontSize: 0.08, color: '#000000', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0, ...over }
}
const elements = { title: { role: 'title', id: 't', text: 'NOISE', words: ['NOISE'] }, images: [], shapes: [], shapeMode: null } as unknown as FrameElements

describe('applyPlacement', () => {
  it('patches the title layer geometry and ink colour from the op', () => {
    const layers: LocalLayer[] = [textLayer('t')]
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'title', kind: 'text', x: 0.2, y: 0.3, w: 0.9, fontSize: 0.25, rotation: 0, align: 'left', colorRole: 'ink' },
    ] }
    const next = applyPlacement(layers, placement, elements, palette)
    expect(next).not.toBe(layers)                 // new array
    expect(next[0]).not.toBe(layers[0])           // new layer object (immutable)
    const t = next[0] as any
    expect([t.x, t.y]).toEqual([0.2, 0.3])
    expect(t.fontSize).toBe(0.25)
    expect(t.boxW).toBe(0.9)                       // op.w → text boxW
    expect(t.align).toBe('left')
    expect(t.color).toBe('#121212')               // ink role → hex
  })
  it('inserts line breaks and blend, and leaves the font/weight untouched', () => {
    const layers: LocalLayer[] = [textLayer('t', { fontFamily: 'Anton', fontWeight: 800 })]
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'title', kind: 'text', x: 0.5, y: 0.5, fontSize: 0.2, colorRole: 'accent', blend: 'multiply', lineBreak: 'NO\nISE' },
    ] }
    const t = applyPlacement(layers, placement, elements, palette)[0] as any
    expect(t.text).toBe('NO\nISE')
    expect(t.blend).toBe('multiply')
    expect(t.color).toBe('#dd2200')
    expect(t.fontFamily).toBe('Anton')            // NEVER changed by apply
    expect(t.fontWeight).toBe(800)                // NEVER changed by apply
  })
  it('skips an op whose target resolves to no layer', () => {
    const layers: LocalLayer[] = [textLayer('t')]
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'details', kind: 'text', x: 0.1, y: 0.1, fontSize: 0.02, colorRole: 'ink' },
    ] }
    const next = applyPlacement(layers, placement, elements, palette)
    expect(next[0]).toBe(layers[0])                // pass-through BY REFERENCE (the contract)
  })
  it('applies a shape op\'s geometry and colour role to the real shape layer', () => {
    const layers: LocalLayer[] = [
      textLayer('t'),
      { id: 's', kind: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2, fill: '#000000', rotation: 0, opacity: 1 } as any,
    ]
    const els = {
      title: { role: 'title', id: 't', text: 'NOISE', words: ['NOISE'] },
      images: [], shapes: [{ id: 's', shapeId: 'circle' }], shapeMode: null,
    } as unknown as FrameElements
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 's', kind: 'shape', x: 0.3, y: 0.4, w: 0.6, h: 0.6, colorRole: 'accent', fill: 'solid', z: 0 },
      { target: 'title', kind: 'text', x: 0.5, y: 0.5, fontSize: 0.2, colorRole: 'ink' },
    ] }
    const next = applyPlacement(layers, placement, els, palette)
    const s = next.find(l => l.id === 's') as any
    expect([s.x, s.y, s.w, s.h]).toEqual([0.3, 0.4, 0.6, 0.6])
    expect(s.fill).toBe(palette.accent)
  })
  it('sizes an existing path layer by scale from op.w (a path has no w)', () => {
    const path: any = { id: 's1', kind: 'path', x: .5, y: .5, rotation: 0, opacity: 1, d: 'M0 0h1v1z', bbox: { x: 0, y: 0, w: 0.3, h: 0.3 }, scale: 1, fill: '#000', fillRule: 'nonzero', stroke: '', strokeWidth: 0, shapeId: 'circle' }
    const out = applyPlacement([path], { did: 'x', ops: [{ target: 's1', kind: 'shape', x: .4, y: .6, w: .6, shapeId: 'circle', colorRole: 'accent' } as any] }, elements, palette)
    const s = out[0] as any
    expect(s.scale).toBeCloseTo(2)
    expect(s.w).toBeUndefined()
  })
  it('Shape counter moves the user\'s own shape layer (its real id), inserting no stand-in', () => {
    const title = textLayer('t', { text: 'NOISE', fontSize: 0.2 })
    const shape: any = { id: 'sh', kind: 'path', x: 0.2, y: 0.2, rotation: 0, opacity: 1, d: 'M0 0h1v1z', bbox: { x: 0, y: 0, w: 0.3, h: 0.3 }, scale: 1, fill: '#000', fillRule: 'nonzero', stroke: '', strokeWidth: 0, shapeId: 'circle' }
    const els = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }, { id: 'sh', kind: 'shape', shapeId: 'circle' }])
    expect(els.shapes[0]!.id).toBe('sh')
    const plan = planLayout({ props: { sailor_localLayers: [title, shape] }, frameW: 800, frameH: 1000, layoutId: 'shapeCounter', choice: { ...DEFAULT_CHOICE }, palette, connectedSlots: [], measure: makeStubMeasure() })!
    expect(plan).not.toBeNull()
    const moved = plan.layers.find(l => l.id === 'sh') as any
    expect(moved.x !== 0.2 || moved.y !== 0.2).toBe(true)
    expect(plan.layers.filter(l => l.kind === 'path')).toHaveLength(1)
  })
  it('last op for an id wins', () => {
    const layers: LocalLayer[] = [textLayer('t')]
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'title', kind: 'text', x: 0.1, y: 0.1, fontSize: 0.1 },
      { target: 'title', kind: 'text', x: 0.9, y: 0.15, fontSize: 0.12 },
    ] }
    const t = applyPlacement(layers, placement, elements, palette)[0] as any
    expect(t.x).toBe(0.9)
  })
  it('an op with no colorRole leaves the layer colour untouched', () => {
    const layers: LocalLayer[] = [textLayer('t', { color: '#abcdef' })]
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'title', kind: 'text', x: 0.2, y: 0.2, fontSize: 0.1 },
    ] }
    const t = applyPlacement(layers, placement, elements, palette)[0] as any
    expect(t.color).toBe('#abcdef')
  })
  it('with { recolour: false }, an existing layer keeps its colour even when the op carries a role', () => {
    const layers: LocalLayer[] = [
      textLayer('t', { color: '#abcdef' }),
      { id: 's', kind: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2, fill: '#334455', rotation: 0, opacity: 1 } as any,
    ]
    const els = {
      title: { role: 'title', id: 't', text: 'NOISE', words: ['NOISE'] },
      images: [], shapes: [{ id: 's', shapeId: 'circle' }], shapeMode: null,
    } as unknown as FrameElements
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'title', kind: 'text', x: 0.2, y: 0.3, fontSize: 0.25, colorRole: 'ink' },
      { target: 's', kind: 'shape', x: 0.3, y: 0.4, w: 0.6, h: 0.6, colorRole: 'accent', fill: 'solid', z: 0 },
    ] }
    const next = applyPlacement(layers, placement, els, palette, { recolour: false })
    const t = next.find(l => l.id === 't') as any
    const s = next.find(l => l.id === 's') as any
    expect(t.color).toBe('#abcdef')                // untouched
    expect(s.fill).toBe('#334455')                  // untouched
    expect([t.x, t.y]).toEqual([0.2, 0.3])          // geometry still applied
    expect(t.fontSize).toBe(0.25)
    expect([s.x, s.y, s.w, s.h]).toEqual([0.3, 0.4, 0.6, 0.6])
  })
  it('never mutates the input', () => {
    const layer = Object.freeze(textLayer('t'))
    const layers: LocalLayer[] = Object.freeze([layer]) as any
    const placement: PatternPlacement = { did: 'x', ops: [
      { target: 'title', kind: 'text', x: 0.2, y: 0.3, fontSize: 0.15, colorRole: 'accent' },
    ] }
    expect(() => applyPlacement(layers, placement, elements, palette)).not.toThrow()
    expect(layer.x).toBe(0.5)
    expect(layer.y).toBe(0.5)
    expect((layer as any).color).toBe('#000000')
  })
})

describe('applyPlacement — expressive fields', () => {
  const palette = { ink: '#111', accent: '#e33', field: '#eee' } as any
  const elements = { title: { role: 'title', id: 't', text: 'A B C', words: ['A', 'B', 'C'] }, images: [], shapes: [], shapeMode: null } as any
  const titleLayer = { id: 't', kind: 'text', text: 'A B C', x: 0.5, y: 0.5, fontSize: 0.1, align: 'left' } as any
  const ex: ExpressiveParams = { wordsPerLine: 1, placement: 'random', jitterX: 0.5, jitterY: 0, seed: 3 }

  it('writes expressive, valign and boxH onto the title layer', () => {
    const ops = [{ target: 'title', kind: 'text', x: 0.5, y: 0.5, w: 0.8, fontSize: 0.1, align: 'left', valign: 'justify', boxH: 1.0, expressive: ex }] as any
    const [out] = applyPlacement([titleLayer], { ops, did: 'x' }, elements, palette, { recolour: false })
    expect((out as any).expressive).toEqual(ex)
    expect((out as any).valign).toBe('justify')
    expect((out as any).boxH).toBe(1.0)
  })

  it('clears stale expressive/valign/boxH when a later flat op omits them', () => {
    const stale = { ...titleLayer, expressive: ex, valign: 'justify', boxH: 1.0 } as any
    const ops = [{ target: 'title', kind: 'text', x: 0.4, y: 0.3, w: 0.6, fontSize: 0.2, align: 'center' }] as any
    const [out] = applyPlacement([stale], { ops, did: 'x' }, elements, palette, { recolour: false })
    expect('expressive' in (out as any)).toBe(false)
    expect('valign' in (out as any)).toBe(false)
    expect('boxH' in (out as any)).toBe(false)
    expect((out as any).align).toBe('center')
  })
})

describe('applyPlacement — wired layer sizing', () => {
  const palette = { ink: '#111', accent: '#e33', field: '#eee' } as any
  const elements = { images: [{ id: 'w' }], shapes: [], shapeMode: null } as any
  const wired = { id: 'w', kind: 'wired', slot: 0, w: 0.5, lastAspect: 1, x: 0.5, y: 0.5 } as any

  it('writes w onto a wired layer and never a dead h', () => {
    const ops = [{ target: 'w', kind: 'image', x: 0.4, y: 0.3, w: 0.8, h: 1.2 }] as any
    const [out] = applyPlacement([wired], { ops, did: 'x' }, elements, palette, { recolour: false })
    expect((out as any).w).toBe(0.8)
    expect((out as any).x).toBe(0.4)
    expect('h' in (out as any)).toBe(false)   // wired height comes from lastAspect
  })

  it('a cover-cropped wired layer takes the layout box height, and loses it when the crop goes', () => {
    const cropOp = [{ target: 'w', kind: 'image', x: 0.4, y: 0.3, w: 0.8, h: 0.5, crop: { fit: 'cover' } }] as any
    const [a] = applyPlacement([wired], { ops: cropOp, did: 'x' }, elements, palette, { recolour: false })
    expect((a as any).h).toBe(0.5)
    expect((a as any).crop).toEqual({ fit: 'cover' })
    const plainOp = [{ target: 'w', kind: 'image', x: 0.4, y: 0.3, w: 0.8 }] as any
    const [b] = applyPlacement([a], { ops: plainOp, did: 'x' }, elements, palette, { recolour: false })
    expect('h' in (b as any)).toBe(false)
    expect('crop' in (b as any)).toBe(false)
  })
})

describe('applyPlacement — box fit while a layout holds (I5)', () => {
  const flow = { target: 'title', kind: 'text', x: 0.4, y: 0.3, w: 0.8, fontSize: 0.1, rotation: 0 } as const
  it('a shrink fit is set to plain wrap by a flow op, and comes back when a later op places the lines', () => {
    const layers: LocalLayer[] = [textLayer('t', { boxFit: 'shrink', boxW: 0.5 })]
    const a = applyPlacement(layers, { did: 'x', ops: [{ ...flow }] }, elements, palette)[0] as any
    // 'wrap' is the renderer's default: it draws at the size the layout approved, like the kit's measure.
    expect(a.boxFit).toBe('wrap')
    const b = applyPlacement([a], { did: 'x', ops: [{ ...flow, runs: [{ text: 'NOISE', x: -1, y: 0 }] }] }, elements, palette)[0] as any
    expect(b.boxFit).toBe('shrink')
    expect(b.layoutPrev?.boxFit).toBeUndefined()
  })
  it('a layer with no fit (or plain wrap) is left alone', () => {
    const a = applyPlacement([textLayer('t')], { did: 'x', ops: [{ ...flow }] }, elements, palette)[0] as any
    expect(a.boxFit).toBeUndefined()
    expect(a.layoutPrev).toBeUndefined()
  })
})

describe('applyPlacement — hidden (tracked visible)', () => {
  const palette = { ink: '#111', accent: '#e33', field: '#eee' } as any
  const elements = { title: { role: 'title', id: 't', text: 'NOISE', words: ['NOISE'] }, images: [], shapes: [], shapeMode: null } as any

  it('an op with hidden:true hides the layer and remembers what it was', () => {
    const layers: LocalLayer[] = [textLayer('t')]
    const [out] = applyPlacement(layers, { did: 'x', ops: [{ target: 'title', kind: 'text', hidden: true }] }, elements, palette)
    expect((out as any).visible).toBe(false)
    expect((out as any).layoutPrev.visible).toEqual({ was: null, set: false })
  })

  it('a later op without hidden restores visibility (key absent again)', () => {
    const layers: LocalLayer[] = [textLayer('t')]
    const a = applyPlacement(layers, { did: 'x', ops: [{ target: 'title', kind: 'text', hidden: true }] }, elements, palette)
    const [b] = applyPlacement(a, { did: 'x', ops: [{ target: 'title', kind: 'text', x: 0.5, y: 0.5, fontSize: 0.1 }] }, elements, palette)
    expect('visible' in (b as any)).toBe(false)
    expect('layoutPrev' in (b as any)).toBe(false)
  })

  it('a user edit to visible between two layouts is kept when the next op omits hidden', () => {
    const layers: LocalLayer[] = [textLayer('t')]
    const a = applyPlacement(layers, { did: 'x', ops: [{ target: 'title', kind: 'text', hidden: true }] }, elements, palette)
    const edited = [{ ...(a[0] as any), visible: true }]
    const [b] = applyPlacement(edited, { did: 'x', ops: [{ target: 'title', kind: 'text', x: 0.5, y: 0.5, fontSize: 0.1 }] }, elements, palette)
    expect((b as any).visible).toBe(true)
  })

  it('a hidden op with no x/y leaves the layer\'s position untouched', () => {
    const layers: LocalLayer[] = [textLayer('t', { x: 0.37, y: 0.61 })]
    const [out] = applyPlacement(layers, { did: 'x', ops: [{ target: 'title', kind: 'text', hidden: true }] }, elements, palette)
    expect((out as any).x).toBe(0.37)
    expect((out as any).y).toBe(0.61)
  })

  it('a hidden op changes nothing on the layer except visibility', () => {
    const layers: LocalLayer[] = [textLayer('t', { fontSize: 0.2, align: 'right', lineHeight: 1.4 })]
    const [out] = applyPlacement(layers, { did: 'x', ops: [{ target: 'title', kind: 'text', hidden: true }] }, elements, palette)
    expect((out as any).fontSize).toBe(0.2)
    expect((out as any).align).toBe('right')
    expect((out as any).lineHeight).toBe(1.4)
  })
})

describe('applyPlacement — image and shape rotation (I6)', () => {
  const els = {
    title: { role: 'title', id: 't', text: 'NOISE', words: ['NOISE'] },
    images: [{ id: 'img' }], shapes: [{ id: 's', shapeId: 'circle' }], shapeMode: null,
  } as unknown as FrameElements
  const img = { id: 'img', kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.5, rotation: 12, opacity: 1, src: 'x.png' } as any
  const shape = { id: 's', kind: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2, fill: '#000', rotation: -8, opacity: 1 } as any
  it('an op at rotation 0 straightens the layer; the user\'s angle comes back when an op leaves rotation unset', () => {
    const a = applyPlacement([img, shape], { did: 'x', ops: [
      { target: 'img', kind: 'image', x: 0.3, y: 0.3, w: 0.5, h: 0.5, rotation: 0 },
      { target: 's', kind: 'shape', x: 0.3, y: 0.3, w: 0.5, h: 0.5, rotation: 0 },
    ] }, els, palette)
    expect(a.map((l: any) => l.rotation)).toEqual([0, 0])
    const b = applyPlacement(a, { did: 'x', ops: [
      { target: 'img', kind: 'image', x: 0.3, y: 0.3, w: 0.5, h: 0.5 },
      { target: 's', kind: 'shape', x: 0.3, y: 0.3, w: 0.5, h: 0.5 },
    ] }, els, palette)
    expect(b.map((l: any) => l.rotation)).toEqual([12, -8])
  })
  it('the kit\'s image op carries rotation 0: a tilted image is straightened by a layout', () => {
    const title = textLayer('t', { text: 'Weather Report', fontSize: 0.12 })
    const plan = planLayout({ props: { sailor_localLayers: [title, img] }, frameW: 895, frameH: 1280, layoutId: 'runoff', choice: { ...DEFAULT_CHOICE }, palette, connectedSlots: [], measure: makeStubMeasure() })!
    expect(plan.issues).toEqual([])
    const out = plan.layers.find(l => l.id === 'img') as any
    expect(out.rotation).toBe(0)
    expect(out.layoutPrev.rotation).toEqual({ was: 12, set: 0 })
  })
})
