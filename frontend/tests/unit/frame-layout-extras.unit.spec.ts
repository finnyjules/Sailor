import { describe, it, expect } from 'vitest'
import { candidatesForFrame, planLayout, EXTRA_INSET_MAX, EXTRA_MIN_TILE, NO_ROOM_FOR_IMAGES } from '~/lib/frame/patterns/kit/plan'
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
import { STYLES as STYLE_SPECS } from '~/lib/frame/patterns/kit/styles'

const PERF_CHECK = STYLE_SPECS.performance.check!

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
// marked 'inset' when the tile sits on the layout's full-bleed image (ruling D5); and each layout
// offered with one image that two images lose, with the checker's reason for its first variation.
//
// Offered, one image → two (fix round 1): Swiss 35 → 35 (the story 32 → 32; the lab Frame has no
// shape, so the five shape layouts are not offered either way), Performance 5 → 3 (the story 5 → 2,
// 300×250 4 → 3), Editorial 4 → 4, Street 4 → 4.
//
// Measured reasons (Performance limit: 55% of the image hidden):
// - Price tag: its panel already hides 50.0% of the image; the inset (a third of the content width
//   square — 30.7 on the portrait, 30.7 on the square, 29.3 on the story) adds 6.6% / 9.4% / 9.5%.
// - Offer first: its image is not full-bleed (it starts at 30.0–37.6 under the panel on the
//   portrait), so there is no inset; the panel and the image leave no free room off it.
// - Centred on the story: the bands already hide 51.0–53.0%; the inset adds 9.5%.
// - Variations lost inside a layout still offered — Performance: Offer on the square 1 of 8 (47.1%
//   hidden + 9.4%), Centred on the square 1 of 4 (46.6% + 9.4%), Offer on the story 5 of 6
//   (45.6–53.4% + 9.5%). Swiss, where no inset is needed and the free room is too small (its
//   shorter side, under 12): Statement on the portrait 6 of 14 (4.1–7.7), Bottom heavy 2 of 8
//   (7.7), Split 1 of 4 (7.4), Footer 3 of 7 (4.1–7.7), Rising on the square 1 of 4 (4.7), Split on
//   the story 1 of 4 (11.9); Street's Fill on the portrait 6 of 12 (7.6).
type Pin = { offered: Record<string, [number, number, number[]] | [number, number, number[], 'inset']>; lost: Record<string, string> }
const PINNED: Record<string, Pin> = {
  'swiss|portrait': {
    offered: {
      runoff: [8, 8, [19, 99.9, 62, 31]], statement: [8, 14, [4, 24.5, 27, 54]], index: [4, 4, [69, 48, 27, 54]],
      photoBehind: [2, 2, [4, 62.5, 16.9, 33.8]], fullBleed: [4, 4, [34.7, 37.4, 30.7, 30.7], 'inset'],
      tilt: [2, 2, [49.6, 111, 46.4, 28]], bottomHeavy: [6, 8, [69, 27.6, 27, 54]],
      fourCorners: [8, 8, [4, 11.3, 50.4, 56]], spacedLines: [2, 2, [4, 22.3, 92, 85.3]],
      ragged: [6, 6, [4, 4, 34.8, 69.5]], edges: [4, 4, [4, 4, 42.6, 63.3]],
      staircase: [2, 2, [76.8, 66.3, 19.2, 38.4]], block: [2, 2, [4, 64.6, 27, 54]],
      split: [3, 4, [50.5, 75.7, 31.3, 15.7]], diagonal: [8, 8, [45.6, 9.6, 50.4, 48.5]],
      wall: [2, 2, [4, 64.7, 27, 54]], scatter: [3, 3, [65.9, 89.6, 30.1, 41.3]],
      cells: [2, 2, [4, 84.3, 58.2, 49.1]], kicker: [4, 4, [4, 29.8, 19.2, 38.4]],
      sidebar: [4, 4, [69, 53.7, 27, 54]], footer: [4, 7, [4, 64.6, 27, 54]],
      plate: [4, 4, [75.7, 36.1, 20.3, 40.5]], panel: [4, 4, [34.7, 28.6, 30.7, 30.7], 'inset'],
      sideSplit: [2, 2, [5.7, 56.2, 30.7, 30.7], 'inset'], cross: [1, 1, [9.1, 90, 81.7, 40.9]],
      overlap: [4, 4, [25.2, 106.1, 49.6, 24.8]], stamp: [4, 4, [4, 11.3, 66, 71.8]],
      column: [2, 2, [4, 60.9, 92, 78.1]], rising: [4, 4, [32.1, 49.7, 35.8, 17.9]],
      overprint: [8, 8, [4, 13.4, 58.2, 37]], dateBehind: [8, 8, [4, 67.3, 42.6, 66.1]],
      tightStack: [8, 8, [4, 75.7, 50.4, 57.7]], behindPhoto: [2, 2, [4.9, 85.8, 90.2, 45.1]],
      label: [4, 4, [75.7, 30.5, 20.3, 40.5]], ghost: [4, 4, [4, 4, 42.6, 63.3]],
    },
    lost: {},
  },
  'swiss|square': {
    offered: {
      runoff: [6, 6, [4, 4, 59.4, 44.1]], statement: [16, 16, [4, 8, 59.4, 43.6]],
      index: [8, 8, [44.4, 34.3, 51.6, 51.3]], photoBehind: [2, 2, [4, 20.1, 40.8, 69.8]],
      fullBleed: [4, 4, [34.7, 21.9, 30.7, 30.7], 'inset'], tilt: [4, 4, [16, 31.8, 16.2, 32.5]],
      bottomHeavy: [8, 8, [36.6, 13.3, 59.4, 39.6]], fourCorners: [8, 8, [4, 9.5, 59.4, 37.7]],
      spacedLines: [2, 2, [4.8, 20.4, 90.4, 45.2]], ragged: [6, 6, [4, 4, 59.4, 37.4]],
      edges: [4, 4, [4, 4, 59.4, 43.1]], staircase: [2, 2, [44.4, 38.8, 51.6, 51]],
      block: [2, 2, [4, 48.3, 59.4, 43.6]], split: [4, 4, [73.7, 52.9, 22.3, 43.1]],
      diagonal: [8, 8, [34.2, 8, 57.9, 28.9]], wall: [2, 2, [4, 47.7, 59.4, 44.2]],
      scatter: [6, 6, [37.6, 4, 25.7, 43.1]], cells: [4, 4, [4, 56.1, 67.1, 33.8]],
      kicker: [4, 4, [4, 4, 43.8, 58.1]], sidebar: [6, 6, [52.2, 34.3, 43.8, 61.7]],
      footer: [8, 8, [4, 47.1, 59.4, 44.9]], plate: [4, 4, [52.9, 16.5, 43.1, 46.4]],
      panel: [4, 4, [34.7, 16.2, 30.7, 30.7], 'inset'], sideSplit: [2, 2, [6.3, 34.7, 30.7, 30.7], 'inset'],
      cross: [1, 1, [47, 80.8, 30.4, 15.2]], overlap: [4, 4, [4, 56.3, 37.9, 33.5]],
      stamp: [4, 4, [4, 9.5, 67.1, 34.6]], column: [2, 2, [36.6, 30.8, 59.4, 65.2]],
      rising: [3, 4, [80.2, 9.6, 15.8, 31.6]], overprint: [8, 8, [57.9, 34.4, 38.1, 61.6]],
      dateBehind: [8, 8, [4, 47.1, 59.4, 44.9]], tightStack: [8, 8, [4, 52.9, 67.1, 37]],
      behindPhoto: [2, 2, [44.1, 77.9, 36.2, 18.1]], label: [4, 4, [60.7, 14.7, 35.3, 70.7]],
      ghost: [4, 4, [4, 4, 59.4, 43.1]],
    },
    lost: {},
  },
  'swiss|meta-story': {
    offered: {
      statement: [16, 16, [6, 37.7, 54.7, 27.4]], index: [8, 8, [39.3, 60.7, 54.7, 36.5]],
      photoBehind: [2, 2, [6, 47.8, 41.5, 51.9]], fullBleed: [4, 4, [35.3, 47.1, 29.3, 29.3], 'inset'],
      tilt: [4, 4, [19, 40.7, 26.7, 53.4]], bottomHeavy: [8, 8, [41.1, 48.2, 43.5, 21.8]],
      fourCorners: [8, 8, [54.8, 67.8, 39.2, 41.8]], spacedLines: [2, 2, [6, 49, 62.2, 42.5]],
      ragged: [6, 6, [7.8, 30.9, 58.5, 29.2]], edges: [4, 4, [6, 30.9, 54.7, 34.2]],
      staircase: [2, 2, [39.3, 66.5, 54.7, 30.2]], block: [2, 2, [6, 74.5, 54.7, 28.2]],
      split: [3, 4, [61.5, 75.4, 32.5, 24.4]], diagonal: [8, 8, [76.3, 55.9, 17.7, 35.5]],
      wall: [2, 2, [6, 75, 54.7, 27.8]], scatter: [6, 6, [40, 30.9, 20.7, 34.2]],
      cells: [4, 4, [11.1, 80.5, 44.6, 22.3]], kicker: [4, 4, [6, 30.9, 47.2, 45.4]],
      sidebar: [8, 8, [46.8, 62.2, 47.2, 47.3]], footer: [8, 8, [6, 70.5, 54.7, 32.3]],
      plate: [4, 4, [68.5, 57.1, 25.5, 51.1]], panel: [4, 4, [35.3, 40.7, 29.3, 29.3], 'inset'],
      sideSplit: [2, 2, [7, 55.6, 29.3, 29.3], 'inset'], overlap: [4, 4, [6, 78.4, 41.6, 21.4]],
      stamp: [4, 4, [20.7, 39.5, 33.8, 16.9]], column: [2, 2, [39.3, 58.9, 54.7, 50.7]],
      rising: [4, 4, [78.8, 30.9, 15.2, 29]], overprint: [8, 8, [54.8, 61.9, 39.2, 47.7]],
      dateBehind: [8, 8, [6, 70.5, 54.7, 32.3]], tightStack: [8, 8, [6, 75.4, 54.7, 27.4]],
      behindPhoto: [2, 2, [76.7, 79.7, 17.3, 29.9]], label: [4, 4, [51.9, 30.9, 42.1, 78.7]],
    },
    lost: {},
  },
  'swiss|ad-300x250': {
    offered: {
      runoff: [6, 6, [4, 4, 67.6, 34.2]], statement: [16, 16, [4, 8.5, 59.8, 30.9]],
      index: [8, 8, [36.2, 32.3, 59.8, 37.1]], photoBehind: [2, 2, [4, 18, 50.1, 53]],
      fullBleed: [4, 4, [34.7, 19.5, 30.7, 30.7], 'inset'], tilt: [4, 4, [13.8, 9.7, 42.2, 55.4]],
      bottomHeavy: [8, 8, [36.4, 22.1, 43.8, 21.9]], fourCorners: [8, 8, [8.2, 9.7, 59.2, 29.6]],
      spacedLines: [2, 2, [4, 19.9, 67.6, 43.5]], ragged: [6, 6, [7.2, 4, 61.2, 30.6]],
      edges: [2, 2, [4, 4, 67.6, 35.3]], staircase: [2, 2, [33.5, 38.3, 57.5, 28.8]],
      block: [2, 2, [4, 43.1, 59.8, 31.8]], split: [4, 4, [50.9, 44, 45.1, 27]],
      diagonal: [8, 8, [34.6, 9.7, 55.2, 27.6]], wall: [2, 2, [5.9, 46.9, 55.9, 28]],
      scatter: [6, 6, [35.7, 4, 35.8, 35.3]], cells: [4, 4, [7.9, 48.9, 52, 26]], kicker: [4, 4, [4, 4, 59.8, 44.8]],
      sidebar: [8, 8, [36.2, 35.8, 59.8, 43.6]], footer: [8, 8, [4, 39.3, 59.8, 35.6]],
      plate: [4, 4, [61.2, 35.8, 34.8, 43.6]], panel: [4, 4, [34.7, 12.9, 30.7, 30.7], 'inset'],
      sideSplit: [2, 2, [6.6, 26.3, 30.7, 30.7], 'inset'], cross: [1, 1, [73.1, 8.5, 22.9, 28.9]],
      overlap: [4, 4, [4.1, 46.8, 48.3, 24.1]], stamp: [4, 4, [20.4, 9.7, 38, 19]],
      column: [2, 2, [36.2, 30.3, 59.8, 49]], rising: [4, 4, [65.3, 4, 30.7, 27.8]],
      overprint: [8, 8, [48.1, 24.2, 47.9, 55.1]], dateBehind: [8, 8, [4, 39.3, 59.8, 35.6]],
      tightStack: [8, 8, [4, 44, 59.8, 30.9]], behindPhoto: [2, 2, [74, 49.8, 22, 29.6]],
      label: [4, 4, [50.6, 4, 45.4, 75.3]], ghost: [4, 4, [4, 4, 67.6, 35.3]],
    },
    lost: {},
  },
  'performance|portrait': {
    offered: {
      perfOffer: [8, 8, [34.7, 50.7, 30.7, 30.7], 'inset'], perfCard: [8, 8, [34.7, 55.6, 30.7, 30.7], 'inset'],
      perfCentred: [4, 4, [34.7, 50.2, 30.7, 30.7], 'inset'],
    },
    lost: {
      perfPriceTag: 'the image is mostly hidden',
      perfOfferFirst: 'no room for the other images',
    },
  },
  'performance|square': {
    offered: {
      perfOffer: [7, 8, [34.7, 31.1, 30.7, 30.7], 'inset'], perfCard: [8, 8, [34.7, 33.8, 30.7, 30.7], 'inset'],
      perfCentred: [3, 4, [34.7, 30.6, 30.7, 30.7], 'inset'],
    },
    lost: {
      perfPriceTag: 'the image is mostly hidden',
      perfOfferFirst: 'no room for the other images',
    },
  },
  'performance|meta-story': {
    offered: {
      perfOffer: [1, 6, [35.3, 33.7, 29.3, 29.3], 'inset'], perfCard: [8, 8, [35.3, 54.9, 29.3, 20.2], 'inset'],
    },
    lost: {
      perfPriceTag: 'the image is mostly hidden',
      perfCentred: 'the image is mostly hidden',
      perfOfferFirst: 'no room for the other images',
    },
  },
  'performance|ad-300x250': {
    offered: {
      perfOffer: [8, 8, [34.7, 25.1, 30.7, 19], 'inset'], perfCard: [4, 4, [62.4, 36.9, 30.7, 30.7], 'inset'],
      perfCentred: [2, 2, [34.7, 23.6, 30.7, 21], 'inset'],
    },
    lost: {
      perfOfferFirst: 'no room for the other images',
    },
  },
  'editorial|portrait': {
    offered: {
      edCover: [4, 4, [34.7, 34.1, 30.7, 30.7], 'inset'], edFramed: [8, 8, [4, 93.2, 21.7, 43.4]],
      edQuiet: [3, 3, [4, 50.4, 21.1, 42.2]], edDiptych: [8, 8, [9.6, 56.2, 30.7, 30.7], 'inset'],
    },
    lost: {},
  },
  'editorial|square': {
    offered: {
      edCover: [4, 4, [34.7, 18.1, 30.7, 30.7], 'inset'], edFramed: [8, 8, [76.8, 30.8, 19.2, 38.4]],
      edQuiet: [4, 4, [4, 24.2, 25.8, 51.7]], edDiptych: [8, 8, [10.2, 34.7, 30.7, 30.7], 'inset'],
    },
    lost: {},
  },
  'editorial|meta-story': {
    offered: {
      edCover: [4, 4, [35.3, 38.4, 29.3, 29.3], 'inset'], edFramed: [4, 4, [74.3, 45.3, 19.7, 39.4]],
      edQuiet: [4, 4, [6, 37.3, 22.9, 45.8]], edDiptych: [8, 8, [10.7, 55.6, 29.3, 29.3], 'inset'],
    },
    lost: {},
  },
  'editorial|ad-300x250': {
    offered: {
      edCover: [4, 4, [34.7, 9.7, 30.7, 30.7], 'inset'], edFramed: [4, 4, [70.2, 11.3, 25.8, 51.6]],
      edQuiet: [4, 4, [4, 4, 28.4, 55.6]], edDiptych: [8, 8, [10.5, 26.3, 30.7, 30.7], 'inset'],
    },
    lost: {},
  },
  'street|portrait': {
    offered: {
      stFill: [6, 12, [4, 71.7, 17.5, 35]], stTag: [4, 4, [34.7, 22.7, 30.7, 30.7], 'inset'],
      stDrop: [5, 5, [8.9, 123.6, 30.8, 15.4]], stRepeat: [4, 4, [4, 4, 24.3, 48]],
    },
    lost: {},
  },
  'street|square': {
    offered: {
      stFill: [12, 12, [4, 37.7, 48.3, 58.3]], stTag: [4, 4, [34.7, 6.5, 30.7, 30.7], 'inset'],
      stDrop: [8, 8, [44.4, 32.3, 41.2, 54.5]], stRepeat: [4, 4, [4, 4, 33.1, 27.8]],
    },
    lost: {},
  },
  'street|meta-story': {
    offered: {
      stFill: [12, 12, [6, 72.4, 45.4, 37.1]], stTag: [4, 4, [35.3, 30.9, 29.3, 21.1], 'inset'],
      stDrop: [8, 8, [39.3, 60.4, 43.1, 35]], stRepeat: [4, 4, [6, 30.9, 28.4, 19.5]],
    },
    lost: {},
  },
  'street|ad-300x250': {
    offered: {
      stFill: [12, 12, [4, 42.1, 53.9, 37.2]], stTag: [4, 4, [36.6, 4, 26.9, 13.4], 'inset'],
      stDrop: [8, 8, [28.4, 31.8, 59.1, 29.7]], stRepeat: [4, 4, [9.7, 58.1, 42.4, 21.2]],
    },
    lost: {},
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
          // Ruling D6: never longer than twice its other side.
          expect.soft(Math.max(t.w, t.h) / Math.min(t.w, t.h), label).toBeLessThanOrEqual(2 + 1e-9)
          expect.soft(t.x >= area.x0 - 1e-6 && t.y >= area.y0 - 1e-6 && t.x + t.w <= area.x1 + 1e-6 && t.y + t.h <= area.y1 + 1e-6, `inside ${JSON.stringify(area)} · ${label}`).toBe(true)
          // Clear of every other element (its measured ink box) by the gap.
          for (const e of cand.out.els) {
            if (e === t || e.k === 'missing') continue
            const b = inkBoxOf(e as El, S)
            if (!b) continue
            // Ruling D5: an inset may lie on the layout's own image when that image covers the
            // content area (and says so: the tile is `over` it).
            const bleeds = e.k === 'p' && b.x0 <= area.x0 && b.y0 <= area.y0 && b.x1 >= area.x1 && b.y1 >= area.y1
            if (bleeds && t.over?.includes((e.role ?? 'p').replace(/\d+$/, ''))) continue
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
  it('Offer first fills the page with its panel and a partial image: the default refused with the reason, nothing offered', () => {
    const a = argsFor('perfOfferFirst', FRAMES[0]!, labFrame(), 'performance')
    expect(planLayout({ ...a, choice: DEFAULT })!.issues).toEqual([NO_ROOM_FOR_IMAGES])
    expect(NO_ROOM_FOR_IMAGES).toBe('no room for the other images')
    expect(candidatesForFrame(a)).toEqual([])
    // …on one image it is offered, exactly as before.
    expect(candidatesForFrame(argsFor('perfOfferFirst', FRAMES[0]!, oneImage(), 'performance')).length).toBeGreaterThan(0)
  })

  it('Full bleed (no room off its image) places an inset on its image (ruling D5)', () => {
    const t = candidatesForFrame(argsFor('fullBleed', FRAMES[0]!, labFrame(), 'swiss'))[0]!.out.els.find((e): e is PhotoEl => e.k === 'p' && e.extra != null)!
    expect(t.over).toEqual(['photo'])
    expect(Math.max(t.w, t.h)).toBeLessThanOrEqual(EXTRA_INSET_MAX * 92 + 1e-9)
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

describe('fix round 1 (rulings D5, D6, D7)', () => {
  const portrait = FRAMES[0]!

  it('D5: Performance places the extra image as an inset on its full-bleed image, clear of the text and the owned pieces', () => {
    let insets = 0
    for (const f of [FRAMES[0]!, FRAMES[1]!]) {
      const S = makeSheet({ frameW: f.w, frameH: f.h, measure: makeStubMeasure(), style: 'performance' })
      for (const def of layoutsForStyle('performance')) {
        for (const cand of candidatesForFrame(argsFor(def.id, f, labFrame(), 'performance'))) {
          const t = cand.out.els.find((e): e is PhotoEl => e.k === 'p' && e.extra != null)!
          if (!t.over?.length) continue
          insets++
          const photo = cand.out.els.find((e): e is PhotoEl => e.k === 'p' && e.role === 'photo')!
          // On the image…
          expect(t.x >= photo.x && t.y >= photo.y && t.x + t.w <= photo.x + photo.w && t.y + t.h <= photo.y + photo.h).toBe(true)
          // …clear of everything else by the gap.
          for (const e of cand.out.els) {
            if (e === t || e === photo || e.k === 'missing') continue
            const b = inkBoxOf(e as El, S)!
            const ix = Math.min(b.x1, t.x + t.w) - Math.max(b.x0, t.x)
            const iy = Math.min(b.y1, t.y + t.h) - Math.max(b.y0, t.y)
            expect(ix > -S.GAP + 1e-6 && iy > -S.GAP + 1e-6, `${def.id} ${e.k}/${e.role}`).toBe(false)
          }
        }
      }
    }
    expect(insets).toBeGreaterThan(0)
  })

  it('D5: free room off the image is tried first — a Swiss layout with room keeps its tile off the image', () => {
    const cand = candidatesForFrame(argsFor('statement', portrait, labFrame(), 'swiss'))[0]!
    const t = cand.out.els.find((e): e is PhotoEl => e.k === 'p' && e.extra != null)!
    expect(t.over).toBeUndefined()
  })

  it('D5: an inset counts as covering the image for "the image is mostly hidden"', () => {
    const check = PERF_CHECK
    const photo: El = { k: 'p', x: 0, y: 0, w: 100, h: 100, role: 'photo' }
    const inset = (w: number): El => ({ k: 'p', x: 0, y: 0, w, h: 100, role: 'extra', extra: 0, over: ['photo'] })
    expect(check([photo, inset(50)], { W: 100, H: 100 })).toEqual([])
    expect(check([photo, inset(60)], { W: 100, H: 100 })).toEqual(['the image is mostly hidden'])
    // The small-format limit (70%) holds for insets too.
    expect(check([photo, inset(60)], { W: 100, H: 100, designW: 300 })).toEqual([])
    expect(check([photo, inset(75)], { W: 100, H: 100, designW: 300 })).toEqual(['the image is mostly hidden'])
  })

  it('D6: a tile that would be longer than twice its width is cut to 2:1, centred in its slot', () => {
    // Kicker on the portrait had a 19.2 × 89.9 room.
    const t = candidatesForFrame(argsFor('kicker', portrait, labFrame(), 'swiss'))[0]!.out.els.find((e): e is PhotoEl => e.k === 'p' && e.extra != null)!
    expect(t.h).toBeCloseTo(2 * t.w, 9)
    expect(t.w).toBeCloseTo(19.2, 1)
    expect(t.y).toBeCloseTo(4 + (89.9 - t.h) / 2, 0)
  })

  it('D7: a wired image tagged Not used is hidden (tracked as the tag\'s) and named', () => {
    const props = { sailor_localLayers: labFrame(), sailor_posterState: { tags: { wired: 'unused' } } }
    const a = { ...argsFor('statement', portrait, labFrame(), 'swiss'), props }
    const cand = candidatesForFrame(a)[0]!
    expect(cand.out.els.some(e => e.k === 'p' && e.extra != null)).toBe(false)
    const plan = planLayout({ ...a, choice: cand.choice })!
    const w = plan.layers.find(l => l.id === 'wired') as { visible?: boolean; layoutPrev?: { visible?: { set: unknown; by?: string } } }
    expect(w.visible).toBe(false)
    expect(w.layoutPrev?.visible).toMatchObject({ set: false, by: 'unused' })
    expect(plan.notPlaced).toContainEqual({ role: 'unused', text: 'Image 2', image: true })
  })
})

describe('the lab Frame: what two images offer, pinned', () => {
  const r1 = (v: number) => Math.round(v * 10) / 10
  for (const style of STYLES) for (const f of FRAMES) {
    it(`${style} · ${f.id}`, () => {
      const pin = PINNED[`${style}|${f.id}`]!
      const offered: Pin['offered'] = {}
      const lost: Pin['lost'] = {}
      for (const def of layoutsForStyle(style)) {
        const one = candidatesForFrame(argsFor(def.id, f, oneImage(), style))
        const a = argsFor(def.id, f, labFrame(), style)
        const two = candidatesForFrame(a)
        if (two.length) {
          const t = two[0]!.out.els.find((e): e is PhotoEl => e.k === 'p' && e.extra != null)!
          const box = [t.x, t.y, t.w, t.h].map(r1)
          offered[def.id] = t.over ? [two.length, one.length, box, 'inset'] : [two.length, one.length, box]
        } else if (one.length) {
          // The measured reason: what the checker says of its first one-image variation.
          lost[def.id] = planLayout({ ...a, choice: one[0]!.choice })!.issues.join('; ')
        }
      }
      expect(offered).toEqual(pin.offered)
      expect(lost).toEqual(pin.lost)
    })
  }
})
