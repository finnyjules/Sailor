import type { LayoutDef } from '../kit/types'
import type { StyleId } from '../kit/styles'
import { bottomHeavy, footer, fourCorners, fullBleed, index, photoBehind, runoff, shapeCounter, statement, tilt } from './swissCore'
import { block, diagonal, edges, kicker, ragged, sidebar, spacedLines, staircase, wall } from './swissLines'
import { badge, cascade, cells, knockout, ring, scatter, shapeBleed, split } from './swissShapes'
import { column, cross, overlap, panel, plate, rising, sideSplit, stamp } from './photo'
import { behindPhoto, collage, dateBehind, ghost, label, overprint, tightStack } from './overlap'
import { PERFORMANCE_LAYOUTS } from './performance'
import { EDITORIAL_LAYOUTS } from './editorial'
import { STREET_LAYOUTS } from './street'
import { PERFORMANCE_AD_LAYOUTS } from './performanceAds'

// ORDER RULE (Ruling R9): a layout's index in this list seeds its random choices
// (`7000 + index·97 + 13 + arr·7919`, as in the prototype). The FINAL order of this list must
// equal the prototype's `def(...)` order in docs/superpowers/specs/assets/
// 2026-09-23-frame-layout-system/layout-sheet.html (def, then defNew, then defOver, top to
// bottom), so the seeds reproduce what the user approved there. Insert each ported layout at
// its prototype position — between its neighbours, not at the end. All 42 are ported.
//
// `LAYOUTS` is the Swiss library — exactly the 42 of Stages 1–2. The style layouts (Stage 3) are
// in `CATALOG`, appended after the 42 and never interleaved, so a style layout's seed index is
// 42 + its place among them and every Swiss seed is unchanged.
export const LAYOUTS: LayoutDef[] = [
  runoff,
  statement,
  index,
  shapeCounter,
  photoBehind,
  fullBleed,
  tilt,
  bottomHeavy,
  fourCorners,
  spacedLines,
  ragged,
  edges,
  staircase,
  block,
  knockout,
  shapeBleed,
  badge,
  split,
  diagonal,
  wall,
  scatter,
  cascade,
  ring,
  cells,
  kicker,
  sidebar,
  footer,
  // defNew: the image-led layouts.
  plate,
  panel,
  sideSplit,
  cross,
  overlap,
  stamp,
  column,
  rising,
  // defOver: the overlap family.
  overprint,
  dateBehind,
  tightStack,
  behindPhoto,
  collage,
  label,
  ghost,
]

/** Every layout, in seed order: the 42 Swiss layouts, then each style's in the prototype's order
 *  (Performance 42–47, Editorial 48–51, Street 52–56), then the Stage 4 layouts, appended and never
 *  interleaved so every earlier seed is unchanged (Performance ad layouts 57–65). */
export const CATALOG: readonly LayoutDef[] = [...LAYOUTS, ...PERFORMANCE_LAYOUTS, ...EDITORIAL_LAYOUTS, ...STREET_LAYOUTS,
  ...PERFORMANCE_AD_LAYOUTS]

/** A layout and its seed index: the catalog's, or — for a layout a test registered — its place
 *  in `LAYOUTS` (as before Stage 3). */
export function layoutEntry(id: string): { def: LayoutDef; index: number } | undefined {
  let index = CATALOG.findIndex(l => l.id === id)
  if (index >= 0) return { def: CATALOG[index]!, index }
  index = LAYOUTS.findIndex(l => l.id === id)
  return index >= 0 ? { def: LAYOUTS[index]!, index } : undefined
}

export function layoutById(id: string): LayoutDef | undefined {
  return layoutEntry(id)?.def
}

/** One style's library, in seed order. Swiss: `LAYOUTS` itself. */
export function layoutsForStyle(style: StyleId = 'swiss'): LayoutDef[] {
  return style === 'swiss' ? LAYOUTS : CATALOG.filter(l => l.style === style)
}

/** Tests only: add a layout to the catalog. Returns a function that removes it again. */
export function __registerLayoutForTest(def: LayoutDef): () => void {
  LAYOUTS.push(def)
  return () => {
    const i = LAYOUTS.indexOf(def)
    if (i >= 0) LAYOUTS.splice(i, 1)
  }
}
