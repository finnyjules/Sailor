import { describe, it, expect } from 'vitest'
import { applyPlacement } from '~/lib/frame/patterns/apply'
import { candidatesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { localStackKey } from '~/lib/compositor/frameStack'
import { createPathLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { FrameElements } from '~/lib/frame/patterns/types'
import { frameLayers, palette } from './helpers/frameLayoutFixtures'

// ═══════════════════ Frame layout decisions, Task 4 ═══════════════════
// 1. Knockout remembers the shape: the size and place a layout gives the user's shape are
//    remembered like every other layout-set field, and a later layout that does not place the
//    shape gives it back (an ellipse comes back an ellipse, at its own size).
// 2. Overprint and Number behind, recolour off: an owned accent copy of the overlapping line
//    under the user's line, which keeps its own colour. Recolour on: no copy.

const base = { frameW: 895, frameH: 1280, connectedSlots: [], measure: makeStubMeasure() }
type Args = Omit<LayoutPlanArgs, 'choice'>
const argsFor = (layers: LocalLayer[], layoutId: string, extra: Partial<LayoutPlanArgs> = {}): Args =>
  ({ ...base, palette, props: { sailor_localLayers: layers }, layoutId, ...extra })
/** Plan a layout's first candidate on `layers`. */
const planFirst = (layers: LocalLayer[], layoutId: string, extra: Partial<LayoutPlanArgs> = {}) => {
  const a = argsFor(layers, layoutId, extra)
  const cands = candidatesForFrame(a)
  expect(cands.length, `${layoutId} offers nothing`).toBeGreaterThan(0)
  const plan = planLayout({ ...a, choice: cands[0]!.choice })!
  expect(plan.issues).toEqual([])
  return plan
}
const geometry = (l: any) => ({ kind: l.kind, x: l.x, y: l.y, w: l.w, h: l.h, rotation: l.rotation })
const shapeOf = (layers: LocalLayer[]) => layers.find(l => l.id === 'shp') as any

describe('applyPlacement — a shape a layout resized comes back when a later layout does not place it', () => {
  const els = { title: { role: 'title', id: 't', text: 'NOISE', words: ['NOISE'] }, images: [], shapes: [{ id: 's' }], shapeMode: null } as unknown as FrameElements
  const ellipse = { id: 's', kind: 'ellipse', x: 0.3, y: 0.4, w: 0.3, h: 0.3, rotation: -8, opacity: 1, fill: '#ef4444' } as any
  const band = { target: 's', kind: 'shape', x: 0.5, y: 0.2, w: 1, h: 0.1, rotation: 0 } as any

  it('the band is remembered; an apply with no op for the shape gives back its place, size and angle', () => {
    const [a] = applyPlacement([ellipse], { did: 'x', ops: [band] }, els, palette)
    expect(geometry(a)).toEqual({ kind: 'ellipse', x: 0.5, y: 0.2, w: 1, h: 0.1, rotation: 0 })
    const [b] = applyPlacement([a!], { did: 'x', ops: [] }, els, palette)
    expect(geometry(b)).toEqual(geometry(ellipse))
    expect('layoutPrev' in (b as any)).toBe(false)
  })

  it('a size the user set after the layout is kept; what they did not touch comes back', () => {
    const [a] = applyPlacement([ellipse], { did: 'x', ops: [band] }, els, palette)
    const [b] = applyPlacement([{ ...(a as any), w: 0.6 }], { did: 'x', ops: [] }, els, palette)
    expect((b as any).w).toBe(0.6)
    expect((b as any).h).toBe(0.3)
    expect([(b as any).x, (b as any).y]).toEqual([0.3, 0.4])
  })

  it('a path shape gets its own scale back', () => {
    const path = createPathLayer({ id: 's', x: 0.3, y: 0.4, bbox: { w: 0.3, h: 0.3 }, scale: 1.2 }) as any
    const [a] = applyPlacement([path], { did: 'x', ops: [{ ...band, w: 0.1, h: 0.1 }] }, els, palette)
    expect((a as any).scale).toBeCloseTo(0.1 / 0.3, 12)
    const [b] = applyPlacement([a!], { did: 'x', ops: [] }, els, palette)
    expect((b as any).scale).toBe(1.2)
    expect([(b as any).x, (b as any).y]).toEqual([0.3, 0.4])
    expect('layoutPrev' in (b as any)).toBe(false)
  })

  it('an untargeted text or image layer is still left exactly as it is', () => {
    const hid = { id: 'q', kind: 'text', x: 0.1, y: 0.1, visible: false, layoutPrev: { visible: { was: null, set: false } } } as any
    const [out] = applyPlacement([hid], { did: 'x', ops: [] }, els, palette)
    expect(out).toBe(hid)
  })
})

describe('Knockout → a layout that leaves the shape alone (planner)', () => {
  // The fixture's ellipse, in a red the title reads on (Knockout sets the title on the shape).
  const start = frameLayers('phrase', { image: false, shape: true }).map(l => (l.id === 'shp' ? { ...l, fill: '#ef4444', x: 0.3, y: 0.7, w: 0.3, h: 0.3 } : l)) as LocalLayer[]

  it('the ellipse comes back an ellipse, at its own size and place', () => {
    const ko = planFirst(start, 'knockout')
    const banded = shapeOf(ko.layers)
    expect(banded.w).toBeGreaterThan(0.9)                  // a full-width band
    expect(banded.h).not.toBe(0.3)
    const next = planFirst(ko.layers, 'statement')
    expect(geometry(shapeOf(next.layers))).toEqual(geometry(shapeOf(start)))
    expect(shapeOf(next.layers).layoutPrev).toBeUndefined()
  })

  it('through Bleed (which places the shape itself) and back: still the user\'s own geometry', () => {
    const ko = planFirst(start, 'knockout')
    const bleed = planFirst(ko.layers, 'shapeBleed')
    expect(shapeOf(bleed.layers).w).toBe(shapeOf(bleed.layers).h)   // Bleed's circle
    const next = planFirst(bleed.layers, 'statement')
    expect(geometry(shapeOf(next.layers))).toEqual(geometry(shapeOf(start)))
  })

  it('a resize the user made after Knockout is kept by the next layout', () => {
    const ko = planFirst(start, 'knockout')
    const edited = ko.layers.map(l => (l.id === 'shp' ? { ...l, w: 0.5, h: 0.2 } : l)) as LocalLayer[]
    const shp = shapeOf(planFirst(edited, 'statement').layers)
    expect([shp.w, shp.h]).toEqual([0.5, 0.2])
  })
})

describe('Overprint and Number behind: an accent copy of the overlapping line with recolour off', () => {
  const layers = frameLayers('phrase', { image: false, shape: false })
  const copyOf = (ls: LocalLayer[]) => ls.filter(l => (l as { owner?: { by: string; key: string } }).owner?.key?.startsWith('copy')) as any[]

  it.each([['overprint', 'd'], ['dateBehind', 'dt']] as const)('%s: an owned copy of the line in the accent, under it, the same words, face, weight and size', (id, lineId) => {
    const plan = planFirst(layers, id)
    const copies = copyOf(plan.layers)
    expect(copies).toHaveLength(1)
    const copy = copies[0]!
    const line = plan.layers.find(l => l.id === lineId) as any
    const user = layers.find(l => l.id === lineId) as any
    expect(copy.owner).toEqual({ by: 'layout', key: 'copy-0' })
    expect(copy.color).toBe(palette.accent)
    // The user's line keeps its own colour.
    expect(line.color).toBe(user.color)
    // Same words, face, weight and size, set exactly where the user's line is.
    expect(copy.runs).toEqual(line.runs)
    const bare = (t: string) => t.replace(/\s/g, '')
    expect(bare(copy.runs.map((r: { text: string }) => r.text).join(''))).toBe(bare(user.text))
    expect([copy.fontFamily, copy.fontWeight]).toEqual([user.fontFamily, user.fontWeight])
    for (const k of ['fontSize', 'x', 'y', 'rotation', 'lineHeight', 'letterSpacing', 'blend', 'opacity'] as const) expect(copy[k], k).toEqual(line[k])
    // Drawn directly under the user's line.
    const at = (lid: string) => plan.order.indexOf(localStackKey(lid))
    expect(at(copy.id)).toBeGreaterThanOrEqual(0)
    expect(at(copy.id)).toBe(at(lineId) - 1)
  })

  it.each(['overprint', 'dateBehind'])('%s with recolour on: no copy (the line itself takes the accent)', (id) => {
    const plan = planFirst(layers, id, { recolour: true })
    expect(copyOf(plan.layers)).toEqual([])
  })

  it('the next layout removes the copy', () => {
    const over = planFirst(layers, 'overprint')
    expect(copyOf(over.layers)).toHaveLength(1)
    expect(copyOf(planFirst(over.layers, 'statement').layers)).toEqual([])
  })

  it('an accent the line already wears (or all but) draws no copy', () => {
    const same = layers.map(l => (l.id === 'd' ? { ...l, color: palette.accent } : l)) as LocalLayer[]
    expect(copyOf(planFirst(same, 'overprint').layers)).toEqual([])
    const near = layers.map(l => (l.id === 'd' ? { ...l, color: '#dc2301' } : l)) as LocalLayer[]
    expect(copyOf(planFirst(near, 'overprint').layers)).toEqual([])
  })

  it('the candidates are the same with recolour on and off (the copy is not checked on its own: it is the line\'s own box)', () => {
    for (const id of ['overprint', 'dateBehind']) {
      const off = candidatesForFrame(argsFor(layers, id)).map(c => c.choice)
      const on = candidatesForFrame(argsFor(layers, id, { recolour: true })).map(c => c.choice)
      expect(off, id).toEqual(on)
    }
  })
})
