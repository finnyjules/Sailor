import { describe, it, expect } from 'vitest'
import { candidatesForFrame, planLayout, EXTRA_MIN_TILE, NO_ROOM_FOR_IMAGES } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { freeRects, inkBoxOf } from '~/lib/frame/patterns/kit/check'
import type { Box } from '~/lib/frame/patterns/kit/check'
import { CATALOG, layoutsForStyle } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import type { El, PhotoEl } from '~/lib/frame/patterns/kit/types'
import type { StyleId } from '~/lib/frame/patterns/kit/styles'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import { createImageLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { frameLayers, palette } from './helpers/frameLayoutFixtures'

// ═══════════════════════ every layout places the extra images (layout decisions, Task 7) ═══════════════════════
// A Frame image a layout does not place — beyond the first (`image`), and the second where a layout
// uses it (Before / after's `image2`) — is placed by the planner after the layout: equal tiles, one
// row or one column, in the largest free rectangle inside the content area (the margins; on a format,
// the band its keep-clear areas leave) that clears every placed element by the kit's gap. A tile is
// at least 12% of the frame's width; with no such room the variation is refused, "no room for the
// other images". This replaces Stage 4's ruling R14 (hide the second image and name it).

type Frame = { id: string; w: number; h: number; preset?: string }
const fmt = (id: string): Frame => { const f = FRAME_FORMATS.find(x => x.id === id)!; return { id, w: f.w, h: f.h, preset: id } }
const FRAMES: Frame[] = [
  { id: 'portrait', w: 895, h: 1280 },
  { id: 'square', w: 1080, h: 1080 },
  fmt('meta-story'),
  fmt('ad-300x250'),
]
const STYLES: StyleId[] = ['swiss', 'performance', 'editorial', 'street']

/** A wired image (a studio's live output) — its height follows its content unless it is cropped. */
const wired = (id: string): LocalLayer => ({ id, kind: 'wired', slot: 0, w: 0.4, lastAspect: 1.25, x: 0.7, y: 0.7, rotation: 0, opacity: 1 } as unknown as LocalLayer)
/** The lab Frame: a title, a name, a date range, a caption, one image and one wired image. */
const labFrame = (): LocalLayer[] => [...frameLayers('phrase', { image: true, shape: false }), wired('wired')]
const oneImage = (): LocalLayer[] => frameLayers('phrase', { image: true, shape: false })

const argsFor = (id: string, f: Frame, layers: LocalLayer[], style: StyleId): Omit<LayoutPlanArgs, 'choice'> => ({
  props: { sailor_localLayers: layers, ...(f.preset ? { sailor_frame: { preset: f.preset } } : {}) },
  frameW: f.w, frameH: f.h, layoutId: id, palette, connectedSlots: [], measure: makeStubMeasure(),
  ...(style === 'swiss' ? {} : { style }),
})
const DEFAULT = { lines: 0, arr: 0, scale: 'full', side: 'right' } as const

/** The content area a tile must lie in: the kit margin, inside the band a format's keep-clear
 *  areas leave. */
function contentArea(f: Frame): Box {
  const format = f.preset ? FRAME_FORMATS.find(x => x.id === f.preset)! : null
  const S = makeSheet({ frameW: f.w, frameH: f.h, measure: makeStubMeasure(), ...(format ? { format: { view: format.view, nc: format.nc, ...(format.keep ? { keepSide: Math.max(format.keep.left, format.keep.right) } : {}) } } : {}) })
  const keep = format?.keep
  return { x0: S.M, x1: 100 - S.M, y0: (keep ? S.H * keep.top : 0) + S.M, y1: (keep ? S.H * (1 - keep.bottom) : S.H) - S.M }
}

// ── The lab Frame's layouts, pinned (measured with the stub measure) ──
// Per style and frame: each layout offered on the two-image lab Frame, as [variations with two
// images, variations with one image, the first variation's tile (x, y, w, h, kit units, to 0.1)],
// and the layouts offered with one image that two images lose.
//
// Offered, one image → two: Swiss 35 → 32 (the story 32 → 29; the lab Frame has no shape, so the
// five shape layouts are not offered either way), Performance 5 → 0 (300×250: 4 → 0), Editorial
// 4 → 2, Street 4 → 3.
//
// Every lost layout covers the whole content area, so there is no free room at all (measured: the
// largest free rectangle has no height): Full bleed, Editorial's Cover and Street's Tag bleed their
// image over the page (100 × 125 on the square); Panel, Side split, Price tag and Diptych set a
// panel on that cover image; Offer, Card and Centred set bands on it; Offer first fills the page
// with its panel (the top 33.1) and the image under it. Performance loses everything: each of its
// layouts is built on the cover image.
//
// Variations lost inside a layout still offered (their best free room's shorter side, under 12):
// Statement on the portrait 6 of 14 (4.1–7.7), Bottom heavy 2 of 8 (7.7), Split 1 of 4 (7.4),
// Footer 3 of 7 (4.1–7.7), Rising on the square 1 of 4 (4.7), Split on the story 1 of 4 (11.9),
// Street's Fill on the portrait 6 of 12 (7.6).
type Pin = { offered: Record<string, [number, number, number[]]>; lost: string[] }
const PINNED: Record<string, Pin> = {
  'swiss|portrait': {
    offered: {
      runoff: [8, 8, [4, 99.9, 92, 31]], statement: [8, 14, [4, 9.6, 27, 83.7]],
      index: [4, 4, [69, 22.6, 27, 104.7]], photoBehind: [2, 2, [4, 25.4, 16.9, 108]],
      tilt: [2, 2, [49.6, 111, 46.4, 28]], bottomHeavy: [6, 8, [69, 15.9, 27, 77.4]],
      fourCorners: [8, 8, [4, 11.3, 50.4, 56]], spacedLines: [2, 2, [4, 22.3, 92, 85.3]],
      ragged: [6, 6, [4, 4, 34.8, 69.5]], edges: [4, 4, [4, 4, 42.6, 63.3]],
      staircase: [2, 2, [76.8, 40.1, 19.2, 90.8]], block: [2, 2, [4, 49.7, 27, 83.7]],
      split: [3, 4, [36.3, 75.7, 59.7, 15.7]], diagonal: [8, 8, [45.6, 9.6, 50.4, 48.5]],
      wall: [2, 2, [4, 49.8, 27, 83.6]], scatter: [3, 3, [65.9, 89.6, 30.1, 41.3]],
      cells: [2, 2, [4, 84.3, 58.2, 49.1]], kicker: [4, 4, [4, 4, 19.2, 89.9]],
      sidebar: [4, 4, [69, 22.3, 27, 116.8]], footer: [4, 7, [4, 49.7, 27, 83.7]],
      plate: [4, 4, [75.7, 22.3, 20.3, 68.2]], cross: [1, 1, [4, 90, 92, 40.9]],
      overlap: [4, 4, [4, 106.1, 92, 24.8]], stamp: [4, 4, [4, 11.3, 66, 71.8]], column: [2, 2, [4, 60.9, 92, 78.1]],
      rising: [4, 4, [4, 49.7, 92, 17.9]], overprint: [8, 8, [4, 13.4, 58.2, 37]],
      dateBehind: [8, 8, [4, 67.3, 42.6, 66.1]], tightStack: [8, 8, [4, 75.7, 50.4, 57.7]],
      behindPhoto: [2, 2, [4, 85.8, 92, 45.1]], label: [4, 4, [75.7, 4, 20.3, 93.6]],
      ghost: [4, 4, [4, 4, 42.6, 63.3]],
    },
    lost: ['fullBleed', 'panel', 'sideSplit'],
  },
  'swiss|square': {
    offered: {
      runoff: [6, 6, [4, 4, 59.4, 44.1]], statement: [16, 16, [4, 8, 59.4, 43.6]],
      index: [8, 8, [44.4, 34.3, 51.6, 51.3]], photoBehind: [2, 2, [4, 20.1, 40.8, 69.8]],
      tilt: [4, 4, [16, 9.5, 16.2, 77.2]], bottomHeavy: [8, 8, [36.6, 13.3, 59.4, 39.6]],
      fourCorners: [8, 8, [4, 9.5, 59.4, 37.7]], spacedLines: [2, 2, [4, 20.4, 92, 45.2]],
      ragged: [6, 6, [4, 4, 59.4, 37.4]], edges: [4, 4, [4, 4, 59.4, 43.1]],
      staircase: [2, 2, [44.4, 38.8, 51.6, 51]], block: [2, 2, [4, 48.3, 59.4, 43.6]],
      split: [4, 4, [73.7, 52.9, 22.3, 43.1]], diagonal: [8, 8, [30.3, 8, 65.7, 28.9]],
      wall: [2, 2, [4, 47.7, 59.4, 44.2]], scatter: [6, 6, [37.6, 4, 25.7, 43.1]],
      cells: [4, 4, [4, 56.1, 67.1, 33.8]], kicker: [4, 4, [4, 4, 43.8, 58.1]],
      sidebar: [6, 6, [52.2, 34.3, 43.8, 61.7]], footer: [8, 8, [4, 47.1, 59.4, 44.9]],
      plate: [4, 4, [52.9, 16.5, 43.1, 46.4]], cross: [1, 1, [28.4, 80.8, 67.6, 15.2]],
      overlap: [4, 4, [4, 56.3, 37.9, 33.5]], stamp: [4, 4, [4, 9.5, 67.1, 34.6]],
      column: [2, 2, [36.6, 30.8, 59.4, 65.2]], rising: [3, 4, [80.2, 4, 15.8, 42.7]],
      overprint: [8, 8, [57.9, 34.4, 38.1, 61.6]], dateBehind: [8, 8, [4, 47.1, 59.4, 44.9]],
      tightStack: [8, 8, [4, 52.9, 67.1, 37]], behindPhoto: [2, 2, [28.4, 77.9, 67.6, 18.1]],
      label: [4, 4, [60.7, 4, 35.3, 92]], ghost: [4, 4, [4, 4, 59.4, 43.1]],
    },
    lost: ['fullBleed', 'panel', 'sideSplit'],
  },
  'swiss|meta-story': {
    offered: {
      statement: [16, 16, [6, 37.7, 54.7, 27.4]], index: [8, 8, [39.3, 60.7, 54.7, 36.5]],
      photoBehind: [2, 2, [6, 47.8, 41.5, 51.9]], tilt: [4, 4, [19, 39.5, 26.7, 55.8]],
      bottomHeavy: [8, 8, [31.8, 48.2, 62.2, 21.8]], fourCorners: [8, 8, [54.8, 67.8, 39.2, 41.8]],
      spacedLines: [2, 2, [6, 49, 62.2, 42.5]], ragged: [6, 6, [6, 30.9, 62.2, 29.2]],
      edges: [4, 4, [6, 30.9, 54.7, 34.2]], staircase: [2, 2, [39.3, 66.5, 54.7, 30.2]],
      block: [2, 2, [6, 74.5, 54.7, 28.2]], split: [3, 4, [61.5, 75.4, 32.5, 24.4]],
      diagonal: [8, 8, [76.3, 37.7, 17.7, 71.9]], wall: [2, 2, [6, 75, 54.7, 27.8]],
      scatter: [6, 6, [40, 30.9, 20.7, 34.2]], cells: [4, 4, [6, 80.5, 54.7, 22.3]],
      kicker: [4, 4, [6, 30.9, 47.2, 45.4]], sidebar: [8, 8, [46.8, 62.2, 47.2, 47.3]],
      footer: [8, 8, [6, 70.5, 54.7, 32.3]], plate: [4, 4, [68.5, 55.7, 25.5, 53.9]],
      overlap: [4, 4, [6, 78.4, 41.6, 21.4]], stamp: [4, 4, [6, 39.5, 63.2, 16.9]],
      column: [2, 2, [39.3, 58.9, 54.7, 50.7]], rising: [4, 4, [78.8, 30.9, 15.2, 29]],
      overprint: [8, 8, [54.8, 61.9, 39.2, 47.7]], dateBehind: [8, 8, [6, 70.5, 54.7, 32.3]],
      tightStack: [8, 8, [6, 75.4, 54.7, 27.4]], behindPhoto: [2, 2, [76.7, 79.7, 17.3, 29.9]],
      label: [4, 4, [51.9, 30.9, 42.1, 78.7]],
    },
    lost: ['fullBleed', 'panel', 'sideSplit'],
  },
  'swiss|ad-300x250': {
    offered: {
      runoff: [6, 6, [4, 4, 67.6, 34.2]], statement: [16, 16, [4, 8.5, 59.8, 30.9]],
      index: [8, 8, [36.2, 32.3, 59.8, 37.1]], photoBehind: [2, 2, [4, 18, 50.1, 53]],
      tilt: [4, 4, [13.8, 9.7, 42.2, 55.4]], bottomHeavy: [8, 8, [20.7, 22.1, 75.3, 21.9]],
      fourCorners: [8, 8, [4, 9.7, 67.6, 29.6]], spacedLines: [2, 2, [4, 19.9, 67.6, 43.5]],
      ragged: [6, 6, [4, 4, 67.6, 30.6]], edges: [2, 2, [4, 4, 67.6, 35.3]],
      staircase: [2, 2, [28.4, 38.3, 67.6, 28.8]], block: [2, 2, [4, 43.1, 59.8, 31.8]],
      split: [4, 4, [50.9, 44, 45.1, 27]], diagonal: [8, 8, [28.4, 9.7, 67.6, 27.6]],
      wall: [2, 2, [4, 46.9, 59.8, 28]], scatter: [6, 6, [35.7, 4, 35.8, 35.3]], cells: [4, 4, [4, 48.9, 59.8, 26]],
      kicker: [4, 4, [4, 4, 59.8, 44.8]], sidebar: [8, 8, [36.2, 35.8, 59.8, 43.6]],
      footer: [8, 8, [4, 39.3, 59.8, 35.6]], plate: [4, 4, [61.2, 35.8, 34.8, 43.6]],
      cross: [1, 1, [73.1, 8.5, 22.9, 28.9]], overlap: [4, 4, [4, 46.8, 48.4, 24.1]],
      stamp: [4, 4, [4, 9.7, 70.8, 19]], column: [2, 2, [36.2, 30.3, 59.8, 49]],
      rising: [4, 4, [65.3, 4, 30.7, 27.8]], overprint: [8, 8, [48.1, 24.2, 47.9, 55.1]],
      dateBehind: [8, 8, [4, 39.3, 59.8, 35.6]], tightStack: [8, 8, [4, 44, 59.8, 30.9]],
      behindPhoto: [2, 2, [74, 49.8, 22, 29.6]], label: [4, 4, [50.6, 4, 45.4, 75.3]],
      ghost: [4, 4, [4, 4, 67.6, 35.3]],
    },
    lost: ['fullBleed', 'panel', 'sideSplit'],
  },
  'performance|portrait': {
    offered: {

    },
    lost: ['perfOffer', 'perfPriceTag', 'perfCard', 'perfCentred', 'perfOfferFirst'],
  },
  'performance|square': {
    offered: {

    },
    lost: ['perfOffer', 'perfPriceTag', 'perfCard', 'perfCentred', 'perfOfferFirst'],
  },
  'performance|meta-story': {
    offered: {

    },
    lost: ['perfOffer', 'perfPriceTag', 'perfCard', 'perfCentred', 'perfOfferFirst'],
  },
  'performance|ad-300x250': {
    offered: {

    },
    lost: ['perfOffer', 'perfCard', 'perfCentred', 'perfOfferFirst'],
  },
  'editorial|portrait': {
    offered: {
      edFramed: [8, 8, [4, 90.9, 21.7, 48.1]], edQuiet: [3, 3, [4, 4, 21.1, 135]],
    },
    lost: ['edCover', 'edDiptych'],
  },
  'editorial|square': {
    offered: {
      edFramed: [8, 8, [76.8, 4, 19.2, 92]], edQuiet: [4, 4, [4, 4, 25.8, 92]],
    },
    lost: ['edCover', 'edDiptych'],
  },
  'editorial|meta-story': {
    offered: {
      edFramed: [4, 4, [74.3, 30.9, 19.7, 68.2]], edQuiet: [4, 4, [6, 30.9, 22.9, 58.6]],
    },
    lost: ['edCover', 'edDiptych'],
  },
  'editorial|ad-300x250': {
    offered: {
      edFramed: [4, 4, [70.2, 4, 25.8, 66.1]], edQuiet: [4, 4, [4, 4, 28.4, 55.6]],
    },
    lost: ['edCover', 'edDiptych'],
  },
  'street|portrait': {
    offered: {
      stFill: [6, 12, [4, 39.3, 17.5, 99.7]], stDrop: [5, 5, [4, 123.6, 40.6, 15.4]],
      stRepeat: [4, 4, [4, 4, 24.3, 48]],
    },
    lost: ['stTag'],
  },
  'street|square': {
    offered: {
      stFill: [12, 12, [4, 37.7, 48.3, 58.3]], stDrop: [8, 8, [44.4, 32.3, 41.2, 54.5]],
      stRepeat: [4, 4, [4, 4, 33.1, 27.8]],
    },
    lost: ['stTag'],
  },
  'street|meta-story': {
    offered: {
      stFill: [12, 12, [6, 72.4, 45.4, 37.1]], stDrop: [8, 8, [39.3, 60.4, 43.1, 35]],
      stRepeat: [4, 4, [6, 30.9, 28.4, 19.5]],
    },
    lost: ['stTag'],
  },
  'street|ad-300x250': {
    offered: {
      stFill: [12, 12, [4, 42.1, 53.9, 37.2]], stDrop: [8, 8, [28.4, 31.8, 59.1, 29.7]],
      stRepeat: [4, 4, [4, 58.1, 53.9, 21.2]],
    },
    lost: ['stTag'],
  },
}

describe('freeRects: the free room, largest first', () => {
  const area: Box = { x0: 0, y0: 0, x1: 100, y1: 100 }

  it('an empty area is one rectangle: the area itself', () => {
    expect(freeRects(area, [], 2, 12)).toEqual([area])
  })

  it('clears every taken box by the gap, and the largest comes first', () => {
    // A box across the top half: the room is below it, the gap under it.
    const rects = freeRects(area, [{ x0: 0, y0: 0, x1: 100, y1: 50 }], 4, 12)
    expect(rects[0]).toEqual({ x0: 0, y0: 54, x1: 100, y1: 100 })
    for (const r of rects) expect(r.y0).toBeGreaterThanOrEqual(54)
  })

  it('a box in the middle leaves four bands; the widest wins, ties go to the top, then the left', () => {
    const rects = freeRects(area, [{ x0: 40, y0: 40, x1: 60, y1: 60 }], 0, 12)
    // Four 100 × 40 (or 40 × 100) bands, all 4000: the top one first (y0 0), then the left one.
    expect(rects.slice(0, 4)).toEqual([
      { x0: 0, y0: 0, x1: 100, y1: 40 },
      { x0: 0, y0: 0, x1: 40, y1: 100 },
      { x0: 60, y0: 0, x1: 100, y1: 100 },
      { x0: 0, y0: 60, x1: 100, y1: 100 },
    ])
  })

  it('leaves out rooms narrower than the minimum side', () => {
    const rects = freeRects(area, [{ x0: 10, y0: 0, x1: 100, y1: 100 }], 0, 12)
    expect(rects).toEqual([])
  })

  it('is deterministic: the same boxes in another order give the same rooms', () => {
    const taken: Box[] = [{ x0: 5, y0: 5, x1: 30, y1: 20 }, { x0: 50, y0: 30, x1: 90, y1: 45 }, { x0: 10, y0: 70, x1: 40, y1: 95 }]
    expect(freeRects(area, [...taken].reverse(), 2, 12)).toEqual(freeRects(area, taken, 2, 12))
  })
})

describe('the extra image is placed by every offered layout', () => {
  for (const style of STYLES) for (const f of FRAMES) {
    it(`${style} · ${f.id}: a tile of at least 12, cropped, in the content area, clear of every element by the gap`, () => {
      const area = contentArea(f)
      let seen = 0
      for (const def of layoutsForStyle(style)) {
        const a = argsFor(def.id, f, labFrame(), style)
        for (const cand of candidatesForFrame(a)) {
          const label = `${def.id} ${JSON.stringify(cand.choice)}`
          const plan = planLayout({ ...a, choice: cand.choice })!
          expect.soft(plan.issues, label).toEqual([])
          const S = makeSheet({ frameW: f.w, frameH: f.h, measure: makeStubMeasure() })
          const tiles = cand.out.els.filter((e): e is PhotoEl => e.k === 'p' && e.extra != null)
          expect(tiles, label).toHaveLength(1)
          const t = tiles[0]!
          expect.soft(Math.min(t.w, t.h), label).toBeGreaterThanOrEqual(EXTRA_MIN_TILE - 1e-9)
          expect.soft(t.x >= area.x0 - 1e-6 && t.y >= area.y0 - 1e-6 && t.x + t.w <= area.x1 + 1e-6 && t.y + t.h <= area.y1 + 1e-6, `inside ${JSON.stringify(area)} · ${label}`).toBe(true)
          // Clear of every other element (its measured ink box) by the gap.
          for (const e of cand.out.els) {
            if (e === t || e.k === 'missing') continue
            const b = inkBoxOf(e as El, S)
            if (!b) continue
            const ix = Math.min(b.x1, t.x + t.w) - Math.max(b.x0, t.x)
            const iy = Math.min(b.y1, t.y + t.h) - Math.max(b.y0, t.y)
            expect.soft(ix > 0 && iy > 0, `${e.k}/${e.role} under the tile · ${label}`).toBe(false)
          }
          // The wired image takes the tile: moved, sized, cropped to cover (so its `h` holds).
          const w = plan.layers.find(l => l.id === 'wired') as unknown as { x: number; y: number; w: number; h?: number; crop?: unknown; visible?: boolean }
          expect.soft(w.crop, label).toEqual({ fit: 'cover' })
          expect.soft(w.w, label).toBeCloseTo(t.w / 100, 9)
          expect.soft(w.h, label).toBeCloseTo(t.h / 100, 9)
          expect.soft(w.x, label).toBeCloseTo((t.x + t.w / 2) / 100, 9)
          expect.soft(w.visible, label).not.toBe(false)
          // It is placed, so it is not listed under "Not shown".
          expect.soft(plan.notPlaced.some(n => n.image), label).toBe(false)
          seen++
        }
      }
      // Every candidate the pinned table below counts was checked here.
      const pinned = PINNED[`${style}|${f.id}`]!
      expect(seen).toBe(Object.values(pinned.offered).reduce((n, [two]) => n + two, 0))
    })
  }
})

describe('no room: the variation is refused', () => {
  it('Full bleed covers the page with its image: the default refused with the reason, nothing offered', () => {
    const a = argsFor('fullBleed', FRAMES[0]!, labFrame(), 'swiss')
    expect(planLayout({ ...a, choice: DEFAULT })!.issues).toEqual([NO_ROOM_FOR_IMAGES])
    expect(NO_ROOM_FOR_IMAGES).toBe('no room for the other images')
    expect(candidatesForFrame(a)).toEqual([])
    // …on one image it is offered, exactly as before.
    expect(candidatesForFrame(argsFor('fullBleed', FRAMES[0]!, oneImage(), 'swiss')).length).toBeGreaterThan(0)
  })
})

describe('which images are extra', () => {
  const portrait = FRAMES[0]!
  const firstOffered = (layers: LocalLayer[], style: StyleId = 'swiss') => {
    for (const def of layoutsForStyle(style)) {
      const a = argsFor(def.id, portrait, layers, style)
      const cand = candidatesForFrame(a)[0]
      if (cand) return { def, cand, plan: planLayout({ ...a, choice: cand.choice })! }
    }
    throw new Error('nothing offered')
  }

  it('three images: the two extras are equal tiles in one row or one column, the kit gap apart', () => {
    const layers = [...labFrame(), createImageLayer('z.png', 1, { id: 'img3', w: 0.3, h: 0.3 }) as LocalLayer]
    const { cand } = firstOffered(layers)
    const tiles = cand.out.els.filter((e): e is PhotoEl => e.k === 'p' && e.extra != null)
    expect(tiles.map(t => t.extra)).toEqual([0, 1])
    expect(tiles[0]!.w).toBeCloseTo(tiles[1]!.w, 9)
    expect(tiles[0]!.h).toBeCloseTo(tiles[1]!.h, 9)
    const S = makeSheet({ frameW: portrait.w, frameH: portrait.h, measure: makeStubMeasure() })
    const row = Math.abs(tiles[0]!.y - tiles[1]!.y) < 1e-9
    if (row) expect(tiles[1]!.x - (tiles[0]!.x + tiles[0]!.w)).toBeCloseTo(S.GAP, 9)
    else expect(tiles[1]!.y - (tiles[0]!.y + tiles[0]!.h)).toBeCloseTo(S.GAP, 9)
  })

  it('an image tagged Not used stays hidden and named (ruling D3), never tiled', () => {
    const layers = [...oneImage(), createImageLayer('y.png', 1.25, { id: 'img2', w: 0.5, h: 0.625 }) as LocalLayer]
    const props = { sailor_localLayers: layers, sailor_posterState: { tags: { img2: 'unused' } } }
    const a = { ...argsFor('statement', portrait, layers, 'swiss'), props }
    const cand = candidatesForFrame(a)[0]!
    expect(cand.out.els.some(e => e.k === 'p' && e.extra != null)).toBe(false)
    const plan = planLayout({ ...a, choice: cand.choice })!
    expect((plan.layers.find(l => l.id === 'img2') as { visible?: boolean }).visible).toBe(false)
    expect(plan.notPlaced).toContainEqual({ role: 'unused', text: 'Image 2', image: true })
  })

  it('an image the user hid is theirs: not tiled, left as it is', () => {
    const layers = labFrame().map(l => l.id === 'wired' ? { ...l, visible: false } as LocalLayer : l)
    const a = argsFor('statement', portrait, layers, 'swiss')
    const cand = candidatesForFrame(a)[0]!
    expect(cand.out.els.some(e => e.k === 'p' && e.extra != null)).toBe(false)
    const plan = planLayout({ ...a, choice: cand.choice })!
    expect(plan.layers.find(l => l.id === 'wired')).toEqual(layers.find(l => l.id === 'wired'))
  })

  it('Before / after places both images itself: nothing extra, as before', () => {
    const layers = [...frameLayers('phrase', { image: true, shape: false }), createImageLayer('y.png', 1.25, { id: 'img2', w: 0.5, h: 0.625 }) as LocalLayer]
    const a = argsFor('perfBeforeAfter', FRAMES[1]!, layers, 'performance')
    const cands = candidatesForFrame(a)
    expect(cands.length).toBeGreaterThan(0)
    for (const c of cands) expect(c.out.els.some(e => e.k === 'p' && e.extra != null)).toBe(false)
  })

  it('the same Frame gives the same tile every time', () => {
    const a = argsFor('statement', portrait, labFrame(), 'swiss')
    const one = candidatesForFrame(a)[0]!.out.els.find(e => e.k === 'p' && e.extra != null)
    const two = candidatesForFrame(a)[0]!.out.els.find(e => e.k === 'p' && e.extra != null)
    expect(one).toBeDefined()
    expect(two).toEqual(one)
  })

  it('every catalog layout is covered by the styles above', () => {
    expect(STYLES.flatMap(s => layoutsForStyle(s)).length).toBe(CATALOG.length)
  })
})

describe('the lab Frame: what two images offer, pinned', () => {
  const r1 = (v: number) => Math.round(v * 10) / 10
  for (const style of STYLES) for (const f of FRAMES) {
    it(`${style} · ${f.id}`, () => {
      const pin = PINNED[`${style}|${f.id}`]!
      const offered: Pin['offered'] = {}
      const lost: string[] = []
      const area = contentArea(f)
      const S = makeSheet({ frameW: f.w, frameH: f.h, measure: makeStubMeasure() })
      const gap = makeSheet({ frameW: f.w, frameH: f.h, measure: makeStubMeasure(), ...(f.preset ? { format: { view: FRAME_FORMATS.find(x => x.id === f.preset)!.view } } : {}) }).GAP
      for (const def of layoutsForStyle(style)) {
        const one = candidatesForFrame(argsFor(def.id, f, oneImage(), style))
        const two = candidatesForFrame(argsFor(def.id, f, labFrame(), style))
        if (two.length) {
          const t = two[0]!.out.els.find((e): e is PhotoEl => e.k === 'p' && e.extra != null)!
          offered[def.id] = [two.length, one.length, [t.x, t.y, t.w, t.h].map(r1)]
        } else if (one.length) {
          lost.push(def.id)
          // The measured reason: the layout leaves no free room at all in the content area.
          const taken = one[0]!.out.els.map(e => inkBoxOf(e, S)).filter((b): b is Box => b != null)
          expect(freeRects(area, taken, gap, 0.01), `${def.id} has free room`).toEqual([])
        }
      }
      expect(offered).toEqual(pin.offered)
      expect(lost).toEqual(pin.lost)
    })
  }
})
