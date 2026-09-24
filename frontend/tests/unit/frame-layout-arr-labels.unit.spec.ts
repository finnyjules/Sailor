import { describe, it, expect } from 'vitest'
import { candidatesForFrame } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { CATALOG, LAYOUTS, layoutsForStyle } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import type { Kind, LayoutDef } from '~/lib/frame/patterns/kit/types'
import type { StyleId } from '~/lib/frame/patterns/kit/styles'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { adFrameLayers, eventFrameLayers, frameLayers, galleryFrameLayers, palette } from './helpers/frameLayoutFixtures'

// Frame layout decisions, Task 5: the Arrangement pills are words, named by each layout
// (`LayoutDef.arrLabels`), never A / B / C.
//
// "Can vary", worked out two ways:
//   1. Statically (every layout, exact in the "cannot" direction): a layout's `fn` is pure in its
//      context, and `arr` reaches it only as `ctx.arr` or through the seeded `r` (its seed moves
//      with `arr`, `plan.ts` `seedFor`). A layout whose `fn` reads neither never varies its
//      arrangement, so `enumerate` (`vary.ts`, `arrVaries`) never offers the row. Every layout
//      that reads either must name its arrangements; every one that reads neither must not.
//   2. By running (the way the pills do): across a spread of Frames, the `arr` values present among
//      a layout's candidates — exactly the values the Choices row shows — each have a label. A
//      two-arrangement layout (one whose arr 2 runs the same as arr 0, so `enumerate`'s signature
//      check drops it) must never surface arr 2.

/** The context names a layout's `fn` destructures from its second parameter. */
function ctxNames(def: LayoutDef): string[] {
  const m = def.fn.toString().match(/^\s*(?:fn\s*)?\(\s*\w+\s*,\s*\{([^}]*)\}/)
  expect(m, `${def.id}: fn destructures its context`).not.toBeNull()
  return m![1]!.split(',').map(s => s.split('=')[0]!.split(':')[0]!.trim()).filter(Boolean)
}
const readsArr = (def: LayoutDef) => ctxNames(def).some(n => n === 'arr' || n === 'r')

describe('Arrangement labels — every layout names its own arrangements', () => {
  it('a layout whose fn reads arr (or the seeded r) has labels; one that reads neither has none', () => {
    const named = CATALOG.filter(readsArr).map(d => d.id)
    // Pinned so a new arrangement-reading layout is noticed here.
    expect(named).toEqual(['runoff', 'statement', 'ragged', 'diagonal', 'scatter',
      'perfOffer', 'perfSticker', 'perfPriceTag', 'perfCard', 'edFramed', 'edDiptych', 'stFill'])
    for (const def of CATALOG) {
      if (readsArr(def)) expect(def.arrLabels, def.id).toBeDefined()
      else expect(def.arrLabels, def.id).toBeUndefined()
    }
  })

  it('labels are 2–3 per layout, sentence case, at most 14 characters, distinct, and never letters', () => {
    for (const def of CATALOG) {
      const labels = def.arrLabels
      if (!labels) continue
      expect(labels.length, def.id).toBeGreaterThanOrEqual(2)
      expect(labels.length, def.id).toBeLessThanOrEqual(3)          // `vary.ts` offers arr 0, 1, 2
      expect(new Set(labels).size, `${def.id}: distinct`).toBe(labels.length)
      for (const l of labels) {
        expect(l.length, `${def.id}: "${l}"`).toBeLessThanOrEqual(14)
        expect(l, `${def.id}: "${l}" is sentence case`).toMatch(/^[A-Z][^A-Z]*$/)
        expect(l, `${def.id}: "${l}" is a word, not a letter`).not.toMatch(/^[A-Z]$/)
        expect(l.toLowerCase(), `${def.id}: "${l}" says image`).not.toContain('photo')
      }
    }
  })

  // ── by running: the arr values the pills would show ──
  type Frame = { w: number; h: number }
  const FRAMES: Frame[] = [{ w: 895, h: 1280 }, { w: 1080, h: 1080 }, { w: 1280, h: 720 }]
  const KINDS: Kind[] = ['word', 'phrase', 'sentence']
  const RUNS: { style: StyleId | undefined; defs: LayoutDef[]; layers: (def: LayoutDef, kind: Kind, image: boolean) => LocalLayer[] }[] = [
    { style: undefined, defs: LAYOUTS, layers: (def, kind, image) => frameLayers(kind, { image, shape: !!def.needs?.shape }) },
    { style: 'performance', defs: layoutsForStyle('performance'), layers: (_d, kind, image) => adFrameLayers(kind, { image, action: true }) },
    { style: 'editorial', defs: layoutsForStyle('editorial'), layers: (_d, kind, image) => galleryFrameLayers(kind, { image, action: true }) },
    { style: 'street', defs: layoutsForStyle('street'), layers: (_d, kind, image) => eventFrameLayers(kind, { image, action: true }) },
  ]

  it('every arr value a layout\'s candidates offer has a label; a layout without labels never offers two', () => {
    const seen = new Map<string, Set<number>>()
    for (const run of RUNS) {
      for (const def of run.defs) {
        const got = seen.get(def.id) ?? new Set<number>()
        for (const f of FRAMES) for (const kind of def.fits.filter(k => KINDS.includes(k))) for (const image of [false, true]) {
          const a: Omit<LayoutPlanArgs, 'choice'> = {
            props: { sailor_localLayers: run.layers(def, kind, image) },
            frameW: f.w, frameH: f.h, layoutId: def.id, palette, connectedSlots: [], measure: makeStubMeasure(),
            ...(run.style ? { style: run.style } : {}),
          }
          for (const c of candidatesForFrame(a)) got.add(c.choice.arr)
        }
        seen.set(def.id, got)
      }
    }
    for (const [id, arrs] of seen) {
      const def = CATALOG.find(d => d.id === id)!
      if (!def.arrLabels) { expect(arrs.size, `${id}: no labels, so its arrangement never varies`).toBeLessThanOrEqual(1); continue }
      for (const v of arrs) expect(def.arrLabels[v], `${id}: arr ${v} has a label`).toBeDefined()
    }
    // Every labelled layout is reached here, each with exactly as many arrangements as it names
    // (so no label is for an arrangement that never shows): measured 12 of 12.
    for (const def of CATALOG.filter(d => d.arrLabels)) {
      expect(seen.get(def.id)?.size, `${def.id}: every label is reachable`).toBe(def.arrLabels!.length)
    }
  })
})
