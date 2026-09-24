import { describe, it, expect } from 'vitest'
import { applyPlacement } from '~/lib/frame/patterns/apply'
import { candidatesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { localStackKey } from '~/lib/compositor/frameStack'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { boxOf, checkPlan } from '~/lib/frame/patterns/kit/check'
import type { El } from '~/lib/frame/patterns/kit/types'
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

describe('Overprint and Number behind with recolour off: the big line is the layout\'s accent copy (ruling D2)', () => {
  const copyOf = (ls: LocalLayer[]) => ls.filter(l => (l as { owner?: { by: string; key: string } }).owner?.key?.startsWith('copy')) as any[]
  const bare = (t: string) => t.replace(/\s/g, '')
  const CASES = [['overprint', 'd', 'details'], ['dateBehind', 'dt', 'date']] as const
  const FRAMES: [number, number][] = [[895, 1280], [1080, 1080], [1280, 720]]

  describe.each([false, true])('image: %s', (image) => {
    const layers = frameLayers('phrase', { image, shape: false })

    it.each(CASES)('%s: the big element is owned, in the accent, in the copied line\'s face, weight and size', (id, lineId, role) => {
      const a = argsFor(layers, id)
      const cand = candidatesForFrame(a)[0]!
      const plan = planLayout({ ...a, choice: cand.choice })!
      expect(plan.issues).toEqual([])
      const copies = copyOf(plan.layers)
      expect(copies).toHaveLength(1)
      const copy = copies[0]!
      const user = layers.find(l => l.id === lineId) as any
      expect(copy.owner).toEqual({ by: 'layout', key: 'copy-0' })
      expect(copy.color).toBe(palette.accent)
      expect([copy.fontFamily, copy.fontWeight]).toEqual([user.fontFamily, user.fontWeight])
      expect(bare(copy.text)).toBe(bare(user.text))
      expect(bare(copy.runs.map((r: { text: string }) => r.text).join(''))).toBe(bare(user.text))
      // Exactly the big line the layout sets: the `copy` element's size and place.
      const big = cand.out.els.find(e => e.k === 't' && e.copy)
      if (big?.k !== 't') throw new Error('no copy element')
      expect(big.role).toBe(role)
      expect(copy.fontSize).toBeCloseTo(big.size / 100, 12)
    })

    it.each(CASES)('%s: the user\'s line is visible, small, in its own colour, and clear of the title', (id, lineId, role) => {
      for (const [w, h] of FRAMES) {
        const a = { ...argsFor(layers, id), frameW: w, frameH: h }
        const S = makeSheet({ frameW: w, frameH: h, measure: makeStubMeasure() })
        const cands = candidatesForFrame(a)
        expect(cands.length, `${w}×${h}`).toBeGreaterThan(0)
        for (const cand of cands) {
          const plan = planLayout({ ...a, choice: cand.choice })!
          expect(plan.issues).toEqual([])
          const line = plan.layers.find(l => l.id === lineId) as any
          const copy = copyOf(plan.layers)[0]!
          expect(line.visible).not.toBe(false)
          expect(line.color).toBe((layers.find(l => l.id === lineId) as any).color)
          expect(line.fontSize).toBeLessThan(copy.fontSize / 2)
          const small = cand.out.els.find(e => e.k === 't' && !e.copy && e.role === role)!
          const title = cand.out.els.filter(e => e.k === 't' && (e.role ?? '').replace(/\d+$/, '') === 'title')
          const sb = boxOf(small, S)!
          for (const t of title) {
            const tb = boxOf(t, S)!
            const cross = Math.min(sb.x1, tb.x1) - Math.max(sb.x0, tb.x0) > 0 && Math.min(sb.y1, tb.y1) - Math.max(sb.y0, tb.y0) > 0
            expect(cross, `${w}×${h} ${JSON.stringify(cand.choice)}`).toBe(false)
          }
        }
      }
    })
  })

  it('Number behind: the title is drawn over the accent number', () => {
    const plan = planFirst(frameLayers('phrase', { image: false, shape: false }), 'dateBehind')
    const at = (lid: string) => plan.order.indexOf(localStackKey(lid))
    expect(at(copyOf(plan.layers)[0]!.id)).toBeLessThan(at('t'))
  })

  it.each(['overprint', 'dateBehind'])('%s with recolour on: no copy; the big line is the user\'s own layer', (id) => {
    const layers = frameLayers('phrase', { image: false, shape: false })
    const plan = planFirst(layers, id, { recolour: true })
    expect(copyOf(plan.layers)).toEqual([])
    const line = plan.layers.find(l => l.id === (id === 'overprint' ? 'd' : 'dt')) as any
    expect(line.color).toBe(palette.accent)
    expect(line.runs?.length).toBeGreaterThan(0)
  })

  it('a line with no colour of its own reads as the renderer\'s black: the copy is drawn, and skipped against a black accent', () => {
    const noColour = frameLayers('phrase', { image: false, shape: false }).map((l) => {
      if (l.id !== 'd') return l
      const { color: _c, ...rest } = l as any
      return rest
    }) as LocalLayer[]
    expect(copyOf(planFirst(noColour, 'overprint').layers)).toHaveLength(1)
    expect(copyOf(planFirst(noColour, 'overprint', { palette: { ...palette, accent: '#000000' } }).layers)).toEqual([])
  })

  it('the next layout removes the copy', () => {
    const over = planFirst(frameLayers('phrase', { image: false, shape: false }), 'overprint')
    expect(copyOf(over.layers)).toHaveLength(1)
    expect(copyOf(planFirst(over.layers, 'statement').layers)).toEqual([])
  })

  it('an accent the line already wears (or all but), or a colour that is not plain, draws no copy: today\'s one-colour layout', () => {
    const base = frameLayers('phrase', { image: false, shape: false })
    const on = planFirst(base, 'overprint', { recolour: true })
    for (const color of [palette.accent, '#dc2301', 'rgb(1, 2, 3)']) {
      const layers = base.map(l => (l.id === 'd' ? { ...l, color } : l)) as LocalLayer[]
      const plan = planFirst(layers, 'overprint')
      expect(copyOf(plan.layers), color).toEqual([])
      // The same geometry as recolour on (the big details are the user's own layer).
      const d = plan.layers.find(l => l.id === 'd') as any
      expect(d.runs, color).toEqual((on.layers.find(l => l.id === 'd') as any).runs)
    }
  })
})

describe('the overlap premise reads the accent copy (ruling D2)', () => {
  it('the copy is the element the premise names, even when the user\'s small line of the role comes first', () => {
    const S = makeSheet({ frameW: 895, frameH: 1280, measure: makeStubMeasure() })
    const title: El = { k: 't', s: 'Weather', x: 10, top: 40, size: 12, ls: 0, lh: 1, role: 'title', pre: true, over: ['detailsCopy'] }
    const small: El = { k: 't', s: 'Ines Vollmer', x: 10, w: 30, top: 120, size: 3, ls: 0, lh: 1.2, role: 'details' }
    const copy: El = { k: 't', s: 'Ines', x: 10, top: 45, size: 12, ls: 0, lh: 1, role: 'details', pre: true, over: ['title'], copy: true }
    const premise = { overlap: [['title', 'details']] as [string, string][] }
    expect(checkPlan([title, small, copy], S, premise)).toEqual([])
    // Without the copy, the small line alone does not cross the title: the promise is broken.
    expect(checkPlan([title, small], S, premise)).toContain('promise broken: title should overlap details')
  })
})
